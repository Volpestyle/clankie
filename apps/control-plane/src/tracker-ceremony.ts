import { decideAction, projectCaptainCeremony, type CompiledDoctrine } from "@clankie/doctrine";
import type { EventStore } from "@clankie/event-store";
import {
  HumanAttentionRequestSchema,
  type DomainEvent,
  type HumanAttentionResponse,
} from "@clankie/protocol";
import {
  correlateAgentSessionToAttention,
  deliverHumanAttention,
  validateIssueDraft,
  type AttentionDeliveryAdapter,
  type AttentionDeliveryResult,
  type AttentionDeliveryStore,
  type PendingAttentionRecord,
  type TrackerPolicyGateway,
  type TrackerWriteRequest,
  type WorkspaceTrackerBinding,
} from "@clankie/tracker-connector";
import { z } from "zod";

export const ValidateIssueDraftRequestSchema = z
  .object({
    draft: z.unknown(),
    bodyMarkdown: z.string().optional(),
    profileHash: z.string().min(1),
  })
  .strict();

/** Binding is never accepted from the client — only workspaceId for trusted lookup. */
export const DeliverHumanAttentionRequestSchema = z
  .object({
    request: z.unknown(),
    workspaceId: z.string().min(1),
    profileHash: z.string().min(1),
  })
  .strict();

/**
 * Correlation accepts a durable verified event id, not a raw agent-session payload.
 * Callers must have already accepted the event into the event store (or equivalent).
 */
export const CorrelateAttentionRequestSchema = z
  .object({
    pending: z.object({
      request: z.unknown(),
      workspaceId: z.string().min(1),
      issueId: z.string().min(1).optional(),
      agentSessionId: z.string().min(1).optional(),
      rootCommentId: z.string().nullable().optional(),
    }),
    verifiedEventId: z.string().min(1),
    responseId: z.string().min(1),
    actorRole: z.enum(["operator", "captain", "product_steward", "reviewer", "verifier"]),
    decision: z.enum(["approve", "deny", "defer", "clarify", "redirect"]).optional(),
    rationale: z.string().min(1).optional(),
    profileHash: z.string().min(1),
  })
  .strict();

/** Trusted control-plane registry: workspace id → binding (never from the model/request). */
export interface WorkspaceBindingResolver {
  resolve(workspaceId: string): WorkspaceTrackerBinding | undefined;
}

export interface TrackerCeremonyRuntime {
  validateDraft(raw: unknown): ReturnType<typeof validateIssueDraft>;
  deliverAttention(raw: unknown): Promise<AttentionDeliveryResult>;
  correlate(raw: unknown): HumanAttentionResponse | { ok: false; reason: string };
}

/**
 * Fail-closed policy gateway: uses doctrine decideAction. Unknown tracker
 * actions deny by default (no default-allow).
 */
export class DoctrineAttentionPolicy implements TrackerPolicyGateway {
  private readonly doctrine: CompiledDoctrine;

  public constructor(doctrine: CompiledDoctrine) {
    this.doctrine = doctrine;
  }

  public async authorize(request: TrackerWriteRequest): Promise<{
    effect: "allow" | "deny" | "require_approval";
    reason: string;
    obligations?: readonly string[];
  }> {
    const decision = decideAction(this.doctrine, {
      id: request.idempotencyKey,
      principal: { kind: "captain", id: "tracker-ceremony" },
      action: request.action,
      resource: { type: "tracker-issue", id: request.ref.issueId },
      context: {
        missionId: request.missionId,
        risk: "low",
        profileHash: this.doctrine.profileHash,
      },
    });
    return {
      effect: decision.effect,
      reason: decision.reason,
      ...(decision.obligations === undefined ? {} : { obligations: decision.obligations }),
    };
  }
}

/** Durable attention store backed by the mission event log. */
export class EventStoreAttentionDeliveryStore implements AttentionDeliveryStore {
  private readonly eventStore: EventStore;
  private readonly options: {
    readonly profileHash: string;
    readonly idFactory: () => string;
    readonly clock: () => Date;
  };

  public constructor(
    eventStore: EventStore,
    options: {
      readonly profileHash: string;
      readonly idFactory: () => string;
      readonly clock: () => Date;
    },
  ) {
    this.eventStore = eventStore;
    this.options = options;
  }

  public async get(idempotencyKey: string): Promise<AttentionDeliveryResult | undefined> {
    const entries = await this.eventStore.readAll();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const event = entries[index]?.event;
      if (event?.type !== "tracker.human-attention.store") continue;
      if (event.data.idempotencyKey !== idempotencyKey) continue;
      return event.data.result as AttentionDeliveryResult;
    }
    return undefined;
  }

  public async put(
    idempotencyKey: string,
    fingerprint: string,
    result: AttentionDeliveryResult,
  ): Promise<void> {
    await this.eventStore.append({
      id: this.options.idFactory(),
      occurredAt: this.options.clock().toISOString(),
      missionId: result.missionId,
      correlationId: result.correlationId,
      profileHash: this.options.profileHash,
      type: "tracker.human-attention.store",
      data: { idempotencyKey, fingerprint, result },
    });
  }
}

