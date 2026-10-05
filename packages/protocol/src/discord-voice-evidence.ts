import { z } from "zod";

// ---------------------------------------------------------------------------
// Discord voice evidence (ADR 0057).
//
// Receipt-visible evidence for the two-tier realtime voice architecture: a
// dormant transcription listener, an engaged realtime session, and a captain
// reached only through `ask_clankie`. Every field is a content-free scalar —
// bounded whitespace-free ids, enums, booleans, finite numbers — so no field
// can carry free text by construction and the receipt store's forbidden-key
// fence never has to trust the emitter. Speaker attribution comes from the
// Discord gateway's authenticated ids, never from the audio.
//
// The cascade timings this replaces (`silenceHoldMs`, `transcribeMs`,
// `captainMs`, `synthesizeMs`) are deliberately unrepresentable: the stages
// they measured no longer exist. What the realtime shape must keep visible
// instead (ADR 0057 consequences): waking versus continuing first-audio
// latency via the `wake` discriminator, captain handoff latency via
// `handoffMs`, whether a turn took the fast path, and the volition gate's
// offered/taken/suppressed counters — so "he talks too much" and "he never
// speaks up" are both falsifiable against numbers.
// ---------------------------------------------------------------------------

/** Gateway-issued Discord ids (snowflakes). Bounded and whitespace-free: an id slot cannot hold prose. */
const DiscordVoiceGatewayIdSchema = z.string().min(1).max(64).regex(/^\S+$/u);
/** Locally-minted correlation ids (delivery/turn). Same construction, sized for UUIDs and prefixed ids. */
const DiscordVoiceLocalIdSchema = z.string().min(1).max(128).regex(/^\S+$/u);

export const DISCORD_VOICE_TRANSCRIPTS_PATH = "/v1/discord/voice-transcripts";
export const DISCORD_VOICE_TRANSCRIPT_PAGE_LIMIT_MAX = 200;
export const DiscordVoiceTranscriptCursorSchema = z.string().regex(/^\d{12}$/u);
const DiscordVoiceTranscriptBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    body: z.enum(["bot", "user_session"]),
    occurredAt: z.string().datetime(),
    guildId: DiscordVoiceGatewayIdSchema,
    channelId: DiscordVoiceGatewayIdSchema,
    stayId: z.string().min(1).max(256).optional(),
    deliveryId: z.string().min(1).max(256),
    speakerId: DiscordVoiceGatewayIdSchema,
    displayName: z.string().min(1).max(256).optional(),
    text: z.string().min(1).max(64_000),
  })
  .strict();
export const DiscordVoiceTranscriptLogEntrySchema = z.union([
  DiscordVoiceTranscriptBaseSchema.extend({ role: z.literal("user").optional() }).strict(),
  DiscordVoiceTranscriptBaseSchema.extend({
    role: z.literal("assistant"),
    speakerId: z.literal("clankie"),
    itemId: z.string().max(256),
    playbackId: z.string().min(1).max(256).optional(),
    responseId: z.string().min(1).max(256).optional(),
    textSource: z.enum(["native_audio", "tts_text"]),
    textComplete: z.boolean(),
    // Generated wording is not word-aligned to audible PCM after a cutoff.
    outcome: z.enum(["played", "interrupted", "suppressed", "failed", "truncated"]),
    audioStarted: z.boolean(),
    playbackMs: z.number().finite().nonnegative(),
  }).strict(),
]);
export type DiscordVoiceTranscriptLogEntry = z.infer<typeof DiscordVoiceTranscriptLogEntrySchema>;

export const DiscordVoiceTranscriptPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    entries: z.array(DiscordVoiceTranscriptLogEntrySchema).max(DISCORD_VOICE_TRANSCRIPT_PAGE_LIMIT_MAX),
    nextCursor: DiscordVoiceTranscriptCursorSchema,
    hasMore: z.boolean(),
  })
  .strict();
export type DiscordVoiceTranscriptPage = z.infer<typeof DiscordVoiceTranscriptPageSchema>;
/** Wall-clock milliseconds; a scalar measurement, never a payload. */
const DiscordVoiceDurationMsSchema = z.number().finite().nonnegative();
/** Monotonic non-negative integer counter. */
const DiscordVoiceCounterSchema = z.number().int().nonnegative();

const discordVoiceChannelScope = {
  guildId: DiscordVoiceGatewayIdSchema,
  channelId: DiscordVoiceGatewayIdSchema,
  /** One id from `joined` to `left`. Optional so records written before stays existed still parse. */
  stayId: DiscordVoiceLocalIdSchema.optional(),
} as const;

