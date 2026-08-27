import {
  CaptainSessionLaneV2Schema,
  DiscordActivitySurfaceSchema,
  DiscordPresenceActionRequestSchema,
  DiscordPresenceActionSchema,
  DiscordTransportKindSchema,
  DISCORD_PRESENCE_ACTION_RISK_CLASS,
  type CaptainLane,
  type CaptainSessionLaneV2,
  type DiscordPresenceAction,
  type DiscordPresenceActionRequest,
  type DiscordTransportKind,
} from "@clankie/protocol";
import { z } from "zod";
import { INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION, type EnvironmentSessionPhase } from "./environment.ts";

export { DiscordPresenceActionRequestSchema, type DiscordPresenceActionRequest };

export const DISCORD_PRESENCE_ENVIRONMENT_KIND = "discord_presence" as const;

/**
 * Presence-plane session phases (ADR 0024). Distinct from environment
 * phases where useful (voice_active, go_live_active) while reusing off/starting/failed.
 */
export const DiscordPresenceSessionPhaseSchema = z.enum([
  "off",
  "connecting",
  "present",
  "voice_active",
  "go_live_active",
  "degraded",
  "failed",
]);
export type DiscordPresenceSessionPhase = z.infer<typeof DiscordPresenceSessionPhaseSchema>;

/** Authenticated bridge-to-service fence carrying immediate gateway truth. */
export const DISCORD_PRESENCE_LIVE_PHASE_HEADER = "x-clankie-discord-presence-phase" as const;
export const DISCORD_PRESENCE_LIVE_SESSION_HEADER = "x-clankie-discord-presence-session" as const;
export const DISCORD_PRESENCE_LIVE_REVISION_HEADER = "x-clankie-discord-presence-revision" as const;

export const DiscordPresenceLiveClaimSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    sessionId: z.string().min(1),
    phase: DiscordPresenceSessionPhaseSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type DiscordPresenceLiveClaim = z.infer<typeof DiscordPresenceLiveClaimSchema>;

/**
 * A rendered surface currently published into a voice channel (ADR 0047).
 *
 * Activity instances are a session *facet*, not a rung on
 * {@link DiscordPresenceSessionPhaseSchema}. A running activity and a running
 * Go Live stream are orthogonal — either, both, or neither may hold while the
 * session sits at `voice_active` — so ranking them against each other would
 * make "is an activity running" unanswerable whenever Go Live is also active.
 */
export const DiscordActivityInstanceSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    guildId: z.string().min(1),
    channelId: z.string().min(1),
    surface: DiscordActivitySurfaceSchema,
    startedAt: z.string().datetime(),
  })
  .strict();
export type DiscordActivityInstance = z.infer<typeof DiscordActivityInstanceSchema>;

export const DISCORD_ACTIVITY_INSTANCE_MAX = 8;

/**
 * One voice channel the session currently occupies, with the human-readable
 * context the ids alone cannot give: guild and channel display names plus who
 * is sharing the room. This is presence metadata about Clankie's own
 * whereabouts (ADR 0054) — names of a room he is standing in, never another
 * room's contents. Occupants exclude the session's own user, are sorted by
 * userId so record JSON stays byte-stable across replays, and are capped.
 *
 * Name fields are optional: the user-session transport observes raw gateway
 * ids only and publishes rooms without names.
 */
export const DiscordVoiceRoomOccupantSchema = z
  .object({
    userId: z.string().min(1),
    displayName: z.string().min(1).max(100),
  })
  .strict();
export type DiscordVoiceRoomOccupant = z.infer<typeof DiscordVoiceRoomOccupantSchema>;

export const DISCORD_VOICE_ROOM_OCCUPANT_MAX = 32;

export const DiscordVoiceRoomSchema = z
  .object({
    guildId: z.string().min(1),
    guildName: z.string().min(1).max(100).optional(),
    channelId: z.string().min(1).optional(),
    channelName: z.string().min(1).max(100).optional(),
    occupants: z.array(DiscordVoiceRoomOccupantSchema).max(DISCORD_VOICE_ROOM_OCCUPANT_MAX),
  })
  .strict();
export type DiscordVoiceRoom = z.infer<typeof DiscordVoiceRoomSchema>;

