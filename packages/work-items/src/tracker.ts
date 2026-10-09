import type { WorkConvention } from "@clankie/protocol/work-items";
import { join } from "node:path";
import type { WorkBackend, WorkWriteCallbacks } from "./backend.ts";
import { createFilesBackend } from "./backends/files.ts";
import { createGithubBackend, type GhRunner, type GithubApi } from "./backends/github.ts";
import {
  assertLinearIssueScope,
  createLinearBackend,
  linearResourceId,
  type LinearToolCall,
} from "./backends/linear.ts";
import { WorkItemScopeError } from "./backend.ts";
import { createLocalTracker } from "./tracker-local.ts";
import { createRepoTracker } from "./tracker-repo.ts";
import {
  refuseBuiltInTrackerFeatures,
  TRACKER_TOOLS,
  type TrackerActor,
  type TrackerToolBackend,
} from "./tracker-tools.ts";
import {
  DEFAULT_WORK_DIRECTORY,
  discoverConvention,
  readConvention,
  writeConvention,
  type CommandRunner,
  type Discovery,
} from "./convention.ts";

export interface TrackerDeps extends WorkWriteCallbacks {
  readonly run?: CommandRunner;
  readonly gh?: GhRunner;
  /** A GitHub account connection (ADR 0196); preferred over `gh` when present. */
  readonly github?: GithubApi;
  readonly linear?: LinearToolCall;
  readonly clock?: () => Date;
  readonly scopedWrites?: boolean;
  /** Ancillary repo state belongs in service state, or ignored `.local/` for standalone use. */
  readonly trackerDirectory?: string;
  /** Host-authenticated writer, recorded by the built-in tracker; never from tool arguments. */
  readonly actor?: TrackerActor;
}

/** Raised instead of guessing: the owner has to answer once (ADR 0191). */
export class ConventionNeededError extends Error {
  readonly discovery: Discovery;
  constructor(discovery: Discovery) {
    super(discovery.question ?? "This repo's work-tracking convention needs a decision");
    this.discovery = discovery;
    this.name = "ConventionNeededError";
  }
}

export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

