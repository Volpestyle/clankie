import { serve } from "@hono/node-server";
import { execFile, spawn, type ExecFileOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  appendFile,
  chmod,
  glob,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, aroundEach, beforeAll, expect, it, vi } from "vitest";
import { IntegrationRunSchema } from "@clankie/protocol/integrate";
import { DeployHolds, durableJson, withDirectoryLock } from "../src/deploy-holds.ts";
import { IntegrationQueue, integrationSources } from "../src/integrate.ts";
import { FleetProgressObserver } from "../src/fleet-progress.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createRuntimeUpdater } from "../../tui/bin/runtime-updater.ts";
import { deployHoldPresence } from "../src/deploy-hold-presence.ts";
import { createIntegrationRoutes } from "../src/integrate-routes.ts";
import { runIntegrationCommand } from "../../tui/src/command/integrate.ts";
import { fixtureWork, withFixtureWork } from "../../../scripts/testing/fixture-work.ts";

// Keep the real kernel proof, including every pre-deletion recheck. Churn is
// unknown, never deletion authority; wait boundedly for a complete observation.
// This test-only adapter also covers the queue's automatic cleanup path.
vi.mock("../src/process-working-directories.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process-working-directories.ts")>();
  return {
    ...actual,
    async processWorkingDirectories() {
      const deadline = performance.now() + 10_000;
      for (;;) {
        fixtureWork().signal.throwIfAborted();
        try {
          return await actual.processWorkingDirectories();
        } catch (error) {
          if (
            !String(error).includes("Incomplete account process cwd census:") ||
            performance.now() >= deadline
          )
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
});

aroundEach(withFixtureWork);
const nativeExecute = promisify(execFile);
beforeAll(async () => {
  if (process.platform === "darwin")
    await nativeExecute(process.execPath, [
      join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs"),
    ]);
});
const execute = (file: string, args: string[], options: ExecFileOptions = {}) => {
  const work = fixtureWork();
  return work.run(() => nativeExecute(file, args, { ...options, encoding: "utf8", signal: work.signal }));
};
const roots: string[] = [];
const queues: IntegrationQueue[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async (context) => {
  fixtureWork().stop();
  // A batch's own install and gate output is the only record of why it failed (VUH-2059).
  if (context.task.result?.state === "fail")
    for (const root of roots)
      for await (const log of glob("integration/batches/*/*.log", { cwd: root }))
        console.error(
          `--- ${log} (last 4000 bytes)\n${(await readFile(join(root, log), "utf8").catch(String)).slice(-4000)}`,
        );
  // Release only our gate barriers; a cancelled test cannot leave a writer parked.
  for (const root of roots) await writeFile(join(root, "release"), "go");
  await fixtureWork().drain();
  for (const close of cleanups.splice(0)) await close();
  await Promise.all(queues.splice(0).map((queue) => queue.wait()));
  // Gate temps live outside the batch root (short socket paths); remove them too.
  for (const root of roots)
    for await (const link of glob("**/isolation/*/tmp", { cwd: root }))
      await readlink(join(root, link)).then(
        (target) => rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
        () => undefined,
      );
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});
async function git(directory: string, ...args: string[]): Promise<string> {
  // Pushed history remains inspectable in the private commit store after scratch cleanup.
  if (!existsSync(directory)) {
    const name = directory.endsWith("clankie-app") ? "app" : "core";
    directory = directory.replace(/[/]worktrees[/]clankie(-app)?$/u, `/repositories/${name}`);
    args = args.map((arg) => arg.replace(/^HEAD(?=$|[~^:])/u, `refs/clankie/retained/${name}`));
  }
  return (await execute("git", ["-c", "core.hooksPath=/dev/null", "-C", directory, ...args])).stdout.trim();
}
function fixture(
  gateExtra: string | ((root: string) => string) = "",
  withApp = false,
  appGateExtra: string | ((root: string) => string) = "",
  landingGate = false,
  appDeclaresRetry = false,
) {
  return fixtureWork().run(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-integrate-")));
    roots.push(root);
    async function repo(name: string) {
      const source = join(root, name === "core" ? "clankie" : "clankie-app");
      const origin = join(root, `${name === "core" ? "clankie" : "clankie-app"}.git`);
      await mkdir(source);
      await git(root, "init", "--bare", origin);
      await git(source, "init", "-b", "main");
      await git(source, "config", "user.name", "Fixture");
      await git(source, "config", "user.email", "fixture@example.invalid");
      await git(source, "remote", "add", "origin", origin);
      await writeFile(
        join(source, "package.json"),
        JSON.stringify({
          name,
          private: true,
          scripts: { check: "node gate.mjs", ...(landingGate ? { "check:landing": "node gate.mjs" } : {}) },
          packageManager: "pnpm@11.11.0",
          ...(name === "app" && appDeclaresRetry
            ? { clankie: { landingGate: { retryFailedTests: true } } }
            : {}),
        }),
      );
      await writeFile(join(source, ".gitignore"), "node_modules/\n");
      const extra = name === "core" ? gateExtra : appGateExtra;
      await writeFile(
        join(source, "gate.mjs"),
        `
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
assert.match(homedir(), /isolation[\\/](core|app)[\\/]home$/);
assert.equal(process.env.CLANKIE_CONTROL_PLANE_URL, 'http://127.0.0.1:1');
assert.equal(process.env.CLANKIE_OPERATOR_TOKEN, undefined);
assert.equal(process.env.DISCORD_BOT_TOKEN, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.CLANKIE_KEYCHAIN_TESTS, undefined);
assert.ok(process.env.CLANKIE_CREDENTIALS_FILE.startsWith(homedir()));
assert.ok(process.env.npm_config_store_dir.includes('isolation'));
// Fixture Unix sockets live under TMPDIR; macOS limits their paths to ~104 bytes.
assert.ok(Buffer.byteLength(join(process.env.TMPDIR, 'clankie-world-body-XXXXXX', 'host.sock')) < 104);
if (process.platform !== 'win32') assert.equal(statSync(process.env.TMPDIR).mode & 0o077, 0);
const descriptor = join(process.env.CLANKIE_STATE, 'links', 'default-local.json');
assert.equal(existsSync(descriptor), false);
mkdirSync(dirname(descriptor), { recursive: true });
writeFileSync(descriptor, 'private-fixture');
mkdirSync(dirname(process.env.CLANKIE_CREDENTIALS_FILE), { recursive: true });
writeFileSync(process.env.CLANKIE_CREDENTIALS_FILE, '{}');
console.log('fixture-gate-isolated', process.cwd());
${typeof extra === "function" ? extra(root) : extra}
`,
      );
      await execute("pnpm", ["install", "--lockfile-only"], { cwd: source });
      await git(source, "add", ".");
      await git(source, "commit", "-m", "base");
      await git(source, "push", "origin", "HEAD:main"); // Local bare fixture only.
      return { source, origin, base: await git(source, "rev-parse", "HEAD") };
    }
    const core = await repo("core");
    const app = withApp ? await repo("app") : undefined;
    const directory = join(root, "integration");
    const holds = new DeployHolds(directory);
    const rawQueue = new IntegrationQueue({
      directory,
      core: core.source,
      ...(app ? { app: app.source } : {}),
    });
    queues.push(rawQueue);
    const queue = fixtureWork().wrap(rawQueue);
    return { root, core, app, directory, holds, queue };
  });
}
async function commit(source: string, file: string, value: string) {
  await writeFile(join(source, file), value);
  await git(source, "add", file);
  await git(source, "commit", "-m", file);
  return git(source, "rev-parse", "HEAD");
}
const guard = async () => {
  fixtureWork().signal.throwIfAborted();
};

it("composes in order on fresh origin, installs real siblings, gates privately and durably reloads exact HEAD", async () => {
  const f = await fixture(
    "assert.ok(existsSync('../clankie-app/package.json')); assert.ok(process.argv.includes('--retry-failed-tests'));",
    true,
    "assert.equal(process.argv.includes('--retry-failed-tests'), false);",
    true,
  );
  const runtime = join(f.root, "nested-runtime");
  await git(f.core.source, "worktree", "add", "--detach", runtime, "HEAD");
  expect(await integrationSources(runtime)).toEqual({ core: f.core.source, app: f.app!.source });
  const a = await commit(f.core.source, "first", "one");
  const b = await commit(f.core.source, "second", "two");
  const appCommit = await commit(f.app!.source, "feature", "app");
  // Advance origin independently of the builder to establish a fresh-origin composition.
  await git(f.core.source, "checkout", "-b", "remote", f.core.base);
  const current = await commit(f.core.source, "remote", "latest");
  await git(f.core.source, "push", "origin", "HEAD:main");
  await git(f.core.source, "checkout", "main");
  const request = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    core: [a, b],
    app: [appCommit],
  });
  const inherited = ["CLANKIE_OPERATOR_TOKEN", "DISCORD_BOT_TOKEN", "NODE_OPTIONS", "CLANKIE_KEYCHAIN_TESTS"];
  const previous = inherited.map((key) => process.env[key]);
  try {
    for (const key of inherited) process.env[key] = "synthetic-parent-secret";
    await f.queue.start(request, guard);
    await f.queue.wait();
  } finally {
    for (const [index, key] of inherited.entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
  const batch = await new IntegrationQueue(f.queue.options).status(request.id);
  expect(batch.state).toBe("passed");
  expect(batch.repos).toHaveLength(2);
  expect(batch.repos[0]!.base).toBe(current);
  for (const repo of batch.repos) {
    expect(repo.commits.map((c) => c.state)).toEqual(
      repo.name === "core" ? ["applied", "applied"] : ["applied"],
    );
    expect(repo.install?.exitCode).toBe(0);
    expect(repo.gate?.exitCode).toBe(0);
    expect(repo.gate?.head).toBe(repo.head);
    expect(await readFile(repo.gate!.log, "utf8")).toContain("fixture-gate-isolated");
    const common = await git(repo.directory, "rev-parse", "--git-common-dir");
    expect(common).toContain("repositories");
    expect(await git(repo.source, "rev-parse", "HEAD")).toBe(repo.name === "core" ? b : appCommit);
    expect(await git(repo.source, "ls-remote", "origin", "refs/heads/main")).toContain(repo.base);
  }
  expect(await readFile(join(batch.repos[0]!.directory, "first"), "utf8")).toBe("one");
  expect(await f.queue.start(request, guard)).toMatchObject({ id: request.id, state: "passed" });
  const landed = await f.queue.land(request.id, guard);
  expect(landed.state).toBe("pushed");
  expect(landed.repos[0]!.ownerCheckoutSync).toMatchObject({
    outcome: "blocked",
    reason: expect.stringContaining("local commits"),
  });
  for (const repo of batch.repos)
    expect(await git(repo.source, "ls-remote", "origin", "refs/heads/main")).toContain(repo.head);
});

// VUH-2166: the app's own gate parses its options strictly, so the queue
// passes it the failed-file retry flag only once its composed tree declares it.
it("passes the failed-test retry flag to an app landing gate that declares the contract", async () => {
  const f = await fixture(
    "assert.ok(process.argv.includes('--retry-failed-tests'));",
    true,
    "assert.ok(process.argv.includes('--retry-failed-tests'));",
    true,
    true,
  );
  const request = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    core: [await commit(f.core.source, "first", "one")],
    app: [await commit(f.app!.source, "feature", "app")],
  });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const batch = await new IntegrationQueue(f.queue.options).status(request.id);
  expect(batch.repos.map((repo) => [repo.name, repo.gate?.exitCode])).toEqual([
    ["core", 0],
    ["app", 0],
  ]);
});

