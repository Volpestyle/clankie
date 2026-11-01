import { join } from "node:path";
import type { FleetRoomParty, WorkerReportRouting } from "@clankie/protocol";
import type { ProjectProcessProof } from "../project-process-proof.ts";
import type { CaptainOptions } from "./captain-types.ts";
import {
  captureConversationAuthority,
  captureNativeSeatAuthority,
  ConversationOwnerSchema,
  type ConversationOwner,
  type NativeSeatRecipient,
  type WorkerWriteAuthority,
} from "./conversation-owner.ts";
import type { ConversationStore } from "./conversations.ts";
import type { CaptainDeps } from "./deps.ts";
import { deliveryFingerprint } from "./delivery-fence.ts";
import type { FleetRoomRecord } from "./fleet-room.ts";
import { occupantIdForHerdrSession, type ObservedFleet } from "./herdr-census.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner, HerdrWatchStore } from "./herdr-watch.ts";
import { InboundSeatReceipts } from "./inbound-seat-receipts.ts";
import { nativeSessionId } from "./native-session-resume.ts";
import type { NextTurnMailbox } from "./next-turn-mailbox.ts";
import type { SeatOutbox } from "./seat-outbox.ts";

type RemoteFleet = NonNullable<CaptainDeps["fleets"]>["list"][number];

export interface NativeSourcesContext {
  readonly options: Pick<CaptainOptions, "stateDir">;
  readonly shutdown: AbortController;
  readonly conversations: ConversationStore;
  readonly herdrRunner: HerdrWatchRunner;
  readonly herdrWatches: HerdrWatchStore;
  readonly observeFleet: (localOnly?: boolean) => Promise<ObservedFleet>;
  readonly refreshFleets: () => Promise<unknown>;
  /** Read at call time: the captain replaces these as linked fleets change (ADR 0325). */
  readonly remoteFleets: readonly RemoteFleet[];
  readonly namedLocal: ReadonlyArray<{ id: string }>;
  readonly fleetIdentities: ReadonlyMap<string, string>;
  readonly validateConversationOwner: (owner: ConversationOwner) => Promise<boolean>;
  readonly seatOutboxes: ReadonlyMap<string, SeatOutbox>;
  readonly fleetMailboxes: ReadonlyMap<string, SeatOutbox>;
  readonly nextTurnMailboxes: NextTurnMailbox;
  readonly noteFleetRoom: (record: FleetRoomRecord) => void;
  readonly workerParty: (seatId: string) => FleetRoomParty;
  readonly leadParty: (conversationId: string) => FleetRoomParty;
}

/**
 * Proof of who a native pane is: inbound receipts, a conversation's native
 * source, a worker report's route to its lead, and a fleet seat's write authority.
 */
