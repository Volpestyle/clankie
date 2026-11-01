import type { OperatorFleetSeat } from "@clankie/protocol";
import type { ClankieSettings } from "@clankie/settings";
import type { WatchGate } from "../watch.ts";
import {
  AUTO_TIDY_PANE_CHECK_MS,
  AUTO_TIDY_WORKTREE_CHECK_MS,
  createAutoTidy,
  reviewerSeatIds,
} from "./auto-tidy.ts";
import type { createCheckoutMaintenance } from "./captain-checkouts.ts";
import type { CaptainOptions } from "./captain-types.ts";
import type { createWorkerReports } from "./captain-worker-reports.ts";
import type { ConversationOwner } from "./conversation-owner.ts";
import type { ConversationStore } from "./conversations.ts";
import { startFleetRounds } from "./fleet-review.ts";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import type { HerdrWatchRunner, HerdrWatchStore } from "./herdr-watch.ts";
import { parkedRefs, type PaneTidy } from "./pane-tidy.ts";

type WorkerReports = ReturnType<typeof createWorkerReports>;

export interface AutoTidyContext {
  readonly options: Pick<CaptainOptions, "autoTidyPaneCheckMs" | "autoTidyWorktreeCheckMs">;
  readonly settings: () => Promise<ClankieSettings>;
  readonly shutdown: AbortController;
  readonly watch: WatchGate;
  readonly conversations: ConversationStore;
  readonly herdrRunner: HerdrWatchRunner;
  readonly herdrWatches: HerdrWatchStore;
  readonly paneTidy: PaneTidy;
  /** Read at call time: the captain replaces the live seat list on every census (ADR 0325). */
  readonly liveSeats: readonly OperatorFleetSeat[];
  readonly reportSummaries: WorkerReports["reportSummaries"];
  readonly retireClosedSeatReports: WorkerReports["retireClosedSeatReports"];
  readonly validateConversationOwner: (owner: ConversationOwner) => Promise<boolean>;
  readonly pruneWorktree: ReturnType<typeof createCheckoutMaintenance>["pruneWorktree"];
}

/** Auto-tidy of finished hires and landed worktrees, and history from seats that are gone. */
export function createCaptainAutoTidy(ctx: AutoTidyContext) {
  const {
    options,
    settings,
    shutdown,
    watch,
    conversations,
    herdrRunner,
    herdrWatches,
    paneTidy,
    reportSummaries,
    retireClosedSeatReports,
    validateConversationOwner,
    pruneWorktree,
  } = ctx;
  // VUH-2392: finished, harvested, landed hires close on their own, and landed worktrees in
  // enrolled roots go, through the same guarded close and prune a lead uses.
  const autoTidy = createAutoTidy({
    // Watch closes nothing and prunes nothing (ADR 0308).
    setting: async () => ((await watch.watching()) ? "off" : (await settings()).fleet.autoTidy),
    runner: herdrRunner,
    tidy: paneTidy,
    reviewerSeats: async () => reviewerSeatIds((await settings()).projects),
    provenance: (agent) => herdrWatches.tidyProvenance(agent),
    unreadReports: (agent) => reportSummaries(undefined, agent).length,
    activityAt: (agent) => {
      const occupant = agent.session && occupantIdForHerdrSession(agent.session);
      const seat = ctx.liveSeats.find(
        (row) => row.seatId === agent.terminalId && row.occupantId === occupant,
      );
      return [
        ...reportSummaries(undefined, agent, true).map((report) => report.acceptedAt),
        seat?.efficiency?.lastReportAt,
        seat?.efficiency?.lastProgressAt,
      ];
    },
    ownerValid: validateConversationOwner,
    adoptUnconfirmed: (agent, owner, guard) => herdrWatches.adoptUnconfirmedForTidy(agent, owner, guard),
    closed: async (owner, entries, adopted) => {
      for (const entry of entries) {
        const issue = await herdrWatches.issueStatus?.closed({
          seatId: entry.seatId,
          reason: entry.reason,
          parked: parkedRefs(entry),
        });
        if (issue?.outcome === "failed")
          console.warn("Seat issue status unavailable", issue.issue, issue.detail);
      }
      const panes =
        entries
          .slice(0, 20)
          .map((entry) => {
            const parked = parkedRefs(entry);
            return `${entry.title || entry.harness} (${entry.paneId}, undo ${entry.id}${parked.length ? `; clean unlanded commits parked on ${parked.join(", ")}` : ""})`;
          })
          .join(", ") +
        (entries.length > 20 ? ` and ${entries.length - 20} more in worker_pane_history` : "");
      conversations.recordServiceNotice(
        owner.conversationId,
        `Auto-tidy closed ${entries.length === 1 ? "a finished hire" : `${entries.length} finished hires`} whose reports you read and whose work landed, was explicitly handed off or was parked on a local keep/ branch: ${panes}.${adopted.length ? ` It first adopted ${adopted.length === 1 ? "an unconfirmed hire" : `${adopted.length} unconfirmed hires`} from the exact native session each original receipt observed (receipts ${adopted.slice(0, 20).join(", ")}).` : ""} undo_worker_pane reopens one within five minutes; later, resume its saved session. keep_worker_pane keeps a pane open; \`clankie fleet set --auto-tidy off\` stops this.`,
      );
    },
    checkouts: async () => {
      const roots = new Map<string, string[]>();
      for (const root of (await settings()).projects.projects.flatMap((project) => project.worktreeRoots))
        if (root.machineId === "local")
          roots.set(root.repoPath, [...(roots.get(root.repoPath) ?? []), root.path]);
      return [...roots].map(([repository, paths]) => ({ repository, roots: paths }));
    },
    prune: (repository, path) => pruneWorktree(repository, path),
    stopped: () => shutdown.signal.aborted,
  });
  const stopAutoTidyPanes = startFleetRounds(async () => {
    await autoTidy.panes();
  }, options.autoTidyPaneCheckMs ?? AUTO_TIDY_PANE_CHECK_MS);
  // VUH-2806: history from seats that are gone, whatever the auto-tidy setting. Reports and
  // keeps of any pane still listed in its fleet, or of a fleet that cannot be listed, stay.
  const stopClosedSeatHistory = startFleetRounds(async () => {
    if (shutdown.signal.aborted) return;
    await retireClosedSeatReports();
    await paneTidy.dropGoneKeeps();
  }, options.autoTidyPaneCheckMs ?? AUTO_TIDY_PANE_CHECK_MS);
  const stopAutoTidyWorktrees = startFleetRounds(async () => {
    await autoTidy.worktrees();
  }, options.autoTidyWorktreeCheckMs ?? AUTO_TIDY_WORKTREE_CHECK_MS);

  return { autoTidy, stopAutoTidyPanes, stopClosedSeatHistory, stopAutoTidyWorktrees };
}
