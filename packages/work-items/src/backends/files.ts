import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  WorkItemPrioritySchema,
  WorkItemSchema,
  type WorkItem,
  type WorkItemStatus,
} from "@clankie/protocol/work-items";
import {
  matchesFilter,
  patchCriteria,
  patchDependsOn,
  patchLabels,
  touchesCriteria,
  sortWorkItems,
  WorkItemNotFoundError,
  WorkItemScopeError,
  workItemLabels,
  type WorkBackend,
  type WorkItemDraft,
  type WorkItemPatch,
  type WorkListFilter,
  type WorkWriteCallbacks,
} from "../backend.ts";
import { isWorkItemStatus, newWorkItemId, parseBody, patchBody, slugify } from "../format.ts";

/**
 * One Markdown file per item in a directory: `.clankie/work/` by default, or
 * the repo's own directory (`docs/tasks`, ...) when that is its convention.
 * Front matter carries the scalar fields; the body is the shared format.
 */

const FRONT = /^---\n([\s\S]*?)\n---\n?/u;
const ID_PREFIX = /^([A-Za-z]+-[A-Za-z0-9]+)(?:-|\.md$)/u;

interface FileItem {
  readonly path: string;
  readonly fields: Map<string, string>;
  readonly body: string;
}

function parseFile(path: string, text: string): FileItem {
  const match = FRONT.exec(text.replace(/\r\n?/gu, "\n"));
  const fields = new Map<string, string>();
  if (match) {
    let list: { key: string; items: string[] } | undefined;
    const closeList = () => {
      // An empty value with no items stays empty, as it always read.
      if (list !== undefined)
        fields.set(list.key, list.items.length === 0 ? "" : `[${list.items.join(", ")}]`);
      list = undefined;
    };
    for (const line of match[1]!.split("\n")) {
      // A YAML block list (`labels:` then `  - a`) folds into the flow form.
      const item = list === undefined ? null : /^\s+-\s+(.*)$/u.exec(line);
      if (item) {
        list!.items.push(item[1]!.trim());
        continue;
      }
      closeList();
      const pair = /^([A-Za-z_]+):\s*(.*)$/u.exec(line);
      if (!pair) continue;
      const key = pair[1]!.toLowerCase();
      if (pair[2]!.trim() === "") list = { key, items: [] };
      else fields.set(key, unquote(pair[2]!.trim()));
    }
    closeList();
  }
  return { path, fields, body: match ? text.slice(match[0].length) : text };
}

function unquote(value: string): string {
  if (/^".*"$/u.test(value)) return JSON.parse(value) as string;
  return /^'.*'$/u.test(value) ? value.slice(1, -1).replace(/''/gu, "'") : value;
}

