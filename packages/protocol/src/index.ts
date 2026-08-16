import { z } from "zod";

export const MissionIdSchema = z.string().min(1);
export const TaskIdSchema = z.string().min(1);
export const WorkerRunIdSchema = z.string().min(1);
export const EnvironmentSessionIdSchema = z.string().min(1);
export const WorldIdSchema = z.string().min(1);
export const CharacterIdSchema = z.string().min(1);
export const ActionIdSchema = z.string().min(1);

export type EnvironmentSessionId = z.infer<typeof EnvironmentSessionIdSchema>;
export type WorldId = z.infer<typeof WorldIdSchema>;
export type CharacterId = z.infer<typeof CharacterIdSchema>;
export type ActionId = z.infer<typeof ActionIdSchema>;

/** Frozen ADR 0016 v1 wire lanes. New lanes belong to a versioned successor. */
export const CaptainLaneSchema = z.enum(["tui", "discord_voice", "gameplay"]);
export type CaptainLaneV1 = z.infer<typeof CaptainLaneSchema>;

/**
 * Durable captain execution lanes v2. CaptainLaneSchema is the frozen v1 wire
 * enum and remains available for legacy dual-read migration only.
 */
export const CaptainSessionLaneV2Schema = z.enum([
  "operator",
  "discord_voice",
  "discord_presence",
  "gameplay",
]);
export type CaptainSessionLaneV2 = z.infer<typeof CaptainSessionLaneV2Schema>;

/**
 * Transitional dual-read lane boundary. Legacy TUI remains readable while the
 * post-v1 discord_presence lane migrates to CaptainSessionLaneV2Schema.
 * Versioned records must use CaptainLaneSchema (v1) or CaptainSessionLaneV2Schema (v2), never this union.
 */
export const CaptainLaneCompatibilitySchema = z.union([CaptainLaneSchema, z.literal("discord_presence")]);
export type CaptainLane = z.infer<typeof CaptainLaneCompatibilitySchema>;

// ---------------------------------------------------------------------------
// Captain lane observation (ADR 0083).
//
// The bounded room history an operator surface reads to watch a lane it is not
// talking in. This is heard/said conversation only: no reasoning, tool, private
// pi session state, or continuation-token field appears here.
// ---------------------------------------------------------------------------

/** The authenticated captain route that lists observable lanes. */
export const CAPTAIN_LANE_OBSERVATION_PATH = "/captain/v1/lanes";

export const CAPTAIN_LANE_ENTRIES_MAX = 40;
export const CAPTAIN_LANE_TEXT_MAX = 16_384;

export const CaptainLaneObservationEntrySchema = z
  .object({
    at: z.string().datetime(),
    kind: z.enum(["heard", "said"]),
    text: z.string().max(CAPTAIN_LANE_TEXT_MAX),
  })
  .strict();
export type CaptainLaneObservationEntry = z.infer<typeof CaptainLaneObservationEntrySchema>;

export const ObservableCaptainLaneSchema = z
  .object({
    lane: CaptainSessionLaneV2Schema,
    /** The room address: `guildId:channelId` for Discord, conversation-shaped elsewhere. */
    targetId: z.string().trim().min(1).max(512),
    entries: z.array(CaptainLaneObservationEntrySchema).max(CAPTAIN_LANE_ENTRIES_MAX),
  })
  .strict();
export type ObservableCaptainLane = z.infer<typeof ObservableCaptainLaneSchema>;

export const CAPTAIN_LANE_LISTING_MAX = 256;

export const CaptainLaneListingSchema = z
  .object({
    schemaVersion: z.literal(1),
    lanes: z.array(ObservableCaptainLaneSchema).max(CAPTAIN_LANE_LISTING_MAX),
  })
  .strict();
export type CaptainLaneListing = z.infer<typeof CaptainLaneListingSchema>;

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
export const OPERATOR_CONVERSATION_INPUT_OPTIONS_MAX = 32;
export const OPERATOR_CONVERSATION_REPLAY_LIMIT_MAX = 500;
export const OPERATOR_CONVERSATION_REPLAY_LIMIT_DEFAULT = 200;
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
const OperatorConversationEventRefSchema = z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX);

export const OperatorConversationScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("workspace"), workspaceId: z.string().trim().min(1).max(512) }).strict(),
]);
export type OperatorConversationScope = z.infer<typeof OperatorConversationScopeSchema>;

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
  })
  .strict();
export type OperatorConversation = z.infer<typeof OperatorConversationSchema>;

export const ListOperatorConversationsRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: OperatorConversationScopeSchema.optional(),
  })
  .strict();
export type ListOperatorConversationsRequest = z.infer<typeof ListOperatorConversationsRequestSchema>;
export const ListOperatorConversationsResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversations: z.array(OperatorConversationSchema).max(OPERATOR_CONVERSATION_LIST_MAX),
  })
  .strict();
export type ListOperatorConversationsResponse = z.infer<typeof ListOperatorConversationsResponseSchema>;

export const GetOperatorConversationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: OperatorConversationIdSchema,
  })
  .strict();
export type GetOperatorConversationRequest = z.infer<typeof GetOperatorConversationRequestSchema>;
export const GetOperatorConversationResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    // Optional: a missing conversation is a typed not-found (get returns
    // undefined), consistent with the callable `get` service result.
    conversation: OperatorConversationSchema.optional(),
  })
  .strict();
export type GetOperatorConversationResponse = z.infer<typeof GetOperatorConversationResponseSchema>;

export const CreateOperatorConversationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: OperatorConversationScopeSchema,
    title: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TITLE_MAX),
  })
  .strict();
export type CreateOperatorConversationRequest = z.infer<typeof CreateOperatorConversationRequestSchema>;
export const CreateOperatorConversationResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversation: OperatorConversationSchema,
  })
  .strict();
export type CreateOperatorConversationResponse = z.infer<typeof CreateOperatorConversationResponseSchema>;

export const OperatorConversationAttachmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: OperatorConversationIdSchema,
    surfaceClientId: OperatorSurfaceClientIdSchema,
    cursor: OperatorConversationCursorSchema.optional(),
  })
  .strict();
export type OperatorConversationAttachment = z.infer<typeof OperatorConversationAttachmentSchema>;

/**
 * Strict discriminated public event union. Every app-renderable VUH-745 session
 * event (message, reasoning, context occupancy, tool, typed input, auth/session
 * lifecycle, turn lifecycle, redacted worker transcript) is a named bounded
 * variant. Raw model, provider, continuation, and credential payloads are
 * impossible by schema; the captain redacts to these shapes before publishing
 * to the durable log/tail.
 */
const OperatorConversationEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: OperatorConversationIdSchema,
  cursor: OperatorConversationCursorSchema,
  revision: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
});

export const OperatorConversationStreamEventSchema = z.discriminatedUnion("type", [
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("message"),
    role: z.enum(["operator", "captain"]),
    text: z.string().max(OPERATOR_CONVERSATION_TEXT_MAX),
    streaming: z.boolean(),
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
    runId: OperatorConversationRunIdSchema,
    phase: z.enum(["accepted", "completed", "failed", "cancelled"]),
    reasonCode: z.string().trim().min(1).max(OPERATOR_CONVERSATION_CODE_MAX).optional(),
  }).strict(),
  OperatorConversationEventEnvelopeSchema.extend({
    type: z.literal("worker_transcript"),
    workerRunId: OperatorConversationWorkerRunIdSchema,
    phase: z.enum(["snapshot", "tail"]),
    summary: z.string().max(OPERATOR_CONVERSATION_TEXT_MAX),
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
 * is the exclusive lower bound (surface clients keep independent cursors).
 */
export const ReplayOperatorConversationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: OperatorConversationIdSchema,
    surfaceClientId: OperatorSurfaceClientIdSchema,
    cursor: OperatorConversationCursorSchema.optional(),
    limit: z.number().int().positive().max(OPERATOR_CONVERSATION_REPLAY_LIMIT_MAX).optional(),
  })
  .strict();
export type ReplayOperatorConversationRequest = z.infer<typeof ReplayOperatorConversationRequestSchema>;

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
    /** Resume cursor for the next page (exclusive lower bound). */
    nextCursor: OperatorConversationCursorSchema,
    /** Latest durable cursor (upper bound). */
    safeCursor: OperatorConversationCursorSchema,
    hasMore: z.boolean(),
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

/**
 * Typed operator input response payload (answers an `input_requested` event).
 *
 * `approval` is deliberately NOT an accepted response kind: the conversation
 * lane must never widen approval authority (ADR 0032). An `input_requested`
 * event may carry `inputKind: "approval"` as a non-authoritative render hint
 * that points the operator to the dedicated authenticated approval surface, but
 * a privileged approval can never be authorized by submitting over this lane.
 */
export const OperatorConversationInputResponseSchema = z.discriminatedUnion("inputKind", [
  z
    .object({
      inputKind: z.literal("text"),
      text: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TEXT_MAX),
    })
    .strict(),
  z
    .object({
      inputKind: z.literal("choice"),
      choice: z.string().trim().min(1).max(OPERATOR_CONVERSATION_SUMMARY_MAX),
    })
    .strict(),
]);
export type OperatorConversationInputResponse = z.infer<typeof OperatorConversationInputResponseSchema>;

/** Typed worker steering intent carried on an operator conversation submit. */
export const OperatorConversationSteerIntentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("focus"),
      target: z.enum(["current_task", "failing_test", "acceptance_criteria", "scope", "diagnosis"]),
    })
    .strict(),
  z.object({ type: z.literal("continue") }).strict(),
  z.object({ type: z.literal("retry_last_step") }).strict(),
  z.object({ type: z.literal("summarize_status") }).strict(),
]);
export type OperatorConversationSteerIntent = z.infer<typeof OperatorConversationSteerIntentSchema>;

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

