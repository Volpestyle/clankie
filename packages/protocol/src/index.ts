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
 * event (message, reasoning, tool, typed input, auth/session lifecycle, turn
 * lifecycle, redacted worker transcript) is a named bounded variant. Raw model,
 * provider, continuation, and credential payloads are impossible by schema; the
 * captain redacts to these shapes before publishing to the durable log/tail.
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
    type: z.literal("tool"),
    toolCallId: OperatorConversationEventRefSchema,
    name: z.string().trim().min(1).max(OPERATOR_CONVERSATION_CODE_MAX),
    phase: z.enum(["started", "completed", "failed"]),
    summary: z.string().max(OPERATOR_CONVERSATION_SUMMARY_MAX).optional(),
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
// envelope any authenticated boundary (control plane, VUH-864 relay) mounts and
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

export const CharacterSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  characterId: CharacterIdSchema,
  goalVersion: z.number().int().nonnegative(),
  activeWorldId: WorldIdSchema.optional(),
  activeEnvironmentSessionId: EnvironmentSessionIdSchema.optional(),
  activeMissionId: MissionIdSchema.optional(),
  goal: z
    .object({
      kind: z.string().min(1),
      summary: z.string().min(1),
    })
    .optional(),
  activeActionId: ActionIdSchema.optional(),
  sharedMemoryRefs: z.array(z.string().min(1)).default([]),
  updatedAt: z.string().datetime(),
});
export type CharacterSnapshot = z.infer<typeof CharacterSnapshotSchema>;

export const IntentCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    intentId: z.string().min(1),
    characterId: CharacterIdSchema,
    context: IntentContextSchema,
    type: z.enum(["set_goal", "steer", "pause", "resume", "stop", "disconnect"]),
    goal: z
      .object({
        kind: z.string().min(1),
        summary: z.string().min(1),
      })
      .optional(),
    createdAt: z.string().datetime(),
  })
  .superRefine((command, context) => {
    if (command.type === "set_goal" && !command.goal) {
      context.addIssue({ code: "custom", path: ["goal"], message: "set_goal requires a goal" });
    }
  });
export type IntentCommand = z.infer<typeof IntentCommandSchema>;

export const RiskSchema = z.enum(["low", "medium", "high", "critical"]);
export type Risk = z.infer<typeof RiskSchema>;

export const TaskKindSchema = z.enum([
  "context",
  "planning",
  "research",
  "design",
  "implementation",
  "debugging",
  "verification",
  "review",
  "integration",
  "deployment",
  "evaluation",
]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskRoleSchema = z.enum([
  "planner",
  "implementer",
  "verifier",
  "reviewer",
  "debugger",
  "evaluator",
]);
export type TaskRole = z.infer<typeof TaskRoleSchema>;

export const ExecutionClassSchema = z.enum([
  "eve_subagent",
  "runner_visible",
  "runner_headless",
  "human_owned",
  "automatic",
]);
export type ExecutionClass = z.infer<typeof ExecutionClassSchema>;

export const HarnessSchema = z.enum(["codex", "claude", "pi", "local", "shell", "simulated"]);
export type Harness = z.infer<typeof HarnessSchema>;

export const TaskStateSchema = z.enum([
  "draft",
  "queued",
  "leased",
  "running",
  "waiting_dependency",
  "waiting_user",
  "blocked",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const MissionStateSchema = z.enum([
  "draft",
  "awaiting_approval",
  "running",
  "blocked",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
]);
export type MissionState = z.infer<typeof MissionStateSchema>;

export const EvidenceSchema = z.object({
  kind: z.enum(["command", "test_report", "diff", "review", "screenshot", "artifact", "log"]),
  label: z.string().min(1),
  uri: z.string().min(1).optional(),
  summary: z.string().min(1),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const TaskSpecSchema = z.object({
  id: TaskIdSchema,
  title: z.string().min(1),
  objective: z.string().min(1),
  kind: TaskKindSchema,
  role: TaskRoleSchema,
  dependsOn: z.array(TaskIdSchema).default([]),
  preferredHarness: HarnessSchema.optional(),
  executionClass: ExecutionClassSchema.default("automatic"),
  risk: RiskSchema.default("low"),
  writeScope: z.array(z.string()).default([]),
  successCriteria: z.array(z.string().min(1)).min(1),
  evidenceRequirements: z.array(z.string().min(1)).min(1),
  estimatedChangedLines: z.number().int().nonnegative().optional(),
  estimatedDurationMinutes: z.number().int().positive().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  maxAttempts: z.number().int().positive().default(1),
  environmentBinding: InteractiveEnvironmentBindingSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const ActionResourceSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  repository: z.string().optional(),
  environment: z.string().optional(),
});
export type ActionResource = z.infer<typeof ActionResourceSchema>;

export const PlannedActionSchema = z.object({
  id: z.string().min(1),
  taskId: TaskIdSchema.optional(),
  action: z.string().min(1),
  resource: ActionResourceSchema,
  rationale: z.string().min(1),
});
export type PlannedAction = z.infer<typeof PlannedActionSchema>;

export const MissionPlanSchema = z
  .object({
    missionId: MissionIdSchema,
    goal: z.string().min(1),
    rationale: z.string().min(1),
    tasks: z.array(TaskSpecSchema).min(1),
    successCriteria: z.array(z.string().min(1)).min(1),
    assumptions: z.array(z.string().min(1)).default([]),
    risks: z.array(z.string().min(1)).default([]),
    humanDecisionsRequired: z.array(z.string().min(1)).default([]),
    plannedActions: z.array(PlannedActionSchema).default([]),
    environmentBindings: z.array(InteractiveEnvironmentBindingSchema).default([]),
    profileHash: z.string().min(1),
  })
  .superRefine((plan, context) => {
    const taskIds = new Set(plan.tasks.map((task) => task.id));
    const actionIds = new Set<string>();
    for (const action of plan.plannedActions) {
      if (actionIds.has(action.id)) {
        context.addIssue({
          code: "custom",
          message: `Planned action id ${action.id} is duplicated`,
          path: ["plannedActions"],
        });
      }
      actionIds.add(action.id);
      if (action.taskId && !taskIds.has(action.taskId)) {
        context.addIssue({
          code: "custom",
          message: `Planned action ${action.id} references unknown task ${action.taskId}`,
          path: ["plannedActions"],
        });
      }
    }
    for (const [taskIndex, task] of plan.tasks.entries()) {
      const binding = task.environmentBinding;
      if (!binding) continue;
      const declaredByMission = plan.environmentBindings.some(
        (missionBinding) =>
          missionBinding.environmentKind === binding.environmentKind &&
          missionBinding.characterId === binding.characterId &&
          missionBinding.worldId === binding.worldId,
      );
      if (!declaredByMission) {
        context.addIssue({
          code: "custom",
          message: `Task ${task.id} environment binding is not declared by the mission`,
          path: ["tasks", taskIndex, "environmentBinding"],
        });
      }
    }
  });
export type MissionPlan = z.infer<typeof MissionPlanSchema>;

/**
 * Runner-authored fact for a trusted verification check that failed.
 * Populated only from real check execution at the runner trust boundary —
 * never from provider prose, diagnosis text, or model-reported identities.
 * The mission-engine static failure-evidence bridge consumes this directly
 * (command + exitCode) without parsing free-form strings.
 */
export const FailedCheckSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
});
export type FailedCheck = z.infer<typeof FailedCheckSchema>;

export const WorkerResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "blocked"]),
  summary: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  outputs: z.record(z.string(), z.unknown()).default({}),
  diagnosis: z.string().optional(),
  /** Optional structured failed-check carrier (VUH-828); additive and runner-authored only. */
  failedCheck: FailedCheckSchema.optional(),
});
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export const ActionEffectSchema = z.enum(["allow", "deny", "require_approval"]);
export type ActionEffect = z.infer<typeof ActionEffectSchema>;

