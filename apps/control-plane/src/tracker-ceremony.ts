import {
  createConnectorActionClassifier,
  createNarrativeWritePolicy,
  decideAction,
  projectCaptainCeremony,
  type CompiledDoctrine,
  type NarrativeWritePolicyEvaluator,
} from "@clankie/doctrine";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { OptimisticConcurrencyError, type EventStore, type ProjectionEventStore } from "@clankie/event-store";
import { type DomainEvent, type HumanAttentionResponse } from "@clankie/protocol";
import {
  correlateAgentSessionToAttention,
  deliverHumanAttention,
  responseFromVerifiedEvent,
  validateIssueDraft,
  type AttentionDeliveryAdapter,
  type AttentionDeliveryAttemptInput,
  type AttentionDeliveryClaimContext,
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
  return typeof candidate.appendExpected === "function" && typeof candidate.readStream === "function";
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
  correlate(raw: unknown): Promise<HumanAttentionResponse | { ok: false; reason: string }>;
}

/**
 * Fail-closed policy gateway: uses doctrine decideAction. Unknown tracker
 * actions deny by default (no default-allow).
 */
export class DoctrineAttentionPolicy implements TrackerPolicyGateway {
  private readonly doctrine: CompiledDoctrine;
  private readonly narrativePolicy: NarrativeWritePolicyEvaluator;
  private readonly classify = createConnectorActionClassifier([
    { action: "tracker.comment.create", riskClass: "narrative-write", narrativeKind: "issue-comment" },
  ]);

  public constructor(doctrine: CompiledDoctrine) {
    this.doctrine = doctrine;
    this.narrativePolicy = createNarrativeWritePolicy(doctrine);
  }

