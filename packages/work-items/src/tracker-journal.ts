import { constants as bufferConstants } from "node:buffer";
import { createHash, type Hash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { type FileHandle, mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

/**
 * Durable layout of a large built-in tracker store (LOCAL-VUH-42, ADR 0226).
 *
 * `tracker.json` stays the checkpoint. A small store keeps the single legacy file. A large one
 * leaves its sync commits out of the checkpoint, which instead names the journal segments it
 * covers. Each commit appends one line (its sync commit and record changes) to the newest
 * segment in `tracker.journal/` and fsyncs once. Segments are never pruned: they are the sync
 * history, and each checkpoint seals the segments it covers by digest.
 */
export const JOURNAL_DIRECTORY = "tracker.journal";

/** Below this a commit rewrites the whole file, as before; its fsync costs about the same. */
export const JOURNAL_THRESHOLD_BYTES = 2 * 1024 * 1024;

/** A checkpoint runs once the live journal reaches this, or an eighth of the checkpoint. */
export const CHECKPOINT_MIN_BYTES = 4 * 1024 * 1024;

/** Larger applied results stay only in their journal record; the receipt points at it. */
export const RECEIPT_RESULT_BYTES = 1024;

/** Previous builds parse the whole checkpoint as one string. These thresholds now warn
 * about rollback compatibility, not the streamed reader's capacity (LOCAL-VUH-49).
 */
export const CHECKPOINT_STRING_LIMIT = bufferConstants.MAX_STRING_LENGTH;
export const CHECKPOINT_WARN_RATIO = 0.5;

export interface CheckpointSize {
  readonly bytes: number;
  readonly limitBytes: number;
  readonly warnAtBytes: number;
  readonly state: "ok" | "warn";
}

/** The size of a store's `tracker.json` against the single-string limit, from its metadata alone; undefined without a store. */
export function trackerCheckpointSize(directory: string): CheckpointSize | undefined {
  let bytes: number;
  try {
    bytes = statSync(join(directory, "tracker.json")).size;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const warnAtBytes = Math.floor(CHECKPOINT_STRING_LIMIT * CHECKPOINT_WARN_RATIO);
  return {
    bytes,
    limitBytes: CHECKPOINT_STRING_LIMIT,
    warnAtBytes,
    state: bytes >= warnAtBytes ? "warn" : "ok",
  };
}

export interface SealedSegment {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Written into the checkpoint. An older build refuses it rather than open a partial store. */
export interface JournalHeader {
  readonly version: 1;
  /** The last sync commit the checkpoint holds, and its chain hash. */
  readonly syncId: number;
  readonly syncHash: string;
  /** The first sync commit with a full journal record; receipts after it can leave memory. */
  readonly since: number;
  readonly sealed: readonly SealedSegment[];
}

type Json = Record<string, unknown>;

/** How one commit changed the store's top-level fields and collections. */
export interface StoreChanges {
  set?: Json;
  unset?: string[];
  /** Records replaced in place by id, or appended when new. */
  upsert?: Record<string, Json[]>;
  remove?: Record<string, string[]>;
  append?: Record<string, unknown[]>;
  replace?: Record<string, unknown[]>;
}

export interface JournalRecord extends StoreChanges {
  readonly syncId: number;
  /** The hash-linked sync commit, exactly as the in-memory sync log holds it. */
  readonly commit: Json & { syncId: number; prevHash: string; hash: string };
}

const keyed = (list: readonly unknown[]): list is Json[] =>
  list.every(
    (entry) => entry !== null && typeof entry === "object" && typeof (entry as Json).id === "string",
  );
// Identity first: a write's unchanged records are the committed objects themselves.
const same = (left: unknown, right: unknown) =>
  left === right || JSON.stringify(left) === JSON.stringify(right);

/**
 * What one commit changed. Committed records are frozen, so a changed record is a new object
 * and only those are compared. An append records its tail; an id-keyed collection records
 * upserts and removals when replaying them reproduces its exact order, and is replaced whole
 * otherwise. `changed` may name, for a collection, the first index it could differ from and the
 * length it appended from (LOCAL-VUH-47); comparison then starts there instead of at the front.
 */
export function storeChanges(
  from: object,
  to: object,
  skip: ReadonlySet<string>,
  changed?: (
    previous: readonly unknown[],
    current: readonly unknown[],
  ) => { readonly replaced: readonly number[]; readonly from: number } | undefined,
): StoreChanges {
  const before = from as Json;
  const after = to as Json;
  const changes: StoreChanges = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (skip.has(key)) continue;
    const previous = before[key];
    const current = after[key];
    if (previous === current) continue;
    if (current === undefined) {
      if (previous !== undefined) (changes.unset ??= []).push(key);
      continue;
    }
    if (!Array.isArray(previous) || !Array.isArray(current)) {
      if (!same(previous, current)) (changes.set ??= {})[key] = current;
      continue;
    }
    const known = changed?.(previous, current);
    let start = known === undefined ? 0 : Math.min(known.replaced[0] ?? known.from, known.from);
    while (start < previous.length && start < current.length && previous[start] === current[start]) start++;
    while (start < previous.length && start < current.length && same(previous[start], current[start]))
      start++;
    if (start === previous.length && start === current.length) continue;
    if (start === previous.length) {
      (changes.append ??= {})[key] = current.slice(start);
      continue;
    }
    const tail =
      keyed(previous) && keyed(current) ? keyedTail(previous.slice(start), current.slice(start)) : undefined;
    if (tail === undefined) {
      (changes.replace ??= {})[key] = current;
      continue;
    }
    if (tail.upsert.length) (changes.upsert ??= {})[key] = tail.upsert;
    if (tail.remove.length) (changes.remove ??= {})[key] = tail.remove;
  }
  return changes;
}

function keyedTail(previous: Json[], current: Json[]): { upsert: Json[]; remove: string[] } | undefined {
  const prior = new Map(previous.map((entry) => [entry.id as string, entry]));
  const now = new Set(current.map((entry) => entry.id as string));
  if (prior.size !== previous.length || now.size !== current.length) return undefined;
  // Replay keeps survivors in place and appends new ids; it must give exactly this order.
  const replayed = [
    ...previous.filter((entry) => now.has(entry.id as string)),
    ...current.filter((entry) => !prior.has(entry.id as string)),
  ];
  if (replayed.some((entry, index) => entry.id !== current[index]!.id)) return undefined;
  return {
    upsert: current.filter((entry) => !same(prior.get(entry.id as string), entry)),
    remove: [...prior.keys()].filter((id) => !now.has(id)),
  };
}

/**
 * Replays records onto a copy of a committed store. Collections are copied once, the first
 * time a record touches them, and then changed in place, so a long tail costs its records.
 */
export function replayJournal<T extends object>(base: T, records: readonly JournalRecord[]): T {
  const store = { ...base } as Json;
  const owned = new Set<string>();
  const indexes = new Map<string, Map<string, number>>();
  const list = (key: string) => {
    if (!owned.has(key)) {
      store[key] = [...((store[key] as unknown[] | undefined) ?? [])];
      owned.add(key);
    }
    return store[key] as Json[];
  };
  const index = (key: string) => {
    let byId = indexes.get(key);
    if (byId === undefined) {
      byId = new Map(list(key).map((entry, at) => [entry.id as string, at]));
      indexes.set(key, byId);
    }
    return byId;
  };
  for (const record of records) {
    for (const [key, value] of Object.entries(record.set ?? {})) {
      store[key] = value;
      owned.delete(key);
      indexes.delete(key);
    }
    for (const key of record.unset ?? []) delete store[key];
    for (const [key, entries] of Object.entries(record.replace ?? {})) {
      store[key] = entries;
      owned.add(key);
      indexes.delete(key);
    }
    for (const [key, entries] of Object.entries(record.append ?? {})) {
      const target = list(key);
      for (const entry of entries) {
        indexes.get(key)?.set((entry as Json).id as string, target.length);
        target.push(entry as Json);
      }
    }
    for (const [key, ids] of Object.entries(record.remove ?? {})) {
      const removed = new Set(ids);
      store[key] = list(key).filter((entry) => !removed.has(entry.id as string));
      indexes.delete(key);
    }
    for (const [key, entries] of Object.entries(record.upsert ?? {})) {
      const target = list(key);
      const byId = index(key);
      for (const entry of entries) {
        const at = byId.get(entry.id as string);
        if (at === undefined) {
          byId.set(entry.id as string, target.length);
          target.push(entry);
        } else target[at] = entry;
      }
    }
    list("syncLog").push(record.commit);
    store.syncId = record.syncId;
  }
  return store as T;
}

export const segmentName = (firstSyncId: number) => `${String(firstSyncId).padStart(12, "0")}.jsonl`;
const SEGMENT = /^(\d{12})\.jsonl$/u;
const firstSyncIdOf = (name: string) => Number(SEGMENT.exec(name)![1]);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function segmentsSync(directory: string): string[] {
  try {
    return readdirSync(join(directory, JOURNAL_DIRECTORY))
      .filter((name) => SEGMENT.test(name))
      .sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/**
 * The journal's current state, without reading it: the segment names and the newest segment's
 * identity, size and timestamps. Every append and every new segment changes it.
 */
export function journalVersion(directory: string): string {
  const names = segmentsSync(directory);
  const last = names.at(-1);
  if (last === undefined) return "";
  const file = statSync(join(directory, JOURNAL_DIRECTORY, last), { bigint: true });
  return `${String(names.length)}:${last}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
}

/**
 * One journal line: the record as JSON, framed by the byte length of everything after its
 * `length` field (LOCAL-VUH-47). A reader then knows where a record must end, so bytes a power
 * cut left unwritten inside an unacknowledged final line are told apart from a whole record,
 * even if they happen to hold a newline.
 */
export function journalLine(record: JournalRecord): string {
  const { syncId, ...rest } = record;
  const body = JSON.stringify(rest).slice(1);
  return `{"syncId":${String(syncId)},"length":${String(Buffer.byteLength(body))},${body}\n`;
}
const parses = (line: string) => {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
};
const FRAMED = /^\{"syncId":\d+,"length":(\d+),/u;
// Lines written before framing end at their newline.
const UNFRAMED = /^\{"syncId":\d+,/u;
/**
 * Where the record starting at `at` ends (its newline), or -1 when it is not a whole record there.
 * A build from before framing, after a rollback, appends unframed lines after framed ones; with no
 * length to check, such a line counts only if it parses (LOCAL-VUH-47 review).
 */
function recordEnd(bytes: Buffer, at: number, afterFramed: boolean): number {
  const head = bytes.toString("latin1", at, Math.min(bytes.length, at + 48));
  const framed = FRAMED.exec(head);
  if (framed !== null) {
    const end = at + framed[0].length + Number(framed[1]);
    return end < bytes.length && bytes[end] === 0x0a ? end : -1;
  }
  if (!UNFRAMED.test(head)) return -1;
  const end = bytes.indexOf(0x0a, at);
  return end < 0 || (afterFramed && !parses(bytes.toString("utf8", at, end))) ? -1 : end;
}
/**
 * The whole records of a segment and the byte length they cover. What follows them is a torn
 * tail: an interrupted append, or a final line whose bytes are not a record (a power cut that
 * persisted the line's length but not all its pages). `later` says a whole record follows that
 * damage, so it is not a tail at all and the open refuses. A final line that parses is a record:
 * if it breaks the chain, the open refuses it rather than skip it.
 */
function segmentLines(bytes: Buffer): { lines: string[]; complete: number; later: boolean } {
  const lines: string[] = [];
  let at = 0;
  let framed = false;
  while (at < bytes.length) {
    const end = recordEnd(bytes, at, framed);
    if (end < 0) break;
    framed ||= FRAMED.test(bytes.toString("latin1", at, Math.min(end, at + 48)));
    lines.push(bytes.toString("utf8", at, end));
    at = end + 1;
  }
  if (at === bytes.length && lines.length && !parses(lines.at(-1)!))
    at -= Buffer.byteLength(lines.pop()!) + 1;
  let later = false;
  for (let next = bytes.indexOf(0x0a, at); !later && next >= 0 && next + 1 < bytes.length;) {
    const end = recordEnd(bytes, next + 1, false);
    later = end >= 0 && parses(bytes.toString("utf8", next + 1, end));
    next = bytes.indexOf(0x0a, next + 1);
  }
  return { lines, complete: at, later };
}

export interface JournalTail {
  readonly records: JournalRecord[];
  /** The segment the next commit appends to, and its size without any torn tail. */
  readonly live: { readonly name: string; readonly size: number } | undefined;
  /** Bytes in the segments after the checkpoint. */
  readonly bytes: number;
}

/**
 * Everything after the checkpoint, proven. Each sealed segment must match its recorded digest
 * (it is the only check of the history an open no longer parses) unless `verified` already
 * holds it from an earlier open in this process; `false` skips it for host reads. The records
 * after the checkpoint must chain from its sync hash with consecutive sync ids. A torn final
 * line, an interrupted append, is left out; the next append truncates it. Anything else broken
 * refuses the open.
 */
export async function readJournalTail(
  directory: string,
  header: JournalHeader,
  options: { verified: Set<string> | false; after?: { syncId: number; hash: string } },
): Promise<JournalTail> {
  const root = join(directory, JOURNAL_DIRECTORY);
  const names = (
    await readdir(root).catch((error: unknown) => {
      if (missing(error)) return [] as string[];
      throw error;
    })
  )
    .filter((name) => SEGMENT.test(name))
    .sort();
  for (const [index, segment] of header.sealed.entries()) {
    if (names[index] !== segment.name) throw new Error(`Tracker journal segment ${segment.name} is missing`);
    const key = `${join(root, segment.name)}:${segment.sha256}`;
    if (options.verified === false || options.verified.has(key)) continue;
    const bytes = await readFile(join(root, segment.name));
    if (bytes.length !== segment.bytes || createHash("sha256").update(bytes).digest("hex") !== segment.sha256)
      throw new Error(`Tracker journal segment ${segment.name} is not intact`);
    options.verified.add(key);
  }
  const records: JournalRecord[] = [];
  let previous = { syncId: header.syncId, hash: header.syncHash };
  const after = options.after?.syncId ?? header.syncId;
  const live = names.slice(header.sealed.length);
  let total = 0;
  let last: JournalTail["live"];
  for (const [index, name] of live.entries()) {
    if (firstSyncIdOf(name) !== previous.syncId + 1)
      throw new Error(`Tracker journal segment ${name} does not follow sync ${String(previous.syncId)}`);
    const bytes = await readFile(join(root, name));
    const { lines, complete, later } = segmentLines(bytes);
    if (complete !== bytes.length && (later || index !== live.length - 1))
      throw new Error(`Tracker journal segment ${name} is torn before its end`);
    for (const line of lines) {
      let record: JournalRecord;
      try {
        record = JSON.parse(line) as JournalRecord;
      } catch {
        throw new Error(`Tracker journal is not intact at sync ${String(previous.syncId + 1)}`);
      }
      if (
        record.syncId !== previous.syncId + 1 ||
        record.commit?.syncId !== record.syncId ||
        record.commit.prevHash !== previous.hash
      )
        throw new Error(`Tracker journal is not intact at sync ${String(previous.syncId + 1)}`);
      if (record.syncId === after && options.after !== undefined && record.commit.hash !== options.after.hash)
        throw new Error(`Tracker journal changed under this backend at sync ${String(after)}`);
      if (record.syncId > after) records.push(record);
      previous = { syncId: record.syncId, hash: record.commit.hash };
    }
    total += complete;
    last = { name, size: complete };
  }
  if (options.after !== undefined && previous.syncId < options.after.syncId)
    throw new Error(`Tracker journal no longer holds sync ${String(options.after.syncId)}`);
  return { records, live: last, bytes: total };
}

/**
 * Bytes past the size an append expects are cut only when they are a torn tail, which is one
 * interrupted append. Past this they are refused unread rather than proven torn.
 */
export const TORN_TAIL_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Whether bytes that start at a record boundary hold a whole record anywhere, framed or not
 * (LOCAL-VUH-54). An acknowledged record always parses; a torn tail, or damage before a later
 * record, never does.
 */
function holdsRecord(tail: Buffer): boolean {
  for (let at = 0; at < tail.length;) {
    const end = recordEnd(tail, at, true);
    if (end >= 0 && parses(tail.toString("utf8", at, end))) return true;
    const next = tail.indexOf(0x0a, at);
    if (next < 0) return false;
    at = next + 1;
  }
  return false;
}

/**
 * One durable commit: a complete line appended to the newest segment, then one fsync. The
 * segment is cut back to the size this backend last saw first, so a torn line left by an
 * interrupted append is never extended. Bytes there that hold a whole record are another
 * writer's acknowledged commit, read from a stale base: the append refuses and cuts nothing.
 */
export async function appendJournal(
  directory: string,
  live: { readonly name: string; readonly size: number },
  line: string,
  beforeAppend: () => void,
): Promise<number> {
  const handle = await open(join(directory, JOURNAL_DIRECTORY, live.name), "r+", 0o600);
  try {
    // Only reads before dispatch, so these refusals provably wrote nothing.
    const { size } = await handle.stat();
    if (size < live.size) throw new Error("Tracker journal segment shrank under this backend");
    if (size > live.size) {
      if (size - live.size > TORN_TAIL_LIMIT_BYTES)
        throw new Error(
          `Tracker journal segment ${live.name} has ${String(size - live.size)} bytes this backend has not read; refusing to cut them`,
        );
      const tail = Buffer.alloc(size - live.size);
      await readAll(handle, tail, live.size);
      if (holdsRecord(tail))
        throw new Error(
          `Tracker journal segment ${live.name} holds a record this backend has not read; refusing to cut it`,
        );
    }
    // Before touching the segment: a holder whose lock went stale must not cut another
    // process's acknowledged record.
    beforeAppend();
    if ((await handle.stat()).size !== size)
      throw new Error("Tracker journal segment changed under this backend");
    if (size > live.size) await handle.truncate(live.size);
    const bytes = Buffer.from(line);
    try {
      await writeAll(handle, bytes, live.size);
      await handle.sync();
    } catch (error) {
      // allow-swallowed-rejection -- the write's own error is thrown; a torn tail left anyway is cut by the next append and skipped at open
      await handle.truncate(live.size).catch(() => {});
      throw error;
    }
    return live.size + bytes.length;
  } finally {
    await handle.close();
  }
}

/**
 * A new, empty segment: every later append, from any process, lands after this point. It never
 * reuses a file, so a segment a checkpoint sealed can never become the live one.
 */
export async function startSegment(directory: string, firstSyncId: number): Promise<string> {
  const root = join(directory, JOURNAL_DIRECTORY);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const name = segmentName(firstSyncId);
  const handle = await open(join(root, name), "wx", 0o600);
  await handle.sync().finally(() => handle.close());
  await syncDirectory(root);
  return name;
}

/** A finished segment's digest, recorded by the checkpoint that covers it. */
export async function sealSegment(directory: string, name: string): Promise<SealedSegment> {
  const bytes = await readFile(join(directory, JOURNAL_DIRECTORY, name));
  if (segmentLines(bytes).complete !== bytes.length)
    throw new Error(`Cannot seal torn tracker journal segment ${name}`);
  return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Writes a whole segment at once (migration's sync history), durably. */
export async function writeSegment(
  directory: string,
  firstSyncId: number,
  lines: Iterable<string>,
): Promise<SealedSegment> {
  const root = join(directory, JOURNAL_DIRECTORY);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const name = segmentName(firstSyncId);
  const handle = await open(join(root, name), "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (const line of lines) {
      const chunk = Buffer.from(line);
      hash.update(chunk);
      bytes += chunk.length;
      await writeAll(handle, chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(root);
  return { name, bytes, sha256: hash.digest("hex") };
}

/** Makes a rename or a new file in `path` durable; the rename alone can be lost to a power cut. */
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  await handle.sync().finally(() => handle.close());
}

/** Writes every byte: a short write would acknowledge a torn record or rename in a cut checkpoint. */
async function writeAll(handle: FileHandle, bytes: Buffer, position?: number): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      written,
      bytes.length - written,
      position === undefined ? null : position + written,
    );
    if (bytesWritten === 0) throw new Error("Tracker journal write made no progress");
    written += bytesWritten;
  }
}

/** Fills `bytes` from `position`: a short read would judge a tail by part of it. */
async function readAll(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let read = 0;
  while (read < bytes.length) {
    const { bytesRead } = await handle.read(bytes, read, bytes.length - read, position + read);
    if (bytesRead === 0) throw new Error("Tracker journal segment shrank under this backend");
    read += bytesRead;
  }
}

/** Moves a journal that no current checkpoint names out of the way; history is never deleted. */
export async function setJournalAside(directory: string, reason: string): Promise<void> {
  try {
    await rename(
      join(directory, JOURNAL_DIRECTORY),
      join(directory, `${JOURNAL_DIRECTORY}.${reason}-${String(Date.now())}`),
    );
    await syncDirectory(directory);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

/** The journal record for one sync id, from whichever segment holds it. */
export async function readJournalRecord(
  directory: string,
  syncId: number,
): Promise<JournalRecord | undefined> {
  const name = segmentsSync(directory)
    .filter((entry) => firstSyncIdOf(entry) <= syncId)
    .at(-1);
  if (name === undefined) return undefined;
  const { lines } = segmentLines(await readFile(join(directory, JOURNAL_DIRECTORY, name)));
  const prefix = `{"syncId":${String(syncId)},`;
  const line = lines.find((entry) => entry.startsWith(prefix));
  return line === undefined ? undefined : (JSON.parse(line) as JournalRecord);
}

/** Every journal record, oldest first: the whole sync history, for a full export. */
export async function* journalRecords(directory: string): AsyncGenerator<JournalRecord> {
  for (const name of segmentsSync(directory)) {
    const { lines } = segmentLines(await readFile(join(directory, JOURNAL_DIRECTORY, name)));
    for (const line of lines) yield JSON.parse(line) as JournalRecord;
  }
}

/** Sync commits after a cursor, oldest first, from the retained segments. */
export async function readJournalCommits(
  directory: string,
  after: number,
  limit: number,
): Promise<{ commits: JournalRecord["commit"][]; hasMore: boolean }> {
  const names = segmentsSync(directory);
  const start = Math.max(
    0,
    names.findLastIndex((name) => firstSyncIdOf(name) <= after + 1),
  );
  const commits: JournalRecord["commit"][] = [];
  for (const name of names.slice(start)) {
    const { lines } = segmentLines(await readFile(join(directory, JOURNAL_DIRECTORY, name)));
    for (const line of lines) {
      const syncId = Number(/^\{"syncId":(\d+),/u.exec(line)?.[1]);
      if (!(syncId > after)) continue;
      if (commits.length === limit) return { commits, hasMore: true };
      commits.push((JSON.parse(line) as JournalRecord).commit);
    }
  }
  return { commits, hasMore: false };
}

/**
 * Writes a checkpoint without one string for the whole store: a key, or one record of a
 * collection, at a time, yielding between chunks so commits keep flowing. The store is a frozen
 * snapshot and cannot change underneath. The temp file is fsynced; the caller renames it in
 * under the store lock. Returns its size and SHA-256.
 */
export async function writeCheckpointFile(
  store: Json,
  temp: string,
): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(temp, "wx", 0o600);
  const hash: Hash = createHash("sha256");
  let bytes = 0;
  let chunk = "{";
  const flush = async () => {
    const buffer = Buffer.from(chunk);
    chunk = "";
    hash.update(buffer);
    bytes += buffer.length;
    await writeAll(handle, buffer);
  };
  const write = async (text: string) => {
    chunk += text;
    if (chunk.length < 1 << 20) return;
    await flush();
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    let first = true;
    for (const [key, value] of Object.entries(store)) {
      if (value === undefined) continue;
      await write(`${first ? "" : ","}\n${JSON.stringify(key)}:`);
      first = false;
      if (!Array.isArray(value)) {
        await write(JSON.stringify(value));
        continue;
      }
      await write("[");
      for (const [index, entry] of value.entries())
        await write(`${index ? "," : ""}\n${JSON.stringify(entry)}`);
      await write("]");
    }
    chunk += "\n}\n";
    await flush();
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}
