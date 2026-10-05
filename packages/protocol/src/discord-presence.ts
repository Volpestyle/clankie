import { DiscordServerActionSchema } from "./discord-server.ts";
import { z } from "zod";
import { DeliveryStageSchema } from "./delivery.ts";
import { BodyLeaseResultSchema } from "./body-leases.ts";
import { MissionIdSchema, TaskIdSchema, WorkerRunIdSchema, CharacterIdSchema } from "./captain-lanes.ts";

/**
 * What he replies with to say nothing at all.
 *
 * A turn used to be structurally obliged to speak: the only successful result
 * carried a non-empty `response`, so silence was never something he could
 * choose, only something a gate could impose before the turn ran. That forced
 * every "should he answer this?" decision to be a rule evaluated without him —
 * and a rule cannot tell a late reply in a real conversation from noise.
 *
 * Available on every turn, including one that named him. A gate decides what
 * reaches him; nothing decides that he must speak.
 *
 * A sentinel rather than a structured field because a Discord turn is
 * free-form conversational text, and making it structured to carry one nullable
 * flag would reshape every captain turn for the sake of this one.
 */
export const CAPTAIN_SILENT_REPLY_SENTINEL = "[[stay-silent]]";

/**
 * Media he made, and why it is sendable without an approval (ADR 0085).
 *
 * Generation writes a local artifact and publishes nothing, so it is read-class
 * (ADR 0029). What makes the picture *conversational* is where it was written:
 * only the service's generator writes beneath `GENERATED_MEDIA_DIRECTORY`,
 * and only the service's browser host writes beneath
 * `BROWSER_ARTIFACT_DIRECTORY`. Nothing the captain holds can write to either —
 * `write_file` is disabled, and any shell he is granted must be sandboxed to a
 * writable root outside the attachment root (the shell host refuses to start
 * otherwise). So a ref under one of those directories is provably something a
 * governed tool of his produced rather than any file that happens to sit under
 * the attachment root, and that is the whole of the distinction. Everything
 * else — repository files, support bundles — keeps `send_attachment` and its
 * `publish-external` approval (ADR 0088).
 */

/** Sole write target of the media generator, relative to the attachment root. */
export const GENERATED_MEDIA_DIRECTORY = "generated";

/** Sole write target of the service's browser host, relative to the attachment root. */
export const BROWSER_ARTIFACT_DIRECTORY = "browser";

/** Sole write target of the service's diagram host, relative to the attachment root. */
export const TLDRAW_ARTIFACT_DIRECTORY = "tldraw";

/** Sole write target of Discord stream-watch stills, relative to the attachment root. */
export const SHARE_ARTIFACT_DIRECTORY = "shares";

export const GENERATED_MEDIA_REF_PATTERN = new RegExp(
  `^sha256:[0-9a-f]{64}:${GENERATED_MEDIA_DIRECTORY}/[A-Za-z0-9._-]+$`,
  "u",
);

const BROWSER_ARTIFACT_REF_PATTERN = new RegExp(
  `^sha256:[0-9a-f]{64}:${BROWSER_ARTIFACT_DIRECTORY}/[A-Za-z0-9._-]+$`,
  "u",
);

const TLDRAW_ARTIFACT_REF_PATTERN = new RegExp(
  `^sha256:[0-9a-f]{64}:${TLDRAW_ARTIFACT_DIRECTORY}/[A-Za-z0-9._-]+$`,
  "u",
);

const SHARE_ARTIFACT_REF_PATTERN = new RegExp(
  `^sha256:[0-9a-f]{64}:${SHARE_ARTIFACT_DIRECTORY}/[A-Za-z0-9._-]+$`,
  "u",
);

/**
 * Whether a reference names media the generator minted.
 *
 * Deliberately stricter than the attachment resolver's containment check: one
 * path segment of safe characters under one fixed directory, so neither
 * traversal nor a nested path can dress an arbitrary artifact up as generated
 * media. The resolver still verifies containment and the hash afterwards — this
 * is the authority check, not the safety one.
 */
export function isGeneratedMediaRef(artifactRef: string): boolean {
  return GENERATED_MEDIA_REF_PATTERN.test(artifactRef);
}

/**
 * Whether a reference names a screenshot the service's browser host minted.
 *
 * Same argument as generated media, same shape: one safe segment under one
 * fixed directory that only the browser host writes. He cannot forge it, cannot
 * traverse out of it, and cannot dress an arbitrary file up as one — the ref is
 * hash-bound and the resolver re-verifies containment and digest.
 */
export function isBrowserArtifactRef(artifactRef: string): boolean {
  return BROWSER_ARTIFACT_REF_PATTERN.test(artifactRef);
}

