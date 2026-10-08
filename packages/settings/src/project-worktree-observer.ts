import { execFile } from "node:child_process";
import { realpath, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  canonicalProjectPath,
  type ObserveProjectGitWorktree,
  type ObserveProjectWorktreeRoot,
} from "./project-worktrees.ts";

const exec = promisify(execFile);
const platform = process.platform === "win32" ? "windows" : "posix";
async function canonical(path: string, directory = true): Promise<string> {
  if (
    !canonicalProjectPath(path, platform) ||
    (await realpath(path)) !== path ||
    (directory ? !(await stat(path)).isDirectory() : !(await stat(path)).isFile())
  )
    throw new Error("Path is missing, aliased or not canonical");
  return path;
}
async function git(path: string, args: readonly string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const { stdout } = await exec("git", ["--no-optional-locks", "-C", path, ...args], {
    env,
    encoding: "utf8",
    timeout: 3_000,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
  return stdout;
}
async function repository(path: string) {
  await canonical(path);
  const lines = (
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
  if (lines.length !== 3) throw new Error("Unexpected Git repository observation");
  const [top, gitDirectory, commonDirectory] = await Promise.all(lines.map((line) => canonical(line)));
  return { top: top!, gitDirectory: gitDirectory!, commonDirectory: commonDirectory! };
}

/** Read-only native Git facts. Remote roots require the registered machine's trusted observer. */
export const observeLocalProjectWorktreeRoot: ObserveProjectWorktreeRoot = async (root) => {
  if (root.machineId !== "local" || root.platform !== platform) return undefined;
  try {
    const path = await canonical(root.path);
    const repo = await repository(root.repoPath);
    if (repo.top !== root.repoPath) return undefined;
    return {
      path,
      repoPath: repo.top,
      commonDirectory: repo.commonDirectory,
      homePath: await canonical(homedir()),
    };
  } catch {
    return undefined;
  }
};

export const observeLocalProjectGitWorktree: ObserveProjectGitWorktree = async (root, cwd) => {
  if (root.machineId !== "local" || root.platform !== platform) return undefined;
  try {
    await canonical(root.path);
    const candidate = await repository(cwd);
    const repo = await repository(root.repoPath);
    if (repo.top !== root.repoPath) return undefined;
    const gitFilePath = await canonical(join(candidate.top, ".git"), false);
    const backlink = (await readFile(join(candidate.gitDirectory, "gitdir"), "utf8")).trimEnd();
    const gitDirectoryBacklink = await canonical(resolve(candidate.gitDirectory, backlink), false);
    const fields = (await git(root.repoPath, ["worktree", "list", "--porcelain", "-z"])).split("\0");
    const paths = fields.filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
    // git() bounds output bytes and execution time; sibling count is not authority.
    if (!paths.length || new Set(paths).size !== paths.length) return undefined;
    // A stale unrelated worktree entry must not prevent a valid registered worktree.
    // Only the matching candidate is authority; the full list is retained for race equality.
    if (!paths.every((path) => canonicalProjectPath(path, platform))) return undefined;
    if (!paths.includes(candidate.top)) return undefined;
    await canonical(candidate.top);
    return {
      cwd,
      worktreePath: candidate.top,
      gitDirectory: candidate.gitDirectory,
      commonDirectory: candidate.commonDirectory,
      repoPath: repo.top,
      repoCommonDirectory: repo.commonDirectory,
      registeredWorktrees: paths,
      gitFilePath,
      gitDirectoryBacklink,
    };
  } catch {
    return undefined;
  }
};
