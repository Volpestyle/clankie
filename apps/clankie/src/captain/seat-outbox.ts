/**
 * The seat's outbox ([ADR 0152](../../../../docs/adr/0152-a-harness-takes-the-operator-seat.md)).
 *
 * Goals, self-wakes, herdr completion watches, and rooms handing work to the
 * head all queue turns into the operator conversation. While a harness sits in
 * the seat, those turns come here instead of the pi lane, and the seat's
 * stdio bridge long-polls them out and pushes each one into the session as a
 * channel event. A bound head is a head that is polling: the bridge asks again
 * the moment a poll returns, so a seat that has gone quiet for longer than the
 * re-poll grace is gone, and what it never took goes back to pi. A service
 * restart is the exception: a seat that was polling the previous process is
 * presumed to be reconnecting for a short grace, so the service does not run
 * the conversation on pi beside a live seat (2026-10-07).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type OperatorOwnerTurnOrigin,
  LEGACY_OPERATOR_SEAT_EVENT_KINDS,
  OperatorSeatCapabilitiesSchema,
  type OperatorSeatCapabilities,
  type OperatorSeatBridgeStatus,
  OPERATOR_CONVERSATION_TEXT_MAX,
  headSeatDeliveryStage,
  type HireRecoveryEvidence,
  type SeatDeliveryAbandonment,
  type DeliveryStage,
  type OperatorSeatEvent,
  type OperatorSeatEventKind,
} from "@clankie/protocol";

import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";

const CLIPPED_NOTE_MAX = 200;

/**
 * Keep every event inside the bridge's wire contract. A bridge drops a page it
 * cannot parse, which would leave its events taken but never shown (2026-10-06:
 * a 24k service handoff). The note says plainly what did not reach the seat.
 */
function fitSeatChannel(content: string): string {
  if (content.length <= OPERATOR_CONVERSATION_TEXT_MAX) return content;
  const kept = OPERATOR_CONVERSATION_TEXT_MAX - CLIPPED_NOTE_MAX;
  return `${content.slice(0, kept)}\n\n[Clipped to the seat channel's ${String(OPERATOR_CONVERSATION_TEXT_MAX)}-character limit: the last ${String(content.length - kept)} characters were not delivered.]`;
}

/** Covers the millisecond gap between a poll returning and the live bridge asking again. */
const BOUND_GRACE_MS = 2_000;
/**
 * A seat that polled the previous service this recently is presumed to be
 * reconnecting after the restart, not gone: its bridge retries every 5s and its
 * parked poll was at most 25s old when the old service stopped (2026-10-07).
 */
const RESTART_RECENT_SEAT_MS = 2 * 60_000;
/** How long after the service starts that presumed seat keeps its turns before pi takes them. */
const RESTART_RECONNECT_GRACE_MS = 45_000;
/** The presence heartbeat is rewritten at most this often. */
const PRESENCE_WRITE_INTERVAL_MS = 5_000;
/** How long an escalation waits for the seat's `reply` before the run settles unanswered. */
const REPLY_TIMEOUT_MS = 10 * 60_000;

/** Source of the service's own notice about an unresolved delivery; it never alerts about itself. */
export const SEAT_DELIVERY_ALERT_SOURCE = "seat-delivery-alert";

/** One delivery whose receipt never resolved; only its own resend is refused (VUH-1779). */
export interface UnresolvedSeatReceipt {
  readonly receiptId: string;
  /** Absent for receipts recorded before VUH-1779. */
  readonly beganAt?: number;
}