/**
 * How far into a server he can actually reach. Bots receive every guild
 * channel over the gateway regardless of view permission, so both the
 * channels he can see and the ones he cannot are nameable — membership alone
 * answers "are you in it?", this answers "which parts of it can you see?".
 * Threads and categories are excluded from the counts; names are sorted,
 * carried without the leading `#`, and capped with truncation counts so a
 * huge server stays a bounded record.
 */
export const DISCORD_GUILD_HIDDEN_CHANNEL_MAX = 32;
export const DISCORD_GUILD_VISIBLE_CHANNEL_MAX = 64;

export const DiscordGuildChannelAccessSchema = z
  .object({
    total: z.number().int().nonnegative(),
    viewable: z.number().int().nonnegative(),
    /** Names he can see. */
    visible: z.array(z.string().min(1).max(100)).max(DISCORD_GUILD_VISIBLE_CHANNEL_MAX).optional(),
    /** Visible channels beyond the `visible` name cap. */
    visibleTruncated: z.number().int().nonnegative().optional(),
    /** Names he cannot see. */
    hidden: z.array(z.string().min(1).max(100)).max(DISCORD_GUILD_HIDDEN_CHANNEL_MAX).optional(),
    /** Hidden channels beyond the `hidden` name cap. */
    hiddenTruncated: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((access, context) => {
    if (access.viewable > access.total) {
      context.addIssue({
        code: "custom",
        path: ["viewable"],
        message: "viewable channels cannot exceed the total",
      });
    }
  });
export type DiscordGuildChannelAccess = z.infer<typeof DiscordGuildChannelAccessSchema>;

/**
 * One server the session's account is a member of. The name is optional for
 * the same reason voice-room names are: a transport that observes raw gateway
 * ids only still publishes a valid (nameless) membership. Channel access is
 * optional the same way — a transport that cannot compute permissions still
 * publishes an honest membership.
 */
export const DiscordGuildMembershipSchema = z
  .object({
    guildId: z.string().min(1),
    guildName: z.string().min(1).max(100).optional(),
    channelAccess: DiscordGuildChannelAccessSchema.optional(),
  })
  .strict();
export type DiscordGuildMembership = z.infer<typeof DiscordGuildMembershipSchema>;

export const DISCORD_GUILD_MEMBERSHIP_MAX = 200;

/**
 * One completed stay in a voice channel, derived read-side from the durable
 * phase stream: the room context captured when the session joined, bounded by
 * join and leave times. History stays presence-class data about Clankie's own
 * whereabouts — the episode ring (ADR 0054) remains reserved for notes he
 * composes himself.
 */
export const DiscordVoiceStaySchema = DiscordVoiceRoomSchema.extend({
  joinedAt: z.string().datetime(),
  leftAt: z.string().datetime(),
}).strict();
export type DiscordVoiceStay = z.infer<typeof DiscordVoiceStaySchema>;

/** Wire shape of `GET /v1/discord/voice-history`. */
export const DiscordVoiceHistorySchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    stays: z.array(DiscordVoiceStaySchema).max(32),
  })
  .strict();
export type DiscordVoiceHistory = z.infer<typeof DiscordVoiceHistorySchema>;

export const DiscordPresenceSessionRecordSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    sessionId: z.string().min(1),
    characterId: z.string().min(1),
    credentialRef: z.string().min(1),
    transportKind: DiscordTransportKindSchema,
    phase: DiscordPresenceSessionPhaseSchema,
    gatewayConnected: z.boolean(),
    voiceGuildIds: z.array(z.string().min(1)).max(64),
    /**
     * Named context for the occupied voice channels. Optional so records
     * published before this field existed still parse; when present it must
     * mirror `voiceGuildIds` exactly (one room per guild, sorted), so a
     * consumer never has to reconcile two divergent views of the same state.
     */
    voiceRooms: z.array(DiscordVoiceRoomSchema).max(64).optional(),
    /**
     * Servers the account is a member of, sorted by guildId. Account-level
     * standing rather than connection state, so it is not cleared on
     * disconnect the way voice state is — it is last-known membership,
     * refreshed on every gateway ready/resume. Optional so records published
     * before this field existed still parse.
     */
    guilds: z.array(DiscordGuildMembershipSchema).max(DISCORD_GUILD_MEMBERSHIP_MAX).optional(),
    /** Rendered surfaces currently published by this session. */
    activityInstances: z.array(DiscordActivityInstanceSchema).max(DISCORD_ACTIVITY_INSTANCE_MAX).default([]),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((session, context) => {
    const connectedPhase = ["present", "voice_active", "go_live_active"].includes(session.phase);
    if (session.gatewayConnected !== connectedPhase) {
      context.addIssue({
        code: "custom",
        path: ["gatewayConnected"],
        message: `gatewayConnected does not match phase ${session.phase}`,
      });
    }
    if (session.activityInstances.length > 0 && !connectedPhase) {
      context.addIssue({
        code: "custom",
        path: ["activityInstances"],
        message: `activity instances cannot outlive phase ${session.phase}`,
      });
    }
    const voicePhase = session.phase === "voice_active" || session.phase === "go_live_active";
    if (voicePhase !== session.voiceGuildIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["voiceGuildIds"],
        message: `voice guild state does not match phase ${session.phase}`,
      });
    }
    if (
      session.voiceRooms !== undefined &&
      JSON.stringify(session.voiceRooms.map((room) => room.guildId)) !== JSON.stringify(session.voiceGuildIds)
    ) {
      context.addIssue({
        code: "custom",
        path: ["voiceRooms"],
        message: "voice rooms must mirror voiceGuildIds exactly, in the same order",
      });
    }
  });
