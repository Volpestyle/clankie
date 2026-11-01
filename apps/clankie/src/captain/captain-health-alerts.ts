import { join } from "node:path";
import type { OperatorFleetSeat } from "@clankie/protocol";
import type { WatchGate } from "../watch.ts";
import type { CaptainOptions } from "./captain-types.ts";
import type { ConversationOwner, NativeSeatRecipient } from "./conversation-owner.ts";
import type { ConversationStore } from "./conversations.ts";
import type { CaptainDeps } from "./deps.ts";
import { deliveryFingerprint } from "./delivery-fence.ts";
import { FleetReportFailureAlerts } from "./fleet-review.ts";
import { fleetSeatMailbox, type FleetSeatDelivery, type FleetSeatMessageContext } from "./fleet-seat.ts";
import type { ObservedFleetSeat } from "./herdr-census.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";
import type { NextTurnMailbox } from "./next-turn-mailbox.ts";
import type { PeerDeliveryOptions } from "./peer-seat-messages.ts";
import type { FleetHealthAlertDelivery } from "./port.ts";
import type { SeatOutbox } from "./seat-outbox.ts";

export interface HealthAlertsContext<Fleet> {
  readonly options: Pick<CaptainOptions, "stateDir" | "onHealthAlertDelivery">;
  readonly deps: Pick<CaptainDeps, "onSeatDeliveryEvent">;
  readonly shutdown: AbortController;
  readonly watch: WatchGate;
  readonly conversations: ConversationStore;
  readonly herdrRunner: HerdrWatchRunner;
  readonly seatLeadOwners: WeakMap<
    OperatorFleetSeat,
    { owner: ConversationOwner; admitted: boolean; observed: ObservedFleetSeat }
  >;
  readonly fleetMailboxes: Map<string, SeatOutbox>;
  readonly nextTurnMailboxes: NextTurnMailbox;
  readonly observeFleet: (localOnly: boolean) => Promise<Fleet>;
  readonly workerReportRoute: (
    agent: HerdrAgentSnapshot,
    fleet: Fleet,
  ) => Promise<{
    owner: ConversationOwner;
    diagnostic: { source: string };
    parent?: NativeSeatRecipient;
    native?: NativeSeatRecipient;
  }>;
  readonly validateConversationOwner: (owner: ConversationOwner) => Promise<boolean>;
  readonly inboundBinding: (agent: HerdrAgentSnapshot | undefined) => string | undefined;
  readonly seatOutbox: (conversationId: string) => SeatOutbox;
  readonly operatorNativeSource: (conversationId: string) => Promise<HerdrAgentSnapshot | undefined>;
  readonly nativeRecipientCurrent: (recipient: NativeSeatRecipient) => Promise<boolean>;
  readonly deliverToSeat: (
    seatId: string,
    message: string,
    context: FleetSeatMessageContext,
    deliveryOptions?: PeerDeliveryOptions,
  ) => Promise<FleetSeatDelivery>;
}

