import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  WORK_ITEM_EVIDENCE_MAX,
  WORK_ITEM_LABEL_MAX,
  WORK_ITEM_LABELS_MAX,
  type WorkEvidence,
  type WorkItemStatus,
} from "@clankie/protocol/work-items";
import { DEFAULT_WORK_DIRECTORY, isPrivateWorkDirectory } from "./convention.ts";
import {
  ensurePrivateGitignore,
  filesBackendRoot,
  parseFile,
  PRIVATE_WORK_LOCK,
  serializeFile,
  type FileItem,
} from "./backends/files.ts";
import { linearStatusOf } from "./backends/linear.ts";
import { appendEvidence, inferEvidenceKind, parseBody, slugify } from "./format.ts";
import { withTrackerStoreLock } from "./tracker-store-lock.ts";

/**
 * `clankie work export`: a project's open tracker items become issue files in
 * the repo's private `.clankie/work/` (step 5, C2). The source tracker is only
 * read. Each file keeps the tracker's own identifier as its `id`, so a re-run
 * finds it again, and records `export_hash`, the hash of exactly what the
 * export wrote. The overwrite rule follows from that hash:
 *
 * - no file for the id: an open item gets a new file; a closed one is skipped;
 * - a file whose text still hashes to its `export_hash`: nobody changed it since
 *   the export, so it is refreshed from the tracker (a close there reaches it);
 * - any other file (changed by an agent, the owner or the files backend, or
 *   never written by export): kept byte for byte and reported, never overwritten.
 */

export interface ExportIssue {
  /** The tracker's own identifier: `LOCAL-VUH-12`, `VUH-2900`. */
  readonly id: string;
  readonly title: string;
  readonly status: WorkItemStatus;
  readonly priority: number;
  readonly labels: readonly string[];
  /** The tracker body: summary, `## Acceptance Criteria`, `## Evidence`, other sections. */
  readonly description: string;
  readonly parent?: string;
  readonly dependsOn: readonly string[];
  readonly milestone?: { readonly id: string; readonly name: string };
  readonly ownerCheck?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /** Where the item lived: its tracker URL. */
  readonly source?: string;
}

export type FilesExportAction = "create" | "update" | "unchanged" | "kept";

export interface FilesExportEntry {
  readonly id: string;
  readonly title: string;
  readonly status: WorkItemStatus;
  readonly action: FilesExportAction;
  /** Repo-relative path of the file written, or that would be written. */
  readonly file: string;
  readonly reason?: string;
}

export interface FilesExportResult {
  readonly dryRun: boolean;
  /** The main checkout whose private folder holds the files. */
  readonly root: string;
  readonly directory: string;
  readonly gitignore: { readonly file: string; readonly action: "create" | "present" };
  readonly counts: Record<FilesExportAction, number> & { readonly closedSkipped: number };
  readonly items: FilesExportEntry[];
}

const EXPORT_HASH_LINE = /^export_hash: [0-9a-f]{64}\n/mu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const open = (status: WorkItemStatus) => status !== "done" && status !== "canceled";

/** True when nothing changed the file since `clankie work export` wrote it. */
export function unchangedSinceExport(file: FileItem, text: string): boolean {
  const recorded = file.fields.get("export_hash");
  return recorded !== undefined && sha256(text.replace(EXPORT_HASH_LINE, "")) === recorded;
}

