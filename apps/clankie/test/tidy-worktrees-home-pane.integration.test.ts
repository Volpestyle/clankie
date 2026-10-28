import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, expect, it } from "vitest";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { pruneTidyWorktree } from "../src/captain/prune-worktree.ts";
import { reclaimWorktreeCaches } from "../src/captain/reclaim-worktree-caches.ts";
import { listTidyWorktrees } from "../src/captain/tidy-worktrees.ts";

// VUH-2926: a pane at $HOME protected every worktree below it, so tidy found nothing to prune,
// and cache reclaim re-examined the same first 32 trees on every sweep.
const exec = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  if (process.platform === "darwin")
    await exec(process.execPath, [join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs")]);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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

// A Herdr namespace of its own (short path: the macOS socket limit), so no pane of the
// owner's or another agent's decides this proof.
async function isolatedHerdr() {
  const root = await mkdtemp("/tmp/tidy-herdr-");
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(
    join(root, "config/config.toml"),
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
  );
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_"))),
    HERDR_SOCKET_PATH: join(root, "herdr.sock"),
    HERDR_CONFIG_PATH: join(root, "config/config.toml"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    SHELL: "/bin/sh",
  };
  spawn("herdr", ["server"], { env, stdio: "ignore" }).unref();
  await expect.poll(() => existsSync(env.HERDR_SOCKET_PATH!), { timeout: 10_000 }).toBe(true);
  cleanups.push(async () => {
    // allow-swallowed-rejection -- a server already gone has nothing to stop
    await exec("herdr", ["server", "stop"], { env }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const cli = async (...args: string[]) => JSON.parse((await exec("herdr", args, { env })).stdout);
  return {
    runner: createHerdrWatchRunner(undefined, undefined, undefined, {
      localCodexRecovery: false,
      localReadBinding: async () => ({ socketPath: env.HERDR_SOCKET_PATH!, session: "default" }),
    }),
    /** A real shell pane whose working directory is `cwd`. */
    paneIn: async (cwd: string) => {
      const created = await cli("workspace", "create", "--cwd", cwd, "--no-focus");
      return created.result.root_pane.pane_id as string;
    },
  };
}

/** A real process working in `cwd`, with no pane there. */
async function processIn(cwd: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await stopped;
  });
  return child;
}

/** A scratch HOME laid out like the owner's: ~/dev/repo, ~/dev/repo-wt/*, ~/research/*. */
async function scratchHome(mainOutsideHome = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-tidy-home-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const repo = mainOutsideHome ? join(root, "srv", "repo") : join(home, "dev", "repo");
  const trees = join(home, "dev", "repo-wt");
  await mkdir(repo, { recursive: true });
  await mkdir(trees, { recursive: true });
  await git(repo, ["init", "--quiet", "--initial-branch", "main"]);
  await git(repo, ["config", "user.name", "Local fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, ".gitignore"), "target/\n.claude/\n");
  await writeFile(join(repo, "base.txt"), "Retained baseline\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "--quiet", "-m", "fixture baseline"]);
  const origin = join(root, "origin.git");
  await git(repo, ["clone", "--quiet", "--bare", repo, origin]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["fetch", "--quiet", "origin"]);
  const worktree = async (path: string) => {
    await git(repo, ["worktree", "add", "--quiet", "--detach", path, "main"]);
    return path;
  };
  return { root, home, repo, trees, worktree };
}

it.runIf(process.platform === "darwin")(
  "a pane at $HOME or above the main checkout no longer protects every worktree; panes and processes inside, research parents and the main checkout still do",
  async () => {
    const { home, repo, trees, worktree } = await scratchHome();
    const landed = await worktree(join(trees, "landed"));
    const paneInside = await worktree(join(trees, "pane-inside"));
    const processInside = await worktree(join(trees, "process-inside"));
    // ADR 0280's research parent: a non-Git directory a worker holds its source trees in.
    const research = join(home, "research", "job");
    await mkdir(research, { recursive: true });
    const researchSource = await worktree(join(research, "source"));
    // A harness that enters a worktree inside the checkout leaves its pane at the checkout.
    const nested = await worktree(join(repo, ".claude", "worktrees", "entered"));
    await mkdir(join(paneInside, "deeper"));
    const herdr = await isolatedHerdr();
    // The operator seat and the owner's shells sit at home and ~/dev, as on the live Mac.
    for (const cwd of [home, join(home, "dev"), research, join(paneInside, "deeper"), repo])
      await herdr.paneIn(cwd);
    const worker = await processIn(processInside);

    const listed = await listTidyWorktrees(repo, "origin/main", herdr.runner, { home });
    expect(listed.outcome, JSON.stringify(listed)).toBe("listed");
    expect(listed.candidates).toEqual([{ path: landed, sha: await git(repo, ["rev-parse", "HEAD"]) }]);
    expect(listed.excluded).toEqual(
      expect.arrayContaining([
        { path: paneInside, reason: "live_pane" },
        { path: processInside, reason: "live_process" },
        { path: researchSource, reason: "live_pane" },
        { path: nested, reason: "live_pane" },
      ]),
    );

    // The process, not a pane, held that tree: once it exits, the tree is a candidate.
    const stopped = new Promise((resolve) => worker.once("exit", resolve));
    worker.kill();
    await stopped;
    const freed = await listTidyWorktrees(repo, "origin/main", herdr.runner, { home });
    expect(freed.candidates.map((entry) => entry.path).sort()).toEqual([landed, processInside]);

    // And prune removes a landed tree while the $HOME panes stay open.
    const pruned = await pruneTidyWorktree(
      repo,
      landed,
      join(home, "archive"),
      herdr.runner,
      async () => {},
      { home },
    );
    expect(pruned, JSON.stringify(pruned)).toMatchObject({ outcome: "removed", path: landed });
    expect(existsSync(landed)).toBe(false);
    for (const kept of [paneInside, processInside, researchSource, nested])
      expect(existsSync(kept)).toBe(true);
    // A pane working inside a tree still refuses its prune.
    expect(
      await pruneTidyWorktree(repo, paneInside, join(home, "archive"), herdr.runner, async () => {}, {
        home,
      }),
    ).toMatchObject({ outcome: "kept", reason: "live_pane" });
    expect(existsSync(paneInside)).toBe(true);
  },
  60_000,
);

it.runIf(process.platform === "darwin")(
  "a pane at $HOME protects nothing below it even when the main checkout lives outside $HOME",
  async () => {
    const { home, repo, trees, worktree } = await scratchHome(true);
    const landed = await worktree(join(trees, "landed"));
    const herdr = await isolatedHerdr();
    await herdr.paneIn(home);
    const listed = await listTidyWorktrees(repo, "origin/main", herdr.runner, { home });
    expect(
      listed.candidates.map((entry) => entry.path),
      JSON.stringify(listed),
    ).toEqual([landed]);
  },
  60_000,
);

it.runIf(process.platform === "darwin")(
  "a process that starts working in a candidate during the listing holds only that tree",
  async () => {
    const { home, repo, trees, worktree } = await scratchHome();
    const quiet = await worktree(join(trees, "quiet"));
    const busy = await worktree(join(trees, "busy"));
    const herdr = await isolatedHerdr();
    await herdr.paneIn(home);
    let reads = 0;
    // The second pane read is the final refresh, after every tree was judged.
    const runner = {
      list: async (...args: Parameters<NonNullable<typeof herdr.runner.list>>) => {
        const panes = await herdr.runner.list!(...args);
        if (++reads === 2) await processIn(busy);
        return panes;
      },
    };
    const listed = await listTidyWorktrees(repo, "origin/main", runner, { home });
    expect(reads).toBe(2);
    expect(listed.outcome, JSON.stringify(listed)).toBe("listed");
    expect(listed.candidates.map((entry) => entry.path)).toEqual([quiet]);
    expect(listed.excluded).toContainEqual({ path: busy, reason: "live_process" });
  },
  60_000,
);

it.runIf(process.platform === "darwin")(
  "repeated cache reclaim sweeps advance past the first 32 worktrees",
  async () => {
    const { home, repo, trees, worktree } = await scratchHome();
    const caches: string[] = [];
    for (let index = 0; index < 34; index++) {
      const tree = await worktree(join(trees, `worker-${index.toString().padStart(2, "0")}`));
      const cache = join(tree, "target");
      await mkdir(cache);
      await writeFile(join(cache, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
      await writeFile(join(cache, "artifact.txt"), "owned disposable build output\n");
      caches.push(cache);
    }
    const herdr = await isolatedHerdr();
    await herdr.paneIn(home);
    const sweep = () =>
      reclaimWorktreeCaches(repo, herdr.runner, {
        roots: [trees],
        retentionMs: 0,
        protection: { home, runtimeRoot: repo },
      });
    const first = await sweep();
    expect(first.reclaimed, JSON.stringify(first)).toEqual(caches.slice(0, 32));
    const deferred = first.kept.filter((entry) => entry.reason.startsWith("cache_worktree_limit:"));
    expect(deferred.map((entry) => entry.path)).toEqual([join(trees, "worker-32"), join(trees, "worker-33")]);
    // The next sweep starts with the deferred trees, then wraps to the start.
    const second = await sweep();
    expect(second.reclaimed, JSON.stringify(second)).toEqual(caches.slice(32));
    expect(
      second.kept
        .filter((entry) => entry.reason.startsWith("cache_worktree_limit:"))
        .map((entry) => entry.path),
    ).toEqual([join(trees, "worker-30"), join(trees, "worker-31")]);
    for (const cache of caches) expect(existsSync(cache)).toBe(false);
    for (let index = 0; index < 34; index++)
      expect(existsSync(join(trees, `worker-${index.toString().padStart(2, "0")}`, "base.txt"))).toBe(true);
  },
  120_000,
);
