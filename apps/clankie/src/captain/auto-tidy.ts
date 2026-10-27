import { stat } from "node:fs/promises";
import { join } from "node:path";
import { FLEET_AUTO_TIDY_MS, type FleetAutoTidy } from "@clankie/protocol/fleet-settings";
import { checkoutGit, projectPathContains } from "@clankie/settings";
import type { ProjectsSettings } from "@clankie/protocol/projects";
import type { ConversationOwner } from "./conversation-owner.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";
import {
  tidySessionKey,
  type ClosedWorkerPaneHistory,
  type PaneTidy,
  type TidyFailure,
} from "./pane-tidy.ts";
import { isNotGitRepository, type PruneWorktreeResult } from "./prune-worktree.ts";
import { tidyWorktreeInventory } from "./tidy-worktrees.ts";

/** How often settled hire panes are considered for an automatic close (VUH-2392). */
export const AUTO_TIDY_PANE_CHECK_MS = 5 * 60_000;
/** How often landed worktrees in enrolled roots are considered for removal. */
export const AUTO_TIDY_WORKTREE_CHECK_MS = 60 * 60_000;
/** A landed, clean worktree must go this long without checkout activity before removal. */
const AUTO_TIDY_WORKTREE_IDLE_MS = 24 * 60 * 60_000;
/** Bounds one sweep: removing a tree with its dependencies installed takes seconds to minutes. */
const WORKTREES_PER_SWEEP = 16;
const SETTLED = new Set(["idle", "done"]);

/** A finished hire past the idle window that auto-tidy could not close, for its lead's round. */
export interface AutoTidyHeld {
  readonly paneId: string;
  readonly seatId: string;
  readonly harness: string;
  readonly title: string;
  readonly idleSince: string;
  readonly window: string;
  /** reports_unread, results_not_kept, adoption_refused, or the close's own refusal. */
  readonly blocker: "reports_unread" | "results_not_kept" | "adoption_refused" | TidyFailure["reason"];
  readonly unreadReports?: number;
}
const platform = process.platform === "win32" ? "windows" : "posix";

export interface AutoTidyPorts {
  readonly setting: () => Promise<FleetAutoTidy>;
  readonly runner: Pick<HerdrWatchRunner, "list">;
  readonly tidy: Pick<PaneTidy, "close" | "keptPane" | "keepVersion" | "hasKeptReport">;
  /** Seats a project names as its standing reviewer; they stay open like kept panes. */
  readonly reviewerSeats?: () => Promise<ReadonlySet<string>>;
  readonly provenance: (agent: HerdrAgentSnapshot) => ConversationOwner | "unknown" | "owner_interactive";
  /** Reports from this exact seat that no lead has acknowledged yet. */
  readonly unreadReports: (agent: HerdrAgentSnapshot) => number;
  readonly ownerValid: (owner: ConversationOwner) => Promise<boolean>;
  /** Operator adoption of an unconfirmed local hire whose receipt observed this exact session. */
  readonly adoptUnconfirmed?: (
    agent: HerdrAgentSnapshot,
    owner: ConversationOwner,
    guard: () => Promise<void>,
  ) => Promise<{ state: string; receiptId: string } | undefined>;
  /** After closes: settle each seat's issue and tell its lead what closed. */
  readonly closed: (
    owner: ConversationOwner,
    entries: readonly ClosedWorkerPaneHistory[],
    adoptedReceipts: readonly string[],
  ) => Promise<void>;
  /** Registered local owner checkouts with their enrolled worktree roots. */
  readonly checkouts: () => Promise<{ repository: string; roots: string[] }[]>;
  /** The guarded single-tree removal behind prune_tidy_worktree. */
  readonly prune: (repository: string, path: string) => Promise<PruneWorktreeResult>;
  readonly stopped: () => boolean;
  readonly now?: () => number;
}

/** Every seat a project names as `review.seat` (ADR 0287); a role reviewer is hired per need. */
export function reviewerSeatIds(projects: ProjectsSettings): ReadonlySet<string> {
  return new Set(
    projects.projects.flatMap((project) =>
      project.review !== undefined && "seat" in project.review ? [project.review.seat] : [],
    ),
  );
}

/** A registered repository the last worktree round could not tidy, and why. */
export interface AutoTidySkipped {
  readonly repository: string;
  readonly reason: "not_a_git_repository" | "inventory_unavailable" | "prune_failed";
  readonly detail?: string;
}