it("attributes a conflict to its input commit and blocks subsequent commits without touching source", async () => {
  const f = await fixture();
  const approved = await commit(f.core.source, "file", "approved");
  const later = await commit(f.core.source, "later", "later");
  await git(f.core.source, "checkout", "-b", "remote", f.core.base);
  const remote = await commit(f.core.source, "file", "remote");
  await git(f.core.source, "push", "origin", "HEAD:main");
  await git(f.core.source, "checkout", "main");
  const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [approved, later] });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const batch = await f.queue.status(request.id);
  expect(batch.state).toBe("conflict");
  expect(batch.repos[0]!.commits).toMatchObject([
    { commit: approved, state: "conflict", conflicts: ["file"] },
    { commit: later, state: "blocked" },
  ]);
  expect(batch.repos[0]!.gate).toBeUndefined();
  expect(await git(f.core.source, "rev-parse", "HEAD")).toBe(later);
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(remote);
});

it("records a real gate driver stopped mid-test as interrupted with its retained logs and no push", async () => {
  const f = await fixture(`
let parent = process.ppid;
let stopped = false;
for (let depth = 0; depth < 6 && parent > 1; depth++) {
  const row = execFileSync('ps', ['-p', String(parent), '-o', 'ppid=', '-o', 'command='], { encoding: 'utf8' }).trim();
  const next = Number(row.split(/\\s+/, 1)[0]);
  if (row.includes('integrate-gate-driver.mjs')) {
    console.log('fixture stopped its owned gate driver', parent);
    process.kill(parent, 'SIGTERM');
    stopped = true;
    break;
  }
  parent = next;
}
assert.ok(stopped, 'exact owned driver ancestor must be found');
`);
  const approved = await commit(f.core.source, "feature", "retain interrupted work");
  const request = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    core: [approved],
    push: true,
  });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const batch = await f.queue.status(request.id);
  expect(batch.state, JSON.stringify(batch)).toBe("interrupted");
  expect(batch.error).toMatch(/without a completion receipt for core gate/u);
  expect(batch.error).not.toContain("undefined");
  expect(batch.repos[0]!.install?.exitCode).toBe(0);
  expect(batch.repos[0]!.gate).toBeUndefined();
  expect(await readFile(join(f.directory, "batches", request.id, "core-gate.log"), "utf8")).toContain(
    "fixture-gate-isolated",
  );
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(f.core.base);
  const stored = JSON.parse(await readFile(batch.evidence, "utf8"));
  expect(stored.state).toBe("interrupted");
  expect((await f.queue.snapshot()).interrupted.map((entry) => entry.id)).toContain(request.id);
  console.log(
    "Interrupted driver proof:",
    JSON.stringify({
      state: batch.state,
      error: batch.error,
      install: batch.repos[0]!.install,
      gate: batch.repos[0]!.gate ?? null,
      originUnchanged: true,
    }),
  );
});

it("keeps a completed frozen-lockfile install failure failed when later sibling phases never started", async () => {
  const f = await fixture("", true);
  const manifest = JSON.parse(await readFile(join(f.core.source, "package.json"), "utf8"));
  manifest.dependencies = { "not-in-the-installed-lockfile": "1.0.0" };
  const approved = await commit(f.core.source, "package.json", JSON.stringify(manifest));
  const appApproved = await commit(f.app!.source, "app-feature", "retain sibling source");
  const request = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    core: [approved],
    app: [appApproved],
    push: true,
  });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const batch = await f.queue.status(request.id);
  expect(batch.state, JSON.stringify(batch)).toBe("failed");
  expect(batch.repos[0]!.install?.exitCode).not.toBe(0);
  expect(batch.repos[1]!.install).toBeUndefined();
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(f.core.base);
});

it.each(["process.exit(7);", "execFileSync('git', ['commit', '--allow-empty', '-m', 'gate moved HEAD']);"])(
  "retains exit and tested HEAD when a gate fails or changes HEAD (%s)",
  async (extra) => {
    const f = await fixture(extra);
    const approved = await commit(f.core.source, "feature", "test");
    const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [approved] });
    await f.queue.start(request, guard);
    await f.queue.wait();
    const batch = await f.queue.status(request.id);
    expect(batch.state).toBe("failed");
    expect(batch.repos[0]!.gate?.exitCode).toBe(extra.startsWith("process") ? 7 : 0);
    expect(batch.repos[0]!.gate?.head).toBe(batch.repos[0]!.head);
    await expect(f.queue.land(request.id, guard)).rejects.toThrow("no landable pass");
    expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(f.core.base);
  },
);

it.each(["head", "dirty", "origin"])("refuses a saved pass after %s changes", async (change) => {
  const f = await fixture();
  const approved = await commit(f.core.source, "feature", "test");
  const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [approved] });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const batch = await f.queue.status(request.id);
  expect(batch.state).toBe("passed");
  const repo = batch.repos[0]!;
  if (change === "head") await git(repo.directory, "commit", "--allow-empty", "-m", "after gate");
  else if (change === "dirty") await writeFile(join(repo.directory, "feature"), "after gate");
  else {
    await commit(f.core.source, "other", "remote drift");
    await git(f.core.source, "push", "origin", "HEAD:main");
  }
  const refused = await f.queue.land(request.id, guard);
  expect(refused.state).toBe("held");
  expect(refused.repos[0]!.push).toBeUndefined();
  expect(refused.error).toMatch(/exact HEAD|worktree changed|origin\/main moved/u);
});

it("a timed hold blocks runtime updates but not landing, shows its age and time left, and lifts with a receipt", async () => {
  const f = await fixture();
  const approved = await commit(f.core.source, "feature", "test");
  const emptySnapshot = JSON.stringify({ result: { snapshot: { workspaces: [], tabs: [], panes: [] } } });
  let clock = Date.now();
  const holds = new DeployHolds(
    f.directory,
    (hold) => deployHoldPresence(hold, async () => emptySnapshot),
    () => clock,
  );
  const rawQueue = new IntegrationQueue({ ...f.queue.options });
  queues.push(rawQueue);
  const queue = fixtureWork().wrap(rawQueue);
  // This real updater refuses an unpinned fixture checkout before ever spawning its helper.
  const updater = createRuntimeUpdater({ repoRoot: f.core.source, env: { ...process.env, HOME: f.root } });
  const service = await fixtureWork().run(async () => {
    const service = await createClankieApp({
      integration: queue,
      deployHolds: holds,
      runtimeUpdater: updater,
      captain: createStubCaptain(),
      authenticateOperator: async (r) =>
        r.headers.get("authorization") === "Bearer fixture-owner"
          ? { operatorId: "fixture-owner" }
          : undefined,
    });
    cleanups.push(() => service.close());
    return service;
  });
  const fetchImpl: typeof fetch = async (input, init) => service.app.fetch(new Request(input, init));
  const cli = { host: "http://fixture.invalid", fetchImpl, env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" } };
  const deploy = () =>
    fetchImpl("http://fixture.invalid/v1/runtime-update", {
      method: "POST",
      headers: { authorization: "Bearer fixture-owner", "content-type": "application/json" },
      body: "{}",
    });
  const hold = ["hold", "--holder", "Bram w3Z:p2N", "--pane", "w3Z:p2N", "--reason", "live test"];
  // A hold names its minutes, at most the ceiling.
  await expect(runIntegrationCommand(hold, cli)).rejects.toThrow("--minutes from 1 to 60");
  await expect(runIntegrationCommand([...hold, "--minutes", "61"], cli)).rejects.toThrow("--minutes");
  const unbounded = await fetchImpl("http://fixture.invalid/v1/integrate", {
    method: "POST",
    headers: { authorization: "Bearer fixture-owner", "content-type": "application/json" },
    body: JSON.stringify({ action: "hold", id: randomUUID(), holder: "Saga", reason: "release gate" }),
  });
  expect(unbounded.status).toBe(400);
  const holdId = randomUUID();
  const acquired = await runIntegrationCommand([...hold, "--id", holdId, "--minutes", "30"], cli);
  expect(acquired.holds).toMatchObject([
    {
      id: holdId,
      holder: "Bram w3Z:p2N",
      reason: "live test",
      presence: "gone",
      expiresAt: new Date(clock + 30 * 60_000).toISOString(),
    },
  ]);

  // Landing on main does not wait for a hold.
  const id = randomUUID();
  await runIntegrationCommand([approved, "--id", id, "--push", "--no-wait"], cli);
  await rawQueue.wait();
  expect((await runIntegrationCommand(["status", id], cli)).batch?.state).toBe("pushed");
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).not.toContain(f.core.base);

  // The refusal names the holder, how long it has held and the time left.
  clock += 12 * 60_000;
  const refused = await deploy();
  expect(refused.status).toBe(409);
  expect((await refused.json()) as { detail: string }).toMatchObject({
    detail: expect.stringContaining(`${holdId} by Bram w3Z:p2N: live test (held 12m, 18m left)`),
  });

  // At expiry it lifts on its own, with a receipt naming the holder.
  clock += 18 * 60_000;
  expect(await holds.list()).toEqual([]);
  expect(await holds.expire()).toMatchObject([
    {
      action: "expire",
      actor: "Clankie",
      reason: "Bram w3Z:p2N's hold lifted on its own after 30 minutes",
      at: new Date(clock).toISOString(),
      hold: { id: holdId, holder: "Bram w3Z:p2N" },
    },
  ]);
  expect((await deploy().then((r) => r.json())) as { detail: string }).not.toMatchObject({
    detail: expect.stringContaining("Deploy held"),
  });
  expect((await runIntegrationCommand(["holds"], cli)).receipts).toMatchObject([
    { action: "expire", hold: { id: holdId } },
  ]);
  await expect(
    runIntegrationCommand(["release", holdId, "--actor", "Clankie", "--reason", "late"], cli),
  ).rejects.toThrow(/already ended \(expire at /u);

  // The lead releases someone else's hold, and the receipt records holder, actor and reason.
  const other = randomUUID();
  await runIntegrationCommand(
    ["hold", "--id", other, "--holder", "Saga w4:p1", "--reason", "release gate", "--minutes", "20"],
    cli,
  );
  const released = await runIntegrationCommand(
    ["release", other, "--actor", "Clankie (lead)", "--reason", "gate finished an hour ago"],
    cli,
  );
  expect(released).toMatchObject({
    holds: [],
    receipts: [
      {
        action: "release",
        actor: "Clankie (lead)",
        reason: "gate finished an hour ago",
        hold: { id: other, holder: "Saga w4:p1" },
      },
    ],
  });
  const audit = JSON.parse(await readFile(join(f.directory, "holds.json"), "utf8"));
  expect(audit.events.map((event: { action: string }) => event.action)).toEqual(["expire", "release"]);
  expect(
    await deployHoldPresence(acquired.holds![0]!, async () => {
      throw Error("socket unavailable");
    }),
  ).toBe("unknown");
});

it("restores a passed tree with a new gated forward commit, retaining bad history", async () => {
  const f = await fixture();
  const approved = await commit(f.core.source, "feature", "good");
  const goodRequest = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    core: [approved],
    push: true,
  });
  await f.queue.start(goodRequest, guard);
  await f.queue.wait();
  const good = await f.queue.status(goodRequest.id);
  expect(good.state).toBe("pushed");
  const repo = good.repos[0]!;
  // Simulate an unrelated bad push using only the disposable bare origin.
  await git(f.core.source, "fetch", "origin");
  await git(f.core.source, "checkout", "-B", "main", "origin/main");
  const bad = await commit(f.core.source, "feature", "bad");
  await git(f.core.source, "push", "origin", "HEAD:main");
  const restore = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    restore: good.id,
    push: true,
  });
  await f.queue.start(restore, guard);
  await f.queue.wait();
  const restored = await f.queue.status(restore.id);
  expect(restored.state).toBe("pushed");
  const head = restored.repos[0]!.head;
  expect(
    await git(join(f.directory, "batches", restored.id, "repositories", "core"), "rev-parse", `${head}^`),
  ).toBe(bad);
  expect(
    await git(
      join(f.directory, "batches", restored.id, "repositories", "core"),
      "rev-parse",
      `${head}^{tree}`,
    ),
  ).toBe(
    await git(
      join(f.directory, "batches", good.id, "repositories", "core"),
      "rev-parse",
      `${repo.head}^{tree}`,
    ),
  );
  expect(head).not.toBe(repo.head);
  expect(restored.repos[0]!.gate?.head).toBe(head);
});

