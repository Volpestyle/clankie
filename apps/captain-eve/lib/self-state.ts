import type { ClankieApiClient } from "@clankie/api-client";
import type { CaptainSessionLaneV2, EmbodimentSession } from "@clankie/protocol";
import type { CaptainLaneSnapshot } from "@clankie/captain-runtime";
import { controlPlaneClient } from "./client.ts";
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
/** "Were you just in VC?" deserves an answer for longer than a live room lingers. */
const RECENT_VOICE_WINDOW_MS = 60 * 60 * 1000;

export interface CaptainRoom {
  readonly lane: CaptainSessionLaneV2;
  readonly targetId: string;
  /**
   * Human-readable name for the room ("Vuhlp — General (with James)") when a
   * source supplies one; the id stays the stable authority.
   */
  readonly label?: string;
  /** True for the room this turn is happening in. */
  readonly here: boolean;
  readonly active: boolean;
  readonly updatedAt: string;
}

/** One voice channel he recently left: place, company, and when it ended. */
export interface CaptainRecentVoiceStay {
  readonly label: string;
  readonly leftAt: string;
}

export interface CaptainSelfState {
  readonly rooms: readonly CaptainRoom[];
  readonly truncated: number;
  /** Rooms he was in within the recent-voice window but is not in now. */
  readonly recentVoice: readonly CaptainRecentVoiceStay[];
}

/**
 * Where Clankie currently is — and just was — across every lane.
 *
 * Six sources (ADR 0054): the operator conversation registry, the captain
 * lane registry, the live asked-play session (ADR 0063), the bridge-owned
 * Discord presence sessions with their named voice rooms (VUH-939), the body
 * lock's current holder (VUH-938), and recently completed voice stays
 * (VUH-940). The presence sources are what tell him his body is in a voice
 * channel — or was, and with whom — even when no captain turn ever flowed
 * through that lane.
 *
 * This is his own presence, not another lane's content: it is built from lane
 * *addresses, liveness, and room names* only. Continuation tokens are
 * structurally absent — `CaptainLaneRegistry.list()` returns
 * {@link CaptainLaneSnapshot}, which has no token field, and the operator
 * registry's public record has none either — so there is no path from this
 * projection back to another lane's session, and no transcript ever crosses it.
 */
export async function captainSelfState(
  channel?: EveChannelLaneContext,
  now: Date = new Date(),
): Promise<CaptainSelfState> {
  const runtime = await captainLaneRuntime();
  const [embodiment, presence, possession, voiceHistory] = await Promise.all([
    boundedControlPlaneRead("embodiment", (client) => client.getLiveEmbodimentSession()),
    boundedControlPlaneRead("discord_presence", (client) => client.listDiscordPresenceSessions()),
    boundedControlPlaneRead("possession", (client) => client.getBodyPossession()),
    boundedControlPlaneRead("voice_history", (client) => client.listDiscordVoiceHistory(3)),
  ]);
  return projectCaptainSelfState({
    conversations: runtime.conversations.list(),
    lanes: runtime.registry.list(),
    // Tool executors receive the AI SDK's options, not the eve session context,
    // so `get_self_state` cannot say which room it is being called from. It
    // still reports every room; only the "you are here" marker needs a channel.
    ...(channel === undefined ? {} : { here: currentRoom(channel) }),
    ...(embodiment === undefined ? {} : { embodiment }),
    ...(presence === undefined ? {} : { presence }),
    ...(possession === undefined ? {} : { possession }),
    ...(voiceHistory === undefined ? {} : { voiceHistory }),
    now,
  });
}

/**
 * The asked-play session (ADR 0063) and the bridge-owned Discord presence
 * sessions (ADR 0024) are control-plane state, not lane rows, so his own
 * whereabouts there are read back from the control plane. Bounded and
 * fail-open: a slow or absent control plane costs at most the race timeout
 * and never the turn — but never silently. A swallowed failure here is a room
 * missing from "Where you are" with nothing to distinguish it from an empty
 * registry, so every miss writes one bounded line.
 */
const CONTROL_PLANE_READ_TIMED_OUT = Symbol("control_plane_read_timed_out");

async function boundedControlPlaneRead<T>(
  source: string,
  read: (client: ClankieApiClient) => Promise<T>,
): Promise<T | undefined> {
  try {
    const result = await Promise.race([
      read(controlPlaneClient()),
      new Promise<typeof CONTROL_PLANE_READ_TIMED_OUT>((settle) => {
        const timer = setTimeout(() => {
          settle(CONTROL_PLANE_READ_TIMED_OUT);
        }, 1_500);
        timer.unref?.();
      }),
    ]);
    if (result === CONTROL_PLANE_READ_TIMED_OUT) {
      reportSelfStateSourceMiss(source, "Timeout");
      return undefined;
    }
    return result;
  } catch (error) {
    reportSelfStateSourceMiss(source, error instanceof Error ? error.name.slice(0, 64) : "Error");
    return undefined;
  }
}

