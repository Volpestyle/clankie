import { createHash } from "node:crypto";
import { parseHerdrSeatTranscript, type HerdrTranscriptEntry } from "./index.ts";

/**
 * The two primitives a host exposes: which transcript files exist and a byte
 * range of one. Everything else (identity, parsing, paging) happens here, so a
 * remote host needs nothing installed beyond the shell that answers those calls.
 */
export interface AgentTranscriptHost {
  readonly id: string;
  list(options?: { readonly limit?: number }): Promise<readonly AgentSessionFile[]>;
  readBytes(
    path: string,
    from: number,
    maxBytes: number,
  ): Promise<{ readonly bytes: Buffer; readonly size: number }>;
}

export interface AgentSessionFile {
  readonly harness: "claude" | "codex";
  /** Host-native path; it stays inside the host layer's transcript roots. */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface AgentSessionSummary {
  /** `host:sessionId`, what `read` takes back. */
  readonly ref: string;
  readonly host: string;
  readonly harness: AgentSessionFile["harness"];
  readonly sessionId: string;
  /** Claude's project directory name, which encodes the launch directory. */
  readonly project?: string;
  readonly size: number;
  /** Last write. A recent one means recently active, never that a process is running. */
  readonly modifiedAt: string;
}

/** Entries as they cross the API: a viewed image keeps its identity, not its host path. */
export type AgentSessionEntry =
  | Exclude<HerdrTranscriptEntry, { type: "viewed_image" }>
  | {
      readonly type: "viewed_image";
      readonly id: string;
      readonly occurredAt?: string | undefined;
    };

export interface AgentSessionPage {
  /** No `modifiedAt`: a read learns the current size, not the file's mtime. */
  readonly session: Omit<AgentSessionSummary, "modifiedAt">;
  readonly entries: readonly AgentSessionEntry[];
  /** Pass back as `after` for what was appended since. */
  readonly cursor: string;
  /** The file shrank or was replaced under an old cursor, so this page restarted from the tail. */
  readonly reset?: true;
  /** A tail stopped at the read ceiling before reaching the start of the file. */
  readonly truncated?: true;
  /**
   * One record after the cursor is longer than a single read, so the page moved
   * past this many bytes of it rather than waiting on a line that cannot fit.
   */
  readonly skippedBytes?: number;
}

/** The caller asked for something wrong, as opposed to the host failing to answer. */
export class AgentSessionRequestError extends Error {
  public readonly status: 400 | 404;

  public constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.status = status;
  }
}

export const AGENT_SESSION_TAIL_DEFAULT = 50;
export const AGENT_SESSION_TAIL_MAX = 500;
// Hosts refuse a single read over 4 MiB; base64 over SSH makes that ~5.6 MB of output.
const READ_MAX_BYTES = 4 * 1024 * 1024;
const WINDOW_BYTES = 256 * 1024;
// Room for what was appended between listing a file and reading its tail.
const SLACK_BYTES = 256 * 1024;
const MAX_WINDOW_BYTES = READ_MAX_BYTES - SLACK_BYTES;
// A page after a cursor re-reads this much before it, so tool results resolve
// calls made earlier and Claude's parent chain has a root to walk back to.
const OVERLAP_BYTES = 256 * 1024;
const AFTER_MAX_BYTES = READ_MAX_BYTES - OVERLAP_BYTES;
const MAX_REAIMS = 3;

export function sessionIdFromPath(file: AgentSessionFile): string {
  const name = file.path
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.jsonl$/, "");
  // Codex names rollouts `rollout-<timestamp>-<uuid>`; Claude names the file the session id.
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(name);
  return uuid?.[0] ?? name;
}

function summarize(host: AgentTranscriptHost, file: AgentSessionFile): AgentSessionSummary {
  const sessionId = sessionIdFromPath(file);
  const project = file.harness === "claude" ? file.path.split(/[\\/]/).at(-2) : undefined;
  return {
    ref: `${host.id}:${sessionId}`,
    host: host.id,
    harness: file.harness,
    sessionId,
    ...(project === undefined ? {} : { project }),
    size: file.size,
    modifiedAt: new Date(file.mtimeMs).toISOString(),
  };
}