export const ActionRequestSchema = z.object({
  id: z.string().min(1),
  principal: z.object({
    kind: z.enum(["captain", "worker", "human", "system"]),
    id: z.string().min(1),
    role: z.string().optional(),
  }),
  action: z.string().min(1),
  resource: ActionResourceSchema,
  context: z.object({
    missionId: MissionIdSchema,
    taskId: TaskIdSchema.optional(),
    risk: RiskSchema,
    checksPassed: z.boolean().optional(),
    humanApprovals: z.number().int().nonnegative().optional(),
    changedLines: z.number().int().nonnegative().optional(),
    changedPaths: z.array(z.string()).optional(),
    costSoFarUsd: z.number().nonnegative().optional(),
    profileHash: z.string().min(1),
  }),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const ActionDecisionSchema = z.object({
  effect: ActionEffectSchema,
  reason: z.string().min(1),
  matchedPolicyIds: z.array(z.string()),
  obligations: z.array(z.string()).default([]),
});
export type ActionDecision = z.infer<typeof ActionDecisionSchema>;

export const ApprovalRequestStatusSchema = z.enum(["pending", "approved", "denied"]);
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;

export const ApprovalRequestRecordSchema = z
  .object({
    id: z.string().min(1),
    missionId: MissionIdSchema,
    taskId: TaskIdSchema.optional(),
    workerRunId: WorkerRunIdSchema.optional(),
    action: z.string().min(1),
    resource: ActionResourceSchema,
    rationale: ActionDecisionSchema,
    requestedAt: z.string().datetime(),
    status: ApprovalRequestStatusSchema,
    decidedAt: z.string().datetime().optional(),
    decidedBy: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    correlationId: z.string().min(1),
    profileHash: z.string().min(1),
  })
  .superRefine((record, context) => {
    const decisionFields = [record.decidedAt, record.decidedBy, record.reason];
    if (record.status === "pending" && decisionFields.some((field) => field !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Pending approval requests cannot contain decision fields",
        path: ["status"],
      });
    }
    if (record.status !== "pending" && decisionFields.some((field) => field === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Decided approval requests require decidedAt, decidedBy, and reason",
        path: ["status"],
      });
    }
  });
export type ApprovalRequestRecord = z.infer<typeof ApprovalRequestRecordSchema>;

export const ApprovalDecisionInputSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  reason: z.string().trim().min(1),
});
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInputSchema>;

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
  { match: "provider-readiness", exact: true, kind: "diagnostic" },
  { match: "media-readiness", exact: true, kind: "diagnostic" },
];

/** The reserved prefixes a freshly minted mission id may not start with. */
export const RESERVED_EVENT_STREAM_PREFIXES: readonly string[] = RESERVED_EVENT_STREAM_NAMESPACES.filter(
  (entry) => !entry.exact,
).map((entry) => entry.match);

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

/**
 * What kind of stream an event belongs to. The stamped `streamKind` is
 * authoritative; namespace inference is the compatibility path for events
 * appended before the field existed, and for the handful of foreign writers
 * (worker adapters, runner diagnostics) that copy a stream id verbatim.
 */
export function classifyEventStream(event: {
  readonly missionId: string;
  readonly streamKind?: EventStreamKind | undefined;
}): EventStreamKind {
  return event.streamKind ?? eventStreamKindForId(event.missionId);
}

