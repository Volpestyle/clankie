/**
 * The seat's outbox ([ADR 0152](../../../../docs/adr/0152-a-harness-takes-the-operator-seat.md)).
 *
 * Goals, self-wakes, herdr completion watches, and rooms handing work to the
 * head all queue turns into the operator conversation. While a harness sits in
 * the seat, those turns come here instead of the pi lane, and the seat's
 * stdio bridge long-polls them out and pushes each one into the session as a
 * channel event. A bound head is a head that is polling: the bridge asks again
 * the moment a poll returns, so a seat that has gone quiet for longer than the
 * re-poll grace is gone, and what it never took goes back to pi.
 */
import { randomUUID } from "node:crypto";
import {
  headSeatDeliveryStage,
  type HireRecoveryEvidence,
  type DeliveryStage,
  type OperatorSeatEvent,
  type OperatorSeatEventKind,
} from "@clankie/protocol";

import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";

/** Covers the millisecond gap between a poll returning and the live bridge asking again. */
const BOUND_GRACE_MS = 2_000;
/** How long an escalation waits for the seat's `reply` before the run settles unanswered. */
const REPLY_TIMEOUT_MS = 10 * 60_000;

/** The service lost its reply waiter; this says nothing about the native turn. */
export class SeatLinkInterruptedError extends Error {
  public constructor(cause?: unknown) {
    super(
      "The service link was interrupted. The seat may still be working, but its reply target is gone. Check the seat before sending the request again.",
      cause === undefined ? undefined : { cause },
    );
  }
}

export type SeatDelivery = { readonly deliveryStage?: DeliveryStage } & (
  | { readonly outcome: "delivered" }
  | { readonly outcome: "replied"; readonly text: string }
  | { readonly outcome: "unconfirmed"; readonly messageId: string; readonly detail: string }
  | { readonly outcome: "unbound" }
  | { readonly outcome: "aborted" }
);

export interface SeatDeliveryInput {
  readonly delivery?: "steer" | "queue";
  /** Host-owned watch identity. Preparation must persist before any native take. */
  readonly original?: {
    readonly messageId: string;
    prepare(receipt: { messageId: string; fingerprint: string; recipientBinding?: string }): void;
  };
  /** Queue admission or the channel's exact take acknowledgment. */
  readonly onAdmitted?: (state: "started" | "steered" | "queued") => void;
  readonly kind: OperatorSeatEventKind;
  readonly conversationId: string;
  readonly source: string;
  readonly content: string;
  /** An escalation holds its run open for the seat's answer; a wake or watch settles once taken. */
  readonly wantsReply: boolean;
  /** A supplied native binding pins every source to its original recipient. */
  readonly recipientBinding?: string;
  readonly signal?: AbortSignal;
}

type PollFinishSource = "wake" | "timeout" | "abort" | "supersede" | "close";

interface ParkedPoller {
  readonly recipientBinding?: string;
  finish(events: OperatorSeatEvent[], source: PollFinishSource): void;
}

interface Pending {
  readonly holdUntilTurnEnd: boolean;
  readonly exactRecipient: boolean;
  readonly onAdmitted?: SeatDeliveryInput["onAdmitted"];
  admission?: "started" | "steered";
  readonly event: OperatorSeatEvent;
  readonly wantsReply: boolean;
  readonly recipientBinding?: string;
  taken: boolean;
  acknowledged: boolean;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  settle(outcome: SeatDelivery | { readonly outcome: "interrupted" }): void;
}

export class SeatOutbox {
  private readonly queued: Pending[] = [];
  private readonly inFlight: Pending[] = [];
  private readonly awaitingReply = new Map<string, Pending>();
  private readonly pollers = new Set<ParkedPoller>();
  private readonly boundGraceMs: number;
  private readonly replyTimeoutMs: number;
  private readonly now: () => number;
  private readonly fence: DeliveryFence;
  private readonly delivered: DeliveryFence;
  private readonly active = new Set<string>();
  private lastPollAt: number | undefined;
  private lastPollBinding: string | undefined;
  private closed = false;
  private turnActive = false;
  private turnSessionId: string | undefined;

