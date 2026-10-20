import { codexAccounts, defaultSettingsPath, SettingsStore } from "@clankie/settings";
import { z } from "zod";
import {
  closeSync,
  globSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  type Stats,
} from "node:fs";
import { glob, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSensitiveText } from "@clankie/observability";
import {
  OPERATOR_CONVERSATION_CODE_MAX,
  OPERATOR_CONVERSATION_REF_MAX,
  OPERATOR_CONVERSATION_TEXT_MAX,
  OPERATOR_CONVERSATION_TOOL_DETAIL_MAX,
} from "@clankie/protocol";

export interface HerdrAgentSession {
  readonly source: string;
  readonly kind: "id" | "path";
  readonly value: string;
}

export interface HerdrTranscriptMessage {
  readonly type: "message";
  readonly id: string;
  readonly role: "operator" | "agent";
  /** Internal channel delivery identity; never rendered as operator chat. */
  readonly internal?: true;
  /** Native Pi custom-message correlation, never inferred from visible text. */
  readonly nativeRequestId?: string;
  readonly text: string;
  readonly occurredAt?: string | undefined;
  /** The harness refused this turn on a usage limit and wrote this in place of a reply. */
  readonly usageLimit?: HerdrUsageLimit | undefined;
}

/** A native session or weekly usage-limit refusal (VUH-2273); resetsAt when the harness said. */
export interface HerdrUsageLimit {
  readonly window: "session" | "weekly" | "other";
  readonly resetsAt?: string | undefined;
}

interface HerdrTranscriptTool {
  readonly type: "tool";
  /** Stable native entry identity used by the transcript checkpoint. */
  readonly id: string;
  /** Stable invocation identity shared by the start and result entries. */
  readonly toolCallId: string;
  readonly name: string;
  readonly phase: "started" | "completed" | "failed";
  /** Redacted, bounded serialized arguments or result. */
  readonly detail?: string | undefined;
  readonly occurredAt?: string | undefined;
}

interface HerdrTranscriptViewedImage {
  readonly type: "viewed_image";
  readonly id: string;
  /** Host path only; it never crosses the conversation protocol. */
  readonly path: string;
  readonly occurredAt?: string | undefined;
}

export type HerdrTranscriptEntry = HerdrTranscriptMessage | HerdrTranscriptTool | HerdrTranscriptViewedImage;

export interface HerdrSeatTranscript {
  readonly sessionKey: string;
  readonly entries: readonly HerdrTranscriptEntry[];
}

// ponytail: the app replays at most 10k events; raise both ceilings together if real sessions exceed this.
const MAX_ENTRIES = 9_000;
// ponytail: one tail per watched seat; the fleet is panes, not thousands.
const MAX_TAILED_TRANSCRIPTS = 32;
/**
 * Dedupe keys and call names a long-lived tail remembers. Twice the retained
 * entries: a duplicate record or a tool result arriving after this many newer
 * keys is treated as new (a second row, or the generic "tool" name) rather than
 * holding every key a session ever produced. Whole-file and incremental parses
 * share the bound, so they still agree.
 */
const MAX_REMEMBERED_KEYS = 2 * MAX_ENTRIES;
/** A cold read of a long session folds in pieces rather than one whole-suffix buffer. */
const READ_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Carried across an incremental read so appended records transform exactly as
 * they would inside a whole-file parse: tool names resolve against calls seen in
 * earlier chunks, the dedupe key stays global, and the positional fallback id
 * keeps counting from where the previous chunk stopped.
 */
interface FlatTranscriptState {
  readonly toolNames: BoundedMap;
  readonly seen: BoundedSet;
  index: number;
}

/** Insertion-ordered; the oldest key leaves first. */
class BoundedSet {
  private readonly keys = new Set<string>();
  public has(key: string): boolean {
    return this.keys.has(key);
  }
  public add(key: string): void {
    this.keys.add(key);
    if (this.keys.size > MAX_REMEMBERED_KEYS) this.keys.delete(this.keys.values().next().value!);
  }
  /** Oldest first, so restoring re-adds in the same eviction order. */
  public list(): string[] {
    return [...this.keys];
  }
}

/** Insertion-ordered by last write; the oldest key leaves first. */
class BoundedMap {
  private readonly values = new Map<string, string>();
  public get(key: string): string | undefined {
    return this.values.get(key);
  }
  public set(key: string, value: string): void {
    this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size > MAX_REMEMBERED_KEYS) this.values.delete(this.values.keys().next().value!);
  }
  /** Oldest first, so restoring re-sets in the same eviction order. */
  public list(): [string, string][] {
    return [...this.values];
  }
}

interface TailedTranscript {
  /** Device and inode together: a same-size, same-mtime atomic replace is a new file. */
  readonly device: number;
  readonly inode: number;
  size: number;
  mtimeMs: number;
  /** Byte offset just past the last complete line already folded into entries. */
  parsedBytes: number;
  /** Codex and Grok hold the window; Claude holds up to CLAUDE_SLACK more before it. */
  entries: HerdrTranscriptEntry[];
  state: FlatTranscriptState;
  claude?: ClaudeTail;
}

/** A Claude fold at the checkpoint, and the last point an append is not expected to branch behind. */
interface ClaudeTail {
  fold: ClaudeFoldState;
  /** The buffer has dropped its oldest entries. */
  trimmed: boolean;
  safe?: ClaudeSafePoint;
}

interface ClaudeSafePoint {
  readonly fold: ClaudeFoldState;
  readonly offset: number;
  readonly entries: HerdrTranscriptEntry[];
  readonly trimmed: boolean;
}

/**
 * Earlier entries a Claude tail keeps behind its window: a superseded queued
 * prompt leaves the parse, so the window can reach back that far without a
 * re-read. A larger burst of supersessions rebuilds from the file.
 */
const CLAUDE_SLACK = 1_024;

/**
 * The seat tail re-reads every watched transcript once a second while a Codex or
 * Grok session grows past a hundred megabytes, so a whole-file read and parse per
 * tick costs a core for output that only ever gains a suffix. These transcripts
 * are append-only JSONL, so remembering the byte offset and folding in just the
 * new lines makes a tick cost the append rather than the history.
 */
const tails = new Map<string, TailedTranscript>();

/** Codex and Grok map each record independently; Claude, Pi and Prime re-walk a parent chain. */
function tailableAgent(agent: string): boolean {
  return agent === "codex" || agent === "grok";
}

/** Claude's append continues its chain fold (VUH-2391); Pi and Prime still re-parse on change. */
function appendableAgent(agent: string): boolean {
  return tailableAgent(agent) || agent === "claude";
}

/** What a tail answers: its window, never the slack behind it. */
function windowOf(tail: TailedTranscript): HerdrTranscriptEntry[] {
  return tail.entries.length > MAX_ENTRIES ? tail.entries.slice(-MAX_ENTRIES) : tail.entries;
}

/** Bytes a Claude tail folds past its safe point before taking a newer one. */
const CLAUDE_SAFE_STRIDE = 64 * 1024;
/** Without a safe head for this long, a safe point is taken anyway; a branch behind it re-reads. */
const CLAUDE_SAFE_MAX_STRIDE = 8 * 1024 * 1024;

/**
 * Apply an append to a fold at `base`, landing the tail at `offset`. False when
 * the fold cannot continue exactly, so the caller replays or re-reads.
 */
function applyClaude(
  tail: TailedTranscript,
  fold: ClaudeFoldState,
  records: readonly Record<string, unknown>[],
  base: { entries: HerdrTranscriptEntry[]; trimmed: boolean; safe: ClaudeSafePoint | undefined },
  offset: number,
): boolean {
  const appended = claudeAppend(fold, records);
  if (appended === "rebuild") return false;
  const superseded = new Set(appended.superseded);
  let entries = superseded.size ? base.entries.filter((entry) => !superseded.has(entry.id)) : base.entries;
  if (appended.entries.length) entries = [...entries, ...appended.entries];
  // A trimmed buffer that supersession shrank below the window no longer holds it.
  if (base.trimmed && entries.length < MAX_ENTRIES) return false;
  let trimmed = base.trimmed;
  if (entries.length > MAX_ENTRIES + CLAUDE_SLACK) {
    entries = entries.slice(-(MAX_ENTRIES + CLAUDE_SLACK / 2));
    trimmed = true;
  }
  const stride = offset - (base.safe?.offset ?? 0);
  const safe =
    (fold.headSafe && stride >= CLAUDE_SAFE_STRIDE) || stride >= CLAUDE_SAFE_MAX_STRIDE
      ? { fold: cloneClaudeFold(fold), offset, entries, trimmed }
      : base.safe;
  tail.claude = { fold, trimmed, ...(safe === undefined ? {} : { safe }) };
  tail.entries = entries;
  tail.parsedBytes = offset;
  return true;
}