/** True when the event belongs to a real mission rather than a reserved stream. */
export function isMissionEventStream(event: {
  readonly missionId: string;
  readonly streamKind?: EventStreamKind | undefined;
}): boolean {
  return classifyEventStream(event) === "mission";
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

// ---------------------------------------------------------------------------
// Authenticated mission-event feed (VUH-909).
//
// DomainEvent is the internal append-only authority and intentionally supports
// additive event data. It is not safe as an app wire contract. The schemas
// below are a closed, bounded read projection that preserves canonical event
// identity and event-store sequence metadata while making raw/provider/private
// payload fields unrepresentable.
// ---------------------------------------------------------------------------

export const MISSION_EVENT_FEED_SCHEMA_VERSION = 1 as const;
export const MISSION_EVENT_FEED_RETENTION_MAX = 1_024;
export const MISSION_EVENT_FEED_SNAPSHOT_MAX = 512;
export const MISSION_EVENT_FEED_CURSOR_MAX = 2_048;
export const MISSION_EVENT_FEED_ID_MAX = 512;

const MissionEventFeedIdSchema = z.string().trim().min(1).max(MISSION_EVENT_FEED_ID_MAX);
export const MissionEventFeedCursorSchema = z.string().trim().min(1).max(MISSION_EVENT_FEED_CURSOR_MAX);
export type MissionEventFeedCursor = z.infer<typeof MissionEventFeedCursorSchema>;

const MissionFeedEventEnvelope = {
  schemaVersion: z.literal(MISSION_EVENT_FEED_SCHEMA_VERSION),
  eventId: MissionEventFeedIdSchema,
  sourceSequence: z.number().int().positive(),
  previousSourceSequence: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
  missionId: MissionEventFeedIdSchema,
  taskId: MissionEventFeedIdSchema.optional(),
  workerRunId: MissionEventFeedIdSchema.optional(),
  correlationId: MissionEventFeedIdSchema,
  causationId: MissionEventFeedIdSchema.optional(),
  profileHash: MissionEventFeedIdSchema,
};

const MissionFeedWorkerIdentityDataSchema = z
  .object({
    workerId: MissionEventFeedIdSchema,
    harness: HarnessSchema,
    taskKind: TaskKindSchema,
    attempt: z.number().int().positive(),
  })
  .strict();

const MissionFeedSummaryDataSchema = z
  .object({ summary: z.enum(["Working", "Waiting for a dependency", "User input required"]) })
  .strict();

const MissionFeedArtifactIdSchema = z.string().regex(/^artifact:\/\/[A-Za-z0-9._~:/-]{1,1000}$/u);

/** Closed canonical event variants consumed by the Garden mission projection. */
export const MissionFeedEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("mission.execution.started"),
      data: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("worker.started"),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: MissionFeedWorkerIdentityDataSchema,
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("worker.leased"),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: MissionFeedWorkerIdentityDataSchema,
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("worker.turn.started"),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: z.object({ state: z.literal("working") }).strict(),
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("worker.turn.settled"),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: z.object({ state: z.literal("idle") }).strict(),
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("worker.waiting_user"),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: MissionFeedSummaryDataSchema,
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.enum(["worker.waiting_dependency", "task.waiting_dependency"]),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: MissionFeedSummaryDataSchema,
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("worker.progress"),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: z.object({ summary: z.literal("Working") }).strict(),
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("worker.status.resolved"),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: z
        .object({
          state: z.enum([
            "unknown",
            "working",
            "idle",
            "waiting_dependency",
            "waiting_user",
            "blocked",
            "failed",
            "completed",
            "offline",
          ]),
          tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
          confidence: z.number().min(0).max(1),
          observedAt: z.string().datetime(),
          attentionRaised: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.enum(["task.failed", "worker.crashed"]),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: z.object({ summary: z.literal("Task failed") }).strict(),
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("task.blocked"),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: z.object({ summary: z.literal("Task blocked") }).strict(),
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("task.succeeded"),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: z.object({ summary: z.literal("Task completed") }).strict(),
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("worker.settled"),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: z
        .object({
          result: z.enum(["succeeded", "failed", "blocked"]),
          artifactIds: z.array(MissionFeedArtifactIdSchema).max(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("worker.completed"),
      taskId: MissionEventFeedIdSchema,
      workerRunId: MissionEventFeedIdSchema,
      data: z.object({ result: z.enum(["succeeded", "failed", "blocked"]) }).strict(),
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("mission.succeeded"),
      data: z.object({ summary: z.literal("Mission completed") }).strict(),
    })
    .strict(),
  z
    .object({
      ...MissionFeedEventEnvelope,
      type: z.literal("mission.failed"),
      data: z.object({ summary: z.literal("Mission failed") }).strict(),
    })
    .strict(),
]);
export type MissionFeedEvent = z.infer<typeof MissionFeedEventSchema>;

export const ActiveMissionDescriptorSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVENT_FEED_SCHEMA_VERSION),
    missionId: MissionEventFeedIdSchema,
    generation: MissionEventFeedIdSchema,
    startedAt: z.string().datetime(),
    profileHash: MissionEventFeedIdSchema,
  })
  .strict();
export type ActiveMissionDescriptor = z.infer<typeof ActiveMissionDescriptorSchema>;

export const ActiveMissionSelectionSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVENT_FEED_SCHEMA_VERSION),
    activeMission: ActiveMissionDescriptorSchema.nullable(),
  })
  .strict();
export type ActiveMissionSelection = z.infer<typeof ActiveMissionSelectionSchema>;

export const MissionEventSnapshotSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVENT_FEED_SCHEMA_VERSION),
    outcome: z.literal("snapshot"),
    mission: ActiveMissionDescriptorSchema,
    replayAfterSourceSequenceFloor: z.number().int().nonnegative(),
    resumeAfterSourceSequence: z.number().int().nonnegative(),
    nextCursor: MissionEventFeedCursorSchema,
    compacted: z.boolean(),
    omittedEventCount: z.number().int().nonnegative(),
    events: z.array(MissionFeedEventSchema).max(MISSION_EVENT_FEED_SNAPSHOT_MAX),
  })
  .strict();
export type MissionEventSnapshot = z.infer<typeof MissionEventSnapshotSchema>;

export const MissionEventCursorExpiredSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVENT_FEED_SCHEMA_VERSION),
    outcome: z.literal("cursor_expired"),
    mission: ActiveMissionDescriptorSchema,
    replayAfterSourceSequenceFloor: z.number().int().nonnegative(),
    snapshotCursor: MissionEventFeedCursorSchema,
  })
  .strict();
export type MissionEventCursorExpired = z.infer<typeof MissionEventCursorExpiredSchema>;

export const MissionEventCursorInvalidSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVENT_FEED_SCHEMA_VERSION),
    outcome: z.literal("cursor_invalid"),
    missionId: MissionEventFeedIdSchema,
  })
  .strict();
export type MissionEventCursorInvalid = z.infer<typeof MissionEventCursorInvalidSchema>;

export const MissionEventMissionReplacedSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVENT_FEED_SCHEMA_VERSION),
    outcome: z.literal("mission_replaced"),
    requestedMissionId: MissionEventFeedIdSchema,
    replacementMission: ActiveMissionDescriptorSchema.nullable(),
  })
  .strict();
export type MissionEventMissionReplaced = z.infer<typeof MissionEventMissionReplacedSchema>;

export const MissionEventRecoverySchema = z.discriminatedUnion("outcome", [
  MissionEventCursorExpiredSchema,
  MissionEventCursorInvalidSchema,
  MissionEventMissionReplacedSchema,
]);
export type MissionEventRecovery = z.infer<typeof MissionEventRecoverySchema>;

export const MissionEventAuthFailureSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVENT_FEED_SCHEMA_VERSION),
    outcome: z.literal("auth_failed"),
    reason: z.enum(["authentication_required", "session_expired", "device_revoked", "permission_denied"]),
  })
  .strict();
