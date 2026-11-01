import { stageWindowsMessage, stagedMessagePointer } from "./remote-seat-message.ts";
import {
  prepareWorkHandoffIntent as prepareWorkIntent,
  prepareFreeAgentIntent as prepareFreeIntent,
} from "./free-agent-intent.ts";
import { readClaudeSubagents, readCodexSubagents } from "@clankie/agent-transcript";
import { OPERATOR_CONVERSATION_TEXT_MAX, type OperatorFleetSeat } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { join } from "node:path";
import { HerdrFleetError, splitFleetQualified, type HerdrFleet } from "../herdr-fleet.ts";
import { type CaptainOptions } from "./captain-types.ts";
import { createNativeSources } from "./captain-native-sources.ts";
import { createFleetProjection } from "./captain-fleet-projection.ts";
import { ConversationStore } from "./conversations.ts";
import type { CaptainDeps } from "./deps.ts";
import {
  deliverFleetSeatMessage,
  fleetSeatMailbox,
  type FleetSeatDelivery,
  type FleetSeatMessageContext,
} from "./fleet-seat.ts";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import { FleetChangeClock } from "./herdr-fleet-changes.ts";
import { HerdrWatchStore } from "./herdr-watch.ts";
import { NextTurnMailbox } from "./next-turn-mailbox.ts";
import { type PeerDeliveryOptions } from "./peer-seat-messages.ts";
import { PersonaStore } from "./personas.ts";
import { type SeatLedger } from "./seat-ledger.ts";
import { SeatOutbox } from "./seat-outbox.ts";
import type { HerdrWatchRunner } from "./herdr-watch.ts";

export interface SeatDeliveryContext {
  readonly options: CaptainOptions;
  readonly deps: CaptainDeps;
  readonly settingsStore: SettingsStore;
  readonly conversations: ConversationStore;
  readonly herdrRunner: HerdrWatchRunner;
  readonly personas: PersonaStore;
  readonly herdrWatches: HerdrWatchStore;
  readonly nextTurnMailboxes: NextTurnMailbox;
  readonly fleetMailboxes: Map<string, SeatOutbox>;
  readonly refreshFleets: () => Promise<readonly HerdrFleet[]>;
  readonly fleetRevisions: Map<string, number>;
  readonly fleetChanges: FleetChangeClock;
  readonly publishWaitingNotice: (seat: string, binding: string | undefined, pane: string) => Promise<void>;
  readonly recordLeadVisit: (seatId: string, kind: "message" | "close", text?: string) => void;
  readonly seatLedger: SeatLedger;
  /** Read and written at call time: the captain's live seat state (ADR 0325). */
  liveSeats: readonly OperatorFleetSeat[];
  /** Read at call time: the captain builds these after seat delivery (ADR 0325). */
  readonly refreshFleet: ReturnType<typeof createFleetProjection>["refreshFleet"];
  readonly inboundBinding: ReturnType<typeof createNativeSources>["inboundBinding"];
}

/**
 * Seat delivery: the one lane into a seat, and the free-agent and work
 * handoff intents it carries (moved from the captain, ADR 0325).
 */