/**
 * Whether a reference names a diagram the service's tldraw host minted.
 *
 * Same argument again, and it holds for the same reason: the host is the only
 * writer beneath `tldraw/`, and the model never authors the canvas code that
 * produces one — it supplies structured diagram *content* (tables, lanes,
 * steps) that the host renders through fixed, host-authored script. A
 * prompt-injected turn can therefore choose what a diagram says and nothing
 * about what runs.
 */
export function isTldrawArtifactRef(artifactRef: string): boolean {
  return TLDRAW_ARTIFACT_REF_PATTERN.test(artifactRef);
}

/**
 * Whether a reference names a still the stream-watch host minted from a
 * consented Discord share. Same host-minted, hash-bound argument as browser
 * screenshots: the captain cannot write under `shares/`.
 */
export function isShareArtifactRef(artifactRef: string): boolean {
  return SHARE_ARTIFACT_REF_PATTERN.test(artifactRef);
}

/**
 * Whether a reference may ride his reply without an approval (ADR 0088).
 *
 * Every one of these directories is written only by a governed service-side
 * host, so what he shows a room is always something a tool of his actually
 * produced. The distinction this preserves is against *arbitrary* files under
 * the attachment root — a repository file, a support bundle — which keep
 * `send_attachment` and its `publish-external` approval.
 */
export function isAttachableTurnMediaRef(artifactRef: string): boolean {
  return (
    isGeneratedMediaRef(artifactRef) ||
    isBrowserArtifactRef(artifactRef) ||
    isTldrawArtifactRef(artifactRef) ||
    isShareArtifactRef(artifactRef)
  );
}

/**
 * A picture he made during the turn, harvested from the turn's own tool results
 * rather than from anything he wrote (ADR 0085).
 *
 * He never names it. The surface that renders the turn decides whether it can
 * show media at all, which is why this rides the result instead of being a
 * second call he has to remember to make — and why a lane with no way to show a
 * picture simply ignores it rather than needing him to behave differently there.
 */
export const CaptainTurnMediaSchema = z
  .object({
    artifactRef: z
      .string()
      .refine(isAttachableTurnMediaRef, "expected a generated-media or browser artifact reference"),
    filename: z.string().min(1).max(200),
  })
  .strict();
export type CaptainTurnMedia = z.infer<typeof CaptainTurnMediaSchema>;

export const CaptainChannelTurnResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("settled"),
      deliveryStage: DeliveryStageSchema.optional(),
      captainSessionId: z.string().min(1),
      turnId: z.string().min(1),
      response: z.string().trim().min(1).max(16_384),
      media: CaptainTurnMediaSchema.optional(),
    })
    .strict(),
  /** He read it and chose not to answer. Nothing is written to the channel. */
  z
    .object({
      state: z.literal("silent"),
      deliveryStage: DeliveryStageSchema.optional(),
      captainSessionId: z.string().min(1),
      turnId: z.string().min(1),
    })
    .strict(),
  /**
   * It arrived mid-turn and was folded into the run already in flight, whose
   * reply answers it (ADR 0091, ADR 0118). Like `silent` in that this delivery
   * writes nothing; unlike it in every way that matters afterwards — he did
   * answer, so the evidence must not record a decline and the channel must not
   * age out as one he has stopped talking in.
   */
  z
    .object({
      state: z.literal("absorbed"),
      deliveryStage: DeliveryStageSchema.optional(),
      /** The delivery whose Discord reply also answers this message. */
      replyDeliveryId: z.string().min(1).optional(),
      captainSessionId: z.string().min(1),
      turnId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("waiting_user"),
      deliveryStage: DeliveryStageSchema.optional(),
      captainSessionId: z.string().min(1),
      turnId: z.string().min(1),
      prompt: z.string().trim().min(1).max(16_384),
      approvalRequired: z.boolean(),
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
      deliveryStage: DeliveryStageSchema.optional(),
      captainSessionId: z.string().min(1).optional(),
      turnId: z.string().min(1).optional(),
      code: z.string().min(1).max(128),
    })
    .strict(),
]);
export type CaptainChannelTurnResult = z.infer<typeof CaptainChannelTurnResultSchema>;

/**
 * Which Discord connection carries an action (ADR 0024, ADR 0048).
 *
 * This is the *only* place bot-versus-user is named. Action schemas stay
 * transport-agnostic so one catalog, one character, and one memory projection
 * serve both planes; the runtime binding decides availability.
 */
export const DiscordTransportKindSchema = z.enum(["bot", "user_session"]);
export type DiscordTransportKind = z.infer<typeof DiscordTransportKindSchema>;

/** Public-safe categories for deterministic Discord tool-progress UI. */
export const DiscordToolProgressCategorySchema = z.enum([
  "browsing",
  "creating_media",
  "working_locally",
  "using_connected_services",
  "playing",
  "using_tools",
]);
export type DiscordToolProgressCategory = z.infer<typeof DiscordToolProgressCategorySchema>;

