import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { PaneTidy } from "../src/captain/pane-tidy.ts";
import { createHerdrWatchRunner, type HerdrWatchRunner } from "../src/captain/herdr-watch.ts";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function git(path: string, args: readonly string[]) {
  const { stdout } = await exec(
    "git",
    ["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  return stdout.trimEnd();
}
function inventory(panes: () => unknown[]) {
  const calls: string[][] = [];
  const runner = createHerdrWatchRunner(
    undefined,
    async (args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: panes() } });
      throw new Error(`Unexpected native mutation or observation: ${args.join(" ")}`);
    },
    undefined,
    { localCodexRecovery: false },
  );
  return { runner, calls };
}
function pane(cwd?: string, status = "idle") {
  return {
    pane_id: "w1:p1",
    terminal_id: "term_fixture",
    agent: "unknown",
    agent_status: status,
    title: "Owner shell",
    ...(cwd ? { cwd } : {}),
  };
}
function tidy(root: string, runner: HerdrWatchRunner) {
  return new PaneTidy(join(root, "tidy.json"), {
    runner,
    provenance: () => "unknown",
    ownerValid: async () => false,
    close: async () => {
      throw new Error("Listing must never close a pane");
    },
    untrack: () => {
      throw new Error("Listing must never untrack a pane");
    },
    hire: async () => {
      throw new Error("Listing must never hire an agent");
    },
    changed: () => {
      throw new Error("Listing must never mutate tidy history");
    },
  });
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-tidy-worktrees-")));
  roots.push(root);
  const repo = join(root, "repository");
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch", "main"]);
  await git(repo, ["config", "user.name", "Local fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "base.txt"), "Retained baseline\n");
  await git(repo, ["add", "base.txt"]);
  await git(repo, ["commit", "--quiet", "-m", "fixture baseline"]);
  await git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const sha = await git(repo, ["rev-parse", "HEAD"]);
  return {
    root,
    repo,
    sha,
    async worktree(name: string, detached = false) {
      const path = join(root, name);
      await git(
        repo,
        detached
          ? ["worktree", "add", "--detach", path, "main"]
          : ["worktree", "add", "-b", name.replaceAll(" ", "-"), path, "main"],
      );
      return path;
    },
  };
}

it("lists only merged clean linked worktrees, including detached HEAD and paths with spaces, without mutations", async () => {
  const f = await fixture();
  const linked = await f.worktree("clean linked"),
    detached = await f.worktree("detached", true);
  const native = inventory(() => []);
  const service = tidy(f.root, native.runner);
  expect(await service.worktrees(f.repo)).toEqual({
    outcome: "listed",
    mergedInto: "origin/main",
    candidates: [
      { path: linked, branch: "clean-linked", sha: f.sha },
      { path: detached, sha: f.sha },
    ],
    excluded: [{ path: f.repo, reason: "main_worktree" }],
  });
  expect(native.calls).toEqual([
    ["pane", "list"],
    ["pane", "list"],
  ]);
  expect(existsSync(join(f.root, "tidy.json"))).toBe(false);
  expect(await readFile(join(linked, "base.txt"), "utf8")).toBe("Retained baseline\n");
  expect((await service.worktrees(linked, "main")).candidates).toHaveLength(2);
});

it("excludes tracked dirt, untracked files, unmerged commits, locked and prunable entries, and every live pane cwd", async () => {
  const f = await fixture();
  const clean = await f.worktree("clean");
  const dirty = await f.worktree("dirty");
  await writeFile(join(dirty, "base.txt"), "Uncommitted change\n");
  const untracked = await f.worktree("untracked");
  await writeFile(join(untracked, "keep-me.txt"), "Untracked owner work\n");
  const unmerged = await f.worktree("unmerged");
  await writeFile(join(unmerged, "base.txt"), "New unmerged commit\n");
  await git(unmerged, ["add", "base.txt"]);
  await git(unmerged, ["commit", "--quiet", "-m", "unmerged work"]);
  const locked = await f.worktree("locked");
  await git(f.repo, ["worktree", "lock", "--reason", "Retain owner workspace", locked]);
  const prunable = await f.worktree("prunable");
  await rm(prunable, { recursive: true });
  const live = await f.worktree("live");
  const cwd = join(live, "nested");
  await mkdir(cwd);
  const native = inventory(() => [pane(cwd, "unknown")]);
  const result = await tidy(f.root, native.runner).worktrees(f.repo);
  expect(result).toEqual({
    outcome: "listed",
    mergedInto: "origin/main",
    candidates: [{ path: clean, branch: "clean", sha: f.sha }],
    excluded: [
      { path: f.repo, reason: "main_worktree" },
      { path: dirty, reason: "dirty" },
      { path: live, reason: "live_pane" },
      { path: locked, reason: "locked" },
      { path: prunable, reason: "prunable" },
      { path: unmerged, reason: "unmerged" },
      { path: untracked, reason: "dirty" },
    ],
  });
  expect(await readFile(join(untracked, "keep-me.txt"), "utf8")).toContain("owner work");
  for (const path of [clean, dirty, untracked, unmerged, locked, live]) expect(existsSync(path)).toBe(true);
});

it("protects a worktree reached by a live pane through a directory alias", async () => {
  const f = await fixture();
  const linked = await f.worktree("aliased");
  const alias = join(f.root, "alias");
  await symlink(linked, alias);
  const native = inventory(() => [pane(alias)]);
  expect(await tidy(f.root, native.runner).worktrees(f.repo)).toMatchObject({
    outcome: "listed",
    candidates: [],
    excluded: expect.arrayContaining([{ path: linked, reason: "live_pane" }]),
  });
});

it("fails closed for missing, failing, malformed, or unknown-cwd complete pane inventory", async () => {
  const f = await fixture();
  await f.worktree("clean");
  const cases: HerdrWatchRunner[] = [
    {
      get: async () => {
        throw new Error("Unavailable");
      },
      resolveTerminal: async () => undefined,
      wait: async () => {
        throw new Error("Unavailable");
      },
    },
    createHerdrWatchRunner(() => false),
    createHerdrWatchRunner(undefined, async () => JSON.stringify({ result: {} })),
    inventory(() => [pane()]).runner,
    inventory(() => [pane(join(f.root, "gone"))]).runner,
  ];
  for (const runner of cases)
    expect(await tidy(f.root, runner).worktrees(f.repo)).toEqual({
      outcome: "unavailable",
      mergedInto: "origin/main",
      candidates: [],
      excluded: [{ path: f.repo, reason: "pane_inventory_unavailable" }],
    });
});

it("refuses an aliased repository, a missing merge ref, and a copied foreign Git pointer", async () => {
  const f = await fixture();
  const linked = await f.worktree("foreign-pointer");
  const alias = join(f.root, "repo-alias");
  await symlink(f.repo, alias);
  const native = inventory(() => []);
  const service = tidy(f.root, native.runner);
  expect(await service.worktrees(alias)).toMatchObject({
    outcome: "unavailable",
    candidates: [],
    excluded: [{ path: alias, reason: "repository_unverified" }],
  });
  expect(await service.worktrees(f.repo, "origin/missing")).toMatchObject({
    outcome: "unavailable",
    candidates: [],
    excluded: [{ path: f.repo, reason: "merge_ref_unavailable" }],
  });
  const foreign = join(f.root, "foreign");
  await mkdir(foreign);
  await git(foreign, ["init", "--initial-branch", "main"]);
  await writeFile(join(linked, ".git"), `gitdir: ${join(foreign, ".git")}\n`);
  expect(await service.worktrees(f.repo)).toMatchObject({
    outcome: "listed",
    candidates: [],
    excluded: expect.arrayContaining([{ path: linked, reason: "worktree_unverified" }]),
  });
  expect(existsSync(linked)).toBe(true);
});

it("withholds candidates when a live pane appears during the inventory", async () => {
  const f = await fixture();
  const linked = await f.worktree("clean");
  let reads = 0;
  const native = inventory(() => (++reads === 1 ? [] : [pane(linked)]));
  expect(await tidy(f.root, native.runner).worktrees(f.repo)).toEqual({
    outcome: "unavailable",
    mergedInto: "origin/main",
    candidates: [],
    excluded: [{ path: f.repo, reason: "inventory_changed" }],
  });
});

it("foreground cwd protects a worktree even when the pane startup cwd is main", async () => {
  const f = await fixture();
  const live = await f.worktree("foreground-live");
  const native = inventory(() => [{ ...pane(f.repo), foreground_cwd: live }]);
  const result = await tidy(f.root, native.runner).worktrees(f.repo);
  expect(result.candidates).toEqual([]);
  expect(result.excluded).toContainEqual({ path: live, reason: "live_pane" });
});

it("prune saves ignored evidence, removes a merged clean worktree and only deletes its merged branch", async () => {
  const { pruneTidyWorktree } = await import("../src/captain/prune-worktree.ts");
  const f = await fixture();
  // A real local origin gives prune its required successful fetch boundary.
  const origin = join(f.root, "origin.git");
  await git(f.repo, ["clone", "--bare", f.repo, origin]);
  await git(f.repo, ["remote", "add", "origin", origin]);
  await git(f.repo, ["config", "branch.main.remote", "origin"]);
  await git(f.repo, ["config", "branch.main.merge", "refs/heads/main"]);
  const path = await f.worktree("landed");
  const common = await git(f.repo, ["rev-parse", "--git-common-dir"]);
  await writeFile(join(f.repo, common, "info", "exclude"), ".local/\n");
  await mkdir(join(path, ".local"));
  await writeFile(join(path, ".local", "proof.txt"), "kept evidence\n");
  const result = await pruneTidyWorktree(
    f.repo,
    path,
    join(f.root, "evidence"),
    inventory(() => []).runner,
    async () => {},
  );
  expect(result).toMatchObject({ outcome: "removed", path, branchDeleted: true });
  expect(existsSync(path)).toBe(false);
  expect(await readFile(join(result.evidencePath!, "proof.txt"), "utf8")).toBe("kept evidence\n");
  expect(await git(f.repo, ["branch", "--list", "landed"])).toBe("");
});

it("prune retains dirty, live, unmerged and main trees and refuses an unavailable census", async () => {
  const { pruneTidyWorktree } = await import("../src/captain/prune-worktree.ts");
  const f = await fixture();
  const origin = join(f.root, "origin.git");
  await git(f.repo, ["clone", "--bare", f.repo, origin]);
  await git(f.repo, ["remote", "add", "origin", origin]);
  const dirty = await f.worktree("prune-dirty");
  await writeFile(join(dirty, "draft.txt"), "keep\n");
  const live = await f.worktree("prune-live");
  const unmerged = await f.worktree("prune-unmerged");
  await writeFile(join(unmerged, "base.txt"), "unfinished\n");
  await git(unmerged, ["add", "base.txt"]);
  await git(unmerged, ["commit", "-m", "unfinished"]);
  const native = inventory(() => [pane(live)]);
  for (const [path, reason] of [
    [f.repo, "main_worktree"],
    [dirty, "dirty"],
    [live, "live_pane"],
    [unmerged, "unmerged"],
  ]) {
    expect(
      await pruneTidyWorktree(f.repo, path!, join(f.root, "evidence"), native.runner, async () => {}),
    ).toMatchObject({ outcome: "kept", reason });
    expect(existsSync(path!)).toBe(true);
  }
  expect((await pruneTidyWorktree(f.repo, live, join(f.root, "evidence"), {}, async () => {})).outcome).toBe(
    "unavailable",
  );
});
