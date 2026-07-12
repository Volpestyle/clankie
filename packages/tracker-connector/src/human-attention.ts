import { createHash } from "node:crypto";
import type { CaptainCeremonyProjection } from "@clankie/doctrine";
import {
  HumanAttentionRequestSchema,
  HumanAttentionResponseSchema,
  type DomainEvent,
  type HumanAttentionRequest,
  type HumanAttentionResponse,
  type CeremonyDirectNotificationMode,
} from "@clankie/protocol";
import type { TrackerPolicyDecision, TrackerPolicyGateway, TrackerWriteRequest } from "./types.ts";
import {
  bindingFingerprint,
  resolveAttentionActions,
  type ResolvedAttentionAction,
  type WorkspaceTrackerBinding,
} from "./workspace-binding.ts";

export type AttentionActionStatus = "succeeded" | "failed" | "unsupported" | "denied";

export interface AttentionActionResult {
  readonly kind: ResolvedAttentionAction["capability"]["kind"];
  readonly principalId: string;
  readonly surface?: string;
  readonly status: AttentionActionStatus;
  readonly detail?: string;
  readonly isFallback: boolean;
}

export type AttentionAggregateOutcome = "delivered" | "partial" | "unsupported" | "fallback";

export interface AttentionDeliveryResult {
  readonly requestId: string;
  readonly missionId: string;
  readonly correlationId: string;
  readonly aggregate: AttentionAggregateOutcome;
  readonly actions: readonly AttentionActionResult[];
  readonly fingerprint: string;
  readonly deliveredAt: string;
}

/**
 * Stable per-action idempotency token for provider seams.
 * Same requestId + content fingerprint + action identity always yields the same
 * token so retries / crash recovery re-use the provider's idempotent write key
 * rather than creating a second side effect.
 */