export const DiscordToolProgressPhaseSchema = z.enum(["running", "completed", "failed", "dismissed"]);
export type DiscordToolProgressPhase = z.infer<typeof DiscordToolProgressPhaseSchema>;

/** Transport-agnostic Discord presence action names (ADR 0024). No bot/user token fields. */
export const DiscordPresenceActionSchema = z.enum([
  "discord.presence.reply",
  /**
   * His reply, with a picture he made during the same turn (ADR 0085).
   *
   * A separate action rather than an optional field on `reply` so the frozen
   * risk-class table below states the truth about what may carry bytes into a
   * channel. It is narrative-write because the payload can only reference media
   * a governed service-side host minted — the generator or the browser host, see
   * `isAttachableTurnMediaRef`. Any other artifact is still `send_attachment`,
   * still publish-external, still approval-gated.
   */
  "discord.presence.reply_with_media",
  "discord.presence.react",
  "discord.presence.unreact",
  "discord.presence.send_message",
  "discord.presence.tool_progress",
  "discord.presence.edit_own_message",
  "discord.presence.delete_own_message",
  "discord.presence.send_attachment",
  "discord.presence.typing_start",
  "discord.presence.create_thread",
  "discord.presence.join_thread",
  "discord.presence.voice_join",
  "discord.presence.voice_leave",
  "discord.presence.go_live_start",
  "discord.presence.go_live_stop",
  "discord.presence.activity_start",
  "discord.presence.activity_stop",
]);
export type DiscordPresenceAction = z.infer<typeof DiscordPresenceActionSchema>;

const DiscordCaptainActionContextSchema = z.object({
  callId: z.string().min(1).max(256),
  actorId: z.string().min(1).max(128),
  guildId: z.string().min(1).max(128).optional(),
  channelId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128),
});

/** IDs are host-stamped from the active turn; the model supplies only action content. */
export const DiscordCaptainActionInputSchema = z.discriminatedUnion("action", [
  DiscordServerActionSchema.extend({
    action: z.literal("server_action"),
    callId: z.string().min(1).max(256),
    source: z.enum(["operator", "discord"]),
    sourceGuildId: z
      .string()
      .regex(/^\d{5,32}$/u)
      .optional(),
  }).strict(),
  DiscordCaptainActionContextSchema.extend({
    action: z.literal("react"),
    emoji: z.string().trim().min(1).max(64),
  }).strict(),
  DiscordCaptainActionContextSchema.extend({
    action: z.literal("unreact"),
    emoji: z.string().trim().min(1).max(64),
  }).strict(),
  DiscordCaptainActionContextSchema.extend({
    action: z.literal("create_thread"),
    name: z.string().trim().min(1).max(100),
  }).strict(),
  DiscordCaptainActionContextSchema.extend({ action: z.literal("join_thread") }).strict(),
  /**
   * A text update posted while the turn is still running (ADR 0118).
   * A turn is allowed to take as long as the work takes; this is how the room
   * finds out that is what is happening instead of watching an indicator.
   */
  DiscordCaptainActionContextSchema.extend({
    action: z.literal("send_text_update"),
    text: z.string().trim().min(1).max(600),
  }).strict(),
  /**
   * A finished reply no body is holding a delivery for: a room turn woken by a
   * Herdr watch it armed answers the message it was armed from (ADR 0186).
   */
  DiscordCaptainActionContextSchema.extend({
    action: z.literal("send_reply"),
    text: z.string().trim().min(1).max(2_000),
  }).strict(),
  /**
   * "He has started writing" — the mid-turn signal ADR 0118 left unbuilt.
   * Host-stamped from the reply stream, never a model tool: it carries no
   * content and posts nothing, it only lets the body light the indicator on a
   * delivery it is already holding.
   */
  DiscordCaptainActionContextSchema.extend({ action: z.literal("typing") }).strict(),
  DiscordCaptainActionContextSchema.extend({
    action: z.literal("tool_progress"),
    phase: DiscordToolProgressPhaseSchema,
    categories: z.array(DiscordToolProgressCategorySchema).min(1).max(6),
    toolCalls: z.number().int().nonnegative(),
    activeToolCalls: z.number().int().nonnegative(),
    failedToolCalls: z.number().int().nonnegative(),
    elapsedSeconds: z.number().int().nonnegative(),
    progressMessageId: z.string().min(1).max(128).optional(),
  }).strict(),
  DiscordCaptainActionContextSchema.extend({
    action: z.literal("watch_start"),
    surface: z.enum(["gba_emulator", "minecraft"]).optional(),
    guildId: z.string().min(1).max(128),
  }).strict(),
  DiscordCaptainActionContextSchema.extend({
    action: z.literal("watch_stop"),
    guildId: z.string().min(1).max(128),
  }).strict(),
]);
export type DiscordCaptainActionInput = z.infer<typeof DiscordCaptainActionInputSchema>;