function localTrackerFor(root: string, convention: WorkConvention, deps: TrackerDeps): TrackerToolBackend {
  const scope = convention.linear;
  return createLocalTracker({
    directory: deps.trackerDirectory ?? join(root, ".local", "tracker"),
    ...(scope === undefined ? {} : { team: scope.team }),
    ...(scope?.project === undefined ? {} : { project: scope.project }),
    ...(scope?.label === undefined ? {} : { labels: [scope.label] }),
    ...(deps.scopedWrites !== true || scope === undefined
      ? {}
      : {
          assertIssueWrite: (issue: Readonly<Record<string, unknown>>) => {
            const same = (left: unknown, right: string) =>
              typeof left === "string" && left.toLowerCase() === right.toLowerCase();
            if (
              !same(issue.team, scope.team) ||
              (scope.project !== undefined && !same(issue.project, scope.project))
            )
              throw new WorkItemScopeError();
          },
        }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  });
}

function nativeBackendFor(root: string, convention: WorkConvention, deps: TrackerDeps): WorkBackend {
  const writes = {
    ...(deps.beforeWrite === undefined ? {} : { beforeWrite: deps.beforeWrite }),
    ...(deps.onDispatch === undefined ? {} : { onDispatch: deps.onDispatch }),
    ...(deps.effectConfirmed === undefined ? {} : { effectConfirmed: deps.effectConfirmed }),
    ...(deps.scopedWrites === undefined ? {} : { scopedWrites: deps.scopedWrites }),
    ...(deps.actor === undefined ? {} : { actor: deps.actor }),
  };
  switch (convention.backend) {
    case "default":
      return createFilesBackend({
        root,
        directory: DEFAULT_WORK_DIRECTORY,
        kind: "default",
        ...writes,
        ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      });
    case "markdown":
      if (convention.directory === undefined) throw new Error("A markdown convention names its directory");
      return createFilesBackend({
        root,
        directory: convention.directory,
        kind: "markdown",
        ...writes,
        ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      });
    case "github":
      if (convention.github === undefined) throw new Error("A github convention names its repo");
      if (deps.github !== undefined)
        return createGithubBackend({ repo: convention.github.repo, api: deps.github, ...writes });
      if (deps.gh === undefined)
        throw new BackendUnavailableError(
          `This repo tracks work in GitHub issues (${convention.github.repo}); connect GitHub to Clankie to use it`,
        );
      return createGithubBackend({ repo: convention.github.repo, gh: deps.gh, ...writes });
    case "linear":
      if (convention.linear === undefined) throw new Error("A linear convention names its team");
      const local = deps.linear === undefined ? localTrackerFor(root, convention, deps) : undefined;
      return createLinearBackend({
        team: convention.linear.team,
        ...(convention.linear.project === undefined ? {} : { project: convention.linear.project }),
        ...(convention.linear.label === undefined ? {} : { label: convention.linear.label }),
        call: deps.linear ?? ((name, args) => local!.call(name, args, writes)),
        ...(local === undefined
          ? writes
          : deps.scopedWrites === undefined
            ? {}
            : { scopedWrites: deps.scopedWrites }),
      });
  }
}

/** The canonical tool seam is also used by the CLI and legacy work-item callers. */
export function trackerToolsFor(
  root: string,
  convention: WorkConvention,
  deps: TrackerDeps,
): TrackerToolBackend {
  if (convention.backend === "linear") {
    const local = deps.linear === undefined ? localTrackerFor(root, convention, deps) : undefined;
    const call =
      deps.linear ?? ((name: string, args: Record<string, unknown>) => local!.call(name, args, deps));
    return {
      catalog: () => TRACKER_TOOLS,
      async call(name, args, callbacks) {
        if (local === undefined) refuseBuiltInTrackerFeatures(name, args);
        const scoped =
          name === "list_issues" ||
          name === "search_issues" ||
          (name === "save_issue" && args.id === undefined);
        const scope = convention.linear!;
        if (deps.scopedWrites) {
          for (const [field, helper, expected] of [
            ["team", "get_team", scope.team],
            ["project", "get_project", scope.project],
          ] as const) {
            if (args[field] === undefined || expected === undefined) continue;
            if (args[field] === null) throw new WorkItemScopeError();
            const [wanted, actual] = await Promise.all([
              call(helper, { query: expected }),
              call(helper, { query: args[field] }),
            ]);
            if (
              linearResourceId(wanted) === undefined ||
              linearResourceId(actual) !== linearResourceId(wanted)
            )
              throw new WorkItemScopeError();
          }
          if (name === "save_issue" && typeof args.id === "string")
            await assertLinearIssueScope(await call("get_issue", { id: args.id }), { ...scope, call });
          if ((name === "save_comment" || name === "create_comment") && typeof args.issueId === "string")
            await assertLinearIssueScope(await call("get_issue", { id: args.issueId }), { ...scope, call });
        }
        const parameters = {
          ...(scoped
            ? {
                team: convention.linear!.team,
                ...(convention.linear!.project === undefined ? {} : { project: convention.linear!.project }),
                ...(convention.linear!.label === undefined || name === "save_issue"
                  ? {}
                  : { label: convention.linear!.label }),
              }
            : {}),
          ...args,
          ...(name !== "save_issue" || args.id !== undefined || convention.linear!.label === undefined
            ? {}
            : {
                labels: [
                  ...new Set([...((args.labels as string[] | undefined) ?? []), convention.linear!.label]),
                ],
              }),
        };
        return local === undefined
          ? call(name, parameters)
          : local.call(name, parameters, { ...deps, ...callbacks });
      },
    };
  }
  return {
    catalog: () => TRACKER_TOOLS,
    call(name, args, callbacks) {
      const currentDeps = { ...deps, ...callbacks };
      return createRepoTracker({
        ...currentDeps,
        backend: nativeBackendFor(root, convention, currentDeps),
        directory: deps.trackerDirectory ?? join(root, ".local", "tracker"),
        ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      }).call(name, args);
    },
  };
}

export function backendFor(root: string, convention: WorkConvention, deps: TrackerDeps): WorkBackend {
  if (convention.backend === "linear") return nativeBackendFor(root, convention, deps);
  // Preserve the compatibility callers' eager backend-availability error boundary.
  nativeBackendFor(root, convention, deps);
  const canonical = trackerToolsFor(root, convention, deps);
  const compatibility = createLinearBackend({
    team: "Local",
    workOwnerAsAssignee: true,
    call: (name, args) => canonical.call(name, args),
  });
  return { ...compatibility, kind: convention.backend };
}

export interface ResolvedTracker {
  readonly convention: WorkConvention;
  readonly recorded: boolean;
  readonly backend: WorkBackend;
  readonly tools: TrackerToolBackend;
}

/**
 * The repo's tracker. A recorded convention wins. Otherwise discovery decides
 * when it is unambiguous, and the answer is recorded only when `record` is set
 * (a write is about to happen), so reading never adds a file to someone's repo.
 */
export async function resolveTracker(
  root: string,
  deps: TrackerDeps,
  options: {
    readonly record?: boolean;
    readonly requireRecorded?: boolean;
    readonly scopedWrites?: boolean;
  } = {},
): Promise<ResolvedTracker> {
  const backendDeps =
    options.scopedWrites === undefined ? deps : { ...deps, scopedWrites: options.scopedWrites };
  const recorded = await readConvention(root);
  if (recorded !== undefined)
    return {
      convention: recorded,
      recorded: true,
      backend: backendFor(root, recorded, backendDeps),
      tools: trackerToolsFor(root, recorded, backendDeps),
    };
  if (options.requireRecorded) throw new Error("A saved work tracker is required");
  const discovery = await discoverConvention(root, deps.run);
  if (discovery.suggestion === undefined) throw new ConventionNeededError(discovery);
  const convention: WorkConvention = {
    ...discovery.suggestion,
    decidedAt: (deps.clock ?? (() => new Date()))().toISOString(),
  };
  if (options.record === true) await writeConvention(root, convention);
  return {
    convention,
    recorded: options.record === true,
    backend: backendFor(root, convention, backendDeps),
    tools: trackerToolsFor(root, convention, backendDeps),
  };
}