/** The seat's notice for one unresolved receipt: what happened and the owner settle command. */
export function seatDeliveryAlert(conversationId: string, receipt: UnresolvedSeatReceipt): string {
  const began =
    receipt.beganAt === undefined ? "at an unrecorded time" : new Date(receipt.beganAt).toISOString();
  return [
    `Seat delivery ${receipt.receiptId} (began ${began}) never confirmed receipt, so it stays unresolved and is never resent. Other wakes, watches and reports keep arriving.`,
    `If this session never received it, settle it without claiming receipt: \`clankie seat-delivery settle ${receipt.receiptId} abandoned-unknown --conversation ${conversationId}\`. \`clankie seat-delivery list\` shows every unresolved delivery and its age.`,
  ].join("\n");
}

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
  | { readonly outcome: "delivered"; readonly messageId?: string }
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
  readonly ownerOrigin?: OperatorOwnerTurnOrigin;
  readonly content: string;
  /** An escalation holds its run open for the seat's answer; a wake or watch settles once taken. */
  readonly wantsReply: boolean;
  /** A supplied native binding pins every source to its original recipient. */
  readonly recipientBinding?: string;
  readonly signal?: AbortSignal;
}

type PollFinishSource = "wake" | "timeout" | "abort" | "supersede" | "close";

interface ParkedPoller {
  readonly capabilities?: OperatorSeatCapabilities;
  readonly recipientBinding?: string;
  finish(events: OperatorSeatEvent[], source: PollFinishSource): void;
}

