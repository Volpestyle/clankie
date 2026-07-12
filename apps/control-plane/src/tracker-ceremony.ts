import { decideAction, projectCaptainCeremony, type CompiledDoctrine } from "@clankie/doctrine";
import {
  OptimisticConcurrencyError,
  type EventStore,
  type ProjectionEventStore,
} from "@clankie/event-store";
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
  type AttentionDeliveryAttemptInput,
  type AttentionDeliveryResult,
  type AttentionDeliveryStore,
  type StoredAttentionDelivery,
  type TrackerPolicyGateway,
  type TrackerWriteRequest,
  type WorkspaceTrackerBinding,
} from "@clankie/tracker-connector";
import { z } from "zod";

/** True when the event store supports durable compare-and-append streams. */
export function isProjectionEventStore(store: EventStore): store is ProjectionEventStore {
  const candidate = store as ProjectionEventStore;
  return (
    typeof candidate.appendExpected === "function" && typeof candidate.readStream === "function"
  );
}

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

/** Process-local serialization only — never the durability mechanism. */
class ProcessLocalKeyExclusive {
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

function attentionReserveEventId(idempotencyKey: string): string {
  return `tracker.human-attention.reserve:${idempotencyKey}`;
}

function attentionCompleteEventId(idempotencyKey: string): string {
  return `tracker.human-attention.store:${idempotencyKey}`;
}

/**
 * Durable attention store backed by a ProjectionEventStore stream.
 *
 * Contract (VUH-844 durable idempotency):
 * 1. Stream id = delivery store key (`attention-request:{requestId}`).
 * 2. Atomic **reserve** via `appendExpected` at revision 0 (or recovery of an
 *    existing incomplete reservation after crash).
 * 3. Factory / adapter work runs only after reserve; adapters receive stable
 *    per-action idempotency tokens (provider seam).
 * 4. Deterministic **complete** event id; re-append of identical completion is
 *    idempotent. In-process mutex may reduce duplicate work but is **not**
 *    durable exactly-once by itself.
 */
export class EventStoreAttentionDeliveryStore implements AttentionDeliveryStore {
  public readonly durableSingleFlight = true as const;
  private readonly eventStore: ProjectionEventStore;
  private readonly options: {
    readonly profileHash: string;
    readonly idFactory: () => string;
    readonly clock: () => Date;
  };
  /** Optional same-process assist only — durability is reserve/complete. */
  private readonly processLocal = new ProcessLocalKeyExclusive();

  public constructor(
    eventStore: EventStore,
    options: {
      readonly profileHash: string;
      readonly idFactory: () => string;
      readonly clock: () => Date;
    },
  ) {
    if (!isProjectionEventStore(eventStore)) {
      throw new Error(
        "attention_delivery_store_requires_projection_event_store: EventStore must support appendExpected/readStream for durable single-flight",
      );
    }
    this.eventStore = eventStore;
    this.options = options;
  }

  public async get(idempotencyKey: string): Promise<StoredAttentionDelivery | undefined> {
    const state = await this.readStreamState(idempotencyKey);
    return state.complete;
  }