it("records core landed/app pending on app rejection and retries only app", async () => {
  const f = await fixture("", true);
  const core = await commit(f.core.source, "feature", "core");
  const app = await commit(f.app!.source, "feature", "app");
  const count = join(f.root, "core-landings");
  const coreHook = join(f.core.origin, "hooks", "pre-receive");
  const appHook = join(f.app!.origin, "hooks", "pre-receive");
  await writeFile(coreHook, `#!/bin/sh\ncat >/dev/null\necho landed >> '${count}'\n`);
  await chmod(coreHook, 0o700);
  await writeFile(appHook, "#!/bin/sh\necho fixture-rejection >&2\nexit 1\n");
  await chmod(appHook, 0o700);
  const request = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    core: [core],
    app: [app],
    push: true,
  });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const partial = await f.queue.status(request.id);
  expect(partial.state).toBe("partial");
  expect(partial.error).toContain(`Core landed at ${partial.repos[0]!.head}; app pending`);
  expect(partial.repos[0]!.push?.state).toBe("confirmed");
  expect(partial.repos[1]!.push?.state).toBe("rejected");
  expect(await readFile(count, "utf8")).toBe("landed\n");
  expect(await git(f.app!.source, "ls-remote", "origin", "refs/heads/main")).toContain(f.app!.base);
  await rm(appHook);
  const landed = await f.queue.land(request.id, guard);
  expect(landed.state).toBe("pushed");
  expect(await readFile(count, "utf8")).toBe("landed\n");
  expect(landed.repos[0]!.push).toEqual(partial.repos[0]!.push);
  expect(await git(f.app!.source, "ls-remote", "origin", "refs/heads/main")).toContain(landed.repos[1]!.head);
});

it("a confirmed integration push fast-forwards clean owner main and persists the sync receipt", async () => {
  const f = await fixture();
  await git(f.core.source, "switch", "-c", "worker");
  const approved = await commit(f.core.source, "new-feature", "approved");
  await git(f.core.source, "switch", "main");
  const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [approved] });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const landed = await f.queue.land(request.id, guard);
  expect(landed.state).toBe("pushed");
  expect(landed.repos[0]!.ownerCheckoutSync).toMatchObject({
    outcome: "updated",
    path: f.core.source,
    before: f.core.base,
    after: landed.repos[0]!.head,
  });
  expect(await git(f.core.source, "rev-parse", "HEAD")).toBe(landed.repos[0]!.head);
  expect((await f.queue.status(request.id)).repos[0]!.ownerCheckoutSync).toEqual(
    landed.repos[0]!.ownerCheckoutSync,
  );
});

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error("Fixture gate did not reach barrier");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const barrier = (root: string, extra = "") => `
const fs = await import('node:fs');
const root = ${JSON.stringify(root)};
fs.appendFileSync(join(root, 'gate-count'), 'gate\\n');
fs.writeFileSync(join(root, 'started'), 'gating');
while (!existsSync(join(root, 'release'))) await new Promise(r => setTimeout(r, 20));
${extra}
`;

it("alerts once for a stale composing head across observer restart, ignores followers and a verified live gate, and records recovery", async () => {
  const f = await fixture((root) => barrier(root));
  let releasePlacement!: () => void;
  let entered!: () => void;
  const enteredPlacement = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let placed = false;
  f.queue.options.placeGate = async () => {
    if (placed) return undefined;
    placed = true;
    entered();
    await new Promise<void>((resolve) => {
      releasePlacement = resolve;
    });
    return undefined;
  };
  const first = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [f.core.base] });
  await f.queue.start(first, guard);
  await enteredPlacement;
  const follower = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    core: [f.core.base],
    push: true,
  });
  await f.queue.start(follower, guard);
  const head = await f.queue.status(first.id);
  expect(head.state).toBe("composing");
  // A retained checkpoint fixture represents the 33-minute incident; no fake clocks or live registry.
  head.updatedAt = new Date(Date.now() - 181_000).toISOString();
  await durableJson(head.evidence, head);
  const source = { prefix: "integration", read: () => f.queue.progress() };
  expect(await source.read()).toEqual([
    expect.objectContaining({ stalled: true, message: expect.stringContaining(first.id) }),
  ]);
  const path = join(f.root, "progress-incidents.json");
  const alerts = join(f.root, "progress-alerts.jsonl");
  const options = {
    path,
    sources: [source],
    notify: async (text: string) => {
      await appendFile(alerts, `${JSON.stringify({ text })}\n`);
      return true;
    },
    onError: (error: unknown) => {
      throw error;
    },
  };
  const observer = new FleetProgressObserver(options);
  try {
    await Promise.all([observer.observe(), observer.observe()]);
    await until(async () => JSON.parse(await readFile(path, "utf8"))[0]?.alert === "submitted");
    observer.stop();
    const restarted = new FleetProgressObserver(options);
    await restarted.observe();
    expect((await readFile(alerts, "utf8")).trim().split("\n")).toHaveLength(1);
    releasePlacement();
    await until(async () => {
      try {
        await readFile(join(f.root, "started"));
        return true;
      } catch {
        return false;
      }
    });
    const gating = await f.queue.status(first.id);
    gating.updatedAt = new Date(Date.now() - 181_000).toISOString();
    await durableJson(gating.evidence, gating);
    expect(await source.read()).toEqual([]); // The exact owned native child is alive.
    await restarted.observe();
    await until(async () => JSON.parse(await readFile(path, "utf8"))[0]?.recovery === "submitted");
    expect((await readFile(alerts, "utf8")).trim().split("\n")).toHaveLength(2);
    restarted.stop();
  } finally {
    releasePlacement();
    observer.stop();
    await writeFile(join(f.root, "release"), "go");
  }
});

