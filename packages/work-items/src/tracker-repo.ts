import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { WorkItemPrioritySchema, type WorkItem, type WorkItemStatus } from "@clankie/protocol/work-items";
import {
  patchLabels,
  WorkItemNotFoundError,
  type WorkBackend,
  type WorkItemPatch,
  type WorkWriteCallbacks,
} from "./backend.ts";
import { parseBody, patchBody } from "./format.ts";
import { createLocalTracker } from "./tracker-local.ts";
import { withTrackerStoreLock } from "./tracker-store-lock.ts";
import {
  applyTrackerDescriptionPatch,
  refuseBuiltInTrackerFeatures,
  TRACKER_TOOLS,
  validateTrackerToolArgs,
  type TrackerToolBackend,
} from "./tracker-tools.ts";

const STATES: Record<WorkItemStatus, { name: string; type: string }> = {
  backlog: { name: "Backlog", type: "backlog" },
  todo: { name: "Todo", type: "unstarted" },
  in_progress: { name: "In Progress", type: "started" },
  in_review: { name: "In Review", type: "started" },
  done: { name: "Done", type: "completed" },
  canceled: { name: "Canceled", type: "canceled" },
};

function statuses(value: unknown): WorkItemStatus[] {
  const key = String(value).toLowerCase().replace(/[ -]+/gu, "_");
  if (key in STATES) return [key as WorkItemStatus];
  if (key === "started") return ["in_progress", "in_review"];
  if (key === "unstarted") return ["todo"];
  if (key === "completed") return ["done"];
  if (key === "duplicate" || key === "cancelled") return ["canceled"];
  throw new Error(`Unknown issue state ${String(value)}`);
}

interface IssueMetadata {
  projectId?: string;
  blocks?: string[];
  relatedTo?: string[];
  duplicateOf?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  links?: { url: string; title: string }[];
}

/**
 * Native repository issues and local ancillary records share the Linear-shaped
 * vocabulary. Comments, projects and status updates live beside the backend's
 * state; their URLs/provenance explicitly identify local repository metadata.
 */