export type MissionEventAuthFailure = z.infer<typeof MissionEventAuthFailureSchema>;

export const MissionEventTailEventLineSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVENT_FEED_SCHEMA_VERSION),
    type: z.literal("mission_event.event"),
    event: MissionFeedEventSchema,
    cursor: MissionEventFeedCursorSchema,
  })
  .strict();
export type MissionEventTailEventLine = z.infer<typeof MissionEventTailEventLineSchema>;

export const MissionEventTailRecoveryLineSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVENT_FEED_SCHEMA_VERSION),
    type: z.literal("mission_event.recovery"),
    recovery: MissionEventRecoverySchema,
  })
  .strict();
export type MissionEventTailRecoveryLine = z.infer<typeof MissionEventTailRecoveryLineSchema>;

export const MissionEventTailAuthLineSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVENT_FEED_SCHEMA_VERSION),
    type: z.literal("mission_event.auth_failed"),
    failure: MissionEventAuthFailureSchema,
  })
  .strict();
export type MissionEventTailAuthLine = z.infer<typeof MissionEventTailAuthLineSchema>;

export const MissionEventTailLineSchema = z.discriminatedUnion("type", [
  MissionEventTailEventLineSchema,
  MissionEventTailRecoveryLineSchema,
  MissionEventTailAuthLineSchema,
]);
export type MissionEventTailLine = z.infer<typeof MissionEventTailLineSchema>;

export const MissionTriggerScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expression: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("once"), at: z.string().datetime() }).strict(),
]);
export type MissionTriggerSchedule = z.infer<typeof MissionTriggerScheduleSchema>;

export const MissionTriggerSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    goal: z.string().min(1),
    context: z.record(z.string(), z.unknown()).default({}),
    schedule: MissionTriggerScheduleSchema,
    misfirePolicy: z.enum(["skip", "run_once_late"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastEvaluatedAt: z.string().datetime().optional(),
  })
  .strict();
export type MissionTrigger = z.infer<typeof MissionTriggerSchema>;

export const MissionTriggerEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("mission.trigger.created"),
    data: z.object({ trigger: MissionTriggerSchema }),
  }),
  EventBaseSchema.extend({
    type: z.literal("mission.trigger.updated"),
    data: z.object({ trigger: MissionTriggerSchema }),
  }),
  EventBaseSchema.extend({
    type: z.literal("mission.trigger.fired"),
    data: z.object({
      trigger: MissionTriggerSchema,
      scheduledAt: z.string().datetime(),
      missionId: MissionIdSchema,
    }),
  }),
  EventBaseSchema.extend({
    type: z.literal("mission.trigger.skipped"),
    data: z.object({ trigger: MissionTriggerSchema, scheduledAt: z.string().datetime() }),
  }),
  EventBaseSchema.extend({
    type: z.literal("mission.trigger.deleted"),
    data: z.object({ triggerId: z.string().min(1) }),
  }),
]);
export type MissionTriggerEvent = z.infer<typeof MissionTriggerEventSchema>;

export const ApprovalEventSchema = z
  .discriminatedUnion("type", [
    EventBaseSchema.extend({
      type: z.literal("approval.requested"),
      data: z.object({ approval: ApprovalRequestRecordSchema }),
    }),
    EventBaseSchema.extend({
      type: z.literal("approval.decided"),
      data: z.object({
        approval: ApprovalRequestRecordSchema,
        consumedAt: z.string().datetime().optional(),
        consumedBy: z.string().min(1).optional(),
      }),
    }),
  ])
  .superRefine((event, context) => {
    if (event.type === "approval.requested" && event.data.approval.status !== "pending") {
      context.addIssue({ code: "custom", message: "approval.requested must be pending" });
    }
    if (event.type === "approval.decided" && event.data.approval.status === "pending") {
      context.addIssue({ code: "custom", message: "approval.decided must be terminal" });
    }
    if (
      event.type === "approval.decided" &&
      (event.data.consumedAt === undefined) !== (event.data.consumedBy === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Approval consumption requires consumedAt and consumedBy together",
      });
    }
  });
export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;

export const WorkerStatusStateSchema = z.enum([
  "unknown",
  "working",
  "idle",
  "waiting_dependency",
  "waiting_user",
  "blocked",
  "failed",
  "completed",
  "offline",
]);
export type WorkerStatusState = z.infer<typeof WorkerStatusStateSchema>;

export const WorkerStatusProvenanceSchema = z.object({
  source: z.string().min(1),
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  confidence: z.number().min(0).max(1),
  observedAt: z.string().datetime(),
});
export type WorkerStatusProvenance = z.infer<typeof WorkerStatusProvenanceSchema>;

// --- Runner-owned worker transcript projection (VUH-865) ---

export const WORKER_TRANSCRIPT_SCHEMA_VERSION = 1 as const;

export const WorkerTranscriptKeySchema = z
  .object({
    missionId: MissionIdSchema,
    taskId: TaskIdSchema,
    workerRunId: WorkerRunIdSchema,
  })
  .strict();
export type WorkerTranscriptKey = z.infer<typeof WorkerTranscriptKeySchema>;

export const WorkerTranscriptVisibilitySchema = z.enum(["garden", "operator"]);
export type WorkerTranscriptVisibility = z.infer<typeof WorkerTranscriptVisibilitySchema>;

export const WorkerTranscriptRedactionClassSchema = z.enum([
  "authorization",
  "token",
  "credential",
  "private_prompt",
  "chain_of_thought",
  "raw_audio",
  "unbounded_output",
]);
export type WorkerTranscriptRedactionClass = z.infer<typeof WorkerTranscriptRedactionClassSchema>;

export const WorkerTranscriptRedactionSchema = z
  .object({
    classification: z.enum(["none", "secrets_removed", "private_content_removed", "metadata_only"]),
    classes: z.array(WorkerTranscriptRedactionClassSchema),
  })
  .strict();
export type WorkerTranscriptRedaction = z.infer<typeof WorkerTranscriptRedactionSchema>;

export const WorkerTranscriptProvenanceSchema = z
  .object({
    source: z.enum(["runner_event", "runner_settlement", "worker_summary"]),
    sourceEventId: z.string().min(1).max(256),
    trust: z.enum(["runner_observed", "worker_authored"]),
  })
  .strict();
export type WorkerTranscriptProvenance = z.infer<typeof WorkerTranscriptProvenanceSchema>;