/**
 * Fold the complete records after the tail's checkpoint. Claude continues its
 * chain from the last parse; when an append branches behind the head (parallel
 * tool results do), it replays from the last safe point. Only a fold that
 * cannot continue from either, or a fresh tail, parses the whole file.
 */
function foldClaudeTail(path: string, size: number, tail: TailedTranscript): boolean {
  const claude = tail.claude;
  if (claude !== undefined && tail.parsedBytes > 0) {
    const chunk = readRecordsFrom(path, tail.parsedBytes, size, false, true);
    if (chunk.consumed === 0) return false;
    const current = { entries: tail.entries, trimmed: claude.trimmed, safe: claude.safe };
    if (applyClaude(tail, claude.fold, chunk.records, current, tail.parsedBytes + chunk.consumed))
      return false;
    const safe = claude.safe;
    if (safe !== undefined) {
      const replay = readRecordsFrom(path, safe.offset, size, false, true);
      if (
        applyClaude(
          tail,
          cloneClaudeFold(safe.fold),
          replay.records,
          { ...safe, safe },
          safe.offset + replay.consumed,
        )
      )
        return false;
    }
  }
  const whole = readRecordsFrom(path, 0, size, true, true);
  // Fold up to the last safe record first, so the next branch replays from there.
  let split = whole.records.length - 1;
  while (split >= 0 && !claudeSafe(whole.records[split]!)) split--;
  if (split >= 0) {
    const prefix = claudeFold(whole.records.slice(0, split + 1), true);
    const trimmed = prefix.entries.length > MAX_ENTRIES + CLAUDE_SLACK;
    const safe = {
      fold: cloneClaudeFold(prefix.state),
      offset: whole.ends![split]!,
      entries: prefix.entries.slice(-(MAX_ENTRIES + CLAUDE_SLACK)),
      trimmed,
    };
    if (applyClaude(tail, prefix.state, whole.records.slice(split + 1), { ...safe, safe }, whole.consumed))
      return true;
  }
  const parsed = claudeFold(whole.records, true);
  tail.claude = { fold: parsed.state, trimmed: parsed.entries.length > MAX_ENTRIES + CLAUDE_SLACK };
  tail.entries = parsed.entries.slice(-(MAX_ENTRIES + CLAUDE_SLACK));
  tail.parsedBytes = whole.consumed;
  return true;
}

function freshState(): FlatTranscriptState {
  return { toolNames: new BoundedMap(), seen: new BoundedSet(), index: 0 };
}

/** Read the harness-native session tree Herdr already identifies for resume. */
export function readHerdrSeatTranscript(
  agent: string,
  session: HerdrAgentSession | undefined,
  processId?: number,
): HerdrSeatTranscript | undefined {
  const resolvedSession = session ?? (agent === "grok" ? grokSessionForProcess(processId) : undefined);
  if (resolvedSession === undefined) return undefined;
  const path = resolveHerdrSeatTranscriptPath(agent, resolvedSession);
  if (path === undefined) return undefined;
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return undefined;
  const sessionKey = `${resolvedSession.source}:${resolvedSession.kind}:${resolvedSession.value}`;
  const key = `${agent}\u0000${path}`;
  const cached = tails.get(key);
  const sameFile = cached !== undefined && cached.device === stats.dev && cached.inode === stats.ino;
  if (sameFile && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    return { sessionKey, entries: windowOf(keep(key, cached)) };
  }

  // Only strict growth on the same file is an append; a shrunk file, a new inode,
  // or a same-length rewrite in place is history we have to read again.
  const tail = sameFile && appendableAgent(agent) && stats.size > cached.size ? cached : freshTail(stats);
  advanceTail(agent, path, stats, tail);
  return { sessionKey, entries: windowOf(keep(key, tail)) };
}

function freshTail(stats: Stats): TailedTranscript {
  return {
    device: stats.dev,
    inode: stats.ino,
    size: 0,
    mtimeMs: 0,
    parsedBytes: 0,
    entries: [],
    state: freshState(),
  };
}

/** Fold what the file gained since the tail's checkpoint; true when it read the whole file again. */
function advanceTail(agent: string, path: string, stats: Stats, tail: TailedTranscript): boolean {
  let whole = tail.parsedBytes === 0;
  if (tailableAgent(agent)) {
    let span = READ_CHUNK_BYTES;
    while (tail.parsedBytes < stats.size) {
      const to = Math.min(stats.size, tail.parsedBytes + span);
      const chunk = readRecordsFrom(path, tail.parsedBytes, to);
      if (chunk.consumed === 0) {
        // The rest is one unfinished record: wait for the writer.
        if (to === stats.size) break;
        // One record longer than a chunk: widen until its newline is in view.
        span *= 2;
        continue;
      }
      span = READ_CHUNK_BYTES;
      tail.entries = [...tail.entries, ...flatEntries(agent, chunk.records, tail.state)].slice(-MAX_ENTRIES);
      tail.state.index += chunk.records.length;
      tail.parsedBytes += chunk.consumed;
    }
  } else if (agent === "claude") {
    whole = foldClaudeTail(path, stats.size, tail);
  } else {
    // ponytail: Pi re-walks a parent chain that an append can re-root, so it
    // re-parses on change; give it Claude's checkpointed fold if a long Pi
    // seat starts costing real CPU here.
    tail.entries = parseHerdrSeatTranscript(agent, readFileSync(path, "utf8"), true).slice(-MAX_ENTRIES);
    tail.parsedBytes = stats.size;
    whole = true;
  }
  tail.size = stats.size;
  tail.mtimeMs = stats.mtimeMs;
  return whole;
}

const hashes = (value: string) => {
  const bytes = Buffer.from(value, "base64");
  const set = new Set<number>();
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) set.add(bytes.readUInt32LE(offset));
  return set;
};
const hashText = (set: ReadonlySet<number>) => {
  const bytes = Buffer.alloc(set.size * 4);
  let offset = 0;
  for (const hash of set) offset = bytes.writeUInt32LE(hash, offset);
  return bytes.toString("base64");
};
const ClaudeFoldCheckpointSchema = z
  .object({
    includeChannelPrompts: z.boolean(),
    kept: z.number().int().nonnegative(),
    head: z.string().optional(),
    headSafe: z.boolean(),
    trailer: z.array(z.tuple([z.string(), z.string().nullable()])),
    ids: z.string(),
    parents: z.array(z.string()),
    prompts: z.array(z.string()),
    calls: z.array(z.string()),
    toolNames: z.array(z.tuple([z.string(), z.string()])),
    seen: z.array(z.string()),
    queued: z.array(z.tuple([z.string(), z.array(z.string())])),
    waitingParents: z.string(),
    waitingCalls: z.string(),
  })
  .strict();

/**
 * Where a seat-sync's last upload left the native transcript (VUH-2391): the
 * file, the byte offset of a fold it continues from, and the entries already
 * sent past that offset. Native ids, names and offsets only, never text.
 */
export const HerdrTranscriptCheckpointSchema = z
  .object({
    version: z.literal(1),
    agent: z.string(),
    path: z.string(),
    device: z.number(),
    inode: z.number(),
    offset: z.number().int().nonnegative(),
    sent: z.array(z.string()),
    flat: z
      .object({
        index: z.number().int().nonnegative(),
        toolNames: z.array(z.tuple([z.string(), z.string()])),
        seen: z.array(z.string()),
      })
      .strict()
      .optional(),
    claude: ClaudeFoldCheckpointSchema.optional(),
  })
  .strict();
export type HerdrTranscriptCheckpoint = z.infer<typeof HerdrTranscriptCheckpointSchema>;

function claudeFoldCheckpoint(fold: ClaudeFoldState): z.infer<typeof ClaudeFoldCheckpointSchema> {
  return {
    includeChannelPrompts: fold.includeChannelPrompts,
    kept: fold.kept,
    ...(fold.head === undefined ? {} : { head: fold.head }),
    headSafe: fold.headSafe,
    trailer: [...fold.trailer].map(([id, link]) => [id, link ?? null]),
    ids: hashText(fold.ids),
    parents: [...fold.parents],
    prompts: [...fold.prompts],
    calls: [...fold.calls],
    toolNames: [...fold.toolNames],
    seen: [...fold.seen],
    queued: [...fold.queued],
    waitingParents: hashText(fold.waitingParents),
    waitingCalls: hashText(fold.waitingCalls),
  };
}

function restoredClaudeFold(saved: z.infer<typeof ClaudeFoldCheckpointSchema>): ClaudeFoldState {
  return {
    includeChannelPrompts: saved.includeChannelPrompts,
    kept: saved.kept,
    head: saved.head,
    headSafe: saved.headSafe,
    trailer: new Map(saved.trailer.map(([id, link]) => [id, link ?? undefined])),
    ids: hashes(saved.ids),
    parents: new Set(saved.parents),
    prompts: new Set(saved.prompts),
    calls: new Set(saved.calls),
    toolNames: new Map(saved.toolNames),
    seen: new Set(saved.seen),
    queued: new Map(saved.queued),
    waitingParents: hashes(saved.waitingParents),
    waitingCalls: hashes(saved.waitingCalls),
  };
}

