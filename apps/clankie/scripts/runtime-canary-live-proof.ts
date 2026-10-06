/** Manual only: real index.ts, Captain, updater, file broker, HTTP health and deploy holds. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ProcessHealthSnapshotSchema, type ProcessHealthSnapshot } from "@clankie/protocol";
import { ClankieSettingsSchema } from "@clankie/settings";
import type { DeployHold } from "@clankie/protocol/integrate";
import { DeployHolds } from "../src/deploy-holds.ts";
import { writePrivateJson } from "../../tui/bin/update-files.ts";
import type { RuntimeBootIdentity, RuntimeUpdateResult } from "../../tui/bin/runtime-update.ts";

if (!process.argv.includes("--run")) {
  process.stderr.write(
    "Manual only: env -u NODE_PATH node --import ./apps/clankie/node_modules/tsx/dist/loader.mjs apps/clankie/scripts/runtime-canary-live-proof.ts --run\n",
  );
  process.exit(2);
}

const repoRoot = await realpath(fileURLToPath(new URL("../../..", import.meta.url)));
const healthy = process.argv.includes("--healthy");
const outputFlag = process.argv.indexOf("--output");
const output = resolve(
  outputFlag < 0
    ? join(
        repoRoot,
        healthy ? ".local/runtime-canary-healthy-live-proof.json" : ".local/runtime-canary-live-proof.json",
      )
    : process.argv[outputFlag + 1]!,
);
const home = await realpath(await mkdtemp(join(tmpdir(), "clankie-index-canary-proof-")));
const state = join(home, ".clankie");
const updates = join(state, "updates");
const trace = join(home, "canary-request-timings.jsonl");
const id = randomUUID();
const independentHoldId = randomUUID();
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const previous = execFileSync("git", ["rev-parse", "HEAD^"], { cwd: repoRoot, encoding: "utf8" }).trim();
const policy = { windowMs: 30_000, sampleIntervalMs: 1000, cpuPercent: 10, healthLatencyMs: 250 };
const receipt: Record<string, unknown> = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  repoRoot,
  head,
  node: process.version,
  outcome: "running",
  mode: healthy ? "healthy" : "cpu",
  path: "apps/clankie/src/index.ts -> /health -> runtime canary -> /v1/runtime-update",
  policy,
  limitations: [
    "The preceding healthy cutover and previous healthy checkpoint are seeded; no updater helper is executed.",
    "The observation uses an accelerated 30-second window, not the default 300-second window.",
    "No model turn, provider call, Discord body, browser, Herdr fleet or AWS deployment is exercised.",
  ],
};
let child: ChildProcess | undefined;
let logs = "";

interface Status {
  runtime: RuntimeBootIdentity;
  latest?: RuntimeUpdateResult;
  holds?: DeployHold[];
  canaryPolicy?: typeof policy;
}
interface Health {
  ok: true;
  service: "clankie";
  runtime: RuntimeBootIdentity;
  processHealth: ProcessHealthSnapshot;
}

async function privateJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function privatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return address.port;
}

async function stopOwnedProcess(process: ChildProcess) {
  if (!process.pid || process.exitCode !== null || process.signalCode !== null) return;
  const exit = new Promise<void>((done) => process.once("exit", () => done()));
  process.kill("SIGTERM");
  const deadline = setTimeout(() => process.kill("SIGKILL"), 8000);
  try {
    await exit;
  } finally {
    clearTimeout(deadline);
  }
}

try {
  assert(!existsSync(join(repoRoot, ".env.local")), "Proof checkout must not contain provider .env.local");
  const credentials = join(home, ".config/clankie/credentials.json");
  const settings = join(home, ".config/clankie/settings.json");
  await privateJson(credentials, {});
  await privateJson(
    settings,
    ClankieSettingsSchema.parse({
      schemaVersion: 1,
      herdr: { runtime: "disabled" },
      captain: { workingDirectory: home },
      browser: { harnessDelegation: false },
      host: { keepAwake: false },
    }),
  );
  await privateJson(join(updates, "latest.json"), { id });
  await privateJson(join(updates, "canary-policy.json"), policy);
  await privateJson(join(updates, "healthy-canary.json"), { commit: previous });
  const cutover = {
    id,
    ref: "HEAD",
    oldCommit: previous,
    newCommit: head,
    phase: healthy ? "restarting" : "healthy",
    ...(healthy ? {} : { healthy: true, canary: { state: "pending" } }),
    updatedAt: new Date().toISOString(),
  };
  await privateJson(join(updates, id, "result.json"), cutover);
  if (healthy)
    await new DeployHolds(join(state, "integration")).acquire({
      id: independentHoldId,
      holder: "Independent proof reviewer",
      reason: "Retain a separate owner hold through a healthy canary",
    });
  const digests: Record<string, string> = {};
  for (const path of [
    "apps/clankie/src/index.ts",
    "apps/clankie/src/runtime-canary.ts",
    "apps/clankie/src/runtime-health-sample.ts",
    "apps/clankie/src/app/runtime.ts",
    "apps/tui/bin/runtime-updater.ts",
  ])
    digests[path] = createHash("sha256")
      .update(await readFile(join(repoRoot, path)))
      .digest("hex");
  receipt.sourceDigests = digests;
  receipt.uncommittedInput =
    execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim().length > 0;
  const port = await privatePort();
  const token = `clankie_op_${randomBytes(32).toString("base64url")}`;
  const trigger = join(home, "cpu-burn.trigger");
  child = spawn(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("../test/fixtures/runtime-canary-cpu-preload.mjs", import.meta.url)),
      "--import",
      fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
      join(repoRoot, "apps/clankie/src/index.ts"),
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_STATE_HOME: join(home, ".local/state"),
        XDG_CACHE_HOME: join(home, ".cache"),
        TMPDIR: home,
        CLANKIE_SETTINGS_FILE: settings,
        CLANKIE_CREDENTIALS_FILE: credentials,
        CLANKIE_STATE: state,
        CLANKIE_OPERATOR_TOKEN: token,
        CLANKIE_SERVICES: "clankie",
        CLANKIE_BROWSER_ENABLED: "false",
        CLANKIE_TLDRAW_ENABLED: "false",
        CLANKIE_PI_NATIVE_ENABLED: "false",
        ...(healthy ? {} : { CLANKIE_CANARY_CPU_TRIGGER: trigger }),
        CLANKIE_CANARY_REQUEST_TRACE: trace,
        PORT: String(port),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    },
  );
  child.stdout?.on("data", (data: Buffer) => {
    logs += data.toString();
  });
  child.stderr?.on("data", (data: Buffer) => {
    logs += data.toString();
  });
  child.once("error", (error) => {
    logs += `${error.message}\n`;
  });
  const base = `http://127.0.0.1:${port}`;
  async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json() as Promise<T>;
  }
  let health: Health | undefined;
  const bootDeadline = Date.now() + 45_000;
  while (Date.now() < bootDeadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw Error(`Real index exited before readiness: ${logs.slice(-12_000)}`);
    try {
      health = await get<Health>("/health");
      break;
    } catch {
      await sleep(250);
    }
  }
  assert(health, `Real index did not become ready: ${logs.slice(-12_000)}`);
  assert.equal(health.ok, true);
  assert.equal(health.service, "clankie");
  const firstCounters = ProcessHealthSnapshotSchema.parse(health.processHealth);
  assert.equal(health.runtime.root, repoRoot);
  assert.equal(health.runtime.commit, head);
  assert.equal(health.runtime.pid, child.pid);
  assert.equal(firstCounters.pid, child.pid);
  receipt.firstHealthyAt = new Date().toISOString();
  if (healthy) {
    const warming = await get<Status>("/v1/runtime-update");
    assert.equal(warming.latest?.phase, "restarting");
    assert(warming.holds?.some((hold) => hold.id === id));
    const warmup: { measuredAt: string; healthRttMs: number }[] = [];
    const warmUntil = Date.now() + 5000;
    while (Date.now() < warmUntil) {
      const began = performance.now();
      await get<Health>("/health");
      warmup.push({ measuredAt: new Date().toISOString(), healthRttMs: performance.now() - began });
      await sleep(250);
    }
    receipt.warmup = warmup;
    receipt.warmupLimitation =
      "A five-second real health warmup precedes seeded helper confirmation; this diagnoses startup timing and is not production policy.";
    writePrivateJson(join(updates, id, "result.json"), {
      ...cutover,
      phase: "healthy",
      healthy: true,
      canary: { state: "pending" },
      updatedAt: new Date().toISOString(),
    });
    receipt.healthyConfirmedAt = new Date().toISOString();
  }
  const initial = await get<Status>("/v1/runtime-update");
  assert.equal(initial.latest?.canary?.state, "pending");
  assert(initial.holds?.some((hold) => hold.id === id));
  receipt.bootHealth = health;
  receipt.initialStatus = initial;
  if (!healthy) {
    await writeFile(trigger, "burn\n", { mode: 0o600 });
    receipt.cpuTriggeredAt = new Date().toISOString();
  }
  let final: Status | undefined;
  const progress: unknown[] = [];
  let lastSamples: number | undefined;
  const observationDeadline = Date.now() + policy.windowMs + 15_000;
  while (Date.now() < observationDeadline) {
    const observed = await get<Status>("/v1/runtime-update");
    const canary = observed.latest?.canary;
    if (canary && canary.samples !== lastSamples) {
      lastSamples = canary.samples;
      progress.push({ observedAt: new Date().toISOString(), ...canary });
      receipt.progress = progress;
    }
    if (canary?.state === "failed" || (canary?.state === "passed" && canary.holdReleased === true)) {
      final = observed;
      break;
    }
    await sleep(500);
  }
  assert(final, "Real index did not settle its canary");
  receipt.finalStatus = final;
  assert.equal(final.latest?.phase, "healthy");
  assert.equal(final.latest?.healthy, true);
  assert.equal(final.latest?.canary?.previousHealthyCommit, previous);
  if (healthy) {
    assert.equal(final.latest?.canary?.state, "passed");
    assert.equal(final.latest?.canary?.holdReleased, true);
    assert((final.latest!.canary!.cpuMeanPercent ?? Infinity) <= policy.cpuPercent);
    assert.deepEqual(
      final.holds?.map((hold) => hold.id),
      [independentHoldId],
    );
  } else {
    assert.equal(final.latest?.canary?.error, "runtime-canary-cpu-budget-exceeded");
    assert.equal(final.latest?.canary?.holdEstablished, true);
    assert((final.latest!.canary!.cpuMeanPercent ?? 0) > policy.cpuPercent);
    assert(final.holds?.some((hold) => hold.id === id));
  }
  assert((final.latest!.canary!.healthP95Ms ?? Infinity) <= policy.healthLatencyMs);
  assert(
    Date.parse(final.latest!.canary!.completedAt!) - Date.parse(final.latest!.canary!.startedAt!) >=
      policy.windowMs,
  );
  const after = await get<Health>("/health");
  const lastCounters = ProcessHealthSnapshotSchema.parse(after.processHealth);
  assert.deepEqual(after.runtime, health.runtime);
  assert.equal(lastCounters.instanceId, firstCounters.instanceId);
  assert(
    lastCounters.cpu.userMicros + lastCounters.cpu.systemMicros >
      firstCounters.cpu.userMicros + firstCounters.cpu.systemMicros,
  );
  if (!healthy) {
    const response = await fetch(`${base}/v1/runtime-update`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ref: "HEAD" }),
      signal: AbortSignal.timeout(5000),
    });
    const refusal = (await response.json()) as { error: string; detail: string };
    assert.equal(response.status, 409);
    assert.equal(refusal.error, "update_refused");
    assert.match(refusal.detail, /Deploy held/u);
    assert(refusal.detail.includes(id));
    receipt.nextUpdate = { status: response.status, ...refusal, helperScheduled: false };
  }
  assert.equal(existsSync(join(updates, "active")), false, "Held POST must not schedule a helper");
  assert.deepEqual(
    (await readdir(updates)).filter((name) => /^[a-f0-9-]{36}$/u.test(name)),
    [id],
  );
  const checkpoint = JSON.parse(await readFile(join(updates, "healthy-canary.json"), "utf8")) as {
    commit: string;
  };
  assert.equal(checkpoint.commit, healthy ? head : previous);
  receipt.finalStatus = final;
  receipt.finalHealth = after;
  receipt.retainedCheckpoint = checkpoint;
  receipt.outcome = "live";
} catch (error) {
  receipt.outcome = "unproven";
  receipt.gap = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (child) {
    await stopOwnedProcess(child);
    receipt.processExit = { code: child.exitCode, signal: child.signalCode };
  }
  if (existsSync(trace))
    receipt.samplerHttpTimings = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  receipt.completedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await writeFile(`${output}.log`, logs, { mode: 0o600 });
  await rm(home, { recursive: true, force: true });
  process.stdout.write(
    `${JSON.stringify({ outcome: receipt.outcome, evidence: output, gap: receipt.gap })}\n`,
  );
}