/**
 * Why a play report was seeded but not spoken. Play loops report constantly;
 * answering each one is a monologue. The drop must be receipt-visible or
 * "why didn't he commentate that turn?" is unanswerable.
 */
export const DiscordVoiceNarrationSuppressReasonSchema = z.enum(["playing", "rate_limited", "responding"]);
export type DiscordVoiceNarrationSuppressReason = z.infer<typeof DiscordVoiceNarrationSuppressReasonSchema>;

/** Whether Clankie holds the floor (engaged realtime session) or only listens (dormant transcription). */
export const DiscordVoiceFloorStateSchema = z.enum(["engaged", "dormant"]);
export type DiscordVoiceFloorState = z.infer<typeof DiscordVoiceFloorStateSchema>;

/**
 * Why the floor moved. A dropped wake means he ignores someone who addressed
 * him — the transition is the new failure surface, so both directions are
 * receipt-visible for the live gate rather than inferred from silence.
 */
export const DiscordVoiceFloorReasonSchema = z.enum(["addressed", "volition", "decay", "released"]);
export type DiscordVoiceFloorReason = z.infer<typeof DiscordVoiceFloorReasonSchema>;

/**
 * Whether this response paid the wake. The first response after being
 * addressed carries session setup; later turns in the exchange do not.
 * Reported separately, or the wake cost is invisible (ADR 0057).
 */
export const DiscordVoiceWakeSchema = z.enum(["waking", "continuing"]);
export type DiscordVoiceWake = z.infer<typeof DiscordVoiceWakeSchema>;

export const DiscordVoiceResponseStateSchema = z.enum(["settled", "waiting_user"]);
export type DiscordVoiceResponseState = z.infer<typeof DiscordVoiceResponseStateSchema>;

/**
 * What made him speak: someone in the room, or play reporting what the
 * body just did. Both take the fast path with a zero handoff, so without this
 * the latency line cannot tell a real reply from a play narration — which is
 * exactly the ambiguity that slowed the 2026-08-02 diagnosis.
 */
export const DiscordVoiceResponseTriggerSchema = z.enum(["room", "narration", "membership"]);
export type DiscordVoiceResponseTrigger = z.infer<typeof DiscordVoiceResponseTriggerSchema>;

/** Content-free checkpoints between captured audio and a spoken response. */
export const DiscordVoiceTranscriptionOutcomeSchema = z.enum(["accepted", "empty"]);
export type DiscordVoiceTranscriptionOutcome = z.infer<typeof DiscordVoiceTranscriptionOutcomeSchema>;

export const DiscordVoiceFloorDecisionActionSchema = z.enum([
  "wake",
  "hold",
  "offer",
  "listen",
  "release",
  "volition_gate_open",
  "ignore",
]);
export type DiscordVoiceFloorDecisionAction = z.infer<typeof DiscordVoiceFloorDecisionActionSchema>;

export const DiscordVoiceFloorDecisionReasonSchema = z.enum([
  "addressed",
  "mentioned",
  "holder",
  "reply_policy_all",
  "transcript",
  "volition",
  "explicit",
  "decay",
]);
export type DiscordVoiceFloorDecisionReason = z.infer<typeof DiscordVoiceFloorDecisionReasonSchema>;

export const DiscordVoiceModelResponsePhaseSchema = z.enum(["requested", "completed", "failed"]);
export type DiscordVoiceModelResponsePhase = z.infer<typeof DiscordVoiceModelResponsePhaseSchema>;
export const DiscordVoiceModelResponseOutcomeSchema = z.enum(["audio", "tool", "silent"]);
export type DiscordVoiceModelResponseOutcome = z.infer<typeof DiscordVoiceModelResponseOutcomeSchema>;

export const DiscordVoiceRealtimeToolNameSchema = z.enum([
  "voice_leave",
  "ask_clankie",
  "look_at_screen",
  "youtube_search",
  "music_play",
  "music_queue",
  "music_skip",
  "music_pause",
  "music_resume",
  "music_stop",
  "music_now",
  "recall_episodes",
  "get_self_state",
  "remember_episode",
]);
export type DiscordVoiceRealtimeToolName = z.infer<typeof DiscordVoiceRealtimeToolNameSchema>;
export const DiscordVoiceRealtimeToolPhaseSchema = z.enum(["called", "completed", "failed", "dropped"]);
export type DiscordVoiceRealtimeToolPhase = z.infer<typeof DiscordVoiceRealtimeToolPhaseSchema>;

