/** Manual only: real index.ts, Captain, updater, file broker, HTTP health and deploy holds. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ProcessHealthSnapshotSchema, type ProcessHealthSnapshot } from "@clankie/protocol";
import { ClankieSettingsSchema } from "@clankie/settings";
import type { DeployHold } from "@clankie/protocol/integrate";
import { DeployHolds } from "../src/deploy-holds.ts";
import { RuntimeCanaryPolicySchema } from "../src/runtime-canary.ts";
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
const profile = process.argv.includes("--profile");
const eventLoopDelay = process.argv.includes("--event-loop-delay");
const compare = process.argv.includes("--compare");
const warmup = process.argv.includes("--warmup");
const policyConfigured =
  process.argv.includes("--window-seconds") || process.argv.includes("--sample-seconds");
function seconds(flag: string, fallback: number): number {
  const at = process.argv.indexOf(flag);
  if (at < 0) return fallback;
  const value = Number(process.argv[at + 1]);
  assert(
    Number.isFinite(value) && value > 0 && Number.isSafeInteger(value * 1000),
    `${flag} requires positive seconds`,
  );
  return value;
}
const windowSeconds = seconds("--window-seconds", 300);
const sampleSeconds = seconds("--sample-seconds", 10);
assert(windowSeconds >= sampleSeconds * 2, "Observation must contain at least two sample intervals");
const outputFlag = process.argv.indexOf("--output");
const output = resolve(
  outputFlag < 0
    ? join(
        repoRoot,
        healthy ? ".local/runtime-canary-healthy-live-proof.json" : ".local/runtime-canary-live-proof.json",
      )
    : process.argv[outputFlag + 1]!,
);
assert(!existsSync(output), `Preserve the existing receipt; choose a new --output: ${output}`);
const home = await realpath(await mkdtemp(join(tmpdir(), "clankie-index-canary-proof-")));
const state = join(home, ".clankie");
const updates = join(state, "updates");
const trace = join(home, "canary-request-timings.jsonl");
const profiles = join(home, "cpu-profiles");
const id = randomUUID();
const independentHoldId = randomUUID();
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const previous = execFileSync("git", ["rev-parse", "HEAD^"], { cwd: repoRoot, encoding: "utf8" }).trim();
const policy = RuntimeCanaryPolicySchema.parse(
  policyConfigured
    ? {
        windowMs: windowSeconds * 1000,
        sampleIntervalMs: sampleSeconds * 1000,
        cpuPercent: 10,
        healthLatencyMs: 250,
      }
    : {},
);
const receipt: Record<string, unknown> = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  repoRoot,
  head,
  node: process.version,
  outcome: "running",
  mode: healthy ? "healthy" : "cpu",
  profile,
  eventLoopDelay,
  compare,
  warmup,
  policyConfigured,
  path: "apps/clankie/src/index.ts -> /health -> runtime canary -> /v1/runtime-update",
  policy,
  limitations: [
    "The preceding healthy cutover and previous healthy checkpoint are seeded; no updater helper is executed.",
    ...(windowSeconds === 300 && sampleSeconds === 10
      ? []
      : [
          `The observation uses ${windowSeconds}-second window/${sampleSeconds}-second sampling, not the default 300/10-second policy.`,
        ]),
    ...(profile
      ? [
          "The owned Node process runs its native CPU profiler; profiling overhead is included in measurements.",
        ]
      : []),
    ...(eventLoopDelay
      ? [
          "The optional 10ms event-loop delay histogram adds regular wakeups and may mask an idle transport delay.",
        ]
      : []),
    ...(compare
      ? [
          "Independent public health comparisons run outside the measured canary window; the bare Node control is not product-flow evidence.",
        ]
      : []),
    "No model turn, provider call, Discord body, browser, Herdr fleet or AWS deployment is exercised.",
  ],
};
let child: ChildProcess | undefined;
let control: ChildProcess | undefined;
let logs = "";
const keepalive = new Agent({ keepAlive: true, maxSockets: 1 });
const socketIds = new WeakMap<object, number>();
const externalRequests = new WeakMap<object, { began: number; id: string }>();
const fetchTimings = new Map<string, unknown>();
let externalSocketOrdinal = 0;
let currentFetch: { began: number; id: string } | undefined;
channel("undici:request:create").subscribe((message) => {
  const { request } = message as { request: { path: string } };
  if (request.path === "/health" && currentFetch) externalRequests.set(request, currentFetch);
});
channel("undici:client:sendHeaders").subscribe((message) => {
  const { request, socket } = message as { request: object; socket: object };
  const probe = externalRequests.get(request);
  if (!probe) return;
  const reused = socketIds.has(socket);
  const socketId = socketIds.get(socket) ?? ++externalSocketOrdinal;
  socketIds.set(socket, socketId);
  fetchTimings.set(probe.id, {
    socketId,
    reusedObservedSocket: reused,
    dispatchToHeadersMs: performance.now() - probe.began,
  });
});

async function curlHealth(url: string, id: string): Promise<unknown> {
  const began = performance.now();
  const result = await new Promise<string>((done, reject) => {
    const probe = spawn(
      "/usr/bin/curl",
      [
        "--noproxy",
        "*",
        "--http1.1",
        "--silent",
        "--show-error",
        "--max-time",
        "2",
        "--output",
        "/dev/null",
        "--header",
        `x-clankie-canary-proof: ${id}`,
        "--write-out",
        "%{http_code} %{time_total} %{time_connect} %{num_connects}",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let data = "";
    let error = "";
    probe.stdout.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    probe.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString();
    });
    probe.once("error", reject);
    probe.once("exit", (code) =>
      code === 0 ? done(data) : reject(Error(`Owned curl probe failed: ${error}`)),
    );
  });
  const [status, total, connect, connections] = result.trim().split(" ").map(Number);
  assert.equal(status, 200);
  return {
    requestLatencyMs: total! * 1000,
    connectMs: connect! * 1000,
    connections,
    includingLaunchMs: performance.now() - began,
  };
}

async function nodeHealth(url: string, id: string, persistent: boolean): Promise<unknown> {
  const began = performance.now();
  return new Promise((done, reject) => {
    let connectMs: number | undefined;
    const request = httpRequest(
      url,
      {
        agent: persistent ? keepalive : false,
        headers: { "x-clankie-canary-proof": id },
        signal: AbortSignal.timeout(2000),
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          if (response.statusCode !== 200) reject(Error(`Owned HTTP probe returned ${response.statusCode}`));
          else
            done({
              requestLatencyMs: performance.now() - began,
              connectMs,
              reusedSocket: request.reusedSocket,
            });
        });
      },
    );
    request.on("socket", (socket) =>
      socket.once("connect", () => {
        connectMs = performance.now() - began;
      }),
    );
    request.once("error", reject);
    request.end();
  });
}

async function independentHealth(url: string, cycle: number): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const client of [
    "curl",
    "node-http-fresh",
    "node-http-keepalive",
    "undici-close",
    "undici-keepalive",
  ] as const) {
    const count = client.endsWith("keepalive") ? 2 : 1;
    for (let iteration = 1; iteration <= count; iteration++) {
      const id = `${cycle}-${client}-${iteration}`;
      const began = performance.now();
      let timing: unknown;
      try {
        if (client === "curl") timing = await curlHealth(url, id);
        else if (client.startsWith("node-http"))
          timing = await nodeHealth(url, id, client.endsWith("keepalive"));
        else {
          currentFetch = { id, began };
          const response = await fetch(url, {
            headers: {
              "x-clankie-canary-proof": id,
              ...(client === "undici-close" ? { connection: "close" } : {}),
            },
            signal: AbortSignal.timeout(2000),
          });
          await response.arrayBuffer();
          assert.equal(response.status, 200);
          timing = { requestLatencyMs: performance.now() - began, dispatch: fetchTimings.get(id) };
        }
        rows.push({ id, client, measuredAt: new Date().toISOString(), timing });
      } catch (error) {
        rows.push({
          id,
          client,
          measuredAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        currentFetch = undefined;
      }
      if (iteration < count) await sleep(250);
    }
  }
  return rows;
}

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
  if (policyConfigured) await privateJson(join(updates, "canary-policy.json"), policy);
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
    "apps/clankie/scripts/runtime-canary-live-proof.ts",
    "apps/clankie/test/fixtures/runtime-canary-cpu-preload.mjs",
  ])
    digests[path] = createHash("sha256")
      .update(await readFile(join(repoRoot, path)))
      .digest("hex");
  receipt.sourceDigests = digests;
  receipt.uncommittedInput =
    execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim().length > 0;
  const port = await privatePort();
  const controlPort = compare ? await privatePort() : undefined;
  if (compare)
    control = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import {createServer} from 'node:http'; createServer((_,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,service:'bare-node-control',pid:process.pid}));}).listen(${controlPort},'127.0.0.1');`,
      ],
      {
        cwd: home,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: home },
      },
    );
  if (control)
    receipt.control = {
      pid: control.pid,
      purpose: "Independent bare node:http process, not product-flow evidence",
    };
  const token = `clankie_op_${randomBytes(32).toString("base64url")}`;
  const trigger = join(home, "cpu-burn.trigger");
  if (profile) await mkdir(profiles, { mode: 0o700 });
  child = spawn(
    process.execPath,
    [
      ...(profile ? ["--cpu-prof", `--cpu-prof-dir=${profiles}`, "--cpu-prof-interval=1000"] : []),
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
        ...(eventLoopDelay ? { CLANKIE_CANARY_EVENT_LOOP_DELAY: "true" } : {}),
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
  const controlBase = `http://127.0.0.1:${controlPort}`;
  const comparisons: unknown[] = [];
  async function compareHealth(stage: "before" | "after") {
    if (!compare) return;
    const cycle = stage === "before" ? 1 : 2;
    comparisons.push({
      stage,
      target: "bare-node-control",
      probes: await independentHealth(`${controlBase}/health`, cycle),
    });
    comparisons.push({
      stage,
      target: "actual-index",
      probes: await independentHealth(`${base}/health`, cycle),
    });
    receipt.independentHealth = comparisons;
  }
  async function api<T>(
    path: string,
    method = "GET",
    body?: unknown,
    timeoutMs = 2000,
  ): Promise<{ status: number; body: T }> {
    // The observer must not reuse the affected Undici idle keepalive path either.
    return new Promise((done, reject) => {
      const fail = (error: unknown) =>
        reject(
          Error(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          }),
        );
      const request = httpRequest(
        `${base}${path}`,
        {
          method,
          agent: false,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) request.destroy(Error("Observer response exceeds 1MiB"));
            else chunks.push(chunk);
          });
          response.once("error", fail);
          response.once("end", () => {
            try {
              done({
                status: response.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
              });
            } catch (error) {
              fail(error);
            }
          });
        },
      );
      request.once("error", fail);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function get<T>(path: string): Promise<T> {
    const response = await api<T>(path);
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.body)}`);
    return response.body;
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
    if (warmup) {
      const probes: { measuredAt: string; healthRttMs: number }[] = [];
      const warmUntil = Date.now() + 5000;
      while (Date.now() < warmUntil) {
        const began = performance.now();
        await get<Health>("/health");
        probes.push({ measuredAt: new Date().toISOString(), healthRttMs: performance.now() - began });
        await sleep(250);
      }
      receipt.warmupHealth = probes;
      receipt.warmupLimitation =
        "A five-second real health warmup precedes seeded helper confirmation; this diagnoses startup timing and is not production policy.";
    }
    await compareHealth("before");
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
  assert.deepEqual(initial.canaryPolicy, policy);
  if (!policyConfigured) assert.equal(existsSync(join(updates, "canary-policy.json")), false);
  receipt.policySource = policyConfigured ? "private-policy-fixture" : "unconfigured-runtime-default";
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
  await compareHealth("after");
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
    const response = await api<{ error: string; detail: string }>(
      "/v1/runtime-update",
      "POST",
      { ref: "HEAD" },
      5000,
    );
    const refusal = response.body;
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
  keepalive.destroy();
  if (child) {
    await stopOwnedProcess(child);
    receipt.processExit = { code: child.exitCode, signal: child.signalCode };
  }
  if (control) {
    await stopOwnedProcess(control);
    receipt.controlProcessExit = { code: control.exitCode, signal: control.signalCode };
  }
  if (existsSync(trace)) {
    const rows = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string });
    receipt.diagnostics = rows;
    receipt.samplerHttpTimings = rows.filter((row) => row.kind === "sampler-http");
    receipt.eventLoopTimings = rows.filter((row) => row.kind === "event-loop");
  }
  if (profile && existsSync(profiles)) {
    const copied: unknown[] = [];
    const destination = `${output}.cpu-profiles`;
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const file of await readdir(profiles)) {
      if (!file.endsWith(".cpuprofile")) continue;
      const bytes = await readFile(join(profiles, file));
      const path = join(destination, file);
      await writeFile(path, bytes, { mode: 0o600 });
      copied.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    receipt.cpuProfiles = copied;
  }
  receipt.completedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await writeFile(`${output}.log`, logs, { mode: 0o600 });
  await rm(home, { recursive: true, force: true });
  process.stdout.write(
    `${JSON.stringify({ outcome: receipt.outcome, evidence: output, gap: receipt.gap })}\n`,
  );
}
