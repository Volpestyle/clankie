import type { WorkConvention } from "@clankie/protocol/work-items";
import type { WorkBackend } from "./backend.ts";
import { createFilesBackend } from "./backends/files.ts";
import { createGithubBackend, type GhRunner } from "./backends/github.ts";
import { createLinearBackend, type LinearToolCall } from "./backends/linear.ts";
import {
  DEFAULT_WORK_DIRECTORY,
  discoverConvention,
  readConvention,
  writeConvention,
  type CommandRunner,
  type Discovery,
} from "./convention.ts";

export interface TrackerDeps {
  readonly run?: CommandRunner;
  readonly gh?: GhRunner;
  readonly linear?: LinearToolCall;
  readonly clock?: () => Date;
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

export function backendFor(root: string, convention: WorkConvention, deps: TrackerDeps): WorkBackend {
  switch (convention.backend) {
    case "default":
      return createFilesBackend({
        root,
        directory: DEFAULT_WORK_DIRECTORY,
        kind: "default",
        ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      });
    case "markdown":
      if (convention.directory === undefined) throw new Error("A markdown convention names its directory");
      return createFilesBackend({
        root,
        directory: convention.directory,
        kind: "markdown",
        ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      });
    case "github":
      if (convention.github === undefined) throw new Error("A github convention names its repo");
      if (deps.gh === undefined)
        throw new BackendUnavailableError(
          `This repo tracks work in GitHub issues (${convention.github.repo}); gh is unavailable here`,
        );
      return createGithubBackend({ repo: convention.github.repo, gh: deps.gh });
    case "linear":
      if (convention.linear === undefined) throw new Error("A linear convention names its team");
      if (deps.linear === undefined)
        throw new BackendUnavailableError(
          `This repo tracks work in Linear (${convention.linear.team}); connect Linear to Clankie to use it`,
        );
      return createLinearBackend({
        team: convention.linear.team,
        ...(convention.linear.project === undefined ? {} : { project: convention.linear.project }),
        call: deps.linear,
      });
  }
}

export interface ResolvedTracker {
  readonly convention: WorkConvention;
  readonly recorded: boolean;
  readonly backend: WorkBackend;
}

/**
 * The repo's tracker. A recorded convention wins. Otherwise discovery decides
 * when it is unambiguous, and the answer is recorded only when `record` is set
 * (a write is about to happen), so reading never adds a file to someone's repo.
 */
export async function resolveTracker(
  root: string,
  deps: TrackerDeps,
  options: { readonly record?: boolean } = {},
): Promise<ResolvedTracker> {
  const recorded = await readConvention(root);
  if (recorded !== undefined)
    return { convention: recorded, recorded: true, backend: backendFor(root, recorded, deps) };
  const discovery = await discoverConvention(root, deps.run);
  if (discovery.suggestion === undefined) throw new ConventionNeededError(discovery);
  const convention: WorkConvention = {
    ...discovery.suggestion,
    decidedAt: (deps.clock ?? (() => new Date()))().toISOString(),
  };
  if (options.record === true) await writeConvention(root, convention);
  return { convention, recorded: options.record === true, backend: backendFor(root, convention, deps) };
}