const WorkerTranscriptEntryBase = {
  schemaVersion: z.literal(WORKER_TRANSCRIPT_SCHEMA_VERSION),
  entryId: z.string().min(1).max(512),
  missionId: MissionIdSchema,
  taskId: TaskIdSchema,
  workerRunId: WorkerRunIdSchema,
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  correlationId: z.string().min(1),
  profileHash: z.string().min(1),
  visibility: WorkerTranscriptVisibilitySchema,
  redaction: WorkerTranscriptRedactionSchema,
  provenance: WorkerTranscriptProvenanceSchema,
};

export const WorkerTranscriptEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...WorkerTranscriptEntryBase,
      kind: z.literal("status"),
      data: z
        .object({
          state: z.enum([
            "unknown",
            "working",
            "idle",
            "waiting_dependency",
            "waiting_user",
            "blocked",
            "failed",
            "completed",
            "offline",
          ]),
          summary: z.string().trim().min(1).max(512),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...WorkerTranscriptEntryBase,
      kind: z.literal("narrative"),
      data: z.object({ summary: z.string().trim().min(1).max(512) }).strict(),
    })
    .strict(),
  z
    .object({
      ...WorkerTranscriptEntryBase,
      kind: z.literal("action"),
      data: z
        .object({
          action: z.string().trim().min(1).max(200),
          result: z.enum(["started", "succeeded", "failed"]),
          fingerprint: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...WorkerTranscriptEntryBase,
      kind: z.literal("artifact"),
      data: z
        .object({
          label: z.string().trim().min(1).max(200),
          ref: z.string().trim().min(1).max(1_024),
          summary: z.string().trim().min(1).max(512),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...WorkerTranscriptEntryBase,
      kind: z.literal("blocker"),
      data: z.object({ summary: z.string().trim().min(1).max(512) }).strict(),
    })
    .strict(),
  z
    .object({
      ...WorkerTranscriptEntryBase,
      kind: z.literal("completion"),
      data: z
        .object({
          status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
          summary: z.string().trim().min(1).max(512),
          evidenceRefs: z.array(z.string().trim().min(1).max(1_024)).max(100),
        })
        .strict(),
    })
    .strict(),
]);
export type WorkerTranscriptEntry = z.infer<typeof WorkerTranscriptEntrySchema>;

export const WorkerTranscriptSnapshotSchema = z
  .object({
    schemaVersion: z.literal(WORKER_TRANSCRIPT_SCHEMA_VERSION),
    outcome: z.literal("snapshot"),
    key: WorkerTranscriptKeySchema,
    generation: z.string().min(1).max(256),
    retainedFromSequence: z.number().int().positive(),
    nextCursor: z.string().min(1).max(2_048),
    entries: z.array(WorkerTranscriptEntrySchema),
  })
  .strict();
export type WorkerTranscriptSnapshot = z.infer<typeof WorkerTranscriptSnapshotSchema>;

export const WorkerTranscriptCursorExpiredSchema = z
  .object({
    schemaVersion: z.literal(WORKER_TRANSCRIPT_SCHEMA_VERSION),
    outcome: z.literal("cursor_expired"),
    retainedFromSequence: z.number().int().positive(),
    snapshotCursor: z.string().min(1).max(2_048),
  })
  .strict();
export type WorkerTranscriptCursorExpired = z.infer<typeof WorkerTranscriptCursorExpiredSchema>;

export const WorkerTranscriptRunReplacedSchema = z
  .object({
    schemaVersion: z.literal(WORKER_TRANSCRIPT_SCHEMA_VERSION),
    outcome: z.literal("run_replaced"),
    replacementKey: WorkerTranscriptKeySchema,
    snapshotCursor: z.string().min(1).max(2_048),
  })
  .strict();
export type WorkerTranscriptRunReplaced = z.infer<typeof WorkerTranscriptRunReplacedSchema>;

export const WorkerTranscriptNotFoundSchema = z
  .object({
    schemaVersion: z.literal(WORKER_TRANSCRIPT_SCHEMA_VERSION),
    outcome: z.literal("not_found"),
  })
  .strict();
export type WorkerTranscriptNotFound = z.infer<typeof WorkerTranscriptNotFoundSchema>;

export const WorkerTranscriptReadOutcomeSchema = z.discriminatedUnion("outcome", [
  WorkerTranscriptSnapshotSchema,
  WorkerTranscriptRunReplacedSchema,
  WorkerTranscriptNotFoundSchema,
]);
export type WorkerTranscriptReadOutcome = z.infer<typeof WorkerTranscriptReadOutcomeSchema>;

export const WorkerTranscriptTailLineSchema = z
  .object({
    schemaVersion: z.literal(WORKER_TRANSCRIPT_SCHEMA_VERSION),
    type: z.literal("worker_transcript.entry"),
    entry: WorkerTranscriptEntrySchema,
    cursor: z.string().min(1).max(2_048),
  })
  .strict();
export type WorkerTranscriptTailLine = z.infer<typeof WorkerTranscriptTailLineSchema>;

export const WorkerTranscriptAuthFailureSchema = z
  .object({
    schemaVersion: z.literal(WORKER_TRANSCRIPT_SCHEMA_VERSION),
    outcome: z.literal("auth_failed"),
    reason: z.enum(["authentication_required", "session_expired", "device_revoked", "permission_denied"]),
  })
  .strict();
export type WorkerTranscriptAuthFailure = z.infer<typeof WorkerTranscriptAuthFailureSchema>;

export const WorkerTurnStartedDataSchema = WorkerStatusProvenanceSchema.extend({
  state: z.literal("working"),
});
export type WorkerTurnStartedData = z.infer<typeof WorkerTurnStartedDataSchema>;

export const WorkerTurnSettledDataSchema = WorkerStatusProvenanceSchema.extend({
  state: z.literal("idle"),
});
export type WorkerTurnSettledData = z.infer<typeof WorkerTurnSettledDataSchema>;

export const WorkerWaitingUserDataSchema = WorkerStatusProvenanceSchema.extend({
  state: z.literal("waiting_user"),
  questionSummary: z.string().trim().min(1),
});
export type WorkerWaitingUserData = z.infer<typeof WorkerWaitingUserDataSchema>;

export const WorkerStatusEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("worker.turn.started"),
    taskId: TaskIdSchema,
    workerRunId: WorkerRunIdSchema,
    data: WorkerTurnStartedDataSchema,
  }),
  EventBaseSchema.extend({
    type: z.literal("worker.turn.settled"),
    taskId: TaskIdSchema,
    workerRunId: WorkerRunIdSchema,
    data: WorkerTurnSettledDataSchema,
  }),
  EventBaseSchema.extend({
    type: z.literal("worker.waiting_user"),
    taskId: TaskIdSchema,
    workerRunId: WorkerRunIdSchema,
    data: WorkerWaitingUserDataSchema,
  }),
]);
export type WorkerStatusEvent = z.infer<typeof WorkerStatusEventSchema>;

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

