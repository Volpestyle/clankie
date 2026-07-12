import { decideAction, projectCaptainCeremony, type CompiledDoctrine } from "@clankie/doctrine";
import type { EventStore } from "@clankie/event-store";
import {
  type DomainEvent,
  type HumanAttentionResponse,
} from "@clankie/protocol";
import {
  authorityFromVerifiedEvent,
  correlateAgentSessionToAttention,
  deliverHumanAttention,
  deliveryStoreKey,
  validateIssueDraft,
  type AttentionDeliveryAdapter,
  type AttentionDeliveryResult,
  type AttentionDeliveryStore,
  type StoredAttentionDelivery,
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
 * Correlation accepts only requestId + verifiedEventId (+ responseId/profileHash).
 * Pending request and correlation context load from the durable store.
 * Actor role / decision / rationale come from the verified event — never the caller.
 */
export const CorrelateAttentionRequestSchema = z
  .object({
    requestId: z.string().min(1),
    verifiedEventId: z.string().min(1),
    responseId: z.string().min(1),
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
  correlate(
    raw: unknown,
  ): Promise<HumanAttentionResponse | { ok: false; reason: string }>;
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

/** Serialize concurrent work for a key within a process. */
class KeyExclusive {
  private readonly chains = new Map<string, Promise<unknown>>();

  public async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(
      () => gate,
      () => gate,
    );
    this.chains.set(key, next);
    try {
      await previous;
    } catch {
      // prior failure must not block the next waiter
    }
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === next) this.chains.delete(key);
    }
  }
}

/**
 * Durable attention store backed by the mission event log.
 * Concurrent put/get for the same request key is serialized; durable event id is
 * deterministic per key so a second append of the same result is idempotent.
 */
export class EventStoreAttentionDeliveryStore implements AttentionDeliveryStore {
  private readonly eventStore: EventStore;
  private readonly options: {
    readonly profileHash: string;
    readonly idFactory: () => string;
    readonly clock: () => Date;
  };
  private readonly exclusive = new KeyExclusive();

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

  public async get(idempotencyKey: string): Promise<StoredAttentionDelivery | undefined> {
    const entries = await this.eventStore.readAll();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const event = entries[index]?.event;
      if (event?.type !== "tracker.human-attention.store") continue;
      if (event.data.idempotencyKey !== idempotencyKey) continue;
      const result = event.data.result as AttentionDeliveryResult;
      const pending = event.data.pending as StoredAttentionDelivery["pending"] | undefined;
      if (pending === undefined || typeof pending.workspaceId !== "string" || pending.workspaceId.length === 0) {
        // Rows without trusted pending context cannot back correlation.
        continue;
      }
      return { result, pending };
    }
    return undefined;
  }

  public async runExclusive(
    idempotencyKey: string,
    fingerprint: string,
    factory: () => Promise<StoredAttentionDelivery>,
  ): Promise<StoredAttentionDelivery> {
    return this.exclusive.run(idempotencyKey, async () => {
      const prior = await this.get(idempotencyKey);
      if (prior !== undefined && prior.pending.workspaceId !== "") {
        if (prior.result.fingerprint !== fingerprint) {
          throw new Error("Human-attention delivery idempotency conflict for request content/fingerprint");
        }
        return prior;
      }
      const record = await factory();
      if (record.result.fingerprint !== fingerprint) {
        throw new Error("Human-attention delivery factory fingerprint mismatch");
      }
      // Deterministic event id: concurrent/process restarts re-append identically.
      const eventId = `tracker.human-attention.store:${idempotencyKey}`;
      await this.eventStore.append({
        id: eventId,
        occurredAt: this.options.clock().toISOString(),
        missionId: record.result.missionId,
        correlationId: record.result.correlationId,
        profileHash: this.options.profileHash,
        type: "tracker.human-attention.store",
        data: {
          idempotencyKey,
          fingerprint,
          result: record.result,
          pending: record.pending,
        },
      });
      return record;
    });
  }
}

/** In-memory store for unit tests only — never a production default. */
export class InMemoryAttentionDeliveryStore implements AttentionDeliveryStore {
  public readonly entries = new Map<string, StoredAttentionDelivery>();
  private readonly exclusive = new KeyExclusive();

  public async get(key: string): Promise<StoredAttentionDelivery | undefined> {
    return this.entries.get(key);
  }

  public async runExclusive(
    key: string,
    fingerprint: string,
    factory: () => Promise<StoredAttentionDelivery>,
  ): Promise<StoredAttentionDelivery> {
    return this.exclusive.run(key, async () => {
      const prior = this.entries.get(key);
      if (prior !== undefined) {
        if (prior.result.fingerprint !== fingerprint) {
          throw new Error("Human-attention delivery idempotency conflict for request content/fingerprint");
        }
        return prior;
      }
      const record = await factory();
      this.entries.set(key, record);
      return record;
    });
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
    async correlate(raw) {
      const parsed = CorrelateAttentionRequestSchema.parse(raw);
      if (parsed.profileHash !== input.doctrine.profileHash) {
        throw new Error("doctrine_hash_mismatch");
      }
      const stored = await input.store.get(deliveryStoreKey(parsed.requestId));
      if (stored === undefined) {
        return { ok: false as const, reason: "pending_not_found" };
      }
      const event = input.lookupVerifiedEvent(parsed.verifiedEventId);
      if (event === undefined) {
        return { ok: false as const, reason: "verified_event_not_found" };
      }
      if (event.type !== "tracker.agent-session.created" && event.type !== "tracker.agent-session.prompted") {
        return { ok: false as const, reason: "event_not_agent_session" };
      }
      const authority = authorityFromVerifiedEvent(event);
      if (authority === undefined) {
        return { ok: false as const, reason: "event_authority_missing" };
      }
      const response = correlateAgentSessionToAttention({
        pending: stored.pending,
        event,
        responseId: parsed.responseId,
        actorRole: authority.actorRole,
        decision: authority.decision,
        rationale: authority.rationale,
        ...(input.clock === undefined ? {} : { clock: input.clock }),
      });
      if (response === undefined) {
        return { ok: false as const, reason: "no_correlation" };
      }
      return response;
    },
  };
}