/**
 * The entries a native transcript gained since a seat-sync checkpoint, and the
 * checkpoint to save once they are acknowledged. Codex and Grok continue from
 * the byte offset; Claude from its last safe fold, skipping what it already
 * sent. A missing, foreign or unusable checkpoint answers the whole window
 * (`complete`), as a cold read always did.
 */
export function readHerdrSeatTranscriptSince(
  agent: string,
  session: HerdrAgentSession,
  checkpoint?: unknown,
): (HerdrSeatTranscript & { complete: boolean; checkpoint: HerdrTranscriptCheckpoint }) | undefined {
  const path = resolveHerdrSeatTranscriptPath(agent, session);
  if (path === undefined) return undefined;
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return undefined;
  const sessionKey = `${session.source}:${session.kind}:${session.value}`;
  const prior = HerdrTranscriptCheckpointSchema.safeParse(checkpoint).data;
  const usable =
    prior !== undefined &&
    appendableAgent(agent) &&
    prior.agent === agent &&
    prior.path === path &&
    prior.device === stats.dev &&
    prior.inode === stats.ino &&
    prior.offset > 0 &&
    prior.offset <= stats.size &&
    (agent === "claude" ? prior.claude !== undefined : prior.flat !== undefined);
  const tail = freshTail(stats);
  if (usable) {
    tail.parsedBytes = prior.offset;
    if (prior.claude) {
      const fold = restoredClaudeFold(prior.claude);
      tail.claude = {
        fold,
        trimmed: false,
        safe: { fold: cloneClaudeFold(fold), offset: prior.offset, entries: [], trimmed: false },
      };
    } else if (prior.flat) {
      for (const [id, name] of prior.flat.toolNames) tail.state.toolNames.set(id, name);
      for (const key of prior.flat.seen) tail.state.seen.add(key);
      tail.state.index = prior.flat.index;
    }
  }
  const restored = tail.claude?.safe;
  const complete = advanceTail(agent, path, stats, tail) || !usable;
  const sent = new Set(complete ? [] : prior!.sent);
  const entries = complete ? windowOf(tail) : tail.entries.filter((entry) => !sent.has(entry.id));
  const base = { version: 1 as const, agent, path, device: stats.dev, inode: stats.ino };
  let next: HerdrTranscriptCheckpoint;
  if (tail.claude) {
    // Continue next time from the safe point; what was produced past it counts
    // as sent. While the point stays, earlier sends count too: a parallel batch
    // can drop a call from the parse and restore it with its result.
    const safe = tail.claude.safe;
    const before = new Set(safe?.entries.map((entry) => entry.id));
    const past = tail.entries.flatMap((entry) => (before.has(entry.id) ? [] : [entry.id]));
    next = {
      ...base,
      offset: safe?.offset ?? tail.parsedBytes,
      sent:
        safe === undefined ? [] : safe === restored && !complete ? [...new Set([...sent, ...past])] : past,
      claude: claudeFoldCheckpoint(safe?.fold ?? tail.claude.fold),
    };
  } else if (tailableAgent(agent)) {
    next = {
      ...base,
      offset: tail.parsedBytes,
      sent: [],
      flat: { index: tail.state.index, toolNames: tail.state.toolNames.list(), seen: tail.state.seen.list() },
    };
  } else next = { ...base, offset: 0, sent: [] };
  return { sessionKey, entries, complete, checkpoint: next };
}

/** Most-recently-read stays resident; the fleet turns panes over. */
function keep(key: string, tail: TailedTranscript): TailedTranscript {
  tails.delete(key);
  tails.set(key, tail);
  for (const stale of [...tails.keys()].slice(0, Math.max(0, tails.size - MAX_TAILED_TRANSCRIPTS))) {
    tails.delete(stale);
  }
  return tail;
}

/**
 * Decode whole lines only. A newline byte never appears inside a multi-byte
 * UTF-8 sequence, so cutting at the last one keeps the decode boundary clean and
 * leaves a half-written record for the next tick rather than dropping it.
 */
function readRecordsFrom(
  path: string,
  from: number,
  to: number,
  /** Also answer the absolute byte offset just past each record's line. */
  withEnds = false,
  /**
   * Also take a final record its writer has not ended with a newline yet, as a
   * whole-file parse does. Only a complete object parses; a half-written one waits.
   */
  unterminated = false,
): { records: Record<string, unknown>[]; consumed: number; ends?: number[] } {
  if (to <= from) return { records: [], consumed: 0 };
  const buffer = Buffer.allocUnsafe(to - from);
  const fd = openSync(path, "r");
  let read: number;
  try {
    read = readSync(fd, buffer, 0, buffer.length, from);
  } finally {
    closeSync(fd);
  }
  if (read <= 0) return { records: [], consumed: 0 };
  // Bound the search to the bytes actually read: allocUnsafe leaves the rest of
  // the buffer holding whatever was in memory, newlines included.
  const complete = buffer.subarray(0, read).lastIndexOf(0x0a);
  let last: Record<string, unknown> | undefined;
  if (unterminated && complete + 1 < read) {
    try {
      const value: unknown = JSON.parse(buffer.toString("utf8", complete + 1, read));
      if (isRecord(value)) last = value;
    } catch {
      /* still being written: it folds once complete */
    }
  }
  const consumed = last === undefined ? complete + 1 : read;
  if (consumed === 0) return { records: [], consumed: 0 };
  if (!withEnds) {
    const records = complete < 0 ? [] : parseRecords(buffer.toString("utf8", 0, complete + 1));
    return { records: last === undefined ? records : [...records, last], consumed };
  }
  const records: Record<string, unknown>[] = [];
  const ends: number[] = [];
  for (let start = 0; start <= complete;) {
    const end = buffer.indexOf(0x0a, start);
    const line = buffer.toString("utf8", start, end);
    start = end + 1;
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) continue;
      records.push(value);
      ends.push(from + start);
    } catch {
      /* a malformed line folds like parseRecords: skipped */
    }
  }
  if (last !== undefined) {
    records.push(last);
    ends.push(from + read);
  }
  return { records, consumed, ends };
}

/** Normalize the words and expandable tool executions the harness TUI renders. */
export function parseHerdrSeatTranscript(
  agent: string,
  jsonl: string,
  includeChannelPrompts = false,
  claudeAgentId?: string,
): HerdrTranscriptEntry[] {
  const records = parseRecords(jsonl);
  if (tailableAgent(agent)) return flatEntries(agent, records, freshState());
  if (agent === "claude")
    return claudeEntries(
      claudeAgentId === undefined
        ? records
        : records
            .filter((entry) => entry.agentId === claudeAgentId && entry.isSidechain === true)
            .map((entry) => ({ ...entry, isSidechain: false })),
      includeChannelPrompts,
    );
  // Prime Agent writes Pi's v3 session tree unchanged.
  if (agent === "pi" || agent === "prime") return piEntries(records);
  return [];
}

function parseRecords(jsonl: string): Record<string, unknown>[] {
  return jsonl
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
}

/** Transform records that depend only on their own position, so a tail can append. */
function flatEntries(
  agent: string,
  records: readonly Record<string, unknown>[],
  state: FlatTranscriptState,
): HerdrTranscriptEntry[] {
  return agent === "codex" ? codexEntries(records, state) : grokEntries(records, state);
}

/** Claude config homes, most specific first: CLAUDE_CONFIG_DIR, ~/.claude, then any ~/.claude-*. */
function claudeConfigRoots(): string[] {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  const roots = [
    ...(configured ? [configured] : []),
    join(homedir(), ".claude"),
    ...globSync(join(homedir(), ".claude-*")).sort(),
  ];
  return [...new Set(roots)];
}

const MAX_RESOLVED_TRANSCRIPTS = 64;
// Root mtimes do not observe a new file in an existing, unrelated date folder.
// A miss or legacy-layout lookup therefore expires even if its probes agree.
const TRANSCRIPT_DISCOVERY_RECHECK_MS = 1_000;

interface TranscriptPathLookup {
  readonly path: string | undefined;
  readonly fileIdentity: string | undefined;
  readonly directories: ReadonlyMap<string, string | undefined>;
  readonly expiresAt: number;
}

const transcriptPaths = new Map<string, TranscriptPathLookup>();
const transcriptSearches = new Map<string, Promise<string | undefined>>();
const transcriptDirectories = new Map<string, { stamp: string; names: string[] }>();
const directorySearches = new Map<string, Promise<string[]>>();

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_RESOLVED_TRANSCRIPTS) cache.delete(cache.keys().next().value!);
  return value;
}