export const ApprovalRecordSchema = z.object({
  actionRequestId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  decidedBy: z.string().min(1),
  reason: z.string().min(1),
  decidedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export function assertValidDag(tasks: TaskSpec[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) {
    throw new Error("Task ids must be unique");
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Task dependency cycle detected at ${id}`);
    visiting.add(id);
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown task ${id}`);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of tasks) visit(task.id);
}

export const LinearChannelIdentitySchema = z
  .object({
    missionId: MissionIdSchema,
    taskId: TaskIdSchema,
    workerRunId: WorkerRunIdSchema,
    correlationId: z.string().min(1),
    profileHash: z.string().min(1),
    workspaceId: z.string().min(1),
    appUserId: z.string().min(1),
  })
  .strict();
export type LinearChannelIdentity = z.infer<typeof LinearChannelIdentitySchema>;

export const LinearChannelTurnRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    deliveryId: z.string().uuid(),
    action: z.enum(["created", "prompted"]),
    identity: LinearChannelIdentitySchema,
    issue: z
      .object({
        id: z.string().min(1),
        identifier: z.string().min(1),
        url: z.string().url(),
      })
      .strict(),
    session: z
      .object({
        id: z.string().min(1),
        appUserId: z.string().min(1),
      })
      .strict(),
    trigger: z
      .object({
        kind: z.enum(["comment", "activity"]),
        id: z.string().min(1),
        rootCommentId: z.string().min(1).nullable(),
        actorId: z.string().min(1),
        body: z.string().min(1).max(16_384),
      })
      .strict(),
  })
  .strict();
export type LinearChannelTurnRequest = z.infer<typeof LinearChannelTurnRequestSchema>;

export const LINEAR_AGENT_THREAD_MAX_ACTIVITIES = 500;

export const LinearAgentThreadContextSchema = z
  .object({
    workspaceId: z.string().min(1),
    appUserId: z.string().min(1),
    sessionId: z.string().min(1),
    issue: z
      .object({
        id: z.string().min(1),
        identifier: z.string().min(1),
        title: z.string().min(1),
        url: z.string().url(),
      })
      .strict(),
    rootComment: z
      .object({
        id: z.string().min(1),
        body: z.string().max(65_536),
        issueId: z.string().min(1),
      })
      .strict()
      .nullable(),
    activities: z
      .array(
        z
          .object({
            id: z.string().min(1),
            userId: z.string().min(1),
            type: z.string().min(1),
            body: z.string().max(65_536),
            createdAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(LINEAR_AGENT_THREAD_MAX_ACTIVITIES),
  })
  .strict();
export type LinearAgentThreadContext = z.infer<typeof LinearAgentThreadContextSchema>;

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

export const CaptainChannelTurnResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("settled"),
      captainSessionId: z.string().min(1),
      turnId: z.string().min(1),
      response: z.string().trim().min(1).max(16_384),
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

export const TrackerNarrativeActionSchema = z.enum([
  "tracker.comment.create",
  "tracker.agent-activity.thought.create",
  "tracker.agent-activity.response.create",
  "tracker.agent-activity.elicitation.create",
  "tracker.reaction.create",
]);
export type TrackerNarrativeAction = z.infer<typeof TrackerNarrativeActionSchema>;

export const TrackerNarrativeWriteSchema = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: z.string().min(1),
    action: TrackerNarrativeActionSchema,
    identity: LinearChannelIdentitySchema,
    issueId: z.string().min(1),
    agentSessionId: z.string().min(1),
    commentId: z.string().min(1).optional(),
    content: z.string().min(1).max(16_384),
    ephemeral: z.boolean().optional(),
  })
  .strict()
  .superRefine((write, context) => {
    if (write.action === "tracker.reaction.create" && write.commentId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Reaction narratives require a comment target",
        path: ["commentId"],
      });
    }
    if (write.action !== "tracker.agent-activity.thought.create" && write.ephemeral === true) {
      context.addIssue({
        code: "custom",
        message: "Only thought narratives can be ephemeral",
        path: ["ephemeral"],
      });
    }
  });
export type TrackerNarrativeWrite = z.infer<typeof TrackerNarrativeWriteSchema>;

export const TrackerNarrativeWriteResultSchema = z
  .object({
    id: z.string().min(1),
    action: TrackerNarrativeActionSchema,
    appUserId: z.string().min(1),
  })
  .strict();
export type TrackerNarrativeWriteResult = z.infer<typeof TrackerNarrativeWriteResultSchema>;

/**
 * Which Discord connection carries an action (ADR 0024, ADR 0048).
 *
 * This is the *only* place bot-versus-user is named. Action schemas stay
 * transport-agnostic so one catalog, one character, and one memory projection
 * serve both planes; the runtime binding plus doctrine decide availability.
 */
export const DiscordTransportKindSchema = z.enum(["bot", "user_session"]);
export type DiscordTransportKind = z.infer<typeof DiscordTransportKindSchema>;

/**
 * Transport lifecycle actions, kept out of the presence write catalog because
 * they change *which body Clankie is wearing* rather than writing anything to a
 * channel. Doctrine gates the user-session connect exactly (ADR 0048).
 */
export const DiscordTransportActionSchema = z.enum(["discord.transport.user_session_connect"]);
export type DiscordTransportAction = z.infer<typeof DiscordTransportActionSchema>;

export const DISCORD_TRANSPORT_ACTION_RISK_CLASS: Readonly<
  Record<DiscordTransportAction, "publish-external">
> = {
  "discord.transport.user_session_connect": "publish-external",
};