/**
 * Revision-fenced submit. `message` is the ordinary turn; `input_response` and
 * `worker_steer` are the VUH-745 typed variants. Variants not yet implementable
 * from current captain primitives return a typed `unsupported` submit result
 * rather than a false `accepted` (see docs/16-operator-conversations.md).
 */
export const SubmitOperatorConversationTurnSchema = z.discriminatedUnion("kind", [
  SubmitOperatorConversationTurnBaseSchema.extend({
    kind: z.literal("message"),
    message: z.string().trim().min(1).max(OPERATOR_CONVERSATION_MESSAGE_MAX),
  }).strict(),
  SubmitOperatorConversationTurnBaseSchema.extend({
    kind: z.literal("input_response"),
    requestId: OperatorConversationEventRefSchema,
    response: OperatorConversationInputResponseSchema,
  }).strict(),
  SubmitOperatorConversationTurnBaseSchema.extend({
    kind: z.literal("worker_steer"),
    workerRunId: OperatorConversationWorkerRunIdSchema,
    intent: OperatorConversationSteerIntentSchema,
  }).strict(),
]);
export type SubmitOperatorConversationTurn = z.infer<typeof SubmitOperatorConversationTurnSchema>;
export type SubmitOperatorConversationTurnKind = SubmitOperatorConversationTurn["kind"];

export const OperatorConversationTurnAcceptedSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("accepted"),
    conversationId: OperatorConversationIdSchema,
    runId: OperatorConversationRunIdSchema,
    revision: z.number().int().nonnegative(),
    safeCursor: OperatorConversationCursorSchema,
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

/** Honest deferral: a submit kind whose captain wiring has not landed yet. */
export const OperatorConversationSubmitUnsupportedSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("unsupported"),
    conversationId: OperatorConversationIdSchema,
    submitKind: z.enum(["message", "input_response", "worker_steer"]),
    reason: z.string().trim().min(1).max(OPERATOR_CONVERSATION_SUMMARY_MAX),
  })
  .strict();
export type OperatorConversationSubmitUnsupported = z.infer<
  typeof OperatorConversationSubmitUnsupportedSchema
>;

export const SubmitOperatorConversationTurnResultSchema = z.discriminatedUnion("status", [
  OperatorConversationTurnAcceptedSchema,
  OperatorConversationRevisionConflictSchema,
  OperatorConversationSubmitUnsupportedSchema,
]);
export type SubmitOperatorConversationTurnResult = z.infer<typeof SubmitOperatorConversationTurnResultSchema>;

// ---------------------------------------------------------------------------
// Callable service contract (VUH-769). A transport-neutral request/result
// envelope any authenticated boundary (the service, the relay) mounts and
// any RN/macOS/TUI client calls. This is the callable contract; VUH-864 owns the
// physical HTTP/NDJSON transport that carries it.
// ---------------------------------------------------------------------------

/** The authenticated route path that carries the callable service contract. */
export const OPERATOR_CONVERSATION_DISPATCH_PATH = "/operator/v1/dispatch";

export const OperatorConversationServiceRequestSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("list"),
      schemaVersion: z.literal(1),
      scope: OperatorConversationScopeSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("get"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("create"),
      schemaVersion: z.literal(1),
      scope: OperatorConversationScopeSchema,
      title: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TITLE_MAX),
    })
    .strict(),
  z
    .object({
      op: z.literal("replay"),
      schemaVersion: z.literal(1),
      replay: ReplayOperatorConversationRequestSchema,
    })
    .strict(),
  // `tail` shares the replay request/result shape (per-surface cursor + typed
  // recovery). The transport long-polls it; the client exposes it as an async
  // iterable via `OperatorConversationTailClient`.
  z
    .object({
      op: z.literal("tail"),
      schemaVersion: z.literal(1),
      tail: ReplayOperatorConversationRequestSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("send"),
      schemaVersion: z.literal(1),
      turn: SubmitOperatorConversationTurnSchema,
    })
    .strict(),
]);
export type OperatorConversationServiceRequest = z.infer<typeof OperatorConversationServiceRequestSchema>;

export const OperatorConversationServiceResultSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("list"),
      schemaVersion: z.literal(1),
      conversations: z.array(OperatorConversationSchema).max(OPERATOR_CONVERSATION_LIST_MAX),
    })
    .strict(),
  z
    .object({
      op: z.literal("get"),
      schemaVersion: z.literal(1),
      conversation: OperatorConversationSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("create"),
      schemaVersion: z.literal(1),
      conversation: OperatorConversationSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("replay"),
      schemaVersion: z.literal(1),
      result: ReplayOperatorConversationResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("tail"),
      schemaVersion: z.literal(1),
      result: ReplayOperatorConversationResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("send"),
      schemaVersion: z.literal(1),
      result: SubmitOperatorConversationTurnResultSchema,
    })
    .strict(),
]);
export type OperatorConversationServiceResult = z.infer<typeof OperatorConversationServiceResultSchema>;

/**
 * Named per-op service results, composed from the discriminated union so RN/
 * macOS/TUI import one coherent set of public names instead of inferring
 * aliases from the union.
 */
export type OperatorConversationListResult = Extract<OperatorConversationServiceResult, { op: "list" }>;
export type OperatorConversationGetResult = Extract<OperatorConversationServiceResult, { op: "get" }>;
export type OperatorConversationCreateResult = Extract<OperatorConversationServiceResult, { op: "create" }>;
export type OperatorConversationReplayResult = Extract<OperatorConversationServiceResult, { op: "replay" }>;
export type OperatorConversationTailResult = Extract<OperatorConversationServiceResult, { op: "tail" }>;
export type OperatorConversationSendResult = Extract<OperatorConversationServiceResult, { op: "send" }>;

/**
 * Transport-neutral dispatch of one service request to its result. RN/macOS
 * supply an authenticated HTTP transport (VUH-864); tests and co-located
 * surfaces supply an in-process dispatch to the captain-owned service handler.
 */
export type OperatorConversationServiceDispatch = (
  request: OperatorConversationServiceRequest,
) => Promise<OperatorConversationServiceResult>;

/**
 * One item yielded by the client `tail` iterable: either a durable event or a
 * typed recovery outcome. The iterable STOPS after yielding a recovery item so
 * the caller decides whether to reset — RN/TUI can distinguish cursor_invalid/
 * expired/reset from an ordinary empty tail and never silently replay past a
 * reset boundary.
 */
export type OperatorConversationTailItem =
  | { readonly kind: "event"; readonly event: OperatorConversationStreamEvent }
  | { readonly kind: "recovery"; readonly recovery: OperatorConversationRecovery };

/**
 * The named public client any RN/macOS/TUI surface uses. It depends only on
 * `@clankie/protocol` types and an injected dispatch — never on Node-only
 * captain-runtime internals — so every surface calls one identical contract.
 */
export interface OperatorConversationServiceClient {
  list(scope?: OperatorConversationScope): Promise<readonly OperatorConversation[]>;
  get(conversationId: string): Promise<OperatorConversation | undefined>;
  create(input: {
    readonly scope: OperatorConversationScope;
    readonly title: string;
  }): Promise<OperatorConversation>;
  replay(request: ReplayOperatorConversationRequest): Promise<ReplayOperatorConversationResult>;
  /**
   * Yields durable events, then a single `recovery` item and STOPS if the server
   * returns a typed recovery outcome. The caller inspects the recovery and, if it
   * chooses, resumes `tail` from `recovery.resetCursor`. The client never
   * auto-resyncs across a reset.
   */
  tail(
    request: ReplayOperatorConversationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OperatorConversationTailItem>;
  send(turn: SubmitOperatorConversationTurn): Promise<SubmitOperatorConversationTurnResult>;
}

export function createOperatorConversationServiceClient(
  dispatch: OperatorConversationServiceDispatch,
  options: { readonly tailIdleMs?: number } = {},
): OperatorConversationServiceClient {
  const tailIdleMs = options.tailIdleMs ?? 250;
  const sleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, tailIdleMs));
  return {
    async list(scope) {
      const result = await dispatch({
        op: "list",
        schemaVersion: 1,
        ...(scope === undefined ? {} : { scope }),
      });
      if (result.op !== "list") throw new Error(`Unexpected ${result.op} result for list`);
      return result.conversations;
    },
    async get(conversationId) {
      const result = await dispatch({ op: "get", schemaVersion: 1, conversationId });
      if (result.op !== "get") throw new Error(`Unexpected ${result.op} result for get`);
      return result.conversation;
    },
    async create(input) {
      const result = await dispatch({
        op: "create",
        schemaVersion: 1,
        scope: input.scope,
        title: input.title,
      });
      if (result.op !== "create") throw new Error(`Unexpected ${result.op} result for create`);
      return result.conversation;
    },
    async replay(request) {
      const result = await dispatch({ op: "replay", schemaVersion: 1, replay: request });
      if (result.op !== "replay") throw new Error(`Unexpected ${result.op} result for replay`);
      return result.result;
    },
    async *tail(request, signal) {
      let cursor = request.cursor;
      while (signal?.aborted !== true) {
        const result = await dispatch({
          op: "tail",
          schemaVersion: 1,
          tail: { ...request, ...(cursor === undefined ? {} : { cursor }) },
        });
        if (result.op !== "tail") throw new Error(`Unexpected ${result.op} result for tail`);
        const page = result.result;
        if (page.status === "recover") {
          // Surface the typed recovery and stop; the caller decides whether to
          // reset. Never silently resync past a reset boundary.
          yield { kind: "recovery", recovery: page };
          return;
        }
        for (const event of page.events) yield { kind: "event", event };
        cursor = page.nextCursor;
        if (page.events.length === 0) await sleep();
      }
    },
    async send(turn) {
      const result = await dispatch({ op: "send", schemaVersion: 1, turn });
      if (result.op !== "send") throw new Error(`Unexpected ${result.op} result for send`);
      return result.result;
    },
  };
}