function fileIdentity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`;
}

function discoveryStamp(stats: Stats | undefined): string | undefined {
  return stats === undefined
    ? undefined
    : `${fileIdentity(stats)}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
}

function pathStats(path: string): Stats | undefined {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

async function pathStatsAsync(path: string): Promise<Stats | undefined> {
  return stat(path).catch(() => undefined);
}

function transcriptPathKey(agent: string, session: HerdrAgentSession): string {
  return JSON.stringify([
    agent,
    session.source,
    session.value,
    homedir(),
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
    defaultSettingsPath(),
  ]);
}

function safeSessionId(value: string): boolean {
  // IDs are literal filename components, never glob patterns or parent paths.
  return /^[a-z0-9_-]{1,128}$/iu.test(value);
}

function datedCodexDirectory(root: string, id: string): string | undefined {
  const compact = id.replaceAll("-", "");
  if (!/^[a-f0-9]{12}/iu.test(compact)) return undefined;
  const date = new Date(Number.parseInt(compact.slice(0, 12), 16));
  return join(
    root,
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  );
}

/** Watch the nearest existing ancestor too, so a missing directory can appear. */
function watchDirectory(path: string, directories: Map<string, string | undefined>): Stats | undefined {
  let current = path;
  for (;;) {
    const stats = pathStats(current);
    directories.set(current, discoveryStamp(stats));
    if (stats !== undefined || dirname(current) === current) return current === path ? stats : undefined;
    current = dirname(current);
  }
}

async function watchDirectoryAsync(
  path: string,
  directories: Map<string, string | undefined>,
): Promise<Stats | undefined> {
  let current = path;
  for (;;) {
    const stats = await pathStatsAsync(current);
    directories.set(current, discoveryStamp(stats));
    if (stats !== undefined || dirname(current) === current) return current === path ? stats : undefined;
    current = dirname(current);
  }
}

function directoryNames(path: string, stats: Stats): string[] {
  const stamp = discoveryStamp(stats)!;
  const cached = transcriptDirectories.get(path);
  if (cached?.stamp === stamp) return remember(transcriptDirectories, path, cached).names;
  const names = readdirSync(path);
  return remember(transcriptDirectories, path, { stamp, names }).names;
}

async function directoryNamesAsync(path: string, stats: Stats): Promise<string[]> {
  const stamp = discoveryStamp(stats)!;
  const cached = transcriptDirectories.get(path);
  if (cached?.stamp === stamp) return remember(transcriptDirectories, path, cached).names;
  const key = JSON.stringify([path, stamp]);
  const running = directorySearches.get(key);
  if (running !== undefined) return running;
  const search = readdir(path).then((names) => remember(transcriptDirectories, path, { stamp, names }).names);
  remember(directorySearches, key, search);
  try {
    return await search;
  } finally {
    if (directorySearches.get(key) === search) directorySearches.delete(key);
  }
}

function lookupCurrent(cached: TranscriptPathLookup): boolean {
  if (cached.expiresAt <= Date.now()) return false;
  for (const [path, stamp] of cached.directories) if (discoveryStamp(pathStats(path)) !== stamp) return false;
  if (cached.path === undefined) return true;
  const stats = pathStats(cached.path);
  return stats?.isFile() === true && fileIdentity(stats) === cached.fileIdentity;
}

async function lookupCurrentAsync(cached: TranscriptPathLookup): Promise<boolean> {
  if (cached.expiresAt <= Date.now()) return false;
  const probes = await Promise.all(
    [...cached.directories].map(
      async ([path, stamp]) => discoveryStamp(await pathStatsAsync(path)) === stamp,
    ),
  );
  if (probes.some((current) => !current)) return false;
  if (cached.path === undefined) return true;
  const stats = await pathStatsAsync(cached.path);
  return stats?.isFile() === true && fileIdentity(stats) === cached.fileIdentity;
}

function uniqueTranscript(
  paths: readonly string[],
  directories: Map<string, string | undefined>,
  dated: boolean,
): TranscriptPathLookup {
  const matches = [...new Set(paths)];
  const path = matches.length === 1 ? matches[0] : undefined;
  const stats = path === undefined ? undefined : pathStats(path);
  return {
    path: stats?.isFile() ? path : undefined,
    fileIdentity: stats?.isFile() ? fileIdentity(stats) : undefined,
    directories,
    expiresAt: dated && stats?.isFile() ? Infinity : Date.now() + TRANSCRIPT_DISCOVERY_RECHECK_MS,
  };
}

async function uniqueTranscriptAsync(
  paths: readonly string[],
  directories: Map<string, string | undefined>,
  dated: boolean,
): Promise<TranscriptPathLookup> {
  const matches = [...new Set(paths)];
  const path = matches.length === 1 ? matches[0] : undefined;
  const stats = path === undefined ? undefined : await pathStatsAsync(path);
  return {
    path: stats?.isFile() ? path : undefined,
    fileIdentity: stats?.isFile() ? fileIdentity(stats) : undefined,
    directories,
    expiresAt: dated && stats?.isFile() ? Infinity : Date.now() + TRANSCRIPT_DISCOVERY_RECHECK_MS,
  };
}

function findTranscript(agent: string, id: string): TranscriptPathLookup {
  const directories = new Map<string, string | undefined>();
  const matches: string[] = [];
  if (agent === "codex") {
    const settingsPath = defaultSettingsPath();
    directories.set(settingsPath, discoveryStamp(pathStats(settingsPath)));
    const roots = [...new Set(codexAccounts().map((account) => join(account.home, "sessions")))];
    for (const root of roots) {
      watchDirectory(root, directories);
      const directory = datedCodexDirectory(root, id);
      if (directory === undefined) continue;
      const stats = watchDirectory(directory, directories);
      if (stats?.isDirectory())
        matches.push(
          ...directoryNames(directory, stats)
            .filter((name) => name.includes(id) && name.endsWith(".jsonl"))
            .map((name) => join(directory, name)),
        );
    }
    if (matches.length > 0) return uniqueTranscript(matches, directories, true);
    for (const root of roots) {
      if (!pathStats(root)?.isDirectory()) continue;
      matches.push(
        ...globSync("**/*.jsonl", { cwd: root })
          .filter((name) => name.split(/[\\/]/u).at(-1)!.includes(id))
          .map((name) => join(root, name)),
      );
    }
  } else {
    watchDirectory(homedir(), directories);
    const roots =
      agent === "claude"
        ? claudeConfigRoots().map((root) => join(root, "projects"))
        : [join(homedir(), ".grok", "sessions")];
    for (const root of roots) {
      if (!watchDirectory(root, directories)?.isDirectory()) continue;
      matches.push(
        ...globSync(agent === "claude" ? `*/${id}.jsonl` : `*/${id}/chat_history.jsonl`, { cwd: root }).map(
          (name) => join(root, name),
        ),
      );
    }
  }
  for (const path of matches) watchDirectory(dirname(path), directories);
  return uniqueTranscript(matches, directories, false);
}

async function findTranscriptAsync(agent: string, id: string): Promise<TranscriptPathLookup> {
  const directories = new Map<string, string | undefined>();
  const matches: string[] = [];
  if (agent === "codex") {
    const settingsPath = defaultSettingsPath();
    directories.set(settingsPath, discoveryStamp(await pathStatsAsync(settingsPath)));
    const accounts = codexAccounts(await new SettingsStore(settingsPath).load());
    const roots = [...new Set(accounts.map((account) => join(account.home, "sessions")))];
    for (const root of roots) {
      await watchDirectoryAsync(root, directories);
      const directory = datedCodexDirectory(root, id);
      if (directory === undefined) continue;
      const stats = await watchDirectoryAsync(directory, directories);
      if (stats?.isDirectory())
        matches.push(
          ...(await directoryNamesAsync(directory, stats))
            .filter((name) => name.includes(id) && name.endsWith(".jsonl"))
            .map((name) => join(directory, name)),
        );
    }
    if (matches.length > 0) return uniqueTranscriptAsync(matches, directories, true);
    for (const root of roots) {
      if (!(await pathStatsAsync(root))?.isDirectory()) continue;
      for await (const name of glob("**/*.jsonl", { cwd: root }))
        if (name.split(/[\\/]/u).at(-1)!.includes(id)) matches.push(join(root, name));
    }
  } else {
    await watchDirectoryAsync(homedir(), directories);
    const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
    const roots =
      agent === "claude"
        ? [
            ...new Set([
              ...(configured ? [configured] : []),
              join(homedir(), ".claude"),
              ...(await readdir(homedir()).catch(() => [] as string[]))
                .filter((name) => name.startsWith(".claude-"))
                .sort()
                .map((name) => join(homedir(), name)),
            ]),
          ].map((root) => join(root, "projects"))
        : [join(homedir(), ".grok", "sessions")];
    for (const root of roots) {
      if (!(await watchDirectoryAsync(root, directories))?.isDirectory()) continue;
      for await (const name of glob(agent === "claude" ? `*/${id}.jsonl` : `*/${id}/chat_history.jsonl`, {
        cwd: root,
      }))
        matches.push(join(root, name));
    }
  }
  for (const path of matches) await watchDirectoryAsync(dirname(path), directories);
  return uniqueTranscriptAsync(matches, directories, false);
}

/** Native lookup used by the reader and failed-delivery diagnostics. No match means no file yet. */
export function resolveHerdrSeatTranscriptPath(
  agent: string,
  session: HerdrAgentSession,
): string | undefined {
  if (session.kind === "path")
    return isAbsolute(session.value) && pathStats(session.value)?.isFile() ? session.value : undefined;
  if (!["codex", "claude", "grok"].includes(agent) || !safeSessionId(session.value)) return undefined;
  const key = transcriptPathKey(agent, session);
  const cached = transcriptPaths.get(key);
  if (cached !== undefined && lookupCurrent(cached)) return remember(transcriptPaths, key, cached).path;
  const found = findTranscript(agent, session.value);
  if (!lookupCurrent(found)) return undefined;
  return remember(transcriptPaths, key, found).path;
}

/** Fleet refreshes never block the event loop walking a native session tree. */
export async function resolveHerdrSeatTranscriptPathAsync(
  agent: string,
  session: HerdrAgentSession,
): Promise<string | undefined> {
  if (session.kind === "path")
    return isAbsolute(session.value) && (await pathStatsAsync(session.value))?.isFile()
      ? session.value
      : undefined;
  if (!["codex", "claude", "grok"].includes(agent) || !safeSessionId(session.value)) return undefined;
  const key = transcriptPathKey(agent, session);
  const running = transcriptSearches.get(key);
  if (running !== undefined) return running;
  const search = (async () => {
    const cached = transcriptPaths.get(key);
    if (cached !== undefined && (await lookupCurrentAsync(cached)))
      return remember(transcriptPaths, key, cached).path;
    const found = await findTranscriptAsync(agent, session.value);
    if (!(await lookupCurrentAsync(found))) return undefined;
    return remember(transcriptPaths, key, found).path;
  })();
  remember(transcriptSearches, key, search);
  try {
    return await search;
  } finally {
    if (transcriptSearches.get(key) === search) transcriptSearches.delete(key);
  }
}

function grokSessionForProcess(processId: number | undefined): HerdrAgentSession | undefined {
  if (processId === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(join(homedir(), ".grok/active_sessions.json"), "utf8"));
    const active = array(value)
      .filter(isRecord)
      .find((entry) => entry.pid === processId);
    const sessionId = active === undefined ? undefined : string(active.session_id);
    return sessionId === undefined ? undefined : { source: "herdr:grok", kind: "id", value: sessionId };
  } catch {
    return undefined;
  }
}

