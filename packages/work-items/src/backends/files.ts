import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { WorkItemSchema, type WorkItem, type WorkItemStatus } from "@clankie/protocol/work-items";
import {
  matchesFilter,
  patchCriteria,
  touchesCriteria,
  WorkItemNotFoundError,
  type WorkBackend,
  type WorkItemDraft,
  type WorkItemPatch,
  type WorkListFilter,
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
    for (const line of match[1]!.split("\n")) {
      const pair = /^([A-Za-z_]+):\s*(.*)$/u.exec(line);
      if (pair) fields.set(pair[1]!.toLowerCase(), unquote(pair[2]!.trim()));
    }
  }
  return { path, fields, body: match ? text.slice(match[0].length) : text };
}

function unquote(value: string): string {
  return /^".*"$/u.test(value) ? (JSON.parse(value) as string) : value;
}

function quote(value: string): string {
  return /^[\w .,/@:+()-]*$/u.test(value) && !/^\s|\s$|:\s/u.test(value) ? value : JSON.stringify(value);
}

function serializeFile(fields: ReadonlyMap<string, string>, body: string): string {
  const order = ["id", "title", "status", "owner", "depends_on", "created", "updated"];
  const keys = [
    ...order.filter((key) => fields.has(key)),
    ...[...fields.keys()].filter((key) => !order.includes(key)),
  ];
  const front = keys.map((key) => `${key}: ${quote(fields.get(key)!)}`).join("\n");
  return `---\n${front}\n---\n\n${body.trim()}\n`;
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

export interface FilesBackendOptions {
  readonly root: string;
  /** Repo-relative directory; `.clankie/work` for the default backend. */
  readonly directory: string;
  readonly kind: "default" | "markdown";
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

export function createFilesBackend(options: FilesBackendOptions): WorkBackend {
  const root = resolve(options.root);
  const directory = resolve(root, options.directory);
  if (directory !== root && !directory.startsWith(root + sep))
    throw new Error("Work directory must be inside the repo");
  const clock = options.clock ?? (() => new Date());

  const toItem = (file: FileItem): WorkItem => {
    const parsed = parseBody(file.body);
    const name = file.path.split(sep).at(-1)!;
    const id = file.fields.get("id") ?? ID_PREFIX.exec(name)?.[1] ?? name.replace(/\.md$/u, "");
    const title =
      file.fields.get("title") ??
      /^#\s+(.+)$/mu.exec(file.body)?.[1]?.trim() ??
      name.replace(/\.md$/u, "").replace(/[-_]+/gu, " ");
    const owner = file.fields.get("owner") ?? parsed.owner;
    const depends = file.fields.get("depends_on");
    return WorkItemSchema.parse({
      id,
      title: title.slice(0, 200),
      status: statusOf(file.fields.get("status")),
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
    });
  };

  const readAll = async (): Promise<FileItem[]> => {
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
    // Atomic replace: a reader never sees half an item, and two agents editing
    // different items never touch the same file.
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, text, "utf8");
    await rename(temporary, path);
  };

  return {
    kind: options.kind,
    async list(filter?: WorkListFilter) {
      const items = (await readAll()).map(toItem).filter((item) => matchesFilter(item, filter));
      return items.slice(0, filter?.limit ?? items.length);
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
      await mkdir(directory, { recursive: true });
      const id = (options.newId ?? newWorkItemId)();
      const now = clock().toISOString();
      const fields = new Map<string, string>([
        ["id", id],
        ["title", draft.title],
        ["status", draft.status ?? "todo"],
        ...(draft.owner === undefined ? [] : [["owner", draft.owner] as [string, string]]),
        ...((draft.dependsOn?.length ?? 0) === 0
          ? []
          : [["depends_on", draft.dependsOn!.join(", ")] as [string, string]]),
        ["created", now],
        ["updated", now],
      ]);
      const body = patchBody(draft.summary ?? "", {
        criteria: (draft.criteria ?? []).map((text) => ({ text, done: false })),
        evidence: [],
      });
      const path = join(directory, `${id}-${slugify(draft.title)}.md`);
      await writeFile(path, serializeFile(fields, body), { encoding: "utf8", flag: "wx" });
      return toItem({ path, fields, body });
    },
    async update(id, patch: WorkItemPatch) {
      const file = await find(id);
      const current = toItem(file);
      const fields = new Map(file.fields);
      if (patch.status !== undefined) fields.set("status", patch.status);
      if (patch.title !== undefined) fields.set("title", patch.title);
      if (patch.owner === null) fields.delete("owner");
      else if (patch.owner !== undefined) fields.set("owner", patch.owner);
      if (patch.dependsOn !== undefined) {
        if (patch.dependsOn.length === 0) fields.delete("depends_on");
        else fields.set("depends_on", patch.dependsOn.join(", "));
      }
      if (!fields.has("id")) fields.set("id", current.id);
      if (!fields.has("title")) fields.set("title", current.title);
      fields.set("updated", clock().toISOString());
      const body = touchesCriteria(patch)
        ? patchBody(file.body, { criteria: patchCriteria(current.criteria, patch) })
        : file.body;
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