export const DiscordCaptainActionResultSchema = z
  .object({
    bodyLease: BodyLeaseResultSchema.optional(),
    ok: z.boolean(),
    message: z.string().min(1).max(1_000),
    messageId: z.string().min(1).max(128).optional(),
    resourceId: z
      .string()
      .regex(/^\d{5,32}$/u)
      .optional(),
    data: z.json().optional(),
  })
  .strict();
export type DiscordCaptainActionResult = z.infer<typeof DiscordCaptainActionResultSchema>;

/**
 * Rendered surfaces the activity plane may publish (ADR 0047). Frozen lab
 * catalog: the executor maps a surface to its configured Discord application id
 * so a model can never name an arbitrary application to launch.
 */
export const DiscordActivitySurfaceSchema = z.enum(["gba_emulator", "minecraft"]);
export type DiscordActivitySurface = z.infer<typeof DiscordActivitySurfaceSchema>;

export const DiscordPresenceActionRiskClassSchema = z.enum([
  "narrative-write",
  "reversible-write",
  "publish-external",
  "destructive",
]);
export type DiscordPresenceActionRiskClass = z.infer<typeof DiscordPresenceActionRiskClassSchema>;

export const DISCORD_PRESENCE_ACTION_RISK_CLASS: Readonly<
  Record<DiscordPresenceAction, DiscordPresenceActionRiskClass>
> = {
  "discord.presence.reply": "narrative-write",
  "discord.presence.reply_with_media": "narrative-write",
  "discord.presence.react": "narrative-write",
  "discord.presence.unreact": "narrative-write",
  "discord.presence.send_message": "narrative-write",
  "discord.presence.tool_progress": "narrative-write",
  "discord.presence.edit_own_message": "reversible-write",
  "discord.presence.delete_own_message": "reversible-write",
  "discord.presence.send_attachment": "publish-external",
  "discord.presence.typing_start": "narrative-write",
  "discord.presence.create_thread": "reversible-write",
  "discord.presence.join_thread": "reversible-write",
  "discord.presence.voice_join": "reversible-write",
  "discord.presence.voice_leave": "reversible-write",
  "discord.presence.go_live_start": "publish-external",
  "discord.presence.go_live_stop": "publish-external",
  "discord.presence.activity_start": "publish-external",
  "discord.presence.activity_stop": "publish-external",
};

export const DiscordPresenceChannelIdentitySchema = z
  .object({
    missionId: MissionIdSchema.optional(),
    taskId: TaskIdSchema.optional(),
    workerRunId: WorkerRunIdSchema.optional(),
    /** Stable bounded-turn scope when ambient presence is not coupled to a mission. */
    presenceSessionId: z.string().min(1).optional(),
    correlationId: z.string().min(1),
    profileHash: z.string().min(1),
    characterId: CharacterIdSchema,
    credentialRef: z.string().min(1),
    transportKind: DiscordTransportKindSchema,
  })
  .strict();
export type DiscordPresenceChannelIdentity = z.infer<typeof DiscordPresenceChannelIdentitySchema>;

export const DISCORD_PRESENCE_TRIGGER_BODY_MAX = 16_384;
export const DISCORD_PRESENCE_CONTEXT_MESSAGES_MAX = 50;

/**
 * Images he can actually be shown. Deliberately the intersection of what
 * Discord serves and what vision models accept — an unsupported type is
 * dropped at ingress rather than fetched and rejected at the model.
 */
export const DISCORD_PRESENCE_ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type DiscordPresenceAttachmentMediaType = (typeof DISCORD_PRESENCE_ATTACHMENT_MEDIA_TYPES)[number];

/**
 * Discord allows ten attachments per message; he is shown at most four. A turn
 * that inlines images pays for every one of them in the model call, and four is
 * already more than a person takes in from one message.
 */
export const DISCORD_PRESENCE_TRIGGER_ATTACHMENTS_MAX = 4;
/** A moving embed becomes at most four chronological image parts for image-only vision models. */
export const DISCORD_PRESENCE_MOTION_FRAMES_MAX = 4;
/** Per-image ceiling. Enforced at ingress on Discord's stated size and again on the bytes actually read. */
export const DISCORD_PRESENCE_ATTACHMENT_BYTES_MAX = 8 * 1024 * 1024;