function codexEntries(
  entries: readonly Record<string, unknown>[],
  state: FlatTranscriptState,
): HerdrTranscriptEntry[] {
  const { toolNames } = state;
  return dedupeTools(
    entries.flatMap<HerdrTranscriptEntry>((entry, offset) => {
      const index = state.index + offset;
      const at = timestamp(entry);
      if (entry.type === "event_msg") {
        const payload = record(entry.payload);
        const item = payload?.type === "item_completed" ? record(payload.item) : undefined;
        if (item?.type !== "ImageView") return [];
        const path = string(item.path);
        if (path === undefined) return [];
        let localPath: string;
        try {
          localPath = fileURLToPath(path);
        } catch {
          return [];
        }
        const nativeId = string(item.id) ?? String(index);
        const key = `viewed_image\u0000${nativeId}`;
        if (state.seen.has(key)) return [];
        state.seen.add(key);
        return [{ type: "viewed_image", id: `codex:image:${nativeId}`, path: localPath, ...at }];
      }
      if (entry.type !== "response_item") return [];
      const payload = record(entry.payload);
      if (payload === undefined) return [];
      const payloadType = string(payload.type);
      const metadata = record(payload.internal_chat_message_metadata_passthrough);
      const nativeId = string(payload.id) ?? string(metadata?.turn_id) ?? String(index);
      const responseAt = timestamp(entry, metadata?.create_time);
      if (payloadType === "message") {
        const role = payload.role;
        if (role !== "user" && role !== "assistant") return [];
        const content = array(payload.content).filter(isRecord);
        let text: string;
        if (role === "user") {
          const kinds = array(record(payload.internal_chat_message_metadata_passthrough)?.content_item_kinds);
          text = content
            .flatMap((item, contentIndex) =>
              kinds[contentIndex] === "user.text" ? [string(item.text) ?? ""] : [],
            )
            .join("\n");
        } else {
          text = content
            .flatMap((item) => (item.type === "output_text" ? [string(item.text) ?? ""] : []))
            .join("\n");
        }
        return transcriptMessage(
          `codex:${nativeId}`,
          role === "user" ? "operator" : "agent",
          text,
          responseAt,
        );
      }
      const callId = cleanRef(payload.call_id, nativeId);
      if (payloadType?.endsWith("_call_output") === true) {
        const failed = payload.is_error === true || payload.status === "failed";
        return [
          transcriptTool(
            `codex:${nativeId}`,
            callId,
            toolNames.get(callId) ?? "tool",
            failed ? "failed" : "completed",
            payload.output ?? payload.result ?? payload.error,
            responseAt,
          ),
        ];
      }
      if (payloadType?.endsWith("_call") !== true) return [];
      const name = cleanName(payload.name ?? payloadType.replace(/_call$/u, ""));
      toolNames.set(callId, name);
      const paired = payloadType === "function_call" || payloadType === "custom_tool_call";
      const phase =
        paired || payload.status === undefined
          ? "started"
          : payload.status === "failed"
            ? "failed"
            : "completed";
      const detail = paired
        ? (payload.arguments ?? payload.input)
        : {
            revisedPrompt: payload.revised_prompt,
            action: payload.action,
            arguments: payload.arguments,
            input: payload.input,
            execution: payload.execution,
            result: payload.result,
          };
      return [transcriptTool(`codex:${nativeId}`, callId, name, phase, detail, responseAt)];
    }),
    state.seen,
  );
}

function claudeEntries(
  entries: readonly Record<string, unknown>[],
  includeChannelPrompts: boolean,
): HerdrTranscriptEntry[] {
  return claudeFold(entries, includeChannelPrompts).entries;
}

function claudeBriefAttachment(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const attachment = entry.type === "attachment" ? record(entry.attachment) : undefined;
  return attachment?.type === "file" &&
    typeof attachment.filename === "string" &&
    /(?:^|[\\/])clankie-brief-[0-9a-f-]{36}\.json$/u.test(attachment.filename)
    ? attachment
    : undefined;
}

const claudeIncluded = (entry: Record<string, unknown>) =>
  (entry.type === "user" ||
    entry.type === "assistant" ||
    queuedCommand(entry) !== undefined ||
    claudeBriefAttachment(entry) !== undefined) &&
  entry.isSidechain !== true;

/** Claude's walk link: a compact boundary has no parent; its logical parent continues the history. */
const claudeLink = (entry: Record<string, unknown>) =>
  string(entry.parentUuid) ?? string(entry.logicalParentUuid);

/** The tool calls an assistant record makes. */
const claudeCalls = (entry: Record<string, unknown>) =>
  entry.type === "assistant"
    ? array(record(entry.message)?.content)
        .filter(isRecord)
        .flatMap((item) => (item.type === "tool_use" && typeof item.id === "string" ? [item.id] : []))
    : [];

/** A user record carrying only tool results: kept beside the chain when its calls are on it. */
function claudeResultIds(entry: Record<string, unknown>): string[] | undefined {
  if (entry.type !== "user" || entry.isSidechain === true) return undefined;
  const content = array(record(entry.message)?.content).filter(isRecord);
  return content.length > 0 && content.every((item) => item.type === "tool_result")
    ? content.map((item) => String(item.tool_use_id))
    : undefined;
}

/** A human prompt, or a reply without tool calls: parallel results branch only after it. */
const claudeSafe = (entry: Record<string, unknown>) =>
  claudeIncluded(entry) &&
  (entry.type === "assistant"
    ? claudeCalls(entry).length === 0
    : entry.type === "user" && claudeResultIds(entry) === undefined);

function cloneClaudeFold(state: ClaudeFoldState): ClaudeFoldState {
  return {
    ...state,
    trailer: new Map(state.trailer),
    ids: new Set(state.ids),
    parents: new Set(state.parents),
    prompts: new Set(state.prompts),
    calls: new Set(state.calls),
    toolNames: new Map(state.toolNames),
    seen: new Set(state.seen),
    queued: new Map(state.queued),
    waitingParents: new Set(state.waitingParents),
    waitingCalls: new Set(state.waitingCalls),
  };
}

