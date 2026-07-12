import {
  CaptainLaneSchema,
  DiscordPresenceActionRequestSchema,
  DiscordPresenceActionSchema,
  DISCORD_PRESENCE_ACTION_RISK_CLASS,
  type CaptainLane,
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
  degraded: 2,
  failed: 0,
};

export function isDiscordPresenceActionAvailable(input: {
  action: DiscordPresenceAction;
  phase: DiscordPresenceSessionPhase;
  transportKind: "bot" | "user_session";
}): boolean {
  const entry = DISCORD_PRESENCE_CATALOG.find((candidate) => candidate.action === input.action);
  if (entry === undefined) return false;
  if (entry.requiresUserSession && input.transportKind !== "user_session") return false;
  if (PHASE_RANK[input.phase] < PHASE_RANK[entry.minPhase]) return false;
  if (input.phase === "off" || input.phase === "failed") return false;
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
  lane: CaptainLane,
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
  // Only the presence captain lane may act; other lanes keep supervision.
  if (lane === "discord_presence") {
    return { lifecycleTools: supervisionTools, presenceTools: presenceActTools };
  }
  return { lifecycleTools: supervisionTools, presenceTools: [] };
}

export const DiscordPresenceToolExposureSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    phase: DiscordPresenceSessionPhaseSchema,
    lane: CaptainLaneSchema,
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
  phase: DiscordPresenceSessionPhase,
  lane: CaptainLane,
): DiscordPresenceToolExposure {
  return DiscordPresenceToolExposureSchema.parse({
    schemaVersion: INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION,
    phase,
    lane,
    ...toolSetsFor(phase, lane),
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