/** Transport-agnostic Discord presence action names (ADR 0024). No bot/user token fields. */
export const DiscordPresenceActionSchema = z.enum([
  "discord.presence.reply",
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

export const DiscordVoicePresenceNoteReasonSchema = z.enum([
  "authority",
  "allowlist",
  "not_in_voice",
  "voice_disabled",
  "other_guild",
  "failed",
]);
export type DiscordVoicePresenceNoteReason = z.infer<typeof DiscordVoicePresenceNoteReasonSchema>;

/**
 * What the bridge just did about voice presence for this message: a member
 * asked him into or out of voice in text chat, and the bridge decided and
 * executed at its ingress boundary before the captain turn (ADR 0062). Enums
 * and ids only, never free text, so a prompt-injected body can never author
 * what he is told happened.
 */
export const DiscordVoicePresenceNoteSchema = z
  .object({
    action: z.enum(["joined", "join_refused", "left", "leave_refused"]),
    channelId: z.string().min(1).optional(),
    reason: DiscordVoicePresenceNoteReasonSchema.optional(),
  })
  .strict();
export type DiscordVoicePresenceNote = z.infer<typeof DiscordVoicePresenceNoteSchema>;

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
         * Nobody addressed him: this reached him because he had been talking to
         * this person, not because they used his name. Framing only — he may
         * stay silent on any turn — but he should know whether he was asked.
         */
        unprompted: z.boolean().optional(),
        /**
         * Set by the bridge when this message asked him into or out of voice
         * and the bridge already executed the decision (ADR 0062). His reply
         * must reflect what actually happened: he is the voice, the bridge is
         * the actor.
         */
        voicePresenceNote: DiscordVoicePresenceNoteSchema.optional(),
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
    .object({ kind: z.literal("go_live_start"), guildId: z.string().min(1), channelId: z.string().min(1) })
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
      // The activity surface also serves the ambient embodiment plane (ADR
      // 0063): an asked play session has no mission, so its launch and stop
      // writes may attribute to the presence session they serve instead. The
      // publish-external approval gate is unchanged — this widens attribution,
      // never authority.
      !(
        (write.action === "discord.presence.activity_start" ||
          write.action === "discord.presence.activity_stop") &&
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
// Asked embodiment (ADR 0063): the captain asks for play, the control plane
// holds the intent, the runner owns the session.
//
// Every schema is a STRICT, content-free wire boundary: ids, enums, counters,
// and timestamps only. No field may carry free text, model output, frame
// bytes, or anything a message body could smuggle through.
// ---------------------------------------------------------------------------

/** Environments the play seam serves; Minecraft joins when its host lands. */
export const EmbodimentEnvironmentIdSchema = z.enum(["pokemon-firered"]);
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
 * `body_held` is one reason on purpose (ADR 0063): whether the control plane
 * saw a live asked session or the runner's body lock saw an external
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

/** Durable control-plane record of one asked session, replayed from events. */
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
 * The control plane's answer to a submitted intent. A refused start still
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

/** One runner→control-plane lifecycle transition for a claimed session. */
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
 * The captain tool's typed outcome, mirroring DiscordVoicePresenceNote: the
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

// Connector-neutral tracker ceremony (VUH-845)
// Semantic roles and notification surfaces only — no provider, principal
// identity, or tracker-vendor nouns.
// ---------------------------------------------------------------------------

/** Semantic role that may receive human-attention or product-impact asks. */
export const CeremonyTargetRoleSchema = z.enum([
  "operator",
  "captain",
  "product_steward",
  "reviewer",
  "verifier",
]);
export type CeremonyTargetRole = z.infer<typeof CeremonyTargetRoleSchema>;

/** Kind of human-attention request (what the captain needs, not how it is delivered). */
export const HumanAttentionRequestKindSchema = z.enum([
  "approval_needed",
  "decision_needed",
  "clarification_needed",
  "review_needed",
  "blocker_resolution",
]);
export type HumanAttentionRequestKind = z.infer<typeof HumanAttentionRequestKindSchema>;

/** Surfaces that may carry a notification requirement (connector-neutral). */
export const CeremonyNotificationSurfaceSchema = z.enum([
  "captain_lane",
  "operator_inbox",
  "workspace_surface",
]);
export type CeremonyNotificationSurface = z.infer<typeof CeremonyNotificationSurfaceSchema>;

export const CeremonyAuthorityImpactSchema = z.enum(["none", "narrow", "broad", "doctrine"]);
export type CeremonyAuthorityImpact = z.infer<typeof CeremonyAuthorityImpactSchema>;

export const CeremonyUrgencySchema = z.enum(["routine", "elevated", "blocking"]);
export type CeremonyUrgency = z.infer<typeof CeremonyUrgencySchema>;

/** Where the product-impact section sits in a drafted issue body. */
export const CeremonySectionPlacementSchema = z.enum(["first", "after_summary", "last"]);
export type CeremonySectionPlacement = z.infer<typeof CeremonySectionPlacementSchema>;

/**
 * Semantic direct-notification mode for human attention (not a provider operation).
 * Connectors map this to delivery policy in VUH-846+.
 */
export const CeremonyDirectNotificationModeSchema = z.enum(["required", "best_effort", "disabled"]);
export type CeremonyDirectNotificationMode = z.infer<typeof CeremonyDirectNotificationModeSchema>;

/** Authored text that must be non-empty after trim (asks, rationales, impact summary). */
export const CeremonyAuthoredTextSchema = z.string().trim().min(1);
export type CeremonyAuthoredText = z.infer<typeof CeremonyAuthoredTextSchema>;

/**
 * Opaque tracker correlation. Connectors bind `externalRef`; protocol never
 * names a tracker vendor or principal.
 */
export const TrackerCorrelationRefSchema = z
  .object({
    correlationId: z.string().min(1),
    externalRef: z.string().min(1).optional(),
  })
  .strict();
export type TrackerCorrelationRef = z.infer<typeof TrackerCorrelationRefSchema>;

function refineCorrelationConflict(
  topLevel: string,
  trackerRef: { correlationId: string } | undefined,
  context: z.RefinementCtx,
): void {
  if (trackerRef !== undefined && trackerRef.correlationId !== topLevel) {
    context.addIssue({
      code: "custom",
      path: ["trackerRef", "correlationId"],
      message: "trackerRef.correlationId must match the top-level correlationId when both are present",
    });
  }
}

function refineExpiresAfterCreated(
  createdAt: string,
  expiresAt: string | undefined,
  context: z.RefinementCtx,
): void {
  if (expiresAt === undefined) return;
  // Compare parsed instants numerically — lexical RFC3339 string order rejects
  // valid fractional-second and equivalent-offset pairs (e.g. Z vs .001Z).
  const createdMs = Date.parse(createdAt);
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(createdMs) || !Number.isFinite(expiresMs) || expiresMs <= createdMs) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiresAt must be strictly after createdAt",
    });
  }
}