export const CommandAuthoritySchema = z.object({
  principal: z.object({
    kind: z.enum(["captain", "human", "system"]),
    id: z.string().min(1),
  }),
  tier: z.enum(["authenticated", "ambient", "autonomous", "system"]),
});
export type CommandAuthority = z.infer<typeof CommandAuthoritySchema>;

export const IntentContextSchema = z
  .object({
    sourceLane: CaptainLaneCompatibilitySchema,
    authority: CommandAuthoritySchema,
    correlationId: z.string().min(1),
    causationId: z.string().min(1).optional(),
    expectedGoalVersion: z.number().int().nonnegative(),
  })
  .superRefine((context, refinement) => {
    const { kind } = context.authority.principal;
    const { tier } = context.authority;
    if (kind === "system" && tier === "system") return;
    const expectedTier = {
      tui: "authenticated",
      discord_voice: "ambient",
      discord_presence: "ambient",
      gameplay: "autonomous",
    }[context.sourceLane];
    if (tier !== expectedTier) {
      refinement.addIssue({
        code: "custom",
        path: ["authority", "tier"],
        message: `${context.sourceLane} commands require ${expectedTier} authority`,
      });
    }
  });
export type IntentContext = z.infer<typeof IntentContextSchema>;

export const InteractiveEnvironmentBindingSchema = z.object({
  schemaVersion: z.literal(1),
  environmentKind: z.string().min(1),
  characterId: CharacterIdSchema,
  worldId: WorldIdSchema,
  lane: z.literal("gameplay"),
  environmentSessionId: EnvironmentSessionIdSchema.optional(),
});
export type InteractiveEnvironmentBinding = z.infer<typeof InteractiveEnvironmentBindingSchema>;

// ---------------------------------------------------------------------------
// Event stream identity.
//
// `missionId` is the append-only log's partition key — it is what
// `ProjectionEventStore.readStream` reads and what optimistic concurrency
// counts. Subsystems that have no mission (presence sessions, embodiment
// sessions, devices, triggers) still need their own partition, so they mint a
// namespaced stream id. `streamKind` is what that partition *is*, so a reader
// never has to infer meaning from the shape of an id.
// ---------------------------------------------------------------------------

export const EVENT_STREAM_KINDS = [
  "mission",
  "captain_presence",
  "captain_episodes",
  "captain_project",
  "discord_presence",
  "discord_user_session",
  "embodiment",
  "person_memory",
  "memory_retention",
  "trigger",
  "pairing",
  "device",
  "character",
  "adoption",
  "diagnostic",
] as const;
export const EventStreamKindSchema = z.enum(EVENT_STREAM_KINDS);
export type EventStreamKind = z.infer<typeof EventStreamKindSchema>;

/**
 * Reserved stream namespaces. A writer picks its namespace here and gets the
 * matching `streamKind` stamped automatically; a reader of a pre-`streamKind`
 * event recovers the same answer. Entries are matched longest-prefix-first, so
 * an exact id and a prefix may coexist. Mission ids must never collide with a
 * reserved namespace — see ADR 0065.
 */
const RESERVED_EVENT_STREAM_NAMESPACES: readonly {
  readonly match: string;
  readonly exact: boolean;
  readonly kind: EventStreamKind;
}[] = [
  { match: "captain-presence", exact: true, kind: "captain_presence" },
  { match: "captain:episodes", exact: true, kind: "captain_episodes" },
  { match: "captain-project:", exact: false, kind: "captain_project" },
  { match: "discord-presence:", exact: false, kind: "discord_presence" },
  { match: "discord-user-session:", exact: false, kind: "discord_user_session" },
  { match: "discord-person:", exact: false, kind: "person_memory" },
  { match: "embodiment:", exact: false, kind: "embodiment" },
  { match: "memory:retention", exact: true, kind: "memory_retention" },
  { match: "trigger:", exact: false, kind: "trigger" },
  { match: "pairing:", exact: false, kind: "pairing" },
  { match: "device:", exact: false, kind: "device" },
  { match: "character:", exact: false, kind: "character" },
  // An adoption has no mission of its own (ADR 0078): the agent existed before
  // any mission wanted it, and may outlive the one that borrows it.
  { match: "adoption:", exact: false, kind: "adoption" },
  { match: "provider-readiness", exact: true, kind: "diagnostic" },
  { match: "media-readiness", exact: true, kind: "diagnostic" },
];

/**
 * The kind a stream id declares by its namespace. Writers call this so the kind
 * is stamped once, at append time, rather than re-derived by every reader.
 */
export function eventStreamKindForId(streamId: string): EventStreamKind {
  for (const entry of RESERVED_EVENT_STREAM_NAMESPACES) {
    if (entry.exact ? streamId === entry.match : streamId.startsWith(entry.match)) return entry.kind;
  }
  return "mission";
}

const EventBaseSchema = z.object({
  id: z.string().min(1),
  occurredAt: z.string().datetime(),
  missionId: MissionIdSchema,
  // Optional, never defaulted: `seal()` re-parses before hashing, so a default
  // would materialize a field absent from historical JSON and break
  // `verifyChain` on every event already on disk.
  streamKind: EventStreamKindSchema.optional(),
  taskId: TaskIdSchema.optional(),
  workerRunId: WorkerRunIdSchema.optional(),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  profileHash: z.string().min(1),
});

export const DomainEventSchema = EventBaseSchema.extend({
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

export const CAPTAIN_PRESENCE_SCHEMA_VERSION = 1 as const;
export const CAPTAIN_STATUS_SUBJECT_ID = "captain" as const;

const CaptainLeaseIdentitySchema = z
  .object({
    schemaVersion: z.literal(CAPTAIN_PRESENCE_SCHEMA_VERSION),
    subjectId: z.literal(CAPTAIN_STATUS_SUBJECT_ID),
    captainId: z.string().min(1),
    leaseId: z.string().min(1),
    generationId: z.string().min(1),
    heartbeatAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const CaptainPresenceOnlineDataSchema = CaptainLeaseIdentitySchema.extend({
  state: z.literal("idle"),
  tier: z.literal(1),
  source: z.literal("control-plane.captain_lease"),
  confidence: z.literal(1),
  observedAt: z.string().datetime(),
}).strict();
export type CaptainPresenceOnlineData = z.infer<typeof CaptainPresenceOnlineDataSchema>;

export const CaptainPresenceOfflineDataSchema = CaptainLeaseIdentitySchema.extend({
  state: z.literal("offline"),
  tier: z.literal(1),
  source: z.literal("control-plane.captain_lease"),
  confidence: z.literal(1),
  observedAt: z.string().datetime(),
  reason: z.enum(["lease_expired", "superseded"]),
}).strict();
export type CaptainPresenceOfflineData = z.infer<typeof CaptainPresenceOfflineDataSchema>;

export const CaptainHeartbeatDataSchema = CaptainLeaseIdentitySchema.extend({
  state: z.literal("idle"),
  tier: z.literal(1),
  source: z.literal("control-plane.captain_lease"),
  confidence: z.literal(1),
  observedAt: z.string().datetime(),
}).strict();
export type CaptainHeartbeatData = z.infer<typeof CaptainHeartbeatDataSchema>;

const CaptainTurnIdentitySchema = z
  .object({
    schemaVersion: z.literal(CAPTAIN_PRESENCE_SCHEMA_VERSION),
    subjectId: z.literal(CAPTAIN_STATUS_SUBJECT_ID),
    captainId: z.string().min(1),
    leaseId: z.string().min(1),
    generationId: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    tier: z.literal(0),
    source: z.literal("eve.lifecycle"),
    confidence: z.literal(1),
    observedAt: z.string().datetime(),
  })
  .strict();

export const CaptainTurnStartedDataSchema = CaptainTurnIdentitySchema.extend({
  state: z.literal("working"),
}).strict();
export type CaptainTurnStartedData = z.infer<typeof CaptainTurnStartedDataSchema>;

export const CaptainTurnSettledDataSchema = z.discriminatedUnion("state", [
  CaptainTurnIdentitySchema.extend({ state: z.literal("idle") }).strict(),
  CaptainTurnIdentitySchema.extend({
    state: z.literal("waiting_user"),
    questionSummary: z.string().trim().min(1).max(512),
  }).strict(),
]);
export type CaptainTurnSettledData = z.infer<typeof CaptainTurnSettledDataSchema>;

export const CaptainWaitingDependencyDataSchema = CaptainTurnIdentitySchema.extend({
  state: z.literal("waiting_dependency"),
  summary: z.string().trim().min(1).max(512),
}).strict();
export type CaptainWaitingDependencyData = z.infer<typeof CaptainWaitingDependencyDataSchema>;

export const CaptainPresenceEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("captain.presence.online"),
    data: CaptainPresenceOnlineDataSchema,
  }),
  EventBaseSchema.extend({
    type: z.literal("captain.presence.offline"),
    data: CaptainPresenceOfflineDataSchema,
  }),
  EventBaseSchema.extend({ type: z.literal("captain.heartbeat"), data: CaptainHeartbeatDataSchema }),
  EventBaseSchema.extend({ type: z.literal("captain.turn.started"), data: CaptainTurnStartedDataSchema }),
  EventBaseSchema.extend({ type: z.literal("captain.turn.settled"), data: CaptainTurnSettledDataSchema }),
  EventBaseSchema.extend({
    type: z.literal("captain.waiting_dependency"),
    data: CaptainWaitingDependencyDataSchema,
  }),
]);
export type CaptainPresenceEvent = z.infer<typeof CaptainPresenceEventSchema>;

const CaptainPresenceReportBaseSchema = z
  .object({
    schemaVersion: z.literal(CAPTAIN_PRESENCE_SCHEMA_VERSION),
    eventId: z.string().min(1),
    leaseId: z.string().min(1),
    generationId: z.string().min(1),
    occurredAt: z.string().datetime(),
  })
  .strict();

const CaptainTurnReportBaseSchema = CaptainPresenceReportBaseSchema.extend({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
});