/** Bounded, safe, non-fatal line. Never the raw error, which could echo response bodies. */
function reportSelfStateSourceMiss(source: string, errorName: string): void {
  process.stderr.write(
    `${JSON.stringify({
      service: "captain-eve",
      event: `captain_self_state.${source}_read_failed`,
      errorName,
    })}\n`,
  );
}

export interface CaptainSelfStateInput {
  readonly conversations: readonly {
    readonly conversationId: string;
    readonly sessionState: string;
    readonly updatedAt: string;
  }[];
  readonly lanes: readonly CaptainLaneSnapshot[];
  readonly here?: { readonly lane: CaptainSessionLaneV2; readonly targetId: string | undefined };
  /** The live asked-play session, when one exists (ADR 0063). */
  readonly embodiment?: EmbodimentSession;
  /**
   * Current holder of the body lock (VUH-938). Sees every suitor, including
   * an MCP possessor no embodiment session ever recorded (ADR 0053).
   */
  readonly possession?: { readonly holderId: string; readonly acquiredAt: string };
  /**
   * Recently completed voice stays (VUH-940), newest first, from the control
   * plane's read-side projection of the durable phase stream.
   */
  readonly voiceHistory?: readonly {
    readonly guildId: string;
    readonly guildName?: string | undefined;
    readonly channelName?: string | undefined;
    readonly occupants: readonly { readonly userId: string; readonly displayName: string }[];
    readonly leftAt: string;
  }[];
  /**
   * Bridge-owned Discord presence sessions, read from the control plane.
   * Structurally minimal on purpose, like the lane source: the projection
   * receives addresses, liveness, and room names only, so `credentialRef` and
   * every other session field stay behind even when full records are passed.
   */
  readonly presence?: readonly {
    readonly sessionId: string;
    readonly phase: string;
    readonly voiceGuildIds: readonly string[];
    readonly voiceRooms?:
      | readonly {
          readonly guildId: string;
          readonly guildName?: string | undefined;
          readonly channelId?: string | undefined;
          readonly channelName?: string | undefined;
          readonly occupants: readonly { readonly userId: string; readonly displayName: string }[];
        }[]
      | undefined;
    readonly updatedAt: string;
  }[];
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

  if (input.embodiment !== undefined) {
    const terminal = ["stopped", "refused", "failed"].includes(input.embodiment.state);
    rooms.push({
      lane: "gameplay",
      targetId: input.embodiment.environmentId,
      here: false,
      active: !terminal,
      updatedAt: input.embodiment.updatedAt,
    });
  }

  // The body lock sees every suitor (ADR 0053): a possessor drives his body
  // even when no embodiment session was ever minted. The runner's own
  // asked-play hold is the embodiment room above wearing its lock id, so it
  // is not reported twice.
  if (input.possession !== undefined && !input.possession.holderId.startsWith("captain-play:")) {
    rooms.push({
      lane: "gameplay",
      targetId: "gba-body",
      label: `GBA body — driven by ${input.possession.holderId.replace(/^gba-mcp:/u, "")}`,
      here: false,
      active: true,
      updatedAt: input.possession.acquiredAt,
    });
  }