/**
 * One image on the trigger message, carried as a reference rather than bytes.
 *
 * The control plane stays a control plane: what crosses it is a URL and its
 * metadata, and the bytes are fetched once at the last hop before the model
 * (see `discord-attachment-fetch`). Passing base64 through here instead would
 * put multi-megabyte payloads into every turn request, receipt fingerprint, and
 * idempotency hash on the path.
 */
export const DiscordPresenceAttachmentSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().url(),
    /** Discord-proxied MP4 for a gifv embed; absent for ordinary images. */
    motionUrl: z.string().url().optional(),
    mediaType: z.enum(DISCORD_PRESENCE_ATTACHMENT_MEDIA_TYPES),
    filename: z.string().min(1).max(256).optional(),
    /** Discord uploads declare a size; proxied embed previews are bounded only when fetched. */
    byteSize: z.number().int().positive().max(DISCORD_PRESENCE_ATTACHMENT_BYTES_MAX).optional(),
  })
  .strict();
export type DiscordPresenceAttachment = z.infer<typeof DiscordPresenceAttachmentSchema>;

export const DiscordVoicePresenceResultReasonSchema = z.enum([
  "authority",
  "allowlist",
  "not_in_voice",
  "voice_disabled",
  "other_guild",
  "no_owner",
  "ambiguous",
  "failed",
]);
export type DiscordVoicePresenceResultReason = z.infer<typeof DiscordVoicePresenceResultReasonSchema>;

/**
 * What the live Discord body did when the captain used a voice-presence tool.
 * The body resolves the destination and enforces authority; the model supplies
 * neither ids nor an explanation of the result. A Discord turn follows the
 * authenticated speaker in that guild. An operator turn follows the configured
 * owner into their current allowlisted voice channel (`no_owner` / `ambiguous`).
 */
export const DiscordVoicePresenceResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("joined"),
      channelId: z.string().min(1),
      /** Whether the authenticated speaker can be heard under the room's current consent policy. */
      actorCanBeHeard: z.boolean(),
      /** Whether exact consented speech is retained in the private local development log. */
      transcriptLoggingEnabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("join_refused"),
      reason: DiscordVoicePresenceResultReasonSchema,
      bodyLease: BodyLeaseResultSchema.optional(),
    })
    .strict(),
  z.object({ action: z.literal("left"), channelId: z.string().min(1).optional() }).strict(),
  z
    .object({
      action: z.literal("leave_refused"),
      reason: DiscordVoicePresenceResultReasonSchema,
      bodyLease: BodyLeaseResultSchema.optional(),
    })
    .strict(),
]);
export type DiscordVoicePresenceResult = z.infer<typeof DiscordVoicePresenceResultSchema>;

export const DiscordPresenceChannelTurnRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    deliveryId: z.string().min(1),
    identity: DiscordPresenceChannelIdentitySchema,
    /** Gateway-observed display names for discovery only; IDs remain the authority and route. */
    room: z
      .object({
        guildName: z.string().trim().min(1).max(100).optional(),
        channelName: z.string().trim().min(1).max(100).optional(),
        peerName: z.string().trim().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    trigger: z
      .object({
        kind: z.enum(["message", "mention", "dm", "reaction", "voice_event", "slash_handoff"]),
        id: z.string().min(1),
        guildId: z.string().min(1).optional(),
        channelId: z.string().min(1),
        messageId: z.string().min(1).optional(),
        actorId: z.string().min(1),
        body: z.string().min(1).max(DISCORD_PRESENCE_TRIGGER_BODY_MAX).optional(),
        /**
         * Images posted with the trigger message. An image is part of what was
         * said, so a message carrying only images is a real turn with an empty
         * body — see the request-level refinement below (ADR 0081).
         */
        attachments: z
          .array(DiscordPresenceAttachmentSchema)
          .max(DISCORD_PRESENCE_TRIGGER_ATTACHMENTS_MAX)
          .default([]),
        /**
         * Attachments the ingress policy left out — wrong type, oversized, or
         * past the per-message cap. A count, never a filename: he is told
         * something went unread so he can say so, and the untrusted message
         * never gets to author a sentence about it (ADR 0072).
         */
        attachmentsOmitted: z.number().int().positive().optional(),
        /**
         * Nobody addressed him: this reached him because he had been talking to
         * this person, not because they used his name. Framing only — he may
         * stay silent on any turn — but he should know whether he was asked.
         */
        unprompted: z.boolean().optional(),
      })
      .strict(),
    contextMessages: z
      .array(
        z
          .object({
            id: z.string().min(1),
            authorId: z.string().min(1),
            body: z.string().max(DISCORD_PRESENCE_TRIGGER_BODY_MAX),
            createdAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(DISCORD_PRESENCE_CONTEXT_MESSAGES_MAX)
      .default([]),
    /** The newest visual source in bounded context; motion may expand it into sampled frames. */
    contextVisual: z
      .object({
        sourceMessageId: z.string().min(1),
        attachment: DiscordPresenceAttachmentSchema.optional(),
        attachmentsOmitted: z.number().int().positive().optional(),
      })
      .strict()
      .refine(
        (visual) => visual.attachment !== undefined || visual.attachmentsOmitted !== undefined,
        "A context visual must carry an image or an omitted count",
      )
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.identity.missionId === undefined && request.identity.presenceSessionId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["identity", "presenceSessionId"],
        message: "Discord channel turns require missionId or presenceSessionId attribution",
      });
    }
    if (
      request.contextVisual !== undefined &&
      !request.contextMessages.some((message) => message.id === request.contextVisual?.sourceMessageId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["contextVisual", "sourceMessageId"],
        message: "A context visual must belong to a bounded context message",
      });
    }
    // A turn must carry something he can perceive. Text or images both qualify;
    // neither is required on its own, because "here, look at this" with no
    // caption is an ordinary thing for a person to send (ADR 0081).
    if ((request.trigger.body ?? "").trim().length === 0 && request.trigger.attachments.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["trigger", "body"],
        message: "Discord channel turns require a trigger body or at least one attachment",
      });
    }
  });
