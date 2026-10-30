import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { WorkEvidence, WorkItemStatus } from "@clankie/protocol/work-items";
import { DEFAULT_WORK_DIRECTORY } from "./convention.ts";
import {
  createFilesBackend,
  ensurePrivateGitignore,
  filesBackendRoot,
  parseFile,
  PRIVATE_WORK_LOCK,
  serializeFile,
  statusOf,
} from "./backends/files.ts";
import { appendEvidence, newWorkItemId, parseBody, slugify } from "./format.ts";
import { withTrackerStoreLock } from "./tracker-store-lock.ts";

/**
 * Drops (step 5, C3): what the owner throws at Clankie from the phone or the
 * Mac, filed at once as a stub issue file in the repo's private `.clankie/work/`
 * (the main checkout's, shared by every worktree), so nothing is lost while no
 * agent runs. The project's lead later refines the stub like any issue file.
 *
 * A drop file carries `drop_key` (the caller's hash of its idempotency key) in
 * its front matter, which is what makes it a drop: a retry finds the file again
 * by it, even after the sidecar below is lost. `.drops.json` beside the files
 * (ignored with them) records each key's request hash and whether its lead has
 * been woken, so a retry neither files nor wakes twice. Both are read and
 * written under the folder's write lock, which every files-backend write holds.
 */

export const DROP_LABEL = "drop";
const RECEIPTS = ".drops.json";
const KEY = /^[0-9a-f]{64}$/u;

/** A paired device by its owner-given name, or this machine itself (the CLI or console). */
export interface DropSource {
  readonly kind: "device" | "machine";
  readonly name?: string | undefined;
  readonly platform?: string | undefined;
}

/**
 * `waking` is written before the lead is woken and replaced after, so a try that
 * stopped in between reads as uncertain and is never woken again.
 */
export type DropWake = "waking" | "woken" | "not_woken";

export interface DropReceipt {
  readonly request: string;
  readonly itemId: string;
  readonly wake: DropWake;
  readonly lead?: string;
}

export interface DropDraft {
  /** A hash the caller derives from the project and the client's idempotency key. */
  readonly key: string;
  /** A hash of everything the request said; the same key with another request is a conflict. */
  readonly request: string;
  readonly projectId: string;
  readonly title: string;
  /** The owner's words, kept whole; the caller bounds their length. */
  readonly body: string;
  readonly evidence: readonly WorkEvidence[];
  readonly source: DropSource;
}

export interface DropRecord {
  readonly id: string;
  readonly title: string;
  readonly status: WorkItemStatus;
  /** The main checkout whose private folder holds the file. */
  readonly root: string;
  /** The file, relative to `root`. */
  readonly file: string;
  readonly droppedAt: string;
  readonly key: string;
  readonly projectId?: string;
  readonly source?: DropSource;
  /** The file's text outside its criteria and evidence sections. */
  readonly summary: string;
  readonly evidence: readonly WorkEvidence[];
}

export class DropConflictError extends Error {
  public constructor() {
    super("That idempotency key already filed a different drop. Use a new key for a new drop.");
  }
}

const folderOf = (root: string) => {
  const main = filesBackendRoot(root, DEFAULT_WORK_DIRECTORY);
  return { main, directory: resolve(main, DEFAULT_WORK_DIRECTORY) };
};
/** A worktree's older private items join the shared folder first, as every files-backend read does. */
const adopt = (root: string) =>
  createFilesBackend({ root, directory: DEFAULT_WORK_DIRECTORY, kind: "default" }).list({ limit: 1 });

