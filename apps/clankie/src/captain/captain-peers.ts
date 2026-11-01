import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { operatorAgentRoleKey, type FleetRoomParty } from "@clankie/protocol";
import { projectRoleForPersona, type ClankieSettings } from "@clankie/settings";
import { resolveFleetSettingsContext } from "../fleet-settings-context.ts";
import type { DeliverToSeat, RefreshFleet, WakeConversation } from "./captain-context.ts";
import type { CaptainOptions } from "./captain-types.ts";
import type { ConversationStore } from "./conversations.ts";
import type { SeatMessageWindow } from "./fleet-edges.ts";
import type { FleetRoomRecord } from "./fleet-room.ts";
import type { ObservedHeadSeat } from "./herdr-census.ts";
import type { FleetChangeClock } from "./herdr-fleet-changes.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner, HerdrWatchStore } from "./herdr-watch.ts";
import { createHuddleService, HuddleStore, type HuddleSeatTarget } from "./huddles.ts";
import { PeerSeatMessages } from "./peer-seat-messages.ts";
import { localWorkspaceProject, reviewCheckoutProject } from "./project-hire-context.ts";
import { ReviewGate } from "./review-gate.ts";

export interface PeersContext {
  readonly options: Pick<CaptainOptions, "stateDir">;
  readonly settings: () => Promise<ClankieSettings>;
  readonly conversations: ConversationStore;
  readonly herdrRunner: HerdrWatchRunner;
  readonly herdrWatches: HerdrWatchStore;
  /** Read at call time: the captain rebinds its head seat as the head pane moves (ADR 0325). */
  readonly headSeat: ObservedHeadSeat | undefined;
  readonly refreshFleet: RefreshFleet;
  readonly deliverToSeat: DeliverToSeat;
  readonly wakeConversation: WakeConversation;
  readonly fleetChanges: FleetChangeClock;
  readonly seatMessages: SeatMessageWindow;
  readonly noteFleetRoom: (record: FleetRoomRecord) => void;
  readonly workerParty: (seatId: string) => FleetRoomParty;
  readonly leadParty: (conversationId: string) => FleetRoomParty;
}