  public async authorize(request: TrackerWriteRequest): Promise<{
    effect: "allow" | "deny" | "require_approval";
    reason: string;
    obligations?: readonly string[];
  }> {
    const actionRequest = {
      id: request.idempotencyKey,
      principal: { kind: "captain", id: "tracker-ceremony" },
      action: request.action,
      resource: { type: "tracker-issue", id: request.ref.issueId },
      context: {
        missionId: request.missionId,
        risk: "low",
        profileHash: this.doctrine.profileHash,
      },
    } as const;
    const classification = this.classify(request.action);
    const decision =
      classification?.riskClass === "narrative-write"
        ? this.narrativePolicy.decide({
            request: actionRequest,
            classification,
            correlationId: request.correlationId ?? "",
            content: request.content ?? "",
          })
        : decideAction(this.doctrine, actionRequest, classification);
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

function attentionReserveEventId(requestId: string): string {
  return `tracker.human-attention.reserve:${requestId}`;
}

function attentionCompleteEventId(requestId: string): string {
  return `tracker.human-attention.store:${requestId}`;
}

const MAX_STREAM_CLAIM_ATTEMPTS = 16;

/**
 * Durable attention store on the **real mission stream** (ProjectionEventStore).
 *
 * Contract (VUH-844 durable idempotency):
 * 1. Stream id = real `missionId` — never a synthetic attention-request stream.
 * 2. Atomic **reserve** via `appendExpected` at the mission stream's **current**
 *    revision; event data carries `requestId` + `fingerprint`. Concurrent
 *    contenders re-read the mission stream to find the claim (or retry when
 *    the stream advanced for unrelated events).
 * 3. Factory / adapter work after reserve (claim-resume after crash uses the
 *    same stable per-action provider tokens).
 * 4. Deterministic **complete** event id on the same mission stream.
 * Process-local mutex is assist-only — not durable exactly-once by itself.
 * Generic EventStore without appendExpected is rejected (fail closed).
 */
export class EventStoreAttentionDeliveryStore implements AttentionDeliveryStore {
  public readonly durableSingleFlight = true as const;
  private readonly eventStore: ProjectionEventStore;
  private readonly options: {
    readonly profileHash: string;
    readonly idFactory: () => string;
    readonly clock: () => Date;
    readonly claimLeaseMs: number;
    readonly claimPollMs: number;
  };
  /** Optional same-process assist only — durability is mission-stream reserve/complete. */
  private readonly processLocal = new ProcessLocalKeyExclusive();
  private readonly storeInstanceId = randomUUID();

  public constructor(
    eventStore: EventStore,
    options: {
      readonly profileHash: string;
      readonly idFactory: () => string;
      readonly clock: () => Date;
      readonly claimLeaseMs?: number;
      readonly claimPollMs?: number;
    },
  ) {
    if (!isProjectionEventStore(eventStore)) {
      throw new Error(
        "attention_delivery_store_requires_projection_event_store: EventStore must support appendExpected/readStream for durable single-flight",
      );
    }
    this.eventStore = eventStore;
    this.options = {
      ...options,
      claimLeaseMs: options.claimLeaseMs ?? 30_000,
      claimPollMs: options.claimPollMs ?? 10,
    };
  }

  public async get(requestId: string): Promise<StoredAttentionDelivery | undefined> {
    const entries = await this.eventStore.readAll();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const event = entries[index]?.event;
      if (event?.type !== "tracker.human-attention.store") continue;
      if (event.data.requestId !== requestId) continue;
      return this.completeFromEvent(event);
    }
    return undefined;
  }

  public async runExclusive(
    context: AttentionDeliveryClaimContext,
    factory: () => Promise<StoredAttentionDelivery>,
  ): Promise<StoredAttentionDelivery> {
    const { missionId, requestId, fingerprint } = context;
    const ownerId = `${this.storeInstanceId}:${this.options.idFactory()}`;
    // Process-local assist only; cross-process correctness is mission-stream claim.
    return this.processLocal.run(`${missionId}:${requestId}`, async () => {
      for (;;) {
        const claim = await this.ensureOwnedReservation(context, ownerId);
        if (claim.complete !== undefined) {
          return this.requireFingerprint(claim.complete, fingerprint);
        }
        if (claim.reserve.fingerprint !== fingerprint) {
          throw new Error("Human-attention delivery idempotency conflict for request content/fingerprint");
        }
        if (claim.reserve.ownerId !== ownerId) {
          const waitMs = Math.max(
            1,
            Math.min(
              this.options.claimPollMs,
              Date.parse(claim.reserve.leaseExpiresAt) - this.options.clock().getTime(),
            ),
          );
          await sleep(waitMs);
          continue;
        }

        // Claim-resume after lease expiry: re-run with stable provider tokens.
        const record = await factory();
        if (record.result.fingerprint !== fingerprint) {
          throw new Error("Human-attention delivery factory fingerprint mismatch");
        }
        return this.ensureCompleted(context, record);
      }
    });
  }

  private async ensureOwnedReservation(
    context: AttentionDeliveryClaimContext,
    ownerId: string,
  ): Promise<{
    readonly reserve: {
      readonly fingerprint: string;
      readonly ownerId: string;
      readonly leaseExpiresAt: string;
    };
    readonly complete: StoredAttentionDelivery | undefined;
  }> {
    const { missionId, requestId, correlationId, fingerprint } = context;
    for (let attempt = 0; attempt < MAX_STREAM_CLAIM_ATTEMPTS; attempt += 1) {
      const state = await this.readMissionClaim(missionId, requestId);
      if (state.complete !== undefined) {
        return {
          complete: state.complete,
          reserve: state.reserve ?? this.syntheticReserve(fingerprint, ownerId),
        };
      }
      const nowMs = this.options.clock().getTime();
      if (state.reserve !== undefined && Date.parse(state.reserve.leaseExpiresAt) > nowMs) {
        return { complete: undefined, reserve: state.reserve };
      }
      const leaseExpiresAt = new Date(nowMs + this.options.claimLeaseMs).toISOString();
      try {
        await this.eventStore.appendExpected(
          {
            id: `${attentionReserveEventId(requestId)}:${ownerId}`,
            occurredAt: this.options.clock().toISOString(),
            missionId,
            correlationId,
            profileHash: this.options.profileHash,
            type: "tracker.human-attention.reserve",
            data: {
              requestId,
              fingerprint,
              ownerId,
              leaseExpiresAt,
              phase: "reserved",
            },
          },
          { streamId: missionId, expectedRevision: state.streamLength },
        );
      } catch (error) {
        if (!(error instanceof OptimisticConcurrencyError)) throw error;
        // Stream advanced (contender or unrelated mission event) — re-read claim.
        continue;
      }
      // Re-read after successful reserve so we observe our own claim.
      const after = await this.readMissionClaim(missionId, requestId);
      if (after.reserve !== undefined) return { complete: after.complete, reserve: after.reserve };
    }
    throw new Error(
      "attention_delivery_reservation_failed_closed: could not reserve or observe a durable claim on the mission stream",
    );
  }

  private syntheticReserve(fingerprint: string, ownerId: string) {
    return { fingerprint, ownerId, leaseExpiresAt: new Date(0).toISOString() };
  }

  private async ensureCompleted(
    context: AttentionDeliveryClaimContext,
    record: StoredAttentionDelivery,
  ): Promise<StoredAttentionDelivery> {
    const { missionId, requestId, fingerprint } = context;
    const completeEvent: DomainEvent = {
      id: attentionCompleteEventId(requestId),
      occurredAt: this.options.clock().toISOString(),
      missionId,
      correlationId: record.result.correlationId,
      profileHash: this.options.profileHash,
      type: "tracker.human-attention.store",
      data: {
        requestId,
        fingerprint,
        result: record.result,
        pending: record.pending,
        phase: "completed",
      },
    };

    for (let attempt = 0; attempt < MAX_STREAM_CLAIM_ATTEMPTS; attempt += 1) {
      const state = await this.readMissionClaim(missionId, requestId);
      if (state.complete !== undefined) {
        return this.requireFingerprint(state.complete, fingerprint);
      }
      try {
        await this.eventStore.appendExpected(completeEvent, {
          streamId: missionId,
          expectedRevision: state.streamLength,
        });
      } catch (error) {
        const afterError = await this.readMissionClaim(missionId, requestId);
        if (afterError.complete !== undefined) {
          return this.requireFingerprint(afterError.complete, fingerprint);
        }
        if (!(error instanceof OptimisticConcurrencyError)) throw error;
        continue;
      }
      const after = await this.readMissionClaim(missionId, requestId);
      if (after.complete !== undefined) {
        return this.requireFingerprint(after.complete, fingerprint);
      }
    }
    throw new Error(
      "attention_delivery_completion_failed_closed: durable completion record missing on mission stream",
    );
  }

  private requireFingerprint(record: StoredAttentionDelivery, fingerprint: string): StoredAttentionDelivery {
    if (record.result.fingerprint !== fingerprint) {
      throw new Error("Human-attention delivery idempotency conflict for request content/fingerprint");
    }
    return record;
  }

  private completeFromEvent(event: DomainEvent): StoredAttentionDelivery | undefined {
    const result = event.data.result as AttentionDeliveryResult | undefined;
    const pending = event.data.pending as StoredAttentionDelivery["pending"] | undefined;
    if (
      result === undefined ||
      pending === undefined ||
      typeof pending.workspaceId !== "string" ||
      pending.workspaceId.length === 0
    ) {
      return undefined;
    }
    return { result, pending };
  }

  private async readMissionClaim(
    missionId: string,
    requestId: string,
  ): Promise<{
    readonly streamLength: number;
    readonly reserve:
      | {
          readonly fingerprint: string;
          readonly ownerId: string;
          readonly leaseExpiresAt: string;
        }
      | undefined;
    readonly complete: StoredAttentionDelivery | undefined;
  }> {
    const entries = await this.eventStore.readStream(missionId);
    let reserve: { fingerprint: string; ownerId: string; leaseExpiresAt: string } | undefined;
    let complete: StoredAttentionDelivery | undefined;
    for (const entry of entries) {
      const event = entry.event;
      if (event.data.requestId !== requestId) continue;
      if (event.type === "tracker.human-attention.reserve") {
        const fp = event.data.fingerprint;
        const ownerId = event.data.ownerId;
        const leaseExpiresAt = event.data.leaseExpiresAt;
        if (typeof fp === "string" && typeof ownerId === "string" && typeof leaseExpiresAt === "string") {
          reserve = { fingerprint: fp, ownerId, leaseExpiresAt };
        }
      }
      if (event.type === "tracker.human-attention.store") {
        const parsed = this.completeFromEvent(event);
        if (parsed !== undefined) complete = parsed;
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

  public async get(requestId: string): Promise<StoredAttentionDelivery | undefined> {
    return this.entries.get(requestId);
  }

  public async runExclusive(
    context: AttentionDeliveryClaimContext,
    factory: () => Promise<StoredAttentionDelivery>,
  ): Promise<StoredAttentionDelivery> {
    return this.exclusive.run(context.requestId, async () => {
      const prior = this.entries.get(context.requestId);
      if (prior !== undefined) {
        if (prior.result.fingerprint !== context.fingerprint) {
          throw new Error("Human-attention delivery idempotency conflict for request content/fingerprint");
        }
        return prior;
      }
      const record = await factory();
      this.entries.set(context.requestId, record);
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
      const stored = await input.store.get(parsed.requestId);
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
      if (event.missionId !== stored.pending.request.missionId) {
        return { ok: false as const, reason: "event_mission_mismatch" };
      }
      if (event.profileHash !== input.doctrine.profileHash) {
        return { ok: false as const, reason: "event_profile_mismatch" };
      }
      if (event.correlationId !== stored.pending.request.correlationId) {
        return { ok: false as const, reason: "event_correlation_mismatch" };
      }
      const binding = input.bindingResolver.resolve(stored.pending.workspaceId);
      if (binding === undefined) {
        return { ok: false as const, reason: "workspace_binding_unavailable" };
      }
      const authority = responseFromVerifiedEvent(event, stored.pending, binding);
      if (authority === undefined) {
        return { ok: false as const, reason: "event_authority_missing" };
      }
      const response = correlateAgentSessionToAttention({
        pending: stored.pending,
        event,
        response: authority,
      });
      if (response === undefined) {
        return { ok: false as const, reason: "no_correlation" };
      }
      return response;
    },
  };
}
