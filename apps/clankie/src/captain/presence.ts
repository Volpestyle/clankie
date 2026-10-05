import { createHash } from "node:crypto";
import { readClaudeSubagents, readCodexSubagents } from "@clankie/agent-transcript";
import type { ObservedHeadSeat } from "./herdr-census.ts";
import type { OperatorPresenceSnapshot } from "@clankie/protocol/presence";

export interface PresenceSources {
  expression?: OperatorPresenceSnapshot["expression"];
  thinking: boolean;
  /** A live native captain/child can work outside Pi's loaded lanes. */
  working?: boolean;
  voiceSince?: string;
  inVoice: boolean;
  playingSince?: string;
  playing: boolean;
  activeSeats: number;
  nativeSubagents?: number;
  pendingOwnerItem?: OperatorPresenceSnapshot["pendingOwnerItem"];
  newMessage?: boolean;
  error?: boolean;
}

/** Pure projection: no persisted presence state or invented transition time. */
export function projectPresence(sources: PresenceSources, includeFace = true): OperatorPresenceSnapshot {
  const { activeSeats, pendingOwnerItem } = sources;
  const [mood, detail, since] = pendingOwnerItem
    ? (["needs_you", pendingOwnerItem.title, pendingOwnerItem.since] as const)
    : sources.thinking
      ? (["thinking", "Thinking", null] as const)
      : sources.inVoice
        ? (["in_voice", "In a voice chat", sources.voiceSince ?? null] as const)
        : sources.playing
          ? (["playing", "Playing", sources.playingSince ?? null] as const)
          : activeSeats > 0
            ? ([
                "leading",
                `With ${String(activeSeats)} ${activeSeats === 1 ? "agent" : "agents"}`,
                null,
              ] as const)
            : (["idle", "Taking a break", null] as const);
  const face: OperatorPresenceSnapshot["face"] = pendingOwnerItem
    ? "needs_you"
    : sources.error
      ? "error"
      : sources.newMessage
        ? "new_message"
        : sources.working || mood === "thinking"
          ? "working"
          : mood === "in_voice"
            ? "voice"
            : mood === "leading"
              ? "working"
              : undefined;
  const projection = {
    schemaVersion: 1 as const,
    mood,
    ...(!includeFace || face === undefined ? {} : { face }),
    detail,
    since,
    activeSeats,
    ...(sources.nativeSubagents === undefined ? {} : { nativeSubagents: sources.nativeSubagents }),
    ...(pendingOwnerItem === undefined ? {} : { pendingOwnerItem }),
    ...(sources.expression === undefined ? {} : { expression: sources.expression }),
  };
  return { ...projection, cursor: createHash("sha256").update(JSON.stringify(projection)).digest("hex") };
}

/** Changes without native notifications are sampled within half a second. */
export async function pollPresence(
  read: () => Promise<OperatorPresenceSnapshot>,
  cursor?: string,
  waitMs = 0,
  signal?: AbortSignal,
): Promise<OperatorPresenceSnapshot> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted();
    const snapshot = await read();
    if (snapshot.cursor !== cursor || Date.now() >= deadline) return snapshot;
    const { setTimeout } = await import("node:timers/promises");
    await setTimeout(Math.min(500, deadline - Date.now()), undefined, { signal });
  }
}

/** Read all loaded captain lanes, including Discord rooms; do not await model setup. */
export async function captainIsThinking(
  lanes: Iterable<
    Promise<{
      running?: unknown;
      starting?: unknown;
      session: { isStreaming: boolean };
    }>
  >,
): Promise<boolean> {
  const active = await Promise.all(
    [...lanes].map(async (pending) => {
      const lane = await Promise.race([pending, Promise.resolve(undefined)]);
      return (
        lane !== undefined &&
        (lane.running !== undefined || lane.starting !== undefined || lane.session.isStreaming)
      );
    }),
  );
  return active.some(Boolean);
}

/** Read only the live local captain parent, never a worker or cached fleet count. */
export async function captainNativeSubagents(
  head: Pick<ObservedHeadSeat, "harness" | "session"> | undefined,
  readOpenCode?: (ref: string) => Promise<{ running: number } | undefined>,
): Promise<number | undefined> {
  if (head?.session === undefined) return undefined;
  try {
    if (head.harness === "claude") return readClaudeSubagents(head.session)?.running;
    if (head.harness === "codex") return readCodexSubagents(head.session)?.running;
    if (head.harness === "opencode" && head.session.kind === "id")
      return (await readOpenCode?.(`local:${head.session.value}`))?.running;
  } catch {
    // Unreadable parent data is unknown, never an invented zero.
  }
  return undefined;
}