interface Pending {
  /** The original content's fingerprint; the wire event may carry a clipped copy. */
  readonly fingerprint: string;
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
  private readonly ackTimeoutMs: number;
  private readonly abortKeepsGrace: boolean;
  private readonly explicitAcknowledgments: boolean;
  private readonly replyTimeoutMs: number;
  private readonly now: () => number;
  private readonly fence: DeliveryFence;
  private readonly delivered: DeliveryFence;
  private readonly active = new Set<string>();
  /** Receipts already announced, including the alerts' own, so an alert never alerts about an alert. */
  private readonly alerted = new Set<string>();
  private readonly onUnresolved: ((receipt: UnresolvedSeatReceipt) => void) | undefined;
  private lastCapabilities: OperatorSeatCapabilities | undefined;
  private lastBridgePollAt: number | undefined;
  private readonly bridgeIssues = new Set<string>();
  private readonly onBridgeIssue: ((detail: string) => void) | undefined;
  private lastPollAt: number | undefined;
  private lastPollBinding: string | undefined;
  private readonly presencePath: string | undefined;
  private presenceWrittenAt: number | undefined;
  private presenceBinding: string | undefined;
  /** Until a seat polls this process, a seat present before the restart is presumed bound. */
  private reconnectUntil: number | undefined;
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
      /** Worker channels acknowledge an exact event, never implicitly on the next poll. */
      readonly explicitAcknowledgments?: boolean;
      readonly boundGraceMs?: number;
      /** How long a taken event waits for its exact ack before settling unconfirmed; defaults to the bound grace. */
      readonly ackTimeoutMs?: number;
      /**
       * Worker mailboxes end parked polls on every report change and re-park at
       * once, so an aborted poll keeps the grace. A head seat's abort is its
       * bridge leaving and unbinds at once.
       */
      readonly abortKeepsGrace?: boolean;
      readonly replyTimeoutMs?: number;
      readonly now?: () => number;
      /**
       * Seat presence heartbeat. A seat that polled the previous service within
       * the recent window stays bound for a reconnect grace after this service
       * starts, so its turns queue for it instead of running on pi.
       */
      readonly presencePath?: string;
      /** When this service process started; the reconnect grace counts from here. */
      readonly startedAt?: number;
      readonly reconnectGraceMs?: number;
      readonly recentSeatMs?: number;
      /** Tell the lead about an unresolved receipt instead of failing silently. Called once per receipt. */
      readonly onUnresolved?: (receipt: UnresolvedSeatReceipt) => void;
      readonly onBridgeIssue?: (detail: string) => void;
    } = {},
  ) {
    this.onUnresolved = options.onUnresolved;
    this.onBridgeIssue = options.onBridgeIssue;
    this.fence = new DeliveryFence(options.uncertaintyPath);
    this.delivered = new DeliveryFence(
      options.uncertaintyPath === undefined ? undefined : `${options.uncertaintyPath}.delivered`,
    );
    this.boundGraceMs = options.boundGraceMs ?? BOUND_GRACE_MS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? this.boundGraceMs;
    this.abortKeepsGrace = options.abortKeepsGrace ?? false;
    this.explicitAcknowledgments = options.explicitAcknowledgments ?? false;
    this.replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.presencePath = options.presencePath;
    if (this.presencePath !== undefined) {
      const presence = readPresence(this.presencePath);
      const startedAt = options.startedAt ?? this.now();
      const age = presence === undefined ? undefined : startedAt - presence.lastPollAt;
      if (age !== undefined && age >= 0 && age <= (options.recentSeatMs ?? RESTART_RECENT_SEAT_MS)) {
        this.reconnectUntil = startedAt + (options.reconnectGraceMs ?? RESTART_RECONNECT_GRACE_MS);
        // The reconnecting seat proves the same native binding when it polls.
        this.lastPollBinding = presence!.recipientBinding;
        this.lastCapabilities = presence!.capabilities;
        this.lastBridgePollAt = presence!.lastPollAt;
      }
    }
  }

  /** A read observes loaded receiver capabilities, never installed files or receipts. */
  public bridgeStatus(conversationId: string): OperatorSeatBridgeStatus {
    const capabilities = this.lastCapabilities;
    const current =
      !!capabilities?.ownerOrigin &&
      capabilities.eventKinds.includes("turn") &&
      LEGACY_OPERATOR_SEAT_EVENT_KINDS.every((kind) => capabilities.eventKinds.includes(kind));
    const bound = this.bound();
    const reconnecting =
      !this.closed &&
      this.pollers.size === 0 &&
      ((this.reconnectUntil ?? 0) > this.now() ||
        (!bound &&
          this.lastBridgePollAt !== undefined &&
          this.now() - this.lastBridgePollAt <= RESTART_RECONNECT_GRACE_MS));
    return {
      conversationId,
      state: reconnecting ? "reconnecting" : !bound ? "disconnected" : current ? "current" : "stale",
      eventKinds: [...(capabilities?.eventKinds ?? LEGACY_OPERATOR_SEAT_EVENT_KINDS)],
      ownerOrigin: capabilities?.ownerOrigin ?? false,
      ...(capabilities?.sourceHash ? { sourceHash: capabilities.sourceHash } : {}),
      ...(this.lastBridgePollAt === undefined
        ? {}
        : { lastSeenAt: new Date(this.lastBridgePollAt).toISOString() }),
      detail: reconnecting
        ? "Seat bridge is reconnecting; only the original native session and chat may attach again."
        : !bound
          ? "Seat bridge is disconnected; reconnect with /mcp if this conversation uses a native head."
          : current
            ? "Seat bridge supports owner turns."
            : "Clankie's seat needs a reconnect: /mcp. The bridge does not declare the current seat protocol; owner turns use a compatible wire format when supported.",
    };
  }

  private bridgeIssue(detail: string): void {
    if (this.bridgeIssues.has(detail)) return;
    this.bridgeIssues.add(detail);
    try {
      this.onBridgeIssue?.(detail);
    } catch {
      /* Diagnostics remain readable if the notice cannot be stored. */
    }
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

  /** Any unresolved receipt. Routing keeps the seat lane; `deliver` refuses only that original. */
  public uncertain(): boolean {
    return this.unresolved().length > 0;
  }

  /**
   * Driver selection: the seat takes this input while it polls, or when the
   * input is (or may be) an unresolved original that only the seat may
   * reconcile. Must agree with `deliver`, which refuses unrelated input with
   * `unbound` when no seat polls, or a driver fence would select it forever.
   */
  public routesToSeat(content: string, messageId?: string): boolean {
    return (
      this.bound() ||
      this.conflict({ content, ...(messageId === undefined ? {} : { messageId }) }) !== undefined
    );
  }

  /** True when this exact content is (or may be) an unresolved original, so it must not be sent again. */
  public uncertainFor(content: string): boolean {
    return this.conflict({ content }) !== undefined;
  }

  /** Unresolved receipts, oldest first, for doctor and the owner settle path. */
  public unresolvedDeliveries(): UnresolvedSeatReceipt[] {
    return this.unresolved()
      .map(([, receipt]) => ({
        receiptId: receipt.messageId,
        ...(receipt.beganAt === undefined ? {} : { beganAt: receipt.beganAt }),
      }))
      .sort((left, right) => (left.beganAt ?? 0) - (right.beganAt ?? 0));
  }

  /**
   * Owner settlement (VUH-1779): retain the original as `abandoned-unknown`.
   * It claims no receipt and the original is never resent; it only stops
   * counting as unresolved.
   */
  public abandonUnknown(receiptId: string): SeatDeliveryAbandonment {
    if (this.active.has(receiptId))
      throw new Error("That delivery is still in flight; wait for it to settle");
    const matches = this.unresolved().filter(([, receipt]) => receipt.messageId === receiptId);
    if (matches.length !== 1) throw new Error("No unresolved seat delivery has that receipt ID");
    return this.fence.abandonUnknown(matches[0]![0], receiptId, this.now());
  }

  private unresolved() {
    return this.fence.entries().filter(([id]) => !this.active.has(id));
  }

  /**
   * ADR 0207 protects the uncertain original itself: its own ID or exact
   * content may never be sent again. Unrelated deliveries are not blocked.
   * An unreadable journal cannot tell the two apart, so it refuses everything.
   */
  private conflict(input: { content: string; messageId?: string }) {
    const fingerprint = deliveryFingerprint(input.content);
    return this.unresolved().find(
      ([id, receipt]) =>
        id === "unreadable-receipts" ||
        receipt.fingerprint === fingerprint ||
        (input.messageId !== undefined && (id === input.messageId || receipt.messageId === input.messageId)),
    );
  }

  /** Each unresolved receipt is announced once per process, only while a seat is reachable. */
  private alertUnresolved(): void {
    if (this.onUnresolved === undefined) return;
    for (const receipt of this.unresolvedDeliveries()) {
      if (this.alerted.has(receipt.receiptId)) continue;
      this.alerted.add(receipt.receiptId);
      const notify = this.onUnresolved;
      queueMicrotask(() => {
        try {
          notify(receipt);
        } catch {
          /* The alert is advisory; doctor still reports the receipt. */
        }
      });
    }
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
    const unresolved = this.conflict({
      content: input.content,
      ...(input.original === undefined ? {} : { messageId: input.original.messageId }),
    });
    if (unresolved !== undefined)
      return Promise.resolve({
        outcome: "unconfirmed",
        deliveryStage: "uncertain",
        messageId: unresolved[1].messageId,
        detail:
          "This delivery is uncertain; its exact receipt must be reconciled (or the owner must settle it as abandoned-unknown) and it is never resent.",
      });
    const abandoned =
      input.original === undefined
        ? undefined
        : this.fence.all().find(([id, receipt]) => receipt.abandoned && id === input.original!.messageId);
    if (abandoned !== undefined)
      return Promise.resolve({
        outcome: "unconfirmed",
        deliveryStage: "uncertain",
        messageId: abandoned[1].messageId,
        detail: "The owner settled this original as abandoned-unknown; it is never resent.",
      });
    if (!this.bound()) return Promise.resolve({ outcome: "unbound", deliveryStage: "unavailable" });
    if (input.source !== SEAT_DELIVERY_ALERT_SOURCE) this.alertUnresolved();
    if (input.signal?.aborted === true)
      return Promise.resolve({ outcome: "aborted", deliveryStage: "expired" });
    const fingerprint = deliveryFingerprint(input.content);
    return new Promise((resolve, reject) => {
      const event: OperatorSeatEvent = {
        schemaVersion: 1,
        id: input.original?.messageId ?? `seat-${randomUUID()}`,
        kind: input.kind,
        conversationId: input.conversationId,
        source: input.source,
        ...(input.ownerOrigin === undefined ? {} : { ownerOrigin: input.ownerOrigin }),
        content: fitSeatChannel(input.content),
        createdAt: new Date(this.now()).toISOString(),
      };
      input.original?.prepare({
        messageId: event.id,
        fingerprint,
        ...(input.recipientBinding === undefined ? {} : { recipientBinding: input.recipientBinding }),
      });
      this.fence.begin(event.id, {
        messageId: event.id,
        fingerprint,
        beganAt: this.now(),
        conversationId: input.conversationId,
        ...(input.original === undefined
          ? input.recipientBinding === undefined
            ? {}
            : { sessionId: input.recipientBinding }
          : // Empty is an exact absent binding, distinct from legacy wildcard receipts.
            { sessionId: input.recipientBinding ?? "" }),
      });
      this.active.add(event.id);
      if (input.source === SEAT_DELIVERY_ALERT_SOURCE) this.alerted.add(event.id);
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
        fingerprint,
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
  public poll(
    waitMs: number,
    signal?: AbortSignal,
    recipientBinding?: string,
    capabilities?: OperatorSeatCapabilities,
  ): Promise<OperatorSeatEvent[]> {
    if (this.closed) return Promise.resolve([]);
    // The seat is back: from here, its own polls decide whether it is bound.
    this.reconnectUntil = undefined;
    const changed = JSON.stringify(this.lastCapabilities) !== JSON.stringify(capabilities);
    this.lastCapabilities = capabilities;
    this.lastBridgePollAt = this.now();
    if (changed) this.presenceWrittenAt = undefined;
    this.recordPresence(recipientBinding);
    if (
      !capabilities?.ownerOrigin ||
      !capabilities.eventKinds.includes("turn") ||
      !LEGACY_OPERATOR_SEAT_EVENT_KINDS.every((kind) => capabilities.eventKinds.includes(kind))
    )
      this.bridgeIssue(
        "Clankie's seat needs a reconnect: /mcp. The attached bridge declares an older or incomplete seat protocol; owner turns use a compatible wire format when supported.",
      );
    // A polling seat is present: announce receipts it has not been told about yet.
    this.alertUnresolved();
    if (!this.explicitAcknowledgments) this.ackInFlight(recipientBinding);
    const ready = this.take(recipientBinding, capabilities);
    if (ready.length > 0 || waitMs <= 0 || signal?.aborted === true) return Promise.resolve(ready);
    return new Promise((resolve) => {
      let finished = false;
      const poller: ParkedPoller = {
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(recipientBinding === undefined ? {} : { recipientBinding }),
        finish: (events, source) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.pollers.delete(poller);
          if (source === "timeout" || source === "wake" || (source === "abort" && this.abortKeepsGrace)) {
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

  /** A target conversation confirms consumption of this exact original, never a replacement. */
  public confirmReceived(original: {
    messageId: string;
    fingerprint: string;
    recipientBinding?: string;
  }): boolean {
    const pending = this.inFlight.find((entry) => entry.event.id === original.messageId);
    if (pending) {
      if (
        !pending.taken ||
        !this.matchesRecipient(pending, original.recipientBinding) ||
        pending.fingerprint !== original.fingerprint
      )
        return false;
    } else {
      if (this.active.has(original.messageId)) return false;
      const receipt = [...this.fence.all(), ...this.delivered.all()].find(
        ([, entry]) => entry.messageId === original.messageId,
      )?.[1];
      if (
        !receipt ||
        receipt.fingerprint !== original.fingerprint ||
        receipt.sessionId !== (original.recipientBinding ?? "")
      )
        return false;
    }
    return this.acknowledge(original.messageId, original.recipientBinding);
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
    const now = this.now();
    const reconnect = this.reconnectUntil === undefined ? 0 : Math.max(0, this.reconnectUntil - now);
    if (this.lastPollAt === undefined) return reconnect;
    const elapsed = now - this.lastPollAt;
    return Math.max(reconnect, elapsed < this.boundGraceMs ? this.boundGraceMs - elapsed : 0);
  }

  /** Durable evidence that a seat is polling, read by the next service after a restart. */
  private recordPresence(recipientBinding: string | undefined): void {
    if (this.presencePath === undefined) return;
    const now = this.now();
    if (
      this.presenceWrittenAt !== undefined &&
      now - this.presenceWrittenAt < PRESENCE_WRITE_INTERVAL_MS &&
      this.presenceBinding === recipientBinding
    )
      return;
    try {
      mkdirSync(dirname(this.presencePath), { recursive: true, mode: 0o700 });
      writeFileSync(
        this.presencePath,
        `${JSON.stringify({ schemaVersion: 1, lastPollAt: now, ...(this.lastCapabilities === undefined ? {} : { capabilities: this.lastCapabilities }), ...(recipientBinding === undefined ? {} : { recipientBinding }) })}\n`,
        { mode: 0o600 },
      );
      this.presenceWrittenAt = now;
      this.presenceBinding = recipientBinding;
    } catch {
      // Presence only shortens a restart's pi fallback; a failed write keeps today's behavior.
    }
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
          fingerprint: pending.fingerprint,
          conversationId: pending.event.conversationId,
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
      pending.settle({ outcome: "delivered", messageId: pending.event.id });
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

  private take(recipientBinding?: string, capabilities?: OperatorSeatCapabilities): OperatorSeatEvent[] {
    const taken = [...this.queued];
    const events: OperatorSeatEvent[] = [];
    for (const pending of taken) {
      if (!this.matchesRecipient(pending, recipientBinding)) {
        pending.settle({ outcome: "unbound" });
        continue;
      }
      if (pending.holdUntilTurnEnd && this.turnActive) continue;
      const kinds: readonly OperatorSeatEventKind[] =
        capabilities?.eventKinds ?? LEGACY_OPERATOR_SEAT_EVENT_KINDS;
      const original = pending.event;
      const fallback = original.kind === "turn" && (!kinds.includes("turn") || !capabilities?.ownerOrigin);
      const kind = fallback ? "message" : original.kind;
      if (!kinds.includes(kind)) {
        this.bridgeIssue(
          `Clankie's seat needs a reconnect: /mcp. Its bridge cannot receive ${original.kind}; this delivery was refused before dispatch.`,
        );
        pending.settle({ outcome: "unbound" });
        continue;
      }
      // Project only declared fields. The Oct 6 bridge has a strict schema.
      const origin = original.ownerOrigin;
      const wire: OperatorSeatEvent = {
        schemaVersion: 1,
        id: original.id,
        kind,
        conversationId: original.conversationId,
        source: original.source,
        createdAt: original.createdAt,
        content:
          fallback && origin
            ? fitSeatChannel(
                `[Owner app turn from ${origin.surfaceClientId}; ${origin.principal.kind} ${origin.principal.id}, verified by the service.]\n\n${original.content}`,
              )
            : original.content,
        ...(capabilities?.ownerOrigin && !fallback && origin ? { ownerOrigin: origin } : {}),
      };
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
        this.ackTimeoutMs,
      );
      pending.timer.unref?.();
      events.push(wire);
    }
    if (events.length > 0) this.lastPollAt = this.now();
    return events;
  }

  private wakePoller(): void {
    const [first] = this.pollers;
    if (first === undefined) return;
    const ready = this.take(first.recipientBinding, first.capabilities);
    if (ready.length > 0) first.finish(ready, "wake");
  }
}

function readPresence(
  path: string,
): { lastPollAt: number; recipientBinding?: string; capabilities?: OperatorSeatCapabilities } | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const { lastPollAt, recipientBinding, capabilities } = raw as Record<string, unknown>;
    const parsed = OperatorSeatCapabilitiesSchema.safeParse(capabilities);
    if (typeof lastPollAt !== "number" || !Number.isFinite(lastPollAt)) return undefined;
    return {
      lastPollAt,
      ...(parsed.success ? { capabilities: parsed.data } : {}),
      ...(typeof recipientBinding === "string" ? { recipientBinding } : {}),
    };
  } catch {
    return undefined;
  }
}