export type DiscordPresenceChannelTurnRequest = z.infer<typeof DiscordPresenceChannelTurnRequestSchema>;

export const DiscordPresenceActionRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reply"),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
      content: z.string().min(1).max(2_000),
    })
    .strict(),
  /**
   * The schema itself refuses anything but generated media, so the narrative
   * classification cannot be widened by a caller passing a different ref. The
   * service re-checks it at the route: a boundary asserted in one place
   * is a boundary that moves when someone refactors the other.
   */
  z
    .object({
      kind: z.literal("reply_with_media"),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
      content: z.string().min(1).max(2_000),
      artifactRef: z
        .string()
        .refine(isAttachableTurnMediaRef, "expected a generated-media or browser artifact reference"),
      filename: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("react"),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
      emoji: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unreact"),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
      emoji: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("send_message"),
      channelId: z.string().min(1),
      content: z.string().min(1).max(2_000),
      replyToMessageId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_progress"),
      channelId: z.string().min(1),
      replyToMessageId: z.string().min(1),
      messageId: z.string().min(1).optional(),
      phase: DiscordToolProgressPhaseSchema,
      categories: z.array(DiscordToolProgressCategorySchema).min(1).max(6),
      toolCalls: z.number().int().nonnegative(),
      activeToolCalls: z.number().int().nonnegative(),
      failedToolCalls: z.number().int().nonnegative(),
      elapsedSeconds: z.number().int().nonnegative(),
    })
    .strict()
    .superRefine((progress, context) => {
      if (progress.activeToolCalls > progress.toolCalls || progress.failedToolCalls > progress.toolCalls) {
        context.addIssue({
          code: "custom",
          path: ["toolCalls"],
          message: "Tool progress counts cannot exceed total tool calls",
        });
      }
      if (progress.phase === "running" && progress.toolCalls === 0) {
        context.addIssue({
          code: "custom",
          path: ["toolCalls"],
          message: "Running tool progress requires at least one tool call",
        });
      }
      if (progress.phase === "dismissed" && progress.messageId === undefined) {
        context.addIssue({
          code: "custom",
          path: ["messageId"],
          message: "Dismissed tool progress requires its message id",
        });
      }
    }),
  z
    .object({
      kind: z.literal("edit_own_message"),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
      content: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delete_own_message"),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("send_attachment"),
      channelId: z.string().min(1),
      content: z.string().max(2_000).optional(),
      artifactRef: z.string().min(1),
      filename: z.string().min(1).max(256),
    })
    .strict(),
  z.object({ kind: z.literal("typing_start"), channelId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("create_thread"),
      channelId: z.string().min(1),
      messageId: z.string().min(1).optional(),
      name: z.string().min(1).max(100),
    })
    .strict(),
  z.object({ kind: z.literal("join_thread"), channelId: z.string().min(1) }).strict(),
  z
    .object({ kind: z.literal("voice_join"), guildId: z.string().min(1), channelId: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("voice_leave"), guildId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("go_live_start"),
      guildId: z.string().min(1),
      channelId: z.string().min(1),
      /** Optional http(s) media URL. Absent, the lab body publishes his live play surface. */
      sourceUrl: z.string().url().max(2_000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("go_live_stop"), guildId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("activity_start"),
      guildId: z.string().min(1),
      channelId: z.string().min(1),
      surface: DiscordActivitySurfaceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("activity_stop"),
      guildId: z.string().min(1),
      channelId: z.string().min(1),
    })
    .strict(),
]);
export type DiscordPresenceActionRequest = z.infer<typeof DiscordPresenceActionRequestSchema>;

