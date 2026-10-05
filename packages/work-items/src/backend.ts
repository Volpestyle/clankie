import {
  WORK_ITEM_LABEL_MAX,
  WORK_ITEM_LABELS_MAX,
  WorkItemSchema,
  type WorkBackendKind,
  type WorkCriterion,
  type WorkEvidence,
  type WorkItem,
  type WorkItemStatus,
  type WorkItemPriority,
} from "@clankie/protocol/work-items";

export interface WorkItemDraft {
  readonly title: string;
  readonly summary?: string;
  /** Exact tracker body, used by the canonical tool surface. */
  readonly description?: string;
  readonly owner?: string;
  readonly criteria?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly status?: WorkItemStatus;
  readonly priority?: WorkItemPriority;
  readonly labels?: readonly string[];
  readonly parent?: string;
}

export interface WorkItemPatch {
  /** Exact tracker body; unlike the display summary, it retains every authored section. */
  readonly description?: string;
  readonly priority?: WorkItemPriority;
  readonly summary?: string;
  readonly parent?: string | null;
  readonly labels?: readonly string[];
  readonly evidence?: readonly WorkEvidence[];
  readonly status?: WorkItemStatus;
  /** `null` clears the owner. */
  readonly owner?: string | null;
  readonly title?: string;
  readonly dependsOn?: readonly string[];
  /** Adds prerequisites without replacing existing ones. */
  readonly addDependsOn?: readonly string[];
  readonly addLabels?: readonly string[];
  readonly removeLabels?: readonly string[];
  /** Replaces the whole checklist. */
  readonly criteria?: readonly WorkCriterion[];
  /** 1-based criterion numbers to tick or untick; applied after `criteria`. */
  readonly check?: readonly number[];
  readonly uncheck?: readonly number[];
  /** Appends criteria. */
  readonly addCriteria?: readonly string[];
}

export interface WorkListFilter {
  readonly status?: readonly WorkItemStatus[];
  readonly owner?: string;
  /** Items carrying this label, case-insensitively (ADR 0208). */
  readonly label?: string;
  readonly limit?: number;
}

/** Hooks at the backend's publish boundary, after read/patch preparation. */
export interface WorkWriteCallbacks {
  readonly beforeWrite?: (() => void) | (() => Promise<void>);
  readonly onDispatch?: () => void;
  readonly effectConfirmed?: () => void;
}

/** Merge label deltas from the raw tracker names, never the bounded display projection. */
export function patchLabels(existing: readonly string[], patch: WorkItemPatch): string[] {
  const key = (name: string) => name.trim().toLowerCase();
  const removed = new Set((patch.removeLabels ?? []).map(key));
  const next = [...(patch.labels ?? existing)].filter((name) => !removed.has(key(name)));
  for (const name of patch.addLabels ?? []) {
    const normalized = key(name);
    if (!removed.has(normalized) && !next.some((entry) => key(entry) === normalized)) next.push(name.trim());
  }
  return next;
}

/** Stable sorting keeps a backend's existing order for equal priorities. */
export function sortWorkItems(items: readonly WorkItem[]): WorkItem[] {
  const rank = (item: WorkItem) => (item.priority === undefined || item.priority === 0 ? 5 : item.priority);
  return [...items].sort((left, right) => rank(left) - rank(right));
}

export function patchDependsOn(existing: readonly string[], patch: WorkItemPatch): string[] {
  const next = [...(patch.dependsOn ?? existing)];
  for (const id of patch.addDependsOn ?? [])
    if (!next.some((entry) => entry.toLowerCase() === id.toLowerCase())) next.push(id);
  return WorkItemSchema.shape.dependsOn.parse(next);
}

/** One storage for work items. Every method speaks the ADR 0191 shape. */
export interface WorkBackend {
  readonly kind: WorkBackendKind;
  /** Raw canonical issue data retains provider labels and description beyond display bounds. */
  readonly readIssue?: (id: string) => Promise<Record<string, unknown> | undefined>;
  list(filter?: WorkListFilter): Promise<WorkItem[]>;
  get(id: string): Promise<WorkItem | undefined>;
  create(draft: WorkItemDraft): Promise<WorkItem>;
  update(id: string, patch: WorkItemPatch): Promise<WorkItem>;
  attach(id: string, evidence: WorkEvidence): Promise<WorkItem>;
}

export class WorkItemNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`No work item ${id}`);
    this.id = id;
    this.name = "WorkItemNotFoundError";
  }
}

export class WorkItemScopeError extends Error {
  readonly code = "work_item_out_of_scope";
  constructor() {
    super("The work item is not proven to belong to this repo's tracker");
    this.name = "WorkItemScopeError";
  }
}

/** Applies a patch's criteria edits to an existing checklist. */
export function patchCriteria(existing: readonly WorkCriterion[], patch: WorkItemPatch): WorkCriterion[] {
  const next = [...(patch.criteria ?? existing)].map((criterion) => ({ ...criterion }));
  for (const text of patch.addCriteria ?? []) next.push({ text, done: false });
  for (const [numbers, done] of [
    [patch.check ?? [], true],
    [patch.uncheck ?? [], false],
  ] as const) {
    for (const number of numbers) {
      const criterion = next[number - 1];
      if (criterion === undefined)
        throw new Error(`No criterion ${String(number)} (there are ${String(next.length)})`);
      criterion.done = done;
    }
  }
  return next;
}

export function touchesCriteria(patch: WorkItemPatch): boolean {
  return (
    patch.criteria !== undefined ||
    (patch.check?.length ?? 0) > 0 ||
    (patch.uncheck?.length ?? 0) > 0 ||
    (patch.addCriteria?.length ?? 0) > 0
  );
}

export function matchesFilter(item: WorkItem, filter: WorkListFilter | undefined): boolean {
  if (filter?.status !== undefined && filter.status.length > 0 && !filter.status.includes(item.status))
    return false;
  if (filter?.owner !== undefined && item.owner !== filter.owner) return false;
  if (filter?.label !== undefined) {
    const wanted = filter.label.trim().toLowerCase();
    if (!(item.labels ?? []).some((label) => label.trim().toLowerCase() === wanted)) return false;
  }
  return true;
}

/** A backend's label names as the item contract bounds them: trimmed, deduped, at most 20 of 64 chars. */
export function workItemLabels(names: readonly unknown[]): { labels?: string[] } {
  const labels = [
    ...new Set(
      names
        .map((name) => (typeof name === "string" ? name.trim().slice(0, WORK_ITEM_LABEL_MAX) : ""))
        .filter((name) => name.length > 0),
    ),
  ].slice(0, WORK_ITEM_LABELS_MAX);
  return labels.length === 0 ? {} : { labels };
}