/** 32-bit FNV-1a: a membership set that can only err toward re-reading the file. */
function idHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * What appended Claude records need to fold exactly as a whole-file parse
 * would (VUH-2391). An append usually extends the active chain from its last
 * included record, so only the new lines are parsed and transformed. Anything
 * else (a rewind or fork, a reused uuid, a result that would admit an earlier
 * record) reports `rebuild`, and the caller parses the whole file again. Hashed
 * sets may only claim membership falsely, which also rebuilds.
 */
interface ClaudeFoldState {
  readonly includeChannelPrompts: boolean;
  /** Records the chain filter kept; the positional fallback id counts on from here. */
  kept: number;
  /** The last included record; undefined (or uuid-less) cannot be extended. */
  head: string | undefined;
  /** That head is a prompt or a reply without tool calls: no append should branch behind it. */
  headSafe: boolean;
  /** Non-included records after the head: an append may walk through them to it. */
  trailer: Map<string, string | undefined>;
  /** Hashes of every uuid in the file: reusing one rebinds the walk. */
  ids: Set<number>;
  /** Exact chain uuids, chain user uuids and chain tool calls (claudeEntries' sets). */
  parents: Set<string>;
  prompts: Set<string>;
  calls: Set<string>;
  toolNames: Map<string, string>;
  seen: Set<string>;
  /** Rendered queued prompts by the user record that would supersede them. */
  queued: Map<string, string[]>;
  /** Hashes of a parent or a call an off-chain result is still waiting for. */
  waitingParents: Set<number>;
  waitingCalls: Set<number>;
}

function claudeRecordEntries(
  entry: Record<string, unknown>,
  entryIndex: number,
  prompts: ReadonlySet<string>,
  toolNames: Map<string, string>,
  includeChannelPrompts: boolean,
): HerdrTranscriptEntry[] {
  const nativeId = string(entry.uuid) ?? String(entryIndex);
  // Claude's native @file expansion retains the full file as an attachment.
  // A startup reference alone is not a receipt: require the complete JSON body.
  if (includeChannelPrompts && entry.type === "attachment") {
    const attachment = claudeBriefAttachment(entry);
    const content = record(attachment?.content);
    const file = record(content?.file);
    if (
      attachment?.type === "file" &&
      content?.type === "text" &&
      file !== undefined &&
      file?.filePath === attachment.filename &&
      file.startLine === 1 &&
      file.numLines === 1 &&
      file.totalLines === 1 &&
      typeof file.content === "string"
    ) {
      try {
        const body: unknown = JSON.parse(file.content);
        const brief = record(body);
        if (brief && Object.keys(brief).length === 1 && typeof brief.clankieBrief === "string")
          return [
            {
              type: "message",
              id: `claude:${nativeId}`,
              role: "operator",
              internal: true,
              text: brief.clankieBrief,
              ...timestamp(entry),
            },
          ];
      } catch {
        // A partial or malformed attachment proves no brief was read.
        return [];
      }
    }
  }
  // Claude stores channel deliveries as user records with isMeta: true
  // and promptSource: "system". Keep their opt-in internal receipts before
  // dropping other metadata; they must never become visible operator chat.
  if (entry.type === "user") {
    const text = messageText(record(entry.message)?.content);
    if (CLAUDE_CHANNEL_PROMPT.test(text.trimStart()))
      return claudePrompt(`claude:${nativeId}`, text, timestamp(entry), includeChannelPrompts);
  }
  if (entry.isMeta === true || entry.promptSource === "system") return [];
  // Mid-turn input rides the active chain as an attachment, stamped when it was sent.
  const queued = queuedCommand(entry);
  if (queued !== undefined) {
    if (prompts.has(queued.source_uuid as string)) return [];
    const text = messageText(queued.prompt);
    const origin = record(queued.origin)?.kind;
    const admitted =
      origin === "channel"
        ? CLAUDE_CHANNEL_PROMPT.test(text.trimStart())
        : origin === "human" && queued.isMeta !== true;
    return admitted
      ? claudePrompt(`claude:${nativeId}`, text, timestamp(entry, queued.timestamp), includeChannelPrompts)
      : [];
  }
  const message = record(entry.message);
  if (message === undefined) return [];
  const at = timestamp(entry);
  const content = array(message.content).filter(isRecord);
  if (entry.type === "assistant") {
    const text = messageText(message.content);
    const limit = claudeUsageLimit(entry, message, text);
    const spoken = transcriptMessage(`claude:${nativeId}`, "agent", text, at).map((said) =>
      limit === undefined ? said : { ...said, usageLimit: limit },
    );
    const tools = content.flatMap((item, contentIndex) => {
      if (item.type !== "tool_use") return [];
      const callId = cleanRef(item.id, nativeId);
      const name = cleanName(item.name);
      toolNames.set(callId, name);
      return [
        transcriptTool(
          `claude:${nativeId}:tool:${String(contentIndex)}`,
          callId,
          name,
          "started",
          item.input,
          at,
        ),
      ];
    });
    return [...spoken, ...tools];
  }
  const toolResults = content.flatMap((item, contentIndex) => {
    if (item.type !== "tool_result") return [];
    const callId = cleanRef(
      item.tool_use_id ?? entry.sourceToolUseID ?? entry.sourceToolAssistantUUID,
      nativeId,
    );
    const failed = item.is_error === true || record(entry.toolUseResult)?.isError === true;
    return [
      transcriptTool(
        `claude:${nativeId}:tool-result:${String(contentIndex)}`,
        callId,
        toolNames.get(callId) ?? cleanName(record(entry.toolUseResult)?.name),
        failed ? "failed" : "completed",
        item.content ?? entry.toolUseResult,
        at,
      ),
    ];
  });
  if (toolResults.length > 0) return toolResults;
  if (
    entry.sourceToolAssistantUUID !== undefined ||
    entry.toolUseResult !== undefined ||
    entry.sourceToolUseID !== undefined
  ) {
    const callId = cleanRef(entry.sourceToolUseID ?? entry.sourceToolAssistantUUID, nativeId);
    return [
      transcriptTool(
        `claude:${nativeId}:tool-result`,
        callId,
        toolNames.get(callId) ?? cleanName(record(entry.toolUseResult)?.name),
        record(entry.toolUseResult)?.isError === true ? "failed" : "completed",
        entry.toolUseResult ?? message.content,
        at,
      ),
    ];
  }
  return claudePrompt(`claude:${nativeId}`, messageText(message.content), at, includeChannelPrompts);
}

/** Render one kept record, remembering a rendered queued prompt its own user record may supersede. */
function claudeKeep(state: ClaudeFoldState, entry: Record<string, unknown>): HerdrTranscriptEntry[] {
  const produced = claudeRecordEntries(
    entry,
    state.kept++,
    state.prompts,
    state.toolNames,
    state.includeChannelPrompts,
  );
  const source = queuedCommand(entry)?.source_uuid;
  if (produced.length > 0 && typeof source === "string")
    state.queued.set(source, [...(state.queued.get(source) ?? []), ...produced.map((item) => item.id)]);
  return produced;
}

/** Note an off-chain result an appended parent or call could still admit. */
function claudeWaiting(state: ClaudeFoldState, entry: Record<string, unknown>, ids: readonly string[]): void {
  const parent = string(entry.parentUuid);
  if (!state.parents.has(entry.parentUuid as string)) {
    if (parent !== undefined && !state.ids.has(idHash(parent))) state.waitingParents.add(idHash(parent));
    return;
  }
  for (const id of ids) if (!state.calls.has(id)) state.waitingCalls.add(idHash(id));
}

function claudeTrailer(records: readonly Record<string, unknown>[], from: number) {
  const trailer = new Map<string, string | undefined>();
  for (const entry of records.slice(from)) {
    const id = string(entry.uuid);
    if (id !== undefined) trailer.set(id, claudeLink(entry));
  }
  return trailer;
}

