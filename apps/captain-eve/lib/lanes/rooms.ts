/**
 * Looking in on a room he is not currently talking in (ADR 0084).
 *
 * Every room Clankie answers in — each Discord server and channel, voice,
 * gameplay, every operator conversation — is its own durable Eve session
 * ([ADR 0032](../../../../docs/adr/0032-conversation-scoped-operator-lanes.md)).
 * ADR 0083 gave the *console* a render-only tail of any of them. This gives the
 * same reach to Clankie himself, from the operator seat: the head can read what
 * his branches did instead of answering "I can't see that room from here".
 *
 * Two reads compose it, both already authoritative:
 *
 * 1. the lane registry — which durable sessions a room has run, newest first;
 * 2. the public loopback session stream — what happened inside one of them.
 *
 * It is a read and only a read. The registry hands back session *identity*
 * (`CaptainLaneSessionRecord` has no continuation-token field, and historical
 * sessions never store one), and nothing here posts a turn, so looking into a
 * room can never become speaking in it.
 */
import { Client } from "eve/client";
import type { HandleMessageStreamEvent } from "eve/client";
import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import { captainLaneRuntime } from "./runtime.ts";

/** His own eve, reached the way every other client in this repo reaches it. */
function captainEveUrl(): string {
  return process.env.CLANKIE_CAPTAIN_URL?.trim() || "http://127.0.0.1:4321";
}

/**
 * How far back into one session to read. Negative indices are tail-relative, so
 * this is "the last N events of that session" — a voice room that has been open
 * all day is bounded to its recent past rather than replayed from the start.
 */
const SESSION_TAIL_EVENTS = 600;
/** Sessions consulted per look. A Discord text room spends one per message. */
const MAX_SESSIONS_PER_ROOM = 24;
/** Rendered entries returned. Well past "what did you just do", short of a dump. */
const DEFAULT_MAX_ENTRIES = 40;
export const MAX_ENTRIES_CEILING = 120;
/** A live session's stream never ends on its own; the read is bounded by both. */
const SESSION_READ_TIMEOUT_MS = 4_000;
/**
 * Ceiling across every session consulted for one look. A room with two dozen
 * past sessions must not be able to spend two dozen session timeouts: the
 * operator asked a question mid-conversation, and a slow answer is worse than
 * a partial one.
 */
const ROOM_READ_BUDGET_MS = 10_000;

const MESSAGE_MAX = 1_200;
const ARGUMENTS_MAX = 300;
const RESULT_MAX = 300;

export interface CaptainRoom {
  /** `discord_presence:123:456` — the address `/trace` uses, and what this tool takes. */
  readonly key: string;
  readonly lane: CaptainSessionLaneV2;
  readonly targetId: string;
  readonly state: string;
  readonly updatedAt: string;
  /** Durable sessions this room has run, newest first. */
  readonly sessionIds: readonly string[];
}

/** `lane:targetId`, matching the console's `/trace` addressing. */
function roomKey(lane: CaptainSessionLaneV2, targetId: string): string {
  return `${lane}:${targetId}`;
}

function normalizeLane(lane: string): CaptainSessionLaneV2 {
  return (lane === "tui" ? "operator" : lane) as CaptainSessionLaneV2;
}

/**
 * Every room that has run a turn, newest first.
 *
 * Operator conversations live in their own registry (ADR 0032), so they are
 * read from there rather than from a lane row; every other room is a lane. A
 * conversation retains its session across turns, so its current session id is
 * its whole readable past — a lane that rotates per message keeps a history.
 */