  public async runExclusive(
    idempotencyKey: string,
    fingerprint: string,
    factory: () => Promise<StoredAttentionDelivery>,
  ): Promise<StoredAttentionDelivery> {
    // Process-local assist only; cross-process correctness is reserve + complete.
    return this.processLocal.run(idempotencyKey, async () => {
      let state = await this.readStreamState(idempotencyKey);
      if (state.complete !== undefined) {
        return this.requireFingerprint(state.complete, fingerprint);
      }

      if (state.reserve === undefined) {
        try {
          await this.eventStore.appendExpected(
            {
              id: attentionReserveEventId(idempotencyKey),
              occurredAt: this.options.clock().toISOString(),
              missionId: idempotencyKey,
              correlationId: idempotencyKey,
              profileHash: this.options.profileHash,
              type: "tracker.human-attention.reserve",
              data: { idempotencyKey, fingerprint, phase: "reserved" },
            },
            { streamId: idempotencyKey, expectedRevision: 0 },
          );
        } catch (error) {
          if (!(error instanceof OptimisticConcurrencyError)) throw error;
          // Another writer reserved first — fall through to re-read.
        }
        state = await this.readStreamState(idempotencyKey);
        if (state.complete !== undefined) {
          return this.requireFingerprint(state.complete, fingerprint);
        }
        if (state.reserve === undefined) {
          throw new Error(
            "attention_delivery_reservation_failed_closed: could not reserve or observe a durable reservation",
          );
        }
      }

      if (state.reserve.fingerprint !== fingerprint) {
        throw new Error("Human-attention delivery idempotency conflict for request content/fingerprint");
      }

      // Crash recovery: incomplete reservation may re-run factory with the same
      // stable action tokens (provider seam). Durable complete is still once.
      const record = await factory();
      if (record.result.fingerprint !== fingerprint) {
        throw new Error("Human-attention delivery factory fingerprint mismatch");
      }

      // Re-read before complete: a concurrent writer may have finished.
      state = await this.readStreamState(idempotencyKey);
      if (state.complete !== undefined) {
        return this.requireFingerprint(state.complete, fingerprint);
      }

      const completeEvent: DomainEvent = {
        id: attentionCompleteEventId(idempotencyKey),
        occurredAt: this.options.clock().toISOString(),
        missionId: idempotencyKey,
        correlationId: record.result.correlationId,
        profileHash: this.options.profileHash,
        type: "tracker.human-attention.store",
        data: {
          idempotencyKey,
          fingerprint,
          result: record.result,
          pending: record.pending,
          phase: "completed",
        },
      };

      try {
        await this.eventStore.appendExpected(completeEvent, {
          streamId: idempotencyKey,
          expectedRevision: state.streamLength,
        });
      } catch (error) {
        if (!(error instanceof OptimisticConcurrencyError)) throw error;
        // Deterministic complete id: identical concurrent completion is idempotent.
        await this.eventStore.append(completeEvent);
      }

      state = await this.readStreamState(idempotencyKey);
      if (state.complete === undefined) {
        throw new Error(
          "attention_delivery_completion_failed_closed: durable completion record missing after append",
        );
      }
      return this.requireFingerprint(state.complete, fingerprint);
    });
  }

  private requireFingerprint(
    record: StoredAttentionDelivery,
    fingerprint: string,
  ): StoredAttentionDelivery {
    if (record.result.fingerprint !== fingerprint) {
      throw new Error("Human-attention delivery idempotency conflict for request content/fingerprint");
    }
    return record;
  }

  private async readStreamState(idempotencyKey: string): Promise<{
    readonly streamLength: number;
    readonly reserve: { readonly fingerprint: string } | undefined;
    readonly complete: StoredAttentionDelivery | undefined;
  }> {
    const entries = await this.eventStore.readStream(idempotencyKey);
    let reserve: { fingerprint: string } | undefined;
    let complete: StoredAttentionDelivery | undefined;
    for (const entry of entries) {
      const event = entry.event;
      if (event.type === "tracker.human-attention.reserve") {
        const fp = event.data.fingerprint;
        if (typeof fp === "string") reserve = { fingerprint: fp };
      }
      if (event.type === "tracker.human-attention.store") {
        const result = event.data.result as AttentionDeliveryResult | undefined;
        const pending = event.data.pending as StoredAttentionDelivery["pending"] | undefined;
        if (
          result !== undefined &&
          pending !== undefined &&
          typeof pending.workspaceId === "string" &&
          pending.workspaceId.length > 0
        ) {
          complete = { result, pending };
        }
      }
    }
    return { streamLength: entries.length, reserve, complete };
  }
}

/**
 * In-memory store for unit tests only — never a production default.
 * `durableSingleFlight` is false: process-local mutex is **not** durable
 * exactly-once across process/restart races.
 */
export class InMemoryAttentionDeliveryStore implements AttentionDeliveryStore {
  public readonly durableSingleFlight = false as const;
  public readonly entries = new Map<string, StoredAttentionDelivery>();
  private readonly exclusive = new ProcessLocalKeyExclusive();

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
  public async attempt(
    _input: AttentionDeliveryAttemptInput,
  ): Promise<{ ok: boolean; unsupported?: boolean; detail?: string }> {
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
