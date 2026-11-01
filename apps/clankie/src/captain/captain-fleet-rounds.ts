import { SeatEfficiencyStore } from "./seat-efficiency.ts";
import {
  autoTidyHeldReview,
  fleetReviewContext,
  fleetRoundEvidence,
  pendingQuestionReview,
  startFleetRounds,
} from "./fleet-review.ts";
import { FleetEfficiencyReviewSchema, type FleetEfficiencyReview } from "./fleet-efficiency-tools.ts";
import { type OperatorFleetSeat } from "@clankie/protocol";
import { type ClankieSettings } from "@clankie/settings";
import { type CaptainOptions } from "./captain-types.ts";
import { createCaptainAutoTidy } from "./captain-auto-tidy.ts";
import { createLeadSeats } from "./captain-lead-seats.ts";
import {
  assertConversationAuthority,
  type ConversationOwner,
  type ConversationAuthority,
} from "./conversation-owner.ts";
import { ConversationStore } from "./conversations.ts";
import type { CaptainDeps } from "./deps.ts";
import { type ObservedFleetSeat } from "./herdr-census.ts";
import { FleetChangeClock } from "./herdr-fleet-changes.ts";
import { HerdrWatchStore } from "./herdr-watch.ts";
import { SeatIssueKeeper } from "./seat-issue-status.ts";
import { createWorkerAccountsReader } from "./harness-accounts.ts";
import { AccountUsageNotices } from "./account-allocation.ts";
import { SeatOutbox } from "./seat-outbox.ts";

import type { RefreshFleet, WakeConversation } from "./captain-context.ts";
import type { OperatorFleetReadWarnings } from "@clankie/protocol";

export interface FleetRoundsContext {
  readonly options: CaptainOptions;
  readonly deps: CaptainDeps;
  readonly shutdown: AbortController;
  readonly settings: () => Promise<ClankieSettings>;
  readonly conversations: ConversationStore;
  readonly herdrWatches: HerdrWatchStore;
  readonly seatLeadOwners: WeakMap<
    OperatorFleetSeat,
    { owner: ConversationOwner; admitted: boolean; observed: ObservedFleetSeat }
  >;
  readonly seatOutbox: (conversationId: string) => SeatOutbox;
  readonly refreshFleet: RefreshFleet;
  readonly boundedFleetRead: (timeoutMs: number) => {
    readonly deadline: number;
    readonly readWarnings: OperatorFleetReadWarnings;
    readonly bounded: <T>(source: string, read: Promise<T>) => Promise<{ value: T } | undefined>;
  };
  readonly FLEET_EFFICIENCY_DEADLINE_MS: number;
  readonly fleetChanges: FleetChangeClock;
  readonly unansweredFleetSources: ReadonlySet<string>;
  readonly seatEfficiency: SeatEfficiencyStore;
  readonly readWorkerAccounts: ReturnType<typeof createWorkerAccountsReader>;
  readonly validateConversationOwner: (owner: ConversationOwner) => Promise<boolean>;
  readonly wakeConversation: WakeConversation;
  readonly privateLeadConversation: (id?: string) => boolean;
  readonly issueStatus: SeatIssueKeeper;
  /** Read at call time: built after the rounds start, or replaced as the fleet is read (ADR 0325). */
  readonly leadFailover: ReturnType<typeof createLeadSeats>["leadFailover"];
  readonly autoTidy: ReturnType<typeof createCaptainAutoTidy>["autoTidy"];
  readonly fleetRefresh: Promise<readonly OperatorFleetSeat[]> | undefined;
  readonly lastProjectedSeats: readonly OperatorFleetSeat[];
}

/**
 * Fleet rounds: each lead's periodic round over its seats, usage-limit and
 * run-out notices, and the fleet efficiency review.
 */
