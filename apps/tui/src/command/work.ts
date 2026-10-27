import { TrackerSyncCommandSchema, OperatorConversationServiceResultSchema } from "@clankie/protocol";
import { randomUUID } from "node:crypto";
import {
  WorkItemWriteRequestSchema,
  WorkItemWriteReceiptRequestSchema,
  WorkItemWriteReceiptSchema,
} from "@clankie/protocol/work-item-write";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { readReviewDiff, readReviewPatch, ReviewDiffError, ReviewPatchError } from "@clankie/work-items";
import {
  WorkItemPrioritySchema,
  WorkInboxListSchema,
  WorkInboxGetSchema,
  WorkInboxSnoozeSchema,
  WorkInboxUnsnoozeSchema,
} from "@clankie/protocol/work-items";
import {
  TRACKER_REQUEST_BUDGET_PATH,
  TrackerRequestBudgetReportSchema,
  type TrackerRequestBudgetReport,
} from "@clankie/protocol/tracker-request-budget";
import { commandHost } from "./io.ts";

const WORK_USAGE = [
  "Usage: clankie work [status|discover] | repos | init [--backend default|markdown|github|linear] [--directory D]",
  "  [--github-repo OWNER/NAME] [--linear-team KEY] [--linear-project NAME] [--linear-label LABEL] [--release-source tags|milestones|both] [--release-lane NAME] [--note TEXT]",
  "  | project | project-details | list [--status S,S] [--owner O] [--label L] | show ID [--project P] | activity ID [--project P] | create TITLE [--summary S] [--owner O] [--criterion C]... [--status S] [--priority 0..4|none|urgent|high|medium|low]",
  "  | update ID [--project P] [--status S] [--priority P] [--owner O | --no-owner] [--title T] [--check N]... [--uncheck N]... [--add-criterion C]...",
  "  | write ID --owner O|--no-owner|--add-label L|--remove-label L|--add-blocker ID [--request-id UUID] | receipt ID --request-id UUID",
  "  | close ID [--project P] [--canceled] | attach ID [--project P] --url URL --caption TEXT [--kind image|video|log|link]",
  "  | releases [--lane L] [--item KEY] [--limit N] | releases sync | release ID|VERSION",
  "  | view save|get|list|apply|delete [ID] --project UUID --store-id ID [--json DEFINITION] [--limit N] [--cursor C]",
  "  | inbox list|get|snooze|unsnooze --project UUID --store-id ID [--target JSON] [--until RFC3339] [--revision N] [--if-updated-at RFC3339|null] [--idempotency-key KEY] [--attention active|snoozed|all] [--limit N] [--cursor C]",
  "  | cycle [--project P] [--type current|previous|next|all] | cycle show ID [--project P]",
  "  | cycle add ITEM [--to current|next|NUMBER] | cycle remove ITEM | cycle length PROJECT DAYS",
  "  | ready [--project P] [--limit N] | drift [--project P] [--idle-days N] | runs [ITEM] [--status S]",
  "  | changes [--project P] [--since N --store-id ID] [--wait S] [--limit N]   (built-in changes since a syncId; without --project, the repo's)",
  "  | bundle set ITEM --json BUNDLE | bundle show ITEM [--run ID] | bundle check ID [--body TEXT]",
  "  | gate ask ITEM --run ID --kind plan|spend|destructive_action|merge|external_write --body TEXT",
  "  | run steer|pause|resume|stop ID [--body TEXT] | ask ITEM --body TEXT",
  "  | lease ITEM [--minutes N] [--release]",
  "  | review-diff BASE HEAD   (read-only local Git change between two commits of --repo; no service)",
  "  | review-patch FILE   (read-only local Git patch file; no Git, repository or service)",
  "  | review save --json REVIEW | review show|list [ID] --issue ITEM | review edit|retire ID --issue ITEM --json JSON   (durable local guided reviews)",
  "  | sync --json COMMAND   (built-in bootstrap, batch, subscribe or keyed transaction)",
  "  | call TOOL [--json ARGS]   (Clankie's call to the built-in tracker, for the owner)",
  "  | owner TOOL [--json ARGS]   (the owner's own call to the built-in tracker; agents never use it)",
  "  | import linear --project UUID --scratch NAME   (read-only Linear mirror into a scratch store)",
  "  | mirror linear --scratch NAME --project UUID enable|disable|status   (Linear webhooks keep that scratch store current)",
  "  | cutover linear --world-project ID --scratch NAME --project UUID [--dry-run]   (that import becomes the live built-in tracker)",
  "  | cutover linear --world-project ID --switch-back [--dry-run]   (restore Linear as that project's tracker)",
  "  Every command takes --repo PATH (default: the git repo containing the current directory).",
].join("\n");

