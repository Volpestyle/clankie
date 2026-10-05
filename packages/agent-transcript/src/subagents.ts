import {
  closeSync,
  constants,
  fstatSync,
  globSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, join, posix, relative, isAbsolute } from "node:path";
import { redactSensitiveText } from "@clankie/observability";
import {
  OPERATOR_CONVERSATION_REF_MAX,
  OPERATOR_SEAT_SUBAGENTS_RECENT_MAX,
  type OperatorSeatSubagents,
} from "@clankie/protocol";
import {
  resolveHerdrSeatTranscriptPath,
  resolveHerdrSeatTranscriptPathAsync,
  type HerdrAgentSession,
} from "./index.ts";
import {
  AgentSessionRequestError,
  readAgentSession,
  type AgentSessionFile,
  type AgentSessionPage,
  type AgentTranscriptHost,
} from "./sessions.ts";

/**
 * The subagents a Claude Code session started inside its own TUI (ADR 0208),
 * read from its transcript: an `Agent` (formerly `Task`) call without a result
 * is still running. A background call answers at once with `async_launched`
 * and finishes when its `<task-notification>` lands in the parent journal.
 *
 * Fleet reads ask for this, so it costs the append, not the history: a cold
 * read starts at most `COLD_READ_BYTES` from the end, and later reads fold in
 * only bytes written since. Older calls outside that window are not counted.
 */

const COLD_READ_BYTES = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** Calls remembered per session; the oldest leave first. */
const MAX_CALLS = 64;
const MAX_SESSIONS = 32;
const LABEL_MAX = 120;
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

interface SubagentCall {
  /** Native child file identity from the matching parent result, never the tool call ID. */
  agentId?: string;
  readonly label: string;
  readonly startedAt: string | undefined;
  endedAt: string | undefined;
  /** The assistant message that made the call; a later one means a sync call was abandoned. */
  readonly messageId: string | undefined;
  background: boolean;
  done: boolean;
}

interface SessionState<T> {
  readonly device: number;
  readonly inode: number;
  size: number;
  offset: number;
  mtimeMs: number;
  readonly data: T;
}

const sessions = new Map<string, SessionState<Map<string, SubagentCall>>>();
const paths = new Map<string, string>();

/** Bounded, incremental subagent summary for one local Claude session; undefined when it has no file. */
export function readClaudeSubagents(session: HerdrAgentSession): OperatorSeatSubagents | undefined {
  const journal = readJournal("claude", session, sessions, () => new Map(), foldClaudeSubagentLine);
  return journal === undefined ? undefined : summarize(journal.state.data);
}

/** Same bounded append reader for each native subagent projection. */
function readJournal<T>(
  harness: string,
  session: HerdrAgentSession,
  cache: Map<string, SessionState<T>>,
  create: () => T,
  fold: (data: T, line: string) => void,
  capacity = MAX_SESSIONS,
): { path: string; state: SessionState<T> } | undefined {
  const key = `${harness}:${session.kind}:${session.value}`;
  let path = paths.get(key);
  let stats = path === undefined ? undefined : statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) {
    path = resolveHerdrSeatTranscriptPath(harness, session);
    if (path === undefined) return undefined;
    stats = statSync(path, { throwIfNoEntry: false });
    if (stats === undefined) return undefined;
    paths.set(key, path);
    if (paths.size > MAX_SESSIONS) paths.delete(paths.keys().next().value!);
  }
  let state = cache.get(key);
  if (
    state === undefined ||
    state.device !== stats.dev ||
    state.inode !== stats.ino ||
    stats.size < state.size ||
    (stats.size === state.size && stats.mtimeMs !== state.mtimeMs)
  ) {
    state = {
      device: stats.dev,
      inode: stats.ino,
      size: 0,
      mtimeMs: 0,
      offset: Math.max(0, stats.size - COLD_READ_BYTES),
      data: create(),
    };
    if (state.offset > 0) state.offset = nextLineStart(path!, state.offset, stats.size);
  }
  cache.delete(key);
  cache.set(key, state);
  if (cache.size > capacity) cache.delete(cache.keys().next().value!);
  while (state.offset < stats.size) {
    const to = Math.min(stats.size, state.offset + READ_CHUNK_BYTES);
    const { lines, consumed } = completeLines(path!, state.offset, to);
    if (consumed === 0) {
      if (to === stats.size) break;
      state.offset = nextLineStart(path!, to, stats.size);
      continue;
    }
    for (const line of lines) fold(state.data, line);
    state.offset += consumed;
  }
  state.size = stats.size;
  state.mtimeMs = stats.mtimeMs;
  return { path: path!, state };
}