export type DiscordPresenceSessionRecord = z.infer<typeof DiscordPresenceSessionRecordSchema>;

export const DiscordPresencePhaseTransitionReasonSchema = z.enum([
  "process_start",
  "gateway_ready",
  "gateway_resumed",
  "gateway_disconnected",
  "gateway_reconnecting",
  "voice_joined",
  "voice_left",
  "guild_membership_changed",
  "lease_lost",
  "gateway_failed",
  "publication_failed",
  "process_stopped",
]);
export type DiscordPresencePhaseTransitionReason = z.infer<typeof DiscordPresencePhaseTransitionReasonSchema>;

export const DiscordPresencePhaseEventSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    plane: z.literal("semantic"),
    id: z.string().min(1),
    type: z.literal("discord.presence.session.phase_changed"),
    occurredAt: z.string().datetime(),
    correlationId: z.string().min(1),
    sessionId: z.string().min(1),
    data: z
      .object({
        previousPhase: DiscordPresenceSessionPhaseSchema,
        phase: DiscordPresenceSessionPhaseSchema,
        reason: DiscordPresencePhaseTransitionReasonSchema,
        session: DiscordPresenceSessionRecordSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.sessionId !== event.data.session.sessionId) {
      context.addIssue({
        code: "custom",
        path: ["data", "session", "sessionId"],
        message: "phase event session identity mismatch",
      });
    }
    if (event.data.phase !== event.data.session.phase) {
      context.addIssue({
        code: "custom",
        path: ["data", "session", "phase"],
        message: "phase event projection mismatch",
      });
    }
    if (event.occurredAt !== event.data.session.updatedAt) {
      context.addIssue({
        code: "custom",
        path: ["data", "session", "updatedAt"],
        message: "phase event timestamp mismatch",
      });
    }
  });
export type DiscordPresencePhaseEvent = z.infer<typeof DiscordPresencePhaseEventSchema>;

/**
 * Runtime transport binding. Action schemas never mention bot vs user; only this
 * binding (plus doctrine) selects which credential-broker provider executes.
 * Token material is forbidden here.
 */
export const DiscordPresenceTransportBindingSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    kind: DiscordTransportKindSchema,
    /** Opaque broker credential reference — never a raw token. */
    credentialRef: z.string().min(1),
    resourceScope: z
      .object({
        guildIds: z.array(z.string().min(1)).max(64).default([]),
        channelIds: z.array(z.string().min(1)).max(256).default([]),
        dmPolicy: z.enum(["deny", "owner_only", "allowlist"]).default("deny"),
      })
      .strict(),
  })
  .strict();
export type DiscordPresenceTransportBinding = z.infer<typeof DiscordPresenceTransportBindingSchema>;