export const CaptainPresenceReportSchema = z.union([
  CaptainPresenceReportBaseSchema.extend({ type: z.literal("captain.heartbeat") }).strict(),
  CaptainTurnReportBaseSchema.extend({ type: z.literal("captain.turn.started") }).strict(),
  CaptainTurnReportBaseSchema.extend({
    type: z.literal("captain.turn.settled"),
    state: z.literal("idle"),
  }).strict(),
  CaptainTurnReportBaseSchema.extend({
    type: z.literal("captain.turn.settled"),
    state: z.literal("waiting_user"),
    questionSummary: z.string().trim().min(1).max(512),
  }).strict(),
  CaptainTurnReportBaseSchema.extend({
    type: z.literal("captain.waiting_dependency"),
    summary: z.string().trim().min(1).max(512),
  }).strict(),
]);
export type CaptainPresenceReport = z.infer<typeof CaptainPresenceReportSchema>;

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

/** Sole write target of the runner's browser host, relative to the attachment root. */
export const BROWSER_ARTIFACT_DIRECTORY = "browser";

/** Sole write target of the runner's diagram host, relative to the attachment root. */
export const TLDRAW_ARTIFACT_DIRECTORY = "tldraw";

/** Sole write target of Discord stream-watch stills, relative to the attachment root. */
export const SHARE_ARTIFACT_DIRECTORY = "shares";

const GENERATED_MEDIA_REF_PATTERN = new RegExp(
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
 * Whether a reference names a screenshot the runner's browser host minted.
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
 * Whether a reference names a diagram the runner's tldraw host minted.
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
 * Every one of these directories is written only by a governed runner-side
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
      captainSessionId: z.string().min(1),
      turnId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("waiting_user"),
      captainSessionId: z.string().min(1),
      turnId: z.string().min(1),
      prompt: z.string().trim().min(1).max(16_384),
      approvalRequired: z.boolean(),
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
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
 * serve both planes; the runtime binding plus doctrine decide availability.
 */
export const DiscordTransportKindSchema = z.enum(["bot", "user_session"]);
export type DiscordTransportKind = z.infer<typeof DiscordTransportKindSchema>;

/** Transport-agnostic Discord presence action names (ADR 0024). No bot/user token fields. */
export const DiscordPresenceActionSchema = z.enum([
  "discord.presence.reply",
  /**
   * His reply, with a picture he made during the same turn (ADR 0085).
   *
   * A separate action rather than an optional field on `reply` so the frozen
   * risk-class table below states the truth about what may carry bytes into a
   * channel. It is narrative-write because the payload can only reference media
   * a governed runner-side host minted — the generator or the browser host, see
   * `isAttachableTurnMediaRef`. Any other artifact is still `send_attachment`,
   * still publish-external, still approval-gated.
   */
  "discord.presence.reply_with_media",
  "discord.presence.react",
  "discord.presence.unreact",
  "discord.presence.send_message",
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

/** Grounded Discord actions a social captain turn may ask the live body to perform. */
export const DiscordCaptainActionSchema = z.enum([
  "react",
  "unreact",
  "create_thread",
  "join_thread",
  "watch_start",
  "watch_stop",
]);
export type DiscordCaptainAction = z.infer<typeof DiscordCaptainActionSchema>;

const DiscordCaptainActionContextSchema = z.object({
  callId: z.string().min(1).max(256),
  actorId: z.string().min(1).max(128),
  guildId: z.string().min(1).max(128).optional(),
  channelId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128),
});

/** IDs are host-stamped from the active turn; the model supplies only action content. */
export const DiscordCaptainActionInputSchema = z.discriminatedUnion("action", [
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
  DiscordCaptainActionContextSchema.extend({
    action: z.literal("watch_start"),
    guildId: z.string().min(1).max(128),
  }).strict(),
  DiscordCaptainActionContextSchema.extend({
    action: z.literal("watch_stop"),
    guildId: z.string().min(1).max(128),
  }).strict(),
]);
export type DiscordCaptainActionInput = z.infer<typeof DiscordCaptainActionInputSchema>;

export const DiscordCaptainActionResultSchema = z
  .object({ ok: z.boolean(), message: z.string().min(1).max(1_000) })
  .strict();
export type DiscordCaptainActionResult = z.infer<typeof DiscordCaptainActionResultSchema>;

/**
 * Rendered surfaces the activity plane may publish (ADR 0047). Frozen lab
 * catalog: the executor maps a surface to its configured Discord application id
 * so a model can never name an arbitrary application to launch.
 */
export const DiscordActivitySurfaceSchema = z.enum(["gba_emulator"]);
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
  "failed",
]);
export type DiscordVoicePresenceResultReason = z.infer<typeof DiscordVoicePresenceResultReasonSchema>;

/**
 * What the live Discord body did when the captain used a voice-presence tool.
 * The body resolves the asker's current channel and enforces authority; the
 * model supplies neither ids nor an explanation of the result.
 */
export const DiscordVoicePresenceResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("joined"),
      channelId: z.string().min(1),
      /** Whether this join explicitly opted the authenticated speaker into capture. */
      actorAutoOptedIn: z.boolean(),
    })
    .strict(),
  z.object({ action: z.literal("join_refused"), reason: DiscordVoicePresenceResultReasonSchema }).strict(),
  z.object({ action: z.literal("left"), channelId: z.string().min(1).optional() }).strict(),
  z.object({ action: z.literal("leave_refused"), reason: DiscordVoicePresenceResultReasonSchema }).strict(),
]);
export type DiscordVoicePresenceResult = z.infer<typeof DiscordVoicePresenceResultSchema>;

export const DiscordPresenceChannelTurnRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    deliveryId: z.string().min(1),
    identity: DiscordPresenceChannelIdentitySchema,
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
        ].includes(write.action) &&
        write.identity.presenceSessionId !== undefined
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
 * bound to the doctrine profile that was in force when the risk was accepted.
 * Re-compiling doctrine therefore invalidates the opt-in rather than silently
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
    frame: z
      .object({
        streamKey: z.string().min(1),
        userId: z.string().min(1),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        jpegBase64: z.string().min(1),
        artifactRef: z.string().optional(),
        capturedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
    decoder: z.enum(["ready", "missing", "error", "idle"]),
    decoderDetail: z.string().max(400).optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .strict();
export type DiscordStreamWatchObservation = z.infer<typeof DiscordStreamWatchObservationSchema>;

export const DISCORD_STREAM_WATCH_PATH = "/v1/discord/stream-watch";

// ---------------------------------------------------------------------------

// --- Device pairing & registry (VUH-727) ---

/** Platform a paired device reports at redemption. */
export const DevicePlatformSchema = z.enum(["ios", "android", "macos", "unknown"]);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

/**
 * Per-device capability grants — field-for-field the app's `PairingGrantSet`.
 * `terminalControl` is never granted in this slice: the runner terminal gateway
 * is observe-only, so {@link DeviceRecordSchema} rejects any record that carries
 * it. The grant→terminal-scope mapping (`terminalObserve`→`observe`,
 * `terminalControl`→`control`) lives in `@clankie/terminal-protocol` and is not
 * wired here.
 */
export const DeviceGrantSetSchema = z.object({
  chat: z.boolean(),
  steer: z.boolean(),
  terminalObserve: z.boolean(),
  terminalControl: z.boolean(),
});
export type DeviceGrantSet = z.infer<typeof DeviceGrantSetSchema>;

/** The Supervise preset offered at pairing: chat + steer + observe, never control. */
export const SUPERVISE_GRANTS: DeviceGrantSet = {
  chat: true,
  steer: true,
  terminalObserve: true,
  terminalControl: false,
};

export const DeviceStatusSchema = z.enum(["pending", "active", "revoked"]);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

/**
 * Durable device record projected from the `device:${deviceId}` event stream.
 * Secret-free: it never carries the session token, its hash, or the offer
 * secret. `grants` holds the offered set while pending and the accepted subset
 * once active.
 */
export const DeviceRecordSchema = z
  .object({
    deviceId: z.string().min(1),
    name: z.string().min(1).max(64),
    platform: DevicePlatformSchema,
    status: DeviceStatusSchema,
    grants: DeviceGrantSetSchema,
    offerId: z.string().min(1),
    mintedBy: z.string().min(1),
    createdAt: z.string().datetime(),
    pendingExpiresAt: z.string().datetime(),
    activatedAt: z.string().datetime().optional(),
    lastRefreshAt: z.string().datetime().optional(),
    revokedAt: z.string().datetime().optional(),
    revokedBy: z.string().min(1).optional(),
  })
  .superRefine((record, context) => {
    if (record.grants.terminalControl) {
      context.addIssue({
        code: "custom",
        message: "terminalControl is not grantable in this slice",
        path: ["grants", "terminalControl"],
      });
    }
    if (record.status === "active" && record.activatedAt === undefined) {
      context.addIssue({ code: "custom", message: "Active devices require activatedAt", path: ["status"] });
    }
    if (record.status === "revoked" && (record.revokedAt === undefined || record.revokedBy === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Revoked devices require revokedAt and revokedBy",
        path: ["status"],
      });
    }
  });
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

/** Canonical `clankie pair` offer wire shape (server mints it, `clankie pair` renders it). */
export const PairingOfferWireSchema = z.object({
  version: z.literal(1),
  deepLink: z.string().min(1),
  code: z.string().min(1),
  expiresAt: z.string().datetime(),
});
export type PairingOfferWire = z.infer<typeof PairingOfferWireSchema>;

/** Host identity shown on the device's access-review screen. */
export const PairingHostSchema = z.object({ name: z.string().min(1) });
export type PairingHost = z.infer<typeof PairingHostSchema>;

/** Redeem step: the offer secret or typed code is the capability; carries device metadata. */
export const PairingRedeemRequestSchema = z
  .object({
    offerSecret: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    device: z.object({ name: z.string().min(1).max(64), platform: DevicePlatformSchema }),
  })
  .superRefine((body, context) => {
    const provided = [body.offerSecret, body.code].filter((value) => value !== undefined);
    if (provided.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of offerSecret or code",
        path: ["offerSecret"],
      });
    }
  });
