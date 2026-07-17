import {
  CaptainSessionLaneV2Schema,
  DiscordPresenceActionRequestSchema,
  DiscordPresenceActionSchema,
  DISCORD_PRESENCE_ACTION_RISK_CLASS,
  type CaptainLane,
  type CaptainSessionLaneV2,
  type DiscordPresenceAction,
  type DiscordPresenceActionRequest,
} from "@clankie/protocol";
import { z } from "zod";
import { INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION, type EnvironmentSessionPhase } from "./environment.ts";

export { DiscordPresenceActionRequestSchema, type DiscordPresenceActionRequest };

export const DISCORD_PRESENCE_ENVIRONMENT_KIND = "discord_presence" as const;

/**
 * Presence-plane session phases (ADR 0024). Distinct from Minecraft environment
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

/** Authenticated bridge-to-control-plane fence carrying immediate gateway truth. */
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

export const DiscordPresenceSessionRecordSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    sessionId: z.string().min(1),
    characterId: z.string().min(1),
    credentialRef: z.string().min(1),
    transportKind: z.enum(["bot", "user_session"]),
    phase: DiscordPresenceSessionPhaseSchema,
    gatewayConnected: z.boolean(),
    voiceGuildIds: z.array(z.string().min(1)).max(64),
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
    const voicePhase = session.phase === "voice_active" || session.phase === "go_live_active";
    if (voicePhase !== session.voiceGuildIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["voiceGuildIds"],
        message: `voice guild state does not match phase ${session.phase}`,
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
    kind: z.enum(["bot", "user_session"]),
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
    /** User-session only capabilities (e.g. Go Live). */
    requiresUserSession: z.boolean(),
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
  });
export type DiscordPresenceCatalogEntry = z.infer<typeof DiscordPresenceCatalogEntrySchema>;

const catalogEntry = (
  action: DiscordPresenceAction,
  requiresUserSession: boolean,
  minPhase: DiscordPresenceSessionPhase,
): DiscordPresenceCatalogEntry =>
  DiscordPresenceCatalogEntrySchema.parse({
    action,
    riskClass: DISCORD_PRESENCE_ACTION_RISK_CLASS[action],
    requiresUserSession,
    minPhase,
  });

/** Frozen educational/lab catalog. Unlisted Discord methods fail closed. */
export const DISCORD_PRESENCE_CATALOG: readonly DiscordPresenceCatalogEntry[] = [
  catalogEntry("discord.presence.reply", false, "present"),
  catalogEntry("discord.presence.react", false, "present"),
  catalogEntry("discord.presence.unreact", false, "present"),
  catalogEntry("discord.presence.send_message", false, "present"),
  catalogEntry("discord.presence.edit_own_message", false, "present"),
  catalogEntry("discord.presence.delete_own_message", false, "present"),
  catalogEntry("discord.presence.send_attachment", false, "present"),
  catalogEntry("discord.presence.typing_start", false, "present"),
  catalogEntry("discord.presence.create_thread", false, "present"),
  catalogEntry("discord.presence.join_thread", false, "present"),
  catalogEntry("discord.presence.voice_join", false, "present"),
  catalogEntry("discord.presence.voice_leave", false, "voice_active"),
  catalogEntry("discord.presence.go_live_start", true, "voice_active"),
  catalogEntry("discord.presence.go_live_stop", true, "go_live_active"),
];

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
  if (entry.requiresUserSession && input.session.transportKind !== "user_session") return false;
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

/** Map Minecraft-style environment phases into presence phases for shared join/status tools. */
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