export async function captainRooms(): Promise<readonly CaptainRoom[]> {
  const runtime = await captainLaneRuntime();
  const rooms: CaptainRoom[] = [];
  for (const conversation of runtime.conversations.list()) {
    const sessionId = runtime.conversations.privateSession(conversation.conversationId).sessionId;
    rooms.push({
      key: roomKey("operator", conversation.conversationId),
      lane: "operator",
      targetId: conversation.conversationId,
      state: conversation.sessionState,
      updatedAt: conversation.updatedAt,
      sessionIds: sessionId === undefined ? [] : [sessionId],
    });
  }
  for (const lane of runtime.registry.list()) {
    // Legacy `tui` rows predate ADR 0032 and would double-count a conversation
    // the operator registry has already reported.
    if (normalizeLane(lane.lane) === "operator") continue;
    rooms.push({
      key: roomKey(normalizeLane(lane.lane), lane.targetId),
      lane: normalizeLane(lane.lane),
      targetId: lane.targetId,
      state: lane.state,
      updatedAt: lane.updatedAt,
      sessionIds: runtime.registry
        .sessionsForKey(lane.key, MAX_SESSIONS_PER_ROOM)
        .map((session) => session.sessionId),
    });
  }
  return rooms.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Resolves what he typed against the live room list: an exact key, a bare
 * target id, a whole lane (its most recently active room), or a substring, so a
 * guild id or a channel name fragment is enough to name a room.
 */
export function selectRoom(rooms: readonly CaptainRoom[], query: string): CaptainRoom | undefined {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  return (
    rooms.find((room) => room.key.toLowerCase() === needle) ??
    rooms.find((room) => room.targetId.toLowerCase() === needle) ??
    rooms.find((room) => room.lane.toLowerCase() === needle) ??
    rooms.find((room) => room.key.toLowerCase().includes(needle))
  );
}

/** One thing he did in that room. */
export interface RoomEntry {
  readonly kind: "said" | "tool" | "tool_result" | "turn";
  readonly text: string;
}

export interface RoomReading {
  readonly room: string;
  readonly lane: CaptainSessionLaneV2;
  readonly sessionsRead: number;
  readonly entries: readonly RoomEntry[];
  /** Stated, never inferred from an empty list. */
  readonly note: string;
}

/**
 * The slice of `eve/client`'s {@link Client} this needs: open one durable
 * session's event stream. Structural so a test can supply a stream without a
 * server, and narrow so nothing here can send a turn.
 */
export interface CaptainSessionStreamReader {
  session(state: { readonly sessionId: string; readonly streamIndex: number }): {
    stream(options: {
      readonly startIndex: number;
      readonly signal: AbortSignal;
    }): AsyncIterable<HandleMessageStreamEvent>;
  };
}

export interface ReadRoomOptions {
  readonly maxEntries?: number;
  readonly client?: CaptainSessionStreamReader;
  readonly rooms?: readonly CaptainRoom[];
  /** Total wall clock for the whole look. Clamped to {@link ROOM_READ_BUDGET_MS}. */
  readonly timeBudgetMs?: number;
}

export class UnknownCaptainRoomError extends Error {
  public readonly rooms: readonly CaptainRoom[];
  public constructor(query: string, rooms: readonly CaptainRoom[]) {
    super(`No room of yours matches ${JSON.stringify(query)}`);
    this.name = "UnknownCaptainRoomError";
    this.rooms = rooms;
  }
}

/**
 * What he did in one room, newest session first.
 *
 * Sessions are walked newest-first and each is rendered oldest-first inside
 * itself, so the result reads forward within a turn while the most recent turn
 * comes first — which is the order the question ("did you just…") is asked in.
 */
export async function readCaptainRoom(query: string, options: ReadRoomOptions = {}): Promise<RoomReading> {
  const rooms = options.rooms ?? (await captainRooms());
  const room = selectRoom(rooms, query);
  if (room === undefined) throw new UnknownCaptainRoomError(query, rooms);
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? DEFAULT_MAX_ENTRIES, MAX_ENTRIES_CEILING));
  const client = options.client ?? new Client({ host: captainEveUrl() });

  const entries: RoomEntry[] = [];
  let sessionsRead = 0;
  const deadline =
    Date.now() + Math.max(1, Math.min(options.timeBudgetMs ?? ROOM_READ_BUDGET_MS, ROOM_READ_BUDGET_MS));
  for (const sessionId of room.sessionIds) {
    if (entries.length >= maxEntries || Date.now() >= deadline) break;
    const events = await readSessionTail(client, sessionId, deadline);
    sessionsRead += 1;
    const rendered = events.flatMap(renderEvent);
    // Newest session first, but forward in time inside it.
    entries.push(...rendered.slice(-Math.max(1, maxEntries - entries.length)));
  }
  const partial = sessionsRead < room.sessionIds.length && entries.length < maxEntries;

  return {
    room: room.key,
    lane: room.lane,
    sessionsRead,
    entries: entries.slice(0, maxEntries),
    note:
      room.sessionIds.length === 0
        ? "That room has not run a turn yet, so there is nothing to read."
        : entries.length === 0
          ? "That room has run, but nothing of yours survives in the readable window."
          : `This is your own side of that room — what you said, the tools you called, and what they returned. It does not carry what other people said there.${partial ? " Its older turns were not read in time; say so rather than treating this as everything that happened." : ""}`,
  };
}