export type PairingRedeemRequest = z.infer<typeof PairingRedeemRequestSchema>;

export const PairingRedeemResponseSchema = z.object({
  deviceId: z.string().min(1),
  host: PairingHostSchema,
  offeredGrants: DeviceGrantSetSchema,
  completionToken: z.string().min(1),
  expiresAt: z.string().datetime(),
});
export type PairingRedeemResponse = z.infer<typeof PairingRedeemResponseSchema>;

/** Complete step: the device accepts a subset of the offered grants. */
export const PairingCompleteRequestSchema = z.object({
  completionToken: z.string().min(1),
  acceptedGrants: DeviceGrantSetSchema,
});
export type PairingCompleteRequest = z.infer<typeof PairingCompleteRequestSchema>;

export const PairingCompleteResponseSchema = z.object({
  deviceId: z.string().min(1),
  deviceToken: z.string().min(1),
  grants: DeviceGrantSetSchema,
  sessionExpiresAt: z.string().datetime(),
});
export type PairingCompleteResponse = z.infer<typeof PairingCompleteResponseSchema>;

export const DeviceSessionRefreshResponseSchema = z.object({
  deviceToken: z.string().min(1),
  grants: DeviceGrantSetSchema,
  sessionExpiresAt: z.string().datetime(),
});
export type DeviceSessionRefreshResponse = z.infer<typeof DeviceSessionRefreshResponseSchema>;

/** Device-authenticated view of its own registration, used to restore a session on launch. */
export const DeviceSelfResponseSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().min(1),
  platform: DevicePlatformSchema,
  grants: DeviceGrantSetSchema,
  host: PairingHostSchema,
  sessionExpiresAt: z.string().datetime(),
});
export type DeviceSelfResponse = z.infer<typeof DeviceSelfResponseSchema>;

/** Secret-free device row for the operator `GET /v1/devices` list. */
export const DeviceListItemSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().min(1),
  platform: DevicePlatformSchema,
  status: DeviceStatusSchema,
  grants: DeviceGrantSetSchema,
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().optional(),
  lastRefreshAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
  revokedBy: z.string().min(1).optional(),
});
export type DeviceListItem = z.infer<typeof DeviceListItemSchema>;

/**
 * Content-free reason codes for the redeem/complete boundary. Extends the
 * `clankie pair` client's fail-closed vocabulary (expired/consumed/revoked)
 * with the malformed and terminal-control-denied cases redemption adds.
 */
export const PairingRedeemErrorSchema = z.object({
  error: z.enum(["expired", "consumed", "revoked", "malformed", "terminal_control_not_grantable"]),
});
export type PairingRedeemError = z.infer<typeof PairingRedeemErrorSchema>;

/**
 * Durable device lifecycle events on the `device:${deviceId}` stream. Every
 * `data` payload is secret-free; token material and offer secrets never appear.
 */
export const DeviceEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("device.pairing.redeemed"),
    data: z.object({
      schemaVersion: z.literal(1),
      deviceId: z.string().min(1),
      offerId: z.string().min(1),
      name: z.string().min(1).max(64),
      platform: DevicePlatformSchema,
      offeredGrants: DeviceGrantSetSchema,
      mintedBy: z.string().min(1),
      pendingExpiresAt: z.string().datetime(),
    }),
  }),
  EventBaseSchema.extend({
    type: z.literal("device.activated"),
    data: z.object({
      schemaVersion: z.literal(1),
      deviceId: z.string().min(1),
      grants: DeviceGrantSetSchema,
      sessionExpiresAt: z.string().datetime(),
    }),
  }),
  EventBaseSchema.extend({
    type: z.literal("device.session.refreshed"),
    data: z.object({
      schemaVersion: z.literal(1),
      deviceId: z.string().min(1),
      grants: DeviceGrantSetSchema,
      sessionExpiresAt: z.string().datetime(),
    }),
  }),
  EventBaseSchema.extend({
    type: z.literal("device.grant.denied"),
    data: z.object({
      schemaVersion: z.literal(1),
      deviceId: z.string().min(1),
      requestedGrant: z.literal("terminalControl"),
      reason: z.literal("terminal_control_not_grantable"),
      stage: z.literal("complete"),
    }),
  }),
  EventBaseSchema.extend({
    type: z.literal("device.revoked"),
    data: z.object({
      schemaVersion: z.literal(1),
      deviceId: z.string().min(1),
      revokedBy: z.string().min(1),
    }),
  }),
]);
export type DeviceEvent = z.infer<typeof DeviceEventSchema>;

// ---------------------------------------------------------------------------
// Asked embodiment (ADR 0063): the captain asks for play, the embodiment
// authority holds the intent, the play host owns the session.
//
// Every schema is a STRICT, content-free wire boundary: ids, enums, counters,
// and timestamps only. No field may carry free text, model output, frame
// bytes, or anything a message body could smuggle through.
// ---------------------------------------------------------------------------

/** Environments the play seam serves; Minecraft joins when its host lands. */
export const EmbodimentEnvironmentIdSchema = z.enum(["pokemon-firered", "pokemon-emerald"]);
export type EmbodimentEnvironmentId = z.infer<typeof EmbodimentEnvironmentIdSchema>;

export const EmbodimentIntentIdSchema = z.string().min(1).max(200);
export type EmbodimentIntentId = z.infer<typeof EmbodimentIntentIdSchema>;

export const EmbodimentRunnerIdSchema = z.string().min(1).max(200);
export type EmbodimentRunnerId = z.infer<typeof EmbodimentRunnerIdSchema>;

export const EmbodimentCheckpointIdSchema = z.string().min(1).max(200);
export type EmbodimentCheckpointId = z.infer<typeof EmbodimentCheckpointIdSchema>;

/**
 * An absent field is "no cap" — the owner's chosen default (2026-07-26): he
 * plays until asked to stop. The stop ask, the single-holder body lock, and
 * lease mechanics are the standing controls; a present field is a caller's
 * deliberate bound and must still be a positive integer.
 */
export const EmbodimentBudgetSchema = z
  .object({
    maxTurns: z.number().int().positive().optional(),
    maxDurationMs: z.number().int().positive().optional(),
  })
  .strict();
export type EmbodimentBudget = z.infer<typeof EmbodimentBudgetSchema>;

const embodimentIntentBase = {
  schemaVersion: z.literal(1),
  intentId: EmbodimentIntentIdSchema,
  originLane: CaptainSessionLaneV2Schema,
  /** Content-free principal id, as the origin lane authenticated it. */
  requestedBy: z.string().min(1).max(200),
  requestedAt: z.string().datetime(),
} as const;

/**
 * A stop intent targets the live session, never an environment: stopping "the
 * game" when a different session than the asker imagines is running must stop
 * nothing and refuse `not_playing`-adjacent, not guess.
 */
export const EmbodimentIntentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("start"),
      ...embodimentIntentBase,
      environmentId: EmbodimentEnvironmentIdSchema,
      budget: EmbodimentBudgetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("stop"),
      ...embodimentIntentBase,
      sessionId: EnvironmentSessionIdSchema,
    })
    .strict(),
]);
export type EmbodimentIntent = z.infer<typeof EmbodimentIntentSchema>;

export const EmbodimentSessionStateSchema = z.enum([
  "requested",
  "claimed",
  "running",
  "stopping",
  "stopped",
  "refused",
  "failed",
]);
export type EmbodimentSessionState = z.infer<typeof EmbodimentSessionStateSchema>;

/**
 * `body_held` is one reason on purpose (ADR 0063): whether the service
 * saw a live asked session or the body lock saw an external
 * possessor, he says the same true thing — someone is already driving.
 */
export const EmbodimentRefusalReasonSchema = z.enum([
  "body_held",
  "no_runner",
  "environment_unavailable",
  "budget",
  "policy",
  "not_playing",
]);
export type EmbodimentRefusalReason = z.infer<typeof EmbodimentRefusalReasonSchema>;

/** The one authority for session-state transitions, shared by every process. */
export const EMBODIMENT_SESSION_TRANSITIONS: Readonly<
  Record<EmbodimentSessionState, readonly EmbodimentSessionState[]>
> = {
  requested: ["claimed", "refused"],
  claimed: ["running", "refused", "failed"],
  running: ["stopping", "stopped", "failed"],
  stopping: ["stopped", "failed"],
  stopped: [],
  refused: [],
  failed: [],
};

export function canTransitionEmbodimentSession(
  from: EmbodimentSessionState,
  to: EmbodimentSessionState,
): boolean {
  return EMBODIMENT_SESSION_TRANSITIONS[from].includes(to);
}

/** Durable service record of one asked session, replayed from events. */
export const EmbodimentSessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: EnvironmentSessionIdSchema,
    environmentId: EmbodimentEnvironmentIdSchema,
    state: EmbodimentSessionStateSchema,
    intentId: EmbodimentIntentIdSchema,
    originLane: CaptainSessionLaneV2Schema,
    requestedBy: z.string().min(1).max(200),
    budget: EmbodimentBudgetSchema,
    requestedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /** Present from `claimed` onward; a pre-claim refusal never had a runner. */
    runnerId: EmbodimentRunnerIdSchema.optional(),
    refusalReason: EmbodimentRefusalReasonSchema.optional(),
    /** ADR 0060 lineage; absent on a cold start. */
    resumedFromCheckpointId: EmbodimentCheckpointIdSchema.optional(),
    /** Minted on graceful stop. */
    checkpointId: EmbodimentCheckpointIdSchema.optional(),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.state === "refused" && session.refusalReason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["refusalReason"],
        message: "Refused sessions carry the typed reason his reply renders",
      });
    }
    if (session.state !== "refused" && session.refusalReason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["refusalReason"],
        message: "Only refused sessions carry a refusal reason",
      });
    }
    const postClaim: EmbodimentSessionState[] = ["claimed", "running", "stopping", "stopped", "failed"];
    if (postClaim.includes(session.state) && session.runnerId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["runnerId"],
        message: "Post-claim states attribute the owning runner",
      });
    }
  });
