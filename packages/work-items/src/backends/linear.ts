import { WorkItemSchema, type WorkItem, type WorkItemStatus } from "@clankie/protocol/work-items";
import {
  matchesFilter,
  patchCriteria,
  touchesCriteria,
  WorkItemNotFoundError,
  type WorkBackend,
  type WorkItemPatch,
} from "../backend.ts";
import { parseBody, patchBody } from "../format.ts";

/**
 * The repo's Linear team, through the Linear account already connected to
 * Clankie (the service's MCP host): no second credential. Linear's own state
 * types are the truth; the unified status is a projection of them.
 */

/** Calls one Linear MCP tool and resolves its parsed JSON result. */
export type LinearToolCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

interface LinearIssue {
  readonly id: string;
  readonly identifier?: string;
  readonly title: string;
  readonly description?: string | null;
  readonly status?: string | { readonly name?: string; readonly type?: string };
  readonly statusType?: string;
  readonly url?: string;
  readonly updatedAt?: string;
}

interface LinearStatus {
  readonly name: string;
  readonly type: string;
}

const FIELDS = ["title", "description", "status", "statusType", "url", "updatedAt"];

function statusName(issue: LinearIssue): string {
  return typeof issue.status === "string" ? issue.status : (issue.status?.name ?? "");
}

function statusType(issue: LinearIssue): string {
  return (
    issue.statusType ??
    (typeof issue.status === "object" ? issue.status.type : undefined) ??
    ""
  ).toLowerCase();
}

export function linearStatusOf(type: string, name: string): WorkItemStatus {
  if (type === "completed") return "done";
  if (type === "canceled" || type === "duplicate") return "canceled";
  if (type === "started") return /review/iu.test(name) ? "in_review" : "in_progress";
  return "todo";
}

/** Picks the team state an ADR 0191 status lands in, preferring the conventional names. */
export function pickLinearState(statuses: readonly LinearStatus[], status: WorkItemStatus): string {
  const ofType = (type: string) => statuses.filter((entry) => entry.type.toLowerCase() === type);
  const named = (list: readonly LinearStatus[], pattern: RegExp) =>
    list.find((entry) => pattern.test(entry.name));
  const started = ofType("started");
  const choice =
    status === "done"
      ? (named(ofType("completed"), /^done$/iu) ?? ofType("completed")[0])
      : status === "canceled"
        ? (named(ofType("canceled"), /^cancel/iu) ?? ofType("canceled")[0])
        : status === "in_review"
          ? (named(started, /review/iu) ?? started[0])
          : status === "in_progress"
            ? (named(started, /^in progress$/iu) ?? started.find((entry) => !/review/iu.test(entry.name)))
            : (named(ofType("unstarted"), /^todo$/iu) ?? ofType("unstarted")[0] ?? ofType("backlog")[0]);
  if (choice === undefined) throw new Error(`The Linear team has no state for ${status}`);
  return choice.name;
}

