import { WorkItemSchema, type WorkItem, type WorkItemStatus } from "@clankie/protocol/work-items";
import {
  matchesFilter,
  patchCriteria,
  patchDependsOn,
  patchLabels,
  touchesCriteria,
  WorkItemNotFoundError,
  WorkItemScopeError,
  workItemLabels,
  type WorkBackend,
  type WorkItemPatch,
  type WorkWriteCallbacks,
} from "../backend.ts";
import { parseBody, patchBody, renderEvidence } from "../format.ts";

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
  readonly parentId?: string | null;
  /** A nested parent from a GraphQL-shaped issue read. */
  readonly parent?: { readonly identifier?: string; readonly id?: string } | null;
  readonly title: string;
  readonly description?: string | null;
  readonly status?: string | { readonly name?: string; readonly type?: string };
  readonly statusType?: string;
  readonly url?: string;
  readonly updatedAt?: string;
  readonly teamId?: string;
  readonly projectId?: string | null;
  /** Linear's MCP returns names; the GraphQL shape nests them. */
  readonly labels?:
    | readonly (string | { readonly name?: string })[]
    | { readonly nodes?: readonly { readonly name?: string }[] };
}

function linearLabelNames(issue: LinearIssue): unknown[] {
  const labels = issue.labels;
  const list = Array.isArray(labels) ? labels : ((labels as { nodes?: unknown[] } | undefined)?.nodes ?? []);
  return list.map((label) =>
    typeof label === "string" ? label : (label as { name?: unknown } | null)?.name,
  );
}

interface LinearStatus {
  readonly name: string;
  readonly type: string;
}

const FIELDS = ["title", "description", "status", "statusType", "url", "updatedAt", "labels", "parentId"];
const PAGE_SIZE = 50;

class LinearPaginationError extends Error {
  readonly code = "invalid_pagination";
  constructor() {
    super("Linear returned another page without a new cursor");
    this.name = "LinearPaginationError";
  }
}

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
  const isLead = (block: string) => !block.startsWith("## ");
  const oldLead = old.find(isLead)?.trim() ?? "";
  const nextLead = next.find(isLead)?.trim() ?? "";
  let prependedHeading: string | undefined;
  if (oldLead !== nextLead) {
    if (oldLead !== "") ops.push({ op: "replace", old_string: oldLead, new_string: nextLead });
    else if (nextLead !== "") {
      const first = old.find((block) => block.trim() !== "");
      if (first === undefined) ops.push({ op: "append", text: nextLead });
      else {
        prependedHeading = first.split("\n")[0]!;
        const replacement = next.find((block) => block.split("\n")[0] === prependedHeading) ?? first;
        ops.push({
          op: "replace",
          old_string: first.trim(),
          new_string: `${nextLead}\n\n${replacement.trim()}`,
        });
      }
    }
  }
  for (const block of next.filter((entry) => !isLead(entry))) {
    const heading = block.split("\n")[0]!;
    if (heading === prependedHeading) continue;
    const match = old.find((candidate) => candidate.split("\n")[0] === heading);
    if (match === undefined) ops.push({ op: "append", text: `\n\n${block.trim()}` });
    else if (match.trim() !== block.trim())
      ops.push({ op: "replace", old_string: match.trim(), new_string: block.trim() });
  }
  return ops;
}