/** The exact text export writes for an issue, `export_hash` last. */
export function renderExportedIssue(issue: ExportIssue): string {
  const single = (value: string) => value.replace(/\s*[\r\n]+\s*/gu, " ").trim();
  const labels = [
    ...new Set(issue.labels.map((label) => single(label).slice(0, WORK_ITEM_LABEL_MAX)).filter(Boolean)),
  ].slice(0, WORK_ITEM_LABELS_MAX);
  const fields = new Map<string, string>([
    ["id", issue.id],
    ["title", single(issue.title).slice(0, 200) || issue.id],
    ["status", issue.status],
    [
      "priority",
      String(
        Number.isInteger(issue.priority) && issue.priority >= 0 && issue.priority <= 4 ? issue.priority : 0,
      ),
    ],
  ]);
  if (issue.parent !== undefined) fields.set("parent", issue.parent);
  if (labels.length > 0) fields.set("labels", JSON.stringify(labels));
  if (issue.dependsOn.length > 0) fields.set("depends_on", [...new Set(issue.dependsOn)].join(", "));
  if (issue.createdAt !== undefined) fields.set("created", issue.createdAt);
  if (issue.updatedAt !== undefined) fields.set("updated", issue.updatedAt);
  if (issue.milestone !== undefined) {
    fields.set("milestone_id", issue.milestone.id);
    fields.set("milestone_name", single(issue.milestone.name));
  }
  if (issue.ownerCheck !== undefined && issue.ownerCheck.trim() !== "")
    fields.set("owner_check", single(issue.ownerCheck));
  if (issue.source !== undefined) fields.set("source", issue.source);
  const description = issue.description.replace(/\r\n?/gu, "\n").trim();
  const text = serializeFile(fields, `\n${description}${description === "" ? "" : "\n"}`);
  fields.set("export_hash", sha256(text));
  return serializeFile(fields, `\n${description}${description === "" ? "" : "\n"}`);
}

async function readFolder(directory: string): Promise<Map<string, { file: FileItem; text: string }>> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const byId = new Map<string, { file: FileItem; text: string }>();
  for (const name of names.filter((entry) => entry.endsWith(".md") && !/^readme\.md$/iu.test(entry)).sort()) {
    const path = join(directory, name);
    const text = (await readFile(path, "utf8")).replace(/\r\n?/gu, "\n");
    const file = parseFile(path, text);
    const id = (file.fields.get("id") ?? name.replace(/\.md$/u, "")).toLowerCase();
    if (!byId.has(id)) byId.set(id, { file, text });
  }
  return byId;
}

/** The ids that already have a file in the folder, so a caller reads only what export needs. */
export async function exportedIssueIds(
  root: string,
  directory = DEFAULT_WORK_DIRECTORY,
): Promise<Set<string>> {
  return new Set((await readFolder(resolve(filesBackendRoot(root, directory), directory))).keys());
}

/**
 * Plans, and unless `dryRun` writes, the issue files for `issues` (open items,
 * plus any closed ones that already have a file). Writes hold the private
 * folder's lock, which the files backend's own writes hold too.
 */