/** Fleet and runtime health alerts, delivered natively to the lead that owns the seat. */
export function createHealthAlerts<Fleet>(ctx: HealthAlertsContext<Fleet>) {
  const {
    options,
    deps,
    shutdown,
    watch,
    conversations,
    herdrRunner,
    seatLeadOwners,
    fleetMailboxes,
    nextTurnMailboxes,
    observeFleet,
    validateConversationOwner,
    seatOutbox,
    deliverToSeat,
  } = ctx;
  const reportFailureAlerts = new FleetReportFailureAlerts();
  function observeReportFailureAlerts(seats: readonly OperatorFleetSeat[]): void {
    for (const alert of reportFailureAlerts.observe(seats)) {
      const seat = seats.find((seat) => seat.seatId === alert.seatId);
      const pane = seat && seatLeadOwners.get(seat)?.observed.paneId;
      if (!pane) {
        reportFailureAlerts.settle(alert, false);
        continue;
      }
      void notifyFleetHealthAlert(pane, alert.text)
        .then((accepted) => reportFailureAlerts.settle(alert, accepted))
        .catch(() => reportFailureAlerts.settle(alert, false));
    }
  }

  /** Native delivery only. Health observations never start a service model turn. */
  async function notifyFleetHealthAlert(
    pane: string | undefined,
    text: string,
    observe?: (delivery: FleetHealthAlertDelivery) => void,
  ): Promise<boolean> {
    if (shutdown.signal.aborted || !text.trim() || text.length > 4000) return false;
    const observeDelivery = observe
      ? (delivery: FleetHealthAlertDelivery) => {
          try {
            observe(delivery);
          } catch {
            /* Observation cannot change delivery settlement. */
          }
        }
      : undefined;
    if (pane === undefined) {
      const conversationId = conversations.defaultGlobalConversationId();
      if (!conversations.recordServiceNotice(conversationId, text)) return false;
      return deliverNativeHealthAlert(
        { conversationId },
        text,
        async () => {
          if (shutdown.signal.aborted) throw new Error("Fleet health alert stopped");
        },
        undefined,
        observeDelivery,
        true,
      );
    }
    // allow-swallowed-rejection -- moved from captain.ts (ADR 0325); a pane that can't be read gets no alert.
    const original = await herdrRunner.get(pane).catch(() => undefined);
    if (!original?.session) return false;
    const fleet = await observeFleet(true);
    const route = await ctx.workerReportRoute(original, fleet);
    if (!["adoption", "parent"].includes(route.diagnostic.source)) return false;
    if (!(await validateConversationOwner(route.owner))) return false;
    const guard = async () => {
      if (shutdown.signal.aborted || !(await validateConversationOwner(route.owner)))
        throw new Error("Fleet health alert owner is unavailable");
      // allow-swallowed-rejection -- moved from captain.ts (ADR 0325); a pane that can't be read gets no alert.
      const current = await herdrRunner.get(pane).catch(() => undefined);
      if (!current || ctx.inboundBinding(current) !== ctx.inboundBinding(original))
        throw new Error("Fleet health alert occupant changed");
      const currentRoute = await ctx.workerReportRoute(current, await observeFleet(true));
      if (JSON.stringify(currentRoute.owner) !== JSON.stringify(route.owner))
        throw new Error("Fleet health alert lead changed");
    };
    const workerText = `Worker ${pane} (${original.agent}). ${text}`;
    return deliverNativeHealthAlert(
      route.owner,
      workerText,
      guard,
      route.native ?? route.parent,
      observeDelivery,
    );
  }

  /**
   * The owner's default conversation records the alert durably as received
   * context, without a model turn, so it reaches the owner even when its native
   * seat cannot take a delivery (VUH-1702). The same text is recorded once. The
   * result is the native seat delivery, which callers retry with that same text.
   */
  async function notifyRuntimeHealthAlert(text: string, targetConversationId?: string): Promise<boolean> {
    if (shutdown.signal.aborted || !text.trim() || text.length > 4000) return false;
    const conversationId = targetConversationId ?? conversations.defaultGlobalConversationId();
    if (!(await validateConversationOwner({ conversationId }))) return false;
    if (!conversations.recordServiceNotice(conversationId, text)) return false;
    return deliverNativeHealthAlert({ conversationId }, text, async () => {
      if (shutdown.signal.aborted) throw new Error("Runtime health alert stopped");
    });
  }

  async function deliverNativeHealthAlert(
    owner: ConversationOwner,
    text: string,
    guard: () => Promise<void>,
    recipient?: NativeSeatRecipient,
    observe?: (delivery: FleetHealthAlertDelivery) => void,
    durableOwnerNotice = false,
  ): Promise<boolean> {
    const outcome = (submitted: boolean, reason: string) => {
      // Only a definitively absent native source settles via its owner notice.
      // Existing unresolved receipts and dispatch failures keep their semantics.
      const noticeAccepted = durableOwnerNotice && reason === "native_source_unavailable";
      if (noticeAccepted) observe?.({ outcome: "accepted" });
      options.onHealthAlertDelivery?.({
        fingerprint: deliveryFingerprint(text),
        conversationId: owner.conversationId,
        outcome: submitted ? "submitted" : "unavailable",
        reason,
      });
      return submitted || noticeAccepted;
    };
    try {
      if (shutdown.signal.aborted || !text.trim() || text.length > 4000)
        return outcome(false, "stopped_or_invalid");
      if (!(await validateConversationOwner(owner))) return outcome(false, "owner_unavailable");
      // Watch sends nothing into a seat, a lead's included (ADR 0308).
      if (await watch.watching()) return outcome(false, "watching");
      await guard();
      await conversations.waitForDriverAdmission(owner.conversationId, shutdown.signal);
      await guard();
      const outbox = seatOutbox(owner.conversationId);
      // VUH-1779: only this alert's own unresolved original holds it back.
      if (outbox.uncertainFor(text)) return outcome(false, "owner_receipt_unresolved");
      if (!recipient && outbox.bound()) {
        const result = await outbox
          .deliver({
            kind: "message",
            conversationId: owner.conversationId,
            source: "service",
            content: text,
            wantsReply: false,
            signal: shutdown.signal,
          })
          .catch((error: unknown) => {
            observe?.({ outcome: "unconfirmed" });
            throw error;
          });
        observe?.(
          result.outcome === "delivered" &&
            ["delivered", "consumed", "responded"].includes(result.deliveryStage ?? "")
            ? { outcome: "accepted" }
            : result.outcome === "unconfirmed"
              ? { outcome: "unconfirmed", acknowledged: () => outbox.recoveryAcknowledged(result.messageId) }
              : { outcome: "unavailable" },
        );
        return outcome(
          ["delivered", "unconfirmed"].includes(result.outcome),
          `owner_mailbox_${result.outcome}`,
        );
      }
      const target = recipient
        ? // allow-swallowed-rejection -- moved from captain.ts (ADR 0325); a pane that can't be read gets no alert.
          await herdrRunner.get(recipient.paneId).catch(() => undefined)
        : await ctx.operatorNativeSource(owner.conversationId);
      if (!target?.session) return outcome(false, "native_source_unavailable");
      const binding = ctx.inboundBinding(target);
      if (recipient && binding !== recipient.binding) return outcome(false, "native_recipient_changed");
      const mailbox = fleetSeatMailbox(
        fleetMailboxes,
        target.terminalId,
        join(options.stateDir, "delivery-receipts", "fleet"),
        deps.onSeatDeliveryEvent,
      );
      if (mailbox.uncertainFor(text)) return outcome(false, "native_receipt_unresolved");
      let blocked = false;
      let dispatchChecked = false;
      const finalGuard = async () => {
        await guard();
        if (!(await validateConversationOwner(owner))) throw new Error("Health alert owner changed");
        if (recipient && !(await ctx.nativeRecipientCurrent(recipient)))
          throw new Error("Health alert native lead changed");
        if (outbox.uncertainFor(text) || mailbox.uncertainFor(text)) {
          blocked = true;
          throw new Error("Health alert recipient has an unresolved original receipt; nothing was sent");
        }
        dispatchChecked = true;
      };
      const result = await deliverToSeat(
        target.terminalId,
        text,
        { conversationId: owner.conversationId, source: "captain" },
        {
          guard: finalGuard,
          ...(binding === undefined ? {} : { recipientBinding: binding }),
          fence: async (current) => ctx.inboundBinding(current) === binding,
        },
      ).catch((error: unknown) => {
        if (blocked) return undefined;
        if (dispatchChecked) observe?.({ outcome: "unconfirmed" });
        throw error;
      });
      if (
        result?.outcome === "delivered" &&
        dispatchChecked &&
        ["delivered", "consumed", "responded"].includes(result.deliveryStage ?? "")
      )
        observe?.({ outcome: "accepted" });
      else if (result?.outcome === "delivered" && dispatchChecked) {
        const id = result.messageId;
        observe?.({
          outcome: "unconfirmed",
          ...(id
            ? {
                acknowledged: () => nextTurnMailboxes.acknowledged(target.terminalId, binding, id, text),
              }
            : {}),
        });
      } else if (result?.outcome === "unconfirmed" && dispatchChecked) {
        const id = result.messageId;
        observe?.({
          outcome: "unconfirmed",
          ...(id
            ? {
                acknowledged: () =>
                  mailbox.recoveryAcknowledged(id) ||
                  nextTurnMailboxes.acknowledged(target.terminalId, binding, id, text),
              }
            : {}),
        });
      }
      return outcome(
        !blocked &&
          result !== undefined &&
          (result.outcome === "delivered" || (result.outcome === "unconfirmed" && dispatchChecked)),
        blocked ? "receipt_unresolved_before_dispatch" : `native_${result?.outcome ?? "unavailable"}`,
      );
    } catch (error) {
      outcome(false, "native_dispatch_failed");
      throw error;
    }
  }
  return { observeReportFailureAlerts, notifyFleetHealthAlert, notifyRuntimeHealthAlert };
}
