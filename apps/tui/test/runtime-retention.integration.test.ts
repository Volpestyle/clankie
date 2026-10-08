import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRuntimeUpdater } from "../bin/runtime-updater.ts";
import {
  executeRuntimeUpdate,
  writeRuntimeUpdate,
  type RuntimeBootIdentity,
  type RuntimeUpdateResult,
} from "../bin/runtime-update.ts";
import { retainRuntimeWorktrees, withRuntimeMaintenance } from "../bin/runtime-retention.ts";
import { writePrivateJson } from "../bin/update-files.ts";
import { RuntimeCanary } from "../../clankie/src/runtime-canary.ts";
import { DeployHolds } from "../../clankie/src/deploy-holds.ts";
import { createRuntimeUpdateRoutes } from "../../clankie/src/runtime-update-routes.ts";
import { runUpdateCommand } from "../src/command/update.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
function fixture(longPaths = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "runtime-retention-")));
  roots.push(base);
  const home = longPaths ? join(base, "a".repeat(175), "b".repeat(175)) : base;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const checkout = join(home, "checkout"),
    runtime = join(home, ".clankie", "pinned"),
    updates = join(home, ".clankie", "updates");
  mkdirSync(checkout);
  mkdirSync(updates, { recursive: true, mode: 0o700 });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    }).trim();
  git(checkout, "init", "-b", "main");
  git(checkout, "config", "user.name", "Runtime fixture");
  git(checkout, "config", "user.email", "fixture@example.test");
  for (const name of [
    "apps/tui/src/command/update.ts",
    "apps/clankie/src/runtime-canary.ts",
    "apps/tui/bin/clankie.ts",
    "apps/tui/bin/clankie-herdr.ts",
  ]) {
    mkdirSync(join(checkout, name, ".."), { recursive: true });
    writeFileSync(join(checkout, name), "// fixture\n", { mode: name.includes("/bin/") ? 0o755 : 0o644 });
  }
  const executable = join(checkout, "runtime-fixture-executable");
  copyFileSync("/bin/sleep", executable);
  chmodSync(executable, 0o755);
  // A relocated Apple platform signature is killed by macOS. Only this owned
  // fixture copy gets an ad-hoc signature; no identity or installed binary changes.
  if (process.platform === "darwin")
    execFileSync("codesign", ["--force", "--sign", "-", executable], { stdio: "pipe" });
  const commits: string[] = [];
  for (let index = 0; index < 5; index++) {
    writeFileSync(join(checkout, "version"), String(index));
    git(checkout, "add", ".");
    git(checkout, "commit", "-m", `version ${index}`);
    commits.push(git(checkout, "rev-parse", "HEAD"));
  }
  git(checkout, "worktree", "add", "--detach", runtime, commits[0]!);
  const holds = new DeployHolds(join(home, "integration"));
  const heldIds = async () => (await holds.list()).map((hold) => hold.id);
  const input = () => ({
    home,
    checkout,
    runtime,
    protectedUpdateIds: heldIds,
    boot: {
      root: runtime,
      commit: git(runtime, "rev-parse", "HEAD"),
      instanceId: randomUUID(),
      pid: process.pid,
    },
  });
  const record = (
    oldCommit: string,
    newCommit: string,
    fields: Partial<RuntimeUpdateResult> = {},
    registered = true,
  ) => {
    const id = randomUUID(),
      directory = join(updates, id);
    mkdirSync(directory, { mode: 0o700 });
    const plan = {
      id,
      ref: "main",
      home,
      checkout,
      runtime,
      directory,
      oldCommit,
      newCommit,
      oldInstanceId: randomUUID(),
    };
    writePrivateJson(join(directory, "plan.json"), plan);
    const result: RuntimeUpdateResult = {
      id,
      ref: "main",
      oldCommit,
      newCommit,
      phase: "healthy",
      healthy: true,
      updatedAt: new Date().toISOString(),
      canary: { state: "passed", holdReleased: true },
      ...fields,
    };
    writeRuntimeUpdate(directory, result);
    writeFileSync(
      join(directory, "helper.log"),
      "fixture install output\n".repeat(10_000) + JSON.stringify(result) + "\n",
      { mode: 0o600 },
    );
    const previous = join(directory, "previous");
    if (registered) git(checkout, "worktree", "add", "--detach", previous, oldCommit);
    else mkdirSync(previous); // Physical candidate without native registration is never removable.
    return { id, directory, previous, plan, result };
  };
  return { home, checkout, runtime, updates, git, commits, input, record, holds, heldIds };
}