/** Huddles, peer messages between seats, and the standing review gate. */
export function createPeers(ctx: PeersContext) {
  const {
    options,
    settings,
    conversations,
    herdrRunner,
    herdrWatches,
    refreshFleet,
    deliverToSeat,
    wakeConversation,
    fleetChanges,
    seatMessages,
    noteFleetRoom,
    workerParty,
    leadParty,
  } = ctx;
  // Huddles (VUH-2025): one structured question to every seat, answered
  // between steps through message_clankie, compiled into one lead wake.
  // A seat's repository by its git common directory, so worktrees of one repo share it.
  const huddleWorkRepo = (cwd: string): Promise<{ workRepo?: string }> =>
    new Promise((resolve) =>
      execFile(
        "git",
        ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { timeout: 2_000 },
        (error, stdout) => {
          const common = error ? "" : String(stdout).trim();
          resolve(common ? { workRepo: basename(dirname(common)) } : {});
        },
      ),
    );
  const huddleService = createHuddleService({
    store: new HuddleStore(join(options.stateDir, "huddles.json")),
    defaultConversation: () => conversations.defaultGlobalConversationId(),
    projectExists: async (project) =>
      (await settings()).projects.projects.some((entry) => entry.id === project),
    async seats(project) {
      const current = await settings();
      const fleet = await refreshFleet({ force: true });
      // A head is any seat whose conversation owns another seat (the main,
      // native and remote-lead heads alike).
      const leading = new Set(fleet.flatMap((seat) => (seat.owner ? [seat.owner.conversationId] : [])));
      const targets: HuddleSeatTarget[] = [];
      for (const seat of fleet) {
        const leads =
          seat.seatId === ctx.headSeat?.seatId ||
          [seat.conversationId, conversations.conversationIdForSeat(seat.seatId)].some(
            (id) => id !== undefined && leading.has(id),
          );
        if (project !== undefined) {
          const seatProject =
            seat.workingDirectory === undefined || seat.fleet !== undefined
              ? undefined
              : // allow-swallowed-rejection -- moved unchanged from captain.ts (ADR 0325); a pane or project that can't be read counts as absent.
                await localWorkspaceProject(current.projects, seat.workingDirectory).catch(() => undefined);
          if (seatProject !== project) continue;
        }
        targets.push({
          seatId: seat.seatId,
          title: seat.title || seat.seatId,
          harness: seat.harness,
          ...(seat.fleet === undefined ? {} : { fleet: seat.fleet }),
          ...(seat.workingDirectory === undefined ? {} : { workingDirectory: seat.workingDirectory }),
          ...(seat.fleet !== undefined || seat.workingDirectory === undefined
            ? {}
            : await huddleWorkRepo(seat.workingDirectory)),
          ...(seat.owner === undefined ? {} : { leadConversationId: seat.owner.conversationId }),
          ...(leads ? { leads } : {}),
        });
      }
      return targets;
    },
    deliver: async (seat, text, conversationId) =>
      (await deliverToSeat(seat.seatId, text, { conversationId, source: "huddle" })).outcome,
    wake: (conversationId, text) =>
      wakeConversation({ conversationId }, text, undefined, "machine", true, false),
    changed: () => fleetChanges.touch(),
  });
  herdrWatches.huddles = huddleService;

  const peerMessages = new PeerSeatMessages({
    path: join(options.stateDir, "delivery-receipts", "peer-messages.json"),
    enabled: async () => (await settings()).fleet.peerMessages === "on",
    // allow-swallowed-rejection -- moved unchanged from captain.ts (ADR 0325); a pane or project that can't be read counts as absent.
    sender: (pane) => herdrRunner.get(pane).catch(() => undefined),
    // allow-swallowed-rejection -- moved unchanged from captain.ts (ADR 0325); a pane or project that can't be read counts as absent.
    recipient: (seat) => herdrRunner.resolveTerminal(seat).catch(() => undefined),
    // A linked machine's seat lists its own machine's inventory (VUH-2616).
    seats: (fleet) => herdrRunner.list?.(fleet === "default" ? undefined : fleet) ?? Promise.resolve([]),
    // Seats on other machines reach each other only under one lead (VUH-2923).
    lead: (agent) => herdrWatches.nativeOwner(agent),
    leadSeats: async (lead) => {
      const seats = (await refreshFleet()).filter(
        (seat) => seat.owner?.conversationId === lead.conversationId,
      );
      const resolved = await Promise.all(
        // allow-swallowed-rejection -- A seat Herdr cannot resolve is no live peer.
        seats.map((seat) => herdrRunner.resolveTerminal(seat.seatId).catch(() => undefined)),
      );
      return resolved.filter((seat): seat is HerdrAgentSnapshot => seat !== undefined);
    },
    deliver: (seat, text, deliveryOptions) =>
      deliverToSeat(
        seat,
        text,
        {
          conversationId: conversations.defaultGlobalConversationId(),
          source: "peer",
        },
        deliveryOptions,
      ),
    confirmed: ({ sender, recipient, text, deliveryId, senderOccupantId, recipientOccupantId }) => {
      seatMessages.record({
        kind: "prompt",
        fromSeatId: sender,
        toSeatId: recipient,
        deliveryId,
        fromOccupantId: senderOccupantId,
        toOccupantId: recipientOccupantId,
        text: text.slice(0, 1000),
        at: Date.now(),
      });
      fleetChanges.touch();
    },
    record: ({ sender, recipient, message, text, receipt, final }) => {
      if (final && (receipt.outcome === "delivered" || receipt.outcome === "unconfirmed"))
        noteFleetRoom({
          id: `peer:${receipt.deliveryId}`,
          at: new Date().toISOString(),
          kind: "peer_message",
          from: workerParty(sender),
          to: workerParty(recipient),
          text,
          delivery: {
            stage:
              receipt.deliveryStage === "recipient_gone" || receipt.deliveryStage === "superseded"
                ? "uncertain"
                : receipt.deliveryStage,
          },
        });
      return conversations.publishFleetPeerExchange(
        `${message}\n\nPeer delivery receipt: ${JSON.stringify(receipt)}`,
      );
    },
  });

  // The standing review gate (ADR 0287): the service routes candidates and
  // verdicts itself, so neither direction needs a lead relay or a peer channel.
  // The named checkout decides; a seat's own directory is only where its session started.
  const reviewProject = async (agent: HerdrAgentSnapshot, checkout = agent.workingDirectory) =>
    reviewCheckoutProject(await settings(), agent.paneId, checkout);
  const reviews = new ReviewGate({
    path: join(options.stateDir, "reviews", "candidates.json"),
    review: async (projectId) =>
      (await settings()).projects.projects.find((project) => project.id === projectId)?.review,
    // allow-swallowed-rejection -- A seat Herdr cannot read is no proven seat; the gate refuses it.
    seat: (pane) => herdrRunner.get(pane).catch(() => undefined),
    // allow-swallowed-rejection -- A seat Herdr cannot resolve gets no verdict notice; the record keeps it.
    resolve: (seatId) => herdrRunner.resolveTerminal(seatId).catch(() => undefined),
    // allow-swallowed-rejection -- An unresolvable checkout submits nothing (no_project).
    seatProject: (agent, checkout) => reviewProject(agent, checkout).catch(() => undefined),
    // Fails loudly: an unreadable checkout must not read as "no reviewer, landable".
    directoryProject: async (directory) =>
      (
        await resolveFleetSettingsContext(
          await settings(),
          { workingDirectory: directory, machine: "local" },
          {},
        )
      ).projectId,
    async reviewers(projectId, review) {
      if ("seat" in review) {
        // allow-swallowed-rejection -- A named seat Herdr cannot resolve is not a live reviewer.
        const seat = await herdrRunner.resolveTerminal(review.seat).catch(() => undefined);
        return seat?.session === undefined ? [] : [seat];
      }
      const projects = (await settings()).projects;
      const holders = (await refreshFleet()).filter(
        (seat) =>
          operatorAgentRoleKey(projectRoleForPersona(projects, seat.personaId, projectId) ?? "") ===
          operatorAgentRoleKey(review.role),
      );
      const resolved = await Promise.all(
        // allow-swallowed-rejection -- A role holder Herdr cannot resolve is not a live reviewer.
        holders.map((seat) => herdrRunner.resolveTerminal(seat.seatId).catch(() => undefined)),
      );
      return resolved
        .filter((seat): seat is HerdrAgentSnapshot => seat?.session !== undefined)
        .sort((left, right) => left.terminalId.localeCompare(right.terminalId));
    },
    lead: (agent) => herdrWatches.nativeOwner(agent),
    deliver: (seatId, text, conversationId) =>
      deliverToSeat(seatId, text, {
        conversationId: conversationId ?? conversations.defaultGlobalConversationId(),
        source: "review",
      }),
    async notifyLead(owner, text) {
      const lead = owner ?? { conversationId: conversations.defaultGlobalConversationId() };
      // Durable in the lead's chat on every surface, even when its woken turn fails.
      conversations.recordServiceNotice(lead.conversationId, text);
      await wakeConversation(lead, text, undefined, "machine", true).catch(() => false);
    },
    room: ({ id, kind, from, to, text }) =>
      noteFleetRoom({
        id,
        at: new Date().toISOString(),
        kind: kind === "waiver" ? "lead_message" : "peer_message",
        from:
          "seatId" in from
            ? workerParty(from.seatId)
            : from.actor === "lead" && from.conversationId !== undefined
              ? leadParty(from.conversationId)
              : { kind: "owner", label: "Owner" },
        to: to === undefined ? null : workerParty(to.seatId),
        text,
      }),
  });

  herdrWatches.reviews = reviews;

  return { huddleService, peerMessages, reviews };
}
