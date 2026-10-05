import { z } from "zod";
import { DiscordSettingsSchema } from "./discord-settings.ts";
import { DiscordSetupSnapshotSchema } from "./discord-setup.ts";
import { ManagedDiscordPolicyStatusSchema } from "./managed-discord.ts";

export const DISCORD_ROOMS_PATH = "/v1/discord/rooms";
export const DISCORD_ROOM_GUIDANCE_PATH = "/v1/discord/room-guidance";
export const DISCORD_ROOM_EVIDENCE_PATH = "/v1/discord/room-evidence";
export const DISCORD_SETTINGS_PATH = "/v1/discord/settings";
export const DISCORD_ROOM_VOICE_PATH = "/v1/discord/room-voice";
const Id = z.string().min(1).max(256);
const Reason = z.string().min(1).max(128);
export const DiscordRoomEvidenceSchema = z
  .object({
    id: Id,
    presenceSessionId: Id,
    /** Internal body evidence only; absent for text ingress. */
    voiceStayId: Id.optional(),
    transportKind: z.enum(["bot", "user_session"]),
    guildId: Id.optional(),
    channelId: Id,
    actorId: Id,
    deliveryId: Id,
    outcome: z.enum([
      "accepted",
      "buffered",
      "dropped",
      "deduplicated",
      "settled",
      "declined",
      "absorbed",
      "failed",
      "missed",
      "escalated",
    ]),
    reason: Reason.optional(),
    replyDeliveryId: Id.optional(),
  })
  .strict();
export type DiscordRoomEvidence = z.infer<typeof DiscordRoomEvidenceSchema>;
export const DiscordRoomGuidanceRequestSchema = z
  .object({
    conversationId: Id,
    text: z.string().trim().min(1).max(4000).optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const DiscordRoomGuidanceSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    state: z.enum(["empty", "pending", "consumed", "expired"]),
    text: z.string().max(4000).optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .strict();
export type DiscordRoomGuidance = z.infer<typeof DiscordRoomGuidanceSchema>;
const Count = z.number().int().nonnegative();
export const DiscordRoomStatusSchema = z
  .object({
    conversationId: Id,
    title: z.string().max(512).optional(),
    lane: z.enum(["discord_presence", "discord_voice"]).optional(),
    targetId: Id.optional(),
    coverage: z.enum(["observed", "unknown"]),
    since: z.string().datetime(),
    received: Count,
    answered: Count,
    silent: Count,
    missed: Count,
    failed: Count,
    pending: Count,
    absorbedUnknown: Count,
    lastReason: Reason.optional(),
    lastObservedAt: z.string().datetime().optional(),
    guidance: DiscordRoomGuidanceSchema,
  })
  .strict();
export type DiscordRoomStatus = z.infer<typeof DiscordRoomStatusSchema>;
export const DiscordRoomsSnapshotSchema = z
  .object({ rooms: z.array(DiscordRoomStatusSchema).max(512) })
  .strict();
export const DiscordSettingsSnapshotSchema = z
  .object({
    settings: DiscordSettingsSchema,
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    /** Optional display metadata; older hosts and clients may omit it. */
    setup: DiscordSetupSnapshotSchema.optional(),
    managedPolicy: ManagedDiscordPolicyStatusSchema.optional(),
  })
  .strict();
export type DiscordSettingsSnapshot = z.infer<typeof DiscordSettingsSnapshotSchema>;
export const DiscordSettingsUpdateSchema = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    settings: DiscordSettingsSchema,
  })
  .strict();
export const DiscordRoomVoiceCommandSchema = z
  .object({
    conversationId: Id,
    action: z.enum(["join", "leave", "mute_output", "unmute_output"]),
    stayId: Id.optional(),
  })
  .strict();
export const DiscordRoomVoiceStatusSchema = z
  .object({
    state: z.enum(["idle", "active", "unknown"]),
    conversationId: Id.optional(),
    stayId: Id.optional(),
    guildId: Id.optional(),
    channelId: Id.optional(),
    activity: z.enum(["speaking", "listening", "thinking", "idle", "unknown"]),
    handoffCount: Count,
    outputMuted: z.boolean(),
    consentedParticipantCount: Count,
    activeCaptureCount: Count,
    /** Absent when current speaking identities cannot be observed. Names are untrusted display text. */
    speakers: z
      .array(z.object({ userId: Id, displayName: z.string().max(128).optional() }).strict())
      .max(64)
      .optional(),
  })
  .strict();
export type DiscordRoomVoiceStatus = z.infer<typeof DiscordRoomVoiceStatusSchema>;
export const DiscordVoiceOutputControlSchema = z
  .object({
    nonce: z.uuid(),
    stayId: Id,
    action: z.enum(["mute_output", "unmute_output", "leave"]),
  })
  .strict();
export const DISCORD_VOICE_OUTPUT_GUARD_PATH = "/v1/discord/voice-output-guard";
