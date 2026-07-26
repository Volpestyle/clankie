import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import type { CaptainLaneSnapshot } from "@clankie/captain-runtime";
import { captainLaneKind, type EveChannelLaneContext } from "./lanes/context.ts";
import { captainLaneRuntime } from "./lanes/runtime.ts";

/**
 * How many rooms he is told about. Well above the number of surfaces a person
 * actually runs at once, and low enough that the summary stays a glance rather
 * than a second context budget.
 */
const MAX_ROOMS = 24;
/** A room stops being "now" well before its lane row is cleaned up. */
const RECENT_WINDOW_MS = 5 * 60 * 1000;

export interface CaptainRoom {
  readonly lane: CaptainSessionLaneV2;
  readonly targetId: string;
  /** True for the room this turn is happening in. */
  readonly here: boolean;
  readonly active: boolean;
  readonly updatedAt: string;
}

export interface CaptainSelfState {
  readonly rooms: readonly CaptainRoom[];
  readonly truncated: number;
}

/**
 * Where Clankie currently is, across every lane.
 *
 * This is his own presence, not another lane's content: it is built from lane
 * *addresses and liveness* only. Continuation tokens are structurally absent —
 * `CaptainLaneRegistry.list()` returns {@link CaptainLaneSnapshot}, which has no
 * token field, and the operator registry's public record has none either — so
 * there is no path from this projection back to another lane's session, and no
 * transcript ever crosses it.
 */
export async function captainSelfState(
  channel?: EveChannelLaneContext,
  now: Date = new Date(),
): Promise<CaptainSelfState> {
  const runtime = await captainLaneRuntime();
  return projectCaptainSelfState({
    conversations: runtime.conversations.list(),
    lanes: runtime.registry.list(),
    // Tool executors receive the AI SDK's options, not the eve session context,
    // so `get_self_state` cannot say which room it is being called from. It
    // still reports every room; only the "you are here" marker needs a channel.
    ...(channel === undefined ? {} : { here: currentRoom(channel) }),
    now,
  });
}

export interface CaptainSelfStateInput {
  readonly conversations: readonly {
    readonly conversationId: string;
    readonly sessionState: string;
    readonly updatedAt: string;
  }[];
  readonly lanes: readonly CaptainLaneSnapshot[];
  readonly here?: { readonly lane: CaptainSessionLaneV2; readonly targetId: string | undefined };
  readonly now: Date;
}

/** Injectable core: production and registry-free tests share the exact projection. */
export function projectCaptainSelfState(input: CaptainSelfStateInput): CaptainSelfState {
  const { here, now } = input;
  const rooms: CaptainRoom[] = [];

  // Operator conversations are their own registry (ADR 0032): the conversation,
  // not the device, is the unit of captain identity, so a lane row never
  // represents them.
  for (const conversation of input.conversations) {
    rooms.push({
      lane: "operator",
      targetId: conversation.conversationId,
      here: here?.lane === "operator" && here.targetId === conversation.conversationId,
      active: conversation.sessionState === "active" || conversation.sessionState === "waiting",
      updatedAt: conversation.updatedAt,
    });
  }

  for (const snapshot of input.lanes) {
    const lane = normalizeLane(snapshot);
    // Legacy `tui` rows predate ADR 0032 and would double-count a conversation
    // that the operator registry already reported.
    if (lane === "operator") continue;
    rooms.push({
      lane,
      targetId: snapshot.targetId,
      here: here?.lane === lane && (here.targetId === undefined || here.targetId === snapshot.targetId),
      active: snapshot.state === "active" || snapshot.state === "waiting",
      updatedAt: snapshot.updatedAt,
    });
  }

  const ranked = rooms
    .filter((room) => room.active || room.here || isRecent(room.updatedAt, now))
    .sort((left, right) => (left.here ? -1 : right.here ? 1 : right.updatedAt.localeCompare(left.updatedAt)));
  return { rooms: ranked.slice(0, MAX_ROOMS), truncated: Math.max(0, ranked.length - MAX_ROOMS) };
}

/**
 * The always-on awareness line. It answers "where else am I right now" without
 * costing a tool call, which is the whole point: a question like "did you just
 * join Discord?" arrives mid-conversation and a model that has to decide to go
 * look will usually just say it cannot know.
 */
export function renderCaptainSelfState(state: CaptainSelfState): string {
  if (state.rooms.length === 0) {
    return ["# Where you are", "This is your only open room right now."].join("\n\n");
  }
  const lines = state.rooms.map((room) => {
    const suffix = room.here ? " — you are here" : room.active ? "" : " (settled)";
    return `- ${LANE_LABEL[room.lane]} · ${room.targetId} · last active ${room.updatedAt}${suffix}`;
  });
  if (state.truncated > 0) lines.push(`- …and ${String(state.truncated)} more not shown`);
  return [
    "# Where you are",
    "Your own open rooms across every surface. This is your presence, not their contents — you can say where you are and when you were last active there, and you still have no access to another room's transcript.",
    lines.join("\n"),
  ].join("\n\n");
}

export async function captainSelfStateInstructions(channel: EveChannelLaneContext): Promise<string> {
  return renderCaptainSelfState(await captainSelfState(channel));
}

const LANE_LABEL: Readonly<Record<CaptainSessionLaneV2, string>> = {
  operator: "Operator conversation",
  discord_voice: "Discord voice",
  discord_presence: "Discord text",
  gameplay: "Gameplay",
};

/**
 * The room this turn is in, resolved the hook-safe way.
 *
 * `captainLaneAddress` throws for any non-operator lane whose `ctx.channel`
 * carries no `captainTargetId`, and lifecycle-hook channels frequently do not
 * (see the note on {@link captainLaneKind}). An instruction hook that throws
 * takes the whole turn down, so this reads the target defensively and settles
 * for the lane alone when it is absent.
 */
function currentRoom(channel: EveChannelLaneContext): {
  readonly lane: CaptainSessionLaneV2;
  readonly targetId: string | undefined;
} {
  const target = channel.metadata?.captainTargetId;
  return {
    lane: captainLaneKind(channel),
    targetId: typeof target === "string" && target.trim().length > 0 ? target.trim() : undefined,
  };
}

function normalizeLane(snapshot: CaptainLaneSnapshot): CaptainSessionLaneV2 {
  return snapshot.lane === "tui" ? "operator" : snapshot.lane;
}

function isRecent(updatedAt: string, now: Date): boolean {
  const at = Date.parse(updatedAt);
  return Number.isFinite(at) && now.getTime() - at <= RECENT_WINDOW_MS;
}