/** The whole-file parse, with the state an append continues from. */
function claudeFold(
  entries: readonly Record<string, unknown>[],
  includeChannelPrompts: boolean,
): { entries: HerdrTranscriptEntry[]; state: ClaudeFoldState } {
  // A compacted session keeps its earlier history, including deliveries
  // a receipt may need to find (VUH-2034).
  const chain = activeChain(entries, "uuid", "parentUuid", claudeIncluded, "logicalParentUuid");
  const active = new Set(chain);
  const head = chain.at(-1);
  const state: ClaudeFoldState = {
    includeChannelPrompts,
    kept: 0,
    head: head === undefined ? undefined : string(head.uuid),
    headSafe: head !== undefined && claudeSafe(head),
    trailer: head === undefined ? new Map() : claudeTrailer(entries, entries.lastIndexOf(head) + 1),
    ids: new Set(entries.flatMap((entry) => (typeof entry.uuid === "string" ? [idHash(entry.uuid)] : []))),
    // A queued prompt Claude also wrote as its own user record renders once.
    prompts: new Set(chain.flatMap((entry) => (entry.type === "user" ? [entry.uuid as string] : []))),
    parents: new Set(chain.map((entry) => entry.uuid as string)),
    calls: new Set(chain.flatMap(claudeCalls)),
    toolNames: new Map(),
    seen: new Set(),
    queued: new Map(),
    waitingParents: new Set(),
    waitingCalls: new Set(),
  };
  // A uuid-less chain record would let parentless results join it; never extend one.
  if (chain.some((entry) => typeof entry.uuid !== "string")) state.head = undefined;
  // Parallel Claude results can be siblings of the active branch. Keep only
  // results for its own calls, never messages or tools from an abandoned branch.
  const records = entries.filter((entry) => {
    if (active.has(entry)) return true;
    const ids = claudeResultIds(entry);
    if (ids === undefined) return false;
    if (state.parents.has(entry.parentUuid as string) && ids.every((id) => state.calls.has(id))) return true;
    claudeWaiting(state, entry, ids);
    return false;
  });
  return {
    entries: dedupeTools(
      records.flatMap((entry) => claudeKeep(state, entry)),
      state.seen,
    ),
    state,
  };
}

/**
 * Continue a fold with records appended after it. Returns the new entries and
 * the ids of earlier queued prompts their own user record now supersedes, or
 * `rebuild` when only a whole-file parse would answer exactly.
 */
function claudeAppend(
  state: ClaudeFoldState,
  appended: readonly Record<string, unknown>[],
): { entries: HerdrTranscriptEntry[]; superseded: string[] } | "rebuild" {
  if (appended.length === 0) return { entries: [], superseded: [] };
  if (state.head === undefined) return "rebuild";
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of appended) {
    const id = entry.uuid;
    if (id === undefined) continue;
    if (
      typeof id !== "string" ||
      byId.has(id) ||
      state.ids.has(idHash(id)) ||
      state.waitingParents.has(idHash(id))
    )
      return "rebuild";
    byId.set(id, entry);
  }
  const included = appended.filter(claudeIncluded);
  const head = included.at(-1);
  const trailerFrom = (entry: Record<string, unknown> | undefined) =>
    claudeTrailer(appended, entry === undefined ? 0 : appended.indexOf(entry) + 1);
  if (head === undefined) {
    // No included record: the chain stands, and nothing new is kept.
    for (const [id, link] of trailerFrom(undefined)) state.trailer.set(id, link);
    for (const id of byId.keys()) state.ids.add(idHash(id));
    return { entries: [], superseded: [] };
  }
  if (typeof head.uuid !== "string") return "rebuild";
  // Walk back from the new head; it must reach the old head through new
  // records and the old head's non-included trailer, or the chain re-rooted.
  const path: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  for (let current: Record<string, unknown> = head; ;) {
    if (claudeIncluded(current)) path.push(current);
    let link = claudeLink(current);
    while (link !== undefined && !byId.has(link) && link !== state.head) {
      if (visited.has(link) || !state.trailer.has(link)) return "rebuild";
      visited.add(link);
      link = state.trailer.get(link);
    }
    if (link === undefined) return "rebuild";
    if (link === state.head) break;
    if (visited.has(link)) return "rebuild";
    visited.add(link);
    current = byId.get(link)!;
  }
  const onPath = new Set(path);
  for (const entry of path) {
    state.parents.add(entry.uuid as string);
    if (entry.type === "user") state.prompts.add(entry.uuid as string);
    for (const call of claudeCalls(entry)) {
      if (state.waitingCalls.has(idHash(call))) return "rebuild";
      state.calls.add(call);
    }
  }
  for (const id of byId.keys()) state.ids.add(idHash(id));
  const kept = appended.filter((entry) => {
    if (onPath.has(entry)) return true;
    const ids = claudeResultIds(entry);
    if (ids === undefined) return false;
    if (state.parents.has(entry.parentUuid as string) && ids.every((id) => state.calls.has(id))) return true;
    claudeWaiting(state, entry, ids);
    return false;
  });
  const superseded = path.flatMap((entry) => {
    const ids = entry.type === "user" ? state.queued.get(entry.uuid as string) : undefined;
    if (ids !== undefined) state.queued.delete(entry.uuid as string);
    return ids ?? [];
  });
  state.head = head.uuid;
  state.headSafe = claudeSafe(head);
  state.trailer = trailerFrom(head);
  return {
    entries: dedupeTools(
      kept.flatMap((entry) => claudeKeep(state, entry)),
      state.seen,
    ),
    superseded,
  };
}

const CLAUDE_CHANNEL_PROMPT = /^<channel[ >]/u;

function queuedCommand(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const attachment = entry.type === "attachment" ? record(entry.attachment) : undefined;
  return attachment?.type === "queued_command" ? attachment : undefined;
}

function claudePrompt(
  id: string,
  text: string,
  at: { readonly occurredAt?: string },
  includeChannelPrompts: boolean,
): HerdrTranscriptMessage[] {
  if (includeChannelPrompts && CLAUDE_CHANNEL_PROMPT.test(text.trimStart()))
    return transcriptMessage(id, "operator", text, at).map((item) => ({
      ...item,
      internal: true as const,
    }));
  if (/^<(?:local-command-|command-name>|system-reminder>|channel[ >])/u.test(text.trimStart())) return [];
  return transcriptMessage(id, "operator", text, at);
}

function piEntries(entries: readonly Record<string, unknown>[]): HerdrTranscriptEntry[] {
  const header = entries.find((entry) => entry.type === "session");
  const sessionId = header?.version === 3 ? header.id : undefined;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
  const chain = activeChain(
    entries,
    "id",
    "parentId",
    (entry) => entry.type === "message" || entry.type === "custom_message",
  );
  const toolNames = new Map<string, string>();
  return dedupeTools(
    chain.flatMap<HerdrTranscriptEntry>((entry, entryIndex) => {
      // Pi's native extension messages carry semantic details outside their
      // visible content. Render the native text without exposing receipt IDs.
      if (entry.type === "custom_message") {
        if (entry.display !== true) return [];
        const details = record(entry.details);
        const nativeRequestId =
          entry.customType === "clankie-worker-message" &&
          typeof sessionId === "string" &&
          uuid.test(sessionId) &&
          details?.sessionId === sessionId &&
          typeof details.requestId === "string" &&
          uuid.test(details.requestId)
            ? details.requestId
            : undefined;
        return transcriptMessage(
          `pi:${string(entry.id) ?? String(entryIndex)}`,
          "operator",
          messageText(entry.content),
          timestamp(entry),
        ).map((message) => ({ ...message, ...(nativeRequestId === undefined ? {} : { nativeRequestId }) }));
      }
      const message = record(entry.message);
      if (message === undefined) return [];
      const nativeId = string(entry.id) ?? String(entryIndex);
      const at = timestamp(entry, message.timestamp);
      if (message.role === "toolResult") {
        const callId = cleanRef(message.toolCallId, nativeId);
        const name = toolNames.get(callId) ?? cleanName(message.toolName);
        const detail =
          message.details === undefined
            ? message.content
            : { content: message.content, details: message.details };
        return [
          transcriptTool(
            `pi:${nativeId}`,
            callId,
            name,
            message.isError === true ? "failed" : "completed",
            detail,
            at,
          ),
        ];
      }
      if (message.role !== "user" && message.role !== "assistant") return [];
      const role = message.role === "user" ? "operator" : "agent";
      const spoken = transcriptMessage(`pi:${nativeId}`, role, messageText(message.content), at);
      const tools = array(message.content).flatMap((item, contentIndex) => {
        if (!isRecord(item)) return [];
        if (item.type !== "toolCall") return [];
        const callId = cleanRef(item.id, nativeId);
        const name = cleanName(item.name);
        toolNames.set(callId, name);
        return [
          transcriptTool(
            `pi:${nativeId}:tool:${String(contentIndex)}`,
            callId,
            name,
            "started",
            item.arguments,
            at,
          ),
        ];
      });
      return [...spoken, ...tools];
    }),
  );
}