it("passed canaries release obsolete real cutovers, keep current/previous, and publish CLI/API evidence", async () => {
  const f = fixture();
  let body: ChildProcess | undefined;
  let boot: RuntimeBootIdentity = f.input().boot;
  const ports = {
    // The fixture has no dependencies. Git moves, links, journal and native body lifecycle are real.
    run: (command: string, args: readonly string[], cwd: string) =>
      command === "pnpm" ? "" : f.git(cwd, ...args),
    services: async (runtime: string, action: "down" | "restart") => {
      if (body && body.exitCode === null && body.signalCode === null) {
        body.kill();
        await once(body, "exit");
      }
      if (action === "down") return { ok: true, services: [{ id: "clankie", ok: true }] };
      const child = spawn(
        process.execPath,
        [
          "-e",
          "const {randomUUID}=require('node:crypto'); const {execFileSync}=require('node:child_process'); console.log(JSON.stringify({root:process.cwd(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),instanceId:randomUUID(),pid:process.pid})); setInterval(()=>{},1000);",
        ],
        { cwd: runtime, stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(child);
      body = child;
      const [line] = await once(child.stdout!, "data");
      boot = JSON.parse(String(line));
      return { ok: true, services: [{ id: "clankie", ok: true, pid: boot.pid }], runtime: boot };
    },
  };
  const directories: string[] = [];
  // Include an identical-SHA update: retention protects paths, not every historical copy of a commit.
  for (const commit of [f.commits[1]!, f.commits[2]!, f.commits[2]!, f.commits[3]!]) {
    const id = randomUUID(),
      directory = join(f.updates, id);
    directories.push(directory);
    mkdirSync(directory, { mode: 0o700 });
    const plan = {
      id,
      ref: "main",
      home: f.home,
      checkout: f.checkout,
      runtime: f.runtime,
      directory,
      oldCommit: f.git(f.runtime, "rev-parse", "HEAD"),
      newCommit: commit,
      oldInstanceId: boot.instanceId,
    };
    writePrivateJson(join(directory, "plan.json"), plan);
    writePrivateJson(join(f.updates, "latest.json"), { id });
    const result = await executeRuntimeUpdate(plan, ports);
    expect(result.phase).toBe("healthy");
    writeFileSync(join(directory, "helper.log"), JSON.stringify(result) + "\n", { mode: 0o600 });
    // Declared completed health-window fixture; existing canary tests exercise real sampling/holds.
    writeRuntimeUpdate(directory, { ...result, canary: { state: "passed", holdReleased: true } });
    const updater = createRuntimeUpdater({
      repoRoot: f.runtime,
      env: { HOME: f.home },
      retentionHolds: f.heldIds,
    });
    const canary = new RuntimeCanary({
      updatesDirectory: f.updates,
      runtime: boot,
      holds: new DeployHolds(join(f.home, "integration")),
      sample: async () => {
        throw Error("passed fixture must not sample");
      },
      onPassed: async () => {
        await updater.retainRuntimes!();
      },
    });
    await canary.recover();
    await canary.close();
    expect(updater.status().retention?.error).toBeUndefined();
    expect(updater.status().retention).toMatchObject({ outcome: "completed" });
    const paths = f.git(f.checkout, "worktree", "list", "--porcelain");
    expect(paths.match(/^worktree /gmu)).toHaveLength(3); // Owner, current, immediate previous.
    expect(existsSync(join(directory, "previous"))).toBe(true);
    expect(f.git(f.runtime, "rev-parse", "HEAD")).toBe(commit);
  }
  for (const directory of directories) {
    expect(existsSync(join(directory, "plan.json"))).toBe(true);
    expect(existsSync(join(directory, "result.json"))).toBe(true);
    expect(existsSync(join(directory, "helper.log"))).toBe(true);
  }
  const updater = createRuntimeUpdater({
    repoRoot: f.runtime,
    env: { HOME: f.home },
    retentionHolds: f.heldIds,
  });
  const app = createRuntimeUpdateRoutes({
    updater,
    authorize: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner"
        ? { guard: async () => {}, current: () => true }
        : undefined,
  });
  const server = createServer(async (request, response) => {
    const result = await app.fetch(
      new Request(`http://127.0.0.1${request.url}`, {
        headers: request.headers.authorization ? { authorization: request.headers.authorization } : {},
      }),
    );
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
  server.listen(0, "127.0.0.1");
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No fixture HTTP port");
    const status = await runUpdateCommand(["status"], {
      host: `http://127.0.0.1:${address.port}`,
      env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
    });
    expect(status).toMatchObject({ retention: { outcome: "completed", removedCount: 1 } });
    expect((await fetch(`http://127.0.0.1:${address.port}/v1/runtime-update`)).status).toBe(403);
  } finally {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 60_000);

it("protects live cwd and recorded service PIDs, canary/recovery dependencies, dirty/locked trees and journals", async () => {
  const f = fixture();
  f.git(f.runtime, "checkout", "--detach", f.commits[4]!);
  const live = f.record(f.commits[0]!, f.commits[1]!);
  const child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], {
    cwd: live.previous,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  await once(child.stdout!, "data");
  const pid = f.record(f.commits[0]!, f.commits[1]!, {
    serviceReceipts: [{ ok: true, services: [{ id: "clankie", ok: true, pid: child.pid! }] }],
  });
  const failed = f.record(f.commits[1]!, f.commits[2]!, {
    canary: { state: "failed", holdEstablished: true, previousHealthyCommit: f.commits[1]! },
  });
  const pending = f.record(f.commits[1]!, f.commits[2]!, { canary: { state: "pending" } });
  const recovery = f.record(f.commits[2]!, f.commits[3]!, { phase: "stop-unconfirmed", healthy: false });
  const dependency = f.record(f.commits[1]!, f.commits[2]!);
  const dirty = f.record(f.commits[0]!, f.commits[1]!);
  writeFileSync(join(dirty.previous, "untracked"), "owner work");
  const locked = f.record(f.commits[0]!, f.commits[1]!);
  f.git(f.checkout, "worktree", "lock", locked.previous);
  const executable = f.record(f.commits[4]!, f.commits[4]!);
  const executableChild = spawn(join(executable.previous, "runtime-fixture-executable"), ["600"], {
    cwd: f.home,
    stdio: "ignore",
  });
  children.push(executableChild);
  await once(executableChild, "spawn");
  const current = f.record(f.commits[3]!, f.commits[4]!);
  writePrivateJson(join(f.updates, "latest.json"), { id: current.id });
  expect(executableChild.exitCode).toBeNull();
  expect(executableChild.signalCode).toBeNull();
  const report = await retainRuntimeWorktrees(f.input());
  expect(executableChild.exitCode).toBeNull();
  expect(executableChild.signalCode).toBeNull();
  expect(report.outcome).toBe("completed");
  expect(report.removedCount).toBe(0);
  for (const row of [live, pid, executable, failed, pending, recovery, dependency, dirty, locked, current])
    expect(existsSync(row.previous)).toBe(true);
  expect(report.retained).toContainEqual({ path: live.previous, reason: "live_runtime_or_helper" });
  expect(report.retained).toContainEqual({ path: pid.previous, reason: "live_runtime_or_helper" });
  expect(report.retained).toContainEqual({ path: executable.previous, reason: "live_runtime_or_helper" });
  expect(report.retained).toContainEqual({ path: failed.previous, reason: "canary_or_recovery_runtime" });
  expect(report.retained).toContainEqual({ path: dependency.previous, reason: "protected_runtime_commit" });
  expect(readFileSync(join(dirty.previous, "untracked"), "utf8")).toBe("owner work");
}, 60_000);

it("fails closed on pending latest canary, unreadable recovery, pin aliases and concurrent admission", async () => {
  const f = fixture();
  f.git(f.runtime, "checkout", "--detach", f.commits[4]!);
  const obsolete = f.record(f.commits[0]!, f.commits[1]!);
  const current = f.record(f.commits[3]!, f.commits[4]!, { canary: { state: "pending" } });
  writePrivateJson(join(f.updates, "latest.json"), { id: current.id });
  expect(await retainRuntimeWorktrees(f.input())).toMatchObject({
    outcome: "blocked",
    error: "runtime_retention_canary_or_recovery_pending",
    removedCount: 0,
  });
  writeRuntimeUpdate(current.directory, {
    ...current.result,
    canary: { state: "passed", holdReleased: true },
  });
  writeFileSync(join(obsolete.directory, "result.json"), "broken", { mode: 0o600 });
  expect(await retainRuntimeWorktrees(f.input())).toMatchObject({ outcome: "blocked", removedCount: 0 });
  expect(existsSync(obsolete.previous)).toBe(true);
  writeRuntimeUpdate(obsolete.directory, obsolete.result);
  await f.holds.acquire({
    id: obsolete.id,
    holder: "Clankie runtime canary",
    reason: "retained fixture canary",
  });
  const held = await retainRuntimeWorktrees(f.input());
  expect(held).toMatchObject({ outcome: "completed", removedCount: 0 });
  expect(held.retained).toContainEqual({ path: obsolete.previous, reason: "canary_or_recovery_runtime" });
  await f.holds.release(obsolete.id, "fixture owner", "release owned fixture hold");
  const updater = createRuntimeUpdater({ repoRoot: f.runtime, env: { HOME: f.home } });
  await withRuntimeMaintenance(f.updates, async () => {
    await expect(
      updater.request(f.commits[4]!, { guard: async () => {}, current: () => true }),
    ).resolves.toMatchObject({ accepted: false, retentionMaintenance: { state: "held" } });
    expect(await retainRuntimeWorktrees(f.input())).toMatchObject({ outcome: "blocked", removedCount: 0 });
  });
  expect(existsSync(join(f.updates, "maintenance.lock"))).toBe(false);
  expect(existsSync(obsolete.previous)).toBe(true);
  const alias = join(f.home, "pin-alias");
  symlinkSync(f.runtime, alias);
  expect(await retainRuntimeWorktrees({ ...f.input(), runtime: alias })).toMatchObject({
    outcome: "blocked",
    error: "runtime_retention_live_pin_unverified",
    removedCount: 0,
  });
  writePrivateJson(join(f.updates, "retention-pending.json"), {
    path: obsolete.previous,
    head: f.commits[0],
    operation: obsolete.id,
  });
  expect(await retainRuntimeWorktrees(f.input())).toMatchObject({
    outcome: "blocked",
    error: "runtime_retention_effect_unconfirmed",
    removedCount: 0,
  });
  await expect(
    updater.request(f.commits[4]!, { guard: async () => {}, current: () => true }),
  ).rejects.toThrow("Runtime retention removal requires owner reconciliation");
  expect(existsSync(obsolete.previous)).toBe(true);
  expect(existsSync(join(f.updates, "retention-pending.json"))).toBe(true);
  expect(updater.status()).toMatchObject({ retentionPending: { state: "unconfirmed" } });
}, 60_000);

it("publishes bounded status with complete counts when many long-path candidates cannot be verified", async () => {
  const f = fixture(true);
  f.git(f.runtime, "checkout", "--detach", f.commits[4]!);
  for (let index = 0; index < 70; index++) f.record(f.commits[0]!, f.commits[1]!, {}, false);
  const current = f.record(f.commits[3]!, f.commits[4]!);
  writePrivateJson(join(f.updates, "latest.json"), { id: current.id });
  const report = await retainRuntimeWorktrees(f.input());
  expect(report).toMatchObject({ outcome: "completed", removedCount: 0, retainedCount: 71 });
  expect(report.retained.length).toBeLessThan(64);
  const updater = createRuntimeUpdater({ repoRoot: f.runtime, env: { HOME: f.home } });
  expect(updater.status().retention).toEqual(report);
  expect(readFileSync(join(f.updates, "retention.log"), "utf8").trim().split("\n")).toHaveLength(71);
}, 60_000);