type Receipts = Record<string, DropReceipt>;
async function readReceipts(directory: string): Promise<Receipts> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, RECEIPTS), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Receipts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  // A missing or damaged sidecar starts empty: the files' own `drop_key` still finds each drop.
  return {};
}
async function writeAtomic(path: string, text: string, exclusive = false): Promise<void> {
  if (exclusive) {
    await writeFile(path, text, { encoding: "utf8", flag: "wx" });
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readFolder(directory: string) {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const name of names.filter((entry) => entry.endsWith(".md") && !/^readme\.md$/iu.test(entry)).sort()) {
    const path = join(directory, name);
    files.push(parseFile(path, await readFile(path, "utf8")));
  }
  return files;
}

function recordOf(main: string, file: ReturnType<typeof parseFile>): DropRecord | undefined {
  const key = file.fields.get("drop_key");
  if (key === undefined || !KEY.test(key)) return undefined;
  const name = file.path.split(/[\\/]/u).at(-1)!;
  const parsed = parseBody(file.body);
  const id = file.fields.get("id") ?? name.replace(/\.md$/u, "");
  const droppedAt = file.fields.get("dropped") ?? file.fields.get("created") ?? "";
  const from = file.fields.get("drop_source");
  const device = file.fields.get("drop_device");
  const platform = file.fields.get("drop_platform");
  const project = file.fields.get("drop_project");
  return {
    id,
    title: file.fields.get("title") ?? id,
    status: statusOf(file.fields.get("status")),
    root: main,
    file: relative(main, file.path),
    droppedAt,
    key,
    ...(project === undefined || project === "" ? {} : { projectId: project }),
    ...(from === "machine"
      ? { source: { kind: "machine" as const } }
      : from === "device"
        ? {
            source: {
              kind: "device" as const,
              ...(device ? { name: device } : {}),
              ...(platform ? { platform } : {}),
            },
          }
        : {}),
    summary: parsed.summary,
    evidence: parsed.evidence,
  };
}

/**
 * The stub's text: the owner's words, then their attachments as `## Evidence`
 * lines, added after anything the owner already wrote in such a section.
 */
export function renderDropBody(body: string, evidence: readonly WorkEvidence[]): string {
  const text = body.replace(/\r\n?/gu, "\n").trim();
  return evidence.length === 0 ? text : appendEvidence(`${text}\n\n`, evidence).trim();
}

/**
 * Files one drop, or finds the one already filed under its key. The caller has
 * already stored any media; this only writes text into the private folder.
 */
export async function fileDrop(
  root: string,
  draft: DropDraft,
  options: {
    readonly clock?: () => Date;
    readonly newId?: () => string;
    /** Rechecks the caller's authority once the folder lock is held, before anything is written. */
    readonly beforeWrite?: () => Promise<void>;
  } = {},
): Promise<{ readonly created: boolean; readonly drop: DropRecord; readonly receipt: DropReceipt }> {
  if (!KEY.test(draft.key) || !KEY.test(draft.request)) throw new Error("Drop keys are SHA-256 hex");
  const { main, directory } = folderOf(root);
  await adopt(root);
  await mkdir(directory, { recursive: true });
  return withTrackerStoreLock(join(directory, PRIVATE_WORK_LOCK), async (assertHeld) => {
    await options.beforeWrite?.();
    await ensurePrivateGitignore(directory);
    const receipts = await readReceipts(directory);
    const held = receipts[draft.key];
    if (held !== undefined && held.request !== draft.request) throw new DropConflictError();
    const files = await readFolder(directory);
    for (const file of files) {
      const record = recordOf(main, file);
      if (record?.key !== draft.key) continue;
      // Filed before: by this key's receipt, or (with the sidecar lost) by the file alone,
      // in which case the stub was written but its lead was never woken.
      const receipt = held ?? { request: draft.request, itemId: record.id, wake: "not_woken" as const };
      if (held === undefined) {
        await writeAtomic(join(directory, RECEIPTS), JSON.stringify({ ...receipts, [draft.key]: receipt }));
      }
      return { created: false, drop: record, receipt };
    }
    const taken = new Set(
      files.map((file) => (file.fields.get("id") ?? "").toLowerCase()).filter((id) => id !== ""),
    );
    let id = (options.newId ?? newWorkItemId)();
    while (taken.has(id.toLowerCase())) id = newWorkItemId();
    const now = (options.clock?.() ?? new Date()).toISOString();
    const single = (value: string) => value.replace(/\s*[\r\n]+\s*/gu, " ").trim();
    const title = single(draft.title).slice(0, 200) || id;
    const fields = new Map<string, string>([
      ["id", id],
      ["title", title],
      ["status", "todo"],
      ["priority", "0"],
      ["labels", JSON.stringify([DROP_LABEL])],
      ["created", now],
      ["updated", now],
      ["dropped", now],
      ["drop_key", draft.key],
      ["drop_project", draft.projectId],
      ["drop_source", draft.source.kind],
    ]);
    if (draft.source.kind === "device") {
      if (draft.source.name) fields.set("drop_device", single(draft.source.name).slice(0, 64));
      if (draft.source.platform) fields.set("drop_platform", draft.source.platform);
    }
    const body = renderDropBody(draft.body, draft.evidence);
    const path = join(directory, `${id}-${slugify(title)}.md`);
    assertHeld();
    await writeAtomic(path, serializeFile(fields, `\n${body}${body === "" ? "" : "\n"}`), true);
    const receipt: DropReceipt = { request: draft.request, itemId: id, wake: "not_woken" };
    await writeAtomic(join(directory, RECEIPTS), JSON.stringify({ ...receipts, [draft.key]: receipt }));
    const written = recordOf(main, parseFile(path, await readFile(path, "utf8")));
    if (written === undefined) throw new Error("The drop file did not read back");
    return { created: true, drop: written, receipt };
  });
}

/** Records where a drop's wake stands; `lead` names the conversation that took it. */
export async function recordDropWake(
  root: string,
  key: string,
  wake: DropWake,
  lead?: string,
): Promise<void> {
  const { directory } = folderOf(root);
  await withTrackerStoreLock(join(directory, PRIVATE_WORK_LOCK), async () => {
    const receipts = await readReceipts(directory);
    const held = receipts[key];
    if (held === undefined) throw new Error("No drop is filed under that key");
    const { lead: _previous, ...rest } = held;
    const next: DropReceipt = { ...rest, wake, ...(lead === undefined ? {} : { lead }) };
    await writeAtomic(join(directory, RECEIPTS), JSON.stringify({ ...receipts, [key]: next }));
  });
}

/** Every drop in the repo's private folder, read from the files as they are now. */
export async function readDrops(root: string): Promise<DropRecord[]> {
  const { main, directory } = folderOf(root);
  await adopt(root);
  return (await readFolder(directory)).flatMap((file) => recordOf(main, file) ?? []);
}