/** Codex fleet reads must never synchronously walk or read a session tree. */
async function readJournalAsync<T>(
  session: HerdrAgentSession,
  cache: Map<string, SessionState<T>>,
  create: () => T,
  fold: (data: T, line: string) => void,
  capacity = MAX_SESSIONS,
  supplied?: { path: string; stats: Stats },
): Promise<{ path: string; state: SessionState<T>; stats: Stats } | undefined> {
  const key = `codex:${session.kind}:${session.value}`;
  let path = supplied?.path ?? paths.get(key);
  let stats = supplied?.stats ?? (path === undefined ? undefined : await lstat(path).catch(() => undefined));
  if (stats === undefined) {
    path = await resolveHerdrSeatTranscriptPathAsync("codex", session);
    if (path === undefined) return undefined;
    stats = await lstat(path).catch(() => undefined);
    if (stats === undefined) return undefined;
    paths.set(key, path);
    if (paths.size > MAX_SESSIONS) paths.delete(paths.keys().next().value!);
  }
  if (!stats.isFile()) return undefined;
  let state = cache.get(key);
  if (
    state === undefined ||
    state.device !== stats.dev ||
    state.inode !== stats.ino ||
    stats.size < state.size ||
    (stats.size === state.size && stats.mtimeMs !== state.mtimeMs)
  ) {
    state = {
      device: stats.dev,
      inode: stats.ino,
      size: 0,
      mtimeMs: 0,
      offset: Math.max(0, stats.size - COLD_READ_BYTES),
      data: create(),
    };
    if (state.offset > 0) state.offset = await nextLineStartAsync(path!, state.offset, stats.size);
  }
  cache.delete(key);
  cache.set(key, state);
  if (cache.size > capacity) cache.delete(cache.keys().next().value!);
  while (state.offset < stats.size) {
    const to = Math.min(stats.size, state.offset + READ_CHUNK_BYTES);
    const buffer = await readRangeAsync(path!, state.offset, to, stats);
    const complete = buffer.lastIndexOf(0x0a);
    if (complete < 0) {
      if (to === stats.size) break;
      state.offset = await nextLineStartAsync(path!, to, stats.size);
      continue;
    }
    for (const line of buffer.toString("utf8", 0, complete + 1).split("\n")) fold(state.data, line);
    state.offset += complete + 1;
  }
  state.size = stats.size;
  state.mtimeMs = stats.mtimeMs;
  return { path: path!, state, stats };
}

/** Quiet files are a fallback, not proof of process completion. */
const CODEX_IDLE_MS = 5 * 60 * 1000;
const HEADER_BYTES = 64 * 1024;
const MAX_HEADERS = 4096;
/** A late child in an unrelated historical directory is discovered within this bound. */
const CODEX_DISCOVERY_REFRESH_MS = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface CodexMetadata {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly nickname: unknown;
  readonly task: string | undefined;
  readonly startedAt: number;
}
interface CodexSignal {
  readonly done: boolean;
  readonly at: number;
  readonly order: number;
}
interface CodexInvocation {
  readonly name: string;
  readonly target: string | undefined;
}
interface CodexState {
  order: number;
  readonly signals: Map<string, CodexSignal>;
  readonly invocations: Map<string, CodexInvocation>;
  readonly children: Map<string, SessionState<{ startedAt: number }>>;
}
const codexSessions = new Map<string, SessionState<CodexState>>();
const headers = new Map<
  string,
  { device: number; inode: number; size: number; mtimeMs: number; metadata: CodexMetadata }
>();
const codexReads = new Map<string, Promise<OperatorSeatSubagents | undefined>>();
interface CodexDirectory {
  readonly fingerprint: string;
  readonly directories: readonly string[];
  readonly files: readonly string[];
}
interface CodexIndex {
  readonly directories: Map<string, CodexDirectory>;
  readonly metadata: Map<string, CodexMetadata>;
  readonly pending: Map<string, string>;
  revision: number;
  refreshing: Promise<void> | undefined;
}
const codexIndexes = new Map<string, CodexIndex>();
const codexDiscoveries = new Map<
  string,
  {
    index: CodexIndex;
    parentId: string;
    revision: number;
    fingerprint: string;
    checkedAt: number;
    children: { path: string; metadata: CodexMetadata }[];
  }
>();

/**
 * Direct children of one addressed local Codex seat, discovered from session
 * headers in that seat's own Codex home. Only matching children's tails are
 * read. Parent collection/status records settle them on this very fleet read.
 */
export function readCodexSubagents(session: HerdrAgentSession): Promise<OperatorSeatSubagents | undefined> {
  const key = `${session.kind}:${session.value}`;
  const existing = codexReads.get(key);
  if (existing !== undefined) return existing;
  const pending = readCodexSubagentsAsync(session).finally(() => {
    if (codexReads.get(key) === pending) codexReads.delete(key);
  });
  codexReads.set(key, pending);
  return pending;
}

