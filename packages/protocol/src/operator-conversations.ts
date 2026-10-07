import { CheckoutStatusSchema } from "./checkouts.ts";
import { OperatorSeatEfficiencySchema } from "./seat-efficiency.ts";
import { WorkerReportSummarySchema } from "./worker-reports.ts";
import { WorkerReportBridgeStatusSchema } from "./worker-report-health.ts";
import { FleetSeatToolCatalogHealthSchema } from "./tool-catalog.ts";
import { z } from "zod";
import { OperatorAgentRoleSchema } from "./agent-roles.ts";
import { ProjectIdSchema } from "./projects.ts";
import { OperatorGoalSchema, OperatorWorkAssignmentSchema } from "./agent-work.ts";
import { HireProfileSchema } from "./hire-profile.ts";
import { DeliveryStageSchema } from "./delivery.ts";
import { isCanonicalBase64 } from "./base64.ts";
import { FleetResourceSnapshotSchema } from "./fleet-resources.ts";

// ---------------------------------------------------------------------------
// Operator conversations (ADR 0032, VUH-769).
//
// Every schema below is a STRICT, provider-neutral, bounded public boundary
// that RN/macOS/TUI consume through `@clankie/protocol` alone. Unknown fields
// are rejected, not stripped; there is no `provider`, continuation-token, or
// credential-shaped field anywhere in the surface, and every string/collection
// is length-bounded so the shared app stream cannot carry an unbounded or
// credential-bearing escape payload.
// ---------------------------------------------------------------------------

/** Bounds shared by the operator conversation boundary (documented, not magic). */
export const OPERATOR_CONVERSATION_TITLE_MAX = 256;
export const OPERATOR_CONVERSATION_TEXT_MAX = 16_384;
export const OPERATOR_CONVERSATION_SUMMARY_MAX = 512;
export const OPERATOR_CONVERSATION_TOOL_DETAIL_MAX = OPERATOR_CONVERSATION_TEXT_MAX;
/** A submitted message is durably logged as a `message` event, so it shares that bound. */
export const OPERATOR_CONVERSATION_MESSAGE_MAX = OPERATOR_CONVERSATION_TEXT_MAX;
export const OPERATOR_CONVERSATION_CODE_MAX = 128;
export const OPERATOR_CONVERSATION_REF_MAX = 512;
export const OPERATOR_DELIVERED_FILE_BYTES_MAX = 15 * 1024 * 1024;
export const OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH = "/operator/v1/artifacts/download";
/** A filesystem path, bounded well under PATH_MAX so it never truncates a real one. */
export const OPERATOR_SEAT_DIRECTORY_MAX = 1024;
/** A model spelling is a harness CLI value — `provider/id`, a pattern, an alias — never a path. */
export const OPERATOR_SEAT_MODEL_MAX = 256;
/** An effort spelling is a short level word — low, high, xhigh — in the harness's own vocabulary. */
export const OPERATOR_SEAT_EFFORT_MAX = 64;
export const OPERATOR_CONVERSATION_INPUT_OPTIONS_MAX = 32;
export const OPERATOR_CONVERSATION_REPLAY_LIMIT_MAX = 500;
export const OPERATOR_CONVERSATION_REPLAY_LIMIT_DEFAULT = 200;
export const OPERATOR_CONVERSATION_WINDOW_TURNS_DEFAULT = 20;
export const OPERATOR_CONVERSATION_WINDOW_TURNS_MAX = 40;
/**
 * Longest a tail request may park on the server waiting for the next change
 * ([ADR 0141](../../../docs/adr/0141-the-console-watches-him-type.md)). Bounded
 * so a parked request never outlives a proxy hop or a service restart.
 */
export const OPERATOR_CONVERSATION_TAIL_WAIT_MS_MAX = 20_000;
/** Public list responses are bounded so the app boundary carries no unbounded collection. */
export const OPERATOR_CONVERSATION_LIST_MAX = 1_000;

/** Locally-bounded worker run id for steering — never the globally-unbounded WorkerRunIdSchema. */
export const OperatorConversationWorkerRunIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(OPERATOR_CONVERSATION_REF_MAX);
export type OperatorConversationWorkerRunId = z.infer<typeof OperatorConversationWorkerRunIdSchema>;

export const OperatorConversationIdSchema = z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX);
export type OperatorConversationId = z.infer<typeof OperatorConversationIdSchema>;
export const OperatorSurfaceClientIdSchema = z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX);
export type OperatorSurfaceClientId = z.infer<typeof OperatorSurfaceClientIdSchema>;
export const OperatorConversationCursorSchema = z.string().trim().min(1).max(4096);
export type OperatorConversationCursor = z.infer<typeof OperatorConversationCursorSchema>;
export const OperatorConversationRunIdSchema = z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX);
export type OperatorConversationRunId = z.infer<typeof OperatorConversationRunIdSchema>;
export const OperatorConversationEventRefSchema = z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX);

export const OperatorDeliveredFileSchema = z
  .object({
    artifactId: OperatorConversationEventRefSchema,
    filename: z.string().trim().min(1).max(256),
    mediaType: z.string().trim().min(1).max(256),
    byteCount: z.number().int().nonnegative().max(OPERATOR_DELIVERED_FILE_BYTES_MAX),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type OperatorDeliveredFile = z.infer<typeof OperatorDeliveredFileSchema>;

export const OperatorDeliveredFileDownloadRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: OperatorConversationIdSchema,
    artifactId: OperatorConversationEventRefSchema,
  })
  .strict();
export type OperatorDeliveredFileDownloadRequest = z.infer<typeof OperatorDeliveredFileDownloadRequestSchema>;

// ---------------------------------------------------------------------------
// Owner attachments (ADR 0209): images and video the owner attaches in a
// composer, uploaded in chunks because the relay and the gateway's encrypted
// envelope each carry at most 1 MiB per request. A committed upload is stored
// beside the conversation's delivered files, with the same retention, and is
// named by the same kind of reference.
// ---------------------------------------------------------------------------

/** Media an owner may attach. HEIC/HEIF is converted to JPEG for harnesses that cannot read it. */
export const OPERATOR_ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
] as const;
export type OperatorAttachmentMediaType = (typeof OPERATOR_ATTACHMENT_MEDIA_TYPES)[number];
/** A 48 MP phone photo or a large screenshot fits; anything bigger is not a photo. */
export const OPERATOR_ATTACHMENT_IMAGE_BYTES_MAX = 20 * 1024 * 1024;
/** A couple of minutes of 4K phone video, or several of 1080p; bounded disk and upload time. */
export const OPERATOR_ATTACHMENT_VIDEO_BYTES_MAX = 200 * 1024 * 1024;
/**
 * Raw bytes per chunk. Base64 grows them to 699,052 characters, which leaves
 * room for the JSON request inside the relay's 1 MiB body limit and the public
 * gateway's 1 MiB encrypted plaintext.
 */
export const OPERATOR_ATTACHMENT_CHUNK_BYTES_MAX = 512 * 1024;
export const OPERATOR_ATTACHMENT_CHUNK_BASE64_MAX = Math.ceil(OPERATOR_ATTACHMENT_CHUNK_BYTES_MAX / 3) * 4;
/** Attachments one message may carry. */
export const OPERATOR_CONVERSATION_ATTACHMENTS_MAX = 8;

export function operatorAttachmentBytesMax(mediaType: OperatorAttachmentMediaType): number {
  return mediaType.startsWith("video/")
    ? OPERATOR_ATTACHMENT_VIDEO_BYTES_MAX
    : OPERATOR_ATTACHMENT_IMAGE_BYTES_MAX;
}

export const OperatorAttachmentMediaTypeSchema = z.enum(OPERATOR_ATTACHMENT_MEDIA_TYPES);

/** A committed owner upload: an `OperatorDeliveredFile` whose size may reach the video cap. */
export const OperatorConversationAttachmentSchema = OperatorDeliveredFileSchema.extend({
  mediaType: OperatorAttachmentMediaTypeSchema,
  byteCount: z.number().int().positive().max(OPERATOR_ATTACHMENT_VIDEO_BYTES_MAX),
}).strict();
export type OperatorConversationAttachment = z.infer<typeof OperatorConversationAttachmentSchema>;

/** What a send names: an attachment committed to the same conversation. */
export const OperatorConversationAttachmentRefSchema = z
  .object({ artifactId: z.string().regex(/^[a-f0-9]{48}$/u) })
  .strict();
export type OperatorConversationAttachmentRef = z.infer<typeof OperatorConversationAttachmentRefSchema>;

export const OperatorAttachmentUploadIdSchema = z.string().regex(/^upload-[a-f0-9]{32}$/u);

export const BeginOperatorAttachmentUploadSchema = z
  .object({
    conversationId: OperatorConversationIdSchema,
    filename: z.string().trim().min(1).max(256),
    mediaType: OperatorAttachmentMediaTypeSchema,
    byteCount: z.number().int().positive().max(OPERATOR_ATTACHMENT_VIDEO_BYTES_MAX),
    /** Hex SHA-256 of the whole file; commit refuses bytes that do not match it. */
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type BeginOperatorAttachmentUpload = z.infer<typeof BeginOperatorAttachmentUploadSchema>;

export const OperatorAttachmentChunkSchema = z
  .object({
    conversationId: OperatorConversationIdSchema,
    uploadId: OperatorAttachmentUploadIdSchema,
    /** Must equal the bytes received so far; a retried last chunk is acknowledged again. */
    offset: z.number().int().nonnegative().max(OPERATOR_ATTACHMENT_VIDEO_BYTES_MAX),
    dataBase64: z
      .string()
      .max(OPERATOR_ATTACHMENT_CHUNK_BASE64_MAX)
      .refine(isCanonicalBase64, { message: "expected non-empty canonical base64" }),
  })
  .strict();
export type OperatorAttachmentChunk = z.infer<typeof OperatorAttachmentChunkSchema>;

export const OperatorAttachmentUploadRefusalReasonSchema = z.enum([
  "unknown_conversation",
  "unsupported_conversation",
  "unknown_upload",
  "offset_mismatch",
  "too_large",
  "incomplete",
  "hash_mismatch",
  "content_mismatch",
  "busy",
  "unavailable",
]);
export type OperatorAttachmentUploadRefusalReason = z.infer<
  typeof OperatorAttachmentUploadRefusalReasonSchema
>;

export const OperatorAttachmentUploadResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("uploading"),
      conversationId: OperatorConversationIdSchema,
      uploadId: OperatorAttachmentUploadIdSchema,
      byteCount: z.number().int().positive().max(OPERATOR_ATTACHMENT_VIDEO_BYTES_MAX),
      receivedBytes: z.number().int().nonnegative().max(OPERATOR_ATTACHMENT_VIDEO_BYTES_MAX),
      chunkBytes: z.number().int().positive().max(OPERATOR_ATTACHMENT_CHUNK_BYTES_MAX),
      /** An upload idle past this is discarded. */
      expiresAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      status: z.literal("committed"),
      conversationId: OperatorConversationIdSchema,
      file: OperatorConversationAttachmentSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      conversationId: OperatorConversationIdSchema,
      reason: OperatorAttachmentUploadRefusalReasonSchema,
      message: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX),
      /** Present on `offset_mismatch`: where the next chunk must start. */
      receivedBytes: z.number().int().nonnegative().max(OPERATOR_ATTACHMENT_VIDEO_BYTES_MAX).optional(),
    })
    .strict(),
]);
export type OperatorAttachmentUploadResult = z.infer<typeof OperatorAttachmentUploadResultSchema>;