const execFileAsync = promisify(execFile);

function inferKind(url: string): "image" | "video" | "log" | "link" {
  const path = url.split(/[?#]/u)[0]!.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|heic|avif)$/u.test(path)) return "image";
  if (/\.(mp4|mov|webm|m4v)$/u.test(path)) return "video";
  if (/\.(log|txt|jsonl?|out)$/u.test(path)) return "log";
  return "link";
}

interface Parsed {
  readonly positional: string[];
  readonly flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(["--no-owner", "--canceled", "--release", "--dry-run", "--switch-back"]);

export function parseWorkArgs(args: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      if (BOOLEAN_FLAGS.has(arg)) {
        flags.set(arg, ["true"]);
        continue;
      }
      const value = args[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value\n${WORK_USAGE}`);
      flags.set(arg, [...(flags.get(arg) ?? []), value]);
      i += 1;
    } else positional.push(arg);
  }
  return { positional, flags };
}

const one = (parsed: Parsed, flag: string) => parsed.flags.get(flag)?.at(-1);
const many = (parsed: Parsed, flag: string) => parsed.flags.get(flag) ?? [];
const numbers = (parsed: Parsed, flag: string) =>
  many(parsed, flag).flatMap((value) =>
    value.split(",").map((part) => {
      const number = Number(part.trim());
      if (!Number.isInteger(number) || number < 1)
        throw new Error(`${flag} takes criterion numbers (1-based)`);
      return number;
    }),
  );

/** Builds the service request for `clankie work ...`; the repo is resolved by the caller. */
export function workRequest(args: readonly string[], repo: string): Record<string, unknown> {
  const parsed = parseWorkArgs(args);
  const [verb = "status", ...rest] = parsed.positional;
  if (parsed.flags.has("--linear-label") && verb !== "init")
    throw new Error("--linear-label only applies to init");
  const status = one(parsed, "--status");
  // An item in the built-in tracker, named by the project `work ready --project` takes (VUH-2805).
  const builtInProject = one(parsed, "--project") === undefined ? {} : { project: one(parsed, "--project") };
  const rawPriority = one(parsed, "--priority");
  const priority =
    rawPriority === undefined
      ? undefined
      : WorkItemPrioritySchema.parse(
          /^\d+$/u.test(rawPriority)
            ? Number(rawPriority)
            : ["none", "urgent", "high", "medium", "low"].indexOf(rawPriority.toLowerCase()),
        );
  switch (verb) {
    case "status":
    case "discover":
      return { action: "discover", repo };
    case "repos":
      return { action: "repos" };
    case "init":
      return {
        action: "init",
        repo,
        ...(one(parsed, "--backend") === undefined ? {} : { backend: one(parsed, "--backend") }),
        ...(one(parsed, "--directory") === undefined ? {} : { directory: one(parsed, "--directory") }),
        ...(one(parsed, "--github-repo") === undefined ? {} : { githubRepo: one(parsed, "--github-repo") }),
        ...(one(parsed, "--linear-team") === undefined ? {} : { linearTeam: one(parsed, "--linear-team") }),
        ...(one(parsed, "--linear-project") === undefined
          ? {}
          : { linearProject: one(parsed, "--linear-project") }),
        ...(one(parsed, "--linear-label") === undefined
          ? {}
          : { linearLabel: one(parsed, "--linear-label") }),
        ...(one(parsed, "--release-source") === undefined
          ? {}
          : { releaseSource: one(parsed, "--release-source") }),
        ...(one(parsed, "--release-lane") === undefined
          ? {}
          : { releaseLane: one(parsed, "--release-lane") }),
        ...(one(parsed, "--note") === undefined ? {} : { note: one(parsed, "--note") }),
      };
    case "project":
      return { action: "project", repo };
    case "list":
      return {
        action: "list",
        repo,
        ...(status === undefined ? {} : { status: status.split(",").map((value) => value.trim()) }),
        ...(one(parsed, "--owner") === undefined ? {} : { owner: one(parsed, "--owner") }),
        ...(one(parsed, "--label") === undefined ? {} : { label: one(parsed, "--label") }),
      };
    case "show":
      if (rest[0] === undefined) throw new Error(WORK_USAGE);
      return { action: "show", repo, id: rest[0], ...builtInProject };
    case "project-details":
      return { action: "project-details", repo };
    case "activity":
      if (rest[0] === undefined) throw new Error(WORK_USAGE);
      return { action: "activity", repo, id: rest[0], ...builtInProject };
    case "create":
      if (rest.length === 0) throw new Error(WORK_USAGE);
      return {
        action: "create",
        repo,
        title: rest.join(" "),
        ...(one(parsed, "--summary") === undefined ? {} : { summary: one(parsed, "--summary") }),
        ...(one(parsed, "--owner") === undefined ? {} : { owner: one(parsed, "--owner") }),
        ...(many(parsed, "--criterion").length === 0 ? {} : { criteria: many(parsed, "--criterion") }),
        ...(status === undefined ? {} : { status }),
        ...(priority === undefined ? {} : { priority }),
      };
    case "update":
    case "close": {
      if (rest[0] === undefined) throw new Error(WORK_USAGE);
      const closing = verb === "close";
      return {
        action: "update",
        repo,
        id: rest[0],
        ...builtInProject,
        ...(priority === undefined ? {} : { priority }),
        ...(closing
          ? { status: one(parsed, "--canceled") === "true" ? "canceled" : "done" }
          : status === undefined
            ? {}
            : { status }),
        ...(one(parsed, "--no-owner") === "true"
          ? { owner: null }
          : one(parsed, "--owner") === undefined
            ? {}
            : { owner: one(parsed, "--owner") }),
        ...(one(parsed, "--title") === undefined ? {} : { title: one(parsed, "--title") }),
        ...(numbers(parsed, "--check").length === 0 ? {} : { check: numbers(parsed, "--check") }),
        ...(numbers(parsed, "--uncheck").length === 0 ? {} : { uncheck: numbers(parsed, "--uncheck") }),
        ...(many(parsed, "--add-criterion").length === 0
          ? {}
          : { addCriteria: many(parsed, "--add-criterion") }),
      };
    }
    case "write": {
      if (rest.length !== 1) throw new Error(WORK_USAGE);
      const commands = [
        ...(one(parsed, "--owner") === undefined
          ? []
          : [{ action: "assign", owner: one(parsed, "--owner") }]),
        ...(one(parsed, "--no-owner") === "true" ? [{ action: "assign", owner: null }] : []),
        ...(one(parsed, "--add-label") === undefined
          ? []
          : [{ action: "add_label", label: one(parsed, "--add-label") }]),
        ...(one(parsed, "--remove-label") === undefined
          ? []
          : [{ action: "remove_label", label: one(parsed, "--remove-label") }]),
        ...(one(parsed, "--add-blocker") === undefined
          ? []
          : [{ action: "add_dependency", id: one(parsed, "--add-blocker") }]),
      ];
      if (commands.length !== 1) throw new Error("Choose exactly one work-item write operation.");
      const allowed = new Set([
        "--owner",
        "--no-owner",
        "--add-label",
        "--remove-label",
        "--add-blocker",
        "--request-id",
        "--free-agent",
        "--work-handoff",
      ]);
      for (const [flag, values] of parsed.flags)
        if (!allowed.has(flag) || values.length !== 1) throw new Error(WORK_USAGE);
      return {
        action: "write",
        request: {
          repoId: repo,
          itemId: rest[0],
          requestId: one(parsed, "--request-id") ?? randomUUID(),
          command: commands[0],
          ...(one(parsed, "--free-agent") === undefined
            ? {}
            : { freeAgent: JSON.parse(one(parsed, "--free-agent")!) }),
          ...(one(parsed, "--work-handoff") === undefined
            ? {}
            : { workHandoff: JSON.parse(one(parsed, "--work-handoff")!) }),
        },
      };
    }
    case "receipt": {
      if (rest.length !== 1 || !one(parsed, "--request-id")) throw new Error(WORK_USAGE);
      return {
        action: "write_receipt",
        request: { repoId: repo, itemId: rest[0], requestId: one(parsed, "--request-id") },
      };
    }
    case "attach": {
      const url = one(parsed, "--url");
      const caption = one(parsed, "--caption");
      if (rest[0] === undefined || url === undefined || caption === undefined) throw new Error(WORK_USAGE);
      return {
        action: "attach",
        repo,
        id: rest[0],
        ...builtInProject,
        evidence: { kind: one(parsed, "--kind") ?? inferKind(url), url, caption },
      };
    }
    default:
      throw new Error(WORK_USAGE);
  }
}

/**
 * Built-in tracker calls (VUH-1917, VUH-1930). Undefined for every other verb, which
 * goes to /v1/work. The operator credential proves a caller on this machine, not the
 * human, so these verbs are Clankie's calls for the owner (`/v1/tracker/call`); only
 * `work owner` speaks as the owner himself (LOCAL-VUH-1).
 */
function trackerRequest(
  args: readonly string[],
  repo: string,
): { readonly path: string; readonly body: Record<string, unknown> } | undefined {
  const parsed = parseWorkArgs(args);
  const [verb, ...rest] = parsed.positional;
  const call = (name: string, toolArgs: Record<string, unknown>, path = "/v1/tracker/call") => ({
    path,
    body: { name, arguments: toolArgs },
  });
  switch (verb) {
    case "inbox": {
      const [action, ...extra] = rest;
      if (extra.length || !one(parsed, "--project") || !one(parsed, "--store-id"))
        throw new Error(WORK_USAGE);
      const names: Record<string, string> = {
        list: "inbox_pending_questions",
        get: "get_inbox_item",
        snooze: "post_snooze_inbox_item",
        unsnooze: "post_unsnooze_inbox_item",
      };
      const name = names[action ?? ""];
      if (!name) throw new Error(WORK_USAGE);
      const allowed = new Set([
        "--project",
        "--store-id",
        ...(action === "list"
          ? ["--attention", "--limit", "--cursor"]
          : [
              "--target",
              ...(action === "get"
                ? []
                : [
                    "--revision",
                    "--if-updated-at",
                    "--idempotency-key",
                    ...(action === "snooze" ? ["--until"] : []),
                  ]),
            ]),
      ]);
      for (const [flag, values] of parsed.flags)
        if (!allowed.has(flag) || values.length !== 1) throw new Error(WORK_USAGE);
      const scope = { project: one(parsed, "--project"), storeId: one(parsed, "--store-id") };
      const toolArgs =
        action === "list"
          ? {
              ...scope,
              ...(one(parsed, "--attention") === undefined ? {} : { attention: one(parsed, "--attention") }),
              ...(one(parsed, "--limit") === undefined ? {} : { limit: Number(one(parsed, "--limit")) }),
              ...(one(parsed, "--cursor") === undefined ? {} : { cursor: one(parsed, "--cursor") }),
            }
          : {
              ...scope,
              target: JSON.parse(one(parsed, "--target") ?? "null"),
              ...(action === "get"
                ? {}
                : {
                    expectedRevision: Number(one(parsed, "--revision") ?? "NaN"),
                    ifUpdatedAt:
                      one(parsed, "--if-updated-at") === "null" ? null : one(parsed, "--if-updated-at"),
                    idempotencyKey: one(parsed, "--idempotency-key"),
                    ...(action === "snooze" ? { until: one(parsed, "--until") } : {}),
                  }),
            };
      const schema =
        action === "list"
          ? WorkInboxListSchema
          : action === "get"
            ? WorkInboxGetSchema
            : action === "snooze"
              ? WorkInboxSnoozeSchema
              : WorkInboxUnsnoozeSchema;
      return { path: "/v1/tracker/call", body: { repo, name, arguments: schema.parse(toolArgs) } };
    }
    case "review": {
      const [action, id, ...extra] = rest;
      const allowed = new Set(["--json", "--issue", ...(action === "list" ? ["--limit", "--cursor"] : [])]);
      for (const [flag, values] of parsed.flags)
        if (!allowed.has(flag) || values.length !== 1) throw new Error(WORK_USAGE);
      if (extra.length) throw new Error(WORK_USAGE);
      const call = (name: string, toolArgs: Record<string, unknown>) => ({
        path: "/v1/tracker/call",
        body: { repo, name, arguments: toolArgs },
      });
      if (action === "save" || action === "edit" || action === "retire") {
        const value: unknown = JSON.parse(one(parsed, "--json") ?? "null");
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("--json requires a review object");
        if (action === "save" && id === undefined && one(parsed, "--issue") === undefined)
          return call("save_guided_review", value as Record<string, unknown>);
        if ((action === "edit" || action === "retire") && id !== undefined && one(parsed, "--issue"))
          return call(action === "edit" ? "post_guided_finding" : "post_retire_guided_review", {
            ...value,
            id,
            issueId: one(parsed, "--issue"),
          });
      }
      if (
        (action === "show" || action === "list") &&
        one(parsed, "--issue") &&
        one(parsed, "--json") === undefined &&
        (action === "show" ? id !== undefined : id === undefined)
      )
        return call(action === "show" ? "get_guided_review" : "list_guided_reviews", {
          issueId: one(parsed, "--issue"),
          ...(id === undefined ? {} : { id }),
          ...(one(parsed, "--limit") === undefined ? {} : { limit: Number(one(parsed, "--limit")) }),
          ...(one(parsed, "--cursor") === undefined ? {} : { cursor: one(parsed, "--cursor") }),
        });
      throw new Error(WORK_USAGE);
    }
    case "view": {
      const viewCall = (name: string, toolArgs: Record<string, unknown>) => ({
        path: "/v1/tracker/call",
        body: { name, arguments: toolArgs, repo },
      });
      const [action, id, ...extra] = rest;
      if (extra.length || !one(parsed, "--project") || !one(parsed, "--store-id"))
        throw new Error(WORK_USAGE);
      const scope = { project: one(parsed, "--project"), storeId: one(parsed, "--store-id") };
      const controls = Object.fromEntries(
        [
          ["ifUpdatedAt", "--if-updated-at"],
          ["idempotencyKey", "--idempotency-key"],
        ]
          .filter(([, flag]) => one(parsed, flag!) !== undefined)
          .map(([key, flag]) => [key, one(parsed, flag!)]),
      );
      if (action === "save") {
        const definition = JSON.parse(one(parsed, "--json") ?? "{}");
        if (!definition || typeof definition !== "object" || Array.isArray(definition))
          throw new Error("--json requires a view definition object");
        return viewCall("save_issue_view", {
          schemaVersion: 1,
          ...definition,
          ...scope,
          ...(id === undefined ? {} : { id }),
          ...controls,
        });
      }
      if (action === "list" || action === "apply") {
        if (action === "list" ? id !== undefined : id === undefined) throw new Error(WORK_USAGE);
        return viewCall(action === "list" ? "list_issue_views" : "list_issue_view_issues", {
          ...scope,
          ...(id === undefined ? {} : { id }),
          ...(one(parsed, "--limit") === undefined ? {} : { limit: Number(one(parsed, "--limit")) }),
          ...(one(parsed, "--cursor") === undefined ? {} : { cursor: one(parsed, "--cursor") }),
        });
      }
      if ((action === "get" || action === "delete") && id !== undefined)
        return viewCall(action === "get" ? "get_issue_view" : "post_delete_issue_view", {
          ...scope,
          id,
          ...(action === "delete" ? controls : {}),
        });
      throw new Error(WORK_USAGE);
    }
    case "sync": {
      if (rest.length || one(parsed, "--json") === undefined) throw new Error(WORK_USAGE);
      const command = TrackerSyncCommandSchema.parse(JSON.parse(one(parsed, "--json")!));
      return { path: "/operator/v1/dispatch", body: { op: "tracker_sync", schemaVersion: 1, command } };
    }
    case "import":
      if (rest.length !== 1 || rest[0] !== "linear" || !one(parsed, "--project") || !one(parsed, "--scratch"))
        throw new Error("Usage: clankie work import linear --project UUID --scratch NAME");
      return {
        path: "/v1/tracker/import/linear",
        body: { projectId: one(parsed, "--project"), scratch: one(parsed, "--scratch") },
      };
    case "mirror": {
      const action = rest[1];
      if (
        rest.length !== 2 ||
        rest[0] !== "linear" ||
        !["enable", "disable", "status"].includes(action ?? "") ||
        !one(parsed, "--project") ||
        !one(parsed, "--scratch")
      )
        throw new Error(
          "Usage: clankie work mirror linear --scratch NAME --project UUID enable|disable|status",
        );
      return {
        path: "/v1/tracker/mirror/linear",
        body: { projectId: one(parsed, "--project"), scratch: one(parsed, "--scratch"), action },
      };
    }
    case "cutover": {
      const switchBack = one(parsed, "--switch-back") === "true";
      if (
        rest.length !== 1 ||
        rest[0] !== "linear" ||
        !one(parsed, "--world-project") ||
        (!switchBack && (!one(parsed, "--project") || !one(parsed, "--scratch")))
      )
        throw new Error(
          "Usage: clankie work cutover linear --world-project ID --scratch NAME --project UUID [--dry-run]\n" +
            "       clankie work cutover linear --world-project ID --switch-back [--dry-run]",
        );
      return {
        path: "/v1/tracker/cutover/linear",
        body: {
          worldProject: one(parsed, "--world-project"),
          ...(switchBack
            ? { switchBack: true }
            : { scratch: one(parsed, "--scratch"), linearProjectId: one(parsed, "--project") }),
          dryRun: one(parsed, "--dry-run") === "true",
        },
      };
    }
    case "releases": {
      if (rest[0] === "sync" && rest.length === 1)
        return { path: "/v1/tracker/releases/sync", body: { repo } };
      if (rest.length > 0) throw new Error(WORK_USAGE);
      const limit = one(parsed, "--limit");
      return call("list_releases", {
        ...(one(parsed, "--lane") === undefined ? {} : { pipeline: one(parsed, "--lane") }),
        ...(one(parsed, "--item") === undefined ? {} : { query: one(parsed, "--item") }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      });
    }
    case "release":
      if (rest.length !== 1) throw new Error(WORK_USAGE);
      return call("get_release", { id: rest[0] });
    case "cycle": {
      const [action, ...targets] = rest;
      const project = one(parsed, "--project");
      if (action === undefined) {
        const type = one(parsed, "--type") ?? "current";
        return call("list_cycles", {
          ...(project === undefined ? {} : { project }),
          ...(type === "all" ? {} : { type }),
        });
      }
      if (action === "show" && targets.length === 1)
        return call("get_cycle", { id: targets[0], ...(project === undefined ? {} : { project }) });
      if (action === "add" && targets.length === 1) {
        const to = one(parsed, "--to") ?? "current";
        return call("save_issue", { id: targets[0], cycle: /^\d+$/u.test(to) ? Number(to) : to });
      }
      if (action === "remove" && targets.length === 1)
        return call("save_issue", { id: targets[0], cycle: null });
      if (action === "length" && targets.length === 2 && /^\d+$/u.test(targets[1]!))
        return call("save_project", { id: targets[0], cycleDays: Number(targets[1]) });
      throw new Error(WORK_USAGE);
    }
    case "ready": {
      const limit = one(parsed, "--limit");
      return call("list_ready_issues", {
        ...(one(parsed, "--project") === undefined ? {} : { project: one(parsed, "--project") }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      });
    }
    case "changes": {
      const [since, wait, limit, project] = ["--since", "--wait", "--limit", "--project"].map((flag) =>
        one(parsed, flag),
      );
      if (rest.length || (since === undefined) !== (one(parsed, "--store-id") === undefined))
        throw new Error(WORK_USAGE);
      const toolArgs = {
        ...(project === undefined ? {} : { project }),
        ...(since === undefined ? {} : { since: Number(since), storeId: one(parsed, "--store-id") }),
        ...(wait === undefined ? {} : { waitMs: Math.round(Number(wait) * 1000) }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      };
      // Without a project the repo's own built-in binding decides, as a hire's does.
      return project === undefined
        ? { path: "/v1/tracker/call", body: { repo, name: "list_changes", arguments: toolArgs } }
        : call("list_changes", toolArgs);
    }
    case "drift": {
      const days = one(parsed, "--idle-days");
      return call("list_drift", {
        ...(one(parsed, "--project") === undefined ? {} : { project: one(parsed, "--project") }),
        ...(days === undefined ? {} : { idleDays: Number(days) }),
      });
    }
    case "runs":
      if (rest.length > 1) throw new Error(WORK_USAGE);
      return call("list_runs", {
        ...(rest[0] === undefined ? {} : { issueId: rest[0] }),
        ...(one(parsed, "--status") === undefined ? {} : { status: one(parsed, "--status") }),
      });
    case "lease": {
      if (rest.length !== 1) throw new Error(WORK_USAGE);
      const minutes = one(parsed, "--minutes");
      return call("save_lease", {
        issueId: rest[0],
        ...(one(parsed, "--release") === "true" ? { release: true } : {}),
        ...(minutes === undefined ? {} : { ttlMinutes: Number(minutes) }),
      });
    }
    case "bundle": {
      if (rest.length !== 2) throw new Error(WORK_USAGE);
      const [action, target] = rest;
      if (action === "show")
        return call("get_evidence_bundle", {
          issueId: target,
          ...(one(parsed, "--run") === undefined ? {} : { runId: one(parsed, "--run") }),
        });
      if (action === "check")
        return call("post_bundle_check", {
          bundleId: target,
          ...(one(parsed, "--body") === undefined ? {} : { body: one(parsed, "--body") }),
        });
      if (action === "set" && one(parsed, "--json")) {
        const bundle = JSON.parse(one(parsed, "--json")!);
        if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
          throw new Error("--json takes a bundle object");
        return call("save_evidence_bundle", { ...bundle, issueId: target });
      }
      throw new Error(WORK_USAGE);
    }
    case "gate":
      if (rest[0] !== "ask" || rest.length !== 2) throw new Error(WORK_USAGE);
      return call("post_issue_ask", {
        issueId: rest[1],
        runId: one(parsed, "--run"),
        purpose: "gate",
        gate: one(parsed, "--kind"),
        body: one(parsed, "--body"),
      });
    case "ask":
      if (rest.length !== 1) throw new Error(WORK_USAGE);
      return call("post_issue_ask", { issueId: rest[0], purpose: "decision", body: one(parsed, "--body") });
    case "run":
      if (rest.length !== 2) throw new Error(WORK_USAGE);
      return call("post_run_control", {
        runId: rest[1],
        action: rest[0],
        ...(one(parsed, "--body") === undefined ? {} : { body: one(parsed, "--body") }),
      });
    case "call":
    case "owner": {
      if (rest.length !== 1) throw new Error(WORK_USAGE);
      const json = one(parsed, "--json");
      const toolArgs = json === undefined ? {} : (JSON.parse(json) as unknown);
      if (toolArgs === null || typeof toolArgs !== "object" || Array.isArray(toolArgs))
        throw new Error("--json takes a JSON object of tool arguments");
      return call(
        rest[0]!.replace(/^linear_/u, ""),
        toolArgs as Record<string, unknown>,
        verb === "owner" ? "/v1/tracker/owner/call" : "/v1/tracker/call",
      );
    }
    default:
      return undefined;
  }
}

async function repoRoot(explicit: string | undefined, cwd: string): Promise<string> {
  if (explicit !== undefined && !explicit.startsWith("/")) return explicit; // a registered repo id
  const start = resolve(cwd, explicit ?? ".");
  try {
    return (
      await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: start, timeout: 10_000 })
    ).stdout.trim();
  } catch {
    return start;
  }
}

/**
 * `clankie work`: the one tracking contract every agent on this machine uses
 * (ADR 0191). JSON out; the service decides where items live.
 */
export async function runWorkCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly fetchImpl?: typeof fetch;
    readonly cwd?: string;
  } = {},
): Promise<{ readonly ok: boolean; readonly body: unknown }> {
  const env = options.env ?? process.env;
  const parsed = parseWorkArgs(args);
  // Before repoRoot: a patch names no repository, and no Git process may run for it.
  if (parsed.positional[0] === "review-patch") {
    if (parsed.positional.length !== 2 || parsed.flags.size > 0) throw new Error(WORK_USAGE);
    try {
      const patch = await readReviewPatch({
        path: resolve(options.cwd ?? process.cwd(), parsed.positional[1]!),
      });
      return { ok: patch.complete, body: patch };
    } catch (error) {
      if (error instanceof ReviewPatchError)
        return { ok: false, body: { outcome: "refused", code: error.code, message: error.message } };
      throw error;
    }
  }
  const repo = await repoRoot(one(parsed, "--repo"), options.cwd ?? process.cwd());
  const withoutRepo = args.filter((arg, index) => arg !== "--repo" && args[index - 1] !== "--repo");
  const local = parseWorkArgs(withoutRepo);
  if (local.positional[0] === "review-diff") {
    if (local.positional.length !== 3 || local.flags.size > 0) throw new Error(WORK_USAGE);
    try {
      const diff = await readReviewDiff({
        repository: repo,
        base: local.positional[1]!,
        head: local.positional[2]!,
      });
      return { ok: diff.complete, body: diff };
    } catch (error) {
      if (error instanceof ReviewDiffError)
        return { ok: false, body: { outcome: "refused", code: error.code, message: error.message } };
      throw error;
    }
  }
  const tracker = trackerRequest(withoutRepo, repo);
  const request = tracker === undefined ? workRequest(withoutRepo, repo) : tracker.body;
  const credential = await resolveOperatorCredential({ env });
  if (!credential) throw new Error("Work tracking needs the operator credential. Run clankie doctor.");
  const fetcher = options.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${credential.token}`, "content-type": "application/json" };
  if (tracker !== undefined) {
    const response = await fetcher(`${commandHost({ env })}${tracker.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(tracker.body),
      // An import or cutover reads the whole Linear project through the shared request budget.
      signal: AbortSignal.timeout(
        tracker.path === "/v1/tracker/import/linear" || tracker.path === "/v1/tracker/cutover/linear"
          ? 1_200_000
          : 60_000,
      ),
    });
    const body: unknown = await response.json();
    if (tracker.body.op === "tracker_sync" && response.ok) {
      const result = OperatorConversationServiceResultSchema.parse(body);
      if (result.op !== "tracker_sync") throw new Error("Unexpected tracker sync result");
      return { ok: result.result.outcome !== "refused", body: result.result };
    }
    return { ok: response.ok, body };
  }
  const endpoint = `${commandHost({ env })}/v1/work`;
  const writing = request.action === "write";
  const journaled = writing || request.action === "write_receipt";
  const input = journaled
    ? (request.request as { repoId: string; itemId: string; requestId: string })
    : undefined;
  if (input && repo.startsWith("/")) {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "repos" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error("Cannot read registered work repositories.");
    const inventory = (await response.json()) as { repos?: { id: string; root?: string }[] };
    const registered = inventory.repos?.find((entry) => entry.root === repo);
    if (!registered)
      return {
        ok: false,
        body: {
          requestId: input.requestId,
          outcome: "refused",
          message: "Register this repository with clankie work status before writing.",
        },
      };
    input.repoId = registered.id;
  }
  if (input)
    request.request = writing
      ? WorkItemWriteRequestSchema.parse(input)
      : WorkItemWriteReceiptRequestSchema.parse(input);
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      body: JSON.stringify(request),
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await response.json()) as unknown;
    // Status also shows hired seats' tracker budgets and role refusals (LOCAL-VUH-45).
    if (request.action === "discover" && response.ok && body !== null && typeof body === "object")
      return {
        ok: true,
        body: { ...body, trackerRequestBudget: await trackerRequestBudget(fetcher, env, headers) },
      };
    if (writing && input) {
      const parsedReceipt = WorkItemWriteReceiptSchema.safeParse(body);
      if (parsedReceipt.success)
        return { ok: parsedReceipt.data.outcome === "applied", body: parsedReceipt.data };
      return {
        ok: false,
        body: {
          requestId: input.requestId,
          outcome: response.status >= 400 && response.status < 500 ? "refused" : "uncertain",
          message:
            response.status >= 400 && response.status < 500
              ? "The owner-authorized work-item write was refused."
              : "The response was lost. Read this receipt and the tracker; never resend this request.",
        },
      };
    }
    return { ok: response.ok, body };
  } catch (error) {
    if (!writing || !input) throw error;
    return {
      ok: false,
      body: {
        requestId: input.requestId,
        outcome: "uncertain",
        message: "The write may have happened. Read this receipt and the tracker; never resend this request.",
      },
    };
  }
}

async function trackerRequestBudget(
  fetcher: typeof fetch,
  env: NodeJS.ProcessEnv,
  headers: Record<string, string>,
): Promise<TrackerRequestBudgetReport | { readonly status: "unavailable"; readonly detail: string }> {
  try {
    const response = await fetcher(`${commandHost({ env })}${TRACKER_REQUEST_BUDGET_PATH}`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Tracker request budget unavailable (HTTP ${response.status})`);
    return TrackerRequestBudgetReportSchema.parse(await response.json());
  } catch (error) {
    return { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
}
