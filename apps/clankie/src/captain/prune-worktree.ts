import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { basename, join, relative, resolve, sep } from "node:path";
import { checkoutGit, fetchCheckoutMain, projectPathContains } from "@clankie/settings";
import { removeDirectory } from "../remove-directory.ts";
import {
  inspectTidyRepository,
  listTidyWorktrees,
  type ManagedWorktreeProtection,
  type TidyWorktreesResult,
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
  /** Regenerable `.local` content left out of the evidence, relative to `.local` (VUH-2932). */
  discarded?: string[];
  /** Discarding regenerable content failed after removal; it stays in the evidence. */
  discardFailed?: string;
  /** The evidence store is on another volume, so `.local` was copied rather than moved. */
  evidenceCopied?: boolean;
  /** After a failed removal: what is left of the tree and where its `.local` is. */
  left?: { registered: boolean; directory: boolean; evidence: "restored" | "kept" | "none" } | "unknown";
}

/** Installs and build caches: regenerable, so never kept as evidence (VUH-2932). */
const REGENERABLE = new Set(["node_modules", ".turbo", "DerivedData", ".pnpm-store", ".gradle", ".next"]);
const rustCacheSignature = "Signature: 8a477f597d28d172789f06886806bc55";

async function rustCache(path: string): Promise<boolean> {
  const tag = join(path, "CACHEDIR.TAG");
  // allow-swallowed-rejection -- an unreadable tag only means the directory is kept as evidence
  const metadata = await lstat(tag).catch(() => undefined);
  return (
    !!metadata?.isFile() &&
    metadata.size <= 4096 &&
    (await readFile(tag, "utf8")).startsWith(rustCacheSignature + "\n")
  );
}

/**
 * One streaming pass over `.local`, never following links. A nested worktree link refuses the
 * prune so that tree is pruned on its own; regenerable directories are noted and not entered.
 */