/** Section-level edits, for descriptions holding Linear uploads that must not be rewritten wholesale. */
export function descriptionPatch(
  before: string,
  after: string,
): { op: "replace" | "append"; old_string?: string; new_string?: string; text?: string }[] {
  const blocks = (text: string) => text.replace(/\r\n?/gu, "\n").split(/\n(?=## )/u);
  const old = blocks(before);
  const next = blocks(after);
  const ops: { op: "replace" | "append"; old_string?: string; new_string?: string; text?: string }[] = [];
  for (const block of next) {
    const heading = block.split("\n")[0]!;
    const match = old.find((candidate) => candidate.split("\n")[0] === heading);
    if (match === undefined) ops.push({ op: "append", text: `\n\n${block.trim()}` });
    else if (match.trim() !== block.trim())
      ops.push({ op: "replace", old_string: match.trim(), new_string: block.trim() });
  }
  return ops;
}

export function createLinearBackend(options: {
  readonly team: string;
  readonly project?: string;
  readonly call: LinearToolCall;
}): WorkBackend {
  let statuses: Promise<LinearStatus[]> | undefined;
  const teamStatuses = () =>
    (statuses ??= options.call("list_issue_statuses", { team: options.team }).then((result) => {
      const list = Array.isArray(result) ? result : ((result as { statuses?: unknown }).statuses ?? []);
      return (list as LinearStatus[]).filter((entry) => typeof entry.name === "string");
    }));

  const toItem = (issue: LinearIssue): WorkItem => {
    const parsed = parseBody(issue.description ?? "");
    return WorkItemSchema.parse({
      id: issue.identifier ?? issue.id,
      title: issue.title.slice(0, 200),
      status: linearStatusOf(statusType(issue), statusName(issue)),
      ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
      dependsOn: parsed.dependsOn,
      summary: parsed.summary,
      criteria: parsed.criteria,
      evidence: parsed.evidence,
      location: issue.url ?? "",
      ...(issue.updatedAt === undefined ? {} : { updatedAt: issue.updatedAt }),
    });
  };

  const fetchIssue = async (id: string): Promise<LinearIssue> => {
    try {
      const issue = (await options.call("get_issue", { id })) as LinearIssue | undefined;
      if (issue === undefined || typeof issue.title !== "string") throw new WorkItemNotFoundError(id);
      return issue;
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) throw error;
      if (/not found|entity not found/iu.test(String(error))) throw new WorkItemNotFoundError(id);
      throw error;
    }
  };

  const save = async (args: Record<string, unknown>): Promise<LinearIssue> =>
    (await options.call("save_issue", args)) as LinearIssue;

  const saveDescription = async (issue: LinearIssue, next: string, extra: Record<string, unknown> = {}) => {
    const before = issue.description ?? "";
    // A description holding uploaded media is edited section by section so the
    // media nodes are never round-tripped through a read.
    const args = /uploads\.linear\.app/u.test(before)
      ? { patch: descriptionPatch(before, next) }
      : { description: next };
    return save({ id: issue.identifier ?? issue.id, ...args, ...extra });
  };

  return {
    kind: "linear",
    async list(filter) {
      const result = (await options.call("list_issues", {
        team: options.team,
        ...(options.project === undefined ? {} : { project: options.project }),
        limit: Math.min(filter?.limit ?? 100, 250),
        fields: FIELDS,
      })) as { issues?: LinearIssue[] } | LinearIssue[];
      const issues = Array.isArray(result) ? result : (result.issues ?? []);
      return issues.map(toItem).filter((item) => matchesFilter(item, filter));
    },
    async get(id) {
      try {
        return toItem(await fetchIssue(id));
      } catch (error) {
        if (error instanceof WorkItemNotFoundError) return undefined;
        throw error;
      }
    },
    async create(draft) {
      const description = patchBody(draft.summary ?? "", {
        criteria: (draft.criteria ?? []).map((text) => ({ text, done: false })),
        ...(draft.owner === undefined ? {} : { owner: draft.owner }),
        ...(draft.dependsOn === undefined ? {} : { dependsOn: draft.dependsOn }),
      });
      const created = await save({
        team: options.team,
        ...(options.project === undefined ? {} : { project: options.project }),
        title: draft.title,
        description,
        ...(draft.status === undefined ? {} : { state: pickLinearState(await teamStatuses(), draft.status) }),
      });
      return toItem(await fetchIssue(created.identifier ?? created.id));
    },
    async update(id, patch: WorkItemPatch) {
      const issue = await fetchIssue(id);
      const current = toItem(issue);
      const bodyChanged =
        touchesCriteria(patch) || patch.owner !== undefined || patch.dependsOn !== undefined;
      const extra = {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.status === undefined ? {} : { state: pickLinearState(await teamStatuses(), patch.status) }),
      };
      if (bodyChanged) {
        const next = patchBody(issue.description ?? "", {
          ...(touchesCriteria(patch) ? { criteria: patchCriteria(current.criteria, patch) } : {}),
          ...(patch.owner === undefined ? {} : { owner: patch.owner }),
          ...(patch.dependsOn === undefined ? {} : { dependsOn: patch.dependsOn }),
        });
        await saveDescription(issue, next, extra);
      } else if (Object.keys(extra).length > 0) {
        await save({ id: issue.identifier ?? issue.id, ...extra });
      }
      return toItem(await fetchIssue(id));
    },
    async attach(id, evidence) {
      const issue = await fetchIssue(id);
      const current = toItem(issue);
      await saveDescription(
        issue,
        patchBody(issue.description ?? "", { evidence: [...current.evidence, evidence] }),
      );
      return toItem(await fetchIssue(id));
    },
  };
}
