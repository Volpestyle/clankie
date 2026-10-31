import { z } from "zod";
import { DiscordSettingsSchema } from "./discord-settings.ts";
import { DiscordSetupSnapshotSchema } from "./discord-setup.ts";
import { DiscordVoiceFailureCodeSchema } from "./discord-voice-evidence.ts";

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
      "abandoned",
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
    /** Failed deliveries without a confirmed reply or room notice. */
    unrecoveredFailed: Count.optional(),
    /** Failed deliveries recovery closed for a permanent reason, unanswered and never retried. */
    abandoned: Count.optional(),
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
/**
 * One leg of a voice stay, read from its content-free receipts (VUH-2728).
 * `broken` means the provider's session was lost after the leg last worked:
 * hearing has had no transcription, answering no completed response, since.
 * A scheduled `lifetime` rotation reconnects on its own: it counts as a loss
 * but never breaks the leg.
 */
export const DiscordVoicePipelineSchema = z
  .object({
    state: z.enum(["working", "broken", "unproven"]),
    losses: Count,
    lastLoss: z
      .object({
        at: z.string().datetime(),
        code: DiscordVoiceFailureCodeSchema,
        closeReason: z.enum(["closed", "lifetime", "socket", "error"]).optional(),
        closeCode: z.number().int().min(0).max(4999).optional(),
        providerCode: DiscordVoiceFailureCodeSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DiscordVoicePipeline = z.infer<typeof DiscordVoicePipelineSchema>;
export const DiscordVoiceStayPipelinesSchema = z
  .object({
    stayId: Id,
    /** When a leave receipt was recorded; absence alone does not prove the stay is live. */
    endedAt: z.string().datetime().optional(),
    hearing: DiscordVoicePipelineSchema.extend({
      /** Known listeners still lost since that speaker last transcribed. Absent on older services. */
      brokenUserIds: z.array(Id).optional(),
    }),
    answering: DiscordVoicePipelineSchema,
  })
  .strict();
export type DiscordVoiceStayPipelines = z.infer<typeof DiscordVoiceStayPipelinesSchema>;
export const DiscordVoiceJoinRefusalSchema = z
  .object({
    at: z.string().datetime(),
    code: DiscordVoiceFailureCodeSchema,
    closeCode: z.number().int().min(0).max(4999).optional(),
    providerCode: DiscordVoiceFailureCodeSchema.optional(),
  })
  .strict();
export type DiscordVoiceJoinRefusal = z.infer<typeof DiscordVoiceJoinRefusalSchema>;
/** Listener admission only: no audio, generated response, or Discord join. */
export const VoiceProviderReadinessSchema = z
  .object({
    provider: z.enum(["openai", "xai", "anthropic"]),
    checkedProvider: z.enum(["openai", "xai"]),
    scope: z.literal("transcription"),
    state: z.enum(["ready", "refused", "missing_key", "unconfirmed", "unavailable", "checking", "disabled"]),
    providerCode: DiscordVoiceFailureCodeSchema.optional(),
    checkedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    cached: z.boolean(),
  })
  .strict();
export type VoiceProviderReadiness = z.infer<typeof VoiceProviderReadinessSchema>;
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
    /** The latest stay's hearing and answering; absent before any stay or when receipts are unreadable. */
    pipelines: DiscordVoiceStayPipelinesSchema.optional(),
    /** A join the voice provider refused after the latest stay began, e.g. no credit (VUH-2728). */
    joinRefusal: DiscordVoiceJoinRefusalSchema.optional(),
    providerReadiness: VoiceProviderReadinessSchema.optional(),
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