export const DISCORD_PRESENCE_ACTION_PAYLOAD_KIND: Readonly<
  Record<DiscordPresenceAction, DiscordPresenceActionRequest["kind"]>
> = {
  "discord.presence.reply": "reply",
  "discord.presence.reply_with_media": "reply_with_media",
  "discord.presence.react": "react",
  "discord.presence.unreact": "unreact",
  "discord.presence.send_message": "send_message",
  "discord.presence.tool_progress": "tool_progress",
  "discord.presence.edit_own_message": "edit_own_message",
  "discord.presence.delete_own_message": "delete_own_message",
  "discord.presence.send_attachment": "send_attachment",
  "discord.presence.typing_start": "typing_start",
  "discord.presence.create_thread": "create_thread",
  "discord.presence.join_thread": "join_thread",
  "discord.presence.voice_join": "voice_join",
  "discord.presence.voice_leave": "voice_leave",
  "discord.presence.go_live_start": "go_live_start",
  "discord.presence.go_live_stop": "go_live_stop",
  "discord.presence.activity_start": "activity_start",
  "discord.presence.activity_stop": "activity_stop",
};

export const DiscordPresenceWriteSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Host-stamped original Discord delivery, resolved against durable service admission. */
    sourceDeliveryId: z.string().min(1).max(128).optional(),
    idempotencyKey: z.string().min(1),
    action: DiscordPresenceActionSchema,
    identity: DiscordPresenceChannelIdentitySchema,
    /**
     * Optional ledger attribution. When omitted, `resolveDiscordPresenceLedgerContent`
     * derives a non-empty string from the payload (emoji, filename, typing sentinel, …).
     */
    content: z.string().min(1).max(16_384).optional(),
    payload: DiscordPresenceActionRequestSchema,
  })
  .strict()
  .superRefine((write, context) => {
    const expectedKind = DISCORD_PRESENCE_ACTION_PAYLOAD_KIND[write.action];
    if (write.payload.kind !== expectedKind) {
      context.addIssue({
        code: "custom",
        path: ["payload", "kind"],
        message: `${write.action} requires payload kind ${expectedKind}`,
      });
    }
    if (write.identity.missionId === undefined && write.identity.presenceSessionId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["identity", "presenceSessionId"],
        message: "Discord presence writes require missionId or presenceSessionId attribution",
      });
    }
    if (
      DISCORD_PRESENCE_ACTION_RISK_CLASS[write.action] !== "narrative-write" &&
      write.identity.missionId === undefined &&
      // Grounded social actions originate in an authenticated ambient turn and
      // attribute to that presence session. The body supplies every target id;
      // this widens attribution, never authority.
      !(
        [
          "discord.presence.create_thread",
          "discord.presence.join_thread",
          "discord.presence.go_live_start",
          "discord.presence.go_live_stop",
          "discord.presence.activity_start",
          "discord.presence.activity_stop",
        ].includes(write.action) && write.identity.presenceSessionId !== undefined
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["identity", "missionId"],
        message: "Non-narrative Discord presence writes require mission attribution",
      });
    }
  });
export type DiscordPresenceWrite = z.infer<typeof DiscordPresenceWriteSchema>;

/**
 * Content used by the narrative rate/volume ledger. Prefer explicit `content`,
 * otherwise derive from the transport-agnostic payload so react/typing need no
 * fabricated body.
 */
export function resolveDiscordPresenceLedgerContent(
  write: Pick<DiscordPresenceWrite, "content" | "payload">,
): string {
  if (write.content !== undefined && write.content.length > 0) return write.content;
  const { payload } = write;
  switch (payload.kind) {
    case "reply":
    case "send_message":
    case "edit_own_message":
    case "reply_with_media":
      return payload.content;
    case "tool_progress":
      return `tool_progress:${payload.phase}`;
    case "react":
    case "unreact":
      return payload.emoji;
    case "typing_start":
      return "typing";
    case "send_attachment":
      return payload.content && payload.content.length > 0 ? payload.content : payload.filename;
    case "delete_own_message":
      return "delete";
    case "create_thread":
      return payload.name;
    case "join_thread":
      return "join_thread";
    case "voice_join":
    case "voice_leave":
    case "go_live_start":
    case "go_live_stop":
    case "activity_stop":
      return payload.kind;
    case "activity_start":
      return `${payload.kind}:${payload.surface}`;
    default: {
      const _exhaustive: never = payload;
      return String(_exhaustive);
    }
  }
}

export const DiscordPresenceWriteResultSchema = z
  .object({
    id: z.string().min(1),
    action: DiscordPresenceActionSchema,
    transportKind: DiscordTransportKindSchema,
    channelId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
  })
  .strict();