export const DiscordVoiceMusicOperationSchema = z.enum([
  "search",
  "play",
  "queue",
  "skip",
  "pause",
  "resume",
  "stop",
  "now",
  "ended",
  "duck",
  "unduck",
]);
export type DiscordVoiceMusicOperation = z.infer<typeof DiscordVoiceMusicOperationSchema>;
export const DiscordVoiceMusicComponentSchema = z.enum(["queue", "yt_dlp", "ffmpeg", "pipeline", "player"]);
export type DiscordVoiceMusicComponent = z.infer<typeof DiscordVoiceMusicComponentSchema>;
export const DiscordVoiceMusicOutcomeSchema = z.enum([
  "offered",
  "empty",
  "rejected",
  "started",
  "queued",
  "skipped",
  "paused",
  "resumed",
  "stopped",
  "reported",
  "ended",
  "ducked",
  "unducked",
  "spawned",
  "first_audio",
  "exited",
  "failed",
  "submitted",
  "playing",
  "idle",
]);
export type DiscordVoiceMusicOutcome = z.infer<typeof DiscordVoiceMusicOutcomeSchema>;

/** The realtime pipeline's failure stages. The cascade stages left with the cascade. */
export const DiscordVoiceFailureStageSchema = z.enum([
  "capture",
  "transcription_session",
  "conversation_session",
  "captain_handoff",
  "look_at_screen",
  // The mouth: synthesis failed before completing the utterance. Distinct
  // from `playback`, which is the Discord player leg downstream of it.
  "speech_synthesis",
  "playback",
]);
export type DiscordVoiceFailureStage = z.infer<typeof DiscordVoiceFailureStageSchema>;

/** A machine token, never a message: lowercase snake_case, bounded. */
export const DiscordVoiceFailureCodeSchema = z.string().regex(/^[a-z0-9_]{1,64}$/u);
export type DiscordVoiceFailureCode = z.infer<typeof DiscordVoiceFailureCodeSchema>;

/** The loopback play seam attaches and detaches locally; no room text is retained. */
export const DiscordVoicePlayConnectionPhaseSchema = z.enum(["attached", "detached"]);
export type DiscordVoicePlayConnectionPhase = z.infer<typeof DiscordVoicePlayConnectionPhaseSchema>;

export const DiscordVoiceEvidenceSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("participant"),
        ...discordVoiceChannelScope,
        userId: DiscordVoiceGatewayIdSchema,
        action: z.enum(["joined", "left"]),
        humanCount: DiscordVoiceCounterSchema,
        deliveryId: DiscordVoiceLocalIdSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("joined"),
        ...discordVoiceChannelScope,
        daveProtocolVersion: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({
        type: z.literal("consent"),
        ...discordVoiceChannelScope,
        userId: DiscordVoiceGatewayIdSchema,
        consented: z.boolean(),
        participantCount: DiscordVoiceCounterSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("utterance"),
        ...discordVoiceChannelScope,
        /** Attribution is the gateway's speaking transition for this authenticated id, never the audio. */
        userId: DiscordVoiceGatewayIdSchema,
        deliveryId: DiscordVoiceLocalIdSchema,
        durationMs: DiscordVoiceDurationMsSchema,
        /** Capture endpoint, not proof of the last spoken phoneme. */
        silenceDurationMs: DiscordVoiceDurationMsSchema.optional(),
        /** Near-silent captures never sent to the transcription provider. */
        filtered: z.boolean().optional(),
        peakRms: z.number().nonnegative().max(32_768).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("transcription"),
        ...discordVoiceChannelScope,
        userId: DiscordVoiceGatewayIdSchema,
        deliveryId: DiscordVoiceLocalIdSchema,
        outcome: DiscordVoiceTranscriptionOutcomeSchema,
        /** Character count only; transcript content remains unrepresentable. */
        characters: DiscordVoiceCounterSchema,
        /** Capture start to final transcript; includes speaking time. */
        latencyMs: DiscordVoiceDurationMsSchema,
        captureEndToFinalMs: DiscordVoiceDurationMsSchema.optional(),
        lastAudioToFinalMs: DiscordVoiceDurationMsSchema.optional(),
        addressed: z.boolean(),
        /**
         * Loudest RMS in the capture, full scale 32_768. Content-free — it is
         * an amplitude, not a sound — and it is the only thing that separates
         * the two ways `outcome: "empty"` happens: a quiet room whose open mic
         * tripped the speaking gate, or real speech the transcriber lost. On
         * 2026-08-18 a play session logged 181 empty transcriptions against 4
         * accepted and the receipts could not tell those apart.
         */
        peakRms: z.number().nonnegative().max(32_768).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("text_input"),
        ...discordVoiceChannelScope,
        /** Discord gateway identity of the author; text needs no voice-consent inference. */
        userId: DiscordVoiceGatewayIdSchema,
        deliveryId: DiscordVoiceLocalIdSchema,
        /** Character count only; the Discord body remains absent from voice receipts. */
        characters: DiscordVoiceCounterSchema,
        addressed: z.boolean(),
      })
      .strict(),
    z
      .object({
        type: z.literal("floor_decision"),
        ...discordVoiceChannelScope,
        userId: DiscordVoiceGatewayIdSchema,
        deliveryId: DiscordVoiceLocalIdSchema,
        action: DiscordVoiceFloorDecisionActionSchema,
        reason: DiscordVoiceFloorDecisionReasonSchema.optional(),
        state: DiscordVoiceFloorStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("floor"),
        ...discordVoiceChannelScope,
        state: DiscordVoiceFloorStateSchema,
        reason: DiscordVoiceFloorReasonSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("model_response"),
        ...discordVoiceChannelScope,
        deliveryId: DiscordVoiceLocalIdSchema,
        userId: DiscordVoiceGatewayIdSchema.optional(),
        phase: DiscordVoiceModelResponsePhaseSchema,
        outcome: DiscordVoiceModelResponseOutcomeSchema.optional(),
        responseId: DiscordVoiceLocalIdSchema.optional(),
        audioBytes: DiscordVoiceCounterSchema.optional(),
        textCharacters: DiscordVoiceCounterSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("realtime_tool"),
        ...discordVoiceChannelScope,
        deliveryId: DiscordVoiceLocalIdSchema.optional(),
        userId: DiscordVoiceGatewayIdSchema.optional(),
        callId: DiscordVoiceLocalIdSchema,
        name: DiscordVoiceRealtimeToolNameSchema,
        phase: DiscordVoiceRealtimeToolPhaseSchema,
        code: DiscordVoiceFailureCodeSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("music"),
        ...discordVoiceChannelScope,
        deliveryId: DiscordVoiceLocalIdSchema.optional(),
        callId: DiscordVoiceLocalIdSchema.optional(),
        source: z.enum(["realtime", "control"]),
        operation: DiscordVoiceMusicOperationSchema,
        component: DiscordVoiceMusicComponentSchema,
        outcome: DiscordVoiceMusicOutcomeSchema,
        current: z.boolean().optional(),
        queuedCount: DiscordVoiceCounterSchema.optional(),
        paused: z.boolean().optional(),
        resultCount: DiscordVoiceCounterSchema.optional(),
        exitCode: DiscordVoiceCounterSchema.optional(),
        code: DiscordVoiceFailureCodeSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("response"),
        ...discordVoiceChannelScope,
        playbackId: DiscordVoiceLocalIdSchema.optional(),
        itemId: DiscordVoiceLocalIdSchema.optional(),
        deliveryId: DiscordVoiceLocalIdSchema,
        /** Gateway speaker whose immutable utterance id caused this response. */
        userId: DiscordVoiceGatewayIdSchema.optional(),
        /** Captain turn id — only the `ask_clankie` path has one. */
        turnId: DiscordVoiceLocalIdSchema.optional(),
        state: DiscordVoiceResponseStateSchema,
        /** True when the realtime session answered directly, without `ask_clankie`. */
        fastPath: z.boolean(),
        /** Optional so records written before the field existed still parse. */
        trigger: DiscordVoiceResponseTriggerSchema.optional(),
        wake: DiscordVoiceWakeSchema,
        toFirstAudioMs: DiscordVoiceDurationMsSchema,
        /** Captain round trip inside `ask_clankie`; 0 on the fast path. */
        handoffMs: DiscordVoiceDurationMsSchema,
        playbackMs: DiscordVoiceDurationMsSchema,
        /** Last received input PCM to transmitted speech; not headphone latency. */
        lastAudioToFirstAudioMs: DiscordVoiceDurationMsSchema.optional(),
        captureEndToFirstAudioMs: DiscordVoiceDurationMsSchema.optional(),
        transcriptToFirstAudioMs: DiscordVoiceDurationMsSchema.optional(),
        /** Includes wake setup, queuing, and any handoff before this response. */
        transcriptToRequestMs: DiscordVoiceDurationMsSchema.optional(),
        requestToFirstTextMs: DiscordVoiceDurationMsSchema.optional(),
        requestToFirstAudioChunkMs: DiscordVoiceDurationMsSchema.optional(),
        firstAudioChunkToPlaybackMs: DiscordVoiceDurationMsSchema.optional(),
        /** Realtime `response.done` usage; omitted when the provider sent none. */
        inputTokens: DiscordVoiceCounterSchema.optional(),
        outputTokens: DiscordVoiceCounterSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("volition"),
        ...discordVoiceChannelScope,
        /** Monotonic per-session counters, reported the way ADR 0056 reports free play. */
        offered: DiscordVoiceCounterSchema,
        taken: DiscordVoiceCounterSchema,
        suppressed: DiscordVoiceCounterSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("overlap"),
        ...discordVoiceChannelScope,
        userId: DiscordVoiceGatewayIdSchema,
        activeCaptureCount: DiscordVoiceCounterSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("interrupted"),
        ...discordVoiceChannelScope,
        playbackId: DiscordVoiceLocalIdSchema.optional(),
        itemId: DiscordVoiceLocalIdSchema.optional(),
        deliveryId: DiscordVoiceLocalIdSchema.optional(),
        userId: DiscordVoiceGatewayIdSchema,
        /** Deliberate truncation while playing; streamed audio has no synthesizing phase to cut. */
        phase: z.literal("playing"),
      })
      .strict(),
    z
      .object({
        type: z.literal("failed"),
        ...discordVoiceChannelScope,
        playbackId: DiscordVoiceLocalIdSchema.optional(),
        itemId: DiscordVoiceLocalIdSchema.optional(),
        deliveryId: DiscordVoiceLocalIdSchema.optional(),
        userId: DiscordVoiceGatewayIdSchema.optional(),
        stage: DiscordVoiceFailureStageSchema,
        code: DiscordVoiceFailureCodeSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("left"),
        ...discordVoiceChannelScope,
        reason: DiscordVoiceFailureCodeSchema.optional(),
        inputTokens: DiscordVoiceCounterSchema.optional(),
        outputTokens: DiscordVoiceCounterSchema.optional(),
        spokenCount: DiscordVoiceCounterSchema.optional(),
        narrationSuppressed: DiscordVoiceCounterSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("play_connection"),
        phase: DiscordVoicePlayConnectionPhaseSchema,
        attachedCount: DiscordVoiceCounterSchema,
        stayId: DiscordVoiceLocalIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("play_room"),
        listening: z.boolean(),
        attachedCount: DiscordVoiceCounterSchema,
        deliveredCount: DiscordVoiceCounterSchema,
        stayId: DiscordVoiceLocalIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("play_transcript_delivery"),
        deliveryId: DiscordVoiceLocalIdSchema,
        attachedCount: DiscordVoiceCounterSchema,
        deliveredCount: DiscordVoiceCounterSchema,
        stayId: DiscordVoiceLocalIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("play_narration_submission"),
        deliveryId: DiscordVoiceLocalIdSchema,
        attachedCount: DiscordVoiceCounterSchema,
        stayId: DiscordVoiceLocalIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("play_narration_suppressed"),
        ...discordVoiceChannelScope,
        deliveryId: DiscordVoiceLocalIdSchema,
        reason: DiscordVoiceNarrationSuppressReasonSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("play_refusal"),
        deliveryId: DiscordVoiceLocalIdSchema.optional(),
        attachedCount: DiscordVoiceCounterSchema,
        reason: DiscordVoiceFailureCodeSchema,
        stayId: DiscordVoiceLocalIdSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((evidence, context) => {
    if (evidence.type !== "response") return;
    if (evidence.fastPath) {
      if (evidence.turnId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["turnId"],
          message: "Fast-path responses have no captain turn to attribute",
        });
      }
      if (evidence.handoffMs !== 0) {
        context.addIssue({
          code: "custom",
          path: ["handoffMs"],
          message: "Fast-path responses pay no captain handoff",
        });
      }
    } else if (evidence.turnId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["turnId"],
        message: "ask_clankie responses carry the captain turn id",
      });
    }
  });

export type DiscordVoiceEvidence = z.infer<typeof DiscordVoiceEvidenceSchema>;