export function createNativeSources(ctx: NativeSourcesContext) {
  const {
    options,
    shutdown,
    conversations,
    herdrRunner,
    herdrWatches,
    observeFleet,
    refreshFleets,
    validateConversationOwner,
    seatOutboxes,
    fleetMailboxes,
    nextTurnMailboxes,
    noteFleetRoom,
    workerParty,
    leadParty,
  } = ctx;
  const inboundReceipts = new InboundSeatReceipts(
    join(options.stateDir, "delivery-receipts", "inbound.json"),
    conversations,
    {
      signal: shutdown.signal,
      // Recorded as it is accepted, so a report always sits before the reply it draws.
      accepted: ({ paneId, seatId, deliveryId, text, conversationId }) =>
        noteFleetRoom({
          id: `report:${deliveryId}`,
          at: new Date().toISOString(),
          kind: "worker_report",
          // A joined machine's worker has no local seat; its pane names it.
          from: seatId === undefined ? { kind: "worker", label: paneId.slice(0, 120) } : workerParty(seatId),
          to: leadParty(conversationId),
          text,
          thread: { conversationId },
          // Accepted into the lead's conversation; that is not the lead reading it.
          delivery: { stage: "stored" },
        }),
    },
  );
  function inboundBinding(agent: HerdrAgentSnapshot | undefined): string | undefined {
    if (!agent?.session || agent.agent === "shell" || agent.agent === "unknown") return undefined;
    return deliveryFingerprint(JSON.stringify([agent.paneId, agent.terminalId, agent.agent, agent.session]));
  }

  function observedAgent(
    seat:
      | NonNullable<Awaited<ReturnType<typeof observeFleet>>["head"]>
      | Awaited<ReturnType<typeof observeFleet>>["seats"][number],
  ): HerdrAgentSnapshot {
    return {
      paneId: seat.paneId,
      terminalId: seat.seatId,
      agent: seat.harness,
      status: seat.status,
      title: "title" in seat ? seat.title : "",
      ...(seat.session === undefined ? {} : { session: seat.session }),
    };
  }

  // A complete inventory that could not answer (an unreachable machine waits out
  // its ssh timeout, ~10s) resolves no source. Remember that briefly per source
  // so every head poll and ack does not wait for the same answer (VUH-2196).
  const unprovenSources = new Map<string, { key: string; until: number; detail: string }>();
  const UNPROVEN_SOURCE_RETRY_MS = 60_000;
  async function operatorNativeSource(
    conversationId: string,
    onUnproven?: (detail: string) => void,
  ): Promise<HerdrAgentSnapshot | undefined> {
    const refuse = (detail: string) => {
      onUnproven?.(detail);
      return undefined;
    };
    const fleet = await observeFleet(true);
    const occupants = [...(fleet.head === undefined ? [] : [fleet.head]), ...fleet.seats];
    const attached = occupants.filter(
      (candidate) => conversations.attachedConversationForNative(observedAgent(candidate)) === conversationId,
    );
    if (attached.length > 1) throw new Error("Native operator bridge has ambiguous conversation occupants");
    const source = attached[0] === undefined ? undefined : observedAgent(attached[0]);
    if (source !== undefined && conversations.nativeSource(conversationId) === undefined) {
      // A bare transcript ID is not a fleet binding. The fail-soft roster
      // cannot prove uniqueness: require every registered inventory to answer.
      const sessionId = nativeSessionId(source);
      let inventory: HerdrAgentSnapshot[];
      let unproven: string | undefined;
      try {
        if (herdrRunner.list === undefined) return refuse("Local Herdr inventory is unavailable.");
        await refreshFleets();
        const identities = JSON.stringify([...ctx.fleetIdentities]);
        unproven = JSON.stringify([inboundBinding(source), identities]);
        const remembered = unprovenSources.get(conversationId);
        if (remembered?.key === unproven && Date.now() < remembered.until) return refuse(remembered.detail);
        const list = async (id?: string) => {
          try {
            return await herdrRunner.list!(id);
          } catch (error) {
            throw new Error(`Herdr inventory ${id ?? "local"} did not answer: ${String(error)}`);
          }
        };
        inventory = (
          await Promise.all([
            list(),
            ...[...ctx.remoteFleets, ...ctx.namedLocal].map((fleet) => list(fleet.id)),
          ])
        ).flat();
        await refreshFleets();
        if (JSON.stringify([...ctx.fleetIdentities]) !== identities)
          return refuse("Herdr inventory identities changed during source proof.");
      } catch (error) {
        const detail = String(error);
        if (unproven !== undefined)
          unprovenSources.set(conversationId, {
            key: unproven,
            until: Date.now() + UNPROVEN_SOURCE_RETRY_MS,
            detail,
          });
        return refuse(detail);
      }
      unprovenSources.delete(conversationId);
      if (
        inventory.some(
          (candidate) =>
            candidate.agent !== "shell" &&
            candidate.agent !== "unknown" &&
            nativeSessionId(candidate) === undefined,
        )
      )
        return refuse("Herdr inventory has an occupant without a native session ID.");
      const matches = inventory.filter((candidate) => nativeSessionId(candidate) === sessionId);
      if (
        sessionId === undefined ||
        matches.length !== 1 ||
        inboundBinding(matches[0]!) !== inboundBinding(source)
      )
        return refuse(
          `Herdr inventory found ${String(matches.length)} matching native sessions for ${sessionId ?? "unknown"}; a unique matching binding is required.`,
        );
    }
    return source;
  }

  /** Shared report/roster projection. Only receiveFleetSeatMessage admits it. */
  async function workerReportRoute(
    agent: HerdrAgentSnapshot,
    fleet: Awaited<ReturnType<typeof observeFleet>>,
    admit = false,
  ): Promise<{
    owner: ConversationOwner;
    diagnostic: WorkerReportRouting;
    parent?: NativeSeatRecipient;
    native?: NativeSeatRecipient;
  }> {
    const defaultId = conversations.defaultGlobalConversationId();
    const child = fleet.seats.find((seat) => seat.paneId === agent.paneId);
    const reporterBinding = inboundBinding(agent);
    if (!child || reporterBinding === undefined || inboundBinding(observedAgent(child)) !== reporterBinding)
      throw new Error("Reporting native occupant is unavailable or changed in the census");
    const adopted = herdrWatches.nativeOwner(agent);
    if (adopted) {
      if (conversations.conversation(adopted.conversationId))
        return {
          owner: ConversationOwnerSchema.parse(adopted),
          diagnostic: { source: "adoption", conversationId: adopted.conversationId },
        };
      return {
        owner: { conversationId: defaultId },
        diagnostic: {
          source: "unadopted",
          reason: "owner_removed",
          conversationId: defaultId,
        },
      };
    }
    const pane = child.parentPaneId;
    const parent =
      pane === undefined
        ? undefined
        : (fleet.seats.find((seat) => seat.paneId === pane) ??
          (fleet.head?.paneId === pane ? fleet.head : undefined));
    const fallback = (reason: NonNullable<WorkerReportRouting["reason"]>) => ({
      owner: { conversationId: defaultId },
      diagnostic: {
        source: "unadopted" as const,
        reason,
        conversationId: defaultId,
        ...(pane === undefined ? {} : { leadPaneId: pane }),
        ...(parent === undefined ? {} : { leadSeatId: parent.seatId }),
      },
    });
    if (pane === undefined) return fallback("no_parent");
    if (!parent?.session || parent.paneId === agent.paneId) return fallback("parent_unavailable");
    const source = observedAgent(parent);
    const binding = inboundBinding(source);
    if (!binding) return fallback("parent_unavailable");
    const parentOwner = herdrWatches.nativeOwner(source);
    if (parentOwner?.discord !== undefined && !(await validateConversationOwner(parentOwner)))
      throw new Error("Original parent room authority is unavailable");
    const recipient: NativeSeatRecipient = {
      kind: "native",
      paneId: parent.paneId,
      seatId: parent.seatId,
      occupantId: occupantIdForHerdrSession(parent.session),
      binding,
      ...(parentOwner === undefined ? {} : { owner: parentOwner }),
    };
    const attached = conversations.attachedConversationForNative(source);
    if (attached !== undefined && !conversations.nativeSource(attached)) {
      const sessionId = (session: NonNullable<HerdrAgentSnapshot["session"]>) =>
        session.kind === "id"
          ? session.value
          : session.value
              .split(/[\\/]/u)
              .at(-1)
              ?.replace(/\.jsonl$/u, "");
      const occupants = [...fleet.seats, ...(fleet.head === undefined ? [] : [fleet.head])].filter(
        (seat) => seat.session !== undefined && sessionId(seat.session) === sessionId(parent.session!),
      );
      if (occupants.length !== 1)
        throw new Error("Parent native-session attachment is ambiguous across fleets");
    }
    if (
      attached !== undefined &&
      conversations.conversation(attached)?.scope.kind === "room" &&
      (parentOwner?.conversationId !== attached || parentOwner.discord === undefined)
    )
      throw new Error("Parent room attachment lacks original Discord authority");
    if (admit && attached !== undefined)
      await conversations.waitForDriverAdmission(attached, shutdown.signal);
    if (
      attached !== undefined &&
      (seatOutboxes.get(attached)?.bound() || seatOutboxes.get(attached)?.uncertain())
    ) {
      return {
        owner: parentOwner?.conversationId === attached ? parentOwner : { conversationId: attached },
        parent: recipient,
        diagnostic: {
          source: "parent",
          leadPaneId: pane,
          leadSeatId: parent.seatId,
          conversationId: attached,
        },
      };
    }
    const linked =
      fleetMailboxes.get(parent.seatId)?.boundTo(binding) ||
      nextTurnMailboxes.observed(parent.seatId, binding) ||
      (await herdrWatches.nativeRouteAvailable(source));
    if (!linked) return fallback("parent_unlinked");
    const nativeConversation = conversations.nativeConversationForSeat(source);
    return {
      owner: { conversationId: defaultId },
      parent: recipient,
      native: recipient,
      diagnostic: {
        source: "parent",
        leadPaneId: pane,
        leadSeatId: parent.seatId,
        ...(nativeConversation === undefined
          ? {}
          : {
              conversationId: nativeConversation.conversationId,
            }),
      },
    };
  }

  async function nativeRecipientCurrent(recipient: NativeSeatRecipient): Promise<boolean> {
    // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); a missing pane or proof means no current source.
    const agent = await herdrRunner.get(recipient.paneId).catch(() => undefined);
    return (
      agent?.session !== undefined &&
      agent.terminalId === recipient.seatId &&
      occupantIdForHerdrSession(agent.session) === recipient.occupantId &&
      inboundBinding(agent) === recipient.binding &&
      (recipient.owner === undefined || (await validateConversationOwner(recipient.owner)))
    );
  }

  async function fleetWriteAuthority(
    principalId: string,
    nativeWriteProof?: () => Promise<ProjectProcessProof | undefined>,
  ): Promise<WorkerWriteAuthority | undefined> {
    const match = /^fleet:([^:]+):pane:(.+)$/u.exec(principalId);
    if (!match || match[2] === "unverified" || !nativeWriteProof) return undefined;
    const pane = match[1] === "default" ? match[2]! : `${match[1]}/${match[2]}`;
    // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); a missing pane or proof means no current source.
    const agent = await herdrRunner.get(pane).catch(() => undefined);
    const binding = inboundBinding(agent);
    if (!agent?.session || !binding) return undefined;
    const occupantId = occupantIdForHerdrSession(agent.session);
    const prove = async () => {
      // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); a missing pane or proof means no current source.
      const proof = await nativeWriteProof().catch(() => undefined);
      return (
        proof !== undefined &&
        !proof.nativeSessionPending &&
        proof.fleet === match[1] &&
        proof.pane === match[2] &&
        proof.nativeOccupantId === occupantId
      );
    };
    if (!(await prove())) return undefined;
    let owner: ConversationOwner | undefined;
    try {
      owner = herdrWatches.nativeOwner(agent);
    } catch {
      return undefined;
    }
    if (owner !== undefined && !(await validateConversationOwner(owner))) return undefined;
    const native = captureNativeSeatAuthority({
      recipient: {
        kind: "native",
        paneId: agent.paneId,
        seatId: agent.terminalId,
        occupantId,
        binding,
        ...(owner === undefined ? {} : { owner }),
      },
      current: () => owner === undefined || conversations.conversation(owner.conversationId) !== undefined,
      authorize: async () => (await nativeRecipientCurrent(native.recipient)) && (await prove()),
    });
    if (!(await native.authorize())) return undefined;
    if (owner === undefined) return { nativeRecipientAuthority: native };
    const conversationAuthority = captureConversationAuthority({
      owner,
      current: native.current,
      authorize: async () => {
        if (!(await native.authorize())) return false;
        // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); a missing pane or proof means no current source.
        const latest = await herdrRunner.get(pane).catch(() => undefined);
        if (!latest) return false;
        try {
          return JSON.stringify(herdrWatches.nativeOwner(latest)) === JSON.stringify(native.recipient.owner);
        } catch {
          return false;
        }
      },
    });
    return { nativeRecipientAuthority: native, conversationAuthority };
  }

  return {
    inboundReceipts,
    inboundBinding,
    observedAgent,
    operatorNativeSource,
    workerReportRoute,
    nativeRecipientCurrent,
    fleetWriteAuthority,
  };
}