/** Catalog entry: transport-agnostic action + frozen doctrine risk class. */
export const DiscordPresenceCatalogEntrySchema = z
  .object({
    action: DiscordPresenceActionSchema,
    riskClass: z.enum(["narrative-write", "reversible-write", "publish-external", "destructive"]),
    /**
     * Transports that can carry this action, as one list rather than a pair of
     * booleans. Availability is a single question — "which bodies can do this?"
     * — so a single slot answers it and no two flags can contradict each other
     * as the plane set grows.
     */
    transports: z.array(DiscordTransportKindSchema).min(1),
    /** Minimum presence phase required. */
    minPhase: DiscordPresenceSessionPhaseSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (DISCORD_PRESENCE_ACTION_RISK_CLASS[entry.action] !== entry.riskClass) {
      context.addIssue({
        code: "custom",
        path: ["riskClass"],
        message: `risk class for ${entry.action} must be ${DISCORD_PRESENCE_ACTION_RISK_CLASS[entry.action]}`,
      });
    }
    if (new Set(entry.transports).size !== entry.transports.length) {
      context.addIssue({
        code: "custom",
        path: ["transports"],
        message: `duplicate transport binding for ${entry.action}`,
      });
    }
  });
export type DiscordPresenceCatalogEntry = z.infer<typeof DiscordPresenceCatalogEntrySchema>;

/** Both planes carry the ordinary social catalog; that is what makes it one character. */
const ANY_TRANSPORT: readonly DiscordTransportKind[] = ["bot", "user_session"];

const catalogEntry = (
  action: DiscordPresenceAction,
  transports: readonly DiscordTransportKind[],
  minPhase: DiscordPresenceSessionPhase,
): DiscordPresenceCatalogEntry =>
  DiscordPresenceCatalogEntrySchema.parse({
    action,
    riskClass: DISCORD_PRESENCE_ACTION_RISK_CLASS[action],
    transports: [...transports],
    minPhase,
  });

/** Frozen educational/lab catalog. Unlisted Discord methods fail closed. */
export const DISCORD_PRESENCE_CATALOG: readonly DiscordPresenceCatalogEntry[] = [
  catalogEntry("discord.presence.reply", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.reply_with_media", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.react", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.unreact", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.send_message", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.tool_progress", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.edit_own_message", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.delete_own_message", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.send_attachment", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.typing_start", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.create_thread", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.join_thread", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.voice_join", ANY_TRANSPORT, "present"),
  catalogEntry("discord.presence.voice_leave", ANY_TRANSPORT, "voice_active"),
  // Discord exposes Go Live only to a user session; a bot cannot publish one.
  catalogEntry("discord.presence.go_live_start", ["user_session"], "voice_active"),
  catalogEntry("discord.presence.go_live_stop", ["user_session"], "voice_active"),
  // Activity plane (ADR 0047): embedded applications are launched by the owning
  // bot application, so this pair is bot-only rather than merely bot-first.
  catalogEntry("discord.presence.activity_start", ["bot"], "voice_active"),
  catalogEntry("discord.presence.activity_stop", ["bot"], "voice_active"),
];

/**
 * Canonical bounded-turn scope for an ambient Discord conversation.
 *
 * Deliberately keyed by *where the conversation happens*, never by which
 * transport observed it. A channel Clankie was speaking in as the bot is the
 * same lane he continues in as the user session, so switching bodies mid-thread
 * keeps one continuing Eve lane, one character, and one person-memory
 * projection instead of forking a second stream of consciousness (ADR 0048).
 *
 * Both bridge processes must derive their `presenceSessionId` here; a
 * transport-local string would silently split the conversation.
 */
export function discordPresenceLaneAddress(scope: {
  readonly guildId?: string | undefined;
  readonly channelId: string;
}): string {
  return `discord:${scope.guildId ?? "dm"}:${scope.channelId}`;
}

const PHASE_RANK: Readonly<Record<DiscordPresenceSessionPhase, number>> = {
  off: 0,
  connecting: 1,
  present: 2,
  voice_active: 3,
  go_live_active: 4,
  degraded: 0,
  failed: 0,
};

export function isDiscordPresenceActionAvailable(input: {
  action: DiscordPresenceAction;
  session: DiscordPresenceSessionRecord;
}): boolean {
  const entry = DISCORD_PRESENCE_CATALOG.find((candidate) => candidate.action === input.action);
  if (entry === undefined) return false;
  if (!entry.transports.includes(input.session.transportKind)) return false;
  if (PHASE_RANK[input.session.phase] < PHASE_RANK[entry.minPhase]) return false;
  if (["off", "degraded", "failed"].includes(input.session.phase)) return false;
  return true;
}

export const DiscordPresenceToolNameSchema = z.enum([
  "discord_presence_status",
  "discord_presence_connect",
  "discord_presence_disconnect",
  "discord_presence_act",
  "discord_presence_action_status",
  "discord_presence_cancel_action",
]);
export type DiscordPresenceToolName = z.infer<typeof DiscordPresenceToolNameSchema>;