function pageSession(host: AgentTranscriptHost, file: AgentSessionFile, size: number) {
  const { modifiedAt: _listed, ...session } = summarize(host, { ...file, size });
  return session;
}

export async function listAgentSessions(
  host: AgentTranscriptHost,
  limit = 20,
): Promise<AgentSessionSummary[]> {
  const files = await host.list({ limit });
  return [...files]
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((file) => summarize(host, file));
}

/** Split `host:session`; a bare session id means the local host. */
export function parseAgentSessionRef(ref: string): {
  host: string;
  session: string;
} {
  const separator = ref.indexOf(":");
  return separator < 0
    ? { host: "local", session: ref }
    : { host: ref.slice(0, separator), session: ref.slice(separator + 1) };
}

/** A session id or any unique prefix of one, among the host's recent files. */
export async function findAgentSession(
  host: AgentTranscriptHost,
  session: string,
  limit = 200,
): Promise<AgentSessionFile> {
  const matches = (await host.list({ limit })).filter((file) => sessionIdFromPath(file).startsWith(session));
  if (matches.length === 1) return matches[0]!;
  throw matches.length === 0
    ? new AgentSessionRequestError(`No recent agent session ${session} on ${host.id}`, 404)
    : new AgentSessionRequestError(`Session ${session} is ambiguous on ${host.id}; give more of the id`);
}

export async function readAgentSession(
  host: AgentTranscriptHost,
  file: AgentSessionFile,
  options: { readonly tail?: number; readonly after?: string } = {},
): Promise<AgentSessionPage> {
  const session = `${host.id}:${sessionIdFromPath(file)}`;
  if (
    options.tail !== undefined &&
    (!Number.isSafeInteger(options.tail) || options.tail < 1 || options.tail > AGENT_SESSION_TAIL_MAX)
  )
    throw new AgentSessionRequestError(`tail must be an integer from 1 to ${AGENT_SESSION_TAIL_MAX}`);
  const cursor = options.after === undefined ? undefined : decodeCursor(options.after);
  if (cursor !== undefined && cursor.s !== session)
    throw new AgentSessionRequestError("Transcript cursor belongs to another session");
  if (cursor !== undefined) {
    const page = await readAfter(host, file, cursor);
    if (page !== undefined) return page;
  }
  const page = await readTail(host, file, options.tail ?? AGENT_SESSION_TAIL_DEFAULT);
  return cursor === undefined ? page : { ...page, reset: true };
}

/**
 * The session, the byte offset, and a hash of the bytes just before it. An
 * offset alone cannot tell an append from a replacement that happens to be as
 * long, so a page after it first checks those bytes are still there.
 */
interface Cursor {
  readonly s: string;
  readonly o: number;
  readonly n: number;
  readonly h: string;
}

const FINGERPRINT_BYTES = 4096;

function fingerprint(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64url").slice(0, 22);
}

function encodeCursor(session: string, offset: number, before: Buffer): string {
  const tail = before.subarray(Math.max(0, before.length - FINGERPRINT_BYTES));
  const cursor: Cursor = {
    s: session,
    o: offset,
    n: tail.length,
    h: fingerprint(tail),
  };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      typeof cursor.s === "string" &&
      typeof cursor.h === "string" &&
      Number.isSafeInteger(cursor.o) &&
      Number.isSafeInteger(cursor.n) &&
      cursor.o! >= cursor.n! &&
      cursor.n! >= 0 &&
      cursor.n! <= FINGERPRINT_BYTES
    )
      return cursor as Cursor;
  } catch {
    // fall through
  }
  throw new AgentSessionRequestError("Invalid transcript cursor");
}