it("retains an uncertain progress alert without replay and keeps observing while delivery is unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-progress-"));
  roots.push(root);
  const sourcePath = join(root, "source.json");
  const incident = { id: "integration:held", stalled: true, message: "Integration head held" };
  await durableJson(sourcePath, [incident]);
  const path = join(root, "incidents.json");
  const sent = join(root, "sent.jsonl");
  const errors: unknown[] = [];
  const options = {
    path,
    sources: [{ prefix: "integration", read: async () => JSON.parse(await readFile(sourcePath, "utf8")) }],
    notify: async (text: string): Promise<boolean> => {
      await appendFile(sent, `${JSON.stringify(text)}\n`);
      return new Promise(() => {}); // Transport remains uncertain after its original dispatch.
    },
    onError: (error: unknown) => {
      errors.push(error);
    },
  };
  const observer = new FleetProgressObserver(options);
  await observer.observe();
  await until(async () => {
    try {
      return (await readFile(sent, "utf8")).length > 0;
    } catch {
      return false;
    }
  });
  await observer.observe();
  observer.stop();
  const restarted = new FleetProgressObserver(options);
  await restarted.observe();
  expect((await readFile(sent, "utf8")).trim().split("\n")).toHaveLength(1);
  await writeFile(sourcePath, "unreadable source");
  await restarted.observe();
  expect(errors).toHaveLength(1);
  expect(JSON.parse(await readFile(path, "utf8"))[0].recovery).toBeUndefined();
  await durableJson(sourcePath, []);
  await restarted.observe();
  await until(async () => (await readFile(sent, "utf8")).trim().split("\n").length === 2);
  expect(JSON.parse(await readFile(path, "utf8"))[0]).toMatchObject({
    alert: "claimed",
    recovery: "claimed",
  });
  restarted.stop();
});
async function queueCli(f: Awaited<ReturnType<typeof fixture>>, authorized = guard) {
  return fixtureWork().run(async () => {
    const api = createIntegrationRoutes({
      queue: f.queue,
      holds: f.holds,
      authorize: async (request) =>
        request.headers.get("authorization") === "Bearer fixture-owner" ? authorized : undefined,
    });
    const server = serve({ fetch: api.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing fixture HTTP address");
    return { host: `http://127.0.0.1:${address.port}`, env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" } };
  });
}

it("a push request reads pushing from its pass until it lands, and one whose push never started stays a landable pass", async () => {
  const f = await fixture((root) => barrier(root));
  const parkedId = randomUUID();
  let parked = false;
  let atPass!: () => void, resume!: () => void;
  const reachedPass = new Promise<void>((resolve) => (atPass = resolve));
  const resumed = new Promise<void>((resolve) => (resume = resolve));
  cleanups.push(() => resume());
  // The landing step re-checks the request's guard; park it once, right after the pass is stored.
  const cli = await queueCli(f, async () => {
    await guard();
    const stored = await new IntegrationQueue(f.queue.options).status(parkedId).catch(() => undefined);
    if (parked || stored?.state !== "passed") return;
    parked = true;
    atPass();
    await resumed;
  });

  // A push that never starts (its lock is busy) rests at a landable pass.
  const idle = randomUUID();
  const started = await runIntegrationCommand(
    [await commit(f.core.source, "idle", "one"), "--id", idle, "--push", "--no-wait"],
    cli,
  );
  const lock = join(started.batch!.evidence, "..", "push.lock");
  await mkdir(lock);
  await writeFile(join(f.root, "release"), "go");
  await f.queue.wait();
  expect((await runIntegrationCommand(["status", idle], cli)).batch?.state).toBe("passed");
  await rm(lock, { recursive: true });
  expect((await runIntegrationCommand(["push", idle], cli)).batch?.state).toBe("pushed");

  // Between the pass and the push, status already says the push is under way. With no
  // poller, only the landing step reaches the guard; replaying the request then waits on it.
  const parkedSha = await commit(f.core.source, "parked", "two");
  await runIntegrationCommand([parkedSha, "--id", parkedId, "--push", "--no-wait"], cli);
  await reachedPass;
  expect(await f.queue.commitHandoffs(f.core.source, [parkedSha])).toContainEqual({
    commit: parkedSha,
    requestId: parkedId,
  });
  // Historical receipts in a fresh queue are not live ownership.
  expect(await new IntegrationQueue(f.queue.options).commitHandoffs(f.core.source, [parkedSha])).toEqual([]);
  const waiting = runIntegrationCommand([parkedSha, "--id", parkedId, "--push"], cli);
  expect((await runIntegrationCommand(["status", parkedId], cli)).batch?.state).toBe("pushing");
  resume();
  expect((await waiting).batch?.state).toBe("pushed");
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(
    (await f.queue.status(parkedId)).repos[0]!.head,
  );
});

it("CLI/API coalesces arrivals during a real gate, isolating a cross-repo conflict and landing healthy members once", async () => {
  const f = await fixture((root) => barrier(root), true);
  const cli = await queueCli(f);
  const initial = await commit(f.core.source, "initial", "one");
  const a = await commit(f.core.source, "a", "healthy");
  const paired = await commit(f.core.source, "paired", "must not land");
  const b = await commit(f.core.source, "b", "healthy");
  // Install the source guard before cloning. The first core-only gate can start
  // while we prepare the independent app conflict; its barrier keeps it parked.
  for (const source of [f.core.source, f.app!.source]) {
    const hook = join(source, ".git", "hooks", "pre-push");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
  }
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await runIntegrationCommand([initial, "--id", ids[0]!, "--push", "--no-wait"], cli);
  // The app input conflicts with freshly fetched main; its paired core input must roll back too.
  const appBase = await commit(f.app!.source, "shared", "base");
  await git(f.app!.source, "push", "origin", "HEAD:main");
  const appBad = await commit(f.app!.source, "shared", "approved");
  await git(f.app!.source, "checkout", "-b", "remote", appBase);
  await commit(f.app!.source, "shared", "remote");
  await git(f.app!.source, "push", "origin", "HEAD:main");
  await git(f.app!.source, "checkout", "main");
  await until(async () => (await runIntegrationCommand(["status", ids[0]!], cli)).batch?.state === "gating");
  await runIntegrationCommand([a, "--id", ids[1]!, "--push", "--no-wait"], cli);
  await runIntegrationCommand([paired, "--app", appBad, "--id", ids[2]!, "--push", "--no-wait"], cli);
  await runIntegrationCommand([b, "--id", ids[3]!, "--push", "--no-wait"], cli);
  const queued = (await runIntegrationCommand(["status"], cli)).queue!;
  expect(queued.running.map((r) => r.state)).toEqual(["gating"]);
  expect(queued.waiting.map((r) => r.id)).toEqual(ids.slice(1));
  await writeFile(join(f.root, "release"), "go");
  await f.queue.wait();
  const aResult = (await runIntegrationCommand(["status", ids[1]!], cli)).batch!;
  const bResult = (await runIntegrationCommand(["status", ids[3]!], cli)).batch!;
  expect(aResult.state).toBe("pushed");
  expect(bResult.state).toBe("pushed");
  expect(aResult.batchId).toBe(bResult.batchId);
  expect(aResult.members?.map((m) => m.id)).toEqual(ids.slice(1));
  expect((await runIntegrationCommand(["status", ids[2]!], cli)).batch?.state).toBe("conflict");
  await expect(f.queue.land(ids[2]!, guard)).rejects.toThrow("no landable pass");
  const core = aResult.repos.find((r) => r.name === "core")!;
  for (const repo of aResult.repos)
    expect(await git(repo.directory, "config", "core.hooksPath")).toBe("/dev/null");
  expect(core.commits.find((c) => c.memberId === ids[2])?.state).toBe("blocked");
  expect(await git(core.directory, "ls-tree", "--name-only", core.head)).not.toContain("paired");
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(core.head);
  expect((await readFile(join(f.root, "gate-count"), "utf8")).trim().split("\n")).toHaveLength(2);
  const finished = (await runIntegrationCommand(["status"], cli)).queue!;
  expect(finished.running).toEqual([]);
  expect(finished.waiting).toEqual([]);
  expect(finished.lastResult).toMatchObject({
    state: "pushed",
    excluded: [{ id: ids[2], state: "conflict" }],
  });
  expect((await new IntegrationQueue(f.queue.options).status(ids[1]!)).state).toBe("pushed");
  expect((await runIntegrationCommand([a, "--id", ids[1]!, "--push", "--no-wait"], cli)).batch?.id).toBe(
    ids[1],
  );
  await expect(runIntegrationCommand([b, "--id", ids[1]!, "--push", "--no-wait"], cli)).rejects.toThrow(
    "different request",
  );
  process.stdout.write(
    "coalescing-evidence " +
      JSON.stringify({
        gating: queued.running.map((r) => r.state),
        waiting: queued.waiting.length,
        members: aResult.members?.length,
        sharedBatch: aResult.batchId,
        healthy: [aResult.state, bResult.state],
        excluded: finished.lastResult?.excluded?.map((e) => e.state),
        coreGates: 2,
        sourceGuards: "installed",
        cloneHooks: "/dev/null",
      }) +
      "\n",
  );
});

it("cancels a request still waiting for its gate with a receipt, and the requests behind it keep their order", async () => {
  const f = await fixture((root) => barrier(root));
  const cli = await queueCli(f);
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const submit = async (name: string, id: string) =>
    runIntegrationCommand([await commit(f.core.source, name, name), "--id", id, "--push", "--no-wait"], cli);
  const status = async (id: string) => (await runIntegrationCommand(["status", id], cli)).batch!;
  const cancel = (id: string, actor: string, reason: string) =>
    runIntegrationCommand(["cancel", id, "--actor", actor, "--reason", reason], cli);
  await submit("first", ids[0]!);
  await until(async () => (await status(ids[0]!)).state === "gating");
  await submit("a", ids[1]!);
  await submit("typo", ids[2]!);
  await submit("b", ids[3]!);

  // A request whose gate has started runs on; one still waiting is withdrawn with a receipt.
  await expect(cancel(ids[0]!, "Ivy", "wrong commit")).rejects.toThrow(`Request ${ids[0]} is gating`);
  expect((await cancel(ids[2]!, "Clankie", "Ivy's typo request")).batch).toMatchObject({
    state: "cancelled",
    cancelled: { actor: "Clankie", reason: "Ivy's typo request" },
  });
  await writeFile(join(f.root, "release"), "go");
  await f.queue.wait();

  expect(await status(ids[2]!)).toMatchObject({ state: "cancelled", cancelled: { actor: "Clankie" } });
  const [a, b] = [await status(ids[1]!), await status(ids[3]!)];
  expect([a.state, b.state]).toEqual(["pushed", "pushed"]);
  expect(a.members?.map((m) => m.id)).toEqual([ids[1], ids[3]]);
  expect(await git(a.repos[0]!.directory, "ls-tree", "--name-only", a.repos[0]!.head)).not.toContain("typo");
  expect((await readFile(join(f.root, "gate-count"), "utf8")).trim().split("\n")).toHaveLength(2);
  await expect(cancel(ids[1]!, "Ivy", "too late")).rejects.toThrow(`Request ${ids[1]} is pushed`);
});

// Real install-and-gate batches take over 30s on a
// cold CI runner, on base and head alike (VUH-2059). Sized to that work, with margin.
it("retries a failed shared real gate individually, reports the bad request, and lands both healthy requests", async () => {
  const f = await fixture((root) => barrier(root, "if (existsSync('broken')) process.exit(9);"));
  const initial = await commit(f.core.source, "initial", "one");
  const good = await commit(f.core.source, "good", "healthy");
  const bad = await commit(f.core.source, "broken", "fails gate");
  const later = await commit(f.core.source, "later", "healthy");
  const request = (sha: string) =>
    IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [sha], push: true });
  const first = request(initial),
    a = request(good),
    failing = request(bad),
    b = request(later);
  await f.queue.start(first, guard);
  await until(async () => (await f.queue.status(first.id)).state === "gating");
  for (const r of [a, failing, b]) await f.queue.start(r, guard);
  await writeFile(join(f.root, "release"), "go");
  await f.queue.wait();
  expect((await f.queue.status(a.id)).state).toBe("pushed");
  expect((await f.queue.status(b.id)).state).toBe("pushed");
  const rejected = await f.queue.status(failing.id);
  expect(rejected.state).toBe("failed");
  expect(rejected.repos[0]!.gate?.exitCode).toBe(9);
  expect(rejected.attempts).toHaveLength(2);
  const landed = (await f.queue.status(b.id)).repos[0]!;
  expect(await git(landed.directory, "ls-tree", "--name-only", landed.head)).toContain("good");
  expect(await git(landed.directory, "ls-tree", "--name-only", landed.head)).toContain("later");
  expect(await git(landed.directory, "ls-tree", "--name-only", landed.head)).not.toContain("broken");
  expect((await readFile(join(f.root, "gate-count"), "utf8")).trim().split("\n")).toHaveLength(5);
  expect((await new IntegrationQueue(f.queue.options).status(failing.id)).state).toBe("failed");
  process.stdout.write(
    "isolation-evidence " +
      JSON.stringify({
        healthy: [(await f.queue.status(a.id)).state, (await f.queue.status(b.id)).state],
        failing: rejected.state,
        exitCode: rejected.repos[0]!.gate?.exitCode,
        attempts: rejected.attempts?.length,
        coreGates: 5,
      }) +
      "\n",
  );
}, 90_000);

it("CLI/API caps batches, preserves retry admission priority and fences active and waiting withdrawals from landing", async () => {
  const names = ["initial", "withdraw", "broken", "survivor", "green1", "green2", "green3", "green4", "late"];
  const f = await fixture(
    (root) => `
const fs = await import('node:fs');
const root = ${JSON.stringify(root)};
const files = ${JSON.stringify(names)}.filter(name => existsSync(name));
fs.appendFileSync(join(root, 'gate-heads'), JSON.stringify({ files, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }) + '\\n');
let stage;
if (files.length === 1) stage = 'initial';
else if (existsSync('broken')) stage = 'shared';
else if (existsSync('withdraw')) stage = 'withdraw';
if (stage) {
  fs.writeFileSync(join(root, stage + '-started'), 'gating');
  while (!existsSync(join(root, stage + '-release')) && !existsSync(join(root, 'release')))
    await new Promise(resolve => setTimeout(resolve, 20));
}
if (existsSync('broken')) process.exit(9);
`,
  );
  let releaseIsolationPlacement!: () => void;
  let isolationPlacementEntered!: () => void;
  const isolationPlacement = new Promise<void>((resolve) => {
    isolationPlacementEntered = resolve;
  });
  let heldIsolationPlacement = false;
  f.queue.options.placeGate = async ({ id }) => {
    const batch = await f.queue.status(id);
    if (batch.isolation && !heldIsolationPlacement) {
      heldIsolationPlacement = true;
      isolationPlacementEntered();
      await new Promise<void>((resolve) => {
        releaseIsolationPlacement = resolve;
        fixtureWork().signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return undefined;
  };
  cleanups.push(() => releaseIsolationPlacement?.());
  const cli = await queueCli(f);
  const inputs = names.map((name) => ({ name, id: randomUUID() }));
  // Serialize edits to the real source index; each request carries just its own approved commit.
  const commits = new Map<string, string>();
  for (const { name } of inputs) commits.set(name, await commit(f.core.source, name, name));
  const byName = (name: string) => inputs.find((input) => input.name === name)!;
  const submit = (name: string) =>
    runIntegrationCommand([commits.get(name)!, "--id", byName(name).id, "--push", "--no-wait"], cli);
  const status = async (name: string) =>
    (await runIntegrationCommand(["status", byName(name).id], cli)).batch!;
  const started = (stage: string) =>
    until(async () => Boolean(await readFile(join(f.root, stage + "-started")).catch(() => undefined)));
  const release = (stage: string) => writeFile(join(f.root, stage + "-release"), "go");

  await submit("initial");
  await started("initial");
  for (const name of names.slice(1, -1)) await submit(name);
  await release("initial");
  await started("shared");
  const shared = await status("broken");
  expect(shared.members?.map((member) => member.id)).toEqual(
    ["withdraw", "broken", "survivor"].map((name) => byName(name).id),
  );
  await submit("late");
  await release("shared");
  await isolationPlacement;
  const childBeforeLaunch = await status("withdraw");
  const parentId = childBeforeLaunch.isolation!.rootBatchId;
  const parent = await f.queue.status(parentId);
  const ageCheckpoint = async (path: string) => {
    const record = JSON.parse(await readFile(path, "utf8"));
    record.updatedAt = new Date(Date.now() - 181_000).toISOString();
    await durableJson(path, record);
  };
  await ageCheckpoint(parent.evidence);
  await ageCheckpoint(childBeforeLaunch.evidence);
  // An isolation child parked before launch does not indefinitely hide a stale head.
  expect(await f.queue.progress()).toEqual([
    expect.objectContaining({
      stalled: true,
      message: expect.stringContaining(childBeforeLaunch.batchId ?? childBeforeLaunch.id),
    }),
  ]);
  releaseIsolationPlacement();
  await started("withdraw");
  await ageCheckpoint(parent.evidence);
  // The real isolation gate proves progress for the old parent checkpoint (VUH-2106).
  expect(await f.queue.progress()).toEqual([]);

  // Later arrivals cannot pass the older isolated requests.
  for (const name of ["green1", "green2", "green3"]) expect((await status(name)).state).toBe("queued");
  const isolated = await status("withdraw");
  expect(isolated.state).toBe("gating");
  expect(isolated.progress).toMatchObject({
    queuePosition: 0,
    estimateBasis: "recent-completions",
    isolationChain: [
      { memberCount: 3, state: "failed", gateExitCode: 9 },
      { memberCount: 1, state: "gating" },
    ],
  });
  expect(isolated.progress!.estimatedRemainingMs).toBeGreaterThan(0);
  expect(isolated.progress!.estimatedCompletionAt).not.toBeNull();
  const queued = await status("broken");
  expect(queued.state).toBe("queued");
  expect(await f.queue.commitHandoffs(f.core.source, [commits.get("broken")!])).toContainEqual({
    commit: commits.get("broken")!,
    requestId: byName("broken").id,
  });
  expect(queued.progress!.queuePosition).toBeGreaterThan(0);
  for (const name of ["withdraw", "broken"]) {
    const result = await runIntegrationCommand(
      ["cancel", byName(name).id, "--actor", "Clankie", "--reason", "replace isolated input"],
      cli,
    );
    expect(result.batch).toMatchObject({
      state: "cancelled",
      cancelled: { actor: "Clankie", reason: "replace isolated input" },
    });
    expect(await f.queue.commitHandoffs(f.core.source, [commits.get(name)!])).toEqual([]);
  }
  // The withdrawn active gate is deliberately green: its pass still cannot authorize a push.
  await release("withdraw");
  await f.queue.wait();
  const withdrawn = await status("withdraw");
  expect(withdrawn.state).toBe("cancelled");
  expect(withdrawn.repos[0]!.gate?.exitCode).toBe(0);
  expect(withdrawn.repos[0]!.push).toBeUndefined();
  await expect(f.queue.land(withdrawn.batchId!, guard)).rejects.toThrow("no landable pass");
  expect((await new IntegrationQueue(f.queue.options).status(byName("withdraw").id)).state).toBe("cancelled");
  expect((await status("broken")).state).toBe("cancelled");
  for (const name of ["survivor", "green1", "green2", "green3", "green4", "late"])
    expect((await status(name)).state).toBe("pushed");
  const survivor = await status("survivor");
  const head = survivor.repos[0]!.head;
  const tree = await git(survivor.repos[0]!.directory, "ls-tree", "--name-only", head);
  expect(tree).not.toContain("withdraw");
  expect(tree).not.toContain("broken");
  const final = (await status("late")).repos[0]!;
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(final.head);
  expect(await git(final.directory, "merge-base", "--is-ancestor", head, final.head)).toBe("");
  for (const input of inputs) expect((await status(input.name)).members?.length ?? 1).toBeLessThanOrEqual(3);
  const gates = (await readFile(join(f.root, "gate-heads"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { files: string[]; head: string });
  // No individual retry of the known-bad, withdrawn member ran.
  expect(gates.filter((gate) => gate.files.includes("broken"))).toHaveLength(1);
  process.stdout.write(
    "vuh-2090-progress-evidence " +
      JSON.stringify({
        isolated: isolated.progress,
        activeWithdrawal: withdrawn.cancelled,
        waitingWithdrawal: (await status("broken")).cancelled,
        gates,
        landedHead: head,
      }) +
      "\n",
  );
}, 120_000);

it("mixed isolation re-gates innocent members before later arrivals and invalidates an app pass on excluded core", async () => {
  const f = await fixture(
    (root) => `
const fs = await import('node:fs');
const root = ${JSON.stringify(root)};
fs.appendFileSync(join(root, 'events'), JSON.stringify({ repo: 'core', head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), broken: existsSync('broken'), late: existsSync('late') }) + '\\n');
let stage;
if (!existsSync('good') && !existsSync('broken')) stage = 'initial';
else if (existsSync('broken')) stage = 'shared';
else if (!existsSync('../clankie-app/feature')) stage = 'first-retry';
if (stage) {
  fs.writeFileSync(join(root, stage + '-started'), 'gating');
  while (!existsSync(join(root, stage + '-release')) && !existsSync(join(root, 'release')))
    await new Promise(resolve => setTimeout(resolve, 20));
}
if (existsSync('broken')) process.exit(9);
`,
    true,
    (root) => `
const fs = await import('node:fs');
assert.equal(fs.readFileSync('feature', 'utf8'), 'app');
assert.equal(fs.readFileSync('../clankie/good', 'utf8'), 'good');
fs.appendFileSync(${JSON.stringify(join(root, "events"))}, JSON.stringify({ repo: 'app', head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), coreHead: execFileSync('git', ['-C', '../clankie', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), broken: existsSync('../clankie/broken') }) + '\\n');
`,
  );
  const cli = await queueCli(f);
  const initial = await commit(f.core.source, "initial", "initial");
  const good = await commit(f.core.source, "good", "good");
  const broken = await commit(f.core.source, "broken", "broken");
  const late = await commit(f.core.source, "late", "late");
  const feature = await commit(f.app!.source, "feature", "app");
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const submit = (index: number, sha: string, app = false) =>
    runIntegrationCommand(
      [...(app ? ["--app", sha] : [sha]), "--id", ids[index]!, "--push", "--no-wait"],
      cli,
    );
  const status = async (index: number) => (await runIntegrationCommand(["status", ids[index]!], cli)).batch!;
  const started = (stage: string) =>
    until(async () => Boolean(await readFile(join(f.root, stage + "-started")).catch(() => undefined)));
  const release = (stage: string) => writeFile(join(f.root, stage + "-release"), "go");
  await submit(0, initial);
  await started("initial");
  await submit(1, good);
  await submit(2, broken);
  await submit(3, feature, true);
  await release("initial");
  await started("shared");
  await submit(4, late);
  await release("shared");
  await started("first-retry");
  const firstRetry = await status(1);
  expect(firstRetry.state).toBe("gating");
  expect((await status(4)).state).toBe("queued");
  const appPosition = (await status(3)).progress!.queuePosition;
  const laterPosition = (await status(4)).progress!.queuePosition;
  expect(appPosition).not.toBeNull();
  expect(laterPosition).not.toBeNull();
  expect(appPosition).toBeLessThan(laterPosition!);
  const shared = await f.queue.status(firstRetry.attempts![0]!);
  expect(shared.repos.find((repo) => repo.name === "core")!.gate?.exitCode).toBe(9);
  expect(shared.repos.find((repo) => repo.name === "app")!.gate?.exitCode).toBe(0);
  await release("first-retry");
  await f.queue.wait();
  for (const index of [0, 1, 3, 4]) expect((await status(index)).state).toBe("pushed");
  expect((await status(2)).state).toBe("failed");
  const appBatch = await status(3);
  const app = appBatch.repos.find((repo) => repo.name === "app")!;
  const core = appBatch.repos.find((repo) => repo.name === "core")!;
  expect(app.gateReuse).toBeUndefined();
  expect(app.gate).toMatchObject({ exitCode: 0, head: app.head });
  const events = (await readFile(join(f.root, "events"), "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          repo: string;
          head: string;
          coreHead?: string;
          broken: boolean;
          late?: boolean;
        },
    );
  const appGates = events.filter((event) => event.repo === "app");
  expect(appGates).toHaveLength(2);
  expect(appGates[0]!.broken).toBe(true);
  expect(appGates[1]).toMatchObject({ head: app.head, coreHead: core.head, broken: false });
  expect(appGates[0]!.coreHead).not.toBe(core.head);
  expect(events.findIndex((event) => event.late)).toBeGreaterThan(events.indexOf(appGates[1]!));
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(
    (await status(4)).repos[0]!.head,
  );
  expect(await git(f.app!.source, "ls-remote", "origin", "refs/heads/main")).toContain(app.head);
  expect(await git((await status(4)).repos[0]!.directory, "ls-tree", "--name-only", "HEAD")).not.toContain(
    "broken",
  );
  process.stdout.write(
    "vuh-2112-mixed-evidence " +
      JSON.stringify({
        firstRetry: firstRetry.progress,
        sharedId: shared.id,
        events,
        appHead: app.head,
        coreHead: core.head,
      }) +
      "\n",
  );
}, 120_000);

it.each(["unchanged", "before composition", "after reused pass"])(
  "reuses the actual app pass only for an unchanged candidate (app base: %s)",
  async (advanceBase) => {
    const f = await fixture(
      (root) => `
const fs = await import('node:fs');
const root = ${JSON.stringify(root)};
if (!existsSync(join(root, 'initial-release')))
  while (!existsSync(join(root, 'initial-release')) && !existsSync(join(root, 'release')))
    await new Promise(resolve => setTimeout(resolve, 20));
if (existsSync('../clankie-app/feature') && !existsSync(join(root, 'failed-once'))) {
  fs.writeFileSync(join(root, 'failed-once'), 'failed');
  process.exit(9);
}
if (existsSync(join(root, 'failed-once')) && !existsSync('../clankie-app/feature')) {
  fs.writeFileSync(join(root, 'first-retry-started'), 'gating');
  while (!existsSync(join(root, 'first-retry-release')) && !existsSync(join(root, 'release')))
    await new Promise(resolve => setTimeout(resolve, 20));
}
`,
      true,
      (root) => `
const fs = await import('node:fs');
assert.equal(fs.readFileSync('../clankie/initial', 'utf8'), 'initial');
assert.equal(fs.readFileSync('feature', 'utf8'), 'app');
if (process.argv.includes('--revalidate')) {
  const old = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "app-gates"))}, 'utf8').trim().split('\\n')[0]);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(), execFileSync('git', ['rev-parse', old.head + '^{tree}'], { encoding: 'utf8' }).trim());
  assert.equal(execFileSync('git', ['-C', '../clankie', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), old.coreHead);
  fs.appendFileSync(${JSON.stringify(join(root, "revalidations"))}, 'covered\\n');
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(join(root, "app-gates"))}, JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), coreHead: execFileSync('git', ['-C', '../clankie', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }) + '\\n');
`,
      true,
    );
    const initial = await commit(f.core.source, "initial", "initial");
    const feature = await commit(f.app!.source, "feature", "app");
    const request = (core: string[], app?: string[]) =>
      IntegrationRunSchema.parse({
        action: "run",
        id: randomUUID(),
        core,
        ...(app ? { app } : {}),
        push: true,
      });
    const first = request([initial]);
    const members = [request([initial]), request([initial]), request([], [feature])];
    let advanced = false;
    const advanceOrigin = async () => {
      advanced = true;
      await git(f.app!.source, "checkout", "-b", "remote", f.app!.base);
      await git(f.app!.source, "commit", "--allow-empty", "-m", "same tree, newer app base");
      await git(f.app!.source, "push", "origin", "HEAD:main");
      await git(f.app!.source, "checkout", "main");
    };
    await f.queue.start(first, guard);
    await until(async () => (await f.queue.status(first.id)).state === "gating");
    for (const member of members)
      await f.queue.start(member, async () => {
        await guard();
        if (advanceBase !== "after reused pass" || advanced || !member.app) return;
        const attempt = await f.queue.status(member.id);
        if (attempt.repos.find((repo) => repo.name === "app")?.gateReuse) await advanceOrigin();
      });
    await writeFile(join(f.root, "initial-release"), "go");
    await until(async () =>
      Boolean(await readFile(join(f.root, "first-retry-started")).catch(() => undefined)),
    );
    const sharedId = (await f.queue.status(members[0]!.id)).attempts![0]!;
    const shared = await f.queue.status(sharedId);
    const oldApp = shared.repos.find((repo) => repo.name === "app")!;
    expect(oldApp.gate?.exitCode).toBe(0);
    if (advanceBase === "before composition") await advanceOrigin();
    await writeFile(join(f.root, "first-retry-release"), "go");
    await f.queue.wait();
    for (const member of members) expect((await f.queue.status(member.id)).state).toBe("pushed");
    const result = await f.queue.status(members[2]!.id);
    const app = result.repos.find((repo) => repo.name === "app")!;
    const core = result.repos.find((repo) => repo.name === "core")!;
    const gates = (await readFile(join(f.root, "app-gates"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { head: string; coreHead: string });
    expect(gates).toHaveLength(advanceBase === "unchanged" ? 1 : 2);
    expect(app.gate).toMatchObject({ exitCode: 0, head: app.head });
    expect(core.gate).toMatchObject({ exitCode: 0, head: core.head });
    if (advanceBase !== "unchanged") expect(app.gateReuse).toBeUndefined();
    else {
      expect(app.head).toBe(oldApp.head);
      expect(app.gate!.log).toBe(oldApp.gate!.log);
      expect(app.gateReuse).toMatchObject({
        batchId: sharedId,
        coreHead: core.head,
        tree: await git(app.directory, "rev-parse", "HEAD^{tree}"),
      });
    }
    expect(gates[0]!.coreHead).toBe(core.head);
    if (advanceBase === "after reused pass") {
      expect(result.regateReason).toContain("reused gate requires an unchanged base");
      const held = await f.queue.status(result.attempts!.at(-2)!);
      expect(held.state).toBe("held");
      expect(held.repos.find((repo) => repo.name === "app")!.gate?.exitCode).toBe(0);
      expect(held.repos.every((repo) => repo.push === undefined)).toBe(true);
      expect(await readFile(join(f.root, "revalidations")).catch(() => undefined)).toBeUndefined();
    }
    expect(await git(f.app!.source, "ls-remote", "origin", "refs/heads/main")).toContain(app.head);
    process.stdout.write(
      "vuh-2112-reuse-evidence " +
        JSON.stringify({ advanceBase, sharedId, gates, appHead: app.head, gateReuse: app.gateReuse }) +
        "\n",
    );
  },
  120_000,
);

it("keeps older isolated retries before a restore and gates the later forward change on its restored tree", async () => {
  const f = await fixture(
    (root) => `
const fs = await import('node:fs');
const root = ${JSON.stringify(root)};
if (existsSync('broken')) {
  fs.writeFileSync(join(root, 'shared-started'), 'gating');
  while (!existsSync(join(root, 'shared-release')) && !existsSync(join(root, 'release')))
    await new Promise(resolve => setTimeout(resolve, 20));
  process.exit(9);
}
if (!existsSync(join(root, 'initial-release')) && !existsSync(join(root, 'release')))
  while (!existsSync(join(root, 'initial-release')) && !existsSync(join(root, 'release')))
    await new Promise(resolve => setTimeout(resolve, 20));
`,
  );
  const initial = await commit(f.core.source, "initial", "one");
  const a = await commit(f.core.source, "a", "healthy");
  const bad = await commit(f.core.source, "broken", "fails");
  const b = await commit(f.core.source, "b", "healthy");
  const later = await commit(f.core.source, "later", "forward");
  const request = (sha: string) =>
    IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [sha], push: true });
  const first = request(initial),
    goodA = request(a),
    failing = request(bad),
    goodB = request(b),
    after = request(later);
  await f.queue.start(first, guard);
  await until(async () => (await f.queue.status(first.id)).state === "gating");
  for (const member of [goodA, failing, goodB]) await f.queue.start(member, guard);
  await writeFile(join(f.root, "initial-release"), "go");
  await until(async () => Boolean(await readFile(join(f.root, "shared-started")).catch(() => undefined)));
  const restore = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    restore: first.id,
    push: true,
  });
  await f.queue.start(restore, guard);
  await f.queue.start(after, guard);
  await writeFile(join(f.root, "shared-release"), "go");
  await f.queue.wait();
  for (const member of [goodA, goodB, restore, after])
    expect((await f.queue.status(member.id)).state).toBe("pushed");
  expect((await f.queue.status(failing.id)).state).toBe("failed");
  const restored = (await f.queue.status(restore.id)).repos[0]!;
  const landedB = (await f.queue.status(goodB.id)).repos[0]!;
  expect(await git(restored.directory, "rev-parse", `${restored.head}^`)).toBe(landedB.head);
  const final = (await f.queue.status(after.id)).repos[0]!;
  const tree = await git(final.directory, "ls-tree", "--name-only", final.head);
  expect(tree).toContain("initial");
  expect(tree).toContain("later");
  expect(tree.split("\n")).not.toContain("a");
  expect(tree.split("\n")).not.toContain("b");
  expect(tree).not.toContain("broken");
  expect(final.gate).toMatchObject({ exitCode: 0, head: final.head });
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(final.head);
}, 120_000);

it("coalesces push requests past a gate-only one, which gates by itself, and reports interrupted receipts after process loss", async () => {
  const f = await fixture((root) => barrier(root));
  const initial = await commit(f.core.source, "initial", "one");
  const before = await commit(f.core.source, "before", "push");
  const candidate = await commit(f.core.source, "candidate", "gate only");
  const after = await commit(f.core.source, "after", "push");
  const request = (sha: string, push: boolean) =>
    IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [sha], push });
  const first = request(initial, true),
    a = request(before, true),
    only = request(candidate, false),
    b = request(after, true);
  await f.queue.start(first, guard);
  await until(async () => (await f.queue.status(first.id)).state === "gating");
  for (const r of [a, only, b]) await f.queue.start(r, guard);
  const reload = await new IntegrationQueue(f.queue.options).snapshot();
  expect(reload.interrupted.map((r) => r.id)).toEqual(
    expect.arrayContaining([first.id, a.id, only.id, b.id]),
  );
  await writeFile(join(f.root, "release"), "go");
  await f.queue.wait();
  // The push behind the gate-only request joins the push batch; the gate-only one never lands.
  const [landedA, landedB] = [await f.queue.status(a.id), await f.queue.status(b.id)];
  expect([landedA.state, landedB.state]).toEqual(["pushed", "pushed"]);
  expect(landedA.batchId).toBe(landedB.batchId);
  expect(landedA.members?.map((m) => m.id)).toEqual([a.id, b.id]);
  const gated = await f.queue.status(only.id);
  expect(gated.state).toBe("passed");
  expect(gated.members?.map((m) => m.id)).toEqual([only.id]);
  expect((await readFile(join(f.root, "gate-count"), "utf8")).trim().split("\n")).toHaveLength(3);
  const landed = landedB.repos[0]!;
  expect(await git(landed.directory, "ls-tree", "--name-only", landed.head)).not.toContain("candidate");
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(landed.head);
});

it("lands a green batch over an unrelated move of main without a second gate, and gates again when main changes what it checked", async () => {
  const f = await fixture();
  // The repository's real revalidation judges the move (VUH-2024); the fixture gate records its selection.
  const validity = fileURLToPath(new URL("../../../scripts/testing/landing-validity.mjs", import.meta.url));
  await writeFile(
    join(f.core.source, "landing.mjs"),
    `
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changePatchId, revalidateLanding, sourceFingerprint } from ${JSON.stringify(validity)};
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const base = git('rev-parse', process.env.CLANKIE_LANDING_BASE);
const report = '.local/landing-gate.json';
if (process.argv.includes('--revalidate')) {
  const verdict = await revalidateLanding({ root: process.cwd(), report: JSON.parse(readFileSync(report, 'utf8')), base });
  console.log(verdict.valid ? '[landing] still covers HEAD' : '[landing] rerun the root gate: ' + verdict.reasons.join('; '));
  process.exit(verdict.valid ? 0 : 1);
}
const root = ${JSON.stringify(f.root)};
appendFileSync(join(root, 'gate-count'), 'gate\\n');
while (!existsSync(join(root, 'release'))) await new Promise((r) => setTimeout(r, 20));
const files = git('diff', '--name-only', base).split('\\n').filter(Boolean);
mkdirSync('.local', { recursive: true });
writeFileSync(report, JSON.stringify({
  head: git('rev-parse', 'HEAD'), base, source: await sourceFingerprint(process.cwd()), exitCode: 0, sourceStable: true,
  change: { rebased: true, patchId: changePatchId(process.cwd(), base, 'HEAD'), files },
  // Every selected test imports lib/helper.
  tests: { dependencies: [...files, 'lib/helper'] },
  typecheckScope: { reason: 'real compiler import graph', affectedInputs: files },
}));
`,
  );
  const manifest = JSON.parse(await readFile(join(f.core.source, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  manifest.scripts["check:landing"] = "node landing.mjs";
  await writeFile(join(f.core.source, "package.json"), JSON.stringify(manifest));
  await writeFile(join(f.core.source, ".gitignore"), "node_modules/\n.local/\n");
  // Top-level files are repository-wide gate inputs, so the incoming work lives in folders.
  await mkdir(join(f.core.source, "lib"));
  await writeFile(join(f.core.source, "lib", "helper"), "one");
  await git(f.core.source, "add", ".");
  await git(f.core.source, "commit", "-m", "landing gate");
  await git(f.core.source, "push", "origin", "HEAD:main");
  const cli = await queueCli(f);
  const gates = async () =>
    (await readFile(join(f.root, "gate-count"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
      .length;
  // Someone lands directly on main while the batch is gating (0250de6aa on 2026-10-10).
  const incoming = async (file: string, value: string) => {
    await git(f.core.source, "fetch", "-q", "origin");
    await git(f.core.source, "checkout", "-q", "-B", "direct", "origin/main");
    await mkdir(join(f.core.source, "docs"), { recursive: true });
    const sha = await commit(f.core.source, file, value);
    await git(f.core.source, "push", "origin", "HEAD:main");
    await git(f.core.source, "checkout", "-q", "main");
    await git(f.core.source, "fetch", "-q", "origin");
    return sha;
  };

  const a = randomUUID();
  await runIntegrationCommand(
    [await commit(f.core.source, "feature", "a"), "--id", a, "--push", "--no-wait"],
    cli,
  );
  await until(async () => (await gates()) === 1);
  const unrelated = await incoming("docs/unrelated.md", "unrelated");
  await writeFile(join(f.root, "release"), "go");
  await f.queue.wait();
  const landed = (await runIntegrationCommand(["status", a], cli)).batch!;
  expect(landed.state).toBe("pushed");
  expect(await gates()).toBe(1);
  const repo = landed.repos[0]!;
  expect(repo.revalidations).toEqual([
    expect.objectContaining({
      to: unrelated,
      incoming: [unrelated],
      covered: true,
      head: repo.head,
      exitCode: 0,
    }),
  ]);
  expect(repo.base).toBe(unrelated);
  expect(await git(repo.directory, "rev-parse", `${repo.head}^`)).toBe(unrelated);
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(repo.head);

  // A move that touches what the gate checked holds that attempt and gates the request again.
  await rm(join(f.root, "release"));
  const b = randomUUID();
  await git(f.core.source, "reset", "-q", "--hard", "origin/main");
  await runIntegrationCommand(
    [await commit(f.core.source, "second", "b"), "--id", b, "--push", "--no-wait"],
    cli,
  );
  await until(async () => (await gates()) === 2);
  const checked = await incoming("lib/helper", "two");
  await writeFile(join(f.root, "release"), "go");
  await f.queue.wait();
  const again = (await runIntegrationCommand(["status", b], cli)).batch!;
  expect(again).toMatchObject({ state: "pushed", attempts: [expect.any(String)] });
  expect(again.regateReason).toContain("incoming commit changes checked input lib/helper");
  expect(again.repos[0]!.base).toBe(checked);
  expect(again.repos[0]!.revalidations).toBeUndefined();
  expect(await gates()).toBe(3);
  const held = JSON.parse(await readFile(join(f.directory, "batches", b, "record.json"), "utf8")) as {
    state: string;
    error: string;
    repos: { revalidations: unknown[] }[];
  };
  expect(held).toMatchObject({
    state: "held",
    error: expect.stringContaining("gating again on the new main"),
  });
  expect(held.repos[0]!.revalidations).toEqual([
    expect.objectContaining({
      incoming: [checked],
      covered: false,
      reason: "incoming commit changes checked input lib/helper",
    }),
  ]);
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(again.repos[0]!.head);
});

it("lands through the repository's change-scoped check:landing, told the batch base, instead of the full check", async () => {
  const f = await fixture();
  await writeFile(
    join(f.core.source, "landing.mjs"),
    "console.log(`landing-gate base=${process.env.CLANKIE_LANDING_BASE}`);\n",
  );
  const manifest = JSON.parse(await readFile(join(f.core.source, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  manifest.scripts = { check: 'node -e "process.exit(1)"', "check:landing": "node landing.mjs" };
  await writeFile(join(f.core.source, "package.json"), JSON.stringify(manifest));
  await git(f.core.source, "add", "landing.mjs", "package.json");
  await git(f.core.source, "commit", "-m", "landing gate");
  const change = await git(f.core.source, "rev-parse", "HEAD");
  const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [change] });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const batch = await new IntegrationQueue(f.queue.options).status(request.id);
  expect(batch.state).toBe("passed");
  expect(await readFile(batch.repos[0]!.gate!.log, "utf8")).toContain(`landing-gate base=${f.core.base}`);
});

it("reclaims a queue lock its dead earlier owner left, records that owner's batches interrupted, and queues behind a live owner", async () => {
  const f = await fixture();
  const lock = join(f.directory, "queue.lock");
  const owner = (pid: number, at: string) => durableJson(join(lock, "owner.json"), { pid, at });
  // Before this process started, as a lock from the service instance a deploy replaced.
  const earlier = new Date(performance.timeOrigin - 60_000).toISOString();
  const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  cleanups.push(() => void live.kill());
  const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => exited.once("exit", resolve));
  const dead = exited.pid!;
  const request = async (name: string, push: boolean) =>
    IntegrationRunSchema.parse({
      action: "run",
      id: randomUUID(),
      core: [await commit(f.core.source, name, name)],
      push,
    });

  // A live owner keeps its lock, however old.
  await owner(live.pid!, earlier);
  const queued = await request("queued", false);
  await f.queue.start(queued, guard);
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(await f.queue.status(queued.id)).toMatchObject({ state: "queued" });
  expect(await readFile(join(lock, "owner.json"), "utf8")).toContain(String(live.pid));
  await rm(lock, { recursive: true });
  await f.queue.wait();
  expect((await f.queue.status(queued.id)).state).toBe("passed");

  // The dead owner left a batch gating and a request waiting.
  const leftover = async (state: "gating" | "queued") => {
    const id = randomUUID();
    const record = join(f.directory, "batches", id, "record.json");
    await durableJson(record, {
      schemaVersion: 1,
      id,
      request: { action: "run", id, core: [f.core.base], push: true },
      state,
      createdAt: earlier,
      updatedAt: earlier,
      evidence: record,
      repos: [],
    });
    return { id, record };
  };
  const [gating, waiting] = [await leftover("gating"), await leftover("queued")];
  await owner(dead, earlier);
  const accepted = await request("accepted", true);
  await f.queue.start(accepted, guard);
  await f.queue.wait();
  expect((await f.queue.status(accepted.id)).state).toBe("pushed");
  for (const [left, state] of [
    [gating, "gating"],
    [waiting, "queued"],
  ] as const) {
    const recorded = JSON.parse(await readFile(left.record, "utf8")) as { state: string; error: string };
    expect(recorded.state).toBe("interrupted");
    expect(recorded.error).toContain(
      `while this was ${state}: its lock owner (pid ${dead} since ${earlier}) died`,
    );
  }
  expect((await f.queue.snapshot()).interrupted.map((b) => b.id).sort()).toEqual(
    [gating.id, waiting.id].sort(),
  );
  expect((await f.queue.status(queued.id)).state).toBe("passed");
  await expect(readFile(join(lock, "owner.json"))).rejects.toThrow();

  // Of two takers that find the same stale lock, one runs; an earlier process with this pid is dead too.
  let runs = 0;
  const work = async () => {
    runs++;
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  for (const pid of [dead, process.pid]) {
    await owner(pid, earlier);
    const takers = await Promise.allSettled([withDirectoryLock(lock, work), withDirectoryLock(lock, work)]);
    expect(takers.map((t) => t.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((takers.find((t) => t.status === "rejected") as PromiseRejectedResult).reason)).toContain(
      "retained lock",
    );
  }
  expect(runs).toBe(2);
  // This process's own lock is live.
  await owner(process.pid, new Date().toISOString());
  await expect(withDirectoryLock(lock, work)).rejects.toThrow(`pid ${process.pid}`);
});

it.runIf(process.platform === "darwin")(
  "ten consecutive landings remove scratch trees immediately, keeping logs, records and restorable commits",
  async () => {
    const f = await fixture();
    const change = await commit(f.core.source, "retained-feature", "keep this commit");
    const id = randomUUID();
    await f.queue.start(IntegrationRunSchema.parse({ action: "run", id, core: [change], push: true }), guard);
    await f.queue.wait();
    const batch = await f.queue.status(id);
    expect(batch.state).toBe("pushed");
    const tree = batch.repos[0]!.directory;
    expect(existsSync(tree)).toBe(false);
    for (let round = 1; round < 10; round++) {
      const next = randomUUID();
      const sha = await commit(f.core.source, `landing-${round}`, `change ${round}`);
      await f.queue.start(
        IntegrationRunSchema.parse({ action: "run", id: next, core: [sha], push: true }),
        guard,
      );
      await f.queue.wait();
      const landed = await f.queue.status(next);
      expect(landed.state).toBe("pushed");
      expect(existsSync(landed.repos[0]!.directory)).toBe(false);
      expect(existsSync(join(f.directory, "batches", next, "isolation"))).toBe(false);
      expect(existsSync(landed.evidence)).toBe(true);
      expect(existsSync(landed.repos[0]!.gate!.log)).toBe(true);
      expect(
        (
          await git(
            join(f.directory, "batches", next, "repositories", "core"),
            "worktree",
            "list",
            "--porcelain",
          )
        ).includes(landed.repos[0]!.directory),
      ).toBe(false);
    }
    const cli = await queueCli(f);
    expect((await runIntegrationCommand(["reclaim"], cli)).reclamation?.freedBytes).toBe(0);
    const log = await readFile(batch.repos[0]!.gate!.log, "utf8");
    expect(await readFile(batch.repos[0]!.gate!.log, "utf8")).toBe(log);
    const retained = await f.queue.status(id);
    expect(retained.worktreeReclamation?.[0]?.head).toBe(batch.repos[0]!.head);
    const repository = join(f.directory, "batches", id, "repositories", "core");
    expect(await git(repository, "show", "refs/clankie/retained/core:retained-feature")).toBe(
      "keep this commit",
    );
    const restore = randomUUID();
    await f.queue.start(IntegrationRunSchema.parse({ action: "run", id: restore, restore: id }), guard);
    await f.queue.wait();
    const restored = await f.queue.status(restore);
    expect(restored.state).toBe("passed");
    expect(await readFile(join(restored.repos[0]!.directory, "retained-feature"), "utf8")).toBe(
      "keep this commit",
    );
    expect((await f.queue.reclaimWorktrees(Date.now() + 61 * 60_000)).reclaimed).toEqual([]);
    expect(existsSync(restored.repos[0]!.directory)).toBe(true);
    console.log("Batch retention proof", {
      consecutiveLandings: 10,
      terminal: batch.state,
      reclaimed: retained.worktreeReclamation,
      restore: restored.state,
    });
  },
  120_000,
);

it.runIf(process.platform === "darwin")(
  "terminal reclamation protects live processes and removes dirty historical scratch trees",
  async () => {
    const f = await fixture();
    const change = await commit(f.core.source, "failed-feature", "keep failed commit");
    const id = randomUUID();
    await f.queue.start(IntegrationRunSchema.parse({ action: "run", id, core: [change] }), guard);
    await f.queue.wait();
    const batch = await f.queue.status(id);
    expect(batch.state).toBe("passed");
    batch.state = "failed";
    await durableJson(batch.evidence, batch);
    const tree = batch.repos[0]!.directory;
    const inspection = join(f.directory, "batches", id, "..inspection");
    await mkdir(inspection);
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      cwd: inspection,
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      expect((await f.queue.reclaimWorktrees(Date.now() + 61 * 60_000)).kept).toContainEqual({
        id,
        reason: "live_cwd",
      });
      expect(existsSync(tree)).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
    const edit = join(tree, "failed-feature");
    await writeFile(edit, "uncommitted edit");
    const result = await f.queue.reclaimWorktrees(Date.now() + 61 * 60_000);
    expect(result.reclaimed).toContain(tree);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(existsSync(tree)).toBe(false);
    expect(await readFile(batch.repos[0]!.gate!.log, "utf8")).toContain("fixture-gate-isolated");
  },
  30_000,
);

it("queues three CLI requests behind the fresh service's real maintenance lock and lands them without resubmission", async () => {
  const f = await fixture();
  const commits = [];
  for (const name of ["after-deploy-one", "after-deploy-two", "after-deploy-three"])
    commits.push(await commit(f.core.source, name, name));
  const cli = await queueCli(f);
  let acquired!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanups.push(() => release());
  // The startup sweep uses this exact lock API in the freshly booted service.
  const maintenance = withDirectoryLock(join(f.directory, "queue.lock"), async () => {
    acquired();
    await released;
  });
  await ready;
  const ids = commits.map(() => randomUUID());
  for (const [i, sha] of commits.entries())
    await runIntegrationCommand([sha, "--id", ids[i]!, "--push", "--no-wait"], cli);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const waiting = await Promise.all(ids.map((id) => f.queue.status(id)));
  expect(waiting.every((batch) => batch.state === "queued" && !batch.error)).toBe(true);
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(f.core.base);
  release();
  await maintenance;
  await f.queue.wait();
  const landed = await Promise.all(ids.map((id) => f.queue.status(id)));
  expect(landed.every((batch) => batch.state === "pushed")).toBe(true);
  for (const name of ["after-deploy-one", "after-deploy-two", "after-deploy-three"])
    expect(await git(f.core.origin, "show", `refs/heads/main:${name}`)).toBe(name);
  if (process.env.VUH2157_EVIDENCE_FILE)
    await appendFile(
      process.env.VUH2157_EVIDENCE_FILE,
      JSON.stringify({ scenario: "fresh-service-live-lock", waiting, landed }) + "\n",
    );
});

it("reports a newly dead queue owner as stale instead of waiting forever or stealing its lock", async () => {
  const f = await fixture();
  const lock = join(f.directory, "queue.lock");
  const owner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => owner.once("exit", resolve));
  const at = new Date().toISOString();
  await durableJson(join(lock, "owner.json"), { pid: owner.pid!, at });
  const request = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    core: [await commit(f.core.source, "stale-owner", "stale")],
  });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const failed = await f.queue.status(request.id);
  expect(failed.state).toBe("failed");
  expect(failed.error).toContain(`retained stale lock: ${lock} (pid ${owner.pid} since ${at})`);
  expect(await readFile(join(lock, "owner.json"), "utf8")).toContain(String(owner.pid));
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(f.core.base);
  if (process.env.VUH2157_EVIDENCE_FILE)
    await appendFile(
      process.env.VUH2157_EVIDENCE_FILE,
      JSON.stringify({ scenario: "dead-current-owner", failed }) + "\n",
    );
});

it.runIf(process.platform === "darwin")(
  "reclaim covers more than 32 historical trees, partial removals and active/foreign boundaries",
  async () => {
    const f = await fixture();
    const reclaimable: string[] = [];
    const protectedTrees: string[] = [];
    const outside = join(f.directory, "outside cleanup ; $HOME");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "keep"), "external target");
    for (let round = 0; round < 40; round++) {
      const id = randomUUID();
      const root = join(f.directory, "batches", id);
      const repository = join(root, "repositories", "core");
      const tree = join(root, "worktrees", "clankie");
      await mkdir(join(root, "repositories"), { recursive: true });
      await mkdir(join(root, "worktrees"));
      await git(root, "clone", "--no-checkout", f.core.source, repository);
      await git(repository, "worktree", "add", "--detach", tree, f.core.base);
      await mkdir(join(tree, "node_modules"));
      await writeFile(join(tree, "node_modules", "gate-cache"), "cache".repeat(1024));
      await writeFile(join(tree, "gate-output"), "untracked gate output");
      const state =
        round < 34 ? "pushed" : ["queued", "gating", "installing", "passed", "held", "partial"][round - 34]!;
      const isolation = join(root, "isolation");
      await mkdir(isolation);
      await writeFile(join(isolation, "cache"), "private install cache".repeat(1024));
      if (round === 0) {
        await symlink(outside, join(isolation, "external"));
        await mkdir(join(isolation, "literal ; $HOME"));
        await writeFile(join(isolation, "literal ; $HOME", "cache"), "literal path");
      }
      if (round < 34) reclaimable.push(isolation);
      else protectedTrees.push(isolation);
      const record = join(root, "record.json");
      await durableJson(record, {
        schemaVersion: 1,
        id,
        request: { action: "run", id, core: [f.core.base], push: true },
        state,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        evidence: record,
        repos: [
          {
            name: "core",
            source: f.core.source,
            origin: f.core.origin,
            base: f.core.base,
            head: f.core.base,
            directory: tree,
            commits: [],
          },
        ],
      });
      if (round === 0) await rm(join(tree, ".git")); // Interrupted removal with a private registration.
      if (round === 1) {
        await writeFile(join(tree, ".git"), `gitdir: ${join(f.core.source, ".git")}\n`);
        protectedTrees.push(tree);
      } else if (round < 34) reclaimable.push(tree);
      else protectedTrees.push(tree);
    }
    const result = await f.queue.reclaimWorktrees();
    expect(result.reclaimed.sort(), JSON.stringify(result.kept)).toEqual(reclaimable.sort());
    expect(result.freedBytes).toBeGreaterThan(0);
    for (const tree of reclaimable) expect(existsSync(tree)).toBe(false);
    for (const tree of protectedTrees) expect(existsSync(tree)).toBe(true);
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("external target");
    expect(await git(f.core.source, "rev-parse", "HEAD")).toBe(f.core.base);
    expect((await f.queue.reclaimWorktrees()).freedBytes).toBe(0);
  },
  120_000,
);

it("a failed gate removes its scratch tree immediately and preserves its record and gate log", async () => {
  const f = await fixture("writeFileSync('gate-output', 'dirty'); process.exit(1);");
  const change = await commit(f.core.source, "failure", "feature");
  const id = randomUUID();
  await f.queue.start(IntegrationRunSchema.parse({ action: "run", id, core: [change] }), guard);
  await f.queue.wait();
  const batch = await f.queue.status(id);
  expect(batch.state).toBe("failed");
  expect(existsSync(batch.repos[0]!.directory)).toBe(false);
  expect(existsSync(batch.evidence)).toBe(true);
  expect(await readFile(batch.repos[0]!.gate!.log, "utf8")).toContain("fixture-gate-isolated");
});