type CaptainLaneInput = CaptainLane | CaptainSessionLaneV2;

function currentCaptainLane(lane: CaptainLaneInput): CaptainSessionLaneV2 {
  return CaptainSessionLaneV2Schema.parse(lane === "tui" ? "operator" : lane);
}

const supervisionTools: DiscordPresenceToolName[] = [
  "discord_presence_status",
  "discord_presence_disconnect",
];

const presenceActTools: DiscordPresenceToolName[] = [
  "discord_presence_act",
  "discord_presence_action_status",
  "discord_presence_cancel_action",
];

function toolSetsFor(
  phase: DiscordPresenceSessionPhase,
  lane: CaptainSessionLaneV2,
): { lifecycleTools: DiscordPresenceToolName[]; presenceTools: DiscordPresenceToolName[] } {
  if (phase === "off" || phase === "failed") {
    return {
      lifecycleTools: ["discord_presence_status", "discord_presence_connect"],
      presenceTools: [],
    };
  }
  if (phase === "connecting") {
    return {
      lifecycleTools: ["discord_presence_status", "discord_presence_disconnect"],
      presenceTools: [],
    };
  }
  if (phase === "degraded") {
    return {
      lifecycleTools: ["discord_presence_status", "discord_presence_disconnect"],
      presenceTools: [],
    };
  }
  // Only the presence captain lane may act; other lanes keep supervision.
  if (lane === "discord_presence") {
    return { lifecycleTools: supervisionTools, presenceTools: presenceActTools };
  }
  return { lifecycleTools: supervisionTools, presenceTools: [] };
}

export const DiscordPresenceToolExposureSchema = z
  .object({
    schemaVersion: z.literal(2),
    phase: DiscordPresenceSessionPhaseSchema,
    lane: CaptainSessionLaneV2Schema,
    lifecycleTools: z.array(DiscordPresenceToolNameSchema),
    presenceTools: z.array(DiscordPresenceToolNameSchema),
  })
  .superRefine((value, context) => {
    const expected = toolSetsFor(value.phase, value.lane);
    if (JSON.stringify(value.lifecycleTools) !== JSON.stringify(expected.lifecycleTools)) {
      context.addIssue({
        code: "custom",
        path: ["lifecycleTools"],
        message: "invalid lifecycle tool exposure",
      });
    }
    if (JSON.stringify(value.presenceTools) !== JSON.stringify(expected.presenceTools)) {
      context.addIssue({
        code: "custom",
        path: ["presenceTools"],
        message: "invalid presence tool exposure",
      });
    }
  });
export type DiscordPresenceToolExposure = z.infer<typeof DiscordPresenceToolExposureSchema>;

export function resolveDiscordPresenceToolExposure(
  session: DiscordPresenceSessionRecord,
  lane: CaptainLaneInput,
): DiscordPresenceToolExposure {
  return resolveDiscordPresencePhaseToolExposure(session.phase, lane);
}

/** Resolve advertised tools directly from live phase when durability is intentionally behind. */
export function resolveDiscordPresencePhaseToolExposure(
  phase: DiscordPresenceSessionPhase,
  lane: CaptainLaneInput,
): DiscordPresenceToolExposure {
  const currentLane = currentCaptainLane(lane);
  return DiscordPresenceToolExposureSchema.parse({
    schemaVersion: 2,
    phase,
    lane: currentLane,
    ...toolSetsFor(phase, currentLane),
  });
}

/** Map environment phases into presence phases for shared join/status tools. */
export function discordPresencePhaseFromEnvironment(
  phase: EnvironmentSessionPhase,
): DiscordPresenceSessionPhase {
  switch (phase) {
    case "off":
      return "off";
    case "starting":
      return "connecting";
    case "active":
      return "present";
    case "paused":
      return "degraded";
    case "stopping":
      return "degraded";
    case "failed":
      return "failed";
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

/** Project presence phases back into the shared environment lifecycle surface. */
export function environmentPhaseFromDiscordPresence(
  phase: DiscordPresenceSessionPhase,
): EnvironmentSessionPhase {
  switch (phase) {
    case "off":
      return "off";
    case "connecting":
      return "starting";
    case "present":
    case "voice_active":
    case "go_live_active":
      return "active";
    case "degraded":
      return "paused";
    case "failed":
      return "failed";
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}
