import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createWorktreeCacheRoutes } from "../src/worktree-cache-routes.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { runCheckoutsCommand } from "../../tui/src/command/checkouts.ts";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { reclaimWorktreeCaches } from "../src/captain/reclaim-worktree-caches.ts";

const exec = promisify(execFile);
beforeAll(async () => {
  if (process.platform === "darwin")
    await exec(process.execPath, [join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs")]);
});
// A Herdr namespace of its own (short path: the macOS socket limit), so no pane of the
// owner's or another agent's decides this proof (VUH-2608).
async function isolatedHerdr() {
  const root = await mkdtemp("/tmp/cache-herdr-");
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
  const cli = async (...args: string[]) => JSON.parse((await exec("herdr", args, { env })).stdout);
  return {
    socketPath: env.HERDR_SOCKET_PATH!,
    /** A pane whose directory is then deleted under it, as when its worktree is removed. */
    paneLeftIn: async (directory: string) => {
      await mkdir(directory, { recursive: true });
      const created = await cli("workspace", "create", "--cwd", directory, "--no-focus");
      await rm(directory, { recursive: true });
      return created.result.root_pane.pane_id as string;
    },
    close: async (pane: string) => await cli("pane", "close", pane),
    stop: async () => {
      // allow-swallowed-rejection -- a server already gone has nothing to stop
      await exec("herdr", ["server", "stop"], { env }).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

it.runIf(process.platform === "darwin")(
  "real installed dependencies and tagged Rust outputs reclaim only when clean, idle and expired, preserving unlanded commits",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-cache-proof-")));
    const repo = join(root, "owner");
    const tree = join(root, "agents", "worker");
    const git = async (path: string, args: string[]) =>
      (
        await exec(
          "git",
          ["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
          { timeout: 5000 },
        )
      ).stdout.trimEnd();
    const herdr = await isolatedHerdr();
    try {
      await mkdir(repo);
      await git(repo, ["init", "--initial-branch=main"]);
      await git(repo, ["config", "user.name", "Filesystem fixture"]);
      await git(repo, ["config", "user.email", "fixture@example.invalid"]);
      await writeFile(join(repo, ".gitignore"), "node_modules/\ntarget/\n.local/\n");
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "cache-proof",
          version: "1.0.0",
          dependencies: { fixture: "file:./fixture" },
        }),
      );
      await writeFile(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
      await mkdir(join(repo, "apps", "installed"), { recursive: true });
      await writeFile(
        join(repo, "apps", "installed", "package.json"),
        JSON.stringify({
          name: "installed-importer",
          version: "1.0.0",
          dependencies: { fixture: "file:../../fixture" },
        }),
      );
      await mkdir(join(repo, "fixture"));
      await writeFile(
        join(repo, "fixture", "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0" }),
      );
      await writeFile(
        join(repo, "Cargo.toml"),
        '[package]\nname="cache-proof"\nversion="0.1.0"\nedition="2021"\n',
      );
      await mkdir(join(repo, "src"));
      await writeFile(join(repo, "src", "lib.rs"), "pub fn retained() -> u32 { 42 }\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "base"]);
      await git(repo, ["worktree", "add", "-b", "unlanded-worker", tree]);
      await exec("pnpm", ["install", "--offline", "--ignore-scripts"], { cwd: tree, timeout: 30000 });
      await exec("cargo", ["build", "--offline"], {
        cwd: tree,
        timeout: 30000,
        env: {
          ...process.env,
          RUSTUP_HOME: join(userInfo().homedir, ".rustup"),
          CARGO_HOME: join(root, "cargo-home"),
        },
      });
      await git(tree, ["add", "."]);
      await git(tree, ["commit", "-m", "unlanded lockfiles"]);
      const head = await git(tree, ["rev-parse", "HEAD"]);
      const importerCache = join(tree, "apps", "installed", "node_modules");
      expect(existsSync(importerCache)).toBe(true);
      const unverified = join(tree, "apps", "never-installed", "node_modules");
      await mkdir(unverified, { recursive: true });
      await writeFile(join(unverified, "keep.txt"), "unverified cache\n");
      await mkdir(join(tree, ".local"));
      await writeFile(join(tree, ".local", "evidence.log"), "keep evidence\n");
      const runner = createHerdrWatchRunner(undefined, undefined, undefined, {
        localCodexRecovery: false,
        localReadBinding: async () => ({ socketPath: herdr.socketPath, session: "default" }),
      });
      const sweep = (retentionMs?: number) =>
        reclaimWorktreeCaches(repo, runner, {
          roots: [join(root, "agents")],
          ...(retentionMs === undefined ? {} : { retentionMs }),
        });
      // A pane left in a deleted directory makes the pane census unknown: the sweep refuses,
      // naming the path, until that pane closes (VUH-2608).
      const stranded = await herdr.paneLeftIn(join(root, "removed"));
      const unknown = await sweep(0);
      expect(unknown.outcome).toBe("unavailable");
      expect(unknown.reclaimed).toEqual([]);
      expect(JSON.stringify(unknown.kept)).toContain(join(root, "removed"));
      await herdr.close(stranded);
      const recent = await sweep();
      expect(recent.outcome, JSON.stringify(recent)).toBe("reclaimed");
      expect(recent.reclaimed).toEqual([]);
      expect(recent.kept.some((entry) => entry.reason === "recent")).toBe(true);
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        cwd: tree,
        stdio: "ignore",
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      try {
        const live = await sweep(0);
        expect(live.reclaimed).toEqual([]);
        expect(live.kept.some((entry) => entry.reason.includes("live_cwd"))).toBe(true);
      } finally {
        const stopped = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await stopped;
      }
      await writeFile(join(tree, "src", "lib.rs"), "pub fn edited() -> u32 { 7 }\n");
      expect((await sweep(0)).reclaimed).toEqual([]);
      expect(await readFile(join(tree, "src", "lib.rs"), "utf8")).toContain("edited");
      await git(tree, ["restore", "src/lib.rs"]);
      await writeFile(join(tree, "uncommitted.txt"), "keep this too\n");
      expect((await sweep(0)).reclaimed).toEqual([]);
      await rm(join(tree, "uncommitted.txt"));
      const api = createWorktreeCacheRoutes({
        authenticate: createBearerAuthenticator("cache-fixture-owner", { operatorId: "fixture-owner" }),
        reclaim: async (repository, path) => {
          if (repository !== repo) throw Error("Unregistered fixture checkout");
          return reclaimWorktreeCaches(repository, runner, {
            roots: [join(root, "agents")],
            retentionMs: 0,
            ...(path === undefined ? {} : { path }),
          });
        },
      });
      const server = serve({ fetch: api.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
      await new Promise<void>((resolve) => server.once("listening", resolve));
      let cleared: Awaited<ReturnType<typeof sweep>>;
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw Error("Missing fixture address");
        const host = `http://127.0.0.1:${address.port}`;
        expect(
          (
            await fetch(`${host}/v1/checkouts/reclaim-caches`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ repository: repo }),
            })
          ).status,
        ).toBe(401);
        expect(existsSync(join(tree, "node_modules"))).toBe(true);
        expect(
          (
            await fetch(`${host}/v1/checkouts/reclaim-caches`, {
              method: "POST",
              headers: { authorization: "Bearer cache-fixture-owner", "content-type": "application/json" },
              body: JSON.stringify({ repository: repo, retentionMs: 0 }),
            })
          ).status,
        ).toBe(400);
        cleared = (await runCheckoutsCommand(["reclaim-caches", "--repository", repo, "--path", tree], {
          host,
          env: { CLANKIE_OPERATOR_TOKEN: "cache-fixture-owner" },
        })) as Awaited<ReturnType<typeof sweep>>;
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
      expect(cleared.reclaimed, JSON.stringify(cleared)).toEqual(
        expect.arrayContaining([join(tree, "node_modules"), importerCache, join(tree, "target")]),
      );
      expect(existsSync(join(tree, "node_modules"))).toBe(false);
      expect(existsSync(importerCache)).toBe(false);
      expect(await readFile(join(unverified, "keep.txt"), "utf8")).toBe("unverified cache\n");
      expect(existsSync(join(tree, "target"))).toBe(false);
      expect(await git(tree, ["rev-parse", "HEAD"])).toBe(head);
      expect(await git(tree, ["show", `${head}:src/lib.rs`])).toContain("retained");
      expect(await readFile(join(tree, ".local", "evidence.log"), "utf8")).toBe("keep evidence\n");
      await mkdir(join(tree, "target"));
      await writeFile(join(tree, "target", "source.txt"), "unverified output\n");
      expect((await sweep(0)).reclaimed).toEqual([]);
      expect(await readFile(join(tree, "target", "source.txt"), "utf8")).toBe("unverified output\n");
      await writeFile(join(tree, "target", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
      const nested = join(tree, "target", "nested");
      await mkdir(nested);
      await git(nested, ["init", "--initial-branch=main"]);
      await git(nested, ["config", "user.name", "Nested fixture"]);
      await git(nested, ["config", "user.email", "fixture@example.invalid"]);
      await writeFile(join(nested, "keep.txt"), "keep nested commit\n");
      await git(nested, ["add", "keep.txt"]);
      await git(nested, ["commit", "-m", "keep nested commit"]);
      const nestedResult = await sweep(0);
      expect(nestedResult.reclaimed).toEqual([]);
      expect(nestedResult.kept.some((entry) => entry.reason.includes("nested_repository"))).toBe(true);
      expect(await git(nested, ["show", "HEAD:keep.txt"])).toBe("keep nested commit");
      console.log(
        "Real cache proof:",
        JSON.stringify({ head, reclaimed: cleared.reclaimed, keptEvidence: true, untaggedTargetKept: true }),
      );
    } finally {
      await herdr.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