export type EmbodimentSession = z.infer<typeof EmbodimentSessionSchema>;

/** A runner's poll for embodiment work, in the mission claim shape. */
export const EmbodimentClaimSchema = z
  .object({
    schemaVersion: z.literal(1),
    claimId: z.string().min(1).max(200),
    runnerId: EmbodimentRunnerIdSchema,
    environmentIds: z.array(EmbodimentEnvironmentIdSchema).min(1),
  })
  .strict();
export type EmbodimentClaim = z.infer<typeof EmbodimentClaimSchema>;

/**
 * The service's answer to a submitted intent. A refused start still
 * carries the minted session id when one was recorded, so the refusal stays
 * queryable rather than dropped.
 */
export const EmbodimentSubmitResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted"), session: EmbodimentSessionSchema }).strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reason: EmbodimentRefusalReasonSchema,
      sessionId: EnvironmentSessionIdSchema.optional(),
    })
    .strict(),
  z.object({ outcome: z.literal("stop_requested"), session: EmbodimentSessionSchema }).strict(),
]);
export type EmbodimentSubmitResult = z.infer<typeof EmbodimentSubmitResultSchema>;

/**
 * What a claim poll hands the runner: a start session to own, or a stop for a
 * session it already owns. Stops re-deliver until the runner reports them
 * done; stopping twice is idempotent, silently missing a stop is not.
 */
export const EmbodimentAssignmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), session: EmbodimentSessionSchema }).strict(),
  z.object({ kind: z.literal("stop"), sessionId: EnvironmentSessionIdSchema }).strict(),
]);
export type EmbodimentAssignment = z.infer<typeof EmbodimentAssignmentSchema>;

export const EmbodimentSessionOutcomeSchema = z.enum([
  "stopped",
  "budget_exhausted",
  "failed",
  "lease_lapsed",
]);
export type EmbodimentSessionOutcome = z.infer<typeof EmbodimentSessionOutcomeSchema>;

/** Terminal accounting for one session: counters and checkpoint lineage only. */
export const EmbodimentSessionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: EnvironmentSessionIdSchema,
    environmentId: EmbodimentEnvironmentIdSchema,
    outcome: EmbodimentSessionOutcomeSchema,
    turnsTaken: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    framesPublished: z.number().int().nonnegative(),
    /** Sink-degraded frames; play continues without a producer, counted not hidden. */
    framesDropped: z.number().int().nonnegative(),
    resumedFromCheckpointId: EmbodimentCheckpointIdSchema.optional(),
    checkpointId: EmbodimentCheckpointIdSchema.optional(),
  })
  .strict();
export type EmbodimentSessionReceipt = z.infer<typeof EmbodimentSessionReceiptSchema>;

/**
 * Who holds Clankie's body right now (VUH-938): a read-only projection of the
 * cross-process body lock, the one authority that sees every suitor —
 * including an MCP possessor no embodiment session ever recorded (ADR 0053,
 * ADR 0063). Liveness-checked at read time; a dead holder's lock reports as
 * nobody. The pid stays off the wire: consumers need who and since when, not
 * process trivia.
 */
export const BodyPossessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    holderId: z.string().min(1).max(200),
    acquiredAt: z.string().min(1),
  })
  .strict();
export type BodyPossession = z.infer<typeof BodyPossessionSchema>;

/** Wire shape of `GET /v1/embodiment/possession`; `possession: null` means nobody holds the body. */
export const BodyPossessionReadSchema = z
  .object({
    schemaVersion: z.literal(1),
    possession: BodyPossessionSchema.nullable(),
  })
  .strict();
export type BodyPossessionRead = z.infer<typeof BodyPossessionReadSchema>;

export const EmbodimentReportStateSchema = z.enum(["running", "stopping", "stopped", "refused", "failed"]);
export type EmbodimentReportState = z.infer<typeof EmbodimentReportStateSchema>;

/** One play-host→service lifecycle transition for a claimed session. */
export const EmbodimentLifecycleReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: EnvironmentSessionIdSchema,
    runnerId: EmbodimentRunnerIdSchema,
    state: EmbodimentReportStateSchema,
    reportedAt: z.string().datetime(),
    refusalReason: EmbodimentRefusalReasonSchema.optional(),
    receipt: EmbodimentSessionReceiptSchema.optional(),
    /** ADR 0060 lineage, reported at start; terminal receipts repeat it. */
    resumedFromCheckpointId: EmbodimentCheckpointIdSchema.optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.resumedFromCheckpointId !== undefined && report.state !== "running") {
      context.addIssue({
        code: "custom",
        path: ["resumedFromCheckpointId"],
        message: "Checkpoint lineage is reported when the session starts running",
      });
    }
    if (report.state === "refused" && report.refusalReason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["refusalReason"],
        message: "Refused reports carry the typed reason",
      });
    }
    if (report.state !== "refused" && report.refusalReason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["refusalReason"],
        message: "Only refused reports carry a refusal reason",
      });
    }
    const terminal = report.state === "stopped" || report.state === "failed";
    if (terminal && report.receipt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["receipt"],
        message: "Terminal reports carry the session receipt",
      });
    }
    if (!terminal && report.receipt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["receipt"],
        message: "Only terminal reports carry a receipt",
      });
    }
  });
export type EmbodimentLifecycleReport = z.infer<typeof EmbodimentLifecycleReportSchema>;

/**
 * The captain tool's typed outcome, like DiscordVoicePresenceResult: the
 * reply reflects what actually happened, and a refusal names a reason he can
 * say out loud. `pending` means the bounded wait elapsed before the runner
 * answered — the request stands, and he must not claim to be playing yet.
 */
export const EmbodimentPlayNoteSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("started"),
      sessionId: EnvironmentSessionIdSchema,
      environmentId: EmbodimentEnvironmentIdSchema,
      resumedFromCheckpointId: EmbodimentCheckpointIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("start_refused"),
      environmentId: EmbodimentEnvironmentIdSchema,
      reason: EmbodimentRefusalReasonSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("stopped"),
      sessionId: EnvironmentSessionIdSchema,
      checkpointId: EmbodimentCheckpointIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("stop_refused"),
      sessionId: EnvironmentSessionIdSchema.optional(),
      reason: EmbodimentRefusalReasonSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("pending"),
      intentId: EmbodimentIntentIdSchema,
    })
    .strict(),
]);
export type EmbodimentPlayNote = z.infer<typeof EmbodimentPlayNoteSchema>;

// ---------------------------------------------------------------------------
// Discord person memory (ADR 0042).
//
// This is the one public wire contract shared by Discord ingress, the control
// plane, API clients, and storage. It deliberately carries stable Discord ids
// and bounded approved facts, never display names or raw transcript content.
// ---------------------------------------------------------------------------

export const DiscordPersonIdentitySchema = z
  .object({
    guildId: z.string().trim().min(1).max(64),
    userId: z.string().trim().min(1).max(64),
  })
  .strict();
export type DiscordPersonIdentity = z.infer<typeof DiscordPersonIdentitySchema>;

export const DiscordPersonMemoryKindSchema = z.enum(["person-fact", "preference", "relationship-note"]);
export type DiscordPersonMemoryKind = z.infer<typeof DiscordPersonMemoryKindSchema>;

export const DiscordPersonMemoryVisibilitySchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("guild") }).strict(),
  z.object({ scope: z.literal("channel"), channelId: z.string().trim().min(1).max(64) }).strict(),
  z.object({ scope: z.literal("operator_private") }).strict(),
]);
export type DiscordPersonMemoryVisibility = z.infer<typeof DiscordPersonMemoryVisibilitySchema>;

export const DiscordPersonMemoryFactSchema = z
  .object({
    schemaVersion: z.literal(1),
    factId: z.string().trim().min(1).max(256),
    subject: DiscordPersonIdentitySchema,
    kind: DiscordPersonMemoryKindSchema,
    body: z.string().trim().min(1).max(2_048),
    visibility: DiscordPersonMemoryVisibilitySchema,
    provenance: z
      .object({
        correlationId: z.string().trim().min(1).max(256),
        sourceEventId: z.string().trim().min(1).max(256),
        sourceSurface: z.enum(["discord_text", "discord_voice", "operator"]),
        rawTranscript: z.literal(false),
      })
      .strict(),
    confidence: z.number().min(0).max(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    supersedesFactId: z.string().trim().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((fact, context) => {
    if (fact.updatedAt < fact.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt must not precede createdAt",
      });
    }
    if (fact.expiresAt !== undefined && fact.expiresAt <= fact.updatedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must follow updatedAt",
      });
    }
    if (fact.supersedesFactId === fact.factId) {
      context.addIssue({
        code: "custom",
        path: ["supersedesFactId"],
        message: "a person-memory fact cannot supersede itself",
      });
    }
  });
export type DiscordPersonMemoryFact = z.infer<typeof DiscordPersonMemoryFactSchema>;

export const DiscordPersonMemoryProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: z.string().trim().min(1).max(256),
    fact: DiscordPersonMemoryFactSchema,
  })
  .strict();
export type DiscordPersonMemoryProposal = z.infer<typeof DiscordPersonMemoryProposalSchema>;

export const DiscordPersonMemoryProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    subject: DiscordPersonIdentitySchema,
    facts: z.array(DiscordPersonMemoryFactSchema).max(128),
    recallCard: z.string().max(4_096).optional(),
  })
  .strict();
export type DiscordPersonMemoryProjection = z.infer<typeof DiscordPersonMemoryProjectionSchema>;

