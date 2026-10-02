import { closeSync, openSync, readSync, statSync } from "node:fs";
import { redactSensitiveText } from "@clankie/observability";
import { OPERATOR_SEAT_SUBAGENTS_RECENT_MAX, type OperatorSeatSubagents } from "@clankie/protocol";
import { resolveHerdrSeatTranscriptPath, type HerdrAgentSession } from "./index.ts";

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
  readonly label: string;
  /** The assistant message that made the call; a later one means a sync call was abandoned. */
  readonly messageId: string | undefined;
  background: boolean;
  done: boolean;
}

interface SessionState {
  readonly device: number;
  readonly inode: number;
  size: number;
  offset: number;
  readonly calls: Map<string, SubagentCall>;
}

const sessions = new Map<string, SessionState>();
const paths = new Map<string, string>();

/** Bounded, incremental subagent summary for one local Claude session; undefined when it has no file. */
export function readClaudeSubagents(session: HerdrAgentSession): OperatorSeatSubagents | undefined {
  const key = `${session.kind}:${session.value}`;
  let path = paths.get(key);
  let stats = path === undefined ? undefined : statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) {
    path = resolveHerdrSeatTranscriptPath("claude", session);
    if (path === undefined) return undefined;
    stats = statSync(path, { throwIfNoEntry: false });
    if (stats === undefined) return undefined;
    paths.set(key, path);
    if (paths.size > MAX_SESSIONS) paths.delete(paths.keys().next().value!);
  }
  let state = sessions.get(key);
  if (
    state === undefined ||
    state.device !== stats.dev ||
    state.inode !== stats.ino ||
    stats.size < state.size
  ) {
    state = {
      device: stats.dev,
      inode: stats.ino,
      size: 0,
      offset: Math.max(0, stats.size - COLD_READ_BYTES),
      calls: new Map(),
    };
    // A cold read that starts mid-file drops the partial first line.
    if (state.offset > 0) state.offset = nextLineStart(path!, state.offset, stats.size);
  }
  sessions.delete(key);
  sessions.set(key, state);
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  while (state.offset < stats.size) {
    const to = Math.min(stats.size, state.offset + READ_CHUNK_BYTES);
    const { lines, consumed } = completeLines(path!, state.offset, to);
    if (consumed === 0) {
      if (to === stats.size) break;
      // One record longer than a chunk (an inline image): step over it.
      state.offset = nextLineStart(path!, to, stats.size);
      continue;
    }
    for (const line of lines) foldClaudeSubagentLine(state.calls, line);
    state.offset += consumed;
  }
  state.size = stats.size;
  return summarize(state.calls);
}

/** Exposed for tests: the same fold over a whole journal. */
export function parseClaudeSubagents(jsonl: string): OperatorSeatSubagents {
  const calls = new Map<string, SubagentCall>();
  for (const line of jsonl.split("\n")) if (line.trim()) foldClaudeSubagentLine(calls, line);
  return summarize(calls);
}

function foldClaudeSubagentLine(calls: Map<string, SubagentCall>, line: string): void {
  // The notification is plain text inside whichever record carries it
  // (a queue operation, a user turn); the tags survive JSON escaping.
  if (line.includes("<task-notification>")) {
    for (const match of line.matchAll(
      /<tool-use-id>([^<]{1,200})<\/tool-use-id>[\s\S]*?<status>([a-z_]{1,32})<\/status>/gu,
    )) {
      const call = calls.get(match[1]!);
      if (call !== undefined && match[2] !== "running") call.done = true;
    }
  }
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
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
      if (!call.done && !call.background && call.messageId !== messageId) call.done = true;
    }
    for (const item of content) {
      if (item.type !== "tool_use" || typeof item.id !== "string" || !SUBAGENT_TOOLS.has(String(item.name)))
        continue;
      const input = isRecord(item.input) ? item.input : {};
      calls.set(item.id, {
        label: label(input.description ?? input.subagent_type),
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
    if (result?.status === "async_launched" || result?.isAsync === true) call.background = true;
    else call.done = true;
  }
}

function summarize(calls: ReadonlyMap<string, SubagentCall>): OperatorSeatSubagents {
  const all = [...calls.values()];
  return {
    running: all.filter((call) => !call.done).length,
    recent: all
      .slice(-OPERATOR_SEAT_SUBAGENTS_RECENT_MAX)
      .reverse()
      .map((call) => ({ label: call.label, status: call.done ? "done" : "running" })),
  };
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
  const fd = openSync(path, "r");
  try {
    return buffer.subarray(0, Math.max(0, readSync(fd, buffer, 0, buffer.length, from)));
  } finally {
    closeSync(fd);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