function grokEntries(
  entries: readonly Record<string, unknown>[],
  state: FlatTranscriptState,
): HerdrTranscriptEntry[] {
  const { toolNames } = state;
  return dedupeTools(
    entries.flatMap<HerdrTranscriptEntry>((entry, offset) => {
      const index = state.index + offset;
      const at = timestamp(entry);
      if (entry.type === "user") {
        if (typeof entry.prompt_index !== "number") return [];
        const text = typeof entry.content === "string" ? entry.content : messageText(entry.content);
        return transcriptMessage(`grok:${String(index)}`, "operator", text, at);
      }
      if (entry.type === "assistant") {
        const text = typeof entry.content === "string" ? entry.content : messageText(entry.content);
        const spoken = transcriptMessage(`grok:${String(index)}`, "agent", text, at);
        const calls = array(entry.tool_calls)
          .filter(isRecord)
          .map((call, callIndex) => {
            const fn = record(call.function);
            const callId = cleanRef(call.id ?? call.call_id, `${String(index)}:${String(callIndex)}`);
            const name = cleanName(call.name ?? fn?.name);
            toolNames.set(callId, name);
            return transcriptTool(
              `grok:${String(index)}:tool:${String(callIndex)}`,
              callId,
              name,
              "started",
              call.arguments ?? fn?.arguments,
              at,
            );
          });
        return [...spoken, ...calls];
      }
      if (entry.type === "tool_result") {
        const callId = cleanRef(entry.tool_call_id, String(index));
        const detail =
          entry.images === undefined ? entry.content : { content: entry.content, images: entry.images };
        return [
          transcriptTool(
            `grok:${String(index)}`,
            callId,
            toolNames.get(callId) ?? "tool",
            entry.is_error === true ? "failed" : "completed",
            detail,
            at,
          ),
        ];
      }
      if (entry.type !== "backend_tool_call") return [];
      const kind = record(entry.kind);
      if (kind === undefined) return [];
      const callId = cleanRef(kind.call_id ?? kind.id, String(index));
      if (kind.name !== undefined) {
        const name = cleanName(kind.name);
        toolNames.set(callId, name);
        return [
          transcriptTool(`grok:${String(index)}:backend-start`, callId, name, "started", kind.input, at),
        ];
      }
      const name = toolNames.get(callId) ?? cleanName(kind.tool_type);
      return [
        transcriptTool(
          `grok:${String(index)}:backend-result`,
          callId,
          name,
          kind.status === "failed" ? "failed" : "completed",
          kind.action,
          at,
        ),
      ];
    }),
    state.seen,
  );
}

function activeChain(
  entries: readonly Record<string, unknown>[],
  idKey: string,
  parentKey: string,
  include: (entry: Record<string, unknown>) => boolean,
  /** Claude's compact boundary has no parent; its logical parent continues the history. */
  logicalParentKey?: string,
): Record<string, unknown>[] {
  const candidates = entries.filter(include);
  const byId = new Map(
    entries.flatMap((entry) => {
      const id = string(entry[idKey]);
      return id === undefined ? [] : [[id, entry] as const];
    }),
  );
  const chain: Record<string, unknown>[] = [];
  const visited = new Set<Record<string, unknown>>();
  let current = candidates.at(-1);
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    if (include(current)) chain.push(current);
    const parent =
      string(current[parentKey]) ??
      (logicalParentKey === undefined ? undefined : string(current[logicalParentKey]));
    current = parent === undefined ? undefined : byId.get(parent);
  }
  return chain.reverse();
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  return array(value)
    .filter(isRecord)
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n");
}

const CLAUDE_LIMIT_TEXT =
  /\b(?:you've|you have) hit your (?:(\w+) )?(?:usage )?limit\b|\bclaude ai usage limit reached\|(\d{9,12})\b/iu;

/**
 * Claude Code writes a synthetic assistant entry when the account refuses a
 * turn on a usage limit: `apiError: "usage_limit_reached"` with the window and
 * reset time, and text such as "You've hit your weekly limit · resets …".
 * Older or unstructured entries are recognised by that wording alone.
 */
function claudeUsageLimit(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  text: string,
): HerdrUsageLimit | undefined {
  const wording = CLAUDE_LIMIT_TEXT.exec(text);
  if (entry.apiError !== "usage_limit_reached" && !(message.model === "<synthetic>" && wording))
    return undefined;
  const info = record(record(entry.apiErrorParams)?.rate_limit_info) ?? record(entry.quotaLimits);
  const type = string(info?.rateLimitType) ?? "";
  const named = wording?.[1]?.toLowerCase() ?? "";
  const window =
    /five_hour/u.test(type) || named === "session"
      ? "session"
      : /seven_day/u.test(type) || named === "weekly"
        ? "weekly"
        : "other";
  const seconds = typeof info?.resetsAt === "number" ? info.resetsAt : Number(wording?.[2]);
  return Number.isFinite(seconds) && seconds > 0
    ? { window, resetsAt: new Date(seconds * 1000).toISOString() }
    : { window };
}

function transcriptMessage(
  id: string,
  role: HerdrTranscriptMessage["role"],
  text: string,
  at: { readonly occurredAt?: string },
): HerdrTranscriptMessage[] {
  const clean = cleanText(text);
  return clean === undefined ? [] : [{ type: "message", id, role, text: clean, ...at }];
}

function transcriptTool(
  id: string,
  toolCallId: string,
  name: string,
  phase: HerdrTranscriptTool["phase"],
  detail: unknown,
  at: { readonly occurredAt?: string },
): HerdrTranscriptTool {
  const clean = cleanDetail(detail);
  return {
    type: "tool",
    id,
    toolCallId,
    name,
    phase,
    ...(clean === undefined ? {} : { detail: clean }),
    ...at,
  };
}

/** One invocation can appear in both the model item and a harness backend item. */
function dedupeTools(
  entries: readonly HerdrTranscriptEntry[],
  seen: { has(key: string): boolean; add(key: string): unknown } = new Set(),
): HerdrTranscriptEntry[] {
  return entries.filter((entry) => {
    if (entry.type !== "tool") return true;
    const key = `${entry.toolCallId}\u0000${entry.phase}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  return (name || "tool").slice(0, OPERATOR_CONVERSATION_CODE_MAX);
}

function cleanRef(value: unknown, fallback: string): string {
  const ref = typeof value === "string" ? value.trim() : "";
  return (ref || fallback).slice(0, OPERATOR_CONVERSATION_REF_MAX);
}

function cleanDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let raw: string;
  if (typeof value === "string") raw = value;
  else {
    try {
      raw = JSON.stringify(value, null, 2);
    } catch {
      raw = String(value);
    }
  }
  const detail = redactSensitiveText(raw.replace(/\r\n?/gu, "\n").trim());
  if (detail.length === 0) return undefined;
  return detail.length <= OPERATOR_CONVERSATION_TOOL_DETAIL_MAX
    ? detail
    : `${detail.slice(0, OPERATOR_CONVERSATION_TOOL_DETAIL_MAX - 1)}…`;
}

function cleanText(value: string): string | undefined {
  const text = redactSensitiveText(value.replace(/\r\n?/gu, "\n").trim());
  if (text.length === 0) return undefined;
  return text.length <= OPERATOR_CONVERSATION_TEXT_MAX
    ? text
    : `${text.slice(0, OPERATOR_CONVERSATION_TEXT_MAX - 1)}…`;
}

function timestamp(entry: Record<string, unknown>, fallback?: unknown): { readonly occurredAt?: string } {
  const value = entry.timestamp ?? fallback;
  const date =
    typeof value === "number"
      ? new Date(value < 10_000_000_000 ? value * 1_000 : value)
      : typeof value === "string"
        ? new Date(value)
        : undefined;
  return date !== undefined && Number.isFinite(date.getTime()) ? { occurredAt: date.toISOString() } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Only normalized display records cross the host boundary; never host image paths. */
export const SeatTranscriptUploadSchema = z
  .object({
    sessionId: z.union([z.uuid(), z.string().regex(/^ses_[A-Za-z0-9]{8,128}$/u)]),
    activity: z.enum(["responding", "waiting"]).optional(),
    entries: z
      .array(
        z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal("message"),
              id: z.string().min(1).max(256),
              role: z.enum(["operator", "agent"]),
              text: z.string().max(OPERATOR_CONVERSATION_TEXT_MAX).transform(redactSensitiveText),
              occurredAt: z.string().max(64).optional(),
              usageLimit: z
                .object({
                  window: z.enum(["session", "weekly", "other"]),
                  resetsAt: z.iso.datetime().optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("tool"),
              id: z.string().min(1).max(256),
              toolCallId: z.string().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
              name: z.string().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
              phase: z.enum(["started", "completed", "failed"]),
              detail: z
                .string()
                .max(OPERATOR_CONVERSATION_TOOL_DETAIL_MAX)
                .transform(redactSensitiveText)
                .optional(),
              occurredAt: z.string().max(64).optional(),
            })
            .strict(),
        ]),
      )
      .max(100),
  })
  .strict();
export type SeatTranscriptUpload = z.infer<typeof SeatTranscriptUploadSchema>;
export * from "./sessions.ts";
export * from "./subagents.ts";

export * from "./goals.ts";
