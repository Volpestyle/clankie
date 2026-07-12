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
  put(idempotencyKey: string, fingerprint: string, result: AttentionDeliveryResult): Promise<void>;
}

export interface DeliverHumanAttentionInput {
  readonly request: unknown;
  readonly binding: WorkspaceTrackerBinding;
  readonly projection: CaptainCeremonyProjection;
  readonly adapter: AttentionDeliveryAdapter;
  readonly policy: TrackerPolicyGateway;
  readonly store: AttentionDeliveryStore;
  readonly clock?: () => Date;
  readonly missionIdForPolicy?: string;
}

function mapAttentionActionToWriteAction(
  kind: ResolvedAttentionAction["capability"]["kind"],
): TrackerWriteRequest["action"] {
  switch (kind) {
    case "assign_principal":
      return "tracker.assignment.mirror";
    case "comment_notify":
    case "surface_notify":
    case "direct_notify":
    case "attention_marker":
      return "tracker.comment.create";
  }
}

function aggregateOf(actions: readonly AttentionActionResult[]): AttentionAggregateOutcome {
  if (actions.length === 0) return "unsupported";
  const succeeded = actions.filter((action) => action.status === "succeeded");
  const unsupported = actions.every(
    (action) => action.status === "unsupported" || action.status === "denied",
  );
  if (succeeded.length === actions.length) {
    return actions.some((action) => action.isFallback) ? "fallback" : "delivered";
  }
  if (succeeded.length === 0 && unsupported) return "unsupported";
  if (succeeded.length === 0) return "unsupported";
  return "partial";
}

function deliveryIdempotencyKey(requestId: string, fingerprint: string): string {
  return createHash("sha256").update(`attention:${requestId}:${fingerprint}`).digest("hex");
}

/**
 * Deliver a human-attention request through a provider-neutral binding.
 * Idempotent by requestId + binding fingerprint. Policy-evaluates every action.
 * Never claims delivery from configured intent alone.
 */
export async function deliverHumanAttention(
  input: DeliverHumanAttentionInput,
): Promise<AttentionDeliveryResult> {
  if (!input.projection.humanAttention.enabled) {
    const now = (input.clock ?? (() => new Date()))().toISOString();
    const request = HumanAttentionRequestSchema.parse(input.request);
    return {
      requestId: request.requestId,
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

  const fingerprint = bindingFingerprint(input.binding, resolved.actions);
  const idempotencyKey = deliveryIdempotencyKey(request.requestId, fingerprint);
  const prior = await input.store.get(idempotencyKey);
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint) {
      throw new Error("Human-attention delivery idempotency conflict for request fingerprint");
    }
    return prior;
  }

  const actionResults: AttentionActionResult[] = [];
  if (resolved.actions.length === 0) {
    const now = (input.clock ?? (() => new Date()))().toISOString();
    const result: AttentionDeliveryResult = {
      requestId: request.requestId,
      correlationId: request.correlationId,
      aggregate: "unsupported",
      actions: [],
      fingerprint,
      deliveredAt: now,
    };
    await input.store.put(idempotencyKey, fingerprint, result);
    return result;
  }

  for (const action of resolved.actions) {
    const writeRequest: TrackerWriteRequest = {
      action: mapAttentionActionToWriteAction(action.capability.kind),
      // Assignment mirrors stay reversible; narrative notify paths use the same
      // reversible class as TrackerMirror comment publishes (narrative rate policy
      // is applied separately by control-plane narrative routes when used).
      riskClass: "reversible-write",
      missionId: input.missionIdForPolicy ?? request.missionId,
      ref: {
        connector: "workspace",
        workspaceId: input.binding.workspaceId,
        issueId: request.trackerRef?.externalRef ?? request.requestId,
      },
      idempotencyKey: `${idempotencyKey}:${action.capability.kind}:${action.capability.principalId}`,
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
  const result: AttentionDeliveryResult = {
    requestId: request.requestId,
    correlationId: request.correlationId,
    aggregate: aggregateOf(actionResults),
    actions: actionResults,
    fingerprint,
    deliveredAt: now,
  };
  await input.store.put(idempotencyKey, fingerprint, result);
  return result;
}

export interface PendingAttentionRecord {
  readonly request: HumanAttentionRequest;
  readonly workspaceId: string;
  readonly issueId?: string;
  readonly agentSessionId?: string;
  readonly rootCommentId?: string | null;
}

/**
 * Correlate a verified agent-session DomainEvent to a pending attention request.
 * Only `tracker.agent-session.created` / `tracker.agent-session.prompted` may resolve.
 * Ordinary out-of-session comments never match.
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
  const issue = data.issue as { id?: string } | undefined;
  const session = data.session as
    | {
        id?: string;
        commentId?: string | null;
        sourceCommentId?: string | null;
      }
    | undefined;
  const appActor = data.appActor as { id?: string } | undefined;
  const actor = data.actor as { id?: string } | undefined;

  if (input.pending.issueId !== undefined && issue?.id !== input.pending.issueId) {
    return undefined;
  }
  if (input.pending.agentSessionId !== undefined && session?.id !== input.pending.agentSessionId) {
    return undefined;
  }
  if (input.pending.rootCommentId !== undefined && input.pending.rootCommentId !== null) {
    const root = session?.commentId ?? session?.sourceCommentId ?? null;
    if (root !== input.pending.rootCommentId) return undefined;
  }
  // Self-authored app actor cannot close attention.
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
    rationale: input.rationale ?? "Authoritative agent-session response correlated to pending attention.",
    createdAt,
    ...(input.pending.request.trackerRef === undefined
      ? {}
      : { trackerRef: input.pending.request.trackerRef }),
  });
}

/**
 * Explicit counterexample path: ordinary issue-comment shaped payloads never resolve.
 */
export function correlateOutOfSessionIssueComment(_input: {
  readonly pending: PendingAttentionRecord;
  readonly comment: { readonly issueId: string; readonly body: string; readonly actorId?: string };
}): undefined {
  return undefined;
}

export function attentionDeliveryEventData(result: AttentionDeliveryResult): Record<string, unknown> {
  return {
    requestId: result.requestId,
    correlationId: result.correlationId,
    aggregate: result.aggregate,
    fingerprint: result.fingerprint,
    deliveredAt: result.deliveredAt,
    actions: result.actions,
  };
}