export function actionIdempotencyToken(
  requestId: string,
  fingerprint: string,
  action: ResolvedAttentionAction,
): string {
  const payload = {
    v: 1,
    requestId,
    fingerprint,
    kind: action.capability.kind,
    principalId: action.capability.principalId,
    surface: action.surface ?? null,
    isFallback: action.isFallback,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export interface AttentionDeliveryAttemptInput {
  readonly action: ResolvedAttentionAction;
  /** Validated semantic request used to render the provider action. */
  readonly request: HumanAttentionRequest;
  /** Trusted workspace identity from the resolved binding. */
  readonly workspaceId: string;
  /**
   * Provider seam obligation: pass this unchanged on every retry of the same
   * logical action. Adapters must treat it as their external idempotency key.
   */
  readonly idempotencyToken: string;
}

export interface AttentionDeliveryAdapter {
  /**
   * Attempt one resolved capability. `unsupported: true` means the adapter cannot
   * perform this capability (not a transient failure).
   * Callers always supply a stable `idempotencyToken` for durable provider dedupe.
   */
  attempt(input: AttentionDeliveryAttemptInput): Promise<{
    ok: boolean;
    unsupported?: boolean;
    detail?: string;
  }>;
}

export interface PendingAttentionRecord {
  readonly request: HumanAttentionRequest;
  /** Must match verified agent-session event organization id (workspace). */
  readonly workspaceId: string;
  readonly issueId?: string;
  readonly agentSessionId?: string;
  readonly rootCommentId?: string | null;
}

/** Durable delivery + correlation context written together. */
export interface StoredAttentionDelivery {
  readonly result: AttentionDeliveryResult;
  readonly pending: PendingAttentionRecord;
}

/**
 * Claim context for durable single-flight on the real mission stream.
 * ProjectionEventStore streams are missionId-based — never fake missionId as an
 * attention-request synthetic stream id.
 */
export interface AttentionDeliveryClaimContext {
  readonly missionId: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly fingerprint: string;
}

/**
 * Durable idempotent store for attention delivery.
 *
 * `durableSingleFlight === true` means the store provides a cross-process
 * reservation + completion contract on the **real mission stream** (compare-
 * and-append at current mission revision). A process-local mutex alone is
 * **not** durable exactly-once and must report `durableSingleFlight === false`.
 */
export interface AttentionDeliveryStore {
  /**
   * True when the store can reserve + complete across process restarts using a
   * durable mission event log. False for in-memory / process-local helpers.
   */
  readonly durableSingleFlight: boolean;
  /** Lookup completed delivery by requestId (from durable log / test map). */
  get(requestId: string): Promise<StoredAttentionDelivery | undefined>;
  /**
   * Single-flight delivery for a request on its mission stream.
   *
   * Durable implementations: reserve on the real mission stream via
   * `appendExpected` at the stream's **current** revision with event data
   * `requestId` + `fingerprint`; concurrent contenders re-read the mission
   * stream to find the claim. Factory runs after reserve (or claim-resume
   * after crash) with stable `actionIdempotencyToken`s. Complete is a
   * deterministic event id on the same mission stream.
   */
  runExclusive(
    context: AttentionDeliveryClaimContext,
    factory: () => Promise<StoredAttentionDelivery>,
  ): Promise<StoredAttentionDelivery>;
}

export interface DeliverHumanAttentionInput {
  readonly request: unknown;
  /** Trusted binding resolved by control plane — never from the request body. */
  readonly binding: WorkspaceTrackerBinding;
  readonly projection: CaptainCeremonyProjection;
  readonly adapter: AttentionDeliveryAdapter;
  readonly policy: TrackerPolicyGateway;
  readonly store: AttentionDeliveryStore;
  readonly clock?: () => Date;
  readonly missionIdForPolicy?: string;
}

/**
 * Map a capability to a TrackerWriteRequest action only when the action
 * truthfully names the adapter side effect. Capabilities without an exact
 * policy action return undefined → delivery marks unsupported (preferable
 * to authorizing the wrong action).
 */
export function policyActionForCapability(
  kind: ResolvedAttentionAction["capability"]["kind"],
): TrackerWriteRequest["action"] | undefined {
  switch (kind) {
    case "assign_principal":
      return "tracker.assignment.update";
    case "comment_notify":
    case "direct_notify":
      return "tracker.comment.create";
    case "attention_marker":
      return "tracker.attention.marker.apply";
    case "surface_notify":
      return undefined;
  }
}

function aggregateOf(actions: readonly AttentionActionResult[]): AttentionAggregateOutcome {
  if (actions.length === 0) return "unsupported";
  const succeeded = actions.filter((action) => action.status === "succeeded");
  const allTerminalUnsupportedOrDenied = actions.every(
    (action) => action.status === "unsupported" || action.status === "denied",
  );
  if (succeeded.length === actions.length) {
    return actions.some((action) => action.isFallback) ? "fallback" : "delivered";
  }
  if (succeeded.length === 0 && allTerminalUnsupportedOrDenied) return "unsupported";
  if (succeeded.length === 0) return "unsupported";
  return "partial";
}

/**
 * When directNotification is required, a successful direct_notify is mandatory
 * for aggregate "delivered". Marker/comment-only bindings must never claim delivered.
 * Per-action denied vs unsupported remains on each action row.
 */
export function enforceRequiredDirectNotification(
  mode: CeremonyDirectNotificationMode,
  actions: readonly AttentionActionResult[],
  aggregate: AttentionAggregateOutcome,
): AttentionAggregateOutcome {
  if (mode !== "required") return aggregate;
  const directSucceeded = actions.some(
    (action) => action.kind === "direct_notify" && action.status === "succeeded",
  );
  if (directSucceeded) return aggregate;
  if (aggregate === "delivered" || aggregate === "partial") {
    return actions.some((action) => action.isFallback && action.status === "succeeded")
      ? "fallback"
      : "unsupported";
  }
  return aggregate;
}

/**
 * Logical lookup key for a pending/completed attention request (not a mission
 * stream id — ProjectionEventStore streams remain missionId-based).
 */
export function deliveryStoreKey(requestId: string): string {
  return `attention-request:${requestId}`;
}

/**
 * Fingerprint includes binding revision/actions **and** request content so a
 * replay with the same requestId but different ask/role/surfaces conflicts.
 */
export function deliveryFingerprint(
  binding: WorkspaceTrackerBinding,
  actions: readonly ResolvedAttentionAction[],
  request: HumanAttentionRequest,
): string {
  const payload = {
    binding: bindingFingerprint(binding, actions),
    request: {
      requestId: request.requestId,
      missionId: request.missionId,
      correlationId: request.correlationId,
      targetRole: request.targetRole,
      requestKind: request.requestKind,
      actionableAsk: request.actionableAsk,
      blocking: request.blocking,
      authorityImpact: request.authorityImpact,
      urgency: request.urgency,
      notificationSurfaces: [...request.notificationSurfaces],
      directNotification: request.directNotification ?? null,
      waitForAuthoritativeResponse: request.waitForAuthoritativeResponse ?? null,
      trackerRef: request.trackerRef ?? null,
    },
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** @deprecated use deliveryStoreKey — kept as alias for callers hashing by request+fingerprint */
export function deliveryIdempotencyKey(requestId: string, fingerprint: string): string {
  return createHash("sha256").update(`attention:${requestId}:${fingerprint}`).digest("hex");
}

function pendingFromDelivery(
  request: HumanAttentionRequest,
  binding: WorkspaceTrackerBinding,
): PendingAttentionRecord {
  return {
    request,
    workspaceId: binding.workspaceId,
    ...(request.trackerRef?.externalRef === undefined ? {} : { issueId: request.trackerRef.externalRef }),
  };
}

/**
 * Deliver a human-attention request through a trusted workspace binding.
 * Idempotent by requestId with content-aware fingerprint conflict detection.
 * Ceremony-disabled deliveries still participate in the same store/fingerprint
 * path. Single-flight is delegated to `store.runExclusive` (durable reservation
 * when the store supports it). Each adapter attempt receives a stable
 * `actionIdempotencyToken` so provider retries after crash do not double-write.
 */
export async function deliverHumanAttention(
  input: DeliverHumanAttentionInput,
): Promise<AttentionDeliveryResult> {
  const request = HumanAttentionRequestSchema.parse(input.request);
  const pending = pendingFromDelivery(request, input.binding);

  if (!input.projection.humanAttention.enabled) {
    const fingerprint = deliveryFingerprint(input.binding, [], request);
    const stored = await input.store.runExclusive(
      {
        missionId: request.missionId,
        requestId: request.requestId,
        correlationId: request.correlationId,
        fingerprint,
      },
      async () => {
        const now = (input.clock ?? (() => new Date()))().toISOString();
        return {
          pending,
          result: {
            requestId: request.requestId,
            missionId: request.missionId,
            correlationId: request.correlationId,
            aggregate: "unsupported",
            actions: [],
            fingerprint,
            deliveredAt: now,
          },
        };
      },
    );
    return stored.result;
  }

  const directNotification: CeremonyDirectNotificationMode =
    request.directNotification ?? input.projection.humanAttention.directNotification;

  let resolved = resolveAttentionActions({
    binding: input.binding,
    targetRole: request.targetRole,
    notificationSurfaces: request.notificationSurfaces,
    directNotification,
  });

  if (resolved.unsupported && input.binding.fallbackRole !== undefined) {
    resolved = resolveAttentionActions({
      binding: input.binding,
      targetRole: request.targetRole,
      notificationSurfaces: request.notificationSurfaces,
      directNotification,
      useFallback: true,
    });
  }

  const fingerprint = deliveryFingerprint(input.binding, resolved.actions, request);

  const stored = await input.store.runExclusive(
    {
      missionId: request.missionId,
      requestId: request.requestId,
      correlationId: request.correlationId,
      fingerprint,
    },
    async () => {
      const actionResults: AttentionActionResult[] = [];
      if (resolved.actions.length === 0) {
        const now = (input.clock ?? (() => new Date()))().toISOString();
        return {
          pending,
          result: {
            requestId: request.requestId,
            missionId: request.missionId,
            correlationId: request.correlationId,
            aggregate: enforceRequiredDirectNotification(directNotification, [], "unsupported"),
            actions: [],
            fingerprint,
            deliveredAt: now,
          },
        };
      }

      for (const action of resolved.actions) {
        const policyAction = policyActionForCapability(action.capability.kind);
        if (policyAction === undefined) {
          actionResults.push({
            kind: action.capability.kind,
            principalId: action.capability.principalId,
            ...(action.surface === undefined ? {} : { surface: action.surface }),
            status: "unsupported",
            detail: `No exact doctrine/policy action truthfully describes capability ${action.capability.kind}`,
            isFallback: action.isFallback,
          });
          continue;
        }

        const writeRequest: TrackerWriteRequest = {
          action: policyAction,
          riskClass: "reversible-write",
          missionId: input.missionIdForPolicy ?? request.missionId,
          ref: {
            connector: "workspace",
            workspaceId: input.binding.workspaceId,
            issueId: request.trackerRef?.externalRef ?? request.requestId,
          },
          idempotencyKey: `${request.requestId}:${action.capability.kind}:${action.capability.principalId}`,
          correlationId: request.correlationId,
          content: request.actionableAsk,
        };
        const decision: TrackerPolicyDecision = await input.policy.authorize(writeRequest);
        if (decision.effect !== "allow") {
          actionResults.push({
            kind: action.capability.kind,
            principalId: action.capability.principalId,
            ...(action.surface === undefined ? {} : { surface: action.surface }),
            status: "denied",
            detail: decision.reason,
            isFallback: action.isFallback,
          });
          continue;
        }

        const idempotencyToken = actionIdempotencyToken(request.requestId, fingerprint, action);
        const attempt = await input.adapter.attempt({
          action,
          request,
          workspaceId: input.binding.workspaceId,
          idempotencyToken,
        });
        if (attempt.unsupported === true) {
          actionResults.push({
            kind: action.capability.kind,
            principalId: action.capability.principalId,
            ...(action.surface === undefined ? {} : { surface: action.surface }),
            status: "unsupported",
            ...(attempt.detail === undefined ? {} : { detail: attempt.detail }),
            isFallback: action.isFallback,
          });
          continue;
        }
        actionResults.push({
          kind: action.capability.kind,
          principalId: action.capability.principalId,
          ...(action.surface === undefined ? {} : { surface: action.surface }),
          status: attempt.ok ? "succeeded" : "failed",
          ...(attempt.detail === undefined ? {} : { detail: attempt.detail }),
          isFallback: action.isFallback,
        });
      }

      const now = (input.clock ?? (() => new Date()))().toISOString();
      const aggregate = enforceRequiredDirectNotification(
        directNotification,
        actionResults,
        aggregateOf(actionResults),
      );
      return {
        pending,
        result: {
          requestId: request.requestId,
          missionId: request.missionId,
          correlationId: request.correlationId,
          aggregate,
          actions: actionResults,
          fingerprint,
          deliveredAt: now,
        },
      };
    },
  );

  return stored.result;
}

/**
 * Extract the complete typed response from a verified authoritative event.
 * Partial/root-level decision fields are deliberately rejected: request and
 * correlation identity must travel with the authoritative response.
 */
export function authorityFromVerifiedEvent(event: DomainEvent): HumanAttentionResponse | undefined {
  const data = event.data as Record<string, unknown>;
  const parsed = HumanAttentionResponseSchema.safeParse(data.attentionResponse);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Deterministically turn a verified agent-session prompt into a typed response.
 * The actor must equal the provider principal bound to the pending semantic role.
 * Free-form approval prose is never interpreted; Linear humans use the explicit
 * `clankie-response <requestId> <decision>: <rationale>` command emitted by the
 * notification adapter.
 */
export function responseFromVerifiedEvent(
  event: DomainEvent,
  pending: PendingAttentionRecord,
  binding: WorkspaceTrackerBinding,
): HumanAttentionResponse | undefined {
  const role = binding.roles[pending.request.targetRole];
  if (role === undefined) return undefined;
  const data = event.data as Record<string, unknown>;
  const actor = data.actor as { id?: string } | undefined;
  if (actor?.id !== role.principalId) return undefined;
  const embedded = authorityFromVerifiedEvent(event);
  if (embedded !== undefined) return embedded;
  const activity = data.activity as { id?: string; body?: string } | undefined;
  if (typeof activity?.body !== "string") return undefined;
  const escapedRequestId = pending.request.requestId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = activity.body.match(
    new RegExp(
      "(?:^|\\s)clankie-response\\s+`?" +
        escapedRequestId +
        "`?\\s+(approve|deny|defer|clarify|redirect)\\s*:\\s*(.+?)\\s*$",
      "iu",
    ),
  );
  if (match?.[1] === undefined || match[2] === undefined || match[2].trim().length === 0) return undefined;
  return HumanAttentionResponseSchema.parse({
    schemaVersion: 1,
    responseId: activity.id ?? event.id,
    requestId: pending.request.requestId,
    correlationId: pending.request.correlationId,
    actorRole: pending.request.targetRole,
    decision: match[1].toLowerCase(),
    rationale: match[2].trim(),
    ...(pending.request.trackerRef === undefined ? {} : { trackerRef: pending.request.trackerRef }),
    createdAt: event.occurredAt,
  });
}

/**
 * Root/source comment identity from a verified agent-session event.
 * Prefers event.data.comment fields, then session root/source ids.
 */
export function rootCommentIdFromAgentSessionEvent(event: DomainEvent): string | null {
  const data = event.data as Record<string, unknown>;
  const comment = data.comment as { id?: string | null; rootId?: string | null } | undefined;
  if (typeof comment?.rootId === "string" && comment.rootId.length > 0) return comment.rootId;
  if (typeof comment?.id === "string" && comment.id.length > 0) return comment.id;
  const session = data.session as
    | {
        commentId?: string | null;
        sourceCommentId?: string | null;
      }
    | undefined;
  if (typeof session?.sourceCommentId === "string" && session.sourceCommentId.length > 0) {
    return session.sourceCommentId;
  }
  if (typeof session?.commentId === "string" && session.commentId.length > 0) {
    return session.commentId;
  }
  return null;
}

/**
 * Correlate a **verified** agent-session DomainEvent to a pending attention request
 * already loaded from the durable trusted store (never from the HTTP caller).
 * - workspaceId must equal event.data.organization.id
 * - event.occurredAt must not be older than request.createdAt
 * - root comment uses event comment/root fields
 * - actorRole/decision/rationale come from the verified event (see authorityFromVerifiedEvent)
 * Only `tracker.agent-session.created` / `prompted` may resolve.
 */
export function correlateAgentSessionToAttention(input: {
  readonly pending: PendingAttentionRecord;
  readonly event: DomainEvent;
  readonly response: HumanAttentionResponse;
}): HumanAttentionResponse | undefined {
  const type = input.event.type;
  if (type !== "tracker.agent-session.created" && type !== "tracker.agent-session.prompted") {
    return undefined;
  }
  const data = input.event.data as Record<string, unknown>;
  const organization = data.organization as { id?: string } | undefined;
  if (organization?.id !== input.pending.workspaceId) {
    return undefined;
  }

  const requestCreatedMs = Date.parse(input.pending.request.createdAt);
  const eventMs = Date.parse(input.event.occurredAt);
  if (!Number.isFinite(requestCreatedMs) || !Number.isFinite(eventMs) || eventMs < requestCreatedMs) {
    return undefined;
  }

  const issue = data.issue as { id?: string } | undefined;
  const session = data.session as { id?: string } | undefined;
  const appActor = data.appActor as { id?: string } | undefined;
  const actor = data.actor as { id?: string } | undefined;

  if (input.pending.issueId !== undefined && issue?.id !== input.pending.issueId) {
    return undefined;
  }
  if (input.pending.agentSessionId !== undefined && session?.id !== input.pending.agentSessionId) {
    return undefined;
  }
  if (input.pending.rootCommentId !== undefined && input.pending.rootCommentId !== null) {
    const rootFromEvent = rootCommentIdFromAgentSessionEvent(input.event);
    if (rootFromEvent !== input.pending.rootCommentId) return undefined;
  }
  if (actor?.id !== undefined && appActor?.id !== undefined && actor.id === appActor.id) {
    return undefined;
  }
  const response = HumanAttentionResponseSchema.parse(input.response);
  if (response.requestId !== input.pending.request.requestId) return undefined;
  if (response.correlationId !== input.pending.request.correlationId) return undefined;
  if (
    JSON.stringify(response.trackerRef ?? null) !== JSON.stringify(input.pending.request.trackerRef ?? null)
  ) {
    return undefined;
  }
  const responseMs = Date.parse(response.createdAt);
  if (!Number.isFinite(responseMs) || responseMs < requestCreatedMs || responseMs > eventMs) return undefined;
  return response;
}

/** Explicit counterexample: ordinary issue comments never resolve pending attention. */
export function correlateOutOfSessionIssueComment(_input: {
  readonly pending: PendingAttentionRecord;
  readonly comment: { readonly issueId: string; readonly body: string; readonly actorId?: string };
}): undefined {
  return undefined;
}

export function attentionDeliveryEventData(result: AttentionDeliveryResult): Record<string, unknown> {
  return {
    requestId: result.requestId,
    missionId: result.missionId,
    correlationId: result.correlationId,
    aggregate: result.aggregate,
    fingerprint: result.fingerprint,
    deliveredAt: result.deliveredAt,
    actions: result.actions,
  };
}
