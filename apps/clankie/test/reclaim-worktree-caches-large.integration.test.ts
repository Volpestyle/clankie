import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import {
  addProjectWorktreeRoot,
  checkoutGit,
  observeLocalProjectWorktreeRoot,
  projectsRevision,
} from "@clankie/settings";
import { expect, it } from "vitest";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { reclaimWorktreeCaches } from "../src/captain/reclaim-worktree-caches.ts";
import { createWorktreeCacheRoutes } from "../src/worktree-cache-routes.ts";

const exec = promisify(execFile);
const tag = "Signature: 8a477f597d28d172789f06886806bc55\n";
const ignoredArgs = ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"];

// Comparative reproduction of the original verifier, not a substitute for native observations.
async function originalInventory(cache: string) {
  const pending = [{ path: cache, depth: 0 }];
  let seen = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (next.depth > 40) return { reason: "cache_inventory_too_deep", seen };
    const entries = await readdir(next.path, { withFileTypes: true });
    seen += entries.length;
    if (seen > 100_000) return { reason: "cache_inventory_too_large", seen };
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has(".git") || (names.has("HEAD") && names.has("objects") && names.has("refs")))
      return { reason: "nested_repository", seen };
    for (const entry of entries)
      if (entry.isDirectory() && !entry.isSymbolicLink())
        pending.push({ path: join(next.path, entry.name), depth: next.depth + 1 });
  }
  return { reason: "verified", seen };
}

async function ignoredBytes(tree: string) {
  const child = spawn("git", ["--no-optional-locks", "-C", tree, ...ignoredArgs], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bytes = 0;
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill();
      forceStop = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timeout = setTimeout(() => stop(Error("Owned Git byte inventory timed out after 60000ms")), 60_000);
    const clear = () => {
      clearTimeout(timeout);
      if (forceStop) clearTimeout(forceStop);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) stop(Error("Owned Git byte inventory exceeded 8MiB"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) + chunk.length > 1024 * 1024)
        stop(Error("Owned Git stderr exceeded 1MiB"));
      else stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clear();
      reject(error);
    });
    child.once("exit", (code) => {
      clear();
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(Error(`Git exited ${code}: ${stderr}`));
    });
  });
  return bytes;
}