export function createRepoTracker(
  options: {
    readonly backend: WorkBackend;
    readonly directory: string;
    readonly clock?: () => Date;
  } & WorkWriteCallbacks,
): TrackerToolBackend {
  const native = options.backend;
  const metadataPath = join(options.directory, "repo-issues.json");
  const readMetadata = async (): Promise<Record<string, IssueMetadata>> => {
    try {
      return Object.assign(
        Object.create(null) as Record<string, IssueMetadata>,
        JSON.parse(await readFile(metadataPath, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return Object.create(null) as Record<string, IssueMetadata>;
      throw error;
    }
  };
  const writeMetadata = async (metadata: Record<string, IssueMetadata>, assertHeld: () => void) => {
    await mkdir(options.directory, { recursive: true });
    const temporary = `${metadataPath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await options.beforeWrite?.();
      assertHeld();
      options.onDispatch?.();
      await rename(temporary, metadataPath);
      options.effectConfirmed?.();
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const issue = async (reference: string): Promise<WorkItem> => {
    const item = await native.get(reference);
    if (!item) throw new WorkItemNotFoundError(reference);
    return item;
  };
  const local = createLocalTracker({
    directory: join(options.directory, "ancillary"),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    issueResolver: async (reference) => {
      const item = await native.get(reference);
      return item === undefined ? undefined : { id: item.id, identifier: item.id };
    },
  });
  const toIssue = async (item: WorkItem, metadata: Record<string, IssueMetadata>) => {
    const raw = await native.readIssue?.(item.id);
    const own = metadata[item.id] ?? {};
    const blockedBy = [
      ...new Set([
        ...item.dependsOn,
        ...Object.entries(metadata)
          .filter(([, value]) => value.blocks?.includes(item.id))
          .map(([id]) => id),
      ]),
    ];
    const relatedTo = [
      ...new Set([
        ...(own.relatedTo ?? []),
        ...Object.entries(metadata)
          .filter(([, value]) => value.relatedTo?.includes(item.id))
          .map(([id]) => id),
      ]),
    ];
    return {
      id: item.id,
      identifier: item.id,
      title: item.title,
      description: patchBody(item.summary, {
        owner: item.owner ?? null,
        dependsOn: item.dependsOn,
        criteria: item.criteria,
        evidence: item.evidence,
      }),
      labels: item.labels ?? [],
      priority: item.priority ?? 0,
      ...(item.milestone === undefined ? {} : { milestone: item.milestone }),
      ...raw,
      status: STATES[item.status].name,
      state: STATES[item.status].name,
      statusType: STATES[item.status].type,
      parentId: item.parent ?? null,
      projectId: own.projectId ?? null,
      url: item.location,
      backend: native.kind,
      ...own,
      blockedBy,
      relatedTo,
    };
  };
  const referenceIds = async (value: unknown, allowUnresolved = false): Promise<string[]> => {
    const result: string[] = [];
    for (const reference of (value ?? []) as string[]) {
      const item = allowUnresolved ? await native.get(reference) : await issue(reference);
      const id = item?.id ?? reference;
      if (!result.includes(id)) result.push(id);
    }
    return result;
  };
  const delta = (existing: readonly string[], additions: readonly string[], removals: readonly string[]) =>
    [...new Set([...existing, ...additions])].filter((id) => !removals.includes(id));

  const call = async (
    name: string,
    args: Record<string, unknown>,
    assertHeld?: () => void,
  ): Promise<unknown> => {
    validateTrackerToolArgs(name, args);
    refuseBuiltInTrackerFeatures(name, args);
    if (name === "list_releases" || name === "get_release")
      throw new Error("Releases live in Clankie's built-in tracker; read them with clankie work releases");
    if (name === "list_cycles" || args.cycle !== undefined)
      throw new Error("Cycles live in Clankie's built-in tracker; use clankie work cycle");
    switch (name) {
      case "list_issue_statuses":
        return Object.entries(STATES).map(([id, state]) => ({ id, ...state }));
      case "get_issue": {
        const item = await issue(args.id as string);
        const metadata = await readMetadata();
        const result = await toIssue(item, metadata);
        if (args.includeRelations !== true) return result;
        const all = await native.list();
        const related = (ids: readonly string[]) => ids.map((id) => ({ id, identifier: id }));
        return {
          ...result,
          relations: {
            parent: item.parent === undefined ? null : { id: item.parent, identifier: item.parent },
            children: related(all.filter((entry) => entry.parent === item.id).map((entry) => entry.id)),
            blockedBy: related(result.blockedBy),
            blocks: related([
              ...new Set([
                ...(result.blocks ?? []),
                ...all.filter((entry) => entry.dependsOn.includes(item.id)).map((entry) => entry.id),
              ]),
            ]),
            relatedTo: related(result.relatedTo ?? []),
            duplicateOf:
              result.duplicateOf == null ? null : { id: result.duplicateOf, identifier: result.duplicateOf },
          },
        };
      }
      case "list_issues":
      case "search_issues": {
        const metadata = await readMetadata();
        const items = await native.list({
          ...(args.state === undefined ? {} : { status: statuses(args.state) }),
          ...(typeof args.assignee === "string" ? { owner: args.assignee } : {}),
          ...(typeof args.label === "string" ? { label: args.label } : {}),
        });
        let projectId: string | undefined;
        if (typeof args.project === "string")
          projectId = ((await local.call("get_project", { query: args.project })) as { id: string }).id;
        const query = typeof args.query === "string" ? args.query.toLowerCase() : undefined;
        const matching = items.filter(
          (item) =>
            (args.priority === undefined || (item.priority ?? 0) === args.priority) &&
            (args.parentId === undefined || item.parent === args.parentId) &&
            (args.assignee !== null || item.owner === undefined) &&
            (projectId === undefined || metadata[item.id]?.projectId === projectId) &&
            (query === undefined ||
              `${item.id}\n${item.title}\n${item.summary}`.toLowerCase().includes(query)),
        );
        const offset = args.cursor === undefined ? 0 : Number(args.cursor);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid tracker cursor");
        const limit = (args.limit as number | undefined) ?? 50;
        const selected = matching.slice(offset, offset + limit);
        const end = offset + selected.length;
        return {
          issues: await Promise.all(selected.map((item) => toIssue(item, metadata))),
          hasNextPage: end < matching.length,
          ...(end < matching.length ? { cursor: String(end) } : {}),
        };
      }
      case "save_issue": {
        if (args.description !== undefined && args.patch !== undefined)
          throw new Error("Choose description or patch, never both");
        if (args.labels !== undefined && (args.addLabels !== undefined || args.removeLabels !== undefined))
          throw new Error("Choose replacement labels or label deltas, never both");
        const metadata = await readMetadata();
        const current = args.id === undefined ? undefined : await issue(args.id as string);
        if (!current && (typeof args.title !== "string" || typeof args.team !== "string"))
          throw new Error("Creating an issue needs team and title");
        if (!current && args.patch !== undefined)
          throw new Error("Description patches require an existing issue");
        const raw = current === undefined ? undefined : await native.readIssue?.(current.id);
        const before =
          (raw?.description as string | undefined) ??
          (current === undefined ? "" : ((await toIssue(current, metadata)).description as string));
        const description =
          args.patch === undefined ? args.description : applyTrackerDescriptionPatch(before, args.patch);
        const parsed = typeof description === "string" ? parseBody(description) : undefined;
        const priority =
          args.priority === undefined ? undefined : WorkItemPrioritySchema.parse(args.priority);
        const nextState = args.state === undefined ? undefined : statuses(args.state)[0];
        const parent =
          args.parentId === null
            ? null
            : typeof args.parentId === "string"
              ? (await issue(args.parentId)).id
              : undefined;
        const relation = {
          blocks: await referenceIds(args.blocks),
          removeBlocks: await referenceIds(args.removeBlocks),
          // Existing repo dependency metadata may refer to a task not materialized here yet.
          blockedBy: await referenceIds(args.blockedBy, true),
          removeBlockedBy: await referenceIds(args.removeBlockedBy, true),
          relatedTo: await referenceIds(args.relatedTo),
          removeRelatedTo: await referenceIds(args.removeRelatedTo),
        };
        if (
          current &&
          [...relation.blocks, ...relation.blockedBy, ...relation.relatedTo].includes(current.id)
        )
          throw new Error("An issue cannot relate to itself");
        if (current && parent === current.id) throw new Error("An issue cannot be its own parent");
        if (current && typeof parent === "string") {
          const ancestors = new Set<string>();
          let ancestor: string | undefined = parent;
          while (ancestor !== undefined) {
            if (ancestor === current.id || ancestors.has(ancestor))
              throw new Error("Issue parents cannot form a cycle");
            ancestors.add(ancestor);
            ancestor = (await issue(ancestor)).parent;
          }
        }
        const project =
          typeof args.project === "string"
            ? ((await local.call("get_project", { query: args.project })) as { id: string }).id
            : args.project;
        const duplicate =
          typeof args.duplicateOf === "string" ? (await issue(args.duplicateOf)).id : args.duplicateOf;
        const dependsOn = delta(
          current?.dependsOn ?? parsed?.dependsOn ?? [],
          relation.blockedBy,
          relation.removeBlockedBy,
        );
        const rawLabels = (raw?.labels as string[] | undefined) ?? current?.labels ?? [];
        const labels = patchLabels(rawLabels, {
          ...(args.labels === undefined ? {} : { labels: args.labels as string[] }),
          ...(args.addLabels === undefined ? {} : { addLabels: args.addLabels as string[] }),
          ...(args.removeLabels === undefined ? {} : { removeLabels: args.removeLabels as string[] }),
        });
        const saved =
          current === undefined
            ? await native.create({
                title: args.title as string,
                summary: parsed?.summary ?? "",
                ...(description === undefined ? {} : { description: description as string }),
                ...(parsed?.owner === undefined && args.assignee == null
                  ? {}
                  : { owner: (args.assignee ?? parsed?.owner) as string }),
                ...(priority === undefined ? {} : { priority }),
                ...(nextState === undefined ? {} : { status: nextState }),
                ...(parent == null ? {} : { parent }),
                labels,
                criteria: parsed?.criteria.map((criterion) => criterion.text) ?? [],
                dependsOn,
              })
            : await native.update(current.id, {
                ...(args.title === undefined ? {} : { title: args.title as string }),
                ...(priority === undefined ? {} : { priority }),
                ...(nextState === undefined ? {} : { status: nextState }),
                ...(parent === undefined ? {} : { parent }),
                ...(args.labels === undefined &&
                args.addLabels === undefined &&
                args.removeLabels === undefined
                  ? {}
                  : { labels }),
                ...(args.assignee === undefined ? {} : { owner: args.assignee as string | null }),
                ...(parsed === undefined ? {} : { description: description as string }),
                ...(args.blockedBy === undefined && args.removeBlockedBy === undefined && parsed === undefined
                  ? {}
                  : { dependsOn }),
              } satisfies WorkItemPatch);
        const own = { ...metadata[saved.id] };
        if (project === null) delete own.projectId;
        else if (typeof project === "string") own.projectId = project;
        for (const key of ["blocks", "relatedTo"] as const)
          if (
            args[key] !== undefined ||
            args[key === "blocks" ? "removeBlocks" : "removeRelatedTo"] !== undefined
          )
            own[key] = delta(
              own[key] ?? [],
              relation[key],
              relation[key === "blocks" ? "removeBlocks" : "removeRelatedTo"],
            );
        for (const [targets, adding] of [
          [relation.blocks, true],
          [relation.removeBlocks, false],
        ] as const) {
          for (const target of targets) {
            const other = await issue(target);
            await native.update(target, {
              dependsOn: delta(other.dependsOn, adding ? [saved.id] : [], adding ? [] : [saved.id]),
            });
          }
        }
        for (const [targets, adding, field] of [
          [relation.blockedBy, true, "blocks"],
          [relation.removeBlockedBy, false, "blocks"],
          [relation.relatedTo, true, "relatedTo"],
          [relation.removeRelatedTo, false, "relatedTo"],
        ] as const) {
          for (const target of targets) {
            const other = { ...metadata[target] };
            other[field] = delta(other[field] ?? [], adding ? [saved.id] : [], adding ? [] : [saved.id]);
            metadata[target] = other;
          }
        }
        if (args.duplicateOf !== undefined) own.duplicateOf = duplicate as string | null;
        if (args.dueDate !== undefined) own.dueDate = args.dueDate as string | null;
        if (args.estimate !== undefined) own.estimate = args.estimate as number | null;
        if (args.links !== undefined) own.links = args.links as { url: string; title: string }[];
        if (
          JSON.stringify(own) !== JSON.stringify(metadata[saved.id] ?? {}) ||
          relation.blockedBy.length > 0 ||
          relation.removeBlockedBy.length > 0 ||
          relation.relatedTo.length > 0 ||
          relation.removeRelatedTo.length > 0
        ) {
          metadata[saved.id] = own;
          if (assertHeld === undefined)
            throw new Error("Repository tracker metadata write requires its store lock");
          await writeMetadata(metadata, assertHeld);
        }
        return toIssue(await issue(saved.id), metadata);
      }
      case "list_issue_labels": {
        const nativeLabels = [...new Set((await native.list()).flatMap((item) => item.labels ?? []))];
        const localLabels = (await local.call(name, args)) as {
          labels: { name: string }[];
          hasNextPage: boolean;
        };
        const existing = new Set(localLabels.labels.map((label) => label.name.toLowerCase()));
        return {
          ...localLabels,
          labels: [
            ...localLabels.labels,
            ...nativeLabels
              .filter((label) => !existing.has(label.toLowerCase()))
              .map((name) => ({ id: name, name })),
          ],
        };
      }
      default:
        return local.call(name, args, options);
    }
  };
  return {
    catalog: () => TRACKER_TOOLS,
    async call(name, args) {
      if (name !== "save_issue") return call(name, args);
      return withTrackerStoreLock(metadataPath, (assertHeld) => call(name, args, assertHeld));
    },
  };
}
