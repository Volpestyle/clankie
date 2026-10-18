import { cp, lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { basename, join, resolve } from "node:path";
import { checkoutGit, fetchCheckoutMain, projectPathContains } from "@clankie/settings";
import {
  inspectTidyRepository,
  listTidyWorktrees,
  type ManagedWorktreeProtection,
} from "./tidy-worktrees.ts";
import type { HerdrWatchRunner } from "./herdr-watch.ts";

export interface PruneWorktreeResult {
  outcome: "removed" | "kept" | "unavailable";
  path: string;
  reason?: string;
  evidencePath?: string;
  branchDeleted?: boolean;
  /** Where a content-equivalent or decided drop's exact commits stay reachable. */
  keptRef?: string;
}

/** Hold both HEAD and its branch while Git removes the checkout, so a new commit cannot lose its only ref. */
async function withStableWorktreeHead(
  repository: string,
  candidate: { path: string; sha: string; branch?: string },
  remove: () => Promise<PruneWorktreeResult>,
): Promise<PruneWorktreeResult> {
  const inspected = await inspectTidyRepository(candidate.path);
  if (inspected.common !== (await inspectTidyRepository(repository)).common)
    return { outcome: "kept", path: candidate.path, reason: "inventory_changed" };
  const directory = inspected.directory;
  const lockPath = join(directory, "HEAD.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const identity = await lock.stat();
  let transaction: ReturnType<typeof spawn> | undefined;
  let output: ReturnType<typeof createInterface> | undefined;
  let exited: Promise<unknown> | undefined;
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("Worktree ref lock unavailable")), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const branch = await checkoutGit(candidate.path, ["symbolic-ref", "--quiet", "HEAD"]).then(
      (value) => value.trim(),
      (error: unknown) => {
        if ((error as { code?: unknown }).code !== 1) throw error;
        return undefined;
      },
    );
    if (
      branch !== (candidate.branch ? `refs/heads/${candidate.branch}` : undefined) ||
      (await checkoutGit(candidate.path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim() !== candidate.sha
    )
      return { outcome: "kept", path: candidate.path, reason: "inventory_changed" };
    if (branch) {
      await checkoutGit(repository, ["check-ref-format", branch]);
      if (/\s/u.test(branch) || branch.includes("\0")) throw Error("Worktree branch is unverified");
      const child = spawn("git", ["--no-optional-locks", "-C", repository, "update-ref", "--stdin"], {
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      transaction = child;
      let streamError: Error | undefined;
      child.stdin.on("error", (error) => {
        streamError = error;
      });
      // Always observe owned child errors/exit, including an unavailable Git executable.
      exited = new Promise((resolve) => {
        child.once("error", resolve);
        child.once("close", resolve);
      });
      child.stderr.resume();
      output = createInterface({ input: child.stdout });
      const lines = output[Symbol.asyncIterator]();
      child.stdin.write(`start\nverify ${branch} ${candidate.sha}\nprepare\n`);
      for (const expected of ["start: ok", "prepare: ok"])
        if ((await bounded(lines.next())).value !== expected)
          throw Error("Worktree branch changed or is busy");
      if (streamError || child.exitCode !== null || child.killed)
        throw Error("Worktree ref lock unavailable");
    }
    return await remove();
  } finally {
    if (transaction) {
      transaction.stdin?.end("abort\n");
      try {
        await bounded(exited!);
      } catch {
        transaction.kill("SIGTERM");
      }
      output?.close();
    }
    await lock.close();
    const current = await lstat(lockPath).catch((error: unknown) => {
      // Git removal deletes the worktree admin directory, including our HEAD lock.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (current?.dev === identity.dev && current.ino === identity.ino)
      await unlink(lockPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
  }
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
    const first = await listTidyWorktrees(repository, "origin/main", runner, { ...protection, only: path });
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
    const fresh = await listTidyWorktrees(repository, "origin/main", runner, { ...protection, only: path });
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
    const keptRef =
      candidate.landedBy === "decision"
        ? `refs/clankie/dropped-worktrees/${candidate.sha}`
        : candidate.landedBy === "content"
          ? `refs/clankie/pruned-worktrees/${candidate.sha}`
          : undefined;
    const removal = await withStableWorktreeHead(repository, candidate, async () => {
      // Content-equivalent work can still be an unpushed detached commit. Retain its exact ref too.
      if (keptRef) {
        const existing = await checkoutGit(repository, [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${keptRef}^{commit}`,
        ]).then(
          (value) => value.trim(),
          (error: unknown) => {
            if ((error as { code?: unknown }).code !== 1) throw error;
            return undefined;
          },
        );
        if (existing !== undefined && existing !== candidate.sha)
          throw Error("Preserved worktree ref changed");
        if (existing === undefined)
          await checkoutGit(repository, [
            "update-ref",
            keptRef,
            candidate.sha,
            "0".repeat(candidate.sha.length),
          ]);
      }
      await checkoutGit(repository, ["worktree", "remove", path]);
      return { outcome: "removed", path };
    });
    if (removal.outcome !== "removed") return { ...removal, ...(evidencePath ? { evidencePath } : {}) };
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
      ...(keptRef ? { keptRef } : {}),
    };
  } catch (error) {
    return { outcome: "unavailable", path, reason: error instanceof Error ? error.message : String(error) };
  }
}