export async function exportIssuesToFiles(options: {
  readonly root: string;
  readonly issues: readonly ExportIssue[];
  readonly dryRun: boolean;
  readonly directory?: string;
  /** Closed items the caller already left out, counted with the ones skipped here. */
  readonly closedSkipped?: number;
}): Promise<FilesExportResult> {
  const directoryName = options.directory ?? DEFAULT_WORK_DIRECTORY;
  if (!isPrivateWorkDirectory(directoryName))
    throw new Error("Export writes only the private .clankie/work folder");
  const root = filesBackendRoot(options.root, directoryName);
  const directory = resolve(root, directoryName);
  const plan = async () => {
    const existing = await readFolder(directory);
    const taken = new Set(
      (await readdir(directory).catch(() => [] as string[])).map((name) => name.toLowerCase()),
    );
    const items: (FilesExportEntry & { readonly text?: string; readonly path: string })[] = [];
    let closedSkipped = options.closedSkipped ?? 0;
    const seen = new Set<string>();
    for (const issue of options.issues) {
      const key = issue.id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const held = existing.get(key);
      const base = { id: issue.id, title: issue.title, status: issue.status };
      if (held === undefined) {
        if (!open(issue.status)) {
          closedSkipped += 1;
          continue;
        }
        // The file name is only a label: the front matter `id` is what a re-run matches.
        const stem = `${issue.id.replace(/[^A-Za-z0-9_-]+/gu, "-")}-${slugify(issue.title)}`;
        let name = `${stem}.md`;
        for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${stem}-${String(n)}.md`;
        taken.add(name.toLowerCase());
        const path = join(directory, name);
        items.push({
          ...base,
          action: "create",
          file: relative(root, path),
          path,
          text: renderExportedIssue(issue),
        });
        continue;
      }
      const file = relative(root, held.file.path);
      if (!unchangedSinceExport(held.file, held.text)) {
        items.push({
          ...base,
          action: "kept",
          file,
          path: held.file.path,
          reason:
            held.file.fields.get("export_hash") === undefined
              ? "This file was not written by export; left as it is."
              : "This file changed since it was exported; left as it is.",
        });
        continue;
      }
      const rendered = renderExportedIssue(issue);
      items.push(
        rendered === held.text
          ? { ...base, action: "unchanged", file, path: held.file.path }
          : { ...base, action: "update", file, path: held.file.path, text: rendered },
      );
    }
    return { items, closedSkipped };
  };
  const gitignoreFile = join(directory, ".gitignore");
  const finish = (
    planned: Awaited<ReturnType<typeof plan>>,
    gitignore: "create" | "present",
  ): FilesExportResult => {
    const counts = { create: 0, update: 0, unchanged: 0, kept: 0, closedSkipped: planned.closedSkipped };
    for (const item of planned.items) counts[item.action] += 1;
    return {
      dryRun: options.dryRun,
      root,
      directory: directoryName,
      gitignore: { file: relative(root, gitignoreFile), action: gitignore },
      counts,
      items: planned.items.map(({ text: _text, path: _path, ...entry }) => entry),
    };
  };
  if (options.dryRun) return finish(await plan(), existsSync(gitignoreFile) ? "present" : "create");
  await mkdir(directory, { recursive: true });
  return withTrackerStoreLock(join(directory, PRIVATE_WORK_LOCK), async (assertHeld) => {
    const created = await ensurePrivateGitignore(directory);
    const planned = await plan();
    for (const item of planned.items) {
      if (item.text === undefined) continue;
      const temporary = `${item.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, item.text, { encoding: "utf8", flag: "wx" });
        assertHeld();
        await rename(temporary, item.path);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return finish(planned, created ? "create" : "present");
  });
}

type Row = Readonly<Record<string, unknown>>;
const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined);

function labelNames(raw: Row): string[] {
  const labels = raw.labels;
  const list = Array.isArray(labels) ? labels : ((labels as { nodes?: unknown[] } | undefined)?.nodes ?? []);
  return list
    .map((label) => (typeof label === "string" ? label : (label as { name?: unknown } | null)?.name))
    .filter((name): name is string => typeof name === "string" && name.trim() !== "");
}

/** Built-in links and the current evidence bundle, as `## Evidence` lines the body lacks. */
function evidenceOf(raw: Row): WorkEvidence[] {
  const evidence: WorkEvidence[] = [];
  for (const link of Array.isArray(raw.links) ? (raw.links as Row[]) : []) {
    const url = text(link?.url);
    if (url !== undefined && url.length <= 2048)
      evidence.push({ kind: inferEvidenceKind(url), url, caption: text(link.title) ?? url });
  }
  const bundle = raw.bundle as { references?: unknown } | null | undefined;
  for (const reference of Array.isArray(bundle?.references) ? (bundle.references as Row[]) : []) {
    const url = text(reference?.url);
    const type = text(reference?.type) ?? "other";
    if (url === undefined || url.length > 2048) continue;
    const kind =
      type === "screenshot" ? "image" : type === "video" ? "video" : type === "log" ? "log" : "link";
    evidence.push({ kind, url, caption: `Evidence bundle ${type}` });
  }
  return evidence;
}