export function createFleetRounds(ctx: FleetRoundsContext) {
  const {
    options,
    deps,
    shutdown,
    settings,
    conversations,
    herdrWatches,
    seatLeadOwners,
    seatOutbox,
    refreshFleet,
    boundedFleetRead,
    FLEET_EFFICIENCY_DEADLINE_MS,
    fleetChanges,
    unansweredFleetSources,
    seatEfficiency,
    readWorkerAccounts,
    validateConversationOwner,
    wakeConversation,
    privateLeadConversation,
    issueStatus,
  } = ctx;
  async function ledSeats(owner: ConversationOwner, force = false) {
    const seats = await refreshFleet({ force });
    return seats.filter((seat) => JSON.stringify(seatLeadOwners.get(seat)?.owner) === JSON.stringify(owner));
  }
  /**
   * A native lead seat that refuses turns on a usage limit stops receiving
   * wakes and rounds until it resets; they run on the service lane meanwhile
   * (VUH-2273). The conversation hears once when that starts.
   */
  function observeSeatUsageLimit(
    conversationId: string,
    entries: readonly import("@clankie/agent-transcript").SeatTranscriptUpload["entries"][number][],
  ): void {
    const limited = seatOutbox(conversationId).observeAgentMessages(
      entries.flatMap((entry) => (entry.type === "message" && entry.role === "agent" ? [entry] : [])),
    );
    if (!limited) return;
    conversations.recordServiceNotice(
      conversationId,
      `Your native seat hit its ${limited.window === "other" ? "usage" : limited.window} limit (resets ${new Date(limited.until).toISOString()}). Until then, wakes and rounds run on Clankie's service lane instead of being sent into it.`,
    );
    // A local lead moves to the account with the most headroom; a remote head has no local launcher.
    if (conversations.runsCaptainTurns(conversationId))
      void ctx.leadFailover
        .limited(conversationId, limited)
        .catch((error: unknown) => console.warn("Lead seat failover failed", conversationId, String(error)));
  }

  const efficiencyActions = {
    async run(authority: ConversationAuthority, input?: FleetEfficiencyReview) {
      // One deadline for the whole call, so the CLI hears an answer before its
      // own abort. Explicit inspection never reuses a completed projection
      // (Git and native files change without a fleet event): a census still
      // running answers when no fleet change landed during it, otherwise one
      // starts after this request. Waiting out a running census and then a
      // forced one could not fit the deadline while a linked fleet stays
      // silent (LOCAL-VUH-19).
      const { readWarnings, bounded } = boundedFleetRead(
        options.fleetEfficiencyDeadlineMs ?? FLEET_EFFICIENCY_DEADLINE_MS,
      );
      const review = input === undefined ? undefined : FleetEfficiencyReviewSchema.parse(input);
      // Renew admission before the native census that proves ownership.
      await assertConversationAuthority(authority);
      const cursor = fleetChanges.current();
      let observed = await bounded(
        "native_fleet_projection",
        ctx.fleetRefresh ?? refreshFleet({ force: true }),
      );
      if (observed !== undefined && cursor !== fleetChanges.current())
        observed = await bounded("native_fleet_projection", refreshFleet({ force: true }));
      // A late census never records this review; the caller hears that nothing was written.
      if (observed === undefined && review)
        throw new Error(
          `Review not recorded; nothing was written. ${readWarnings.map((warning) => warning.message).join(" ")}`,
        );
      for (const source of [...unansweredFleetSources].slice(0, 16 - readWarnings.length))
        readWarnings.push({
          source,
          reason: "unavailable",
          message: `${source} did not answer the latest census; its seats are unknown, not absent.`,
        });
      const owned = (observed?.value ?? ctx.lastProjectedSeats).filter(
        (seat) => JSON.stringify(seatLeadOwners.get(seat)?.owner) === JSON.stringify(authority.owner),
      );
      const answer = (seats: readonly OperatorFleetSeat[]) => ({
        conversationId: authority.owner.conversationId,
        seats,
        ...(readWarnings.length === 0 ? {} : { readWarnings }),
      });
      if (!review) {
        await assertConversationAuthority(authority);
        return answer(owned);
      }
      const seat = owned.find((candidate) => candidate.seatId === review.seatId);
      if (!seat) throw new Error("This conversation does not lead that native seat");
      if (!seatLeadOwners.get(seat)?.admitted)
        throw new Error("The native occupant must be re-adopted before recording a review");
      // No await separates this census's ownership proof from writing the display-only review.
      if (!authority.current()) throw new Error("Native seat ownership changed during review");
      const { seatId: _seat, ...finding } = review;
      const efficiency = seatEfficiency.review({
        occupantId: seat.occupantId,
        owner: authority.owner,
        ...finding,
      });
      fleetChanges.touch();
      return {
        ...answer(owned.map((candidate) => (candidate === seat ? { ...seat, efficiency } : candidate))),
        review: { seatId: seat.seatId, occupantId: seat.occupantId, reviewedAt: efficiency.reviewedAt! },
      };
    },
  };
  herdrWatches.efficiency = efficiencyActions;
  herdrWatches.workerAccountsReport = (fleet) => readWorkerAccounts(fleet);
  const pendingFleetRounds = new Set<string>();
  const completedFleetRounds = new Map<string, string>();
  // Each lead hears a run-out projection once per window reset (VUH-1974).
  const usageNotices = new Map<string, AccountUsageNotices>();
  const usageNoticeOwners = new Map<string, ConversationOwner>();
  const warnRunOuts = async (owners: ReadonlyMap<string, ConversationOwner>) => {
    const usage = (await settings()).usage;
    if (!usage.runOutWarning || shutdown.signal.aborted) return;
    const reading = await readWorkerAccounts(undefined, ["claude", "codex"]);
    for (const [ownerKey, owner] of owners) {
      const notices = usageNotices.get(ownerKey) ?? new AccountUsageNotices();
      usageNotices.set(ownerKey, notices);
      const fresh = notices.pending(reading, usage);
      if (!fresh.length || !(await validateConversationOwner(owner))) continue;
      const accepted = await wakeConversation(
        owner,
        fresh.map((warning) => warning.text).join("\n\n"),
        async () => {
          if (shutdown.signal.aborted) throw new Error("Usage warning stopped");
        },
        "machine",
        false,
        false,
      );
      if (!accepted) continue;
      notices.delivered(fresh);
      usageNoticeOwners.set(ownerKey, owner);
    }
  };
  const stopFleetRounds = startFleetRounds(async () => {
    if (shutdown.signal.aborted) return;
    const seats = await refreshFleet();
    // Keep checking a warned lead even after its last seat finishes.
    const owners = new Map(usageNoticeOwners);
    for (const seat of seats) {
      const owner = seatLeadOwners.get(seat)?.owner;
      if (owner) owners.set(JSON.stringify(owner), owner);
    }
    const pendingQuestions = conversations.pendingLeadQuestions();
    for (const pending of pendingQuestions) {
      if (!pendingQuestionReview([pending]) || !privateLeadConversation(pending.conversationId)) continue;
      if (![...owners.values()].some((owner) => owner.conversationId === pending.conversationId)) {
        const owner = { conversationId: pending.conversationId };
        owners.set(JSON.stringify(owner), owner);
      }
    }
    for (const ownerKey of completedFleetRounds.keys()) {
      if (!owners.has(ownerKey)) completedFleetRounds.delete(ownerKey);
    }
    // Once a day the lead hears every In Progress issue no live seat owns (VUH-1990).
    void issueStatus
      .dailyCheck()
      .then(async (text) => {
        if (text === undefined || shutdown.signal.aborted) return;
        const lead = { conversationId: conversations.defaultGlobalConversationId() };
        if (!(await wakeConversation(lead, text, undefined, "machine", true, false)))
          console.warn("Daily issue status check was not delivered");
      })
      .catch((error: unknown) => {
        if (!shutdown.signal.aborted) console.warn("Daily issue status check unavailable", String(error));
      });
    if (owners.size)
      await warnRunOuts(owners).catch((error: unknown) => {
        if (!shutdown.signal.aborted) console.warn("Usage warning unavailable", String(error));
      });
    for (const [ownerKey, owner] of owners) {
      if (pendingFleetRounds.has(ownerKey)) continue;
      try {
        if (!(await validateConversationOwner(owner))) continue;
        const current = await ledSeats(owner);
        const questionNotice = pendingQuestionReview(
          pendingQuestions.filter((pending) => pending.conversationId === owner.conversationId),
        );
        if ((!current.length && !questionNotice) || shutdown.signal.aborted) continue;
        // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); unreadable deploy holds mean none to report.
        const holds = (await deps.deployHolds?.().catch(() => undefined)) ?? [];
        const disk = options.fleetResources?.status()?.pressure;
        const diskNotice = disk?.diskWarning
          ? `Low disk: ${disk.freeDiskGb?.toFixed(1)} GiB free. Inspect clankie doctor before starting more work.\n`
          : "";
        const held = autoTidyHeldReview(ctx.autoTidy.held(owner.conversationId));
        const evidence = fleetRoundEvidence(current, holds);
        const roundKey = held.key ? `${evidence.fingerprint}:${held.key}` : evidence.fingerprint;
        if (
          !diskNotice &&
          !questionNotice &&
          !evidence.flagged &&
          completedFleetRounds.get(ownerKey) === roundKey
        )
          continue;
        pendingFleetRounds.add(ownerKey);
        void wakeConversation(
          owner,
          [
            diskNotice,
            questionNotice,
            held.text,
            fleetReviewContext(
              current,
              Math.max(0, 10_000 - diskNotice.length - questionNotice.length - held.text.length - 3),
              holds,
            ),
          ]
            .filter(Boolean)
            .join("\n"),
          async () => {
            if (
              shutdown.signal.aborted ||
              (!(await ledSeats(owner)).length &&
                !pendingQuestionReview(
                  conversations
                    .pendingLeadQuestions()
                    .filter((pending) => pending.conversationId === owner.conversationId),
                ))
            )
              throw new Error("Fleet review stopped or has no owned seats or pending questions");
            if (shutdown.signal.aborted) throw new Error("Fleet review stopped");
          },
          "machine",
          false,
          true,
        )
          .then((accepted) => {
            if (accepted) completedFleetRounds.set(ownerKey, roundKey);
          })
          .catch((error: unknown) => {
            if (!shutdown.signal.aborted)
              console.warn("Fleet lead round unavailable", owner.conversationId, String(error));
          })
          .finally(() => pendingFleetRounds.delete(ownerKey));
      } catch (error) {
        if (!shutdown.signal.aborted)
          console.warn("Fleet lead round unavailable", owner.conversationId, String(error));
      }
    }
  }, options.fleetRoundIntervalMs);

  return { ledSeats, observeSeatUsageLimit, efficiencyActions, stopFleetRounds };
}
