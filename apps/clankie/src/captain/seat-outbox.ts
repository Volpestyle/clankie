/**
 * The seat's outbox ([ADR 0152](../../../../docs/adr/0152-a-harness-takes-the-operator-seat.md)).
 *
 * Goals, self-wakes, herdr completion watches, and rooms handing work to the
 * head all queue turns into the operator conversation. While a harness sits in
 * the seat, those turns come here instead of the pi lane, and the seat's
 * stdio bridge long-polls them out and pushes each one into the session as a
 * channel event. A bound head is a head that is polling: the bridge asks again
 * the moment a poll returns, so a seat that has gone quiet for longer than one
 * poll window is gone, and what it never took goes back to pi.
 */
import { randomUUID } from "node:crypto";
import type { OperatorSeatEvent, OperatorSeatEventKind } from "@clankie/protocol";

/** Longer than one bridge poll window (25s) plus a reconnect, shorter than a human notices. */
const BOUND_TTL_MS = 45_000;
/** How long an escalation waits for the seat's `reply` before the run settles unanswered. */
const REPLY_TIMEOUT_MS = 10 * 60_000;

export type SeatDelivery =
  | { readonly outcome: "delivered" }
  | { readonly outcome: "replied"; readonly text: string }
  | { readonly outcome: "unbound" }
  | { readonly outcome: "aborted" };

export interface SeatDeliveryInput {
  readonly kind: OperatorSeatEventKind;
  readonly conversationId: string;
  readonly source: string;
  readonly content: string;
  /** An escalation holds its run open for the seat's answer; a wake or watch settles once taken. */
  readonly wantsReply: boolean;
  readonly signal?: AbortSignal;
}

interface Pending {
  readonly event: OperatorSeatEvent;
  readonly wantsReply: boolean;
  taken: boolean;
  timer?: ReturnType<typeof setTimeout>;
  settle(outcome: SeatDelivery): void;
}

export class SeatOutbox {
  private readonly queued: Pending[] = [];
  private readonly awaitingReply = new Map<string, Pending>();
  private readonly pollers = new Set<(events: OperatorSeatEvent[]) => void>();
  private readonly boundTtlMs: number;
  private readonly replyTimeoutMs: number;
  private readonly now: () => number;
  private lastPollAt: number | undefined;

  public constructor(
    options: {
      readonly boundTtlMs?: number;
      readonly replyTimeoutMs?: number;
      readonly now?: () => number;
    } = {},
  ) {
    this.boundTtlMs = options.boundTtlMs ?? BOUND_TTL_MS;
    this.replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** A seat is bound while its bridge is polling, or polled within the last window. */
  public bound(): boolean {
    return (
      this.pollers.size > 0 ||
      (this.lastPollAt !== undefined && this.now() - this.lastPollAt < this.boundTtlMs)
    );
  }

  /**
   * Hand one turn to the seat. Resolves `unbound` at once when no seat is
   * polling, so the caller runs the pi lane instead; `delivered` when the bridge
   * takes it (or, for an escalation, when the reply window lapses); `replied`
   * with the seat's answer; `aborted` when the operator cancels the run.
   */
  public deliver(input: SeatDeliveryInput): Promise<SeatDelivery> {
    if (!this.bound()) return Promise.resolve({ outcome: "unbound" });
    if (input.signal?.aborted === true) return Promise.resolve({ outcome: "aborted" });
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
      const onAbort = (): void => pending.settle({ outcome: "aborted" });
      const pending: Pending = {
        event,
        wantsReply: input.wantsReply,
        taken: false,
        settle: (outcome) => {
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          input.signal?.removeEventListener("abort", onAbort);
          const index = this.queued.indexOf(pending);
          if (index >= 0) this.queued.splice(index, 1);
          this.awaitingReply.delete(event.id);
          resolve(outcome);
        },
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      // Nobody took it inside a bound window: the bridge died between polls.
      pending.timer = setTimeout(() => {
        if (!pending.taken) pending.settle({ outcome: "unbound" });
      }, this.boundTtlMs);
      pending.timer.unref?.();
      this.queued.push(pending);
      this.wakePoller();
    });
  }

  /** The bridge's long poll: everything queued, or park until something is. */
  public poll(waitMs: number, signal?: AbortSignal): Promise<OperatorSeatEvent[]> {
    this.lastPollAt = this.now();
    const ready = this.take();
    if (ready.length > 0 || waitMs <= 0 || signal?.aborted === true) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const done = (events: OperatorSeatEvent[]): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pollers.delete(done);
        this.lastPollAt = this.now();
        resolve(events);
      };
      const onAbort = (): void => done([]);
      const timer = setTimeout(() => done([]), waitMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pollers.add(done);
    });
  }

  /** The seat's answer to an escalation. False when nothing is waiting on that id. */
  public reply(eventId: string, text: string): boolean {
    const pending = this.awaitingReply.get(eventId);
    if (pending === undefined) return false;
    pending.settle({ outcome: "replied", text });
    return true;
  }

  public close(): void {
    for (const pending of [...this.queued, ...this.awaitingReply.values()]) {
      pending.settle({ outcome: "aborted" });
    }
    // Each poller removes itself as it settles; a set never revisits a yielded entry.
    for (const poller of this.pollers) poller([]);
  }

  private take(): OperatorSeatEvent[] {
    const taken = this.queued.splice(0);
    for (const pending of taken) {
      pending.taken = true;
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      if (!pending.wantsReply) {
        pending.settle({ outcome: "delivered" });
        continue;
      }
      this.awaitingReply.set(pending.event.id, pending);
      pending.timer = setTimeout(() => pending.settle({ outcome: "delivered" }), this.replyTimeoutMs);
      pending.timer.unref?.();
    }
    return taken.map((pending) => pending.event);
  }

  private wakePoller(): void {
    // One parked poll takes the whole batch; a second poller, if any, sees
    // whatever arrives next. The bridge only ever runs one.
    const [first] = this.pollers;
    if (first === undefined) return;
    first(this.take());
  }
}
