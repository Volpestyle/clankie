import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Evidence } from "@clankie/protocol";
import { replacePrivateFileAtomically } from "./private-artifact.ts";

const execFileAsync = promisify(execFile);

export interface GitEvidence {
  baseCommit: string;
  headCommit: string;
  indexTree: string;
  changedPaths: string[];
  ignoredPaths: string[];
  diff: string;
  sha256: string;
  artifactPath: string;
  fingerprints: Record<string, string>;
  ignoredFingerprints: Record<string, string>;
  evidence: Evidence;
}

export interface CollectGitEvidenceInput {
  workspacePath: string;
  baseCommit: string;
  artifactRoot: string;
  missionId: string;
  workerRunId: string;
  attempt: number;
}

export async function collectGitEvidence(input: CollectGitEvidenceInput): Promise<GitEvidence> {
  const workspacePath = resolve(input.workspacePath);
  const repositoryRoot = (await git(workspacePath, ["rev-parse", "--show-toplevel"])).trim();
  if (resolve(repositoryRoot) !== workspacePath) {
    throw new Error(`Worker workspace ${workspacePath} is not the Git worktree root ${repositoryRoot}`);
  }
  const verifiedBase = (
    await git(workspacePath, ["rev-parse", "--verify", `${input.baseCommit}^{commit}`])
  ).trim();
  if (verifiedBase !== input.baseCommit)
    throw new Error("Worktree base commit changed during evidence collection");
  const headCommit = (await git(workspacePath, ["rev-parse", "HEAD"])).trim();
  const indexTree = (await git(workspacePath, ["write-tree"])).trim();

  const nameStatus = await git(workspacePath, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    input.baseCommit,
  ]);
  const changedPaths = parseNameStatus(nameStatus);
  const untracked = splitNull(await git(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const ignored = splitNull(
    await git(workspacePath, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
  ).map(normalizeRepoPath);
  for (const path of untracked) changedPaths.push(normalizeRepoPath(path));

  let diff = await git(workspacePath, ["diff", "--binary", "--find-renames", input.baseCommit, "--"]);
  for (const path of untracked) {
    diff += await gitAllowDifference(workspacePath, [
      "diff",
      "--no-index",
      "--binary",
      "--",
      "/dev/null",
      path,
    ]);
  }
  const uniquePaths = [...new Set(changedPaths)].sort();
  const fingerprints: Record<string, string> = {};
  const untrackedSet = new Set(untracked.map(normalizeRepoPath));
  for (const path of uniquePaths) {
    const pathDiff = await git(workspacePath, ["diff", "--binary", input.baseCommit, "--", path]);
    const untrackedHash = untrackedSet.has(path)
      ? (await git(workspacePath, ["hash-object", "--no-filters", "--", path])).trim()
      : "";
    fingerprints[path] = createHash("sha256")
      .update(pathDiff)
      .update("\0")
      .update(untrackedHash)
      .digest("hex");
  }
  const ignoredFingerprints: Record<string, string> = {};
  for (const path of ignored) {
    const objectHash = (await git(workspacePath, ["hash-object", "--no-filters", "--", path])).trim();
    ignoredFingerprints[path] = objectHash;
  }
  const sha256 = createHash("sha256").update(diff).digest("hex");
  const artifactDirectory = resolve(input.artifactRoot, safeName(input.missionId));
  const artifactPath = join(
    artifactDirectory,
    `${safeName(input.workerRunId)}-attempt-${input.attempt}.diff`,
  );
  await mkdir(artifactDirectory, { recursive: true });
  await replacePrivateFileAtomically(artifactPath, diff);
  return {
    baseCommit: input.baseCommit,
    headCommit,
    indexTree,
    changedPaths: uniquePaths,
    ignoredPaths: ignored.sort(),
    diff,
    sha256,
    artifactPath,
    fingerprints,
    ignoredFingerprints,
    evidence: {
      kind: "diff",
      label: "runner-observed-git-diff",
      uri: `artifact://runner-diff/${safeName(input.missionId)}/${safeName(input.workerRunId)}-${input.attempt}`,
      summary: `${uniquePaths.length} changed path(s), sha256=${sha256}`,
    },
  };
}

export function pathsChangedBetween(before: GitEvidence, after: GitEvidence): string[] {
  const paths = new Set([
    ...Object.keys(before.fingerprints),
    ...Object.keys(after.fingerprints),
    ...Object.keys(before.ignoredFingerprints),
    ...Object.keys(after.ignoredFingerprints),
  ]);
  return [...paths]
    .filter(
      (path) =>
        before.fingerprints[path] !== after.fingerprints[path] ||
        before.ignoredFingerprints[path] !== after.ignoredFingerprints[path],
    )
    .sort();
}

export function pathsOutsideWriteScope(
  changedPaths: readonly string[],
  writeScope: readonly string[],
): string[] {
  return changedPaths.filter(
    (path) => !writeScope.some((pattern) => globMatches(normalizeRepoPath(path), normalizeGlob(pattern))),
  );
}

function parseNameStatus(value: string): string[] {
  const fields = splitNull(value);
  const paths: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) break;
    const source = fields[index++];
    if (!source) throw new Error(`Malformed git name-status output for ${status}`);
    paths.push(normalizeRepoPath(source));
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = fields[index++];
      if (!destination) throw new Error(`Malformed git rename output for ${status}`);
      paths.push(normalizeRepoPath(destination));
    }
  }
  return paths;
}

function splitNull(value: string): string[] {
  return value.split("\0").filter((field) => field.length > 0);
}

function normalizeRepoPath(path: string): string {
  const posix = path.split(sep).join("/").replace(/^\.\//u, "");
  if (isAbsolute(path) || posix === ".." || posix.startsWith("../") || posix.includes("/../")) {
    throw new Error(`Git reported a path outside the repository: ${path}`);
  }
  return posix;
}

function normalizeGlob(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "") || "unnamed";
}

function globMatches(path: string, pattern: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character?.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") ?? "";
  }
  return new RegExp(`${expression}$`, "u").test(path);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return result.stdout;
}

async function gitAllowDifference(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string };
    if (failure.code === 1 && typeof failure.stdout === "string") return failure.stdout;
    throw error;
  }
}