export function createLinearBackend(
  options: {
    readonly team: string;
    readonly project?: string;
    readonly label?: string;
    readonly call: LinearToolCall;
    readonly scopedWrites?: boolean;
  } & WorkWriteCallbacks,
): WorkBackend {
  let statuses: Promise<LinearStatus[]> | undefined;
  const teamStatuses = () =>
    (statuses ??= options.call("list_issue_statuses", { team: options.team }).then((result) => {
      const list = Array.isArray(result) ? result : ((result as { statuses?: unknown }).statuses ?? []);
      return (list as LinearStatus[]).filter((entry) => typeof entry.name === "string");
    }));

  const toItem = (issue: LinearIssue): WorkItem => {
    const parsed = parseBody(issue.description ?? "");
    const parent = issue.parent?.identifier ?? issue.parentId ?? issue.parent?.id;
    return WorkItemSchema.parse({
      id: issue.identifier ?? issue.id,
      ...(parent == null ? {} : { parent }),
      title: issue.title.slice(0, 200),
      status: linearStatusOf(statusType(issue), statusName(issue)),
      ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
      dependsOn: parsed.dependsOn,
      summary: parsed.summary,
      criteria: parsed.criteria,
      evidence: parsed.evidence,
      location: issue.url ?? "",
      ...(issue.updatedAt === undefined ? {} : { updatedAt: issue.updatedAt }),
      ...workItemLabels(linearLabelNames(issue)),
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

  const save = async (args: Record<string, unknown>): Promise<LinearIssue> => {
    options.beforeWrite?.();
    options.onDispatch?.();
    const saved = await options.call("save_issue", args);
    options.effectConfirmed?.();
    return saved as LinearIssue;
  };

  const assertScope = async (issue: LinearIssue) => {
    if (!options.scopedWrites) return;
    const [team, project] = await Promise.all([
      options.call("get_team", { query: options.team }),
      options.project === undefined ? undefined : options.call("get_project", { query: options.project }),
    ]);
    const uuid = (value: unknown) =>
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
        ? value.toLowerCase()
        : undefined;
    const identity = (value: unknown) => {
      if (value === null || typeof value !== "object") return undefined;
      const resource = value as { id?: unknown; uuid?: unknown };
      if (resource.uuid !== undefined && uuid(resource.uuid) === undefined) return undefined;
      const ids = [uuid(resource.id), uuid(resource.uuid)].filter((id) => id !== undefined);
      return ids.length > 0 && ids.every((id) => id === ids[0]) ? ids[0] : undefined;
    };
    const teamId = identity(team);
    const projectId = identity(project);
    if (
      teamId === undefined ||
      uuid(issue.teamId) !== teamId ||
      (options.project !== undefined && (projectId === undefined || uuid(issue.projectId) !== projectId))
    )
      throw new WorkItemScopeError();
  };

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
      const limit = Math.min(filter?.limit ?? 100, 250);
      const { label, ...itemFilter } = filter ?? {};
      const items: WorkItem[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      while (items.length < limit) {
        const result = (await options.call("list_issues", {
          team: options.team,
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.label === undefined ? {} : { label: options.label }),
          limit: Math.min(PAGE_SIZE, limit - items.length),
          ...(cursor === undefined ? {} : { cursor }),
          fields: FIELDS,
        })) as { issues?: LinearIssue[]; hasNextPage?: boolean; cursor?: string } | LinearIssue[];
        const issues = Array.isArray(result) ? result : (result.issues ?? []);
        for (const issue of issues) {
          // Match the ad-hoc role against provider labels before the item's
          // bounded display projection. The saved repo label filters each page.
          if (
            label !== undefined &&
            !linearLabelNames(issue).some(
              (name) => typeof name === "string" && name.trim().toLowerCase() === label.trim().toLowerCase(),
            )
          )
            continue;
          const item = toItem(issue);
          if (matchesFilter(item, itemFilter)) items.push(item);
          if (items.length === limit) return items;
        }
        if (Array.isArray(result) || result.hasNextPage !== true) break;
        if (typeof result.cursor !== "string" || result.cursor.length === 0 || cursors.has(result.cursor))
          throw new LinearPaginationError();
        cursor = result.cursor;
        cursors.add(cursor);
      }
      return items;
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
        ...(options.label === undefined ? {} : { labels: [options.label] }),
        title: draft.title,
        description,
        ...(draft.status === undefined ? {} : { state: pickLinearState(await teamStatuses(), draft.status) }),
      });
      return toItem(await fetchIssue(created.identifier ?? created.id));
    },
    async update(id, patch: WorkItemPatch) {
      const issue = await fetchIssue(id);
      await assertScope(issue);
      const current = toItem(issue);
      const dependsChanged = patch.dependsOn !== undefined || patch.addDependsOn !== undefined;
      const bodyChanged = touchesCriteria(patch) || patch.owner !== undefined || dependsChanged;
      const extra = {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.status === undefined ? {} : { state: pickLinearState(await teamStatuses(), patch.status) }),
        ...(patch.addLabels === undefined && patch.removeLabels === undefined
          ? {}
          : {
              labels: patchLabels(
                linearLabelNames(issue).filter((name): name is string => typeof name === "string"),
                patch,
              ),
            }),
      };
      if (bodyChanged) {
        const next = patchBody(issue.description ?? "", {
          ...(touchesCriteria(patch) ? { criteria: patchCriteria(current.criteria, patch) } : {}),
          ...(patch.owner === undefined ? {} : { owner: patch.owner }),
          ...(dependsChanged ? { dependsOn: patchDependsOn(current.dependsOn, patch) } : {}),
        });
        await saveDescription(issue, next, extra);
      } else if (Object.keys(extra).length > 0) {
        await save({ id: issue.identifier ?? issue.id, ...extra });
      }
      return toItem(await fetchIssue(id));
    },
    async attach(id, evidence) {
      const issue = await fetchIssue(id);
      await assertScope(issue);
      const current = toItem(issue);
      const before = issue.description ?? "";
      if (/uploads\.linear\.app/u.test(before)) {
        // Insert the new evidence beside the heading; never serialize the
        // existing upload nodes into a replacement Evidence section.
        const headings: string[] = [];
        let fence = false;
        for (const line of before.replace(/\r\n?/gu, "\n").split("\n")) {
          if (/^\s*(```|~~~)/u.test(line)) fence = !fence;
          else if (!fence && /^##\s+evidence\s*$/iu.test(line)) headings.push(line);
        }
        const heading = headings[0];
        if (headings.length > 1 || (heading !== undefined && before.split(heading).length !== 2))
          throw new Error("Cannot attach evidence: the Evidence heading is ambiguous");
        const text = renderEvidence([evidence]).join("\n");
        await save({
          id: issue.identifier ?? issue.id,
          patch:
            heading === undefined
              ? [{ op: "append", text: `\n\n## Evidence\n\n${text}` }]
              : [{ op: "replace", old_string: heading, new_string: `${heading}\n\n${text}` }],
        });
        return toItem(await fetchIssue(id));
      }
      await saveDescription(
        issue,
        patchBody(issue.description ?? "", { evidence: [...current.evidence, evidence] }),
      );
      return toItem(await fetchIssue(id));
    },
  };
}