async function readCodexSubagentsAsync(
  session: HerdrAgentSession,
): Promise<OperatorSeatSubagents | undefined> {
  const journal = await readJournalAsync(
    session,
    codexSessions,
    () => ({ order: 0, signals: new Map(), invocations: new Map(), children: new Map() }),
    foldCodexSubagentLine,
  );
  if (journal === undefined) return undefined;
  const parent = await codexMetadataAsync(journal.path, journal.stats);
  if (parent === undefined) return undefined;
  const children = (await codexChildrenAsync(journal.path, parent, journal.stats))
    .sort((a, b) => a.metadata.startedAt - b.metadata.startedAt)
    .slice(-MAX_CALLS);
  const calls = new Map<string, SubagentCall>();
  for (const { path, metadata: discovered } of children) {
    try {
      const stats = await lstat(path);
      await confinedChildAsync(codexRoot(journal.path), path);
      // Directory mtimes do not observe appends or a rewritten child header.
      const metadata = await codexMetadataAsync(path, stats);
      if (metadata?.parentId !== parent.id || metadata.id !== discovered.id) continue;
      const child = await readJournalAsync(
        { source: session.source, kind: "path", value: path },
        journal.state.data.children,
        () => ({ startedAt: metadata.startedAt }),
        (data, line) => {
          const entry = jsonRecord(line);
          const payload = entry?.payload;
          if (entry?.type === "event_msg" && isRecord(payload) && payload.type === "task_started")
            data.startedAt = Math.max(data.startedAt, codexTimestamp(entry));
        },
        MAX_CALLS,
        { path, stats },
      );
      if (child === undefined) continue;
      const signals = [
        journal.state.data.signals.get(metadata.id),
        metadata.task === undefined ? undefined : journal.state.data.signals.get(metadata.task),
        metadata.task === undefined
          ? undefined
          : journal.state.data.signals.get(posix.relative(parent.task ?? "/root", metadata.task)),
      ].filter((signal) => signal !== undefined);
      const signal = signals.sort((a, b) => b.at - a.at || b.order - a.order)[0];
      const idle = Date.now() - child.state.mtimeMs >= CODEX_IDLE_MS;
      const done = signal !== undefined && signal.at >= child.state.data.startedAt ? signal.done : idle;
      calls.set(metadata.id, {
        label: label(
          [metadata.nickname, metadata.task].filter((value) => typeof value === "string").join(" · "),
        ),
        startedAt: isoTime(metadata.startedAt),
        endedAt: done
          ? isoTime(
              signal !== undefined && signal.at >= child.state.data.startedAt
                ? signal.at
                : child.state.mtimeMs + CODEX_IDLE_MS,
            )
          : undefined,
        messageId: undefined,
        background: false,
        done,
      });
    } catch {
      // One removed/unreadable child must not hide the others.
    }
  }
  return summarize(calls);
}

/** Discovery parses and retains only metadata; bytes after the first newline are ignored. */
function codexMetadata(path: string, fresh = false): CodexMetadata | undefined {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return undefined;
  const cached = headers.get(path);
  if (
    !fresh &&
    cached?.device === stats.dev &&
    cached.inode === stats.ino &&
    stats.size >= cached.size &&
    (stats.size !== cached.size || stats.mtimeMs === cached.mtimeMs)
  ) {
    cached.size = stats.size;
    cached.mtimeMs = stats.mtimeMs;
    return cached.metadata;
  }
  const prefix = readRange(path, 0, Math.min(stats.size, HEADER_BYTES));
  const metadata = parseCodexMetadata(prefix);
  if (metadata === undefined) return undefined;
  rememberCodexMetadata(path, stats, metadata);
  return metadata;
}

async function codexMetadataAsync(path: string, supplied?: Stats): Promise<CodexMetadata | undefined> {
  const stats = supplied ?? (await lstat(path).catch(() => undefined));
  if (stats === undefined || !stats.isFile()) return undefined;
  const cached = headers.get(path);
  if (
    cached?.device === stats.dev &&
    cached.inode === stats.ino &&
    stats.size >= cached.size &&
    (stats.size !== cached.size || stats.mtimeMs === cached.mtimeMs)
  ) {
    cached.size = stats.size;
    cached.mtimeMs = stats.mtimeMs;
    return cached.metadata;
  }
  const metadata = parseCodexMetadata(
    await readRangeAsync(path, 0, Math.min(stats.size, HEADER_BYTES), stats),
  );
  if (metadata === undefined) return undefined;
  rememberCodexMetadata(path, stats, metadata);
  return metadata;
}

function parseCodexMetadata(prefix: Buffer): CodexMetadata | undefined {
  const newline = prefix.indexOf(0x0a);
  if (newline < 0) return undefined; // A partial header waits for its writer.
  const entry = jsonRecord(prefix.toString("utf8", 0, newline));
  const payload = entry?.payload;
  if (
    entry?.type !== "session_meta" ||
    !isRecord(payload) ||
    typeof payload.id !== "string" ||
    !UUID.test(payload.id)
  )
    return undefined;
  const source = isRecord(payload.source) ? payload.source.subagent : undefined;
  const spawn = isRecord(source) && isRecord(source.thread_spawn) ? source.thread_spawn : undefined;
  const parentId = payload.parent_thread_id ?? spawn?.parent_thread_id;
  const task = payload.agent_path ?? spawn?.agent_path;
  const metadata = {
    id: payload.id,
    parentId:
      (payload.thread_source === "subagent" || spawn !== undefined) &&
      typeof parentId === "string" &&
      UUID.test(parentId)
        ? parentId
        : undefined,
    nickname: payload.agent_nickname ?? spawn?.agent_nickname,
    task: typeof task === "string" ? task : undefined,
    startedAt: codexTimestamp(entry),
  };
  return metadata;
}

function rememberCodexMetadata(path: string, stats: Stats, metadata: CodexMetadata): void {
  headers.set(path, {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    metadata,
  });
  if (headers.size > MAX_HEADERS) headers.delete(headers.keys().next().value!);
}

