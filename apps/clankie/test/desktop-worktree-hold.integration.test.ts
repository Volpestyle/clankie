import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { workerWorktreeHold } from "../src/captain/worktree-decisions.ts";

it("observes local desktop worktrees while retaining dirty, unlanded, unreadable and remote work", async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "desktop-worktree-hold-")));
  const root = join(scratch, "repository");
  await mkdir(root);
  const git = async (...args: string[]) =>
    promisify(execFile)("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    });
  try {
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, "base"), "baseline\n");
    await git("add", "base");
    await git("commit", "-m", "baseline");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    const tree = join(scratch, "worker");
    await git("worktree", "add", "-b", "read-only", tree, "origin/main");
    const hold = (paneId = "herdr-core/tproof", foregroundWorkingDirectory?: string) =>
      workerWorktreeHold({ paneId, workingDirectory: tree, ...(foregroundWorkingDirectory ? { foregroundWorkingDirectory } : {}) });
    expect(await hold()).toEqual([]);
    await writeFile(join(tree, "draft"), "unfinished\n");
    expect(await hold()).toMatchObject([{ path: tree, state: "unreconciled", dirtyFiles: 1, unlandedCommits: 0 }]);
    await git("-C", tree, "add", "draft");
    await git("-C", tree, "commit", "-m", "unlanded work");
    expect(await hold()).toMatchObject([{ state: "unreconciled", dirtyFiles: 0, unlandedCommits: 1 }]);
    await git("update-ref", "refs/remotes/origin/main", "read-only");
    expect(await hold()).toEqual([]);
    await writeFile(join(root, "foreground-draft"), "keep foreground work\n");
    expect(await hold("herdr-core/tproof", root)).toMatchObject([{ path: root, dirtyFiles: 1 }]);
    await git("update-ref", "-d", "refs/remotes/origin/main");
    expect(await hold()).toMatchObject([{ state: "unknown", reason: expect.any(String) }]);
    expect(await hold("other-mac/term_proof")).toEqual([{ path: tree, state: "unknown", reason: "Remote fleet worktree" }]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