export type DiscordPresenceWriteResult = z.infer<typeof DiscordPresenceWriteResultSchema>;

/**
 * Durable owner opt-in for the user-session transport (ADR 0048).
 *
 * Discord forbids automating normal user accounts, so the capability cannot be
 * reached by configuration alone: an operator-authenticated record must exist,
 * bound to the profile hash that was in force when the risk was accepted.
 * Changing that hash therefore invalidates the opt-in rather than silently
 * carrying an acceptance across a policy change.
 */
export const DiscordUserSessionOptInSchema = z
  .object({
    schemaVersion: z.literal(1),
    optInId: z.string().min(1),
    characterId: CharacterIdSchema,
    /** Broker credential reference. Token material is never carried here. */
    credentialRef: z.string().min(1),
    profileHash: z.string().min(1),
    /** Free-form acknowledgement the operator typed; retained for audit. */
    acknowledgement: z.string().min(1).max(2_048),
    guildIds: z.array(z.string().min(1)).min(1).max(64),
    channelIds: z.array(z.string().min(1)).min(1).max(256),
    dmPolicy: z.enum(["deny", "owner_only", "allowlist"]),
    recordedAt: z.string().datetime(),
    revokedAt: z.string().datetime().optional(),
  })
  .strict();
export type DiscordUserSessionOptIn = z.infer<typeof DiscordUserSessionOptInSchema>;

/** Operator request body that mints a {@link DiscordUserSessionOptIn}. */
export const DiscordUserSessionOptInRequestSchema = DiscordUserSessionOptInSchema.pick({
  characterId: true,
  acknowledgement: true,
  guildIds: true,
  channelIds: true,
  dmPolicy: true,
})
  .extend({ schemaVersion: z.literal(1) })
  .strict();
export type DiscordUserSessionOptInRequest = z.infer<typeof DiscordUserSessionOptInRequestSchema>;

/**
 * A Discord Go Live / screen share the bridges have observed.
 *
 * Metadata only: who, where, whether the lab body is watching. Raw video never
 * enters this record. A still, when one exists, is a host-minted artifact.
 */
export const DiscordActiveStreamSchema = z
  .object({
    schemaVersion: z.literal(1),
    streamKey: z.string().min(1).max(200),
    kind: z.enum(["guild", "call"]),
    guildId: z.string().min(1).optional(),
    channelId: z.string().min(1),
    userId: z.string().min(1),
    watching: z.boolean(),
    hasFrame: z.boolean(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type DiscordActiveStream = z.infer<typeof DiscordActiveStreamSchema>;

export const DiscordStreamWatchFrameSchema = z
  .object({
    schemaVersion: z.literal(1),
    streamKey: z.string().min(1).max(200),
    userId: z.string().min(1),
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
    jpegBase64: z.string().min(1).max(8_000_000),
    capturedAt: z.string().datetime(),
  })
  .strict();
export type DiscordStreamWatchFrame = z.infer<typeof DiscordStreamWatchFrameSchema>;

/** Four 1 fps share samples: enough for coarse motion without feeding video continuously. */
export const DISCORD_STREAM_WATCH_FRAME_HISTORY_MAX = 4;

const DiscordStreamWatchObservationFrameSchema = DiscordStreamWatchFrameSchema.omit({ schemaVersion: true })
  .extend({ artifactRef: z.string().optional() })
  .strict();

/** What a bridge posts when a share starts, stops, or yields a still. */
export const DiscordStreamWatchReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.enum(["bot", "user_session"]).default("user_session"),
    streams: z.array(DiscordActiveStreamSchema).max(16),
    frame: DiscordStreamWatchFrameSchema.optional(),
    decoder: z.enum(["ready", "missing", "error", "idle"]).optional(),
    decoderDetail: z.string().max(400).optional(),
  })
  .strict();
export type DiscordStreamWatchReport = z.infer<typeof DiscordStreamWatchReportSchema>;

/** Captain/operator read of the live share projection. */
export const DiscordStreamWatchObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    streams: z.array(DiscordActiveStreamSchema).max(16),
    frame: DiscordStreamWatchObservationFrameSchema.optional(),
    /** Chronological coarse-motion samples, oldest to newest. `frame` remains the latest for compatibility. */
    frames: z
      .array(DiscordStreamWatchObservationFrameSchema)
      .max(DISCORD_STREAM_WATCH_FRAME_HISTORY_MAX)
      .optional(),
    decoder: z.enum(["ready", "missing", "error", "idle"]),
    decoderDetail: z.string().max(400).optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .strict();
export type DiscordStreamWatchObservation = z.infer<typeof DiscordStreamWatchObservationSchema>;

export const DISCORD_STREAM_WATCH_PATH = "/v1/discord/stream-watch";
