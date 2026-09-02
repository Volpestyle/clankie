import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
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
  readonly text: string;
  readonly occurredAt?: string;
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
  readonly detail?: string;
  readonly occurredAt?: string;
}

export type HerdrTranscriptEntry = HerdrTranscriptMessage | HerdrTranscriptTool;

export interface HerdrSeatTranscript {
  readonly sessionKey: string;
  readonly entries: readonly HerdrTranscriptEntry[];
}

// ponytail: the app replays at most 10k events; raise both ceilings together if real sessions exceed this.
const MAX_ENTRIES = 9_000;

/** Read the harness-native session tree Herdr already identifies for resume. */
export function readHerdrSeatTranscript(
  agent: string,
  session: HerdrAgentSession | undefined,
  processId?: number,
): HerdrSeatTranscript | undefined {
  const resolvedSession = session ?? (agent === "grok" ? grokSessionForProcess(processId) : undefined);
  if (resolvedSession === undefined) return undefined;
  const path = transcriptPath(agent, resolvedSession);
  if (path === undefined) return undefined;
  const entries = parseHerdrSeatTranscript(agent, readFileSync(path, "utf8"));
  return {
    sessionKey: `${resolvedSession.source}:${resolvedSession.kind}:${resolvedSession.value}`,
    entries: entries.slice(-MAX_ENTRIES),
  };
}

/** Normalize the words and expandable tool executions the harness TUI renders. */
export function parseHerdrSeatTranscript(agent: string, jsonl: string): HerdrTranscriptEntry[] {
  const entries = jsonl
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
  if (agent === "codex") return codexEntries(entries);
  if (agent === "claude") return claudeEntries(entries);
  if (agent === "pi") return piEntries(entries);
  if (agent === "grok") return grokEntries(entries);
  return [];
}

function transcriptPath(agent: string, session: HerdrAgentSession): string | undefined {
  if (session.kind === "path")
    return isAbsolute(session.value) && existsSync(session.value) ? session.value : undefined;
  if (agent === "claude") {
    return globSync(join(homedir(), ".claude/projects/*", `${session.value}.jsonl`))[0];
  }
  if (agent === "grok") {
    return globSync(join(homedir(), ".grok/sessions/*", session.value, "chat_history.jsonl"))[0];
  }
  if (agent !== "codex") return undefined;
  const compact = session.value.replaceAll("-", "");
  const millis = Number.parseInt(compact.slice(0, 12), 16);
  if (Number.isFinite(millis)) {
    const date = new Date(millis);
    const directory = join(
      homedir(),
      ".codex/sessions",
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    );
    const path = existsSync(directory)
      ? readdirSync(directory).find((name) => name.includes(session.value) && name.endsWith(".jsonl"))
      : undefined;
    if (path !== undefined) return join(directory, path);
  }
  return globSync(join(homedir(), ".codex/sessions/**/*.jsonl")).find((path) => path.includes(session.value));
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

function codexEntries(entries: readonly Record<string, unknown>[]): HerdrTranscriptEntry[] {
  const toolNames = new Map<string, string>();
  return dedupeTools(
    entries.flatMap<HerdrTranscriptEntry>((entry, index) => {
      if (entry.type !== "response_item") return [];
      const payload = record(entry.payload);
      if (payload === undefined) return [];
      const payloadType = string(payload.type);
      const metadata = record(payload.internal_chat_message_metadata_passthrough);
      const nativeId = string(payload.id) ?? string(metadata?.turn_id) ?? String(index);
      const at = timestamp(entry, metadata?.create_time);
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
        return transcriptMessage(`codex:${nativeId}`, role === "user" ? "operator" : "agent", text, at);
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
            at,
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
      return [transcriptTool(`codex:${nativeId}`, callId, name, phase, detail, at)];
    }),
  );
}

function claudeEntries(entries: readonly Record<string, unknown>[]): HerdrTranscriptEntry[] {
  const chain = activeChain(
    entries,
    "uuid",
    "parentUuid",
    (entry) => (entry.type === "user" || entry.type === "assistant") && entry.isSidechain !== true,
  );
  const toolNames = new Map<string, string>();
  return dedupeTools(
    chain.flatMap<HerdrTranscriptEntry>((entry, entryIndex) => {
      if (entry.isMeta === true || entry.promptSource === "system") return [];
      const message = record(entry.message);
      if (message === undefined) return [];
      const nativeId = string(entry.uuid) ?? String(entryIndex);
      const at = timestamp(entry);
      const content = array(message.content).filter(isRecord);
      if (entry.type === "assistant") {
        const spoken = transcriptMessage(`claude:${nativeId}`, "agent", messageText(message.content), at);
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
      const text = messageText(message.content);
      if (/^<(?:local-command-|command-name>|system-reminder>|channel[ >])/u.test(text.trimStart()))
        return [];
      return transcriptMessage(`claude:${nativeId}`, "operator", text, at);
    }),
  );
}

function piEntries(entries: readonly Record<string, unknown>[]): HerdrTranscriptEntry[] {
  const chain = activeChain(entries, "id", "parentId", (entry) => entry.type === "message");
  const toolNames = new Map<string, string>();
  return dedupeTools(
    chain.flatMap<HerdrTranscriptEntry>((entry, entryIndex) => {
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

function grokEntries(entries: readonly Record<string, unknown>[]): HerdrTranscriptEntry[] {
  const toolNames = new Map<string, string>();
  return dedupeTools(
    entries.flatMap<HerdrTranscriptEntry>((entry, index) => {
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
  );
}

function activeChain(
  entries: readonly Record<string, unknown>[],
  idKey: string,
  parentKey: string,
  include: (entry: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  const candidates = entries.filter(include);
  const byId = new Map(
    entries.flatMap((entry) => {
      const id = string(entry[idKey]);
      return id === undefined ? [] : [[id, entry] as const];
    }),
  );
  const chain: Record<string, unknown>[] = [];
  let current = candidates.at(-1);
  while (current !== undefined) {
    if (include(current)) chain.push(current);
    const parent = string(current[parentKey]);
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
function dedupeTools(entries: readonly HerdrTranscriptEntry[]): HerdrTranscriptEntry[] {
  const seen = new Set<string>();
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
