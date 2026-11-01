import type { LeadRestartStatus } from "@clankie/protocol";
import { startFleetRounds } from "./fleet-review.ts";
import { inspectHerdrSeatTranscriptPathAsync } from "@clankie/agent-transcript";
import { createLeadSeatRelaunch, readClaudeSessionUsage } from "./lead-seat-relaunch.ts";
import { createHiredSeatRestarts, RestartRefusal } from "./hired-seat-restarts.ts";
import { readHiredRestartObservation } from "./hired-restart-observation.ts";
import { createLeadSeatFailover } from "./lead-seat-failover.ts";
import { SettingsStore, type ClankieSettings } from "@clankie/settings";
import { join } from "node:path";
import { type CaptainOptions } from "./captain-types.ts";
import { createNativeSources } from "./captain-native-sources.ts";
import { type ConversationOwner } from "./conversation-owner.ts";
import { ConversationStore } from "./conversations.ts";
import type { CaptainDeps } from "./deps.ts";
import { occupantIdForHerdrSession, type ObservedHeadSeat } from "./herdr-census.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "./herdr-watch.ts";
import { nativeSessionId } from "./native-session-resume.ts";
import { prepareSeatIssueAttribution } from "./seat-issue-status.ts";
import { createWorkerAccountsReader } from "./harness-accounts.ts";
import { SeatOutbox } from "./seat-outbox.ts";

import type { WatchGate } from "../watch.ts";
import type { HerdrWatchRunner } from "./herdr-watch.ts";

/** How often the service considers a fresh restart of the default lead seat (ADR 0271). */
const LEAD_RESTART_CHECK_MS = 5 * 60_000;
/** ADR 0293's accepted work budget, independent of Claude's model window. */
export const LEAD_RESTART_CONTEXT_TOKENS = 250_000;
export const LEAD_RESTART_AGE_MS = 12 * 60 * 60_000;
/** The owner has not written for this long, from the pane or any app. */
const LEAD_RESTART_QUIET_OWNER_MS = 15 * 60_000;
/** A brief that did not lead to a restart is not asked for again sooner than this. */
const LEAD_RESTART_RETRY_MS = 60 * 60_000;
const LEAD_HANDOFF_REQUEST = [
  "Scheduled fresh restart (ADR 0271 / 0293). Your session reached 250K context tokens or 12 hours, so Clankie will relaunch you fresh in this pane once this turn ends. The previous session stays resumable.",
  "Answer this escalation with `reply` and a handoff brief for your successor, who starts from the shared conversation log plus this brief: work in flight and its owners, decisions waiting on James, commitments and timers you hold, and anything you would otherwise lose. Keep it under 2,000 words. Do nothing else in this turn.",
].join("\n\n");

export interface LeadSeatsContext {
  readonly options: CaptainOptions;
  readonly deps: CaptainDeps;
  readonly shutdown: AbortController;
  readonly watch: WatchGate;
  readonly settings: () => Promise<ClankieSettings>;
  readonly settingsStore: SettingsStore;
  readonly conversations: ConversationStore;
  readonly herdrRunner: HerdrWatchRunner;
  readonly herdrWatches: HerdrWatchStore;
  readonly seatOutboxes: ReadonlyMap<string, SeatOutbox>;
  readonly seatOutbox: (conversationId: string) => SeatOutbox;
  readonly seatContext: (conversationId: string) => { readonly cwd?: string | undefined } | undefined;
  /** Read at call time: the captain proves native sources after this (ADR 0325). */
  readonly inboundBinding: ReturnType<typeof createNativeSources>["inboundBinding"];
  readonly operatorNativeSource: ReturnType<typeof createNativeSources>["operatorNativeSource"];
  readonly readWorkerAccounts: ReturnType<typeof createWorkerAccountsReader>;
  readonly validateConversationOwner: (owner: ConversationOwner) => Promise<boolean>;
  /** Read at call time: the captain binds its head seat later (ADR 0325). */
  readonly headSeat: ObservedHeadSeat | undefined;
}

/**
 * Lead seats: fresh restarts of the default lead (ADR 0271), usage-limit
 * failover and failback, and restarts of hired seats.
 */
