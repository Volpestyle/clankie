import { stat } from "node:fs/promises";
import { join } from "node:path";
import { FLEET_AUTO_TIDY_MS, type FleetAutoTidy } from "@clankie/protocol/fleet-settings";
import { checkoutGit, projectPathContains } from "@clankie/settings";
import type { ConversationOwner } from "./conversation-owner.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";
import { tidySessionKey, type ClosedWorkerPaneHistory, type PaneTidy } from "./pane-tidy.ts";
import type { PruneWorktreeResult } from "./prune-worktree.ts";
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
const platform = process.platform === "win32" ? "windows" : "posix";

export interface AutoTidyPorts {
  readonly setting: () => Promise<FleetAutoTidy>;
  readonly runner: Pick<HerdrWatchRunner, "list">;
  readonly tidy: Pick<PaneTidy, "close" | "keptPane" | "hasKeptReport">;
  readonly provenance: (agent: HerdrAgentSnapshot) => ConversationOwner | "unknown" | "owner_interactive";
  /** Reports from this exact seat that no lead has acknowledged yet. */
  readonly unreadReports: (agent: HerdrAgentSnapshot) => number;
  readonly ownerValid: (owner: ConversationOwner) => Promise<boolean>;
  /** After closes: settle each seat's issue and tell its lead what closed. */
  readonly closed: (owner: ConversationOwner, entries: readonly ClosedWorkerPaneHistory[]) => Promise<void>;
  /** Registered local owner checkouts with their enrolled worktree roots. */
  readonly checkouts: () => Promise<{ repository: string; roots: string[] }[]>;
  /** The guarded single-tree removal behind prune_tidy_worktree. */
  readonly prune: (repository: string, path: string) => Promise<PruneWorktreeResult>;
  readonly stopped: () => boolean;
  readonly now?: () => number;
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

  async function panes(): Promise<ClosedWorkerPaneHistory[]> {
    const setting = await ports.setting();
    if (setting === "off" || !ports.runner.list) {
      settledSince.clear();
      retryAt.clear();
      return [];
    }
    const delay = FLEET_AUTO_TIDY_MS[setting];
    const at = now();
    const seen = new Set<string>();
    const closed = new Map<string, { owner: ConversationOwner; entries: ClosedWorkerPaneHistory[] }>();
    for (const agent of await ports.runner.list()) {
      if (ports.stopped()) break;
      if (!SETTLED.has(agent.status) || !["claude", "codex"].includes(agent.agent)) continue;
      if (agent.session?.kind !== "id") continue;
      const sessionKey = tidySessionKey(agent);
      const key = JSON.stringify([agent.terminalId, sessionKey]);
      seen.add(key);
      const since = settledSince.get(key) ?? at;
      settledSince.set(key, since);
      if (at - since < delay || (retryAt.get(key) ?? 0) > at) continue;
      const owner = ports.provenance(agent);
      // Hand-started, owner-interactive and unproven panes are never closed automatically.
      if (typeof owner !== "object") continue;
      if (ports.tidy.keptPane(agent) || !ports.tidy.hasKeptReport(agent) || ports.unreadReports(agent) > 0)
        continue;
      const result = await ports.tidy.close(
        {
          pane: agent.paneId,
          reason: `Auto-tidy: idle ${setting} with its reports read and its work landed`,
          idleOnly: true,
          expected: { terminalId: agent.terminalId, sessionKey },
        },
        { owner, current: () => !ports.stopped(), authorize: () => ports.ownerValid(owner) },
      );
      if (result.outcome !== "closed") {
        retryAt.set(key, at + delay);
        continue;
      }
      const group = closed.get(owner.conversationId) ?? { owner, entries: [] };
      group.entries.push(result.entry);
      closed.set(owner.conversationId, group);
    }
    for (const key of settledSince.keys()) if (!seen.has(key)) settledSince.delete(key);
    for (const key of retryAt.keys()) if (!seen.has(key)) retryAt.delete(key);
    for (const { owner, entries } of closed.values())
      await ports.closed(owner, entries).catch((error: unknown) => {
        console.warn("Auto-tidy close bookkeeping unavailable", String(error));
      });
    return [...closed.values()].flatMap((group) => group.entries);
  }

  async function worktrees(): Promise<PruneWorktreeResult[]> {
    if ((await ports.setting()) === "off") return [];
    const removed: PruneWorktreeResult[] = [];
    for (const { repository, roots } of await ports.checkouts()) {
      if (ports.stopped()) break;
      let entries: ReturnType<typeof tidyWorktreeInventory>;
      let main: string;
      try {
        entries = tidyWorktreeInventory(
          await checkoutGit(repository, ["worktree", "list", "--porcelain", "-z"]),
        );
        main = (await checkoutGit(repository, ["rev-parse", "--verify", "origin/main^{commit}"])).trim();
      } catch {
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
        const result = await ports.prune(repository, entry.path);
        if (result.outcome !== "removed") continue;
        pruned++;
        removed.push(result);
      }
    }
    return removed;
  }

  return { panes, worktrees };
}