export const DiscordPersonMemoryExportSchema = z
  .object({
    schemaVersion: z.literal(1),
    subject: DiscordPersonIdentitySchema,
    exportedAt: z.string().datetime(),
    facts: z.array(DiscordPersonMemoryFactSchema).max(128),
  })
  .strict();
export type DiscordPersonMemoryExport = z.infer<typeof DiscordPersonMemoryExportSchema>;

export const DiscordPersonMemoryDeleteResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    subject: DiscordPersonIdentitySchema,
    deletedFactIds: z.array(z.string().trim().min(1).max(256)).max(128),
  })
  .strict();
export type DiscordPersonMemoryDeleteResult = z.infer<typeof DiscordPersonMemoryDeleteResultSchema>;

/** Authenticated owner edits preserve the fact's identity and source provenance. */
export const DiscordPersonMemoryEditSchema = z
  .object({
    body: z.string().trim().min(1).max(2_048).optional(),
    kind: DiscordPersonMemoryKindSchema.optional(),
    visibility: DiscordPersonMemoryVisibilitySchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((edit) => Object.keys(edit).length > 0, "an edit must change at least one field");
export type DiscordPersonMemoryEdit = z.infer<typeof DiscordPersonMemoryEditSchema>;

// ---------------------------------------------------------------------------
// Clankie's browser (ADR 0082).
//
// The captain drives a runner-hosted `agent-browser` MCP server. Descriptors
// are projected through doctrine before they reach him, so `requiresApproval`
// is a decided fact carried on the wire rather than something the captain or
// the model re-derives.
// ---------------------------------------------------------------------------

export const BrowserToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u, "Browser tool names are alphanumerics with underscores or dashes");

export const BrowserToolDescriptorSchema = z.object({
  name: BrowserToolNameSchema,
  description: z.string().max(4_000),
  /** JSON Schema for the tool's arguments, verbatim from the MCP server. */
  inputSchema: z.record(z.string(), z.unknown()),
  riskClass: z.enum(["read", "reversible-write", "irreversible-write", "publish-external", "destructive"]),
  /** Doctrine returned `require_approval`; the call needs an approval envelope. */
  requiresApproval: z.boolean(),
});
export type BrowserToolDescriptor = z.infer<typeof BrowserToolDescriptorSchema>;

export const BrowserToolCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  /** `false` means the host could not be reached — never that no tools exist. */
  available: z.boolean(),
  reason: z.string().max(200).optional(),
  tools: z.array(BrowserToolDescriptorSchema).max(256),
});
export type BrowserToolCatalog = z.infer<typeof BrowserToolCatalogSchema>;

export const CallBrowserToolRequestSchema = z.object({
  schemaVersion: z.literal(1),
  tool: BrowserToolNameSchema,
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export type CallBrowserToolRequest = z.infer<typeof CallBrowserToolRequestSchema>;

/**
 * A refusal is a normal outcome, not an exception: doctrine may deny the tool
 * and an approval may be outstanding. Both come back as results the captain
 * can relay in words rather than errors he has to interpret.
 */
/**
 * A non-text result the browser produced, parked as bytes on the runner.
 *
 * Screenshots come back as base64 image blocks, and base64 pixels are the one
 * thing that must never enter a captain turn: a single screenshot is tens of
 * kilobytes of tokens that say nothing a model can read. The bytes are written
 * where the Discord attachment resolver can already find them and only the
 * hash-bound reference travels, which is the same shape every other artifact
 * in this system uses.
 */
export const BrowserArtifactSchema = z.object({
  /** `sha256:<hex>:<path-relative-to-the-attachment-root>`, as the resolver expects. */
  artifactRef: z.string().regex(/^sha256:[0-9a-f]{64}:.+$/u),
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  byteLength: z.number().int().nonnegative(),
});
export type BrowserArtifact = z.infer<typeof BrowserArtifactSchema>;

export const CallBrowserToolResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ok"),
    tool: BrowserToolNameSchema,
    /** Text blocks from the MCP result, already bounded by the host. */
    content: z.string().max(200_000),
    isError: z.boolean().default(false),
    /** Images and other bytes the call produced; empty for most tools. */
    artifacts: z.array(BrowserArtifactSchema).max(8).default([]),
  }),
  z.object({
    outcome: z.literal("refused"),
    tool: BrowserToolNameSchema,
    reason: z.enum(["doctrine_denied", "approval_required", "unknown_tool", "browser_unavailable"]),
    detail: z.string().max(500).optional(),
  }),
]);
export type CallBrowserToolResult = z.infer<typeof CallBrowserToolResultSchema>;

// ---------------------------------------------------------------------------
// Drawing a diagram (ADR 0096).
//
// He describes the diagram as data — entities and their fields, lanes and the
// messages between them — and the host renders it through the tldraw desktop
// app in a fixed design system. He never authors canvas code: the script that
// runs is the host's, and the request only fills in what the picture says. See
// `isTldrawArtifactRef` above for why the artifact this mints is attachable.
// ---------------------------------------------------------------------------

/** Why a diagram request produced nothing. Each one is sayable out loud. */
export const DiagramRefusalReasonSchema = z.enum([
  "canvas_unavailable",
  "canvas_failed",
  "diagram_too_large",
  "artifact_too_large",
]);
export type DiagramRefusalReason = z.infer<typeof DiagramRefusalReasonSchema>;

/**
 * One entity box: a name, the store it lives in, and its fields.
 *
 * `columns` is one field per line as `ROLES|field|type`, where roles are any
 * comma-separated mix of `PK`, `SK` and `FK` — the notation the design system's
 * table shape already speaks, so the request carries no rendering decisions.
 */
export const DiagramTableSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    /** Where the rows actually live: `postgres`, `memory · hot`, `ewram`, … */
    engine: z.string().trim().max(60).default(""),
    tone: z.enum(["black", "grey", "blue", "green", "yellow", "orange", "red", "violet"]).default("black"),
    columns: z.string().trim().min(1).max(4_000),
    /** Constraints or lifecycle notes; keep them out of the type cells. */
    footer: z.string().trim().max(600).default(""),
  })
  .strict();
export type DiagramTable = z.infer<typeof DiagramTableSchema>;

/** One relationship, pinned to the rows that actually hold the keys. */
export const DiagramEdgeSchema = z
  .object({
    from: z.string().trim().min(1).max(60),
    fromField: z.string().trim().min(1).max(60),
    to: z.string().trim().min(1).max(60),
    toField: z.string().trim().min(1).max(60),
    label: z.string().trim().max(80).default(""),
  })
  .strict();
export type DiagramEdge = z.infer<typeof DiagramEdgeSchema>;

export const DrawErDiagramRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().trim().max(240).default(""),
    tables: z.array(DiagramTableSchema).min(1).max(16),
    edges: z.array(DiagramEdgeSchema).max(32).default([]),
  })
  .strict();
export type DrawErDiagramRequest = z.infer<typeof DrawErDiagramRequestSchema>;

export const DrawSequenceDiagramRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().trim().min(1).max(120),
    /** One participant per line as `id|Label|sublabel`, left to right. */
    lanes: z.string().trim().min(1).max(1_200),
    /**
     * The exchange, one step per line, in the design system's mini-syntax:
     * `== phase`, `a->b: message`, `a-->b: reply`, `a->a: self call`,
     * `note over a,b: aside`. A trailing `[red]` colours one step.
     */
    steps: z.string().trim().min(1).max(8_000),
  })
  .strict();
export type DrawSequenceDiagramRequest = z.infer<typeof DrawSequenceDiagramRequestSchema>;

/**
 * Only `ok` carries a reference, so a diagram that failed to render can never
 * yield something attachable.
 */
export const DrawDiagramResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ok"),
      artifactRef: z.string().refine(isTldrawArtifactRef, "expected a tldraw artifact reference"),
      filename: z.string().min(1),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      /**
       * Which design system it came out in. Operator-chosen, like the model
       * behind a picture — reported so he can name the look, not so he can
       * pick it.
       */
      system: z.string().min(1).max(60).optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reason: DiagramRefusalReasonSchema,
      detail: z.string().max(500).optional(),
    })
    .strict(),
]);
export type DrawDiagramResult = z.infer<typeof DrawDiagramResultSchema>;

// ---------------------------------------------------------------------------
// Making a picture (ADR 0085).
//
// The provider and model come from operator config, never from the request: the
// operator picks with `/image-model`, and a turn chooses only what to draw. See
// `isGeneratedMediaRef` above for why the artifact this mints is attachable.
// ---------------------------------------------------------------------------

export const MEDIA_IMAGE_GENERATION_PATH = "/v1/media/images";

/**
 * Why a request produced nothing. Every one of these is a sentence he can say
 * out loud, which is the point: "I have no image model set up" is an answer,
 * where a 500 is something he would have to invent an explanation for.
 */
export const MediaRefusalReasonSchema = z.enum([
  "doctrine_denied",
  "no_model_configured",
  "credential_unavailable",
  "provider_unsupported",
  "provider_failed",
  "artifact_too_large",
  "media_unavailable",
]);
export type MediaRefusalReason = z.infer<typeof MediaRefusalReasonSchema>;

export const GenerateImageRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    prompt: z.string().trim().min(1).max(4_000),
    /** Provider-neutral shape hint; the provider and model come from operator config. */
    aspectRatio: z
      .string()
      .trim()
      .regex(/^\d{1,4}(?:\.\d)?:\d{1,4}(?:\.\d)?$/u)
      .optional(),
    /**
     * Edit this picture instead of drawing a new one.
     *
     * Restricted to media he already made: editing reads bytes back off disk,
     * and the one directory he can cause writes into is the only one safe to
     * read from without turning "change the sky" into an arbitrary file read.
     */
    sourceRef: z
      .string()
      .refine(isGeneratedMediaRef, "expected a generated-media artifact reference")
      .optional(),
  })
  .strict();
export type GenerateImageRequest = z.infer<typeof GenerateImageRequestSchema>;

