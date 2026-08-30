import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { redactSensitiveText } from "@clankie/observability";
import { OPERATOR_CONVERSATION_TEXT_MAX } from "@clankie/protocol";

export interface HerdrAgentSession {
  readonly source: string;
  readonly kind: "id" | "path";
  readonly value: string;
}

export interface HerdrTranscriptMessage {
  readonly id: string;
  readonly role: "operator" | "agent";
  readonly text: string;
  readonly occurredAt?: string;
}

export interface HerdrSeatTranscript {
  readonly sessionKey: string;
  readonly messages: readonly HerdrTranscriptMessage[];
}

// ponytail: the app replays at most 10k events; raise both ceilings together if real sessions exceed this.
const MAX_MESSAGES = 9_000;

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
  const messages = parseHerdrSeatTranscript(agent, readFileSync(path, "utf8"));
  return {
    sessionKey: `${resolvedSession.source}:${resolvedSession.kind}:${resolvedSession.value}`,
    messages: messages.slice(-MAX_MESSAGES),
  };
}

/** Normalize only the user/assistant words the harness TUI renders as chat. */
export function parseHerdrSeatTranscript(agent: string, jsonl: string): HerdrTranscriptMessage[] {
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
  if (agent === "codex") return codexMessages(entries);
  if (agent === "claude") return claudeMessages(entries);
  if (agent === "pi") return piMessages(entries);
  if (agent === "grok") return grokMessages(entries);
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

function codexMessages(entries: readonly Record<string, unknown>[]): HerdrTranscriptMessage[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "response_item") return [];
    const payload = record(entry.payload);
    if (payload?.type !== "message") return [];
    const role = payload.role;
    if (role !== "user" && role !== "assistant") return [];
    const content = array(payload.content).filter(isRecord);
    let text: string;
    if (role === "user") {
      const kinds = array(record(payload.internal_chat_message_metadata_passthrough)?.content_item_kinds);
      text = content
        .flatMap((item, index) => (kinds[index] === "user.text" ? [string(item.text) ?? ""] : []))
        .join("\n");
    } else {
      text = content
        .flatMap((item) => (item.type === "output_text" ? [string(item.text) ?? ""] : []))
        .join("\n");
    }
    const clean = cleanText(text);
    if (clean === undefined) return [];
    return [
      {
        id: `codex:${string(payload.id) ?? string(record(payload.internal_chat_message_metadata_passthrough)?.turn_id) ?? String(entries.indexOf(entry))}`,
        role: role === "user" ? ("operator" as const) : ("agent" as const),
        text: clean,
        ...timestamp(entry, record(payload.internal_chat_message_metadata_passthrough)?.create_time),
      },
    ];
  });
}

function claudeMessages(entries: readonly Record<string, unknown>[]): HerdrTranscriptMessage[] {
  const chain = activeChain(
    entries,
    "uuid",
    "parentUuid",
    (entry) => (entry.type === "user" || entry.type === "assistant") && entry.isSidechain !== true,
  );
  return chain.flatMap((entry) => {
    if (entry.isMeta === true || entry.promptSource === "system") return [];
    const message = record(entry.message);
    if (message === undefined) return [];
    if (
      entry.type === "user" &&
      (entry.sourceToolAssistantUUID !== undefined ||
        entry.toolUseResult !== undefined ||
        entry.sourceToolUseID !== undefined)
    )
      return [];
    const text = messageText(message.content);
    if (/^<(?:local-command-|command-name>|system-reminder>)/u.test(text.trimStart())) return [];
    const clean = cleanText(text);
    if (clean === undefined) return [];
    return [
      {
        id: `claude:${string(entry.uuid) ?? String(entries.indexOf(entry))}`,
        role: entry.type === "user" ? ("operator" as const) : ("agent" as const),
        text: clean,
        ...timestamp(entry),
      },
    ];
  });
}

function piMessages(entries: readonly Record<string, unknown>[]): HerdrTranscriptMessage[] {
  const chain = activeChain(entries, "id", "parentId", (entry) => entry.type === "message");
  return chain.flatMap((entry) => {
    const message = record(entry.message);
    if (message?.role !== "user" && message?.role !== "assistant") return [];
    const clean = cleanText(messageText(message.content));
    if (clean === undefined) return [];
    return [
      {
        id: `pi:${string(entry.id) ?? String(entries.indexOf(entry))}`,
        role: message.role === "user" ? ("operator" as const) : ("agent" as const),
        text: clean,
        ...timestamp(entry, message.timestamp),
      },
    ];
  });
}

function grokMessages(entries: readonly Record<string, unknown>[]): HerdrTranscriptMessage[] {
  return entries.flatMap((entry, index) => {
    if (entry.type !== "user" && entry.type !== "assistant") return [];
    if (entry.type === "user" && typeof entry.prompt_index !== "number") return [];
    const text = typeof entry.content === "string" ? entry.content : messageText(entry.content);
    const clean = cleanText(text);
    if (clean === undefined) return [];
    return [
      {
        id: `grok:${index}`,
        role: entry.type === "user" ? ("operator" as const) : ("agent" as const),
        text: clean,
        ...timestamp(entry),
      },
    ];
  });
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