/**
 * Reads the tail of one durable session.
 *
 * A parked session's stream stays OPEN waiting for its next message, so this
 * cannot drain to end-of-stream: it stops at the session's own boundary event,
 * at the event ceiling, or at the timeout — whichever comes first. Draining
 * would hang the turn that asked.
 *
 * The timeout both aborts the stream and wins a race against it. Aborting alone
 * is only as good as the transport's willingness to honour the signal, and
 * "read what you did over there" is not worth a turn that never answers.
 */
async function readSessionTail(
  client: CaptainSessionStreamReader,
  sessionId: string,
  deadline: number,
): Promise<HandleMessageStreamEvent[]> {
  const controller = new AbortController();
  const budget = Math.max(0, Math.min(SESSION_READ_TIMEOUT_MS, deadline - Date.now()));
  const events: HandleMessageStreamEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((settle) => {
    timer = setTimeout(() => {
      controller.abort();
      settle();
    }, budget);
    timer.unref?.();
  });
  const drain = (async () => {
    for await (const event of client
      .session({ sessionId, streamIndex: 0 })
      .stream({ startIndex: -SESSION_TAIL_EVENTS, signal: controller.signal })) {
      events.push(event);
      if (events.length >= SESSION_TAIL_EVENTS) break;
      if (["session.waiting", "session.completed", "session.failed"].includes(event.type)) break;
    }
  })().catch(() => {
    // A session eve has already aged out, or a read that was cut short. Both
    // cost this room part of its past, never the turn that asked.
  });
  await Promise.race([drain, expiry]);
  clearTimeout(timer);
  controller.abort();
  return events;
}

/** His own side of one event, bounded. Reasoning is deliberately not carried. */
function renderEvent(event: HandleMessageStreamEvent): RoomEntry[] {
  switch (event.type) {
    case "message.completed": {
      const text = truncate(event.data.message ?? "", MESSAGE_MAX);
      return text.length === 0 ? [] : [{ kind: "said", text }];
    }
    case "actions.requested": {
      return event.data.actions.map((action) => {
        const record = action as Record<string, unknown>;
        const name = firstString(record.toolName, record.name) ?? "action";
        const args = truncate(safeJson(record.input ?? record.args ?? record.arguments), ARGUMENTS_MAX);
        return { kind: "tool" as const, text: args.length === 0 ? name : `${name} ${args}` };
      });
    }
    case "action.result": {
      const result = event.data.result as Record<string, unknown>;
      const name = firstString(result.toolName, result.name) ?? "action";
      const digest = truncate(safeJson(result.output ?? result.result ?? result.value), RESULT_MAX);
      const status = event.data.status === "completed" ? "returned" : String(event.data.status);
      return [{ kind: "tool_result", text: `${name} ${status}${digest.length === 0 ? "" : ` ${digest}`}` }];
    }
    case "session.failed":
      return [{ kind: "turn", text: "that turn failed" }];
    default:
      return [];
  }
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