export const OperatorConversationChannelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(OPERATOR_CONVERSATION_REF_MAX);
export type OperatorConversationChannelId = z.infer<typeof OperatorConversationChannelIdSchema>;

/** Durable character identity for one fleet agent, independent of any Herdr pane. */
export const OperatorAgentPersonaIdSchema = z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX);
export type OperatorAgentPersonaId = z.infer<typeof OperatorAgentPersonaIdSchema>;
/** One name that is valid in both the app and Discord's per-message webhook identity. */
export const OperatorAgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((name) => !/discord|clyde/iu.test(name), "Agent names cannot contain Discord or Clyde");
export const OperatorAgentAppearanceSchema = z
  .object({
    /** Gold belongs to the operator and is intentionally absent here. */
    variant: z.enum(["green", "teal", "amber", "dusk", "onyx", "azure"]),
    accessory: z.enum([
      "none",
      "lead",
      "planner",
      "implementer",
      "verifier",
      "reviewer",
      "debugger",
      "evaluator",
    ]),
    shape: z.enum(["circle", "squircle", "tile"]),
  })
  .strict();
export type OperatorAgentAppearance = z.infer<typeof OperatorAgentAppearanceSchema>;
/** Shared full-tuple default; six tints alone cannot identify a real fleet. */
export function defaultOperatorAgentAppearance(
  harness: string,
  personaId = harness,
): OperatorAgentAppearance {
  const variants = ["green", "teal", "amber", "dusk", "onyx", "azure"] as const;
  const accessories = [
    "none",
    "lead",
    "planner",
    "implementer",
    "verifier",
    "reviewer",
    "debugger",
    "evaluator",
  ] as const;
  const shapes = ["circle", "squircle", "tile"] as const;
  let hash = 2_166_136_261;
  for (const character of `${harness}\0${personaId}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  }
  let choice = hash % (variants.length * accessories.length * shapes.length);
  const variant = variants[choice % variants.length]!;
  choice = Math.floor(choice / variants.length);
  const accessory = accessories[choice % accessories.length]!;
  choice = Math.floor(choice / accessories.length);
  return { variant, accessory, shape: shapes[choice % shapes.length]! };
}
export const OperatorAgentPersonaSchema = z
  .object({
    schemaVersion: z.literal(1),
    personaId: OperatorAgentPersonaIdSchema,
    name: OperatorAgentNameSchema,
    appearance: OperatorAgentAppearanceSchema,
    /** The team role the owner (or the hire) assigned; absent means unassigned (ADR 0208). */
    role: OperatorAgentRoleSchema.optional(),
    /** Last known harness, retained while the persona has no live seat. */
    harness: z.string().trim().min(1).max(OPERATOR_CONVERSATION_CODE_MAX),
    /** Present while this character occupies a live Herdr seat. */
    activeSeatId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX).optional(),
    /** Present once the persona's durable DM exists. */
    conversationId: OperatorConversationIdSchema.optional(),
    /** SHA-256 of the current host-served PNG; also busts Discord's avatar cache. */
    avatarRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type OperatorAgentPersona = z.infer<typeof OperatorAgentPersonaSchema>;

export const UpdateOperatorAgentPersonaSchema = z
  .object({
    schemaVersion: z.literal(1),
    personaId: OperatorAgentPersonaIdSchema,
    /** Omit for an appearance/avatar-only change; preserve the current name atomically. */
    name: OperatorAgentNameSchema.optional(),
    /** Omit for a name-only change; preserve the current appearance atomically. */
    appearance: OperatorAgentAppearanceSchema.optional(),
    /** Optional exact app-rendered PNG. The host validates and serves it to Discord. */
    avatarPngBase64: z.string().min(1).max(700_000).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined || input.appearance !== undefined || input.avatarPngBase64 !== undefined,
    { message: "Provide a name, appearance or avatar" },
  );
export type UpdateOperatorAgentPersona = z.infer<typeof UpdateOperatorAgentPersonaSchema>;

/** Assign or clear a current member's project role; omission selects the default project. */
export const SetOperatorAgentPersonaRoleSchema = z
  .object({
    schemaVersion: z.literal(1),
    personaId: OperatorAgentPersonaIdSchema,
    role: OperatorAgentRoleSchema.nullable(),
    projectId: ProjectIdSchema.optional(),
  })
  .strict();
export type SetOperatorAgentPersonaRole = z.infer<typeof SetOperatorAgentPersonaRoleSchema>;

export const OperatorConversationScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  /** An external room's inspectable history; turns still enter through its authenticated transport. */
  z
    .object({
      kind: z.literal("room"),
      lane: z.enum(["discord_presence", "discord_voice"]),
      targetId: z.string().trim().min(1).max(512),
    })
    .strict(),
  z.object({ kind: z.literal("workspace"), workspaceId: z.string().trim().min(1).max(512) }).strict(),
  /** One DM thread per durable fleet character (ADR 0147). */
  z.object({ kind: z.literal("persona"), personaId: OperatorAgentPersonaIdSchema }).strict(),
  /** Legacy persisted scope. New surfaces create persona scopes. */
  z.object({ kind: z.literal("seat"), seatId: z.string().trim().min(1).max(512) }).strict(),
  /**
   * One conversation several seats share (ADR 0146). Membership lives on the
   * channel record, not here, so seats can join and leave without the
   * conversation changing identity.
   */
  z.object({ kind: z.literal("channel"), channelId: OperatorConversationChannelIdSchema }).strict(),
]);
export type OperatorConversationScope = z.infer<typeof OperatorConversationScopeSchema>;

/**
 * A channel costs one model call per member per message under sequential
 * turn-taking, so membership is bounded well below the roster ceiling. Wanting
 * more than this in one room is a sign the room should be split.
 */
export const OPERATOR_CHANNEL_MEMBER_MAX = 12;

/**
 * One room in the managed server a channel can be projected onto (ADR 0146).
 * Projection is not limited to rooms Clankie made: he owns Manage Webhooks in
 * the one server he controls, so any text or announcement channel there is a
 * place the fleet can be put without the owner copying a URL out of Server
 * Settings. A forum is a container: choosing one creates a distinct post for
 * the Clankie room. Servers he merely inhabits never appear here.
 */
export const DiscordGuildRoomIdSchema = z.string().trim().min(1).max(128);
export const DISCORD_GUILD_ROOM_MAX = 500;
export const DiscordGuildRoomTargetSchema = z
  .object({
    kind: z.enum(["channel", "forum"]),
    channelId: DiscordGuildRoomIdSchema,
  })
  .strict();
export type DiscordGuildRoomTarget = z.infer<typeof DiscordGuildRoomTargetSchema>;
export const DiscordGuildRoomSchema = z
  .object({
    kind: z.enum(["channel", "forum"]),
    channelId: DiscordGuildRoomIdSchema,
    name: z.string().trim().min(1).max(100),
  })
  .strict();
export type DiscordGuildRoom = z.infer<typeof DiscordGuildRoomSchema>;

/** A durable fleet character in a channel. The operator is implicit and always present. */
export const OperatorChannelMemberSchema = z
  .object({
    personaId: OperatorAgentPersonaIdSchema,
    /** Order the member is offered a turn in. Stable across restarts. */
    position: z.number().int().nonnegative(),
    joinedAt: z.string().datetime(),
  })
  .strict();
export type OperatorChannelMember = z.infer<typeof OperatorChannelMemberSchema>;

/**
 * The membership record behind a `channel` scope (ADR 0146). A channel is a
 * fan-out amplifier for anything an agent can do, so who is in it is an
 * operator decision and never an agent one — no op here lets a member add
 * itself or another seat.
 */
export const OperatorChannelSchema = z
  .object({
    schemaVersion: z.literal(1),
    channelId: OperatorConversationChannelIdSchema,
    conversationId: OperatorConversationIdSchema,
    title: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TITLE_MAX),
    members: z.array(OperatorChannelMemberSchema).max(OPERATOR_CHANNEL_MEMBER_MAX),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /** Present once the channel is projected onto a guild (ADR 0146). */
    discord: z
      .object({
        guildId: z.string().trim().min(1).max(128),
        /** The webhook's owning channel: direct room or parent forum. */
        channelId: z.string().trim().min(1).max(128),
        /** Present when the Clankie room lives in one post under a forum. */
        threadId: z.string().trim().min(1).max(128).optional(),
        /** Webhook id only. The token is a secret and never leaves the host. */
        webhookId: z.string().trim().min(1).max(128),
      })
      .strict()
      .optional(),
  })
  .strict();
export type OperatorChannel = z.infer<typeof OperatorChannelSchema>;

/**
 * The whole roster, restated. Membership arrives as the list the operator
 * wants, in the order turns are offered, and the host reconciles it — so
 * joining, leaving, and reordering are one op rather than three, and a member's
 * `joinedAt` survives a reorder. `channelId` absent creates a channel.
 */
export const UpsertOperatorChannelSchema = z
  .object({
    schemaVersion: z.literal(1),
    channelId: OperatorConversationChannelIdSchema.optional(),
    title: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TITLE_MAX),
    members: z.array(z.string().trim().min(1).max(512)).max(OPERATOR_CHANNEL_MEMBER_MAX),
    /**
     * Project the channel onto Discord (ADR 0146). Absent leaves an existing
     * projection exactly as it is.
     *
     * `provision` is the ordinary path and the one that makes rooms cheap to
     * create: Clankie makes the webhook himself inside the managed server — a fresh
     * channel when no `room` is given, an existing channel when one is named,
     * or a new post inside a selected forum.
     * `webhook` is the manual fallback for a webhook the owner made by hand in
     * that same server, for when Clankie lacks the permission to make one. It
     * is not a way into another guild: a URL resolving outside the managed server
     * is refused, and with no managed server set neither path projects anything.
     * `off` removes an existing projection: the room stays, with its whole
     * transcript, and stops posting to or hearing from the guild. A webhook
     * Clankie provisioned is deleted in Discord; a pasted one belongs to the
     * operator and is left in place. The Discord channel or forum post itself
     * is never deleted — what was said there stays readable.
     *
     * Either way the host keeps the token and only `webhookId` comes back out,
     * so this field is the one direction the secret ever moves.
     */
    discord: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("provision"),
            /** An existing container in the home guild; absent makes a text channel. */
            room: DiscordGuildRoomTargetSchema.optional(),
          })
          .strict(),
        z.object({ kind: z.literal("webhook"), webhookUrl: z.string().trim().min(1).max(512) }).strict(),
        z.object({ kind: z.literal("off") }).strict(),
      ])
      .optional(),
  })
  .strict();
export type UpsertOperatorChannel = z.infer<typeof UpsertOperatorChannelSchema>;

/**
 * The bridge handing the service one message typed in a guild channel a
 * Clankie channel is projected onto (ADR 0146).
 *
 * The projection map lives on the conversation, so the bridge does not carry a
 * copy of it that can go stale the moment a channel is projected. It asks about
 * each message instead, and the answer says whether the service took it.
 *
 * Discord identity policy stays on the bridge, which already owns it for
 * ingress: only messages the bridge is willing to attribute to the operator
 * reach here. A channel fans one message out to every seat in it, so the seat
 * that decides who may do that is the one that knows who is speaking.
 */
export const DiscordChannelProjectionMessagePath = "/v1/captain/channel-projection-messages";

export const DiscordChannelProjectionMessageSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Discord's message id; a redelivery of it must not run the round twice. */
    deliveryId: z.string().trim().min(1).max(128),
    guildId: z.string().trim().min(1).max(128),
    channelId: z.string().trim().min(1).max(128),
    body: z.string().trim().min(1).max(OPERATOR_CONVERSATION_MESSAGE_MAX),
  })
  .strict();
export type DiscordChannelProjectionMessage = z.infer<typeof DiscordChannelProjectionMessageSchema>;

export const DiscordChannelProjectionMessageResultSchema = z.discriminatedUnion("state", [
  /** No channel is projected here; the bridge carries on with ordinary ingress. */
  z.object({ schemaVersion: z.literal(1), state: z.literal("not_projected") }).strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      state: z.literal("accepted"),
      conversationId: OperatorConversationIdSchema,
      runId: OperatorConversationRunIdSchema,
    })
    .strict(),
]);
export type DiscordChannelProjectionMessageResult = z.infer<
  typeof DiscordChannelProjectionMessageResultSchema
>;

/**
 * A reaction on one transcript entry (ADR 0146). Deliberately a side-record
 * keyed by entry rather than a field on the entry itself: entries are
 * append-only and durable, reactions are mutable, and a reaction arriving must
 * not rewrite something already written.
 *
 * `reactor` is a seat id, or `operator` for the person. Agents react because
 * acknowledgement — seen, working on it, agreed — is worth saying and not worth
 * a transcript turn.
 */
export const OperatorConversationReactorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator") }).strict(),
  z.object({ kind: z.literal("seat"), seatId: z.string().trim().min(1).max(512) }).strict(),
]);
export type OperatorConversationReactor = z.infer<typeof OperatorConversationReactorSchema>;

export const OperatorConversationReactionSchema = z
  .object({
    conversationId: OperatorConversationIdSchema,
    entryRef: OperatorConversationEventRefSchema,
    emoji: z.string().trim().min(1).max(64),
    reactor: OperatorConversationReactorSchema,
    reactedAt: z.string().datetime(),
  })
  .strict();
export type OperatorConversationReaction = z.infer<typeof OperatorConversationReactionSchema>;

/**
 * What an agent is doing with its own body in the commons (ADR 0148).
 *
 * The roster already says what a pane *is observed* to be doing — running,
 * waiting, offline — and the app's figures read it. A stance is the other half:
 * what the agent *says* it is doing, in its own words, chosen by it.
 *
 * Three properties keep it honest. It is **attributed** — the service resolves
 * the seat from the pane the command ran in, so an agent can only move its own
 * figure and never another's. It **expires** — a stance is a live statement,
 * not a fact that accumulates, so a stale one falls back to the observed status
 * rather than outliving the agent that struck it. And it is **sayable** — the
 * note rides the seat, so every surface that lists the fleet can print it, which
 * is what keeps a graphical fact from being one only the room can see.
 *
 * Poses are meanings rather than sprite names; each surface owns its own art.
 */
export const OperatorAgentPoseSchema = z.enum([
  "working",
  "thinking",
  "stuck",
  "hauling",
  "resting",
  /** Just landed something (ADR 0162) — the agent-stated half of a reward. */
  "celebrate",
]);
export type OperatorAgentPose = z.infer<typeof OperatorAgentPoseSchema>;

/** Host-stated work kind (VUH-1719); never inferred from a caption or shell text. */
export const OperatorAgentActivityKindSchema = z.enum([
  "reading",
  "editing",
  "testing",
  "planning",
  "waiting",
]);
export type OperatorAgentActivityKind = z.infer<typeof OperatorAgentActivityKindSchema>;
export const OperatorAgentActivitySchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("native_tool"),
      kind: OperatorAgentActivityKindSchema,
      toolName: z.string().min(1).max(OPERATOR_CONVERSATION_CODE_MAX),
      startedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      source: z.literal("stated"),
      kind: OperatorAgentActivityKindSchema,
      statedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
    })
    .strict(),
]);
export type OperatorAgentActivity = z.infer<typeof OperatorAgentActivitySchema>;

export const OPERATOR_AGENT_STANCE_NOTE_MAX = 120;
/** A stance older than this is ignored however long it asked for. */
export const OPERATOR_AGENT_STANCE_MAX_MS = 60 * 60 * 1000;
export const OPERATOR_AGENT_STANCE_DEFAULT_MS = 15 * 60 * 1000;

export const OperatorAgentStanceSchema = z
  .object({
    pose: OperatorAgentPoseSchema,
    activityKind: OperatorAgentActivityKindSchema.optional(),
    /** One short line in the agent's own voice; shown wherever the seat is listed. */
    note: z.string().trim().max(OPERATOR_AGENT_STANCE_NOTE_MAX).optional(),
    statedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type OperatorAgentStance = z.infer<typeof OperatorAgentStanceSchema>;

/**
 * An agent stating its own stance. It names no seat: the service reads the
 * Herdr pane the caller is sitting in and resolves the seat from the live
 * census, so identity is checked rather than claimed.
 */
export const StateOperatorAgentStanceSchema = z
  .object({
    herdrPaneId: z.string().trim().min(1).max(128),
    pose: OperatorAgentPoseSchema,
    activityKind: OperatorAgentActivityKindSchema.optional(),
    note: z.string().trim().max(OPERATOR_AGENT_STANCE_NOTE_MAX).optional(),
    /** How long this statement stands. Clamped to the ceiling above. */
    ttlMs: z.number().int().positive().max(OPERATOR_AGENT_STANCE_MAX_MS).optional(),
  })
  .strict();
export type StateOperatorAgentStance = z.infer<typeof StateOperatorAgentStanceSchema>;

/** Why a stance did not take, so an agent is told rather than left guessing. */
export const StateOperatorAgentStanceResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("stated"),
      seatId: z.string().trim().min(1).max(512),
      personaId: OperatorAgentPersonaIdSchema,
      stance: OperatorAgentStanceSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unseated"),
      /** The pane holds no live fleet seat — a shell pane, or a census yet to catch up. */
      herdrPaneId: z.string().trim().min(1).max(128),
    })
    .strict(),
]);
export type StateOperatorAgentStanceResult = z.infer<typeof StateOperatorAgentStanceResultSchema>;

/** Durable personas outlive seats, so their public bound cannot be the live roster bound. */
export const OPERATOR_AGENT_PERSONA_LIST_MAX = 1_000;
/** Bounded fleet roster entry: one herdr seat as a messageable contact (ADR 0135). */
export const OPERATOR_FLEET_ROSTER_MAX = 48;
/**
 * What the host saw a seat's last run come to (ADR 0162). `passed` is a pane
 * that worked and then settled ready for the next thing; `failed` is one that
 * settled blocked. Nothing here is a judgement about the work — it is what the
 * pane's own agent status said when the run ended.
 */
export const OperatorSeatRunResultSchema = z.enum(["passed", "failed"]);
export type OperatorSeatRunResult = z.infer<typeof OperatorSeatRunResultSchema>;

export const OperatorSeatLastOutcomeSchema = z
  .object({
    result: OperatorSeatRunResultSchema,
    /** When the run settled, never when it was read. */
    at: z.string().datetime(),
  })
  .strict();
export type OperatorSeatLastOutcome = z.infer<typeof OperatorSeatLastOutcomeSchema>;

/** One numbered, labelled level of Herdr's workspace → tab hierarchy. */
const OperatorHerdrLevelSchema = z
  .object({
    id: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
    label: z.string().max(OPERATOR_CONVERSATION_TITLE_MAX),
    number: z.number().int().positive(),
  })
  .strict();
/** Where a terminal sits in Herdr, as the owner arranged it. */
export const OperatorHerdrPlacementSchema = z
  .object({ workspace: OperatorHerdrLevelSchema, tab: OperatorHerdrLevelSchema })
  .strict();
export type OperatorHerdrPlacement = z.infer<typeof OperatorHerdrPlacementSchema>;

export const OperatorCodexAccountSchema = z
  .object({ label: z.string().min(1).max(64), home: z.string().min(1).max(4096) })
  .strict();

export const OPERATOR_SEAT_SUBAGENTS_RECENT_MAX = 8;
export const OperatorSeatSubagentsSchema = z
  .object({
    running: z.number().int().min(0),
    recent: z
      .array(
        z
          .object({
            label: z.string().max(120),
            status: z.enum(["running", "done"]),
            // Optional for older hosts/transcripts; native readers fill available evidence.
            id: z.string().min(1).max(OPERATOR_CONVERSATION_REF_MAX).optional(),
            startedAt: z.string().datetime().optional(),
            endedAt: z.string().datetime().optional(),
          })
          .strict(),
      )
      .max(OPERATOR_SEAT_SUBAGENTS_RECENT_MAX),
  })
  .strict();
export type OperatorSeatSubagents = z.infer<typeof OperatorSeatSubagentsSchema>;

const HarnessBridgeProcessSchema = z
  .object({
    status: z.enum(["live-process", "missing", "pane-mismatch", "unobserved"]),
    detail: z.string().max(1024),
    remediation: z.string().max(1024).optional(),
    bridgePid: z.number().int().positive().optional(),
    claimedPane: z.string().max(128).optional(),
    sharedDaemon: z.boolean().optional(),
    /** Process age is a reload hint, not proof of the loaded build or tool delivery. */
    freshness: z.enum(["older-than-runtime", "current", "unknown"]).optional(),
    bridgeStartedAt: z.string().datetime().optional(),
    runtimeStartedAt: z.string().datetime().optional(),
  })
  .strict();
const OperatorHarnessBridgeSchema = HarnessBridgeProcessSchema.extend({
  /** Operator channel and worker connected tools are independent processes. */
  operatorBridge: HarnessBridgeProcessSchema.optional(),
});

/** Host routing diagnostics; never a worker-selected destination or tool grant. */
export const WorkerReportRoutingSchema = z
  .object({
    source: z.enum(["adoption", "parent", "unadopted", "refused"]),
    reason: z
      .enum(["no_parent", "parent_unavailable", "parent_unlinked", "owner_removed", "authority_unavailable"])
      .optional(),
    leadPaneId: z.string().min(1).max(256).optional(),
    leadSeatId: z.string().min(1).max(256).optional(),
    conversationId: OperatorConversationIdSchema.optional(),
  })
  .strict();
export type WorkerReportRouting = z.infer<typeof WorkerReportRoutingSchema>;

/** Service-observed worker tool traffic; never native membership or tool authority. */
export const WorkerBridgeStatusSchema = z
  .object({
    status: z.enum(["pending", "ready", "missing", "stalled", "not-observed"]),
    reason: z.string().min(1).max(1024),
    observedAt: z.string().datetime().optional(),
    pendingSince: z.string().datetime().optional(),
    tools: z.array(z.string().min(1).max(256)).max(4096).optional(),
    pluginVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/u)
      .optional(),
    expectedPluginVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/u)
      .optional(),
    behind: z.boolean().optional(),
    restartNeeded: z.boolean().optional(),
    remediation: z.string().min(1).max(2048).optional(),
    runtimeRevision: z.string().min(1).max(256).optional(),
    expectedRuntimeRevision: z.string().min(1).max(256).optional(),
    /**
     * Host-observed at the seat's last process proof: it still runs an earlier
     * harness release than the installed launcher. Messaging keeps working;
     * resuming the same thread picks up the current release.
     */
    harnessUpdate: z
      .object({
        harness: z.string().min(1).max(80),
        running: z.string().min(1).max(64),
        installed: z.string().min(1).max(64),
        observedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorkerBridgeStatus = z.infer<typeof WorkerBridgeStatusSchema>;

export const OperatorFleetSeatSchema = z
  .object({
    /** Cached owner repository observation; not freshness admission proof. */
    checkout: CheckoutStatusSchema.optional(),
    /** Host-observed bridge facts, not tool or message delivery acceptance. */
    harnessBridge: OperatorHarnessBridgeSchema.optional(),
    /** Native client acceptance for this exact occupying session. */
    toolCatalog: FleetSeatToolCatalogHealthSchema.optional(),
    /** Authenticated bridge/catalog observations only; not proof that the harness loaded its tools. */
    workerTools: WorkerBridgeStatusSchema.optional(),
    /** Sender receipt health is independent of the served tool catalog. */
    workerReportBridge: WorkerReportBridgeStatusSchema.optional(),
    account: OperatorCodexAccountSchema.optional(),
    seatId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
    /** Harness-session identity; stable when the same agent moves panes. */
    occupantId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
    /** Durable character occupying this temporary Herdr seat. */
    personaId: OperatorAgentPersonaIdSchema,
    /** Harness kind — claude, codex, pi, … — contact-card metadata, never routing. */
    harness: z.string().trim().min(1).max(OPERATOR_CONVERSATION_CODE_MAX),
    status: z.string().trim().min(1).max(OPERATOR_CONVERSATION_CODE_MAX),
    title: z.string().max(OPERATOR_CONVERSATION_TITLE_MAX),
    /** Current work kind and its host evidence. Absent is unknown; no caption parsing. */
    activity: OperatorAgentActivitySchema.optional(),
    /** Native goal and explicitly stated assignment for this exact session. */
    goal: OperatorGoalSchema.optional(),
    assignment: OperatorWorkAssignmentSchema.optional(),
    /** Herd-lead distilled summary, when one has been written for the seat's pane. */
    summary: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX).optional(),
    next: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX).optional(),
    /** Present once the occupying persona's DM thread exists in the registry. */
    conversationId: OperatorConversationIdSchema.optional(),
    /**
     * The lead conversation persisted for this exact native occupant (VUH-1763).
     * `hired` is false for a hand-started seat a conversation adopted by
     * messaging it. Absent means unowned. Only a hired seat's owner may steer it.
     */
    owner: z.object({ conversationId: OperatorConversationIdSchema, hired: z.boolean() }).strict().optional(),
    /**
     * Absolute path the agent is working in. The commons keys its districts off
     * this (ADR 0022), and hiring offers it back as the places a new agent can
     * join. Absent when the shell cannot resolve one.
     */
    workingDirectory: z.string().trim().max(OPERATOR_SEAT_DIRECTORY_MAX).optional(),
    /**
     * The Herdr workspace and tab holding this seat, so a roster can be laid
     * out the way the owner laid out the work. Absent when Herdr's snapshot
     * could not be read; the seat is still a seat.
     */
    placement: OperatorHerdrPlacementSchema.optional(),
    /** Display identity of the host machine; fleet remains the routing key. */
    machine: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TITLE_MAX).optional(),
    /** Named Herdr server session, independent of the occupying harness session. */
    herdrSession: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TITLE_MAX).optional(),
    /**
     * The registered machine (Herdr fleet) holding this seat (ADR 0184), for a
     * machine tag. Absent on the local default fleet.
     */
    fleet: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/u)
      .optional(),
    /**
     * What the occupying agent last said it was doing, while that statement
     * stands. Absent once it expires, so a surface never has to reason about
     * staleness — the seat simply stops carrying one.
     */
    stance: OperatorAgentStanceSchema.optional(),
    /**
     * How this seat's last run came out, while the host holds one (ADR 0162).
     * Absent is the third answer — no settled run — so a surface reads the
     * ledger rather than inferring an outcome from a quiet seat.
     */
    lastOutcome: OperatorSeatLastOutcomeSchema.optional(),
    /**
     * The seat whose pane started this one, for as long as both are seated.
     * Read from the live census, never remembered: a seat whose parent left
     * the roster simply stops carrying one (ADR 0163).
     */
    parentSeatId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX).optional(),
    workerReportRouting: WorkerReportRoutingSchema.optional(),
    workerReports: z.array(WorkerReportSummarySchema).max(100).optional(),
    /** Evidence for the leading conversation's periodic and watch-time review. */
    efficiency: OperatorSeatEfficiencySchema.optional(),
    /**
     * Native subagents the occupying harness started inside its own TUI
     * (Claude Code's Agent/Task tool), newest first (ADR 0208). Present only
     * for a local Claude seat the host already has an address for — hired, or
     * a chat the owner opened (ADR 0188) — so discovery alone never reads a
     * transcript. Absent means unknown, not none.
     */
    subagents: OperatorSeatSubagentsSchema.optional(),
  })
  .strict();
export type OperatorFleetSeat = z.infer<typeof OperatorFleetSeatSchema>;

/**
 * One seat's counts for the calendar day the host is in (ADR 0162). The host
 * is the authority for what a seat has earned; a surface renders these and
 * keeps no score of its own. A seat with nothing yet today is absent from the
 * array rather than carrying zeroes.
 */
export const OperatorSeatDayTallySchema = z
  .object({
    seatId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
    /** The host's local calendar day these cover, `YYYY-MM-DD`. */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    /** Runs that settled today, however they came out. */
    runs: z.number().int().nonnegative(),
    /** The `passed` half of `runs`. */
    greenRuns: z.number().int().nonnegative(),
    /** Times the agent said it landed something: a `celebrate` stance struck. */
    ships: z.number().int().nonnegative(),
    /** Prompts the host delivered into this seat's pane, from whichever surface sent them. */
    promptsSent: z.number().int().nonnegative(),
  })
  .strict();
export type OperatorSeatDayTally = z.infer<typeof OperatorSeatDayTallySchema>;

/**
 * One directed relationship between two seated agents (ADR 0163). A `spawn`
 * edge runs from the parent that started the child and stands for the life of
 * the child; a `prompt` edge runs from the sender to the agent it prompted and
 * a `reply` edge back from the one that answered, both standing only while
 * they are inside the captain's recent window. Both ends are live seats: an
 * edge touching a seat that left the roster is not carried.
 */
export const OperatorFleetEdgeSchema = z
  .object({
    kind: z.enum(["prompt", "spawn", "reply"]),
    fromSeatId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
    toSeatId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
    at: z.string().datetime(),
    /**
     * The thread this edge happened in, and the entry in it that was said,
     * when the captain can name them. A message it delivered itself it can
     * always name; one typed into a pane by `herdr agent prompt` it never saw,
     * so a surface that wants the words has to be ready for their absence.
     */
    conversationId: OperatorConversationIdSchema.optional(),
    entryId: OperatorConversationCursorSchema.optional(),
  })
  .strict();
export type OperatorFleetEdge = z.infer<typeof OperatorFleetEdgeSchema>;

/**
 * Spawn edges are bounded by the roster; prompt edges by the captain's window.
 * The ceiling holds both with room to spare, so a busy fleet is truncated by
 * the window rather than by the wire.
 */
export const OPERATOR_FLEET_EDGE_MAX = 128;

/** A full live-fleet read plus the cursor that wakes its next long poll. */
export const OPERATOR_FLEET_WAIT_MS_MAX = 30_000;

/** Durable roster history; closing never discards the harvested output. */
export const ClosedWorkerPaneSchema = z
  .object({
    id: z.string().uuid(),
    paneId: z.string().min(1),
    seatId: z.string().min(1),
    title: z.string(),
    harness: z.enum(["claude", "codex"]),
    reason: z.string().min(1).max(512),
    lastOutput: z.string().max(131072),
    reportPath: z.string().min(1),
    closedAt: z.string().datetime(),
    undoUntil: z.string().datetime(),
    state: z.enum(["closing", "closed", "close_unconfirmed", "undoing", "reopened"]),
    resumedSeatId: z.string().optional(),
  })
  .strict();
export type ClosedWorkerPane = z.infer<typeof ClosedWorkerPaneSchema>;

/** An attributed room request delegated into its own inspectable conversation. */
export const RoomHandoffMetadataSchema = z
  .object({
    roomConversationId: OperatorConversationIdSchema,
    deliveryId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
    actorId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
    actorName: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TITLE_MAX).optional(),
    source: z.enum(["voice", "text"]),
    request: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TEXT_MAX),
    doing: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX).optional(),
    state: z.enum(["pending", "running", "waiting_user", "completed", "failed"]),
    host: z.enum(["pi", "claude", "codex", "opencode"]),
    /** Actual native child reference, supplied by the dispatch acknowledgment. */
    nativeChildSessionId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX).optional(),
    result: z.string().max(OPERATOR_CONVERSATION_TEXT_MAX).optional(),
  })
  .strict();
export type RoomHandoffMetadata = z.infer<typeof RoomHandoffMetadataSchema>;

export const OperatorFleetSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Cached host capacity and holders; no process probing on a snapshot read. */
    resources: FleetResourceSnapshotSchema.optional(),
    cursor: OperatorConversationCursorSchema,
    goals: z
      .array(z.object({ conversationId: OperatorConversationIdSchema, goal: OperatorGoalSchema }).strict())
      .max(OPERATOR_CONVERSATION_LIST_MAX)
      .optional(),
    assignments: z
      .array(
        z
          .object({ conversationId: OperatorConversationIdSchema, assignment: OperatorWorkAssignmentSchema })
          .strict(),
      )
      .max(OPERATOR_CONVERSATION_LIST_MAX)
      .optional(),
    closedPanes: z.array(ClosedWorkerPaneSchema).max(128).optional(),
    seats: z.array(OperatorFleetSeatSchema).max(OPERATOR_FLEET_ROSTER_MAX),
    workerReports: z.array(WorkerReportSummarySchema).max(1000).optional(),
    personas: z.array(OperatorAgentPersonaSchema).max(OPERATOR_AGENT_PERSONA_LIST_MAX),
    channels: z.array(OperatorChannelSchema).max(OPERATOR_CONVERSATION_LIST_MAX),
    /** Clankie’s room handoffs are conversations, not invented fleet seats. */
    roomHandoffs: z
      .array(z.lazy(() => OperatorConversationSchema))
      .max(OPERATOR_CONVERSATION_LIST_MAX)
      .optional(),
    /**
     * Today's counts for the seats that have any (ADR 0162). Optional so a
     * surface written before the ledger keeps reading snapshots unchanged.
     */
    tallies: z.array(OperatorSeatDayTallySchema).max(OPERATOR_FLEET_ROSTER_MAX).optional(),
    /**
     * Who prompted whom recently and who spawned whom, derived on every read
     * (ADR 0163). Absent from a host that does not yet publish edges; empty on
     * a quiet fleet.
     */
    edges: z.array(OperatorFleetEdgeSchema).max(OPERATOR_FLEET_EDGE_MAX).optional(),
  })
  .strict();
export type OperatorFleetSnapshot = z.infer<typeof OperatorFleetSnapshotSchema>;

/** Home needs seated people and room participants.
 * Archived personas remain addressable through personas/get; never delete them.
 * Shared by the service projection and older-host client fallback.
 */
export function operatorFleetHome(snapshot: OperatorFleetSnapshot): OperatorFleetSnapshot {
  const visible = new Set(snapshot.seats.map((seat) => seat.personaId));
  for (const channel of snapshot.channels) {
    for (const member of channel.members) visible.add(member.personaId);
  }
  return {
    ...snapshot,
    personas: snapshot.personas.filter((persona) => visible.has(persona.personaId)),
  };
}

/**
 * Hire an agent (ADR 0013, "compose is hiring"): herdr opens a tab in the
 * chosen working directory and starts the harness there. The seat that comes
 * back is the durable thread identity, so the DM opens on the reply rather
 * than after a roster poll notices a stranger.
 */
export const SpawnOperatorSeatSchema = z
  .object({
    schemaVersion: z.literal(1),
    ...HireProfileSchema.shape,
    /** Saved transcript ref (`host:sessionId`); continue it as a normal native seat. */
    resume: z.string().trim().min(1).max(128).optional(),
    /** Explicit new remote work after a settled native hire; both identities stay fenced. */
    freshIntent: z
      .object({
        id: z
          .string()
          .uuid()
          .refine((id) => id === id.toLowerCase(), "Use a canonical lowercase UUID"),
        afterReceiptId: z
          .string()
          .uuid()
          .refine((id) => id === id.toLowerCase(), "Use a canonical lowercase UUID"),
      })
      .strict()
      .optional(),
    /** What the roster calls it; herdr's own agent name is derived from this. */
    title: OperatorAgentNameSchema,
    /** Absolute path it starts in — the district it joins (ADR 0022). */
    workingDirectory: z.string().trim().min(1).max(OPERATOR_SEAT_DIRECTORY_MAX),
    /**
     * Start the harness with its owner's-Chrome integration on (ADR 0199):
     * claude's `--chrome`. Codex's Chrome and computer use follow the owner's
     * own Codex settings, so it needs no flag; other harnesses fail typed.
     */
    chrome: z.boolean().optional(),
    /**
     * The Herdr fleet it starts on (ADR 0184): a registered machine's name.
     * Absent means the local default fleet; the seat id comes back as
     * `<fleet>/<terminal>` for any other.
     */
    fleet: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/u)
      .optional(),
    /** Requested project must match the host-proven hiring context; never grants authority. */
    projectId: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
      .optional(),
    /** Explicit shared workflow tab; split joins its last pane, never a focused/lead tab. */
    pipeline: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\p{Cc}]+$/u, "Pipeline names cannot contain control characters")
      .optional(),
    /** Stable work item/deliverable key, required for native-first admission. */
    deliverable: z.string().trim().min(1).max(512).optional(),
    /** The hired persona's team role (ADR 0208); absent leaves it as it was. */
    role: OperatorAgentRoleSchema.optional(),
  })
  .strict();
export type SpawnOperatorSeat = z.infer<typeof SpawnOperatorSeatSchema>;

/**
 * Spawning crosses a process boundary that fails in ordinary ways: a path that
 * is not there, a harness that is not installed, a startup that never becomes
 * ready. Those are outcomes to render, not exceptions to crash a surface on —
 * the same call the send lane makes with `undelivered`.
 */
const SeatControlModeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.enum(["channel", "adapter"]) }).strict(),
  z
    .object({
      mode: z.enum(["terminal", "unavailable"]),
      reason: z.string(),
      detail: z.string(),
      fix: z.string().optional(),
    })
    .strict(),
]);

export const OperatorSeatSpawnResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("spawned"),
      /** Native hire succeeded; only its semantic role write remains incomplete. Never retry the hire. */
      roleAssignment: z
        .discriminatedUnion("outcome", [
          z.object({ outcome: z.literal("pending"), operationId: z.string().uuid() }).strict(),
          z.object({ outcome: z.literal("unsaved") }).strict(),
        ])
        .optional(),
      deliveryStage: DeliveryStageSchema.optional(),
      seat: OperatorFleetSeatSchema,
      control: SeatControlModeSchema.optional(),
      profile: HireProfileSchema.optional(),
      /**
       * Retired opinionated-skill condition. Bodies no longer send it; kept so
       * clients still parse spawn results from an older body.
       */
      skills: z
        .object({
          mode: z.enum(["bundled", "plain"]),
          source: z.enum(["setting", "override"]),
          applied: z.boolean(),
          included: z.array(z.string()),
          excluded: z.array(z.string()),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("failed"),
      deliveryStage: DeliveryStageSchema.optional(),
      /** `at_capacity`: a hosted body already runs as many hired agents as its plan allows (VUH-1388). */
      reason: z.enum([
        "unknown_directory",
        "harness_unavailable",
        "not_ready",
        "trust_required",
        "herdr_unreachable",
        "at_capacity",
        /** The native message/start may have landed: inspect its pane, never blindly replay. */
        "delivery_unconfirmed",
        "start_unconfirmed",
      ]),
      detail: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX).optional(),
      control: SeatControlModeSchema.optional(),
    })
    .strict(),
]);
export type OperatorSeatSpawnResult = z.infer<typeof OperatorSeatSpawnResultSchema>;

/**
 * Sending a live seat to another working directory (ADR 0166). A seat is named
 * by the chair it is sitting in now; where it lands is a district like any
 * other, so this takes the same absolute path hiring does.
 */
export const MoveOperatorSeatSchema = z
  .object({
    schemaVersion: z.literal(1),
    seatId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
    /** Absolute path it moves to — the district it joins (ADR 0022). */
    workingDirectory: z.string().trim().min(1).max(OPERATOR_SEAT_DIRECTORY_MAX),
  })
  .strict();
export type MoveOperatorSeat = z.infer<typeof MoveOperatorSeatSchema>;

/**
 * Moving restarts the harness in the new directory, so it fails the same ways
 * hiring does, plus one of its own: the seat may be gone by the time the move
 * is asked for. `moved` carries the seat in its new chair — a new seat id,
 * because it is a new terminal, wearing the same persona.
 */
export const OperatorSeatMoveResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("moved"), seat: OperatorFleetSeatSchema }).strict(),
  z
    .object({
      outcome: z.literal("failed"),
      reason: z.enum([
        "unknown_seat",
        "unknown_directory",
        "harness_unavailable",
        "not_ready",
        "trust_required",
        "herdr_unreachable",
      ]),
      detail: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX).optional(),
      control: SeatControlModeSchema.optional(),
    })
    .strict(),
]);
export type OperatorSeatMoveResult = z.infer<typeof OperatorSeatMoveResultSchema>;

/** One message-scope slash command a conversation endpoint can actually accept. */
export const OperatorComposerCommandSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/u)
      .max(64),
    aliases: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/u)
          .max(64),
      )
      .max(12),
    summary: z.string().trim().min(1).max(256),
    argumentHint: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type OperatorComposerCommand = z.infer<typeof OperatorComposerCommandSchema>;

/** One exact skill loaded by the target conversation, with its native invocation. */
export const SkillQuickActionSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    icon: z
      .string()
      .regex(/^[a-z0-9-]+$/u)
      .max(64),
    selectionArg: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9_-]*$/u)
      .max(64)
      .optional(),
  })
  .strict();
export type SkillQuickAction = z.infer<typeof SkillQuickActionSchema>;

/** One exact skill loaded by the target conversation, with its native invocation. */
export const OperatorComposerSkillSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9:_-]*$/u)
      .max(64),
    description: z.string().trim().min(1).max(512),
    source: z.string().trim().min(1).max(32),
    /** A single sigil token; arguments are appended by the client. */
    invocation: z.string().regex(/^[/$][^\s]{1,127}$/u),
    quickAction: SkillQuickActionSchema.optional(),
  })
  .strict();
export type OperatorComposerSkill = z.infer<typeof OperatorComposerSkillSchema>;

export const OPERATOR_COMPOSER_CATALOG_MAX = 256;
export const OperatorComposerCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    commands: z.array(OperatorComposerCommandSchema).max(OPERATOR_COMPOSER_CATALOG_MAX),
    skills: z.array(OperatorComposerSkillSchema).max(OPERATOR_COMPOSER_CATALOG_MAX),
  })
  .strict();
export type OperatorComposerCatalog = z.infer<typeof OperatorComposerCatalogSchema>;

/** Up to 16 execution connections, each with 48 observable panes. */
export const OPERATOR_TERMINAL_CATALOG_MAX = 16 * 48;

/** Herdr's native workspace → tab → pane location for one observable terminal. */
export const OperatorTerminalSessionSchema = z
  .object({
    /** Runtime identity is separate from Herdr's local workspace and tab IDs. */
    runtime: z
      .object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u), session: z.string().min(1).max(64) })
      .strict()
      .optional(),
    terminalId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
    label: z.string().max(OPERATOR_CONVERSATION_TITLE_MAX),
    workspace: OperatorHerdrLevelSchema,
    tab: OperatorHerdrLevelSchema,
    pane: z
      .object({
        id: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
      })
      .strict(),
    /**
     * Harness occupying the pane — claude, codex, clankie, … Absent for a plain
     * shell. Herdr draws this line itself (`herdr agent list` is the subset of
     * panes carrying one), and it is why an operator opens the catalog at all,
     * so surfaces must be able to tell the two apart without guessing.
     */
    agent: z.string().trim().min(1).max(OPERATOR_CONVERSATION_CODE_MAX).optional(),
  })
  .strict();
export type OperatorTerminalSession = z.infer<typeof OperatorTerminalSessionSchema>;

export const OperatorConversationSessionStateSchema = z.enum([
  "unbound",
  "active",
  "waiting",
  "completed",
  "failed",
]);
export type OperatorConversationSessionState = z.infer<typeof OperatorConversationSessionStateSchema>;

/** Current model-context occupancy, independent of provider-specific token metadata. */
export const OperatorConversationContextUsageSchema = z
  .object({
    /** Unknown immediately after compaction until the next model response. */
    tokens: z.number().int().nonnegative().nullable(),
    contextWindow: z.number().int().positive(),
  })
  .strict();
export type OperatorConversationContextUsage = z.infer<typeof OperatorConversationContextUsageSchema>;

/** Public registry record. Provider credentials and continuation capabilities are impossible by schema. */
export const OperatorConversationSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: OperatorConversationIdSchema,
    scope: OperatorConversationScopeSchema,
    title: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TITLE_MAX),
    isDefault: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    sessionState: OperatorConversationSessionStateSchema,
    revision: z.number().int().nonnegative(),
    contextUsage: OperatorConversationContextUsageSchema.optional(),
    goal: OperatorGoalSchema.optional(),
    assignment: OperatorWorkAssignmentSchema.optional(),
    /** Present only for an ephemeral side conversation forked from this parent. */
    parentConversationId: OperatorConversationIdSchema.optional(),
    roomHandoff: RoomHandoffMetadataSchema.optional(),
    designatedHeadConversationId: OperatorConversationIdSchema.optional(),
    /**
     * A harness sits in this conversation's seat and takes its turns instead
     * of pi (ADR 0152). `harness` is present when the service can name it,
     * which today is the head pane herdr lists under his name.
     */
    driver: z
      .object({ harness: z.string().trim().min(1).max(OPERATOR_CONVERSATION_CODE_MAX).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type OperatorConversation = z.infer<typeof OperatorConversationSchema>;
export const CONVERSATION_HEAD_PATH = "/v1/conversation-heads";
export const ConversationHeadRequestSchema = z.strictObject({
  conversationId: OperatorConversationIdSchema,
  headConversationId: OperatorConversationIdSchema.nullable(),
});
export type ConversationHeadRequest = z.infer<typeof ConversationHeadRequestSchema>;

export const OperatorWakeSchema = z
  .object({
    at: z.string().datetime(),
    reason: z.string().trim().min(1).max(OPERATOR_CONVERSATION_SUMMARY_MAX),
    createdAt: z.string().datetime(),
  })
  .strict();
export type OperatorWake = z.infer<typeof OperatorWakeSchema>;

export const OperatorAutonomyStatusSchema = z
  .object({
    enabled: z.boolean(),
    error: z.literal("state_unreadable").optional(),
    goal: OperatorGoalSchema.optional(),
    wake: OperatorWakeSchema.optional(),
  })
  .strict();
export type OperatorAutonomyStatus = z.infer<typeof OperatorAutonomyStatusSchema>;

export const OperatorAutonomyCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("set_enabled"), enabled: z.boolean() }).strict(),
  z
    .object({
      action: z.literal("set_goal"),
      objective: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TEXT_MAX),
      tokenBudget: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ action: z.literal("accept_goal") }).strict(),
  z.object({ action: z.literal("set_goal_status"), status: z.enum(["active", "paused"]) }).strict(),
  z.object({ action: z.literal("clear_goal") }).strict(),
  z.object({ action: z.literal("clear_wake") }).strict(),
]);
export type OperatorAutonomyCommand = z.infer<typeof OperatorAutonomyCommandSchema>;

/** Starting or re-enabling autonomous work requires the owner transport. */
export function operatorAutonomyCommandRequiresOwner(command: OperatorAutonomyCommand): boolean {
  return (
    command.action === "set_goal" ||
    command.action === "accept_goal" ||
    (command.action === "set_goal_status" && command.status === "active") ||
    (command.action === "set_enabled" && command.enabled)
  );
}

/**
 * Strict discriminated public event union. Every app-renderable VUH-745 session
 * event (activity, message, reasoning, context occupancy, tool, typed input,
 * auth/session lifecycle, turn lifecycle, redacted worker transcript) is a named bounded
 * variant. Raw model, provider, continuation, and credential payloads are
 * impossible by schema; the captain redacts to these shapes before publishing
 * to the durable log/tail.
 */
/** Owner asks share immutable identity across surfaces; answers never grant credentials. */
export const ConversationWorkerQuestionSchema = z
  .object({
    seatId: z.string().min(1).max(256),
    requestId: z.union([z.string().min(1).max(256), z.number().int()]),
    sessionId: z.string().min(1).max(256),
    questions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            header: z.string().max(256).optional(),
            question: z.string().min(1).max(4000),
            options: z
              .array(
                z
                  .object({
                    label: z.string().min(1).max(500),
                    description: z.string().max(2000).optional(),
                  })
                  .strict(),
              )
              .max(32)
              .optional(),
            isOther: z.boolean().optional(),
            isSecret: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type ConversationWorkerQuestion = z.infer<typeof ConversationWorkerQuestionSchema>;
export const ConversationQuestionAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), optionId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(4000) }).strict(),
  z
    .object({
      kind: z.literal("worker"),
      answers: z.record(
        z.string().min(1).max(256),
        z.object({ answers: z.array(z.string().min(1).max(4000)).min(1).max(32) }).strict(),
      ),
    })
    .strict(),
]);
export type ConversationQuestionAnswer = z.infer<typeof ConversationQuestionAnswerSchema>;
export const ConversationQuestionSchema = z
  .object({
    requestId: z.string().uuid(),
    incarnationId: z.string().uuid(),
    conversationId: OperatorConversationIdSchema,
    workspace: z.string().min(1).max(4096).optional(),
    purpose: z.enum(["preference", "decision", "approval", "owner_action"]),
    recommendation: z.string().trim().min(1).max(2000).optional(),
    waitingOn: z.string().trim().min(1).max(2000).optional(),
    steps: z.array(z.string().trim().min(1).max(2000)).max(32).optional(),
    gate: z.string().min(1).max(100).optional(),
    workerQuestion: ConversationWorkerQuestionSchema.optional(),
    kind: z.enum(["text", "choice"]),
    prompt: z.string().trim().min(1).max(2000),
    options: z
      .array(
        z
          .object({
            optionId: z.string().uuid(),
            label: z.string().trim().min(1).max(200),
            description: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(8),
    allowFreeform: z.boolean(),
    createdAt: z.string().datetime(),
    originRunId: z.string().min(1).max(256),
    status: z.enum(["pending", "submitted", "cancelled"]),
    resolvedAt: z.string().datetime().optional(),
    reason: z.string().max(100).optional(),
    answer: ConversationQuestionAnswerSchema.optional(),
    continuation: z
      .object({
        runId: z.string().min(1).max(256),
        state: z.enum(["accepted", "completed", "failed", "cancelled"]),
        reasonCode: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ConversationQuestion = z.infer<typeof ConversationQuestionSchema>;
export const ConversationQuestionTargetSchema = z
  .object({
    conversationId: OperatorConversationIdSchema,
    incarnationId: z.string().uuid(),
    requestId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export type ConversationQuestionTarget = z.infer<typeof ConversationQuestionTargetSchema>;
export const ConversationQuestionResultSchema = z
  .object({
    status: z.enum(["ready", "resolved", "revision_conflict", "refused"]),
    conversationId: OperatorConversationIdSchema,
    incarnationId: z.string().uuid().optional(),
    revision: z.number().int().nonnegative().optional(),
    safeCursor: OperatorConversationCursorSchema.optional(),
    question: ConversationQuestionSchema.optional(),
    reason: z.string().max(100).optional(),
  })
  .strict();
export type ConversationQuestionResult = z.infer<typeof ConversationQuestionResultSchema>;
export const ConversationQuestionListSchema = z
  .object({
    questions: z.array(ConversationQuestionResultSchema).max(1000),
  })
  .strict();
export type ConversationQuestionList = z.infer<typeof ConversationQuestionListSchema>;

const OperatorConversationEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: OperatorConversationIdSchema,
  cursor: OperatorConversationCursorSchema,
  revision: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
});

export const OperatorConversationActivityPhaseSchema = z.enum([
  "waiting",
  "thinking",
  "responding",
  "preparing_tool",
  "compacting",
  "retrying",
]);
export type OperatorConversationActivityPhase = z.infer<typeof OperatorConversationActivityPhaseSchema>;

export const OperatorConversationStreamEventSchema = z.discriminatedUnion("type", [
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("activity"),
    phase: OperatorConversationActivityPhaseSchema,
  }).strict(),
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("message"),
    /** `agent` is a fleet character; `external` is received context, never operator direction. */
    role: z.enum(["operator", "captain", "agent", "external"]),
    text: z.string().max(OPERATOR_CONVERSATION_TEXT_MAX),
    streaming: z.boolean(),
    /** Coordinator message identity, retained for duplicate delivery recovery. */
    swarmMessageId: z.string().min(1).max(128).optional(),
    /** Verified Linear context retained in the selected ordinary chat; never operator authority. */
    linear: z
      .object({
        eventId: z.string().regex(/^[a-f0-9]{64}$/u),
        /** Legacy history compatibility; new webhook deliveries do not emit this field. */
        notification: z.boolean().optional(),
        conversationId: OperatorConversationIdSchema,
        following: z.boolean(),
        project: z
          .object({ id: z.string().uuid(), name: z.string().max(256).optional() })
          .strict()
          .optional(),
        route: z.enum(["project_lead", "project_fallback", "default"]).optional(),
        receiver: z.object({ userId: z.string().uuid(), workspaceId: z.string().uuid() }).strict().optional(),
        notificationTypes: z.array(z.string().min(1).max(128)).max(32).optional(),
      })
      .strict()
      .optional(),
    /**
     * Which persona spoke. Absent in a persona thread, where the counterpart is
     * the conversation's own scope; present in a channel, where several agents
     * share one transcript and the surface must attribute each line (ADR 0146).
     */
    personaId: OperatorAgentPersonaIdSchema.optional(),
    /** Legacy channel attribution retained while old event logs are readable. */
    seatId: z.string().trim().min(1).max(512).optional(),
    /** Files the owner attached to an operator message (ADR 0209). */
    attachments: z
      .array(OperatorConversationAttachmentSchema)
      .min(1)
      .max(OPERATOR_CONVERSATION_ATTACHMENTS_MAX)
      .optional(),
  }).strict(),
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("reasoning"),
    text: z.string().max(OPERATOR_CONVERSATION_TEXT_MAX),
    streaming: z.boolean(),
  }).strict(),
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("context"),
    usage: OperatorConversationContextUsageSchema,
  }).strict(),
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("tool"),
    toolCallId: OperatorConversationEventRefSchema,
    name: z.string().trim().min(1).max(OPERATOR_CONVERSATION_CODE_MAX),
    phase: z.enum(["started", "completed", "failed"]),
    summary: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX).optional(),
    /** Present when Pi loads a named skill, directly or through the read tool. */
    skillName: z.string().trim().min(1).max(OPERATOR_CONVERSATION_CODE_MAX).optional(),
    /** Redacted, serialized arguments or result; bounded before it enters the durable log. */
    detail: z.string().max(OPERATOR_CONVERSATION_TOOL_DETAIL_MAX).optional(),
  }).strict(),
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("input_requested"),
    requestId: OperatorConversationEventRefSchema,
    prompt: z.string().max(OPERATOR_CONVERSATION_TEXT_MAX),
    inputKind: z.enum(["text", "choice", "approval"]),
    purpose: z.enum(["preference", "decision", "approval", "owner_action"]).optional(),
    waitingOn: z.string().max(2000).optional(),
    recommendation: z.string().max(2000).optional(),
    steps: z.array(z.string().max(2000)).max(32).optional(),
    options: z
      .array(z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX))
      .max(OPERATOR_CONVERSATION_INPUT_OPTIONS_MAX)
      .default([]),
  }).strict(),
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("input_resolved"),
    requestId: OperatorConversationEventRefSchema,
    outcome: z.enum(["submitted", "cancelled"]),
  }).strict(),
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("auth"),
    phase: z.enum(["required", "completed"]),
    summary: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX).optional(),
  }).strict(),
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("session"),
    phase: z.enum(["started", "waiting", "completed", "failed"]),
  }).strict(),
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("turn"),
    workerReportRouting: WorkerReportRoutingSchema.optional(),
    deliveryStage: DeliveryStageSchema.optional(),
    runId: OperatorConversationRunIdSchema,
    phase: z.enum(["accepted", "completed", "failed", "cancelled"]),
    reasonCode: z.string().trim().min(1).max(OPERATOR_CONVERSATION_CODE_MAX).optional(),
    /** What actually went wrong, in words. A code alone never tells the operator. */
    summary: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX).optional(),
  }).strict(),
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("worker_transcript"),
    workerRunId: OperatorConversationWorkerRunIdSchema,
    phase: z.enum(["snapshot", "tail"]),
    summary: z.string().max(OPERATOR_CONVERSATION_TEXT_MAX),
  }).strict(),
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("file"),
    file: OperatorDeliveredFileSchema,
  }).strict(),
  /**
   * A reaction landing on, or coming off, one earlier entry (ADR 0146).
   * Deliberately its own append-only event rather than a field on the entry it
   * points at: entries are durable and never rewritten, reactions are mutable,
   * and the current set is the fold of these in cursor order.
   */
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("reaction"),
    /** Cursor of the entry being reacted to. */
    entryRef: OperatorConversationEventRefSchema,
    emoji: z.string().trim().min(1).max(64),
    reactor: OperatorConversationReactorSchema,
    /** True takes the reactor's reaction back off; the add remains in the log. */
    removed: z.boolean(),
  }).strict(),
  /**
   * Bounded forward-compatibility variant. A newer captain may name a semantic
   * event an older app cannot render; it degrades to a bounded label only. It
   * carries no free-form `data`, so it is not a provider/credential escape hatch.
   */
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("unsupported"),
    kind: z.string().trim().min(1).max(OPERATOR_CONVERSATION_CODE_MAX),
    summary: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX),
  }).strict(),
]);
export type OperatorConversationStreamEvent = z.infer<typeof OperatorConversationStreamEventSchema>;
export type OperatorConversationStreamEventType = OperatorConversationStreamEvent["type"];

/**
 * The reactions standing on a conversation right now, folded from its event log
 * in cursor order (ADR 0146). One reactor holds at most one of a given emoji on
 * a given entry, and a removal takes that one back off. Surfaces and the
 * captain both read the set this way rather than keeping a second copy of it
 * that can drift from the log.
 */
export function foldOperatorConversationReactions(
  events: readonly OperatorConversationStreamEvent[],
): readonly OperatorConversationReaction[] {
  const standing = new Map<string, OperatorConversationReaction>();
  for (const event of events) {
    if (event.type !== "reaction") continue;
    const reactorKey = event.reactor.kind === "seat" ? `seat:${event.reactor.seatId}` : "operator";
    const key = `${event.entryRef}\u0000${event.emoji}\u0000${reactorKey}`;
    if (event.removed) {
      standing.delete(key);
      continue;
    }
    standing.set(key, {
      conversationId: event.conversationId,
      entryRef: event.entryRef,
      emoji: event.emoji,
      reactor: event.reactor,
      reactedAt: event.occurredAt,
    });
  }
  return [...standing.values()];
}

/**
 * Select the newest bounded transcript window, preserving chronological order.
 * `before` is exclusive; omitted means the newest retained event. The event
 * ceiling still applies when one assistant turn alone has hundreds of events.
 *
 * Operator and external messages each make a visible turn. Accepted runs make
 * one assistant turn, including their captain prose, reasoning and tools. Bare
 * seat/agent messages settle their own turn. A truncated run starts an implicit
 * assistant turn at its first retained content event, never forcing a scan of
 * the entire journal. This helper is node-free so device caches use the same
 * window as the captain.
 */
export function operatorConversationWindow(
  events: readonly OperatorConversationStreamEvent[],
  options: { readonly before?: string; readonly limit?: number; readonly turnLimit?: number } = {},
): { events: OperatorConversationStreamEvent[]; hasOlder: boolean } {
  const limit = Math.max(
    1,
    Math.min(options.limit ?? OPERATOR_CONVERSATION_REPLAY_LIMIT_MAX, OPERATOR_CONVERSATION_REPLAY_LIMIT_MAX),
  );
  const turnLimit = Math.max(
    1,
    Math.min(
      options.turnLimit ?? OPERATOR_CONVERSATION_WINDOW_TURNS_DEFAULT,
      OPERATOR_CONVERSATION_WINDOW_TURNS_MAX,
    ),
  );
  let end = events.length;
  if (options.before !== undefined) {
    let low = 0;
    while (low < end) {
      const middle = (low + end) >>> 1;
      if (events[middle]!.cursor < options.before) low = middle + 1;
      else end = middle;
    }
  }
  const floor = Math.max(0, end - limit);
  const starts: number[] = [];
  let assistantOpen = false;
  let lifecycleOpen = false;
  for (let index = floor; index < end; index += 1) {
    const event = events[index]!;
    if (event.type === "turn") {
      if (event.phase === "accepted") {
        starts.push(index);
        assistantOpen = true;
        lifecycleOpen = true;
      } else {
        assistantOpen = false;
        lifecycleOpen = false;
      }
    } else if (event.type === "message") {
      if (event.role === "external") {
        if (!event.streaming) {
          starts.push(index);
          // A window can begin on this independent message, omitting a run
          // that began earlier. Budget a subsequent assistant continuation as
          // another turn so folding that suffix cannot exceed the ceiling.
          assistantOpen = false;
        }
      } else if (event.role === "operator") {
        if (!event.streaming) starts.push(index);
        assistantOpen = false;
        lifecycleOpen = false;
      } else {
        if (!assistantOpen) starts.push(index);
        assistantOpen = event.role !== "agent" || event.streaming;
      }
    } else if (
      event.type === "reasoning" ||
      event.type === "tool" ||
      event.type === "file" ||
      event.type === "input_requested" ||
      event.type === "auth"
    ) {
      if (!assistantOpen) starts.push(index);
      assistantOpen = true;
    } else if (
      (event.type === "activity" && event.phase === "waiting") ||
      (event.type === "session" && event.phase !== "started")
    ) {
      // A live run can publish waiting mid-turn; bare projections settle here.
      if (!lifecycleOpen) assistantOpen = false;
    }
  }
  const start = starts.length > turnLimit ? starts[starts.length - turnLimit]! : floor;
  return { events: events.slice(start, end), hasOlder: start > 0 };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A stream event minus its durable envelope (cursor/revision/occurredAt). The
 * captain publishes redacted bodies of this shape; the registry stamps the
 * envelope. Discrimination on `type` is preserved.
 */
export type OperatorConversationEventBody = DistributiveOmit<
  OperatorConversationStreamEvent,
  "schemaVersion" | "conversationId" | "cursor" | "revision" | "occurredAt"
>;

/**
 * Bounded, pageable replay/tail request. `limit` caps the returned page; `cursor`
 * is the exclusive lower bound by default. Backward replay uses an exclusive
 * upper bound; omitting it starts at the newest event. Surfaces keep their own
 * forward-tail and backward-history cursors.
 */
export const ReplayOperatorConversationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: OperatorConversationIdSchema,
    surfaceClientId: OperatorSurfaceClientIdSchema,
    cursor: OperatorConversationCursorSchema.optional(),
    limit: z.number().int().positive().max(OPERATOR_CONVERSATION_REPLAY_LIMIT_MAX).optional(),
    direction: z.literal("backward").optional(),
    /** Visible turn ceiling for backward replay; defaults to 20. */
    turnLimit: z.number().int().positive().max(OPERATOR_CONVERSATION_WINDOW_TURNS_MAX).optional(),
    /**
     * Highest live-draft sequence this surface has already rendered. A tail that
     * would return neither a new event nor a newer draft parks for `waitMs`
     * instead of answering empty.
     */
    liveSequence: z.number().int().nonnegative().optional(),
    /**
     * How long a `tail` may park waiting for the next change. Absent or `0`
     * answers immediately, which is what `replay` always does.
     */
    waitMs: z.number().int().nonnegative().max(OPERATOR_CONVERSATION_TAIL_WAIT_MS_MAX).optional(),
  })
  .strict();
export type ReplayOperatorConversationRequest = z.infer<typeof ReplayOperatorConversationRequestSchema>;

/** A native child is read through its already-addressed parent, never a new chat. */
export const ReplayOperatorSubagentRequestSchema = ReplayOperatorConversationRequestSchema.extend({
  subagentId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
}).strict();
export type ReplayOperatorSubagentRequest = z.infer<typeof ReplayOperatorSubagentRequestSchema>;

/**
 * The captain's answer as it is being typed — a volatile view, never a durable
 * event ([ADR 0141](../../../docs/adr/0141-the-console-watches-him-type.md)).
 * `text` is the whole message so far, not a delta, so a surface that misses a
 * page renders the right thing anyway. It exists only while a message streams;
 * the durable `message` event that settles it is the record.
 */
export const OperatorConversationLiveDraftSchema = z
  .object({
    /** Monotonic per conversation. A surface compares it to skip work it has already drawn. */
    sequence: z.number().int().positive(),
    role: z.literal("captain"),
    text: z.string().max(OPERATOR_CONVERSATION_TEXT_MAX),
  })
  .strict();
export type OperatorConversationLiveDraft = z.infer<typeof OperatorConversationLiveDraftSchema>;

/** One bounded replay page with explicit retained lower bound and resume cursor. */
export const OperatorConversationReplayPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("page"),
    conversationId: OperatorConversationIdSchema,
    surfaceClientId: OperatorSurfaceClientIdSchema,
    events: z.array(OperatorConversationStreamEventSchema).max(OPERATOR_CONVERSATION_REPLAY_LIMIT_MAX),
    /** Oldest cursor still retained; clients below this must reset. */
    retainedFromCursor: OperatorConversationCursorSchema,
    /** Forward replay/tail resume cursor (exclusive lower bound), even on a backward page. */
    nextCursor: OperatorConversationCursorSchema,
    /** Exclusive upper bound for the next backward page; present on backward replay. */
    previousCursor: OperatorConversationCursorSchema.optional(),
    /** More retained events precede this page; present on backward replay. */
    hasOlder: z.boolean().optional(),
    /** Latest durable cursor (upper bound). */
    safeCursor: OperatorConversationCursorSchema,
    hasMore: z.boolean(),
    /** The message being typed right now, when one is. Volatile; absent between messages. */
    live: OperatorConversationLiveDraftSchema.optional(),
  })
  .strict();
export type OperatorConversationReplayPage = z.infer<typeof OperatorConversationReplayPageSchema>;

/** Stable recovery codes. Shape mirrors terminal recovery concepts (no import). */
export const OperatorConversationRecoveryCodeSchema = z.enum([
  "cursor_invalid",
  "cursor_expired",
  "cursor_reset",
  "run_conflict",
  "unknown_conversation",
]);
export type OperatorConversationRecoveryCode = z.infer<typeof OperatorConversationRecoveryCodeSchema>;

/**
 * Typed, non-throwing recovery outcome for client replay. `recoverable` states
 * whether resetting to `resetCursor` restores a consistent stream.
 */
export const OperatorConversationRecoverySchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("recover"),
    conversationId: OperatorConversationIdSchema,
    code: OperatorConversationRecoveryCodeSchema,
    recoverable: z.boolean(),
    resetCursor: OperatorConversationCursorSchema,
    message: z.string().trim().min(1).max(OPERATOR_CONVERSATION_SUMMARY_MAX),
  })
  .strict();
export type OperatorConversationRecovery = z.infer<typeof OperatorConversationRecoverySchema>;

export const ReplayOperatorConversationResultSchema = z.discriminatedUnion("status", [
  OperatorConversationReplayPageSchema,
  OperatorConversationRecoverySchema,
]);
export type ReplayOperatorConversationResult = z.infer<typeof ReplayOperatorConversationResultSchema>;

const SubmitOperatorConversationTurnBaseSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: OperatorConversationIdSchema,
  surfaceClientId: OperatorSurfaceClientIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  /**
   * When the operator console is a herdr pane, that pane is Clankie's seat
   * in the same session as the fleet. Absent on Discord and on a console
   * outside herdr.
   */
  herdrPaneId: z.string().trim().min(1).max(64).regex(/^\S+$/u).optional(),
});

/** Revision-fenced operator message submit. */
export const SubmitOperatorConversationTurnSchema = SubmitOperatorConversationTurnBaseSchema.extend({
  kind: z.literal("message"),
  /** May be empty only when the message carries attachments. */
  message: z.string().trim().max(OPERATOR_CONVERSATION_MESSAGE_MAX),
  /** Steer a live Clankie turn or wait for a separate turn. Omitted preserves automatic admission. */
  delivery: z.enum(["steer", "queue"]).optional(),
  /** Uploads committed to this conversation (ADR 0209). Owner content, never instructions. */
  attachments: z
    .array(OperatorConversationAttachmentRefSchema)
    .min(1)
    .max(OPERATOR_CONVERSATION_ATTACHMENTS_MAX)
    .optional(),
})
  .strict()
  .superRefine((turn, context) => {
    if (turn.message.length === 0 && turn.attachments === undefined) {
      context.addIssue({ code: "custom", path: ["message"], message: "message or attachments required" });
    }
    const ids = (turn.attachments ?? []).map((attachment) => attachment.artifactId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["attachments"], message: "duplicate attachment" });
    }
  });
export type SubmitOperatorConversationTurn = z.infer<typeof SubmitOperatorConversationTurnSchema>;

export const OperatorConversationTurnAcceptedSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("accepted"),
    deliveryStage: DeliveryStageSchema.optional(),
    conversationId: OperatorConversationIdSchema,
    runId: OperatorConversationRunIdSchema,
    revision: z.number().int().nonnegative(),
    safeCursor: OperatorConversationCursorSchema,
    /** Actual turn admission (including Clankie), distinct from its eventual answer.
     * Existing optional shape keeps older strict clients compatible. */
    seatDelivery: z
      .object({
        state: z.enum(["queued", "started", "steered"]),
        detail: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type OperatorConversationTurnAccepted = z.infer<typeof OperatorConversationTurnAcceptedSchema>;

export const OperatorConversationRevisionConflictSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("revision_conflict"),
    conversationId: OperatorConversationIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    currentRevision: z.number().int().nonnegative(),
    safeCursor: OperatorConversationCursorSchema,
  })
  .strict();
export type OperatorConversationRevisionConflict = z.infer<typeof OperatorConversationRevisionConflictSchema>;

/** An agent thread stays readable when its durable character has no live Herdr seat. */
export const OperatorConversationSeatOfflineSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("seat_offline"),
    deliveryStage: DeliveryStageSchema.optional(),
    conversationId: OperatorConversationIdSchema,
    /** Present for a legacy seat-scoped conversation. */
    seatId: OperatorConversationEventRefSchema.optional(),
    /** Present for a durable persona conversation. */
    personaId: OperatorAgentPersonaIdSchema.optional(),
    currentRevision: z.number().int().nonnegative(),
    safeCursor: OperatorConversationCursorSchema,
  })
  .strict();
export type OperatorConversationSeatOffline = z.infer<typeof OperatorConversationSeatOfflineSchema>;

/** A live seat can lack a safe channel, or take a message without confirming it. */
const OperatorConversationSeatDeliveryFailureSchema = OperatorConversationSeatOfflineSchema.extend({
  status: z.enum(["seat_undelivered", "seat_delivery_unconfirmed"]),
  detail: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX),
  messageId: z.string().min(1).max(OPERATOR_CONVERSATION_SUMMARY_MAX).optional(),
}).strict();

export const SubmitOperatorConversationTurnResultSchema = z.discriminatedUnion("status", [
  OperatorConversationTurnAcceptedSchema,
  OperatorConversationRevisionConflictSchema,
  OperatorConversationSeatOfflineSchema,
  OperatorConversationSeatDeliveryFailureSchema.extend({ status: z.literal("seat_undelivered") }),
  OperatorConversationSeatDeliveryFailureSchema.extend({ status: z.literal("seat_delivery_unconfirmed") }),
]);
export type SubmitOperatorConversationTurnResult = z.infer<typeof SubmitOperatorConversationTurnResultSchema>;
