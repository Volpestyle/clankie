/** An isolated real process and HTTP body for canary boundary integration tests. */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DeployHolds } from "../../src/deploy-holds.ts";
import { RuntimeCanary } from "../../src/runtime-canary.ts";
import { createRuntimeHealthSampler } from "../../src/runtime-health-sample.ts";
import { readPrivateJson } from "../../../tui/bin/update-files.ts";
import { readRuntimeUpdate, writeRuntimeUpdate } from "../../../tui/bin/runtime-update.ts";

const root = process.argv[2]!;
let mode = process.argv[3] ?? "idle";
const updatesDirectory = join(root, "updates");
const id = (readPrivateJson(join(updatesDirectory, "latest.json")) as { id: string }).id;
const runtime = {
  root: join(root, "pinned"),
  commit: process.argv[4] ?? "b".repeat(40),
  instanceId: randomUUID(),
  pid: process.pid,
};
const holds = new DeployHolds(join(root, "integration"));
const errors: string[] = [];
let healthRequests = 0;
let sample: ReturnType<typeof createRuntimeHealthSampler>;
// Advance only at canary sample boundaries. Real scheduling/fsync/CPU delays
// must not change a fixture's intended availability timeline. The sampler
// still measures the actual child CPU and loopback HTTP latency separately.
let canaryNow = 0;
let attempts = 0;
let lastSampleWall: number | undefined;
let maxSampleGapMs = 0;
const canary = new RuntimeCanary({
  updatesDirectory,
  runtime,
  holds,
  now: () => canaryNow,
  sample: async (identity) => {
    const attempt = attempts++;
    if (attempt > 0) canaryNow += sampleIntervalMs * (mode === "sampling-gap" ? 4 : 1);
    if (mode === "scheduler-stall" && attempt === 1) await new Promise((resolve) => setTimeout(resolve, 900));
    const wall = performance.now();
    if (lastSampleWall !== undefined) maxSampleGapMs = Math.max(maxSampleGapMs, wall - lastSampleWall);
    lastSampleWall = wall;
    return sample(identity);
  },
  alert: async (text) => {
    await appendFile(join(root, "alerts.jsonl"), `${JSON.stringify({ text })}\n`, { mode: 0o600 });
    return mode !== "alert-unavailable";
  },
  onError: () => errors.push("canary observation unavailable"),
});
const server = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  healthRequests++;
  if (mode === "timeout" || (mode === "first-timeout" && healthRequests === 1)) return;
  if (mode === "first-reset" && healthRequests === 1) {
    request.socket.destroy();
    return;
  }
  const unhealthy = mode === "unhealthy" || (mode === "first-unhealthy" && healthRequests === 1);
  const answer = () => {
    response.writeHead(unhealthy ? 503 : 200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: !unhealthy,
        service: "clankie",
        runtime: mode === "wrong-identity" ? { ...runtime, instanceId: randomUUID() } : runtime,
      }),
    );
  };
  if (mode === "latency") setTimeout(answer, 60);
  else answer();
});
if (mode !== "body-only") await canary.recover();
const armPath = join(updatesDirectory, id, "canary-policy.json");
const sampleIntervalMs = existsSync(armPath)
  ? (readPrivateJson(armPath) as { policy: { sampleIntervalMs: number } }).policy.sampleIntervalMs
  : canary.policy().sampleIntervalMs;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
sample = createRuntimeHealthSampler({
  healthUrl: `http://127.0.0.1:${port}/health`,
  timeoutMs: mode.includes("timeout") ? 200 : 1000,
});
const burn = setInterval(() => {
  if (mode !== "cpu") return;
  const start = performance.now();
  while (performance.now() - start < 30) {
    Math.sqrt(performance.now());
  }
}, 50);
burn.unref();
if (mode !== "body-only") canary.start();
process.send?.({ ready: true, runtime, port });

process.on("message", (message: unknown) => {
  void (async () => {
    const input = message as { requestId: number; action: string; value?: unknown };
    let value: unknown;
    try {
      if (input.action === "status") {
        value = {
          result: readRuntimeUpdate(join(updatesDirectory, id)),
          holds: await holds.list(),
          policy: canary.policy(),
          errors,
          healthRequests,
          maxSampleGapMs,
          checkpoint: existsSync(join(updatesDirectory, "healthy-canary.json"))
            ? readPrivateJson(join(updatesDirectory, "healthy-canary.json"))
            : undefined,
        };
      } else if (input.action === "configure")
        value = await canary.configure(input.value, async () => {
          if (!process.connected) throw Error("Fixture parent IPC disconnected");
        });
      else if (input.action === "mode") {
        mode = String(input.value);
        value = { ok: true };
      } else if (input.action === "healthy") {
        const result = readRuntimeUpdate(join(updatesDirectory, id));
        writeRuntimeUpdate(join(updatesDirectory, id), {
          ...result,
          phase: "healthy",
          healthy: true,
          canary: { state: "pending" },
        });
        value = { ok: true };
      } else if (input.action === "health-target") {
        sample = createRuntimeHealthSampler({
          healthUrl: `http://127.0.0.1:${Number(input.value)}/health`,
          timeoutMs: 1000,
        });
        value = { ok: true };
      } else if (input.action === "sample") value = await sample(runtime);
      else if (input.action === "cpu") value = canary.cpu();
      else if (input.action === "prehealthy-outcome") {
        const phase = String(input.value);
        if (!["rolled-back", "failed", "stop-unconfirmed"].includes(phase))
          throw Error("Invalid prehealthy fixture outcome");
        const result = readRuntimeUpdate(join(updatesDirectory, id));
        writeRuntimeUpdate(join(updatesDirectory, id), {
          ...result,
          phase: phase as "rolled-back" | "failed" | "stop-unconfirmed",
          healthy: false,
          rollbackHealthy: phase === "rolled-back",
        });
        value = { ok: true };
      } else if (input.action === "landing") {
        value = await holds.landing("fixture-deploy", [], async () => ({ accepted: true }));
      } else throw Error("Unknown fixture action");
      process.send?.({ requestId: input.requestId, value });
    } catch (error) {
      process.send?.({
        requestId: input.requestId,
        error: error instanceof Error ? error.message : "fixture operation failed",
      });
    }
  })();
});

let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  clearInterval(burn);
  await canary.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}
process.once("SIGTERM", () => void close());
process.once("disconnect", () => void close());