/** In-memory store for unit tests only — never a production default. */
export class InMemoryAttentionDeliveryStore implements AttentionDeliveryStore {
  private readonly entries = new Map<string, { fingerprint: string; result: AttentionDeliveryResult }>();

  public async get(key: string): Promise<AttentionDeliveryResult | undefined> {
    return this.entries.get(key)?.result;
  }

  public async put(key: string, fingerprint: string, result: AttentionDeliveryResult): Promise<void> {
    this.entries.set(key, { fingerprint, result });
  }
}

/** Adapter that marks all capabilities unsupported (honest without Linear extension). */
export class UnsupportedAttentionAdapter implements AttentionDeliveryAdapter {
  public async attempt(): Promise<{ ok: boolean; unsupported?: boolean; detail?: string }> {
    return {
      ok: false,
      unsupported: true,
      detail: "No attention delivery adapter is configured for this control plane.",
    };
  }
}

export function createTrackerCeremonyRuntime(input: {
  readonly doctrine: CompiledDoctrine;
  readonly policy: TrackerPolicyGateway;
  readonly adapter: AttentionDeliveryAdapter;
  readonly store: AttentionDeliveryStore;
  readonly bindingResolver: WorkspaceBindingResolver;
  /** Lookup verified DomainEvents by id (event store). Required for correlate. */
  readonly lookupVerifiedEvent: (eventId: string) => DomainEvent | undefined;
  readonly clock?: () => Date;
}): TrackerCeremonyRuntime {
  const projection = projectCaptainCeremony(input.doctrine);
  return {
    validateDraft(raw) {
      const parsed = ValidateIssueDraftRequestSchema.parse(raw);
      if (parsed.profileHash !== input.doctrine.profileHash) {
        throw new Error("doctrine_hash_mismatch");
      }
      return validateIssueDraft({
        draft: parsed.draft,
        projection,
        ...(parsed.bodyMarkdown === undefined ? {} : { bodyMarkdown: parsed.bodyMarkdown }),
      });
    },
    async deliverAttention(raw) {
      const parsed = DeliverHumanAttentionRequestSchema.parse(raw);
      if (parsed.profileHash !== input.doctrine.profileHash) {
        throw new Error("doctrine_hash_mismatch");
      }
      const binding = input.bindingResolver.resolve(parsed.workspaceId);
      if (binding === undefined) {
        throw new Error("workspace_binding_unavailable");
      }
      if (binding.workspaceId !== parsed.workspaceId) {
        throw new Error("workspace_binding_mismatch");
      }
      return deliverHumanAttention({
        request: parsed.request,
        binding,
        projection,
        adapter: input.adapter,
        policy: input.policy,
        store: input.store,
        ...(input.clock === undefined ? {} : { clock: input.clock }),
      });
    },
    correlate(raw) {
      const parsed = CorrelateAttentionRequestSchema.parse(raw);
      if (parsed.profileHash !== input.doctrine.profileHash) {
        throw new Error("doctrine_hash_mismatch");
      }
      const event = input.lookupVerifiedEvent(parsed.verifiedEventId);
      if (event === undefined) {
        return { ok: false as const, reason: "verified_event_not_found" };
      }
      if (event.type !== "tracker.agent-session.created" && event.type !== "tracker.agent-session.prompted") {
        return { ok: false as const, reason: "event_not_agent_session" };
      }
      const pending: PendingAttentionRecord = {
        request: HumanAttentionRequestSchema.parse(parsed.pending.request),
        workspaceId: parsed.pending.workspaceId,
        ...(parsed.pending.issueId === undefined ? {} : { issueId: parsed.pending.issueId }),
        ...(parsed.pending.agentSessionId === undefined
          ? {}
          : { agentSessionId: parsed.pending.agentSessionId }),
        ...(parsed.pending.rootCommentId === undefined
          ? {}
          : { rootCommentId: parsed.pending.rootCommentId }),
      };
      const response = correlateAgentSessionToAttention({
        pending,
        event,
        responseId: parsed.responseId,
        actorRole: parsed.actorRole,
        ...(parsed.decision === undefined ? {} : { decision: parsed.decision }),
        ...(parsed.rationale === undefined ? {} : { rationale: parsed.rationale }),
        ...(input.clock === undefined ? {} : { clock: input.clock }),
      });
      if (response === undefined) {
        return { ok: false as const, reason: "no_correlation" };
      }
      return response;
    },
  };
}