function foldCodexSubagentLine(state: CodexState, line: string): void {
  const entry = jsonRecord(line);
  const payload = entry?.payload;
  if (entry?.type !== "response_item" || !isRecord(payload)) return;
  const at = codexTimestamp(entry);
  const signal = (target: unknown, done: boolean) => {
    if (
      typeof target !== "string" ||
      target.length > 256 ||
      !(UUID.test(target) || /^\/?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(target))
    )
      return;
    state.signals.delete(target);
    state.order += 1;
    state.signals.set(target, { done, at, order: state.order });
    while (state.signals.size > MAX_CALLS * 2) state.signals.delete(state.signals.keys().next().value!);
  };
  if (
    payload.type === "agent_message" &&
    typeof payload.author === "string" &&
    typeof payload.recipient === "string"
  ) {
    const content = Array.isArray(payload.content) ? payload.content[0] : undefined;
    // Only the native envelope, never FINAL_ANSWER text quoted in a message body.
    if (
      isRecord(content) &&
      content.type === "input_text" &&
      typeof content.text === "string" &&
      content.text.startsWith(
        `Message Type: FINAL_ANSWER\nTask name: ${payload.recipient}\nSender: ${payload.author}\nPayload:\n`,
      )
    )
      signal(payload.author, true);
    return;
  }
  if (
    payload.type === "function_call" &&
    typeof payload.call_id === "string" &&
    typeof payload.name === "string"
  ) {
    const args = typeof payload.arguments === "string" ? jsonRecord(payload.arguments) : undefined;
    const native =
      payload.namespace === "collaboration" ||
      payload.namespace === "multi_agent_v1" ||
      (payload.namespace === undefined &&
        ["spawn_agent", "wait", "close_agent", "resume_agent", "send_input"].includes(payload.name));
    if (
      !native ||
      ![
        "wait",
        "wait_agent",
        "close_agent",
        "interrupt_agent",
        "followup_task",
        "resume_agent",
        "send_input",
        "list_agents",
      ].includes(payload.name) ||
      (payload.name === "wait" && !Array.isArray(args?.ids))
    )
      return;
    const target = args?.target ?? args?.id;
    state.invocations.set(payload.call_id, {
      name: payload.name,
      target: typeof target === "string" ? target : undefined,
    });
    while (state.invocations.size > MAX_CALLS)
      state.invocations.delete(state.invocations.keys().next().value!);
    return;
  }
  if (payload.type !== "function_call_output" || typeof payload.call_id !== "string") return;
  const invocation = state.invocations.get(payload.call_id);
  if (invocation === undefined) return;
  state.invocations.delete(payload.call_id);
  const output = typeof payload.output === "string" ? jsonRecord(payload.output) : undefined;
  if (invocation.name === "list_agents" && Array.isArray(output?.agents)) {
    for (const agent of output.agents)
      if (isRecord(agent)) foldCodexStatus(agent.agent_status, (done) => signal(agent.agent_name, done));
  } else if ((invocation.name === "wait" || invocation.name === "wait_agent") && isRecord(output?.status)) {
    for (const [id, status] of Object.entries(output.status))
      foldCodexStatus(status, (done) => signal(id, done));
  } else if (invocation.name === "close_agent" && output !== undefined && "previous_status" in output) {
    signal(invocation.target, true);
  } else if (invocation.name === "interrupt_agent" && typeof output?.previous_status === "string") {
    signal(invocation.target, true);
  } else if (invocation.name === "followup_task" && payload.output === "") {
    signal(invocation.target, false);
  } else if (invocation.name === "resume_agent" && output !== undefined) {
    foldCodexStatus(output.status, (done) => signal(invocation.target, done));
  } else if (invocation.name === "send_input" && typeof output?.submission_id === "string") {
    signal(invocation.target, false);
  }
}

function foldCodexStatus(status: unknown, signal: (done: boolean) => void): void {
  if (status === "running" || status === "pending_init") signal(false);
  else if (
    status === "shutdown" ||
    status === "interrupted" ||
    status === "completed" ||
    status === "errored"
  )
    signal(true);
  else if (isRecord(status) && ("completed" in status || "errored" in status)) signal(true);
}

function jsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function codexTimestamp(entry: Record<string, unknown>): number {
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(at) ? at : 0;
}

/** Exposed for tests: the same fold over a whole journal. */
export function parseClaudeSubagents(jsonl: string): OperatorSeatSubagents {
  const calls = new Map<string, SubagentCall>();
  for (const line of jsonl.split("\n")) if (line.trim()) foldClaudeSubagentLine(calls, line);
  return summarize(calls);
}