export function createLeadSeats(ctx: LeadSeatsContext) {
  const {
    options,
    deps,
    shutdown,
    watch,
    settings,
    settingsStore,
    conversations,
    herdrRunner,
    herdrWatches,
    seatOutboxes,
    seatOutbox,
    seatContext,
    readWorkerAccounts,
    validateConversationOwner,
  } = ctx;
  // ADR 0271: the default lead seat restarts fresh in its own pane instead of
  // compacting for days. VUH-2273 moves a usage-limited seat with the same call.
  const leadSeatPane = (source: HerdrAgentSnapshot) => {
    const sessionId = nativeSessionId(source);
    const binding = ctx.inboundBinding(source);
    return {
      paneId: source.paneId,
      terminalId: source.terminalId,
      harness: source.agent,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(binding === undefined ? {} : { binding }),
    };
  };
  const leadSeats = createLeadSeatRelaunch({
    journalPath: join(options.stateDir, "lead-seat-relaunches.json"),
    seat: async (conversationId) => {
      const source = await ctx.operatorNativeSource(conversationId);
      // The launcher resolves --conversation through seat-context, which can
      // override the shell cwd. Check the directory it will actually launch in.
      const directory = seatContext(conversationId)?.cwd;
      return source === undefined
        ? undefined
        : {
            ...leadSeatPane(source),
            ...(directory === undefined ? {} : { workingDirectory: directory }),
          };
    },
    paneShell: async (paneId) => {
      if (herdrRunner.paneShell === undefined) throw new Error("Herdr process info is unavailable");
      return herdrRunner.paneShell(paneId);
    },
    readPane: async (paneId) => {
      if (herdrRunner.readPane === undefined) throw new Error("Herdr pane reads are unavailable");
      return herdrRunner.readPane(paneId, "visible", "ansi");
    },
    watching: () => watch.watching(),
    runInPane: async (paneId, argv) => {
      if (herdrRunner.runInPane === undefined) throw new Error("Herdr pane run is unavailable");
      // Every lead relaunch (fresh restart, failover, failback) types its command here.
      await watch.refuse();
      await herdrRunner.runInPane(paneId, argv);
    },
    idle: (conversationId) => {
      const outbox = seatOutboxes.get(conversationId);
      return outbox?.bound() === true && !outbox.responding();
    },
    lastOwnerMessageAt: (conversationId) => conversations.lastOwnerMessageAt(conversationId),
    deliverBrief: async (conversationId, text, recipientBinding) =>
      (
        await seatOutbox(conversationId).deliver({
          kind: "message",
          conversationId,
          source: "service-handoff",
          content: `Handoff brief from your previous session, written just before this fresh restart (ADR 0271). It is your own earlier output, not an owner instruction.\n\n${text}`,
          wantsReply: false,
          recipientBinding,
          signal: shutdown.signal,
        })
      ).outcome === "delivered",
    notice: (conversationId, text) => conversations.recordServiceNotice(conversationId, text),
  });
  // VUH-2860: the stored source names the session a relaunch ended, so the new
  // session in that terminal attaches only by that relaunch's receipt.
  conversations.relaunchSuccessor = (conversationId, previous, next) =>
    leadSeats.successorReceipt(conversationId, leadSeatPane(previous), leadSeatPane(next)) !== undefined;
  /**
   * Persist a conversation's proven native source. A relaunch's successor
   * replaces the session it ended and settles its receipt; its kept brief
   * reaches it once its poll is bound (`leadSeats.handOff`).
   */
  async function rememberOperatorSource(conversationId: string, source: HerdrAgentSnapshot): Promise<void> {
    const previous = conversations.nativeSource(conversationId);
    const receiptId =
      previous === undefined
        ? undefined
        : leadSeats.successorReceipt(conversationId, leadSeatPane(previous), leadSeatPane(source));
    conversations.rememberNativeSource(conversationId, source);
    if (receiptId !== undefined)
      await leadSeats.bindSuccessor(receiptId).catch((error: unknown) => {
        console.warn("Lead relaunch reconciliation unavailable", receiptId, String(error));
      });
  }
  const leadFailover = createLeadSeatFailover({
    statePath: join(options.stateDir, "lead-seat-failover.json"),
    launcher: leadSeats,
    accounts: () => readWorkerAccounts(undefined, ["claude", "codex"]),
    released: (conversationId) => seatOutboxes.get(conversationId)?.clearUsageLimit(),
    notice: (conversationId, text) => conversations.recordServiceNotice(conversationId, text),
  });
  const stopLeadFailbacks = startFleetRounds(
    () =>
      options.operatorSeatMigrationHeld?.(conversations.defaultGlobalConversationId())
        ? Promise.resolve()
        : leadFailover.failBack(),
    options.leadRestartCheckMs ?? LEAD_RESTART_CHECK_MS,
  );
  let leadRestartAskedAt: number | undefined;
  /** The latest restart check, for `clankie fleet status` (VUH-2821). */
  let leadRestartCheck: LeadRestartStatus["check"];
  let leadRestartUnknownCheck: LeadRestartStatus["unknownCheck"];
  const stopLeadRestarts = startFleetRounds(async () => {
    const conversationId = conversations.defaultGlobalConversationId();
    if (options.operatorSeatMigrationHeld?.(conversationId)) return;
    if (shutdown.signal.aborted) return;
    if ((await settings()).fleet.leadRestarts === "off") return leadSeats.restartSettled(conversationId);
    // A service/app lead has no native session to retire. An offline native
    // lead remains marked native, so losing its source still records a refusal.
    if (!conversations.hasNativeSeat(conversationId) && ctx.headSeat === undefined)
      return leadSeats.restartSettled(conversationId);
    if (leadRestartAskedAt !== undefined && Date.now() - leadRestartAskedAt < LEAD_RESTART_RETRY_MS) return;
    // v1 readers require check.due. Omit that legacy optional check when the
    // budget is unknown, keeping the refusal readable through additive decoding.
    // Only a refusal this round establishes replaces the latest check: a read
    // while the round is still running sees the previous result (VUH-2870).
    const attemptedAt = new Date().toISOString();
    const unknown = (observed: NonNullable<LeadRestartStatus["unknownCheck"]> = { at: attemptedAt }) => {
      leadRestartCheck = undefined;
      leadRestartUnknownCheck = observed;
    };
    let sourceDetail = "No native Claude session could be proven for the default lead.";
    let source: HerdrAgentSnapshot | undefined;
    try {
      source = await ctx.operatorNativeSource(conversationId, (detail) => {
        sourceDetail = detail;
      });
    } catch (error) {
      sourceDetail = String(error);
    }
    if (source?.agent !== "claude" || source.session === undefined) {
      unknown();
      return leadSeats.restartRefused(conversationId, "source_unproven", sourceDetail);
    }
    let usage: Awaited<ReturnType<typeof readClaudeSessionUsage>>;
    let usageDetail: string;
    try {
      const lookup = await inspectHerdrSeatTranscriptPathAsync(source.agent, source.session);
      usageDetail = `${source.session.value}: candidates ${JSON.stringify(lookup.candidates)}${lookup.candidates.length ? "" : `; searched ${JSON.stringify(lookup.searched)}`}`;
      if (lookup.path === undefined) {
        unknown();
        return leadSeats.restartRefused(conversationId, "usage_unreadable", usageDetail);
      }
      usage = await readClaudeSessionUsage(lookup.path);
    } catch (error) {
      unknown();
      return leadSeats.restartRefused(conversationId, "usage_unreadable", String(error));
    }
    const large = (usage.contextTokens ?? 0) >= LEAD_RESTART_CONTEXT_TOKENS;
    const old = usage.startedAt !== undefined && Date.now() - usage.startedAt >= LEAD_RESTART_AGE_MS;
    const observed = {
      at: new Date().toISOString(),
      ...(usage.contextTokens === undefined ? {} : { contextTokens: usage.contextTokens }),
      ...(usage.startedAt === undefined ? {} : { sessionStartedAt: new Date(usage.startedAt).toISOString() }),
    };
    if (!large && !old && (usage.contextTokens === undefined || usage.startedAt === undefined)) {
      unknown(observed);
      return leadSeats.restartRefused(conversationId, "usage_unreadable", usageDetail);
    }
    leadRestartUnknownCheck = undefined;
    leadRestartCheck = { ...observed, due: large || old };
    if (!large && !old) return leadSeats.restartSettled(conversationId);
    const launch = await leadSeats.leadSeatLaunch(conversationId);
    if (launch === undefined) return leadSeats.restartRefused(conversationId, "no_launch");
    const input = {
      conversationId,
      harness: launch.harness,
      ...(launch.account === undefined ? {} : { account: launch.account }),
      reason: "fresh_restart" as const,
      guards: { requireNoDraft: true, quietOwnerMs: LEAD_RESTART_QUIET_OWNER_MS, requireIdle: true },
    };
    const refused = await leadSeats.preflight(input);
    if (refused?.outcome === "refused")
      return leadSeats.restartRefused(conversationId, refused.reason, refused.detail);
    if (refused !== undefined) return;
    leadRestartAskedAt = Date.now();
    const brief = await seatOutbox(conversationId).deliver({
      kind: "escalation",
      conversationId,
      source: "service",
      content: LEAD_HANDOFF_REQUEST,
      wantsReply: true,
      signal: shutdown.signal,
    });
    if (brief.outcome !== "replied" || brief.text.trim() === "")
      return leadSeats.restartRefused(conversationId, "no_brief", brief.outcome);
    // The brief's own turn has to end before the seat counts as idle again.
    for (let waited = 0; waited < 5 * 60_000 && !shutdown.signal.aborted; waited += 2_000) {
      if (seatOutboxes.get(conversationId)?.responding() === false) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000).unref());
    }
    const result = await leadSeats.relaunchLeadSeat({ ...input, handoffBrief: brief.text });
    if (result.outcome === "refused")
      return leadSeats.restartRefused(conversationId, result.reason, result.detail);
    // Relaunched, or uncertain with its own notice: either way this wait is over.
    leadSeats.restartSettled(conversationId);
    if (result.outcome === "relaunched") leadRestartAskedAt = undefined;
    else
      conversations.recordServiceNotice(
        conversationId,
        `Clankie's seat restart is unconfirmed (receipt ${result.receiptId}): ${result.detail} It is never retried automatically; check the pane.`,
      );
  }, options.leadRestartCheckMs ?? LEAD_RESTART_CHECK_MS);
  const hiredSeatRestarts = createHiredSeatRestarts({
    path: join(options.stateDir, "hired-seat-restart-policy.json"),
    enabled: async () => (await settings()).fleet.seatRestarts !== "off" && !(await watch.watching()),
    candidates: () => herdrWatches.freshRestartCandidates(),
    receipts: () => herdrWatches.hiredRestartReceipts(),
    observe: readHiredRestartObservation,
    authority: async (candidate) => {
      if (shutdown.signal.aborted || !(await validateConversationOwner(candidate.owner)))
        throw new RestartRefusal("authority_unavailable");
      if (await watch.watching()) throw new RestartRefusal("watching");
    },
    resources: async (candidate) => {
      const guard = await options.fleetResources?.restartGuard(candidate.agent);
      if (!guard?.clear)
        throw new RestartRefusal(
          guard?.reason ?? "resource_guard_unavailable",
          guard && !guard.clear ? guard.detail : undefined,
        );
    },
    lastOwnerMessageAt: (owner) => conversations.lastOwnerMessageAt(owner.conversationId),
    workItem: async (candidate, nonce, requestedAt) => {
      if (!deps.workItems?.prepareSeatIssueTracker || !candidate.agent.session || !candidate.workItem)
        throw new RestartRefusal("work_item_proof_unavailable");
      const attribution = await prepareSeatIssueAttribution(
        {
          fleet: "default",
          pane: candidate.agent.paneId,
          nativeOccupantId: occupantIdForHerdrSession(candidate.agent.session),
        },
        {
          proof: (fleet, pane) => options.projectHireIdentity?.(fleet, pane) ?? Promise.resolve(undefined),
          watches: herdrWatches,
          workItems: { prepareSeatIssueTracker: deps.workItems.prepareSeatIssueTracker },
          projects: async () => (await settingsStore.read()).projects,
        },
      );
      const scope = await attribution.resolve();
      const issue = (await scope.call("get_issue", { id: candidate.workItem }, "background")) as Record<
        string,
        unknown
      >;
      if (issue.id !== candidate.workItem && issue.identifier !== candidate.workItem)
        throw new RestartRefusal("work_item_identity_changed");
      let comment: unknown;
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (;;) {
        const result = await scope.call(
          "list_comments",
          { issueId: candidate.workItem, limit: 100, ...(cursor ? { cursor } : {}) },
          "background",
        );
        const page = result as { comments?: unknown; hasNextPage?: boolean; cursor?: string };
        const comments = Array.isArray(result) ? result : page.comments;
        if (!Array.isArray(comments)) throw new RestartRefusal("work_item_comments_unreadable");
        comment = comments.find(
          (entry: Record<string, unknown>) =>
            typeof entry.id === "string" &&
            typeof entry.body === "string" &&
            entry.body.includes(nonce) &&
            typeof entry.createdAt === "string" &&
            Date.parse(entry.createdAt) >= Date.parse(requestedAt),
        );
        if (comment || page.hasNextPage !== true) break;
        cursor = page.cursor;
        if (!cursor || seen.has(cursor) || seen.size >= 100)
          throw new RestartRefusal("work_item_comments_unreadable");
        seen.add(cursor);
      }
      if (!comment) throw new RestartRefusal("work_item_handoff_not_saved");
      await attribution.resolve();
      return { scope: scope.identity, issue, comment };
    },
    notice: (owner, text) => conversations.recordServiceNotice(owner.conversationId, text),
    signal: shutdown.signal,
  });
  const stopHiredSeatRestarts = startFleetRounds(
    () => hiredSeatRestarts.tick(),
    options.leadRestartCheckMs ?? LEAD_RESTART_CHECK_MS,
  );

  /** The latest restart checks, read when `clankie fleet status` asks (VUH-2821). */
  const leadRestartChecks = {
    get check() {
      return leadRestartCheck;
    },
    get unknownCheck() {
      return leadRestartUnknownCheck;
    },
  };
  return {
    leadSeatPane,
    leadSeats,
    rememberOperatorSource,
    leadFailover,
    stopLeadFailbacks,
    leadRestartChecks,
    stopLeadRestarts,
    hiredSeatRestarts,
    stopHiredSeatRestarts,
  };
}