/** Product-impact facts required on impact-led issue drafts. */
export const ProductImpactSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: CeremonyAuthoredTextSchema,
    userVisibleChange: z.boolean(),
    risk: RiskSchema,
    authorityImpact: CeremonyAuthorityImpactSchema,
  })
  .strict();
export type ProductImpact = z.infer<typeof ProductImpactSchema>;

/**
 * Connector-neutral draft for a tracker issue. Captains and runtimes validate
 * this shape before any connector delivery (VUH-846+).
 */
export const TrackerIssueDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    draftId: z.string().min(1),
    missionId: MissionIdSchema,
    taskId: TaskIdSchema.optional(),
    correlationId: z.string().min(1),
    title: CeremonyAuthoredTextSchema,
    objective: CeremonyAuthoredTextSchema,
    productImpact: ProductImpactSchema,
    acceptanceCriteria: z.array(CeremonyAuthoredTextSchema).min(1),
    writeScope: z.array(z.string().min(1)).default([]),
    trackerRef: TrackerCorrelationRefSchema.optional(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((draft, context) => {
    refineCorrelationConflict(draft.correlationId, draft.trackerRef, context);
  });
export type TrackerIssueDraft = z.infer<typeof TrackerIssueDraftSchema>;

/** Request that a human (by semantic role) attend to a mission decision. */
export const HumanAttentionRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().min(1),
    missionId: MissionIdSchema,
    taskId: TaskIdSchema.optional(),
    workerRunId: WorkerRunIdSchema.optional(),
    correlationId: z.string().min(1),
    targetRole: CeremonyTargetRoleSchema,
    requestKind: HumanAttentionRequestKindSchema,
    actionableAsk: CeremonyAuthoredTextSchema,
    blocking: z.boolean(),
    authorityImpact: CeremonyAuthorityImpactSchema,
    urgency: CeremonyUrgencySchema.default("elevated"),
    notificationSurfaces: z.array(CeremonyNotificationSurfaceSchema).min(1),
    /** Semantic direct-notification mode for this request (ceremony default may supply). */
    directNotification: CeremonyDirectNotificationModeSchema.optional(),
    /**
     * When true, the mission must wait for an authoritative HumanAttentionResponse
     * before proceeding past this attention gate.
     */
    waitForAuthoritativeResponse: z.boolean().optional(),
    trackerRef: TrackerCorrelationRefSchema.optional(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    refineExpiresAfterCreated(request.createdAt, request.expiresAt, context);
    refineCorrelationConflict(request.correlationId, request.trackerRef, context);
  });
export type HumanAttentionRequest = z.infer<typeof HumanAttentionRequestSchema>;

/** Response from the role that attended the request. */
export const HumanAttentionResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    responseId: z.string().min(1),
    requestId: z.string().min(1),
    correlationId: z.string().min(1),
    actorRole: CeremonyTargetRoleSchema,
    decision: z.enum(["approve", "deny", "defer", "clarify", "redirect"]),
    rationale: CeremonyAuthoredTextSchema,
    trackerRef: TrackerCorrelationRefSchema.optional(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((response, context) => {
    refineCorrelationConflict(response.correlationId, response.trackerRef, context);
  });
export type HumanAttentionResponse = z.infer<typeof HumanAttentionResponseSchema>;

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

export const ApprovedDiscordPersonMemoryProposalSchema = DiscordPersonMemoryProposalSchema.extend({
  approval: z
    .object({
      approvalId: z.string().trim().min(1).max(256),
      status: z.literal("approved"),
      approvedAt: z.string().datetime(),
      approvedBy: z.string().trim().min(1).max(256),
    })
    .strict(),
}).strict();
export type ApprovedDiscordPersonMemoryProposal = z.infer<typeof ApprovedDiscordPersonMemoryProposalSchema>;

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

/**
 * The captain's authored tool inventory, and part of its identity.
 *
 * This lives in the protocol because two places must agree on it and they are
 * in different apps: the TUI refuses to adopt or signal a listener on the
 * captain port whose advertised tools do not match exactly, and captain-eve's
 * discovery test asserts what the agent actually compiles to. When those were
 * two hand-maintained lists they drifted the first time a tool was added — the
 * captain came up healthy and the launcher then declined to recognize it, with
 * every unit test still green because each side asserted against its own copy.
 *
 * Adding a tool means adding it here, and the discovery test fails until the
 * compiled agent agrees.
 */
export const CAPTAIN_AUTHORED_TOOL_NAMES = [
  "add_recovery",
  "create_mission",
  "decide_action",
  "get_mission",
  "get_self_state",
  "observe_current_activity",
  "remember_episode",
  "start_mission",
  "start_play",
  "steer_worker",
  "stop_play",
  "submit_plan",
] as const;

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
} as const;

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

/** The realtime pipeline's failure stages. The cascade stages left with the cascade. */
export const DiscordVoiceFailureStageSchema = z.enum([
  "capture",
  "transcription_session",
  "conversation_session",
  "captain_handoff",
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
        type: z.literal("floor"),
        ...discordVoiceChannelScope,
        state: DiscordVoiceFloorStateSchema,
        reason: DiscordVoiceFloorReasonSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("response"),
        ...discordVoiceChannelScope,
        deliveryId: DiscordVoiceLocalIdSchema,
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
    z.object({ type: z.literal("left"), ...discordVoiceChannelScope }).strict(),
    z
      .object({
        type: z.literal("possessor_connection"),
        phase: DiscordVoicePossessorConnectionPhaseSchema,
        attachedCount: DiscordVoiceCounterSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("possessor_room"),
        listening: z.boolean(),
        attachedCount: DiscordVoiceCounterSchema,
        deliveredCount: DiscordVoiceCounterSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("possessor_transcript_delivery"),
        deliveryId: DiscordVoiceLocalIdSchema,
        attachedCount: DiscordVoiceCounterSchema,
        deliveredCount: DiscordVoiceCounterSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("possessor_narration_submission"),
        deliveryId: DiscordVoiceLocalIdSchema,
        attachedCount: DiscordVoiceCounterSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("possessor_refusal"),
        deliveryId: DiscordVoiceLocalIdSchema.optional(),
        attachedCount: DiscordVoiceCounterSchema,
        reason: DiscordVoiceFailureCodeSchema,
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
