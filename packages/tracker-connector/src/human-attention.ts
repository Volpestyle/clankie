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

export interface AttentionDeliveryAdapter {
  /**
   * Attempt one resolved capability. `unsupported: true` means the adapter cannot
   * perform this capability (not a transient failure).
   */
  attempt(action: ResolvedAttentionAction): Promise<{
    ok: boolean;
    unsupported?: boolean;
    detail?: string;
  }>;
}

/** Durable idempotent store (mission event projection or equivalent). */
export interface AttentionDeliveryStore {
  get(idempotencyKey: string): Promise<AttentionDeliveryResult | undefined>;
  put(
    idempotencyKey: string,
    fingerprint: string,
    result: AttentionDeliveryResult,
  ): Promise<void>;
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
      return "tracker.assignment.mirror";
    case "comment_notify":
      return "tracker.comment.create";
    case "surface_notify":
    case "direct_notify":
    case "attention_marker":
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

/** Store key is request-id stable so content fingerprint conflicts are detectable. */
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

/**
 * Deliver a human-attention request through a trusted workspace binding.
 * Idempotent by requestId with content-aware fingerprint conflict detection.
 * Policy-evaluates every action with a truthful TrackerWriteRequest action
 * (or marks unsupported). Never claims delivery from configured intent alone.
 */
export async function deliverHumanAttention(
  input: DeliverHumanAttentionInput,
): Promise<AttentionDeliveryResult> {
  if (!input.projection.humanAttention.enabled) {
    const now = (input.clock ?? (() => new Date()))().toISOString();
    const request = HumanAttentionRequestSchema.parse(input.request);
    return {
      requestId: request.requestId,
      missionId: request.missionId,
      correlationId: request.correlationId,
      aggregate: "unsupported",
      actions: [],
      fingerprint: "ceremony-disabled",
      deliveredAt: now,
    };
  }

  const request = HumanAttentionRequestSchema.parse(input.request);
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
  const storeKey = deliveryStoreKey(request.requestId);
  const prior = await input.store.get(storeKey);
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint) {
      throw new Error("Human-attention delivery idempotency conflict for request content/fingerprint");
    }
    return prior;
  }

  const actionResults: AttentionActionResult[] = [];
  if (resolved.actions.length === 0) {
    const now = (input.clock ?? (() => new Date()))().toISOString();
    const result: AttentionDeliveryResult = {
      requestId: request.requestId,
      missionId: request.missionId,
      correlationId: request.correlationId,
      aggregate: enforceRequiredDirectNotification(directNotification, [], "unsupported"),
      actions: [],
      fingerprint,
      deliveredAt: now,
    };
    await input.store.put(storeKey, fingerprint, result);
    return result;
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
      idempotencyKey: `${storeKey}:${action.capability.kind}:${action.capability.principalId}`,
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

    const attempt = await input.adapter.attempt(action);
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
  const result: AttentionDeliveryResult = {
    requestId: request.requestId,
    missionId: request.missionId,
    correlationId: request.correlationId,
    aggregate,
    actions: actionResults,
    fingerprint,
    deliveredAt: now,
  };
  await input.store.put(storeKey, fingerprint, result);
  return result;
}

export interface PendingAttentionRecord {
  readonly request: HumanAttentionRequest;
  /** Must match verified agent-session event organization id (workspace). */
  readonly workspaceId: string;
  readonly issueId?: string;
  readonly agentSessionId?: string;
  readonly rootCommentId?: string | null;
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
  const session = data.session as {
    commentId?: string | null;
    sourceCommentId?: string | null;
  } | undefined;
  if (typeof session?.sourceCommentId === "string" && session.sourceCommentId.length > 0) {
    return session.sourceCommentId;
  }
  if (typeof session?.commentId === "string" && session.commentId.length > 0) {
    return session.commentId;
  }
  return null;
}

/**
 * Correlate a **verified** agent-session DomainEvent to a pending attention request.
 * - workspaceId must equal event.data.organization.id
 * - event.occurredAt must not be older than request.createdAt
 * - root comment uses event comment/root fields (see rootCommentIdFromAgentSessionEvent)
 * Only `tracker.agent-session.created` / `prompted` may resolve.
 */
export function correlateAgentSessionToAttention(input: {
  readonly pending: PendingAttentionRecord;
  readonly event: DomainEvent;
  readonly responseId: string;
  readonly actorRole: HumanAttentionResponse["actorRole"];
  readonly decision?: HumanAttentionResponse["decision"];
  readonly rationale?: string;
  readonly clock?: () => Date;
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

  const createdAt = (input.clock ?? (() => new Date()))().toISOString();
  return HumanAttentionResponseSchema.parse({
    schemaVersion: 1,
    responseId: input.responseId,
    requestId: input.pending.request.requestId,
    correlationId: input.pending.request.correlationId,
    actorRole: input.actorRole,
    decision: input.decision ?? "clarify",
    rationale:
      input.rationale ?? "Authoritative agent-session response correlated to pending attention.",
    createdAt,
    ...(input.pending.request.trackerRef === undefined
      ? {}
      : { trackerRef: input.pending.request.trackerRef }),
  });
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