/** `labels: [a, "b c"]` or `labels: a, b`. */
function listField(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const inner = /^\[(.*)\]$/su.exec(raw.trim())?.[1] ?? raw;
  return [...inner.matchAll(/\s*("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,]+)\s*(?:,|$)/gu)]
    .map((match) => match[1]!.trim())
    .filter((value) => value.length > 0)
    .map(unquote);
}

function quote(value: string): string {
  if (/^\[[^\]\n]*\]$/u.test(value)) return value;
  return /^[\w .,/@:+()-]*$/u.test(value) && !/^\s|\s$|:\s/u.test(value) ? value : JSON.stringify(value);
}

function serializeFile(fields: ReadonlyMap<string, string>, body: string): string {
  const order = ["id", "title", "status", "owner", "priority", "depends_on", "created", "updated"];
  const keys = [
    ...order.filter((key) => fields.has(key)),
    ...[...fields.keys()].filter((key) => !order.includes(key)),
  ];
  const front = keys.map((key) => `${key}: ${quote(fields.get(key)!)}`).join("\n");
  return `---\n${front}\n---\n${body}`;
}

function statusOf(raw: string | undefined): WorkItemStatus {
  const value = (raw ?? "todo").toLowerCase().replace(/[\s-]+/gu, "_");
  if (isWorkItemStatus(value)) return value;
  if (["open", "backlog", "planned"].includes(value)) return "todo";
  if (["doing", "active", "started", "wip"].includes(value)) return "in_progress";
  if (["review", "reviewing"].includes(value)) return "in_review";
  if (["closed", "complete", "completed", "finished"].includes(value)) return "done";
  if (["cancelled", "dropped", "wontfix", "won't_fix"].includes(value)) return "canceled";
  return "todo";
}

export interface FilesBackendOptions extends WorkWriteCallbacks {
  readonly root: string;
  /** Repo-relative directory; `.clankie/work` for the default backend. */
  readonly directory: string;
  readonly kind: "default" | "markdown";
  readonly clock?: () => Date;
  readonly newId?: () => string;
  readonly scopedWrites?: boolean;
}

export function createFilesBackend(options: FilesBackendOptions): WorkBackend {
  const root = resolve(options.root);
  const directory = resolve(root, options.directory);
  if (directory !== root && !directory.startsWith(root + sep))
    throw new Error("Work directory must be inside the repo");
  const clock = options.clock ?? (() => new Date());

  const assertScopedPath = (path: string, allowMissing = false) => {
    if (!options.scopedWrites) return;
    const local = relative(root, path);
    if (local.startsWith(`..${sep}`) || local === "..") throw new WorkItemScopeError();
    const parts = local === "" ? [] : local.split(sep);
    let current = root;
    for (let index = 0; index <= parts.length; index++) {
      if (index > 0) current = join(current, parts[index - 1]!);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || (index < parts.length && !stat.isDirectory()))
          throw new WorkItemScopeError();
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  };

  const toItem = (file: FileItem): WorkItem => {
    const parsed = parseBody(file.body);
    const name = file.path.split(sep).at(-1)!;
    const id = file.fields.get("id") ?? ID_PREFIX.exec(name)?.[1] ?? name.replace(/\.md$/u, "");
    const title =
      file.fields.get("title") ??
      /^#\s+(.+)$/mu.exec(file.body)?.[1]?.trim() ??
      name.replace(/\.md$/u, "").replace(/[-_]+/gu, " ");
    const owner = file.fields.get("owner") ?? parsed.owner;
    const parent = file.fields.get("parent");
    const depends = file.fields.get("depends_on");
    return WorkItemSchema.parse({
      id,
      ...(parent === undefined || parent.trim() === "" ? {} : { parent }),
      title: title.slice(0, 200),
      status: statusOf(file.fields.get("status")),
      // Authored Markdown can contain a typo; one malformed priority must not hide the repo's work.
      priority: WorkItemPrioritySchema.safeParse(Number(file.fields.get("priority") ?? "0")).data ?? 0,
      ...(owner === undefined || owner === "" ? {} : { owner }),
      dependsOn:
        depends === undefined
          ? parsed.dependsOn
          : depends
              .split(/[,\s]+/u)
              .map((value) => value.trim())
              .filter(Boolean),
      summary: parsed.summary.replace(/^#\s+.+\n?/u, "").trim(),
      criteria: parsed.criteria,
      evidence: parsed.evidence,
      location: relative(root, file.path),
      ...(file.fields.get("updated") === undefined ? {} : { updatedAt: file.fields.get("updated")! }),
      ...workItemLabels(listField(file.fields.get("labels"))),
    });
  };

  const readAll = async (): Promise<FileItem[]> => {
    assertScopedPath(directory, true);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files: FileItem[] = [];
    for (const name of names
      .filter((entry) => entry.endsWith(".md") && !/^readme\.md$/iu.test(entry))
      .sort()) {
      const path = join(directory, name);
      assertScopedPath(path);
      files.push(parseFile(path, await readFile(path, "utf8")));
    }
    return files;
  };

  const find = async (id: string): Promise<FileItem> => {
    const wanted = id.toLowerCase();
    const file = (await readAll()).find((candidate) => toItem(candidate).id.toLowerCase() === wanted);
    if (file === undefined) throw new WorkItemNotFoundError(id);
    return file;
  };

  const write = async (path: string, text: string): Promise<void> => {
    assertScopedPath(path);
    // Atomic replace: a reader never sees half an item, and two agents editing
    // different items never touch the same file.
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, text, "utf8");
      await options.beforeWrite?.();
      assertScopedPath(path);
      options.onDispatch?.();
      await rename(temporary, path);
      options.effectConfirmed?.();
    } finally {
      await rm(temporary, { force: true });
    }
  };

  return {
    kind: options.kind,
    async readIssue(id) {
      try {
        const file = await find(id);
        const item = toItem(file);
        return {
          ...item,
          identifier: item.id,
          description: file.body,
          labels: listField(file.fields.get("labels")),
          url: item.location,
        };
      } catch (error) {
        if (error instanceof WorkItemNotFoundError) return undefined;
        throw error;
      }
    },
    async list(filter?: WorkListFilter) {
      const { label, ...itemFilter } = filter ?? {};
      const items = (await readAll())
        .filter(
          (file) =>
            label === undefined ||
            listField(file.fields.get("labels")).some(
              (name) => name.trim().toLowerCase() === label.trim().toLowerCase(),
            ),
        )
        .map(toItem)
        .filter((item) => matchesFilter(item, itemFilter));
      return sortWorkItems(items).slice(0, filter?.limit ?? items.length);
    },
    async get(id) {
      try {
        return toItem(await find(id));
      } catch (error) {
        if (error instanceof WorkItemNotFoundError) return undefined;
        throw error;
      }
    },
    async create(draft: WorkItemDraft) {
      const priority = WorkItemPrioritySchema.parse(draft.priority ?? 0);
      await mkdir(directory, { recursive: true });
      const id = (options.newId ?? newWorkItemId)();
      const now = clock().toISOString();
      const fields = new Map<string, string>([
        ["id", id],
        ["title", draft.title],
        ["status", draft.status ?? "todo"],
        ["priority", String(priority)],
        ...(draft.parent === undefined ? [] : [["parent", draft.parent] as [string, string]]),
        ...((draft.labels?.length ?? 0) === 0
          ? []
          : [["labels", JSON.stringify(draft.labels)] as [string, string]]),
        ...(draft.owner === undefined ? [] : [["owner", draft.owner] as [string, string]]),
        ...((draft.dependsOn?.length ?? 0) === 0
          ? []
          : [["depends_on", draft.dependsOn!.join(", ")] as [string, string]]),
        ["created", now],
        ["updated", now],
      ]);
      const body =
        draft.description ??
        patchBody(draft.summary ?? "", {
          criteria: (draft.criteria ?? []).map((text) => ({ text, done: false })),
          evidence: [],
        });
      const path = join(directory, `${id}-${slugify(draft.title)}.md`);
      await options.beforeWrite?.();
      assertScopedPath(path, true);
      options.onDispatch?.();
      await writeFile(path, serializeFile(fields, `\n${body}`), { encoding: "utf8", flag: "wx" });
      options.effectConfirmed?.();
      return toItem({ path, fields, body });
    },
    async update(id, patch: WorkItemPatch) {
      const file = await find(id);
      const current = toItem(file);
      const fields = new Map(file.fields);
      if (patch.status !== undefined) fields.set("status", patch.status);
      if (patch.priority !== undefined)
        fields.set("priority", String(WorkItemPrioritySchema.parse(patch.priority)));
      if (patch.parent === null) fields.delete("parent");
      else if (patch.parent !== undefined) fields.set("parent", patch.parent);
      if (patch.title !== undefined) fields.set("title", patch.title);
      if (patch.owner === null) fields.delete("owner");
      else if (patch.owner !== undefined) fields.set("owner", patch.owner);
      if (patch.dependsOn !== undefined || patch.addDependsOn !== undefined) {
        const depends = patchDependsOn(current.dependsOn, patch);
        if (depends.length === 0) fields.delete("depends_on");
        else fields.set("depends_on", depends.join(", "));
      }
      if (patch.labels !== undefined || patch.addLabels !== undefined || patch.removeLabels !== undefined) {
        const labels = patchLabels(listField(file.fields.get("labels")), patch);
        if (labels.length === 0) fields.delete("labels");
        else fields.set("labels", JSON.stringify(labels));
      }
      if (!fields.has("id")) fields.set("id", current.id);
      if (!fields.has("title")) fields.set("title", current.title);
      fields.set("updated", clock().toISOString());
      const body =
        patch.summary !== undefined ||
        patch.evidence !== undefined ||
        touchesCriteria(patch) ||
        patch.owner !== undefined
          ? patchBody(patch.description ?? patch.summary ?? file.body, {
              ...(patch.summary === undefined
                ? {}
                : { criteria: current.criteria, evidence: current.evidence }),
              ...(touchesCriteria(patch) ? { criteria: patchCriteria(current.criteria, patch) } : {}),
              ...(patch.evidence === undefined ? {} : { evidence: patch.evidence }),
              // Front matter owns the new value; clear any older inline fallback.
              ...(patch.owner === undefined ? {} : { owner: null }),
            })
          : (patch.description ?? file.body);
      await write(file.path, serializeFile(fields, body));
      return toItem({ path: file.path, fields, body });
    },
    async attach(id, evidence) {
      const file = await find(id);
      const current = toItem(file);
      const fields = new Map(file.fields);
      fields.set("updated", clock().toISOString());
      if (!fields.has("id")) fields.set("id", current.id);
      const body = patchBody(file.body, { evidence: [...current.evidence, evidence] });
      await write(file.path, serializeFile(fields, body));
      return toItem({ path: file.path, fields, body });
    },
  };
}