export function createSeatDelivery(ctx: SeatDeliveryContext) {
  const {
    options,
    deps,
    settingsStore,
    conversations,
    herdrRunner,
    personas,
    herdrWatches,
    nextTurnMailboxes,
    fleetMailboxes,
    refreshFleets,
    fleetRevisions,
    fleetChanges,
    publishWaitingNotice,
    recordLeadVisit,
    seatLedger,
  } = ctx;

  /**
   * The one lane into a seat — an operator DM, a room turn, and the captain's
   * own messages all take it: harness control, native queue or the seat's bound
   * mailbox. A missing or uncertain channel never permits terminal typing.
   */
  function prepareFreeAgentIntent(intent: import("@clankie/protocol").FreeAgentIntent) {
    return prepareFreeIntent(
      {
        settingsStore,
        options,
        refreshFleet: async () => {
          await ctx.refreshFleet({ force: true });
          const helper = ctx.liveSeats.find(
            (seat) => seat.seatId === intent.seatId && seat.occupantId === intent.occupantId,
          );
          if (!helper) return ctx.liveSeats;
          const addressed =
            conversations.conversationIdForPersona(helper.personaId) !== undefined ||
            conversations.conversationIdForSeat(helper.seatId) !== undefined;
          const native =
            addressed && helper.fleet === undefined
              ? // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); a channel that can't be read leaves delivery to its own fence.
                await herdrRunner.resolveTerminal(helper.seatId).catch(() => undefined)
              : undefined;
          let subagents: import("@clankie/protocol").OperatorSeatSubagents | undefined;
          if (native?.session && occupantIdForHerdrSession(native.session) === intent.occupantId) {
            try {
              subagents =
                helper.harness === "codex"
                  ? await readCodexSubagents(native.session, { freshDiscovery: true })
                  : helper.harness === "claude"
                    ? readClaudeSubagents(native.session, { requireComplete: true })
                    : undefined;
            } catch {
              /* Unknown census never proves zero children. */
            }
          }
          ctx.liveSeats = ctx.liveSeats.map((seat) => (seat === helper ? { ...seat, subagents } : seat));
          return ctx.liveSeats;
        },
        seats: () => ctx.liveSeats,
        personaForOccupant: (id) => personas.personaForOccupant(id),
      },
      intent,
    );
  }

  function prepareWorkHandoffIntent(intent: import("@clankie/protocol").WorkHandoffIntent) {
    return prepareWorkIntent(
      {
        settingsStore,
        options,
        refreshFleet: async () => {
          await ctx.refreshFleet({ force: true });
          return ctx.liveSeats;
        },
        seats: () => ctx.liveSeats,
        personaForOccupant: (id) => personas.personaForOccupant(id),
      },
      intent,
    );
  }

  async function deliverToSeat(
    seatId: string,
    message: string,
    context: FleetSeatMessageContext,
    deliveryOptions?: PeerDeliveryOptions,
  ): Promise<FleetSeatDelivery> {
    if (context.workHandoff) {
      const intent = context.workHandoff;
      if (
        context.freeAgent ||
        intent.seatId !== seatId ||
        context.source !== "operator" ||
        context.delivery === "queue"
      )
        return {
          outcome: "undelivered",
          deliveryStage: "rejected",
          detail: "This work handoff changed its original recipient.",
        };
      const recipient = await prepareWorkHandoffIntent(intent);
      const previous = deliveryOptions;
      deliveryOptions = {
        ...previous,
        source: "operator",
        guard: async () => {
          await previous?.guard?.();
          await recipient.guard();
        },
        fence: async (agent) => {
          if (previous?.fence && !(await previous.fence(agent))) return false;
          await recipient.guard();
          recipient.assertCurrent();
          return (
            !!agent?.session &&
            agent.terminalId === intent.seatId &&
            occupantIdForHerdrSession(agent.session) === intent.occupantId
          );
        },
      };
      await deliveryOptions.guard!();
    }
    if (context.freeAgent) {
      const intent = context.freeAgent;
      if (intent.seatId !== seatId || context.source !== "operator" || context.delivery === "queue")
        return {
          outcome: "undelivered",
          deliveryStage: "rejected",
          detail: "This drop changed its original recipient.",
        };
      const free = await prepareFreeAgentIntent(intent);
      const previous = deliveryOptions;
      deliveryOptions = {
        ...previous,
        source: "operator",
        guard: async () => {
          await previous?.guard?.();
          await free.guard();
        },
        fence: async (agent) => {
          const teammate = intent.helpTarget
            ? // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); a channel that can't be read leaves delivery to its own fence.
              await herdrRunner.resolveTerminal(intent.helpTarget.seatId).catch(() => undefined)
            : undefined;
          if (previous?.fence && !(await previous.fence(agent))) return false;
          await free.guard();
          free.assertCurrent();
          return (
            !!agent?.session &&
            agent.terminalId === intent.seatId &&
            occupantIdForHerdrSession(agent.session) === intent.occupantId &&
            /^(idle|resting)$/u.test(agent.status) &&
            (!intent.helpTarget ||
              (!!teammate?.session &&
                teammate.paneId === intent.helpTarget.paneId &&
                occupantIdForHerdrSession(teammate.session) === intent.helpTarget.occupantId))
          );
        },
      };
      await deliveryOptions.guard!();
    }
    // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); a channel that can't be read leaves delivery to its own fence.
    const current = await herdrRunner.resolveTerminal(seatId).catch(() => undefined);
    if (
      context.source === "operator" &&
      options.connectorSessionDetection?.() === true &&
      deliveryOptions?.reconcileOnly !== true &&
      deliveryOptions?.rediscover === undefined
    )
      deliveryOptions = { ...deliveryOptions, rediscover: true };
    // The owner's or a lead's own message may be typed into an agent with no channel (ADR
    // 0334), never while a worker-channel original to this seat is still uncertain.
    const directPrompt =
      context.source === "operator" &&
      context.delivery === undefined &&
      deliveryOptions?.fence === undefined &&
      deliveryOptions?.reconcileOnly !== true &&
      current?.session !== undefined &&
      fleetMailboxes.get(seatId)?.uncertain() !== true
        ? { session: current.session.value }
        : undefined;
    deliveryOptions = {
      ...deliveryOptions,
      ...(directPrompt === undefined ? {} : { directPrompt }),
      conversationId: context.conversationId,
      ...(ctx.inboundBinding(current) === undefined
        ? {}
        : { recipientBinding: ctx.inboundBinding(current)! }),
    };
    if (
      context.delivery &&
      current?.agent === "claude" &&
      !(await herdrWatches.inputCapabilities(current)).deliveryModes.includes(context.delivery)
    )
      return {
        outcome: "undelivered",
        deliveryStage: "rejected",
        detail: `This Claude session cannot ${context.delivery} through its current receiver. Nothing was sent.`,
      };
    const prior = nextTurnMailboxes.receipt(seatId, ctx.inboundBinding(current), message);
    if (prior && deliveryOptions?.stableReceiptKey === undefined) return prior;
    const mailbox = fleetSeatMailbox(
      fleetMailboxes,
      seatId,
      join(options.stateDir, "delivery-receipts", "fleet"),
      deps.onSeatDeliveryEvent,
    );
    if (deliveryOptions?.reconcileOnly) {
      const receipt = mailbox.receipt(message);
      if (receipt?.outcome === "delivered") return { outcome: "delivered", deliveryStage: "delivered" };
    }
    // An adapter-driven seat takes its message through the adapter, which
    // waits for the harness's own receipt; any other seat needs a structured lane.
    // `attempt` is the delivery attempt that fell back here: the rediscovery's
    // final resend passes its own options, not the first attempt's.
    const fallback = async (attempt?: {
      readonly rediscover?: boolean | "final";
    }): Promise<FleetSeatDelivery> => {
      const live = fleetMailboxes.get(seatId);
      const rediscover = attempt?.rediscover ?? deliveryOptions?.rediscover;
      // A cleared session leaves the mailbox certain of an occupant that is gone.
      // Release that one receipt so the rediscovery can send once. A poll still
      // bound to the current session keeps its receipt until the transcript
      // proves the message absent, which is the final attempt.
      if (
        live &&
        (rediscover === "final" || (rediscover === true && !live.boundTo(ctx.inboundBinding(current) ?? "")))
      )
        live.releaseAbsent(message);
      if (live?.boundTo(ctx.inboundBinding(current) ?? "") || live?.uncertain()) {
        let staged: Awaited<ReturnType<typeof stageWindowsMessage>> | undefined;
        let dispatched = false;
        try {
          const fleetId = current && splitFleetQualified(current.paneId)?.fleet;
          const fleet = fleetId && (await refreshFleets()).find((entry) => entry.id === fleetId);
          if (
            current?.agent === "claude" &&
            message.length > OPERATOR_CONVERSATION_TEXT_MAX &&
            fleet &&
            fleet.ssh.shell === "powershell"
          ) {
            const revision = fleetRevisions.get(fleet.id) ?? 0;
            try {
              staged = await stageWindowsMessage(async (...args) => {
                await refreshFleets();
                if ((fleetRevisions.get(fleet.id) ?? 0) !== revision || !deps.fleets?.shell)
                  throw new Error("Machine connection changed");
                return deps.fleets.shell(fleet)(...args);
              }, message);
            } catch (error) {
              throw new HerdrFleetError("staging_failed", `Nothing was sent: ${String(error)}`, "not_sent");
            }
          }
          if (staged) {
            // allow-swallowed-rejection -- A failed recipient read refuses dispatch and removes this preparation.
            const observed = await herdrRunner.resolveTerminal(seatId).catch(() => undefined);
            if (
              !observed ||
              observed.paneId !== current?.paneId ||
              ctx.inboundBinding(observed) !== ctx.inboundBinding(current)
            )
              return {
                outcome: "undelivered",
                deliveryStage: "unavailable",
                detail: "The native recipient changed while staging; nothing was sent.",
              };
          }
          await deliveryOptions?.guard?.();
          if (deliveryOptions?.fence && !(await deliveryOptions.fence(current)))
            return {
              outcome: "undelivered",
              deliveryStage: "rejected",
              detail: "Peer authority changed before mailbox delivery; nothing was sent.",
            };
          if (context.delivery && current?.session?.kind === "id" && current.status === "working")
            live.observeTurn(current.session.value, "responding", { onlyIfUnknown: true });
          dispatched = true;
          const result = await deliverFleetSeatMessage(fleetMailboxes, seatId, message, {
            ...context,
            ...(staged === undefined ? {} : { channelContent: stagedMessagePointer(staged, message) }),
            ...(deliveryOptions?.recipientBinding !== undefined
              ? { recipientBinding: deliveryOptions.recipientBinding }
              : context.delivery && ctx.inboundBinding(current)
                ? { recipientBinding: ctx.inboundBinding(current)! }
                : {}),
          });
          if (result.outcome === "undelivered" || result.outcome === "offline") dispatched = false;
          return result;
        } finally {
          // allow-swallowed-rejection -- Cleanup cannot change the send verdict; stale files remain eligible for the seven-day prune.
          if (staged && !dispatched) await staged.remove().catch(() => undefined);
        }
      }
      if (context.delivery === "steer")
        return {
          outcome: "undelivered",
          deliveryStage: "rejected",
          detail: "This agent's channel is unavailable. Nothing was sent.",
        };
      // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); a channel that can't be read leaves delivery to its own fence.
      const agent = await herdrRunner.resolveTerminal(seatId).catch(() => undefined);
      await deliveryOptions?.guard?.();
      if (deliveryOptions?.fence && !(await deliveryOptions.fence(agent)))
        return {
          outcome: "undelivered",
          deliveryStage: "rejected",
          detail: "Peer authority changed before mailbox storage; nothing was sent.",
        };
      let receipt = nextTurnMailboxes.store(seatId, ctx.inboundBinding(agent), message);
      if (receipt.deliveryStage === "stored" && agent?.agent === "claude")
        receipt = {
          ...receipt,
          detail: `${receipt.detail ?? ""} ${
            nextTurnMailboxes.messageReceiver(
              seatId,
              ctx.inboundBinding(agent),
              false,
              agent.session?.kind === "id" ? agent.session.value : undefined,
            ).detail
          }`.trim(),
        };
      fleetChanges.touch();
      if (agent)
        // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); a channel that can't be read leaves delivery to its own fence.
        await publishWaitingNotice(seatId, ctx.inboundBinding(agent), agent.paneId).catch(() => undefined);
      return receipt;
    };
    const deliver = () =>
      deliveryOptions || context.delivery
        ? herdrWatches.deliverToSeat(seatId, message, fallback, {
            ...deliveryOptions,
            ...(context.delivery === undefined ? {} : { delivery: context.delivery }),
          })
        : herdrWatches.deliverToSeat(seatId, message, fallback);
    let delivery: FleetSeatDelivery | undefined;
    if (context.source === "room") {
      await herdrWatches.sendAndWatchReply(seatId, message, async () => {
        delivery = await deliver();
        return delivery.outcome === "delivered";
      });
    } else delivery = await deliver();
    // What a seat has been asked to do today is a fact about the seat, so the
    // roster's cursor moves for it the way it moves for a stance (ADR 0150).
    if (delivery?.outcome === "delivered") {
      if (context.source === "captain" && delivery.deliveryStage !== "stored")
        recordLeadVisit(seatId, "message", message);
      seatLedger.promptSent(seatId);
      fleetChanges.touch();
    }
    return delivery!;
  }

  return { prepareFreeAgentIntent, prepareWorkHandoffIntent, deliverToSeat };
}