/** The newest checkout activity: its root entries, index, HEAD or reflog. */
async function lastActivity(path: string): Promise<number | undefined> {
  try {
    const gitDir = (await checkoutGit(path, ["rev-parse", "--path-format=absolute", "--git-dir"])).trim();
    const stamps = await Promise.all(
      [path, join(gitDir, "index"), join(gitDir, "HEAD"), join(gitDir, "logs", "HEAD")].map((file) =>
        stat(file).then(
          (metadata) => metadata.mtimeMs,
          () => 0,
        ),
      ),
    );
    return Math.max(...stamps);
  } catch {
    return undefined;
  }
}

/**
 * The owner's automatic tidy (VUH-2392). Finished hires close through PaneTidy.close, so
 * every hard line there still holds: kept results, landed worktrees, no unsent draft and a
 * still-settled pane. Landed worktrees go through the same guarded prune a lead uses.
 */
export function createAutoTidy(ports: AutoTidyPorts) {
  const now = () => ports.now?.() ?? Date.now();
  /** When each session was first seen settled in its pane; a working turn starts it over. */
  const settledSince = new Map<string, number>();
  /** A close that was refused or failed waits for another settled period before it is retried. */
  const retryAt = new Map<string, number>();
  /** Why each settled hire past its window is still open, by session key. */
  const held = new Map<string, { owner: string; row: AutoTidyHeld }>();
  /** Repositories the latest worktree round skipped; replaced each round. */
  let skipped: AutoTidySkipped[] = [];

  async function panes(): Promise<ClosedWorkerPaneHistory[]> {
    const setting = await ports.setting();
    if (setting === "off" || !ports.runner.list) {
      settledSince.clear();
      retryAt.clear();
      held.clear();
      return [];
    }
    const delay = FLEET_AUTO_TIDY_MS[setting];
    const at = now();
    const seen = new Set<string>();
    const closed = new Map<
      string,
      { owner: ConversationOwner; entries: ClosedWorkerPaneHistory[]; adopted: string[] }
    >();
    const reviewers = (await ports.reviewerSeats?.()) ?? new Set<string>();
    for (const agent of await ports.runner.list()) {
      if (ports.stopped()) break;
      if (!SETTLED.has(agent.status) || !["claude", "codex"].includes(agent.agent)) continue;
      if (agent.session?.kind !== "id") continue;
      const sessionKey = tidySessionKey(agent);
      const key = JSON.stringify([agent.terminalId, sessionKey, ports.tidy.keepVersion(agent)]);
      seen.add(key);
      // A standing reviewer idles between candidates; closing it stalls every landing (VUH-2920).
      if (ports.tidy.keptPane(agent) || reviewers.has(agent.terminalId)) {
        settledSince.delete(key);
        retryAt.delete(key);
        held.delete(key);
        continue;
      }
      const since = settledSince.get(key) ?? at;
      settledSince.set(key, since);
      if (at - since < delay) {
        held.delete(key);
        continue;
      }
      if ((retryAt.get(key) ?? 0) > at) continue;
      const owner = ports.provenance(agent);
      // Hand-started, owner-interactive and unproven panes are never closed automatically.
      if (typeof owner !== "object") {
        held.delete(key);
        continue;
      }
      const hold = (blocker: AutoTidyHeld["blocker"], unreadReports?: number) =>
        held.set(key, {
          owner: owner.conversationId,
          row: {
            paneId: agent.paneId,
            seatId: agent.terminalId,
            harness: agent.agent,
            title: agent.title,
            idleSince: new Date(since).toISOString(),
            window: setting,
            blocker,
            ...(unreadReports === undefined ? {} : { unreadReports }),
          },
        });
      if (!ports.tidy.hasKeptReport(agent)) {
        hold("results_not_kept");
        continue;
      }
      const unread = ports.unreadReports(agent);
      if (unread > 0) {
        hold("reports_unread", unread);
        continue;
      }
      const authorize = () => ports.ownerValid(owner);
      // A hire that never confirmed its start holds its close until its original receipt
      // settles; adopt it here only from the exact native session that receipt observed.
      const adopted = await ports
        .adoptUnconfirmed?.(agent, owner, async () => {
          if (ports.stopped() || !(await authorize())) throw new Error("Auto-tidy stopped or lost its lead");
        })
        .catch((error: unknown) => {
          console.warn("Auto-tidy adoption unavailable", String(error));
          return { state: "refused", receiptId: "" };
        });
      // An adoption that applies but did not complete leaves its original for the lead.
      if (adopted !== undefined && adopted.state !== "adopted") {
        hold("adoption_refused");
        retryAt.set(key, at + delay);
        continue;
      }
      const result = await ports.tidy.close(
        {
          pane: agent.paneId,
          reason: `Auto-tidy: idle ${setting} with its reports read and its work landed or explicitly handed off`,
          idleOnly: true,
          automatic: true,
          expected: { terminalId: agent.terminalId, sessionKey },
        },
        { owner, current: () => !ports.stopped(), authorize },
      );
      if (result.outcome !== "closed") {
        hold(result.reason);
        retryAt.set(key, at + delay);
        continue;
      }
      held.delete(key);
      const group = closed.get(owner.conversationId) ?? { owner, entries: [], adopted: [] };
      group.entries.push(result.entry);
      if (adopted?.state === "adopted") group.adopted.push(adopted.receiptId);
      closed.set(owner.conversationId, group);
    }
    for (const key of settledSince.keys()) if (!seen.has(key)) settledSince.delete(key);
    for (const key of retryAt.keys()) if (!seen.has(key)) retryAt.delete(key);
    for (const key of held.keys()) if (!seen.has(key)) held.delete(key);
    for (const { owner, entries, adopted } of closed.values())
      await ports.closed(owner, entries, adopted).catch((error: unknown) => {
        console.warn("Auto-tidy close bookkeeping unavailable", String(error));
      });
    return [...closed.values()].flatMap((group) => group.entries);
  }

  async function worktrees(): Promise<PruneWorktreeResult[]> {
    if ((await ports.setting()) === "off") return [];
    const removed: PruneWorktreeResult[] = [];
    const round: AutoTidySkipped[] = [];
    // One repository that cannot be tidied is reported, never the end of the round.
    for (const { repository, roots } of await ports.checkouts()) {
      if (ports.stopped()) break;
      let entries: ReturnType<typeof tidyWorktreeInventory>;
      let main: string;
      try {
        entries = tidyWorktreeInventory(
          await checkoutGit(repository, ["worktree", "list", "--porcelain", "-z"]),
        );
        main = (await checkoutGit(repository, ["rev-parse", "--verify", "origin/main^{commit}"])).trim();
      } catch (error) {
        round.push(
          isNotGitRepository(error)
            ? { repository, reason: "not_a_git_repository" }
            : { repository, reason: "inventory_unavailable", detail: String(error).slice(0, 200) },
        );
        continue;
      }
      let pruned = 0;
      // The first entry is the owner checkout itself.
      for (const entry of entries.slice(1)) {
        if (ports.stopped() || pruned >= WORKTREES_PER_SWEEP) break;
        if (entry.bare || entry.locked || entry.prunable || entry.sha === undefined) continue;
        if (!roots.some((root) => projectPathContains(root, entry.path, platform))) continue;
        const active = await lastActivity(entry.path);
        if (active === undefined || now() - active < AUTO_TIDY_WORKTREE_IDLE_MS) continue;
        // Only a HEAD already in origin/main. The prune then rechecks HEAD, cleanliness and
        // every live pane and process cwd from fresh state before it removes anything.
        const merged = await checkoutGit(repository, ["merge-base", "--is-ancestor", entry.sha, main]).then(
          () => true,
          () => false,
        );
        if (!merged) continue;
        let result: PruneWorktreeResult;
        try {
          result = await ports.prune(repository, entry.path);
        } catch (error) {
          round.push({ repository, reason: "prune_failed", detail: String(error).slice(0, 200) });
          break;
        }
        if (result.outcome !== "removed") continue;
        pruned++;
        removed.push(result);
      }
    }
    skipped = round;
    for (const entry of round)
      console.warn(
        `Auto-tidy skipped ${entry.repository}: ${entry.reason}${entry.detail ? ` (${entry.detail})` : ""}`,
      );
    return removed;
  }

  /** Seats this lead must close or acknowledge itself: auto-tidy found each one past its window. */
  function heldFor(conversationId: string): AutoTidyHeld[] {
    return [...held.values()].filter((entry) => entry.owner === conversationId).map((entry) => entry.row);
  }

  return { panes, worktrees, held: heldFor, skipped: (): readonly AutoTidySkipped[] => skipped };
}