/** A tracker row's unified status, from Linear's state type or, without one, its name. */
export function trackerIssueStatus(raw: Row): WorkItemStatus {
  const status = raw.status as string | { name?: unknown; type?: unknown } | undefined;
  const statusName = typeof status === "string" ? status : (text(status?.name) ?? text(raw.state) ?? "");
  const statusType = (
    text(raw.statusType) ??
    (typeof status === "object" ? text(status?.type) : undefined) ??
    ""
  ).toLowerCase();
  return linearStatusOf(statusType, statusName);
}

/**
 * The issues that block this one, in each tracker's shape: a top-level `blockedBy`
 * (the built-in tracker), `relations.blockedBy` (a repo tracker read with relations),
 * or connected Linear's `inverseRelations` of type `blocks`, whose `issue` blocks this one.
 */
export function blockerReferences(raw: Row): unknown[] {
  const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);
  const object = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;
  return [
    ...list(raw.blockedBy),
    ...list(object(raw.relations)?.blockedBy),
    ...list(object(raw.inverseRelations)?.nodes)
      .map(object)
      .filter((node) => node?.type === "blocks")
      .map((node) => node!.issue),
  ];
}

/**
 * One tracker issue read (`get_issue` on the built-in tracker, the offline
 * Linear-shaped tracker, or connected Linear) as an export record. `identifierOf`
 * names a related issue by its identifier; a UUID it cannot name is dropped,
 * since it would mean nothing in a file.
 */
export function exportIssueFromTracker(
  raw: Row,
  identifierOf: (reference: string) => string | undefined,
): ExportIssue {
  const id = text(raw.identifier) ?? text(raw.id);
  const title = text(raw.title);
  if (id === undefined || title === undefined)
    throw new Error("A tracker issue without an identifier or title");
  const name = (reference: unknown): string | undefined => {
    if (reference !== null && typeof reference === "object") {
      const entry = reference as Row;
      return text(entry.identifier) ?? name(entry.id);
    }
    const value = text(reference);
    if (value === undefined) return undefined;
    return identifierOf(value) ?? (UUID.test(value) ? undefined : value);
  };
  const parent = name(raw.parent) ?? name(raw.parentId);
  const description = text(raw.description) ?? "";
  const parsed = parseBody(description);
  const extra = evidenceOf(raw).filter(
    (entry) => !parsed.evidence.some((existing) => existing.url === entry.url),
  );
  const room = Math.max(0, WORK_ITEM_EVIDENCE_MAX - parsed.evidence.length);
  const milestone = (raw.projectMilestone ?? raw.milestone) as Row | null | undefined;
  const priority = raw.priority as number | { value?: unknown } | undefined;
  const blockedBy = blockerReferences(raw);
  return {
    id,
    title,
    status: trackerIssueStatus(raw),
    priority: typeof priority === "number" ? priority : Number(priority?.value ?? 0),
    labels: labelNames(raw),
    description:
      extra.length === 0 || room === 0 ? description : appendEvidence(description, extra.slice(0, room)),
    ...(parent === undefined || parent === id ? {} : { parent }),
    dependsOn: [
      ...new Set([
        ...parsed.dependsOn,
        ...blockedBy.map(name).filter((entry): entry is string => entry !== undefined && entry !== id),
      ]),
    ],
    ...(text(milestone?.id) !== undefined && text(milestone?.name) !== undefined
      ? { milestone: { id: text(milestone!.id)!, name: text(milestone!.name)! } }
      : {}),
    ...(text(raw.ownerCheck) === undefined ? {} : { ownerCheck: text(raw.ownerCheck)! }),
    ...(text(raw.createdAt) === undefined ? {} : { createdAt: text(raw.createdAt)! }),
    ...(text(raw.updatedAt) === undefined ? {} : { updatedAt: text(raw.updatedAt)! }),
    ...(text(raw.url) === undefined ? {} : { source: text(raw.url)! }),
  };
}
