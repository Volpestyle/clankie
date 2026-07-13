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

export const CaptainLaneSchema = z.enum(["tui", "discord_voice", "discord_presence", "gameplay"]);
export type CaptainLane = z.infer<typeof CaptainLaneSchema>;

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
    sourceLane: CaptainLaneSchema,
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

export const WorkerResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "blocked"]),
  summary: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  outputs: z.record(z.string(), z.unknown()).default({}),
  diagnosis: z.string().optional(),
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

const EventBaseSchema = z.object({
  id: z.string().min(1),
  occurredAt: z.string().datetime(),
  missionId: MissionIdSchema,
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

export const CaptainChannelTurnResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("settled"),
      captainSessionId: z.string().min(1),
      turnId: z.string().min(1),
      response: z.string().trim().min(1).max(16_384),
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
]);
export type DiscordPresenceAction = z.infer<typeof DiscordPresenceActionSchema>;

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
    transportKind: z.enum(["bot", "user_session"]),
  })
  .strict();
export type DiscordPresenceChannelIdentity = z.infer<typeof DiscordPresenceChannelIdentitySchema>;

export const DISCORD_PRESENCE_TRIGGER_BODY_MAX = 16_384;
export const DISCORD_PRESENCE_CONTEXT_MESSAGES_MAX = 50;

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
};

export const DiscordPresenceWriteSchema = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: z.string().min(1),
    action: DiscordPresenceActionSchema,
    identity: DiscordPresenceChannelIdentitySchema.extend({ transportKind: z.literal("bot") }).strict(),
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
      write.identity.missionId === undefined
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
      return payload.kind;
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
    transportKind: z.literal("bot"),
    channelId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
  })
  .strict();
export type DiscordPresenceWriteResult = z.infer<typeof DiscordPresenceWriteResultSchema>;

// ---------------------------------------------------------------------------
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
