import {
  WORK_ITEM_LABEL_MAX,
  WORK_ITEM_LABELS_MAX,
  type WorkBackendKind,
  type WorkCriterion,
  type WorkEvidence,
  type WorkItem,
  type WorkItemStatus,
} from "@clankie/protocol/work-items";

export interface WorkItemDraft {
  readonly title: string;
  readonly summary?: string;
  readonly owner?: string;
  readonly criteria?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly status?: WorkItemStatus;
}

export interface WorkItemPatch {
  readonly status?: WorkItemStatus;
  /** `null` clears the owner. */
  readonly owner?: string | null;
  readonly title?: string;
  readonly dependsOn?: readonly string[];
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

/** One storage for work items. Every method speaks the ADR 0191 shape. */
export interface WorkBackend {
  readonly kind: WorkBackendKind;
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