  /** Authenticated seat-sync activity; an unrelated session cannot release a hold. */
  public observeTurn(sessionId: string, activity: "responding" | "waiting", onlyIfUnknown = false): boolean {
    if (this.closed) return false;
    if (onlyIfUnknown && this.turnSessionId !== undefined) return false;
    if (activity === "waiting" && this.turnSessionId !== undefined && this.turnSessionId !== sessionId)
      return false;
    this.turnSessionId = sessionId;
    this.turnActive = activity === "responding";
    if (!this.turnActive) this.wakePoller();
    return true;
  }

  public constructor(
    options: {
      readonly uncertaintyPath?: string;
      readonly boundGraceMs?: number;
      readonly replyTimeoutMs?: number;
      readonly now?: () => number;
    } = {},
  ) {
    this.fence = new DeliveryFence(options.uncertaintyPath);
    this.delivered = new DeliveryFence(
      options.uncertaintyPath === undefined ? undefined : `${options.uncertaintyPath}.delivered`,
    );
    this.boundGraceMs = options.boundGraceMs ?? BOUND_GRACE_MS;
    this.replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Read the exact original from the live mailbox or its retained acknowledgment. */
  public recoveryReceipt(id: string) {
    if (this.active.has(id)) throw new Error("Original channel event is still active");
    const originals = this.fence.all().filter(([, receipt]) => receipt.messageId === id);
    const acknowledgments = this.delivered.all().filter(([, receipt]) => receipt.messageId === id);
    if (originals.length > 1 || acknowledgments.length > 1)
      throw new Error("Original channel receipt is ambiguous");
    const pending = originals[0]?.[1],
      acknowledged = acknowledgments[0]?.[1];
    if (
      pending &&
      acknowledged &&
      (pending.fingerprint !== acknowledged.fingerprint ||
        pending.sessionId !== acknowledged.sessionId ||
        (pending.settlement &&
          acknowledged.settlement &&
          JSON.stringify(pending.settlement) !== JSON.stringify(acknowledged.settlement)))
    )
      throw new Error("Original channel receipt conflicts with its acknowledgment");
    return pending ?? acknowledged;
  }
  public recoveryAcknowledged(id: string): boolean {
    const original = this.recoveryReceipt(id);
    const acknowledged = this.delivered.all().find(([, receipt]) => receipt.messageId === id)?.[1];
    return (
      !!original &&
      !!acknowledged &&
      original.fingerprint === acknowledged.fingerprint &&
      original.sessionId === acknowledged.sessionId
    );
  }
  public settleRecoveredDelivery(id: string, evidence: HireRecoveryEvidence): void {
    if (this.active.has(id)) throw new Error("Original channel event is still active");
    const store = this.fence.all().some(([, receipt]) => receipt.messageId === id)
      ? this.fence
      : this.delivered;
    const original = store.all().find(([, receipt]) => receipt.messageId === id);
    if (!original) throw new Error("Original channel event is missing");
    if (original[1].settlement) {
      if (JSON.stringify(original[1].settlement) !== JSON.stringify(evidence))
        throw new Error("Original recovery evidence changed");
      return;
    }
    store.settleRecovery(original[0], id, evidence);
  }

  public uncertain(): boolean {
    return this.fence.entries().some(([id]) => !this.active.has(id));
  }

  /** Exact acknowledged content, retained for read-only reconciliation after restart. */
  public receipt(content: string): SeatDelivery | undefined {
    const fingerprint = deliveryFingerprint(content);
    const match = this.delivered.all().find(([, receipt]) => receipt.fingerprint === fingerprint);
    return match ? { outcome: "delivered", deliveryStage: "delivered" } : undefined;
  }

  /** A seat is bound while a poller is parked, or a parked poll resolved within the grace. */
  public bound(): boolean {
    return !this.closed && (this.pollers.size > 0 || this.remainingGraceMs() > 0);
  }

  /** Routing observation only: the existing poll carries the native binding. */
  public boundTo(binding: string): boolean {
    return (
      !this.closed &&
      ([...this.pollers].some((poller) => poller.recipientBinding === binding) ||
        (this.remainingGraceMs() > 0 && this.lastPollBinding === binding))
    );
  }

  /** The current proven poll binding, including an explicitly unbound legacy poll. */
  public recipientBinding(): string | undefined {
    const current = [...this.pollers][0];
    return current === undefined ? this.lastPollBinding : current.recipientBinding;
  }

  /**
   * Hand one turn to the seat. Resolves `unbound` at once when no seat is
   * polling and the grace has lapsed, so the caller runs the pi lane instead;
   * `delivered` when the bridge takes the turn and comes back for more (or,
   * for an escalation, when the reply window lapses); `replied` with the
   * seat's answer; `aborted` when the operator cancels the run. Closing the
   * mailbox rejects with SeatLinkInterruptedError, never successful completion.
   */
  public deliver(input: SeatDeliveryInput): Promise<SeatDelivery> {
    if (this.closed) return Promise.reject(new SeatLinkInterruptedError());
    const unresolved = this.fence.entries().find(([id]) => !this.active.has(id));
    if (
      unresolved !== undefined &&
      input.source === "peer" &&
      unresolved[1].fingerprint !== deliveryFingerprint(input.content)
    )
      return Promise.resolve({ outcome: "unbound", deliveryStage: "unavailable" });
    if (unresolved !== undefined)
      return Promise.resolve({
        outcome: "unconfirmed",
        deliveryStage: "uncertain",
        messageId: unresolved[1].messageId,
        detail: "An earlier delivery is uncertain; its exact receipt must be reconciled before any retry.",
      });
    if (!this.bound()) return Promise.resolve({ outcome: "unbound", deliveryStage: "unavailable" });
    if (input.signal?.aborted === true)
      return Promise.resolve({ outcome: "aborted", deliveryStage: "expired" });
    return new Promise((resolve, reject) => {
      const event: OperatorSeatEvent = {
        schemaVersion: 1,
        id: input.original?.messageId ?? `seat-${randomUUID()}`,
        kind: input.kind,
        conversationId: input.conversationId,
        source: input.source,
        content: input.content,
        createdAt: new Date(this.now()).toISOString(),
      };
      input.original?.prepare({
        messageId: event.id,
        fingerprint: deliveryFingerprint(input.content),
        ...(input.recipientBinding === undefined ? {} : { recipientBinding: input.recipientBinding }),
      });
      this.fence.begin(event.id, {
        messageId: event.id,
        fingerprint: deliveryFingerprint(input.content),
        ...(input.original === undefined
          ? input.recipientBinding === undefined
            ? {}
            : { sessionId: input.recipientBinding }
          : // Empty is an exact absent binding, distinct from legacy wildcard receipts.
            { sessionId: input.recipientBinding ?? "" }),
      });
      this.active.add(event.id);
      const onAbort = (): void =>
        pending.settle(
          pending.acknowledged
            ? { outcome: "delivered" }
            : pending.taken
              ? {
                  outcome: "unconfirmed",
                  messageId: event.id,
                  detail: "The bridge took the event before cancellation; delivery may still land.",
                }
              : { outcome: "aborted" },
        );
      const pending: Pending = {
        holdUntilTurnEnd: input.delivery === "queue",
        exactRecipient: input.original !== undefined,
        ...(input.onAdmitted === undefined ? {} : { onAdmitted: input.onAdmitted }),
        event,
        wantsReply: input.wantsReply,
        ...(input.recipientBinding === undefined ? {} : { recipientBinding: input.recipientBinding }),
        taken: false,
        acknowledged: false,
        settled: false,
        settle: (outcome) => {
          if (pending.settled) return;
          pending.settled = true;
          this.active.delete(event.id);
          if (
            outcome.outcome !== "unconfirmed" &&
            !(outcome.outcome === "interrupted" && pending.taken && !pending.acknowledged)
          ) {
            try {
              this.fence.reconcile(event.id, event.id);
            } catch (error) {
              // A failed receipt write must not convert shutdown into successful
              // run completion. The fence retains its original unresolved record.
              if (outcome.outcome !== "interrupted")
                outcome = {
                  outcome: "unconfirmed",
                  messageId: event.id,
                  detail: `Receipt persistence failed: ${String(error)}`,
                };
            }
          }
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          input.signal?.removeEventListener("abort", onAbort);
          const queuedIndex = this.queued.indexOf(pending);
          if (queuedIndex >= 0) this.queued.splice(queuedIndex, 1);
          const flightIndex = this.inFlight.indexOf(pending);
          if (flightIndex >= 0) this.inFlight.splice(flightIndex, 1);
          this.awaitingReply.delete(event.id);
          if (outcome.outcome === "interrupted") reject(new SeatLinkInterruptedError());
          else resolve({ ...outcome, deliveryStage: headSeatDeliveryStage(outcome.outcome) });
        },
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const waitForReceiver = (): void => {
        const waitMs = this.pollers.size > 0 ? this.boundGraceMs : this.remainingGraceMs();
        pending.timer = setTimeout(() => {
          if (pending.taken || pending.settled) return;
          // Held messages remain admitted while their bridge is polling. A
          // definite detach retains the existing pre-take fallback boundary.
          if (pending.holdUntilTurnEnd && this.bound()) waitForReceiver();
          else pending.settle({ outcome: "unbound" });
        }, waitMs);
        pending.timer.unref?.();
      };
      waitForReceiver();
      this.queued.push(pending);
      if (pending.holdUntilTurnEnd && this.turnActive) pending.onAdmitted?.("queued");
      this.wakePoller();
    });
  }

  /** The bridge's long poll: ack in-flight turns, then everything queued, or park. */
  public poll(waitMs: number, signal?: AbortSignal, recipientBinding?: string): Promise<OperatorSeatEvent[]> {
    if (this.closed) return Promise.resolve([]);
    this.ackInFlight(recipientBinding);
    const ready = this.take(recipientBinding);
    if (ready.length > 0 || waitMs <= 0 || signal?.aborted === true) return Promise.resolve(ready);
    return new Promise((resolve) => {
      let finished = false;
      const poller: ParkedPoller = {
        ...(recipientBinding === undefined ? {} : { recipientBinding }),
        finish: (events, source) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.pollers.delete(poller);
          if (source === "timeout" || source === "wake") {
            this.lastPollAt = this.now();
            this.lastPollBinding = recipientBinding;
          }
          resolve(events);
        },
      };
      const onAbort = (): void => poller.finish([], "abort");
      const timer = setTimeout(() => poller.finish([], "timeout"), waitMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      // Each poller removes itself as it settles; a set never revisits a yielded entry.
      for (const older of this.pollers) older.finish([], "supersede");
      this.pollers.add(poller);
    });
  }

  /** The seat's answer to an escalation. False when nothing is waiting on that id. */
  public reply(eventId: string, text: string, recipientBinding?: string): boolean {
    const pending =
      this.awaitingReply.get(eventId) ?? this.inFlight.find((candidate) => candidate.event.id === eventId);
    if (pending === undefined) {
      // A late reply proves receipt of the original event, but no live waiter
      // remains to publish its text. Never report that this answer was sent.
      const original = this.fence.pending(eventId);
      if (original?.sessionId !== undefined && original.sessionId !== (recipientBinding ?? "")) return false;
      this.fence.reconcile(eventId, eventId);
      return false;
    }
    if (pending.exactRecipient) {
      if (!this.matchesRecipient(pending, recipientBinding)) return false;
      if (!pending.acknowledged) this.ackPending(pending);
    }
    pending.settle({ outcome: "replied", text });
    return true;
  }

  /** Exact bridge receipt, also usable after a timeout or service restart. */
  public acknowledge(eventId: string, recipientBinding?: string): boolean {
    const pending = this.inFlight.find((candidate) => candidate.event.id === eventId);
    if (pending === undefined) {
      const original = this.fence.pending(eventId);
      if (!original) {
        const delivered = this.delivered.all().find(([, receipt]) => receipt.messageId === eventId)?.[1];
        return (
          delivered?.messageId === eventId &&
          (delivered.sessionId === undefined || delivered.sessionId === (recipientBinding ?? ""))
        );
      }
      if (original.sessionId !== undefined && original.sessionId !== (recipientBinding ?? "")) return false;
      if (!this.delivered.pending(eventId)) this.delivered.begin(eventId, original);
      return this.fence.reconcile(eventId, eventId);
    }
    if (!this.matchesRecipient(pending, recipientBinding)) return false;
    this.ackPending(pending);
    return true;
  }

  public close(): void {
    this.closed = true;
    for (const pending of [...this.queued, ...this.inFlight, ...this.awaitingReply.values()]) {
      // Closing the service's waiter cannot finish an independent native turn.
      // Preserve the fence when take happened without an exact receipt.
      pending.settle({ outcome: "interrupted" });
    }
    // Each poller removes itself as it settles; a set never revisits a yielded entry.
    for (const poller of this.pollers) poller.finish([], "close");
  }

  private remainingGraceMs(): number {
    if (this.lastPollAt === undefined) return 0;
    const elapsed = this.now() - this.lastPollAt;
    return elapsed < this.boundGraceMs ? this.boundGraceMs - elapsed : 0;
  }

  /** The bridge came back: previous takes are delivered, escalations start their reply window. */
  private ackInFlight(recipientBinding?: string): void {
    const acked = this.inFlight.filter((pending) => this.matchesRecipient(pending, recipientBinding));
    for (const pending of acked) this.ackPending(pending);
  }

  private ackPending(pending: Pending): void {
    pending.acknowledged = true;
    const index = this.inFlight.indexOf(pending);
    if (index >= 0) this.inFlight.splice(index, 1);
    try {
      if (!this.delivered.pending(pending.event.id))
        this.delivered.begin(pending.event.id, {
          messageId: pending.event.id,
          fingerprint: deliveryFingerprint(pending.event.content),
          ...(pending.exactRecipient
            ? { sessionId: pending.recipientBinding ?? "" }
            : pending.recipientBinding === undefined
              ? {}
              : { sessionId: pending.recipientBinding }),
        });
      this.fence.reconcile(pending.event.id, pending.event.id);
    } catch (error) {
      pending.settle({
        outcome: "unconfirmed",
        messageId: pending.event.id,
        detail: `Receipt persistence failed: ${String(error)}`,
      });
      throw error;
    }
    if (pending.admission !== undefined) pending.onAdmitted?.(pending.admission);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (!pending.wantsReply) {
      pending.settle({ outcome: "delivered" });
      return;
    }
    this.awaitingReply.set(pending.event.id, pending);
    pending.timer = setTimeout(() => pending.settle({ outcome: "delivered" }), this.replyTimeoutMs);
    pending.timer.unref?.();
  }

  private matchesRecipient(pending: Pending, recipientBinding?: string): boolean {
    return pending.exactRecipient
      ? pending.recipientBinding === recipientBinding
      : pending.recipientBinding === undefined
        ? pending.event.source !== "peer"
        : pending.recipientBinding === recipientBinding;
  }

  private take(recipientBinding?: string): OperatorSeatEvent[] {
    const taken = [...this.queued];
    const events: OperatorSeatEvent[] = [];
    for (const pending of taken) {
      if (!this.matchesRecipient(pending, recipientBinding)) {
        pending.settle({ outcome: "unbound" });
        continue;
      }
      if (pending.holdUntilTurnEnd && this.turnActive) continue;
      this.queued.splice(this.queued.indexOf(pending), 1);
      pending.admission = this.turnActive ? "steered" : "started";
      this.turnActive = true;
      pending.taken = true;
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      this.inFlight.push(pending);
      pending.timer = setTimeout(
        () =>
          pending.settle({
            outcome: "unconfirmed",
            messageId: pending.event.id,
            detail:
              "The bridge took the event but did not acknowledge it; inspect the seat before resending.",
          }),
        this.boundGraceMs,
      );
      pending.timer.unref?.();
      events.push(pending.event);
    }
    if (events.length > 0) this.lastPollAt = this.now();
    return events;
  }

  private wakePoller(): void {
    const [first] = this.pollers;
    if (first === undefined) return;
    const ready = this.take(first.recipientBinding);
    if (ready.length > 0) first.finish(ready, "wake");
  }
}