async function scanEvidence(root: string): Promise<{ regenerable: string[]; nestedWorktree?: string }> {
  const regenerable: string[] = [];
  const started = Date.now();
  const visit = async (directory: string, depth: number): Promise<string | undefined> => {
    if (depth > 40) throw Error(`evidence_scan_depth_limit: at=${relative(root, directory)}`);
    for await (const entry of await opendir(directory, { bufferSize: 32 })) {
      if (Date.now() - started > 60_000) throw Error("evidence_scan_time_limit");
      const path = join(directory, entry.name);
      if (entry.name === ".git") {
        // A `.git` file is a linked worktree's registration; a nested clone's own `.git` stays evidence.
        if (!entry.isDirectory()) return relative(root, directory) || ".";
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (REGENERABLE.has(entry.name) || (entry.name === "target" && (await rustCache(path)))) {
        regenerable.push(relative(root, path));
        continue;
      }
      const nested = await visit(path, depth + 1);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  const nestedWorktree = await visit(root, 0);
  return { regenerable, ...(nestedWorktree === undefined ? {} : { nestedWorktree }) };
}

const sweeps = new Map<string, Promise<void>>();
/** Delete discarded content off the request path; a sweep left by a restart finishes on the next one. */
export function sweepEvidenceTrash(evidenceRoot: string): Promise<void> {
  const trash = join(evidenceRoot, ".trash");
  const next = (sweeps.get(trash) ?? Promise.resolve()).then(async () => {
    const entries = await readdir(trash).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) await removeDirectory(join(trash, entry), { force: true });
  });
  sweeps.set(
    trash,
    next.catch((error: unknown) => console.warn(`Worktree evidence trash sweep failed: ${String(error)}`)),
  );
  return next;
}

/**
 * True only for git's own refusal to treat a path as a repository: a plain directory, or a
 * registered workspace whose folder was removed (`git -C` reports it as a failed chdir, never ENOENT).
 */
export function isNotGitRepository(error: unknown): boolean {
  const text = `${(error as { stderr?: unknown })?.stderr ?? ""}${error instanceof Error ? error.message : ""}`;
  return /not a git repository|cannot change to .*No such file or directory/iu.test(text);
}

/**
 * Whether any registered owner checkout lists a worktree nested under `path`. A registered
 * workspace that is not a git repository, or whose folder is gone, has no worktrees to nest, so it is skipped; any other
 * failure still refuses the removal (VUH-2850).
 */
export async function hasNestedRegisteredWorktree(owners: readonly string[], path: string): Promise<boolean> {
  for (const owner of owners) {
    let raw: string;
    try {
      raw = await checkoutGit(owner, ["worktree", "list", "--porcelain", "-z"]);
    } catch (error) {
      if (isNotGitRepository(error)) continue;
      throw error;
    }
    if (raw.split("\0").some((field) => field.startsWith(`worktree ${path}/`))) return true;
  }
  return false;
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
/** What is left after a failed removal. `.local` goes back only into a tree Git still holds intact. */
async function leftAfterFailure(
  repository: string,
  path: string,
  moved: { evidencePath: string; copied: boolean } | undefined,
): Promise<NonNullable<PruneWorktreeResult["left"]>> {
  try {
    const raw = await checkoutGit(repository, ["worktree", "list", "--porcelain", "-z"]);
    const registered = raw.split("\0").includes(`worktree ${path}`);
    // allow-swallowed-rejection -- a missing directory is the observation itself
    const directory = !!(await stat(path).catch(() => undefined))?.isDirectory();
    if (!moved || moved.copied) return { registered, directory, evidence: moved ? "kept" : "none" };
    const intact =
      registered &&
      directory &&
      (await checkoutGit(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) === "" &&
      // allow-swallowed-rejection -- only an absent `.local` may be refilled; any entry there stays
      !(await lstat(join(path, ".local")).catch(() => undefined));
    if (intact) await rename(moved.evidencePath, join(path, ".local"));
    return { registered, directory, evidence: intact ? "restored" : "kept" };
  } catch {
    return "unknown";
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
  batch?: { listing: TidyWorktreesResult },
): Promise<PruneWorktreeResult> {
  try {
    await guard();
    // A batch fetches once and admits every tree from one listing; each still gets its own fresh check.
    let first = batch?.listing;
    if (!first) {
      await fetchCheckoutMain(repository);
      first = await listTidyWorktrees(repository, "origin/main", runner, { ...protection, only: path });
    }
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
    let scan: Awaited<ReturnType<typeof scanEvidence>> | undefined;
    if (await stat(evidence).catch(() => undefined)) {
      if ((await realpath(evidence)) !== evidence) return { outcome: "kept", path, reason: "evidence_alias" };
      if (
        projectPathContains(path, resolve(evidenceRoot), process.platform === "win32" ? "windows" : "posix")
      )
        return { outcome: "kept", path, reason: "evidence_archive_in_worktree" };
      await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
      if ((await realpath(evidenceRoot)) !== resolve(evidenceRoot))
        return { outcome: "kept", path, reason: "evidence_archive_alias" };
      scan = await scanEvidence(evidence);
      // A worktree of another repository registered inside `.local` is pruned on its own, never moved.
      if (scan.nestedWorktree !== undefined)
        return { outcome: "kept", path, reason: `nested_worktree: .local/${scan.nestedWorktree}` };
    }
    const fresh = await listTidyWorktrees(repository, "origin/main", runner, { ...protection, only: path });
    const current = fresh.candidates.find(
      (entry) => entry.path === path && entry.sha === candidate.sha && entry.branch === candidate.branch,
    );
    if (fresh.outcome !== "listed" || !current) return { outcome: "kept", path, reason: "inventory_changed" };
    await guard();
    const keptRef =
      candidate.landedBy === "decision"
        ? `refs/clankie/dropped-worktrees/${candidate.sha}`
        : candidate.landedBy === "content"
          ? `refs/clankie/pruned-worktrees/${candidate.sha}`
          : undefined;
    let moved: { evidencePath: string; copied: boolean } | undefined;
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
      if (scan) {
        // Moving `.local` into the store costs no new disk on one volume. Copying wrote out every
        // block that APFS clones (pnpm installs) shared, while removal freed almost none (VUH-2932).
        const evidencePath = join(evidenceRoot, `${basename(path)}-${Date.now()}`);
        try {
          await rename(evidence, evidencePath);
          moved = { evidencePath, copied: false };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          // Another volume: copy what is worth keeping; the regenerable rest goes with the tree.
          const skipped = new Set(scan.regenerable.map((entry) => join(evidence, entry)));
          await cp(evidence, evidencePath, {
            recursive: true,
            errorOnExist: true,
            force: false,
            verbatimSymlinks: true,
            filter: (source) => !skipped.has(source),
          });
          moved = { evidencePath, copied: true };
        }
      }
      try {
        await checkoutGit(repository, ["worktree", "remove", path]);
      } catch (error) {
        const left = await leftAfterFailure(repository, path, moved);
        return {
          outcome: "unavailable",
          path,
          reason: error instanceof Error ? error.message : String(error),
          left,
          ...(moved && (left === "unknown" || left.evidence === "kept")
            ? { evidencePath: moved.evidencePath }
            : {}),
        };
      }
      return { outcome: "removed", path };
    });
    if (removal.outcome !== "removed") return removal;
    let discarded: string[] = scan?.regenerable ?? [];
    let discardFailed: string | undefined;
    if (moved && !moved.copied && discarded.length) {
      // The tree is gone; a failure here leaves regenerable content in the evidence, nothing worse.
      discarded = [];
      try {
        const trash = join(evidenceRoot, ".trash");
        await mkdir(trash, { recursive: true, mode: 0o700 });
        for (const entry of scan!.regenerable) {
          const source = join(moved.evidencePath, entry);
          // allow-swallowed-rejection -- content that changed or vanished since the scan is not discarded
          const metadata = await lstat(source).catch(() => undefined);
          if (!metadata?.isDirectory() || (await realpath(source)) !== source) continue;
          await rename(source, join(trash, randomUUID()));
          discarded.push(entry);
        }
      } catch (error) {
        discardFailed = String(error);
      }
      // allow-swallowed-rejection -- the sweep logs its own failure, and the next prune retries it
      void sweepEvidenceTrash(evidenceRoot).catch(() => undefined);
    }
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
      ...(moved ? { evidencePath: moved.evidencePath } : {}),
      ...(moved?.copied ? { evidenceCopied: true } : {}),
      ...(discarded.length ? { discarded } : {}),
      ...(discardFailed ? { discardFailed } : {}),
      ...(keptRef ? { keptRef } : {}),
    };
  } catch (error) {
    return { outcome: "unavailable", path, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Prune several trees with one fetch and one admission census; each tree still gets its own fresh
 * census right before removal. Deepest trees go first, so a nested tree is gone before its parent.
 */
export async function pruneTidyWorktrees(
  repository: string,
  paths: readonly string[],
  evidenceRoot: string,
  runner: Pick<HerdrWatchRunner, "list">,
  guard: () => Promise<void>,
  protection: ManagedWorktreeProtection = {},
  admit: (path: string) => Promise<void> = async () => {},
): Promise<PruneWorktreeResult[]> {
  const ordered = [...new Set(paths)].sort(
    (a, b) => b.split(sep).length - a.split(sep).length || (a < b ? -1 : a > b ? 1 : 0),
  );
  let listing: TidyWorktreesResult;
  try {
    await guard();
    await fetchCheckoutMain(repository);
    listing = await listTidyWorktrees(repository, "origin/main", runner, protection);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return ordered.map((path) => ({ outcome: "unavailable", path, reason }));
  }
  const results: PruneWorktreeResult[] = [];
  for (const path of ordered) {
    try {
      await admit(path);
    } catch (error) {
      results.push({ outcome: "kept", path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    results.push(
      await pruneTidyWorktree(repository, path, evidenceRoot, runner, guard, protection, { listing }),
    );
  }
  return results;
}