async function readTail(
  host: AgentTranscriptHost,
  file: AgentSessionFile,
  tail: number,
): Promise<AgentSessionPage> {
  const session = `${host.id}:${sessionIdFromPath(file)}`;
  let window = WINDOW_BYTES;
  // Every read reports the current size, so each widening costs one call, not two.
  let knownSize = file.size;
  let reaims = 0;
  for (;;) {
    const from = Math.max(0, knownSize - window);
    const { bytes, size } = await host.readBytes(file.path, from, window + SLACK_BYTES);
    // More was appended since the size we aimed from than the slack covers: aim
    // again, a few times at most, so a transcript growing that fast can't hold
    // the request open; the cursor then picks up the rest.
    if (from + bytes.length < size && knownSize !== size && reaims < MAX_REAIMS) {
      knownSize = size;
      reaims += 1;
      continue;
    }
    knownSize = size;
    // Past the start of the file, the first line is almost always cut mid-record.
    const start = from === 0 ? 0 : bytes.indexOf(0x0a) + 1;
    const end = bytes.lastIndexOf(0x0a) + 1;
    const entries = (from === 0 || start > 0) && end > start ? parse(file, bytes.subarray(start, end)) : [];
    const exhausted = from === 0 || window >= MAX_WINDOW_BYTES;
    if (entries.length >= tail || exhausted) {
      return {
        session: pageSession(host, file, size),
        entries: entries.slice(-tail),
        cursor: encodeCursor(session, from + end, bytes.subarray(0, end)),
        ...(from > 0 && entries.length < tail ? { truncated: true as const } : {}),
      };
    }
    window = Math.min(window * 4, MAX_WINDOW_BYTES);
  }
}

async function readAfter(
  host: AgentTranscriptHost,
  file: AgentSessionFile,
  cursor: Cursor,
): Promise<AgentSessionPage | undefined> {
  const offset = cursor.o;
  const from = Math.max(0, offset - OVERLAP_BYTES);
  const { bytes, size } = await host.readBytes(file.path, from, offset - from + AFTER_MAX_BYTES);
  if (offset > size || offset - from > bytes.length) return undefined;
  if (fingerprint(bytes.subarray(offset - from - cursor.n, offset - from)) !== cursor.h) return undefined;
  const context = bytes.subarray(from === 0 ? 0 : bytes.indexOf(0x0a) + 1, offset - from);
  const end = bytes.lastIndexOf(0x0a) + 1;
  // A full read past the cursor with no line end in it is one record too long to
  // ever fit. Step over what was read; the rest of that line fails to parse and
  // drops, and the records after it page normally.
  if (end <= offset - from && bytes.length - (offset - from) >= AFTER_MAX_BYTES) {
    const skipped = bytes.length - (offset - from);
    return {
      session: pageSession(host, file, size),
      entries: [],
      cursor: encodeCursor(`${host.id}:${sessionIdFromPath(file)}`, offset + skipped, bytes),
      skippedBytes: skipped,
    };
  }
  const fresh = end > offset - from ? bytes.subarray(offset - from, end) : Buffer.alloc(0);
  // Compare whole entries, not ids: a record can resolve after the cursor, such
  // as a tool whose result lands later, and that change is news.
  const seen = new Set(parse(file, context).map((entry) => JSON.stringify(entry)));
  const entries = parse(file, Buffer.concat([context, fresh])).filter(
    (entry) => !seen.has(JSON.stringify(entry)),
  );
  return {
    session: pageSession(host, file, size),
    entries,
    cursor: encodeCursor(
      `${host.id}:${sessionIdFromPath(file)}`,
      offset + fresh.length,
      bytes.subarray(0, offset - from + fresh.length),
    ),
  };
}

function parse(file: AgentSessionFile, bytes: Buffer): AgentSessionEntry[] {
  if (bytes.length === 0) return [];
  return parseHerdrSeatTranscript(file.harness, bytes.toString("utf8")).map((entry) =>
    entry.type === "viewed_image"
      ? {
          type: "viewed_image",
          id: entry.id,
          ...(entry.occurredAt ? { occurredAt: entry.occurredAt } : {}),
        }
      : entry,
  );
}