function foldClaudeSubagentLine(calls: Map<string, SubagentCall>, line: string): void {
  const entry = jsonRecord(line);
  const at = entry === undefined ? undefined : isoTime(codexTimestamp(entry));
  // Native background notifications settle at their parent record timestamp.
  if (line.includes("<task-notification>")) {
    for (const match of line.matchAll(
      /<tool-use-id>([^<]{1,200})<\/tool-use-id>[\s\S]*?<status>([a-z_]{1,32})<\/status>/gu,
    )) {
      const call = calls.get(match[1]!);
      if (call !== undefined && match[2] !== "running") endClaudeCall(call, at);
    }
  }
  if (!isRecord(entry) || entry.isSidechain === true) return;
  const message = isRecord(entry.message) ? entry.message : undefined;
  const content = Array.isArray(message?.content) ? message.content.filter(isRecord) : [];
  if (entry.type === "assistant") {
    const messageId = typeof message?.id === "string" ? message.id : undefined;
    // The main thread waits on a foreground call, so it speaking again in a
    // new message means that call ended without a recorded result (an
    // interrupt, a rewound branch).
    for (const call of calls.values()) {
      if (!call.done && !call.background && call.messageId !== messageId) endClaudeCall(call, at);
    }
    for (const item of content) {
      if (item.type !== "tool_use" || typeof item.id !== "string" || !SUBAGENT_TOOLS.has(String(item.name)))
        continue;
      const input = isRecord(item.input) ? item.input : {};
      calls.set(item.id, {
        label: label(input.description ?? input.subagent_type),
        startedAt: at,
        endedAt: undefined,
        messageId,
        background: false,
        done: false,
      });
      while (calls.size > MAX_CALLS) calls.delete(calls.keys().next().value!);
    }
    return;
  }
  if (entry.type !== "user") return;
  const result = isRecord(entry.toolUseResult) ? entry.toolUseResult : undefined;
  for (const item of content) {
    if (item.type !== "tool_result") continue;
    const call = calls.get(String(item.tool_use_id));
    if (call === undefined) continue;
    if (typeof result?.agentId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(result.agentId))
      call.agentId = result.agentId;
    if (result?.status === "async_launched" || result?.isAsync === true) call.background = true;
    else endClaudeCall(call, at);
  }
}

function summarize(calls: ReadonlyMap<string, SubagentCall>): OperatorSeatSubagents {
  const all = [...calls.entries()];
  return {
    running: all.filter(([, call]) => !call.done).length,
    recent: all
      .slice(-OPERATOR_SEAT_SUBAGENTS_RECENT_MAX)
      .reverse()
      .map(([id, call]) => ({
        id,
        label: call.label,
        status: call.done ? "done" : "running",
        ...(call.startedAt === undefined ? {} : { startedAt: call.startedAt }),
        ...(!call.done || call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
      })),
  };
}

/** Native OpenCode v1 task parts, supplied by the confined registered-profile reader. */
export function projectOpenCodeSubagents(
  parentId: string,
  messages: readonly unknown[],
  isChild: (id: string) => boolean,
  onChild?: (callId: string, childId: string | undefined) => void,
): OperatorSeatSubagents {
  const calls = new Map<string, SubagentCall & { childId: string | undefined }>();
  for (const raw of messages) {
    const message = openCodeRecord(raw);
    const info = openCodeRecord(message?.info);
    if (info?.sessionID !== parentId || !Array.isArray(message?.parts)) continue;
    const created = openCodeRecord(info.time)?.created;
    for (const rawPart of message.parts) {
      const part = openCodeRecord(rawPart);
      if (!part || part.sessionID !== parentId) continue;
      if (part.type === "text" && part.synthetic === true && info.role === "user") {
        const signal = openCodeTaskEnvelope(part.text);
        if (!signal || signal.status === "running") continue;
        const endedAt = openCodeTime(created);
        for (const call of calls.values())
          if (
            call.childId === signal.id &&
            call.background &&
            !call.done &&
            (endedAt === undefined ||
              call.startedAt === undefined ||
              Date.parse(endedAt) >= Date.parse(call.startedAt))
          ) {
            call.done = true;
            call.endedAt = endedAt;
          }
        continue;
      }
      if (part.type !== "tool" || part.tool !== "task" || typeof part.callID !== "string") continue;
      if (part.callID.length === 0 || part.callID.length > OPERATOR_CONVERSATION_REF_MAX) continue;
      const state = openCodeRecord(part.state);
      if (!state || !["pending", "running", "completed", "error"].includes(String(state.status))) continue;
      const input = openCodeRecord(state.input);
      const metadata = openCodeRecord(state.metadata);
      const envelope = openCodeTaskEnvelope(state.output);
      const childId = typeof metadata?.sessionId === "string" ? metadata.sessionId : envelope?.id;
      if (metadata?.parentSessionId !== undefined && metadata.parentSessionId !== parentId) continue;
      if (childId !== undefined && !isChild(childId)) continue;
      onChild?.(part.callID, childId);
      const time = openCodeRecord(state.time);
      const background = metadata?.background === true || envelope?.status === "running";
      const done =
        state.status === "error" ||
        (state.status === "completed" &&
          (!background || envelope?.status === "completed" || envelope?.status === "error"));
      calls.set(part.callID, {
        label: label(
          [input?.subagent_type, input?.description ?? state.title]
            .filter((v) => typeof v === "string")
            .join(": "),
        ),
        childId,
        startedAt: openCodeTime(time?.start ?? part.createdAt),
        endedAt: done ? openCodeTime(time?.end) : undefined,
        messageId: undefined,
        background,
        done,
      });
      if (calls.size > MAX_CALLS) calls.delete(calls.keys().next().value!);
    }
  }
  return summarize(calls);
}

function openCodeTaskEnvelope(value: unknown): { id: string; status: string } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^<task id="(ses_[A-Za-z0-9]{8,128})" state="(running|completed|error)">\r?\n/u.exec(value);
  return match ? { id: match[1]!, status: match[2]! } : undefined;
}

function openCodeTime(value: unknown): string | undefined {
  return typeof value === "number" && value >= 0 && value <= 8_640_000_000_000_000
    ? new Date(value).toISOString()
    : undefined;
}

function openCodeRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function endClaudeCall(call: SubagentCall, at: string | undefined): void {
  if (call.done) return;
  call.done = true;
  call.endedAt = at;
}

/** Missing/invalid source timestamps remain unknown, never wall-clock invention. */
function isoTime(at: number): string | undefined {
  return at > 0 && Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

function label(value: unknown): string {
  const text = typeof value === "string" ? redactSensitiveText(value.replace(/\s+/gu, " ").trim()) : "";
  if (text.length === 0) return "subagent";
  return text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1)}…`;
}

function nextLineStart(path: string, from: number, size: number): number {
  const buffer = readRange(path, from, Math.min(size, from + READ_CHUNK_BYTES));
  const newline = buffer.indexOf(0x0a);
  return newline < 0 ? size : from + newline + 1;
}

/** Whole lines only; a half-written record waits for the next read. */
function completeLines(path: string, from: number, to: number): { lines: string[]; consumed: number } {
  const buffer = readRange(path, from, to);
  const complete = buffer.lastIndexOf(0x0a);
  if (complete < 0) return { lines: [], consumed: 0 };
  return { lines: buffer.toString("utf8", 0, complete + 1).split("\n"), consumed: complete + 1 };
}

function readRange(path: string, from: number, to: number): Buffer {
  if (to <= from) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(to - from);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile())
      throw new AgentSessionRequestError("Native transcript is not a regular file", 409);
    return buffer.subarray(0, Math.max(0, readSync(fd, buffer, 0, buffer.length, from)));
  } finally {
    closeSync(fd);
  }
}

async function nextLineStartAsync(path: string, from: number, size: number): Promise<number> {
  const buffer = await readRangeAsync(path, from, Math.min(size, from + READ_CHUNK_BYTES));
  const newline = buffer.indexOf(0x0a);
  return newline < 0 ? size : from + newline + 1;
}

async function readRangeAsync(path: string, from: number, to: number, expected?: Stats): Promise<Buffer> {
  if (to <= from) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(to - from);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new AgentSessionRequestError("Native transcript is not a regular file", 409);
    if (expected !== undefined && (stats.dev !== expected.dev || stats.ino !== expected.ino))
      throw new AgentSessionRequestError("Native transcript changed during read", 409);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, from);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** On-demand child history under one already-addressed local parent. No native control authority. */
export async function readNativeSubagentSession(
  harness: "claude" | "codex",
  parent: HerdrAgentSession,
  childId: string,
  options: { tail?: number; after?: string } = {},
): Promise<AgentSessionPage> {
  if (!childId || childId.length > OPERATOR_CONVERSATION_REF_MAX)
    throw new AgentSessionRequestError("Invalid subagent identity");
  const selected = resolveNativeChild(harness, parent, childId);
  const assertSelected = () => {
    const fresh = resolveNativeChild(harness, parent, childId);
    if (
      fresh.path !== selected.path ||
      fresh.agentId !== selected.agentId ||
      fresh.parentIdentity !== selected.parentIdentity ||
      fresh.childIdentity !== selected.childIdentity
    )
      throw new AgentSessionRequestError("Subagent parent source changed during read", 409);
    return fresh;
  };
  const host: AgentTranscriptHost = {
    id: "local",
    async list() {
      return [selected.file];
    },
    async readBytes(path, from, maxBytes) {
      if (path !== selected.path) throw new AgentSessionRequestError("Foreign child source", 409);
      const fresh = assertSelected();
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const stat = fstatSync(fd);
        if (`${stat.dev}:${stat.ino}` !== fresh.childIdentity || !stat.isFile())
          throw new AgentSessionRequestError("Native child file changed during read", 409);
        bytes = Buffer.alloc(Math.max(0, Math.min(maxBytes, stat.size - from)));
        bytes = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, from));
      } finally {
        closeSync(fd);
      }
      assertSelected();
      return { bytes, size: fresh.file.size };
    },
  };
  const page = await readAgentSession(host, selected.file, {
    ...options,
    ...(selected.agentId === undefined ? {} : { claudeAgentId: selected.agentId }),
  });
  assertSelected();
  return page;
}

function resolveNativeChild(harness: "claude" | "codex", parent: HerdrAgentSession, childId: string) {
  const supplied = resolveHerdrSeatTranscriptPath(harness, parent);
  if (supplied === undefined) throw new AgentSessionRequestError("Parent native transcript unavailable", 404);
  const parentPath = realpathSync(supplied);
  const parentStat = statSync(parentPath);
  if (!parentStat.isFile()) throw new AgentSessionRequestError("Invalid parent native source", 409);
  let path: string | undefined;
  let root: string;
  let agentId: string | undefined;
  if (harness === "claude") {
    const calls = new Map<string, SubagentCall>();
    const parentBytes = readRange(
      parentPath,
      Math.max(0, parentStat.size - COLD_READ_BYTES),
      parentStat.size,
    );
    for (const line of parentBytes.toString("utf8").split("\n")) foldClaudeSubagentLine(calls, line);
    const call = calls.get(childId);
    if (call === undefined) throw new AgentSessionRequestError("No matching parent subagent call", 404);
    agentId = call.agentId;
    if (agentId === undefined)
      throw new AgentSessionRequestError("Native child locator is not available yet", 409);
    root = join(parentPath.replace(/\.jsonl$/u, ""), "subagents");
    path = join(root, `agent-${agentId}.jsonl`);
    if (statSync(path, { throwIfNoEntry: false }) === undefined)
      throw new AgentSessionRequestError("Native child transcript unavailable", 404);
    confinedChild(root, path);
    const prefix = readRange(path, 0, HEADER_BYTES);
    const newline = prefix.indexOf(0x0a);
    const header = newline < 0 ? undefined : jsonRecord(prefix.toString("utf8", 0, newline));
    const parentId = parentPath
      .split("/")
      .at(-1)!
      .replace(/\.jsonl$/u, "");
    if (header?.agentId !== agentId || header.isSidechain !== true || header.sessionId !== parentId)
      throw new AgentSessionRequestError("Native child header does not match its parent", 409);
  } else {
    if (!UUID.test(childId)) throw new AgentSessionRequestError("Invalid native child thread identity");
    const metadata = codexMetadata(parentPath, true);
    if (metadata === undefined) throw new AgentSessionRequestError("Parent native header unavailable", 409);
    root = codexRoot(parentPath);
    const matches = codexChildren(parentPath, metadata)
      .filter((child) => child.metadata.id === childId)
      .filter((child) => {
        const fresh = codexMetadata(child.path, true);
        return fresh?.id === childId && fresh.parentId === metadata.id;
      })
      .map((child) => child.path);
    if (matches.length !== 1)
      throw new AgentSessionRequestError(
        matches.length ? "Ambiguous native child transcript" : "No matching native child transcript",
        matches.length ? 409 : 404,
      );
    path = matches[0]!;
  }
  const canonicalChild = confinedChild(root, path);
  const stat = statSync(canonicalChild);
  if (!stat.isFile()) throw new AgentSessionRequestError("Native child is not a regular transcript", 409);
  const file: AgentSessionFile = { harness, path: canonicalChild, size: stat.size, mtimeMs: stat.mtimeMs };
  return {
    path: canonicalChild,
    file,
    agentId,
    parentIdentity: `${parentStat.dev}:${parentStat.ino}`,
    childIdentity: `${stat.dev}:${stat.ino}`,
  };
}

function confinedChild(root: string, path: string): string {
  const canonicalRoot = realpathSync(root);
  const canonicalChild = realpathSync(path);
  const rel = relative(canonicalRoot, canonicalChild);
  if (canonicalChild !== path || !rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new AgentSessionRequestError("Native child source escaped its parent", 409);
  return canonicalChild;
}

function codexRoot(parentPath: string): string {
  const boundary = parentPath.lastIndexOf("/sessions/");
  return boundary < 0 ? dirname(parentPath) : parentPath.slice(0, boundary + "/sessions".length);
}

async function confinedChildAsync(root: string, path: string): Promise<string> {
  const [canonicalRoot, canonicalChild] = await Promise.all([realpath(root), realpath(path)]);
  const rel = relative(canonicalRoot, canonicalChild);
  if (canonicalChild !== path || !rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new AgentSessionRequestError("Native child source escaped its parent", 409);
  return canonicalChild;
}

function fingerprint(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

/**
 * Share one async directory-stat pass across concurrent parents in a Codex home.
 * Unchanged directories reuse their listings and headers. Checking each known
 * directory is necessary: adding a rollout in an old date directory does not
 * change the sessions root's mtime. File appends are checked separately.
 */
async function refreshCodexIndex(root: string, index: CodexIndex): Promise<void> {
  if (index.refreshing !== undefined) return index.refreshing;
  const pending = (async () => {
    const directories = new Set<string>();
    const changed = new Set<string>();
    const files: string[] = [];
    let visited = 0;
    const visit = async (path: string): Promise<void> => {
      if (++visited > MAX_HEADERS) return;
      const stats = await lstat(path).catch(() => undefined);
      if (stats === undefined || !stats.isDirectory()) return;
      const current = fingerprint(stats);
      let cached = index.directories.get(path);
      if (cached?.fingerprint !== current) {
        // Never traverse a replaced directory through an ancestor symlink.
        if ((await realpath(path).catch(() => undefined)) !== path) return;
        const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
        if (entries === undefined) return;
        cached = {
          fingerprint: current,
          directories: entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(path, entry.name))
            .sort(),
          files: entries
            .filter((entry) => entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name))
            .map((entry) => join(path, entry.name)),
        };
        index.directories.set(path, cached);
        changed.add(path);
      }
      directories.add(path);
      files.push(...cached.files);
      await Promise.all(cached.directories.map(visit));
    };
    await visit(root);
    for (const path of index.directories.keys()) if (!directories.has(path)) index.directories.delete(path);
    const selected = new Set(files.sort().reverse().slice(0, MAX_HEADERS));
    for (const path of index.metadata.keys()) {
      if (!selected.has(path)) {
        index.metadata.delete(path);
        index.revision += 1;
      }
    }
    for (const path of index.pending.keys()) if (!selected.has(path)) index.pending.delete(path);
    const candidates = [...selected].filter(
      (path) => !index.metadata.has(path) || changed.has(dirname(path)),
    );
    // Bound simultaneous open file handles even on a cold, large native home.
    for (let offset = 0; offset < candidates.length; offset += 16) {
      await Promise.all(
        candidates.slice(offset, offset + 16).map(async (path) => {
          const stats = await lstat(path).catch(() => undefined);
          if (stats === undefined || !stats.isFile()) {
            if (index.metadata.delete(path)) index.revision += 1;
            index.pending.delete(path);
            return;
          }
          const current = fingerprint(stats);
          if (index.pending.get(path) === current) return;
          try {
            await confinedChildAsync(root, path);
            const metadata = await codexMetadataAsync(path, stats);
            if (metadata === undefined) {
              if (index.metadata.delete(path)) index.revision += 1;
              index.pending.set(path, current);
            } else {
              if (index.metadata.get(path) !== metadata) index.revision += 1;
              index.metadata.set(path, metadata);
              index.pending.delete(path);
            }
          } catch {
            if (index.metadata.delete(path)) index.revision += 1;
            index.pending.set(path, current);
          }
        }),
      );
    }
  })().finally(() => {
    if (index.refreshing === pending) index.refreshing = undefined;
  });
  index.refreshing = pending;
  return pending;
}

/** Check only this parent's relevant directories between bounded full discovery passes. */
function codexRelevantDirectories(root: string, parentPath: string, children: readonly { path: string }[]) {
  const directories = new Set([root]);
  const add = (path: string) => {
    let current = path;
    while (current !== root) {
      const rel = relative(root, current);
      if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return;
      directories.add(current);
      current = dirname(current);
    }
  };
  add(dirname(parentPath));
  for (const child of children) add(dirname(child.path));
  const parentDate = /\/(\d{4})\/(\d{2})\/(\d{2})$/u.exec(dirname(parentPath));
  const dates = [Date.now()];
  if (parentDate !== null) {
    const parsed = Date.parse(`${parentDate[1]}-${parentDate[2]}-${parentDate[3]}T00:00:00Z`);
    if (Number.isFinite(parsed)) dates.push(parsed);
  }
  for (const at of dates) {
    for (const offset of [-1, 0, 1]) {
      const date = new Date(at + offset * 86_400_000);
      add(
        join(
          root,
          String(date.getUTCFullYear()),
          String(date.getUTCMonth() + 1).padStart(2, "0"),
          String(date.getUTCDate()).padStart(2, "0"),
        ),
      );
    }
  }
  return directories;
}

async function codexChildrenAsync(parentPath: string, parent: CodexMetadata, parentStats: Stats) {
  const canonicalParent = await realpath(parentPath);
  const root = codexRoot(canonicalParent);
  let index = codexIndexes.get(root);
  if (index === undefined) {
    index = {
      directories: new Map(),
      metadata: new Map(),
      pending: new Map(),
      revision: 0,
      refreshing: undefined,
    };
    codexIndexes.set(root, index);
    if (codexIndexes.size > MAX_SESSIONS) codexIndexes.delete(codexIndexes.keys().next().value!);
  }
  const cached = codexDiscoveries.get(canonicalParent);
  const directories = codexRelevantDirectories(root, canonicalParent, cached?.children ?? []);
  const relevant = [
    ...directories,
    ...[...index.pending.keys()]
      .filter((path) => directories.has(dirname(path)))
      .sort()
      .reverse()
      .slice(0, MAX_CALLS),
  ].sort();
  const stamps = await Promise.all(
    relevant.map(async (path) => {
      const stats = await lstat(path).catch(() => undefined);
      return `${path}:${stats === undefined ? "missing" : fingerprint(stats)}`;
    }),
  );
  const current = `${fingerprint(parentStats)}\n${stamps.join("\n")}`;
  const now = Date.now();
  const fresh =
    cached?.index === index &&
    cached.parentId === parent.id &&
    cached.fingerprint === current &&
    now >= cached.checkedAt &&
    now - cached.checkedAt < CODEX_DISCOVERY_REFRESH_MS;
  if (fresh && cached.revision === index.revision) return cached.children;
  if (!fresh) await refreshCodexIndex(root, index);
  const children = [...index.metadata.entries()]
    .filter(([, metadata]) => metadata.parentId === parent.id)
    .map(([path, metadata]) => ({ path, metadata }))
    .sort((a, b) => a.metadata.startedAt - b.metadata.startedAt)
    .slice(-MAX_CALLS);
  codexDiscoveries.delete(canonicalParent);
  codexDiscoveries.set(canonicalParent, {
    index,
    parentId: parent.id,
    revision: index.revision,
    fingerprint: current,
    checkedAt: fresh ? cached.checkedAt : now,
    children,
  });
  if (codexDiscoveries.size > MAX_SESSIONS) codexDiscoveries.delete(codexDiscoveries.keys().next().value!);
  return children;
}

/** The same bounded header discovery serves roster projection and on-demand child history. */
function codexChildren(parentPath: string, parent: CodexMetadata) {
  const root = codexRoot(realpathSync(parentPath));
  return globSync("**/rollout-*.jsonl", { cwd: root })
    .sort()
    .reverse()
    .slice(0, MAX_HEADERS)
    .flatMap((relative) => {
      const path = join(root, relative);
      try {
        confinedChild(root, path);
        const metadata = codexMetadata(path);
        return metadata?.parentId === parent.id ? [{ path, metadata }] : [];
      } catch {
        return [];
      }
    });
}
