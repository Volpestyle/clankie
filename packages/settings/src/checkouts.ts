import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CheckoutStatus, WorktreeReconciliation } from "@clankie/protocol";

const exec = promisify(execFile);
export async function checkoutGit(path: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", ["--no-optional-locks", "-C", path, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });
  return stdout;
}
export async function ownerCheckout(path: string): Promise<string> {
  const raw = await checkoutGit(path, ["worktree", "list", "--porcelain", "-z"]);
  const owner = raw.split("\0")[0]?.replace(/^worktree /u, "");
  if (!owner || (await realpath(owner)) !== owner) throw Error("Owner checkout is unverified");
  return owner;
}
export async function fetchCheckoutMain(path: string): Promise<string> {
  await checkoutGit(path, ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  return (await checkoutGit(path, ["rev-parse", "--verify", "origin/main^{commit}"])).trim();
}
export async function inspectCheckout(path: string): Promise<CheckoutStatus> {
  try {
    const canonical = await realpath(path);
    if (canonical !== path || (await checkoutGit(path, ["rev-parse", "--show-toplevel"])).trim() !== path)
      throw Error("Use the canonical repository root");
    const [head, remoteMain, branch, counts, status, raw] = await Promise.all([
      checkoutGit(path, ["rev-parse", "HEAD"]),
      checkoutGit(path, ["rev-parse", "--verify", "origin/main^{commit}"]),
      checkoutGit(path, ["branch", "--show-current"]),
      checkoutGit(path, ["rev-list", "--left-right", "--count", "HEAD...origin/main"]),
      checkoutGit(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      checkoutGit(path, ["worktree", "list", "--porcelain", "-z"]),
    ]);
    const [ahead, behind] = counts.trim().split(/\s+/u).map(Number);
    const entries = raw.split("\0\0").filter(Boolean).slice(1);
    // One graph traversal, rather than one process for every historical worktree.
    const fresh = new Set([
      remoteMain.trim(),
      ...(await checkoutGit(path, ["rev-list", "--all", "--ancestry-path", `^${remoteMain.trim()}`]))
        .trim()
        .split("\n"),
    ]);
    const staleWorktrees = entries.filter((entry) => {
      const sha = entry
        .split("\0")
        .find((field) => field.startsWith("HEAD "))
        ?.slice(5);
      return sha !== undefined && !fresh.has(sha);
    }).length;
    return {
      path,
      outcome: "observed",
      head: head.trim(),
      remoteMain: remoteMain.trim(),
      branch: branch.trim(),
      ahead: ahead!,
      behind: behind!,
      dirty: Boolean(status),
      linkedWorktrees: entries.length,
      staleWorktrees,
    };
  } catch (error) {
    return { path, outcome: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
/**
 * Compare one checkout's HEAD with main by patch content (`git cherry`), so rebased or
 * cherry-picked commits count as landed, and count uncommitted files. Read-only.
 * A directory outside any Git checkout, or one that no longer exists, holds nothing.
 */
export async function reconcileWorktree(
  path: string,
  mergedInto = "origin/main",
): Promise<WorktreeReconciliation | undefined> {
  let root: string;
  try {
    root = (await checkoutGit(path, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (
      /not a git repository|cannot change to|No such file/iu.test(
        String((error as { stderr?: unknown }).stderr ?? ""),
      )
    )
      return undefined;
    return { path, state: "unknown", reason: "Git observation unavailable" };
  }
  try {
    const [head, branch, status] = await Promise.all([
      checkoutGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]).then((value) => value.trim()),
      checkoutGit(root, ["branch", "--show-current"]).then((value) => value.trim()),
      checkoutGit(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"]),
    ]);
    const base = (
      await checkoutGit(root, ["rev-parse", "--verify", "--end-of-options", `${mergedInto}^{commit}`]).catch(
        (error: unknown) => {
          // A repository whose default branch is not main still names it through origin/HEAD.
          if (mergedInto !== "origin/main") throw error;
          return checkoutGit(root, ["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"]);
        },
      )
    ).trim();
    let unlandedCommits = 0;
    try {
      await checkoutGit(root, ["merge-base", "--is-ancestor", head, base]);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
      unlandedCommits = (await checkoutGit(root, ["cherry", base, head]))
        .split("\n")
        .filter((line) => line.startsWith("+ ")).length;
      // `git cherry` omits merges, including unique conflict-resolution work.
      // Hold non-ancestor merges until landed or deliberately reconciled by the lead.
      unlandedCommits += Number(
        (await checkoutGit(root, ["rev-list", "--count", "--merges", `${base}..${head}`])).trim(),
      );
    }
    const dirty = status
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3));
    const times = [
      Number((await checkoutGit(root, ["log", "-1", "--format=%ct", head])).trim()) * 1000,
      ...(await Promise.all(
        dirty
          .slice(0, 256)
          .map(async (file) => (await stat(join(root, file)).catch(() => undefined))?.mtimeMs ?? 0),
      )),
    ].filter((time) => Number.isFinite(time) && time > 0);
    return {
      path: root,
      state: unlandedCommits || dirty.length ? "unreconciled" : "reconciled",
      ...(branch ? { branch } : {}),
      head,
      unlandedCommits,
      dirtyFiles: dirty.length,
      ...(times.length ? { lastActivityAt: new Date(Math.max(...times)).toISOString() } : {}),
    };
  } catch (error) {
    return {
      path: root,
      state: "unknown",
      reason: error instanceof Error ? error.message.slice(0, 512) : "Git observation unavailable",
    };
  }
}
/** Every linked worktree of one owner checkout that holds unlanded or uncommitted work. */
export async function unreconciledLinkedWorktrees(
  repository: string,
  skip: (path: string) => boolean = () => false,
): Promise<WorktreeReconciliation[]> {
  const raw = await checkoutGit(repository, ["worktree", "list", "--porcelain", "-z"]);
  const paths = raw
    .split("\0\0")
    .filter(Boolean)
    .slice(1)
    .filter(
      (record) => !record.split("\0").some((field) => field === "prunable" || field.startsWith("prunable ")),
    )
    .map((record) =>
      record
        .split("\0")
        .find((field) => field.startsWith("worktree "))
        ?.slice(9),
    )
    .filter((path): path is string => path !== undefined && !skip(path));
  const results: WorktreeReconciliation[] = [];
  // Bounded concurrency: one owner checkout can register hundreds of worktrees.
  for (let index = 0; index < paths.length; index += 8)
    for (const result of await Promise.all(
      paths.slice(index, index + 8).map((path) => reconcileWorktree(path)),
    ))
      if (result && result.state !== "reconciled") results.push(result);
  return results;
}
export interface CheckoutBlocker {
  path: string;
  ageSeconds?: number | undefined;
}
export interface CheckoutSyncResult {
  path: string;
  outcome: "current" | "updated" | "blocked" | "unavailable";
  before?: string | undefined;
  after?: string | undefined;
  reason?: string | undefined;
  blockers: CheckoutBlocker[];
}
async function dirtyPaths(path: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    checkoutGit(path, ["diff", "--name-only", "-z", "HEAD"]),
    checkoutGit(path, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))];
}
async function ages(path: string, files: string[]): Promise<CheckoutBlocker[]> {
  return Promise.all(
    files.map(async (file) => {
      const info = await stat(join(path, file)).catch(() => undefined);
      return {
        path: file,
        ...(info ? { ageSeconds: Math.max(0, Math.floor((Date.now() - info.mtimeMs) / 1000)) } : {}),
      };
    }),
  );
}
/** Never stash, reset, rebase, force a ref, or auto-commit owner work. Git itself checks index races. */
export async function syncOwnerCheckout(repository: string): Promise<CheckoutSyncResult> {
  let path = repository;
  try {
    path = await ownerCheckout(repository);
    const target = await fetchCheckoutMain(repository);
    const status = await inspectCheckout(path);
    if (status.outcome !== "observed") throw Error(status.reason);
    const files = await dirtyPaths(path);
    const blockers = await ages(path, files);
    if (status.branch !== "main")
      return {
        path,
        outcome: "blocked",
        reason: `Owner checkout is on ${status.branch || "detached HEAD"}`,
        blockers,
      };
    if (status.ahead)
      return {
        path,
        outcome: "blocked",
        reason: `${status.ahead} local commits; ${status.behind} behind origin/main`,
        blockers,
      };
    if (status.head === target)
      return { path, outcome: "current", before: target, after: target, blockers: [] };
    const incoming = (
      await checkoutGit(path, ["diff", "--name-only", "--no-renames", "-z", status.head!, target])
    )
      .split("\0")
      .filter(Boolean);
    const ignoredIncoming: string[] = [];
    for (const file of incoming) {
      try {
        await checkoutGit(path, ["cat-file", "-e", `${status.head}:${file}`]);
      } catch {
        if (await stat(join(path, file)).catch(() => undefined)) ignoredIncoming.push(file);
      }
    }
    const overlap = [
      ...new Set([
        ...ignoredIncoming,
        ...files.filter((file) =>
          incoming.some(
            (changed) => changed === file || changed.startsWith(file + "/") || file.startsWith(changed + "/"),
          ),
        ),
      ]),
    ];
    if (overlap.length)
      return {
        path,
        outcome: "blocked",
        reason: "Local edits overlap incoming files",
        blockers: await ages(path, overlap),
      };
    // Disable owner-configured autostash and hooks. Disjoint staged/unstaged edits survive.
    try {
      await checkoutGit(path, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "merge.autoStash=false",
        "merge",
        "--ff-only",
        "--no-autostash",
        "--no-overwrite-ignore",
        target,
      ]);
    } catch {
      return {
        path,
        outcome: "blocked",
        reason: "Git refused fast-forward; checkout or index changed, or a merge is in progress",
        blockers: await ages(path, await dirtyPaths(path)),
      };
    }
    const after = (await checkoutGit(path, ["rev-parse", "HEAD"])).trim();
    return { path, outcome: "updated", before: status.head!, after, blockers: [] };
  } catch (error) {
    return {
      path,
      outcome: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
      blockers: [],
    };
  }
}
export interface HireCheckoutFreshness {
  outcome: "fresh" | "not-repository" | "refused";
  path: string;
  head?: string;
  remoteMain?: string;
  reason?: string | undefined;
}
/** New work starts clean and contains the fetched origin/main, including fresh topic branches. */
export async function verifyHireCheckout(path: string): Promise<HireCheckoutFreshness> {
  let root: string;
  try {
    root = (await checkoutGit(path, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (!/not a git repository/iu.test(String((error as { stderr?: unknown }).stderr ?? "")))
      return { outcome: "refused", path, reason: "Git checkout observation is unavailable" };
    // Missing/inaccessible directories are not usable non-Git workspaces.
    try {
      if (!(await stat(path)).isDirectory()) throw Error("Not a directory");
    } catch {
      return { outcome: "refused", path, reason: "Start directory is unavailable" };
    }
    return { outcome: "not-repository", path };
  }
  try {
    const remoteMain = await fetchCheckoutMain(root);
    const head = (await checkoutGit(root, ["rev-parse", "HEAD"])).trim();
    const dirty = (
      await checkoutGit(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"])
    )
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3));
    if (dirty.length)
      return {
        outcome: "refused",
        path: root,
        head,
        remoteMain,
        reason: `Start checkout is dirty: ${dirty
          .slice(0, 20)
          .map((file) => JSON.stringify(file))
          .join(
            ", ",
          )}${dirty.length > 20 ? " (more files omitted)" : ""}; preserve it and create a clean worktree from origin/main`,
      };
    try {
      await checkoutGit(root, ["merge-base", "--is-ancestor", remoteMain, head]);
    } catch {
      return {
        outcome: "refused",
        path: root,
        head,
        remoteMain,
        reason: "Start checkout does not contain fetched origin/main; sync or create a fresh worktree",
      };
    }
    return { outcome: "fresh", path: root, head, remoteMain };
  } catch (error) {
    return {
      outcome: "refused",
      path: root,
      reason: `Cannot verify fresh origin/main: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
