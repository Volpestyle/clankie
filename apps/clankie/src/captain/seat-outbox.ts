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
  type DeliveryStage,
  type OperatorSeatEvent,
  type OperatorSeatEventKind,
} from "@clankie/protocol";

import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";

/** Covers the millisecond gap between a poll returning and the live bridge asking again. */
const BOUND_GRACE_MS = 2_000;
/** How long an escalation waits for the seat's `reply` before the run settles unanswered. */
const REPLY_TIMEOUT_MS = 10 * 60_000;

export type SeatDelivery = { readonly deliveryStage?: DeliveryStage } & (
  | { readonly outcome: "delivered" }
  | { readonly outcome: "replied"; readonly text: string }
  | { readonly outcome: "unconfirmed"; readonly messageId: string; readonly detail: string }
  | { readonly outcome: "unbound" }
  | { readonly outcome: "aborted" }
);

export interface SeatDeliveryInput {
  readonly kind: OperatorSeatEventKind;
  readonly conversationId: string;
  readonly source: string;
  readonly content: string;
  /** An escalation holds its run open for the seat's answer; a wake or watch settles once taken. */
  readonly wantsReply: boolean;
  readonly signal?: AbortSignal;
}

type PollFinishSource = "wake" | "timeout" | "abort" | "supersede" | "close";

interface ParkedPoller {
  finish(events: OperatorSeatEvent[], source: PollFinishSource): void;
}

interface Pending {
  readonly event: OperatorSeatEvent;
  readonly wantsReply: boolean;
  taken: boolean;
  acknowledged: boolean;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  settle(outcome: SeatDelivery): void;
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
  private readonly active = new Set<string>();
  private lastPollAt: number | undefined;

  public constructor(
    options: {
      readonly uncertaintyPath?: string;
      readonly boundGraceMs?: number;
      readonly replyTimeoutMs?: number;
      readonly now?: () => number;
    } = {},
  ) {
    this.fence = new DeliveryFence(options.uncertaintyPath);
    this.boundGraceMs = options.boundGraceMs ?? BOUND_GRACE_MS;
    this.replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  public uncertain(): boolean {
    return this.fence.entries().some(([id]) => !this.active.has(id));
  }

  /** A seat is bound while a poller is parked, or a parked poll resolved within the grace. */
  public bound(): boolean {
    return this.pollers.size > 0 || this.remainingGraceMs() > 0;
  }

  /**
   * Hand one turn to the seat. Resolves `unbound` at once when no seat is
   * polling and the grace has lapsed, so the caller runs the pi lane instead;
   * `delivered` when the bridge takes the turn and comes back for more (or,
   * for an escalation, when the reply window lapses); `replied` with the
   * seat's answer; `aborted` when the operator cancels the run.
   */
  public deliver(input: SeatDeliveryInput): Promise<SeatDelivery> {
    const unresolved = this.fence.entries().find(([id]) => !this.active.has(id));
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
    return new Promise((resolve) => {
      const event: OperatorSeatEvent = {
        schemaVersion: 1,
        id: `seat-${randomUUID()}`,
        kind: input.kind,
        conversationId: input.conversationId,
        source: input.source,
        content: input.content,
        createdAt: new Date(this.now()).toISOString(),
      };
      this.fence.begin(event.id, { messageId: event.id, fingerprint: deliveryFingerprint(input.content) });
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
        event,
        wantsReply: input.wantsReply,
        taken: false,
        acknowledged: false,
        settled: false,
        settle: (outcome) => {
          if (pending.settled) return;
          pending.settled = true;
          this.active.delete(event.id);
          if (outcome.outcome !== "unconfirmed") {
            try {
              this.fence.reconcile(event.id, event.id);
            } catch (error) {
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
          resolve({ ...outcome, deliveryStage: headSeatDeliveryStage(outcome.outcome) });
        },
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const waitMs = this.pollers.size > 0 ? this.boundGraceMs : this.remainingGraceMs();
      pending.timer = setTimeout(() => {
        if (!pending.taken) pending.settle({ outcome: "unbound" });
      }, waitMs);
      pending.timer.unref?.();
      this.queued.push(pending);
      this.wakePoller();
    });
  }

  /** The bridge's long poll: ack in-flight turns, then everything queued, or park. */
  public poll(waitMs: number, signal?: AbortSignal): Promise<OperatorSeatEvent[]> {
    this.ackInFlight();
    const ready = this.take();
    if (ready.length > 0 || waitMs <= 0 || signal?.aborted === true) return Promise.resolve(ready);
    return new Promise((resolve) => {
      let finished = false;
      const poller: ParkedPoller = {
        finish: (events, source) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.pollers.delete(poller);
          if (source === "timeout" || source === "wake") this.lastPollAt = this.now();
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
  public reply(eventId: string, text: string): boolean {
    const pending =
      this.awaitingReply.get(eventId) ?? this.inFlight.find((candidate) => candidate.event.id === eventId);
    if (pending === undefined) return this.fence.reconcile(eventId, eventId);
    pending.settle({ outcome: "replied", text });
    return true;
  }

  /** Exact bridge receipt, also usable after a timeout or service restart. */
  public acknowledge(eventId: string): boolean {
    const pending = this.inFlight.find((candidate) => candidate.event.id === eventId);
    if (pending === undefined) return this.fence.reconcile(eventId, eventId);
    this.ackPending(pending);
    return true;
  }

  public close(): void {
    for (const pending of [...this.queued, ...this.inFlight, ...this.awaitingReply.values()]) {
      pending.settle(
        pending.acknowledged
          ? { outcome: "delivered" }
          : pending.taken
            ? {
                outcome: "unconfirmed",
                messageId: pending.event.id,
                detail: "The bridge took the event before the mailbox closed; delivery may still land.",
              }
            : { outcome: "aborted" },
      );
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
  private ackInFlight(): void {
    const acked = this.inFlight.splice(0);
    for (const pending of acked) this.ackPending(pending);
  }

  private ackPending(pending: Pending): void {
    pending.acknowledged = true;
    const index = this.inFlight.indexOf(pending);
    if (index >= 0) this.inFlight.splice(index, 1);
    try {
      this.fence.reconcile(pending.event.id, pending.event.id);
    } catch (error) {
      pending.settle({
        outcome: "unconfirmed",
        messageId: pending.event.id,
        detail: `Receipt persistence failed: ${String(error)}`,
      });
      throw error;
    }
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (!pending.wantsReply) {
      pending.settle({ outcome: "delivered" });
      return;
    }
    this.awaitingReply.set(pending.event.id, pending);
    pending.timer = setTimeout(() => pending.settle({ outcome: "delivered" }), this.replyTimeoutMs);
    pending.timer.unref?.();
  }

  private take(): OperatorSeatEvent[] {
    const taken = this.queued.splice(0);
    for (const pending of taken) {
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
    }
    if (taken.length > 0) this.lastPollAt = this.now();
    return taken.map((pending) => pending.event);
  }

  private wakePoller(): void {
    const [first] = this.pollers;
    if (first === undefined) return;
    first.finish(this.take(), "wake");
  }
}
