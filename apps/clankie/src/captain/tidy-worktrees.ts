import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalProjectPath, projectPathContains } from "@clankie/settings";
import type { HerdrWatchRunner } from "./herdr-watch.ts";

export interface TidyWorktreesResult {
  readonly outcome: "listed" | "unavailable";
  readonly mergedInto: string;
  readonly candidates: { path: string; branch?: string; sha: string }[];
  readonly excluded: { path: string; reason: string }[];
}
interface GitWorktree {
  readonly path: string;
  readonly sha?: string;
  readonly branch?: string;
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly bare: boolean;
}
const exec = promisify(execFile);
const platform = process.platform === "win32" ? "windows" : "posix";
const SHA = /^[a-f0-9]{40,64}$/u;

async function canonical(path: string, directory = true): Promise<string> {
  if (
    !canonicalProjectPath(path, platform) ||
    (await realpath(path)) !== path ||
    (directory ? !(await stat(path)).isDirectory() : !(await stat(path)).isFile())
  )
    throw new Error("Unverified path");
  return path;
}
async function git(path: string, args: readonly string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const { stdout } = await exec("git", ["--no-optional-locks", "-C", path, ...args], {
    env,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}
async function repository(path: string) {
  await canonical(path);
  const paths = (
    await git(path, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ])
  )
    .trimEnd()
    .split("\n");
  if (paths.length !== 3) throw new Error("Unverified repository");
  const [top, directory, common] = await Promise.all(paths.map((path) => canonical(path)));
  if (top !== path) throw new Error("Repository path must be its exact canonical root");
  return { top: top!, directory: directory!, common: common! };
}
function worktrees(raw: string): GitWorktree[] {
  const records = raw
    .split("\0\0")
    .filter(Boolean)
    .map((record) => {
      const fields = record.split("\0").filter(Boolean);
      const paths = fields.filter((field) => field.startsWith("worktree "));
      const heads = fields.filter((field) => field.startsWith("HEAD "));
      const branches = fields.filter((field) => field.startsWith("branch "));
      if (paths.length !== 1 || heads.length > 1 || branches.length > 1)
        throw new Error("Malformed worktree inventory");
      const path = paths[0]!.slice(9);
      const sha = heads[0]?.slice(5);
      const branch = branches[0]?.slice(7).replace(/^refs\/heads\//u, "");
      const bare = fields.includes("bare");
      if (!canonicalProjectPath(path, platform) || (!bare && (!sha || !SHA.test(sha))))
        throw new Error("Unverified worktree inventory");
      return {
        path,
        ...(sha ? { sha } : {}),
        ...(branch ? { branch } : {}),
        bare,
        locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
        prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
      };
    });
  if (
    records.length === 0 ||
    records.length > 256 ||
    new Set(records.map((record) => record.path)).size !== records.length
  )
    throw new Error("Incomplete worktree inventory");
  return records;
}
async function paneDirectories(runner: Pick<HerdrWatchRunner, "list">): Promise<string[]> {
  if (!runner.list) throw new Error("Complete pane inventory unavailable");
  const panes = await runner.list();
  const paths: string[] = [];
  for (const pane of panes) {
    if (!pane.workingDirectory || !canonicalProjectPath(pane.workingDirectory, platform))
      throw new Error("Unknown pane directory");
    // Resolve aliases so a pane reached through a symlink still protects its real worktree.
    const path = await realpath(pane.workingDirectory);
    if (!(await stat(path)).isDirectory()) throw new Error("Unknown pane directory");
    paths.push(path);
  }
  return [...new Set(paths)].sort();
}

/** Read-only suggestions; every future removal must freshly verify its own admission. */
export async function listTidyWorktrees(
  repositoryPath: string,
  mergedInto: string,
  runner: Pick<HerdrWatchRunner, "list">,
): Promise<TidyWorktreesResult> {
  const unavailable = (reason: string): TidyWorktreesResult => ({
    outcome: "unavailable",
    mergedInto,
    candidates: [],
    excluded: [{ path: repositoryPath, reason }],
  });
  let repo: Awaited<ReturnType<typeof repository>>;
  try {
    repo = await repository(repositoryPath);
  } catch {
    return unavailable("repository_unverified");
  }
  let mergeSha: string;
  try {
    if (!mergedInto || mergedInto.includes("\0") || /[\r\n]/u.test(mergedInto))
      return unavailable("merge_ref_unavailable");
    mergeSha = (
      await git(repo.top, ["rev-parse", "--verify", "--end-of-options", `${mergedInto}^{commit}`])
    ).trim();
    if (!SHA.test(mergeSha)) return unavailable("merge_ref_unavailable");
  } catch {
    return unavailable("merge_ref_unavailable");
  }
  let panePaths: string[];
  try {
    panePaths = await paneDirectories(runner);
  } catch {
    return unavailable("pane_inventory_unavailable");
  }
  try {
    const raw = await git(repo.top, ["worktree", "list", "--porcelain", "-z"]);
    const inventory = worktrees(raw);
    const result: TidyWorktreesResult = { outcome: "listed", mergedInto, candidates: [], excluded: [] };
    for (const entry of inventory) {
      let reason: string | undefined;
      if (entry.bare || entry.path === inventory[0]!.path) reason = "main_worktree";
      else if (entry.locked) reason = "locked";
      else if (entry.prunable) reason = "prunable";
      else {
        try {
          const candidate = await repository(entry.path);
          if (
            candidate.common !== repo.common ||
            dirname(candidate.directory) !== join(repo.common, "worktrees")
          )
            throw new Error("Unverified linked worktree");
          const gitFile = await canonical(join(entry.path, ".git"), false);
          const backlink = (await readFile(join(candidate.directory, "gitdir"), "utf8")).trimEnd();
          if ((await canonical(resolve(candidate.directory, backlink), false)) !== gitFile)
            throw new Error("Unverified worktree backlink");
          const head = (await git(entry.path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
          if (head !== entry.sha) throw new Error("Worktree changed");
          if (panePaths.some((path) => projectPathContains(entry.path, path, platform))) reason = "live_pane";
          else if (await git(entry.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
            reason = "dirty";
          else {
            try {
              await git(entry.path, ["merge-base", "--is-ancestor", head, mergeSha]);
            } catch (error) {
              if ((error as { code?: unknown }).code !== 1) throw error;
              reason = "unmerged";
            }
          }
        } catch {
          reason = "worktree_unverified";
        }
      }
      if (reason) result.excluded.push({ path: entry.path, reason });
      else
        result.candidates.push({
          path: entry.path,
          sha: entry.sha!,
          ...(entry.branch ? { branch: entry.branch } : {}),
        });
    }
    const refreshedRepo = await repository(repositoryPath);
    const refreshedSha = (
      await git(repo.top, ["rev-parse", "--verify", "--end-of-options", `${mergedInto}^{commit}`])
    ).trim();
    if (
      JSON.stringify(refreshedRepo) !== JSON.stringify(repo) ||
      refreshedSha !== mergeSha ||
      (await git(repo.top, ["worktree", "list", "--porcelain", "-z"])) !== raw ||
      JSON.stringify(await paneDirectories(runner)) !== JSON.stringify(panePaths)
    )
      return unavailable("inventory_changed");
    return result;
  } catch {
    return unavailable("inventory_unavailable");
  }
}
