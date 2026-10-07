import { cp, mkdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { checkoutGit, fetchCheckoutMain, projectPathContains } from "@clankie/settings";
import { listTidyWorktrees, type ManagedWorktreeProtection } from "./tidy-worktrees.ts";
import type { HerdrWatchRunner } from "./herdr-watch.ts";

export interface PruneWorktreeResult {
  outcome: "removed" | "kept" | "unavailable";
  path: string;
  reason?: string;
  evidencePath?: string;
  branchDeleted?: boolean;
  /** Where a decided drop's unlanded commits stay reachable. */
  keptRef?: string;
}
/** An exact candidate, not recursive directory cleanup. Never force Git removal. */
export async function pruneTidyWorktree(
  repository: string,
  path: string,
  evidenceRoot: string,
  runner: Pick<HerdrWatchRunner, "list">,
  guard: () => Promise<void>,
  protection: ManagedWorktreeProtection = {},
): Promise<PruneWorktreeResult> {
  try {
    await guard();
    await fetchCheckoutMain(repository);
    const first = await listTidyWorktrees(repository, "origin/main", runner, protection);
    if (first.outcome !== "listed")
      return { outcome: "unavailable", path, reason: first.excluded[0]?.reason ?? "inventory_unavailable" };
    const candidate = first.candidates.find((entry) => entry.path === path);
    if (!candidate)
      return {
        outcome: "kept",
        path,
        reason: first.excluded.find((entry) => entry.path === path)?.reason ?? "not_registered",
      };
    // Git may ignore a nested checkout; its registration must still protect the parent.
    const raw = await checkoutGit(repository, ["worktree", "list", "--porcelain", "-z"]);
    if (raw.split("\0").some((field) => field.startsWith(`worktree ${path}/`)))
      return { outcome: "kept", path, reason: "nested_worktree" };
    const evidence = join(path, ".local");
    let evidencePath: string | undefined;
    if (await stat(evidence).catch(() => undefined)) {
      if ((await realpath(evidence)) !== evidence) return { outcome: "kept", path, reason: "evidence_alias" };
      if (
        projectPathContains(path, resolve(evidenceRoot), process.platform === "win32" ? "windows" : "posix")
      )
        return { outcome: "kept", path, reason: "evidence_archive_in_worktree" };
      await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
      if ((await realpath(evidenceRoot)) !== resolve(evidenceRoot))
        return { outcome: "kept", path, reason: "evidence_archive_alias" };
      evidencePath = join(evidenceRoot, `${basename(path)}-${Date.now()}`);
      await cp(evidence, evidencePath, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
    }
    const fresh = await listTidyWorktrees(repository, "origin/main", runner, protection);
    const current = fresh.candidates.find(
      (entry) => entry.path === path && entry.sha === candidate.sha && entry.branch === candidate.branch,
    );
    if (fresh.outcome !== "listed" || !current)
      return {
        outcome: "kept",
        path,
        reason: "inventory_changed",
        ...(evidencePath ? { evidencePath } : {}),
      };
    await guard();
    // A decided drop removes the checkout, never the commits: a hidden ref keeps them reachable.
    if (candidate.landedBy === "decision")
      await checkoutGit(repository, [
        "update-ref",
        `refs/clankie/dropped-worktrees/${candidate.sha}`,
        candidate.sha,
      ]);
    await checkoutGit(repository, ["worktree", "remove", path]);
    let branchDeleted = false;
    if (candidate.branch) {
      try {
        await checkoutGit(repository, ["merge-base", "--is-ancestor", candidate.branch, "origin/main"]);
        await checkoutGit(repository, ["branch", "-d", candidate.branch]);
        branchDeleted = true;
      } catch {
        /* A changed, checked-out or independently tracked branch stays. */
      }
    }
    return {
      outcome: "removed",
      path,
      branchDeleted,
      ...(evidencePath ? { evidencePath } : {}),
      ...(candidate.landedBy === "decision"
        ? { keptRef: `refs/clankie/dropped-worktrees/${candidate.sha}` }
        : {}),
    };
  } catch (error) {
    return { outcome: "unavailable", path, reason: error instanceof Error ? error.message : String(error) };
  }
}