/**
 * A refusal is a normal outcome he says out loud, not an exception: no image
 * model configured, no credential stored, doctrine denied. Only `ok` carries a
 * reference, so there is no shape in which a failed generation yields something
 * attachable.
 */
export const GenerateImageResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ok"),
      schemaVersion: z.literal(1),
      artifactRef: z.string().regex(GENERATED_MEDIA_REF_PATTERN),
      filename: z.string().min(1).max(200),
      mimeType: z.string().min(1).max(100),
      byteLength: z.number().int().positive(),
      provider: z.string().min(1).max(64),
      model: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      schemaVersion: z.literal(1),
      reason: MediaRefusalReasonSchema,
      detail: z.string().max(500).optional(),
    })
    .strict(),
]);
export type GenerateImageResult = z.infer<typeof GenerateImageResultSchema>;

// ---------------------------------------------------------------------------
// Making a video (ADR 0085).
//
// A render is a job, not a response: it takes anywhere from seconds to minutes,
// so the route waits a bounded while and then hands back the job instead of
// holding a conversation open indefinitely. Passing `requestId` resumes that
// job rather than paying to render it twice, which is why resuming is the same
// call rather than a second tool he has to know about.
// ---------------------------------------------------------------------------

export const MEDIA_VIDEO_GENERATION_PATH = "/v1/media/videos";

export const GenerateVideoRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    prompt: z.string().trim().min(1).max(4_000).optional(),
    aspectRatio: z
      .string()
      .trim()
      .regex(/^\d{1,4}(?:\.\d)?:\d{1,4}(?:\.\d)?$/u)
      .optional(),
    durationSeconds: z.number().int().min(1).max(15).optional(),
    /** Resume an in-flight render started by an earlier call. */
    requestId: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.prompt === undefined) === (request.requestId === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "a video request names either a prompt to start or a requestId to resume, not both",
      });
    }
  });
export type GenerateVideoRequest = z.infer<typeof GenerateVideoRequestSchema>;

export const GenerateVideoResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ok"),
      schemaVersion: z.literal(1),
      artifactRef: z.string().regex(GENERATED_MEDIA_REF_PATTERN),
      filename: z.string().min(1).max(200),
      mimeType: z.string().min(1).max(100),
      byteLength: z.number().int().positive(),
      provider: z.string().min(1).max(64),
      model: z.string().min(1).max(200),
    })
    .strict(),
  /** Still rendering. The same call with this `requestId` picks it up. */
  z
    .object({
      outcome: z.literal("pending"),
      schemaVersion: z.literal(1),
      requestId: z.string().min(1).max(200),
      waitedSeconds: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      schemaVersion: z.literal(1),
      reason: MediaRefusalReasonSchema,
      detail: z.string().max(500).optional(),
    })
    .strict(),
]);
export type GenerateVideoResult = z.infer<typeof GenerateVideoResultSchema>;

// ---------------------------------------------------------------------------
// Captain episodes (ADR 0054).
//
// The second memory trust class. A `MemoryFact` is a claim about the world and
// enters memory only through an approval envelope; an episode is Clankie's own
// note about his own activity, so it is written without one. Keeping them in
// separate shapes is what lets the world-fact fences stay closed while he still
// remembers having been somewhere.
// ---------------------------------------------------------------------------

/** Where an episode may resurface. There is no "public only" scope: a room he was in already knows. */
export const CaptainEpisodeVisibilitySchema = z.enum(["shareable", "operator_private"]);
export type CaptainEpisodeVisibility = z.infer<typeof CaptainEpisodeVisibilitySchema>;

export const CAPTAIN_EPISODE_SUMMARY_MAX = 512;

export const CaptainEpisodeSchema = z
  .object({
    schemaVersion: z.literal(1),
    episodeId: z.string().trim().min(1).max(256),
    /** The room it happened in, so recall can say where without holding its transcript. */
    lane: CaptainSessionLaneV2Schema,
    targetId: z.string().trim().min(1).max(512),
    summary: z.string().trim().min(1).max(CAPTAIN_EPISODE_SUMMARY_MAX),
    visibility: CaptainEpisodeVisibilitySchema,
    provenance: z
      .object({
        characterId: z.string().trim().min(1).max(512),
        sessionId: z.string().trim().min(1).max(512),
        /**
         * Structural assertions, not descriptions. An episode is Clankie
         * summarizing himself; anything asserting a fact about the world belongs
         * in `MemoryFactSchema` behind its approval gate, and raw untrusted text
         * never becomes durable memory in either shape.
         */
        selfAuthored: z.literal(true),
        rawTranscript: z.literal(false),
      })
      .strict(),
    occurredAt: z.string().datetime(),
  })
  .strict();
export type CaptainEpisode = z.infer<typeof CaptainEpisodeSchema>;

/** Owner curation may change the note or its reach, but never its room or provenance. */
export const CaptainEpisodeEditSchema = z
  .object({
    summary: z.string().trim().min(1).max(CAPTAIN_EPISODE_SUMMARY_MAX).optional(),
    visibility: CaptainEpisodeVisibilitySchema.optional(),
  })
  .strict()
  .refine((edit) => Object.keys(edit).length > 0, "an edit must change at least one field");
export type CaptainEpisodeEdit = z.infer<typeof CaptainEpisodeEditSchema>;

/** Complete owner-only browse view; ambient callers only receive bounded recall cards. */
export const OperatorMemoryCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    discordPeople: z.array(
      z
        .object({
          subject: DiscordPersonIdentitySchema,
          facts: z.array(DiscordPersonMemoryFactSchema).max(128),
        })
        .strict(),
    ),
    captainEpisodes: z.array(CaptainEpisodeSchema),
  })
  .strict();
export type OperatorMemoryCatalog = z.infer<typeof OperatorMemoryCatalogSchema>;

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
 * Why a possessor report was seeded but not spoken. Play loops report constantly;
 * answering each one is a monologue. The drop must be receipt-visible or
 * "why didn't he commentate that turn?" is unanswerable.
 */
export const DiscordVoiceNarrationSuppressReasonSchema = z.enum(["playing", "rate_limited"]);
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
 * What made him speak: someone in the room, or a possessor reporting what the
 * body just did. Both take the fast path with a zero handoff, so without this
 * the latency line cannot tell a real reply from a play narration — which is
 * exactly the ambiguity that slowed the 2026-08-02 diagnosis.
 */
export const DiscordVoiceResponseTriggerSchema = z.enum(["room", "narration"]);
export type DiscordVoiceResponseTrigger = z.infer<typeof DiscordVoiceResponseTriggerSchema>;

/** Content-free checkpoints between captured audio and a spoken response. */
export const DiscordVoiceTranscriptionOutcomeSchema = z.enum(["accepted", "empty"]);
export type DiscordVoiceTranscriptionOutcome = z.infer<typeof DiscordVoiceTranscriptionOutcomeSchema>;

export const DiscordVoiceFloorDecisionActionSchema = z.enum([
  "wake",
  "hold",
  "release",
  "volition_gate_open",
  "ignore",
]);
export type DiscordVoiceFloorDecisionAction = z.infer<typeof DiscordVoiceFloorDecisionActionSchema>;

export const DiscordVoiceFloorDecisionReasonSchema = z.enum([
  "addressed",
  "reply_policy_all",
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
  "playback",
]);
export type DiscordVoiceFailureStage = z.infer<typeof DiscordVoiceFailureStageSchema>;

/** A machine token, never a message: lowercase snake_case, bounded. */
export const DiscordVoiceFailureCodeSchema = z.string().regex(/^[a-z0-9_]{1,64}$/u);
export type DiscordVoiceFailureCode = z.infer<typeof DiscordVoiceFailureCodeSchema>;

/** The loopback possessor seam attaches and detaches locally; no room text is retained. */
export const DiscordVoicePossessorConnectionPhaseSchema = z.enum(["attached", "detached"]);
export type DiscordVoicePossessorConnectionPhase = z.infer<typeof DiscordVoicePossessorConnectionPhaseSchema>;

export const DiscordVoiceEvidenceSchema = z
  .discriminatedUnion("type", [
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
        latencyMs: DiscordVoiceDurationMsSchema,
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
        userId: DiscordVoiceGatewayIdSchema,
        /** Deliberate truncation while playing; streamed audio has no synthesizing phase to cut. */
        phase: z.literal("playing"),
      })
      .strict(),
    z
      .object({
        type: z.literal("failed"),
        ...discordVoiceChannelScope,
        stage: DiscordVoiceFailureStageSchema,
        code: DiscordVoiceFailureCodeSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("left"),
        ...discordVoiceChannelScope,
        inputTokens: DiscordVoiceCounterSchema.optional(),
        outputTokens: DiscordVoiceCounterSchema.optional(),
        spokenCount: DiscordVoiceCounterSchema.optional(),
        narrationSuppressed: DiscordVoiceCounterSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("possessor_connection"),
        phase: DiscordVoicePossessorConnectionPhaseSchema,
        attachedCount: DiscordVoiceCounterSchema,
        stayId: DiscordVoiceLocalIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("possessor_room"),
        listening: z.boolean(),
        attachedCount: DiscordVoiceCounterSchema,
        deliveredCount: DiscordVoiceCounterSchema,
        stayId: DiscordVoiceLocalIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("possessor_transcript_delivery"),
        deliveryId: DiscordVoiceLocalIdSchema,
        attachedCount: DiscordVoiceCounterSchema,
        deliveredCount: DiscordVoiceCounterSchema,
        stayId: DiscordVoiceLocalIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("possessor_narration_submission"),
        deliveryId: DiscordVoiceLocalIdSchema,
        attachedCount: DiscordVoiceCounterSchema,
        stayId: DiscordVoiceLocalIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("possessor_narration_suppressed"),
        ...discordVoiceChannelScope,
        deliveryId: DiscordVoiceLocalIdSchema,
        reason: DiscordVoiceNarrationSuppressReasonSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("possessor_refusal"),
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