// Explicit manual proof: generating and installing 100k files does not belong in push/PR CI.
it.runIf(
  process.env.LARGE_CACHE_PROOF === "1" &&
    process.platform === "darwin" &&
    existsSync(join(userInfo().homedir, ".config", "herdr", "herdr.sock")),
)(
  "large real offline installs retain actionable limits and allow safe sibling progress",
  async () => {
    const started = Date.now();
    const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-large-cache-proof-")));
    const repo = join(root, "owner");
    const agents = join(root, "agents");
    const home = join(root, "private-home");
    const payload = join(root, "package-payload");
    const large = join(agents, "large");
    const ignored = join(agents, "ignored-output");
    const dirty = join(agents, "dirty");
    const live = join(agents, "live");
    const alias = join(agents, "alias");
    const bounded = join(agents, "bounded");
    const rollback = join(agents, "rollback");
    const managedRoot = join(home, ".clankie", "pinned");
    const managed = join(managedRoot, "worker");
    const nativeSocket = join(userInfo().homedir, ".config", "herdr", "herdr.sock");
    const runner = createHerdrWatchRunner(undefined, undefined, undefined, {
      localCodexRecovery: false,
      localReadBinding: async () => ({ socketPath: nativeSocket, session: "default" }),
    });
    const git = async (cwd: string, args: string[]) =>
      (
        await exec(
          "git",
          ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
          {
            timeout: 30_000,
            env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
          },
        )
      ).stdout.trimEnd();
    const cache = async (tree: string, relative = "target") => {
      const path = join(tree, relative);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "CACHEDIR.TAG"), tag);
      await writeFile(join(path, "artifact.txt"), "owned disposable build output\n");
      return path;
    };
    const evidence: Record<string, unknown> = {
      privateRetentionMs: 0,
      defaultRetentionMs: 6 * 60 * 60_000,
      actualSixHourExpiryTested: false,
      nativeSocket,
      payloadFiles: 100_005,
    };
    try {
      await mkdir(repo);
      await mkdir(agents);
      await mkdir(managedRoot, { recursive: true });
      await mkdir(payload);
      await writeFile(
        join(payload, "package.json"),
        JSON.stringify({ name: "cache-payload", version: "1.0.0" }),
      );
      // Package-manager input, rather than unrelated files appended after installation.
      for (let bucket = 0; bucket <= 100; bucket++) {
        const path = join(payload, `bucket-${bucket}`);
        mkdirSync(path);
        const count = bucket === 100 ? 5 : 1000;
        for (let file = 0; file < count; file++) writeFileSync(join(path, `${file}.txt`), "fixture\n");
      }
      await git(repo, ["init", "--initial-branch=main"]);
      await git(repo, ["config", "user.name", "Large cache fixture"]);
      await git(repo, ["config", "user.email", "fixture@example.invalid"]);
      await writeFile(join(repo, ".gitignore"), "node_modules/\ntarget/\n.local/\nignored-*\n");
      await writeFile(join(repo, "source.txt"), "retained committed source\n");
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "large-cache-fixture",
          version: "1.0.0",
          dependencies: { "cache-payload": `file:${payload}` },
        }),
      );
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "owned fixture baseline"]);
      for (const tree of [large, ignored, dirty, live, alias, bounded, rollback, managed])
        await git(repo, ["worktree", "add", "--detach", tree, "HEAD"]);
      let settings = ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "cache-proof",
            name: "Cache proof",
            workspaces: [{ id: "owner", machineId: "local", platform: "posix", path: repo }],
          },
        ],
      });
      for (const path of [agents, managedRoot]) {
        const request = {
          projectId: "cache-proof",
          machineId: "local",
          platform: "posix" as const,
          path,
          repoPath: repo,
          expectedRevision: projectsRevision(settings),
        };
        const observation = await observeLocalProjectWorktreeRoot(request);
        expect(observation).toBeDefined();
        settings = addProjectWorktreeRoot(settings, request, observation!);
      }
      const roots = settings.projects[0]!.worktreeRoots.map((entry) => entry.path);
      const sweep = (path?: string, retentionMs: number | undefined = 0, observedRunner = runner) =>
        reclaimWorktreeCaches(repo, observedRunner, {
          roots,
          protection: { home, runtimeRoot: repo },
          ...(path === undefined ? {} : { path }),
          ...(retentionMs === undefined ? {} : { retentionMs }),
        });
      const installed = await exec(
        "pnpm",
        [
          "install",
          "--offline",
          "--ignore-scripts",
          "--store-dir",
          join(root, "pnpm-store"),
          "--config.package-import-method=copy",
        ],
        { cwd: large, timeout: 300_000, maxBuffer: 1024 * 1024 },
      );
      evidence.pnpm = installed.stdout;
      expect(await readFile(join(large, "node_modules", ".modules.yaml"), "utf8")).toMatch(
        /packageManager"?:\s*"?pnpm@/u,
      );
      const installedPayload = await realpath(join(large, "node_modules", "cache-payload"));
      expect(installedPayload.startsWith(join(large, "node_modules") + "/")).toBe(true);
      let installedFiles = 0;
      for (let bucket = 0; bucket <= 100; bucket++)
        installedFiles += (await readdir(join(installedPayload, `bucket-${bucket}`))).length;
      expect(installedFiles).toBe(100_005);
      evidence.installedFiles = installedFiles;
      await git(large, ["add", "pnpm-lock.yaml"]);
      await git(large, [
        "-c",
        "user.name=Large cache fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "retain unlanded installed lockfile",
      ]);
      const head = await git(large, ["rev-parse", "HEAD"]);
      await mkdir(join(large, ".local"));
      await writeFile(join(large, ".local", "evidence.log"), "preserve owned evidence\n");
      const sibling = await cache(large, "z-safe/target");
      const defaultRecent = await reclaimWorktreeCaches(repo, runner, {
        roots,
        path: large,
        protection: { home, runtimeRoot: repo },
      });
      expect(defaultRecent.reclaimed, JSON.stringify(defaultRecent)).toEqual([]);
      expect(defaultRecent.kept.some((entry) => entry.reason === "recent")).toBe(true);
      evidence.defaultRecent = defaultRecent;
      const api = createWorktreeCacheRoutes({
        authenticate: createBearerAuthenticator("fixture-owner", { operatorId: "fixture-owner" }),
        reclaim: async (repository, path) =>
          reclaimWorktreeCaches(repository, runner, { roots, ...(path ? { path } : {}) }),
      });
      const publicOverride = await api.request("/v1/checkouts/reclaim-caches", {
        method: "POST",
        headers: { authorization: "Bearer fixture-owner", "content-type": "application/json" },
        body: JSON.stringify({ repository: repo, retentionMs: 0 }),
      });
      expect(publicOverride.status).toBe(400);
      evidence.publicRetentionOverrideStatus = publicOverride.status;
      evidence.originalInventory = await originalInventory(join(large, "node_modules"));
      expect(evidence.originalInventory).toMatchObject({ reason: "cache_inventory_too_large" });
      console.log("LOCAL-VUH-10 original recursive limit:", JSON.stringify(evidence.originalInventory));
      const largeResult = await sweep(large);
      expect(largeResult.outcome, JSON.stringify(largeResult)).toBe("reclaimed");
      expect(largeResult.reclaimed).toContain(sibling);
      expect(
        largeResult.kept.some(
          (entry) =>
            entry.path === join(large, "node_modules") &&
            entry.reason.includes("cache_inventory_entry_limit") &&
            entry.reason.includes("phase=before-rename") &&
            entry.reason.includes("limit_entries=100000") &&
            entry.reason.includes(`cache=${join(large, "node_modules")}`),
        ),
        JSON.stringify(largeResult),
      ).toBe(true);
      expect(existsSync(join(large, "node_modules"))).toBe(true);
      expect(await git(large, ["rev-parse", "HEAD"])).toBe(head);
      expect(await git(large, ["show", "HEAD:source.txt"])).toBe("retained committed source");
      expect(await readFile(join(large, ".local", "evidence.log"), "utf8")).toBe("preserve owned evidence\n");
      evidence.largeResult = largeResult;
      await cache(ignored);
      const ordinaryIgnored = (from: number, until: number) => {
        for (let index = from; index < until; index++)
          writeFileSync(
            join(ignored, `ignored-${index.toString().padStart(5, "0")}-${"x".repeat(230)}`),
            "owned ignored ordinary file\n",
          );
      };
      ordinaryIgnored(0, 5000);
      const firstBytes = await ignoredBytes(ignored);
      expect(firstBytes).toBeGreaterThan(1024 * 1024);
      expect(firstBytes).toBeLessThan(4 * 1024 * 1024);
      const oneMiBResult = await sweep(ignored);
      expect(oneMiBResult.reclaimed, JSON.stringify(oneMiBResult)).toEqual([]);
      expect(
        oneMiBResult.kept.some(
          (entry) =>
            entry.path === ignored &&
            entry.reason.includes("git_output_limit") &&
            entry.reason.includes("phase=ignored-paths") &&
            entry.reason.includes("limit_bytes=1048576"),
        ),
        JSON.stringify(oneMiBResult),
      ).toBe(true);
      ordinaryIgnored(5000, 18000);
      const fullBytes = await ignoredBytes(ignored);
      expect(fullBytes).toBeGreaterThan(4 * 1024 * 1024);
      console.log("LOCAL-VUH-10 original ignored output:", JSON.stringify({ firstBytes, fullBytes }));
      await expect(checkoutGit(ignored, ignoredArgs)).rejects.toMatchObject({
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
      const fourMiBResult = await sweep(ignored);
      expect(fourMiBResult.reclaimed).toEqual([]);
      expect(
        fourMiBResult.kept.some(
          (entry) =>
            entry.path === ignored &&
            entry.reason.includes("git_output_limit") &&
            entry.reason.includes("phase=ignored-paths") &&
            entry.reason.includes("limit_bytes=1048576"),
        ),
        JSON.stringify(fourMiBResult),
      ).toBe(true);
      expect(await readFile(join(ignored, "ignored-17999-" + "x".repeat(230)), "utf8")).toBe(
        "owned ignored ordinary file\n",
      );
      evidence.ignoredOutput = {
        firstBytes,
        fullBytes,
        originalCheckoutGitMaxBuffer: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        oneMiBResult,
        fourMiBResult,
      };
      const dirtyCache = await cache(dirty);
      await writeFile(join(dirty, "source.txt"), "keep dirty source\n");
      const dirtyResult = await sweep(dirty);
      expect(
        dirtyResult.kept.some((entry) => entry.reason.includes("dirty")),
        JSON.stringify(dirtyResult),
      ).toBe(true);
      expect(existsSync(dirtyCache)).toBe(true);
      expect(await readFile(join(dirty, "source.txt"), "utf8")).toBe("keep dirty source\n");
      const liveCache = await cache(live);
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        cwd: live,
        stdio: "ignore",
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      try {
        const liveResult = await sweep(live);
        expect(
          liveResult.kept.some((entry) => entry.reason.includes("live_cwd")),
          JSON.stringify(liveResult),
        ).toBe(true);
        expect(existsSync(liveCache)).toBe(true);
        evidence.liveResult = liveResult;
      } finally {
        const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill();
        await stopped;
      }
      const managedCache = await cache(managed);
      expect((await sweep(managed)).reclaimed).toEqual([]);
      expect(existsSync(managedCache)).toBe(true);
      const outside = join(root, "outside-owned-cache");
      await mkdir(outside);
      await writeFile(join(outside, "sentinel.txt"), "keep alias target\n");
      await symlink(outside, join(alias, "node_modules"));
      expect((await sweep(alias)).reclaimed).toEqual([]);
      expect(await readFile(join(alias, "node_modules", "sentinel.txt"), "utf8")).toBe("keep alias target\n");
      const unknownRunner = createHerdrWatchRunner(undefined, undefined, undefined, {
        localCodexRecovery: false,
        localReadBinding: async () => ({ socketPath: join(root, "missing-herdr.sock"), session: "default" }),
      });
      const unknownResult = await sweep(live, 0, unknownRunner);
      expect(unknownResult.outcome).toBe("unavailable");
      expect(unknownResult.reclaimed).toEqual([]);
      expect(existsSync(liveCache)).toBe(true);
      const mainCache = await cache(repo);
      expect((await sweep(repo)).reclaimed).toEqual([]);
      expect(existsSync(mainCache)).toBe(true);
      // These are deliberately unverified ignored directories, not claimed package installs.
      for (let index = 0; index < 33; index++) {
        const path = join(bounded, `candidate-${index.toString().padStart(2, "0")}`, "node_modules");
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "unverified.txt"), "retained unverified directory\n");
      }
      const boundedResult = await sweep(bounded);
      expect(boundedResult.reclaimed).toEqual([]);
      expect(boundedResult.kept.filter((entry) => entry.reason === "install_unverified")).toHaveLength(32);
      expect(
        boundedResult.kept.some(
          (entry) => entry.reason.includes("cache_candidate_limit") && entry.reason.includes("limit=32"),
        ),
      ).toBe(true);
      for (let index = 0; index < 33; index++)
        expect(
          existsSync(
            join(bounded, `candidate-${index.toString().padStart(2, "0")}`, "node_modules", "unverified.txt"),
          ),
        ).toBe(true);
      evidence.boundedCandidates = boundedResult;
      const rollbackCache = await cache(rollback);
      let occupiedOriginal = false;
      const collisionResult = await reclaimWorktreeCaches(repo, runner, {
        roots,
        path: rollback,
        protection: { home, runtimeRoot: repo },
        retentionMs: 0,
        guard: async () => {
          if (occupiedOriginal || existsSync(rollbackCache)) return;
          const aside = (await readdir(rollback)).find((name) => name.startsWith("target.clankie-reclaim-"));
          if (!aside) return;
          await mkdir(rollbackCache);
          await writeFile(join(rollbackCache, "new-install.txt"), "preserve newly occupied original name\n");
          occupiedOriginal = true;
          throw Error("owned_rollback_collision");
        },
      });
      expect(occupiedOriginal).toBe(true);
      expect(collisionResult.reclaimed).toEqual([]);
      const collisionAside = collisionResult.kept.find((entry) =>
        entry.path.startsWith(`${rollbackCache}.clankie-reclaim-`),
      );
      expect(collisionAside, JSON.stringify(collisionResult)).toBeDefined();
      expect(collisionAside!.reason).toContain("owned_rollback_collision");
      expect(await readFile(join(rollbackCache, "new-install.txt"), "utf8")).toBe(
        "preserve newly occupied original name\n",
      );
      expect(await readFile(join(collisionAside!.path, "artifact.txt"), "utf8")).toBe(
        "owned disposable build output\n",
      );
      evidence.rollbackCollision = collisionResult;
      evidence.protections = {
        dirtyResult,
        unknownResult,
        managedRetained: true,
        aliasTargetRetained: true,
        mainRetained: true,
        sourceAndUnlandedHeadRetained: true,
        evidenceRetained: true,
      };
      evidence.elapsedMs = Date.now() - started;
      const receipt = process.env.LARGE_CACHE_PROOF_RECEIPT;
      if (receipt) await writeFile(receipt, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
      console.log("LOCAL-VUH-10 large cache proof:", JSON.stringify(evidence));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  600_000,
);