  // The body in a Discord voice channel is the bridge's realtime agent, not a
  // captain lane (ADR 0056/0057): no lane row exists until a handoff turn
  // flows, so his whereabouts there come from the presence session. Only
  // connected phases are rooms — "where you are" has no entry for a session
  // that is off, connecting, degraded, or failed. A handoff can add a lane row
  // for the same voice channel; both rows are true and neither suppresses the
  // other, because the lane row settles while he is still in the channel.
  for (const session of input.presence ?? []) {
    if (session.phase === "present") {
      rooms.push(presenceRoom("discord_presence", session.sessionId, session.updatedAt, here));
    }
    if (session.phase !== "voice_active" && session.phase !== "go_live_active") continue;
    const targets = session.voiceGuildIds.length > 0 ? session.voiceGuildIds : [session.sessionId];
    for (const targetId of targets) {
      const named = session.voiceRooms?.find((room) => room.guildId === targetId);
      rooms.push(
        presenceRoom(
          "discord_voice",
          targetId,
          session.updatedAt,
          here,
          named === undefined ? undefined : voiceRoomLabel(named),
        ),
      );
    }
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

  // "Were you just in VC?" outlives the room: a stay he left inside the
  // recent-voice window stays visible, with the company captured at join
  // time. A guild he is back inside is a live room, not history.
  const liveVoiceTargets = new Set(
    rooms.filter((room) => room.lane === "discord_voice" && room.active).map((room) => room.targetId),
  );
  const recentVoice = (input.voiceHistory ?? [])
    .filter(
      (stay) => !liveVoiceTargets.has(stay.guildId) && isRecent(stay.leftAt, now, RECENT_VOICE_WINDOW_MS),
    )
    .map((stay) => ({ label: voiceRoomLabel(stay), leftAt: stay.leftAt }));

  return {
    rooms: ranked.slice(0, MAX_ROOMS),
    truncated: Math.max(0, ranked.length - MAX_ROOMS),
    recentVoice,
  };
}

/**
 * The always-on awareness line. It answers "where else am I right now" without
 * costing a tool call, which is the whole point: a question like "did you just
 * join Discord?" arrives mid-conversation and a model that has to decide to go
 * look will usually just say it cannot know.
 *
 * Live rooms render as "open right now", never as a bare timestamp: shown
 * "last active <three minutes ago>" for a voice channel he was sitting in, he
 * read his own presence as history and answered "not in it now".
 */
export function renderCaptainSelfState(state: CaptainSelfState): string {
  const recent = state.recentVoice.map(
    (stay) => `- Discord voice · ${stay.label} · you left at ${stay.leftAt} — not in it anymore`,
  );
  if (state.rooms.length === 0 && recent.length === 0) {
    return ["# Where you are", "This is your only open room right now."].join("\n\n");
  }
  const lines = state.rooms.map((room) => {
    const when = room.active
      ? `open right now — last update ${room.updatedAt}`
      : `last active ${room.updatedAt} (settled)`;
    const suffix = room.here ? " — you are here" : "";
    return `- ${LANE_LABEL[room.lane]} · ${room.label ?? room.targetId} · ${when}${suffix}`;
  });
  if (state.truncated > 0) lines.push(`- …and ${String(state.truncated)} more not shown`);
  lines.push(...recent);
  return [
    "# Where you are",
    'Your own open rooms across every surface. A room marked "open right now" is one you are in at this moment — answer presence questions about it in the present tense, the way a person says where they are, never by citing "my presence" or this card. A "you left" line is your own recent whereabouts, company included. This is your presence, not their contents — you still have no access to another room\'s transcript.',
    lines.join("\n"),
  ].join("\n\n");
}

/**
 * Fails open to silence. An instruction hook that throws does not degrade the
 * turn, it ends it: eve retries the step and then fails the session, so a
 * Discord message gets no reply at all. `captainLaneKind` throws on a channel
 * kind it does not recognise and the registry can fail to open, neither of which
 * is worth losing an answer over — he simply does not mention where he is.
 */
export async function captainSelfStateInstructions(channel: EveChannelLaneContext): Promise<string> {
  try {
    return renderCaptainSelfState(await captainSelfState(channel));
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        service: "captain-eve",
        event: "captain_self_state.projection_failed",
        errorName: error instanceof Error ? error.name.slice(0, 64) : "Error",
      })}\n`,
    );
    return "";
  }
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

/** A connected presence session is a live room by definition. */
function presenceRoom(
  lane: CaptainSessionLaneV2,
  targetId: string,
  updatedAt: string,
  here: CaptainSelfStateInput["here"],
  label?: string,
): CaptainRoom {
  return {
    lane,
    targetId,
    ...(label === undefined ? {} : { label }),
    here: here?.lane === lane && (here.targetId === undefined || here.targetId === targetId),
    active: true,
    updatedAt,
  };
}

const VOICE_ROOM_LABEL_OCCUPANTS_MAX = 5;

/** "Vuhlp — General (with James, Sam +2 more)": place first, people second. */
export function voiceRoomLabel(room: {
  readonly guildId: string;
  readonly guildName?: string | undefined;
  readonly channelName?: string | undefined;
  readonly occupants: readonly { readonly displayName: string }[];
}): string {
  const place = [room.guildName ?? room.guildId, room.channelName]
    .filter((part): part is string => part !== undefined)
    .join(" — ");
  if (room.occupants.length === 0) return place;
  const shown = room.occupants.slice(0, VOICE_ROOM_LABEL_OCCUPANTS_MAX).map((o) => o.displayName);
  const extra = room.occupants.length - shown.length;
  return `${place} (with ${shown.join(", ")}${extra > 0 ? ` +${String(extra)} more` : ""})`;
}

function normalizeLane(snapshot: CaptainLaneSnapshot): CaptainSessionLaneV2 {
  return snapshot.lane === "tui" ? "operator" : snapshot.lane;
}

function isRecent(updatedAt: string, now: Date, windowMs: number = RECENT_WINDOW_MS): boolean {
  const at = Date.parse(updatedAt);
  return Number.isFinite(at) && now.getTime() - at <= windowMs;
}
