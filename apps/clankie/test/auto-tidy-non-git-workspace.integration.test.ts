// VUH-2850: a registered workspace that is not a git repository must not end the hourly
// worktree round. Real git repositories with landed, idle worktrees sit beside a real plain
// directory; the round removes the landed trees, completes, and reports the skip.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createAutoTidy } from "../src/captain/auto-tidy.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { hasNestedRegisteredWorktree, pruneTidyWorktree } from "../src/captain/prune-worktree.ts";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function git(path: string, args: readonly string[]) {
  const { stdout } = await exec(
    "git",
    ["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  return stdout.trimEnd();
}
/** A repository with an origin and one linked worktree already contained in origin/main. */
async function landedRepository(base: string, name: string) {
  const repo = join(base, name);
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch", "main"]);
  await git(repo, ["config", "user.name", "Local fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "base.txt"), "baseline\n");
  await git(repo, ["add", "base.txt"]);
  await git(repo, ["commit", "--quiet", "-m", "baseline"]);
  const origin = join(base, `${name}-origin.git`);
  await git(repo, ["clone", "--quiet", "--bare", repo, origin]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["fetch", "--quiet", "origin"]);
  const tree = join(base, `${name}-landed`);
  await git(repo, ["worktree", "add", "--quiet", "-b", `${name}-landed`, tree, "main"]);
  return { repo, tree };
}

it("skips a non-git workspace, reports it, and still tidies every other repository", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "clankie-auto-tidy-non-git-")));
  roots.push(base);
  const plain = join(base, "tracker-research");
  await mkdir(join(plain, ".local"), { recursive: true });
  await writeFile(join(plain, "notes.md"), "research, not a repository\n");
  const first = await landedRepository(base, "first");
  const second = await landedRepository(base, "second");
  const runner = createHerdrWatchRunner(
    undefined,
    async (args) => {
      if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: [] } });
      throw new Error(`Unexpected native call: ${args.join(" ")}`);
    },
    undefined,
    { localCodexRecovery: false },
  );
  // Every registered workspace is an owner for the nested-worktree check, as in the captain.
  const owners = [plain, first.repo, second.repo];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const tidy = createAutoTidy({
    setting: async () => "1h",
    runner,
    tidy: {} as never,
    provenance: () => "unknown",
    unreadReports: () => 0,
    ownerValid: async () => true,
    closed: async () => {},
    // The non-git workspace is enrolled first, so a round that stops on it tidies nothing.
    checkouts: async () => [
      { repository: plain, roots: [base] },
      { repository: first.repo, roots: [base] },
      { repository: second.repo, roots: [base] },
    ],
    prune: async (repository, path) => {
      if (await hasNestedRegisteredWorktree(owners, path)) throw new Error("nested");
      return pruneTidyWorktree(repository, path, join(base, "archive"), runner, async () => {}, {
        runtimeRoot: join(base, "runtime"),
        home: join(base, "home"),
        runtimePath: join(base, "runtime"),
      });
    },
    stopped: () => false,
    // Two days later, so both landed trees are past the idle window.
    now: () => Date.now() + 2 * 24 * 60 * 60_000,
  });

  const removed = await tidy.worktrees();

  expect(removed.map((result) => [result.outcome, result.path]).sort()).toEqual([
    ["removed", first.tree],
    ["removed", second.tree],
  ]);
  expect(await git(first.repo, ["worktree", "list", "--porcelain"])).not.toContain(first.tree);
  expect(await git(second.repo, ["worktree", "list", "--porcelain"])).not.toContain(second.tree);
  expect(tidy.skipped()).toEqual([{ repository: plain, reason: "not_a_git_repository" }]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toBe(`Auto-tidy skipped ${plain}: not_a_git_repository`);
});
