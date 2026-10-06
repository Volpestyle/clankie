import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { DeployHold } from "@clankie/protocol/integrate";
import { DeployHolds, durableJson } from "../src/deploy-holds.ts";
import type { RuntimeCanaryCpu, RuntimeCanaryPolicy } from "../src/runtime-canary.ts";
import type { RuntimeHealthSample } from "../src/runtime-health-sample.ts";
import { writePrivateJson } from "../../tui/bin/update-files.ts";
import {
  readRuntimeUpdate,
  writeRuntimeUpdate,
  type RuntimeBootIdentity,
  type RuntimeUpdateResult,
} from "../../tui/bin/runtime-update.ts";

interface Snapshot {
  result: RuntimeUpdateResult;
  holds: DeployHold[];
  policy: RuntimeCanaryPolicy;
  errors: string[];
  checkpoint?: { commit: string };
}
const roots: string[] = [];
const children = new Set<ChildProcess>();
const policy: RuntimeCanaryPolicy = {
  windowMs: 1200,
  sampleIntervalMs: 150,
  cpuPercent: 10_000,
  healthLatencyMs: 1000,
};
// Real CPU burn plus durable fsyncs needs room for scheduler jitter during concurrent checks.
const cpuPolicy = { cpuPercent: 5, windowMs: 2400, sampleIntervalMs: 400 };

afterEach(async () => {
  await Promise.all([...children].map(stop));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stop(child: ChildProcess): Promise<void> {
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    await exited;
  } finally {
    clearTimeout(kill);
  }
}

async function fixture(
  options: {
    phase?: "healthy" | "restarting";
    policy?: Partial<RuntimeCanaryPolicy>;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-runtime-canary-")));
  roots.push(root);
  const updates = join(root, "updates");
  const id = randomUUID();
  await mkdir(join(updates, id), { recursive: true, mode: 0o700 });
  writePrivateJson(join(updates, "latest.json"), { id });
  await durableJson(join(updates, "canary-policy.json"), { ...policy, ...options.policy });
  await durableJson(join(updates, "healthy-canary.json"), { commit: "a".repeat(40) });
  writeRuntimeUpdate(join(updates, id), {
    id,
    ref: "main",
    oldCommit: "a".repeat(40),
    newCommit: "b".repeat(40),
    phase: options.phase ?? "healthy",
    updatedAt: new Date().toISOString(),
    ...(options.phase === "restarting" ? {} : { healthy: true, canary: { state: "pending" } }),
  });
  return { root, id, updates };
}

async function start(root: string, mode = "idle", commit = "b".repeat(40)) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/runtime-canary-service.ts", import.meta.url)), root, mode, commit],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { PATH: process.env.PATH, HOME: root },
    },
  );
  children.add(child);
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  let requestId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let ready!: (value: { runtime: RuntimeBootIdentity; port: number }) => void;
  let failed!: (error: Error) => void;
  const started = new Promise<{ runtime: RuntimeBootIdentity; port: number }>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  child.on("message", (message: unknown) => {
    const data = message as {
      ready?: boolean;
      runtime: RuntimeBootIdentity;
      port: number;
      requestId?: number;
      value?: unknown;
      error?: string;
    };
    if (data.ready) ready(data);
    if (data.requestId === undefined) return;
    const call = pending.get(data.requestId);
    pending.delete(data.requestId);
    if (data.error) call?.reject(Error(data.error));
    else call?.resolve(data.value);
  });
  child.on("exit", () => {
    const error = Error(`Canary fixture exited: ${stderr}`);
    failed(error);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  });
  child.on("error", failed);
  const timeout = setTimeout(() => failed(Error(`Canary fixture start timed out: ${stderr}`)), 10_000);
  let identity;
  try {
    identity = await started;
  } finally {
    clearTimeout(timeout);
  }
  async function call<T>(action: string, value?: unknown): Promise<T> {
    const id = ++requestId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (data) => resolve(data as T), reject });
      child.send({ requestId: id, action, value });
    });
  }
  return { child, ...identity, call, status: () => call<Snapshot>("status") };
}

async function waitFor(service: Awaited<ReturnType<typeof start>>, state: "passed" | "failed") {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const snapshot = await service.status();
    if (
      snapshot.result.canary?.state === state &&
      (state === "passed"
        ? snapshot.result.canary.holdReleased
        : ["submitted", "unavailable"].includes(snapshot.result.canary.alertState ?? ""))
    )
      return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`Canary did not reach ${state}: ${JSON.stringify(await service.status())}`);
}

async function alerts(root: string): Promise<{ text: string }[]> {
  const content = await readFile(join(root, "alerts.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return content.trim()
    ? content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { text: string })
    : [];
}

it("samples a real candidate process and loopback health for a full window before releasing only its owned hold", async () => {
  const f = await fixture();
  const holds = new DeployHolds(join(f.root, "integration"));
  const other = { id: randomUUID(), holder: "Integrator", reason: "Independent live check" };
  await holds.acquire(other);
  const service = await start(f.root);
  const early = await service.status();
  expect(early.result.canary).toMatchObject({
    state: "pending",
    holdId: f.id,
    holdEstablished: true,
    pid: service.runtime.pid,
  });
  expect(early.holds.map((hold) => hold.id)).toContain(f.id);
  await expect(service.call("landing")).rejects.toThrow("Deploy held");
  const sample = await service.call<RuntimeHealthSample>("sample");
  expect(sample).toMatchObject({ runtime: service.runtime });
  expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
  expect(sample.healthLatencyMs).toBeGreaterThan(0);
  const result = await waitFor(service, "passed");
  expect(
    Date.parse(result.result.canary!.completedAt!) - Date.parse(result.result.canary!.startedAt!),
  ).toBeGreaterThanOrEqual(policy.windowMs);
  expect(result.result.canary).toMatchObject({
    state: "passed",
    holdReleased: true,
    previousHealthyCommit: "a".repeat(40),
  });
  expect(result.result.canary!.samples).toBeGreaterThanOrEqual(2);
  expect(result.holds.map((hold) => hold.id)).toEqual([other.id]);
  expect(result.checkpoint).toEqual({ commit: "b".repeat(40) });
  expect(await alerts(f.root)).toEqual([]);
  await expect(service.call("landing")).rejects.toThrow("Independent live check");
});

it("records a real CPU burn beside the previous runtime's mean without holding deploys", async () => {
  const f = await fixture({ policy: cpuPolicy });
  const previousId = randomUUID();
  await mkdir(join(f.updates, previousId), { mode: 0o700 });
  writeRuntimeUpdate(join(f.updates, previousId), {
    id: previousId,
    ref: "main",
    oldCommit: "9".repeat(40),
    newCommit: "a".repeat(40),
    phase: "healthy",
    healthy: true,
    canary: { state: "passed", cpuMeanPercent: 1, holdReleased: true },
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const service = await start(f.root, "cpu");
  const passed = await waitFor(service, "passed");
  expect(passed.result.canary).toMatchObject({ state: "passed", holdReleased: true });
  expect(passed.result.canary!.cpuMeanPercent).toBeGreaterThan(cpuPolicy.cpuPercent);
  expect(
    Date.parse(passed.result.canary!.completedAt!) - Date.parse(passed.result.canary!.startedAt!),
  ).toBeGreaterThanOrEqual(cpuPolicy.windowMs);
  expect(passed.holds).toEqual([]);
  expect(passed.checkpoint).toEqual({ commit: "b".repeat(40) });
  const cpu = (await service.call("cpu")) as RuntimeCanaryCpu;
  expect(cpu).toMatchObject({
    commit: "b".repeat(40),
    advisoryPercent: cpuPolicy.cpuPercent,
    aboveAdvisory: true,
    previous: { commit: "a".repeat(40), cpuMeanPercent: 1, updateId: previousId },
  });
  expect(cpu.ratioToPrevious).toBeGreaterThan(1);
  expect(await alerts(f.root)).toEqual([]);
  expect(await service.call("landing")).toEqual({ accepted: true });
});

it.each([["latency", { healthLatencyMs: 5 }, "runtime-canary-latency-budget-exceeded"]] as const)(
  "holds a real %s regression, retains new health and the previous checkpoint, and alerts once across restart",
  async (mode, budget, error) => {
    const f = await fixture({ policy: budget });
    const service = await start(f.root, mode);
    const failed = await waitFor(service, "failed");
    expect(failed.result).toMatchObject({
      phase: "healthy",
      healthy: true,
      newCommit: "b".repeat(40),
      canary: {
        state: "failed",
        error,
        holdEstablished: true,
        previousHealthyCommit: "a".repeat(40),
        alertState: "submitted",
      },
    });
    expect(failed.holds.map((hold) => hold.id)).toContain(f.id);
    expect(failed.checkpoint).toEqual({ commit: "a".repeat(40) });
    await expect(service.call("landing")).rejects.toThrow("Deploy held");
    await stop(service.child);
    const restarted = await start(f.root);
    const retained = await restarted.status();
    expect(retained.result.canary?.state).toBe("failed");
    expect(retained.checkpoint).toEqual({ commit: "a".repeat(40) });
    await expect(restarted.call("landing")).rejects.toThrow("Deploy held");
    const notification = await alerts(f.root);
    expect(notification).toHaveLength(1);
    expect(notification[0]!.text).toContain("a".repeat(40));
    expect(notification[0]!.text).toContain("No automatic rollback");
  },
);

it("arms a restarting target before health admission, snapshots policy, and starts only after confirmed healthy", async () => {
  const f = await fixture({ phase: "restarting" });
  const service = await start(f.root);
  expect((await service.status()).result.phase).toBe("restarting");
  expect((await service.status()).holds.map((hold) => hold.id)).toContain(f.id);
  await expect(service.call("landing")).rejects.toThrow("Deploy held");
  await service.call("configure", { windowMs: 2400 });
  await service.call("healthy");
  const passed = await waitFor(service, "passed");
  expect(passed.result.canary?.policy?.windowMs).toBe(1200);
  expect(passed.policy.windowMs).toBe(2400);
  expect(passed.holds).toEqual([]);
  expect(await service.call("landing")).toEqual({ accepted: true });
});

it("restarts a pending observation from a fresh process and does not count downtime or old samples", async () => {
  const f = await fixture({ policy: { windowMs: 2400 } });
  const first = await start(f.root);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const previous = await first.status();
  expect(previous.result.canary?.state).toBe("pending");
  expect(previous.result.canary!.samples).toBeGreaterThan(0);
  await stop(first.child);
  const second = await start(f.root);
  const reset = await second.status();
  expect(reset.result.canary).toMatchObject({
    state: "pending",
    pid: second.runtime.pid,
    instanceId: second.runtime.instanceId,
  });
  expect(reset.result.canary!.startedAt).not.toEqual(previous.result.canary!.startedAt);
  expect(reset.result.canary!.samples).toBeLessThanOrEqual(1);
  const passed = await waitFor(second, "passed");
  expect(
    Date.parse(passed.result.canary!.completedAt!) - Date.parse(reset.result.canary!.startedAt!),
  ).toBeGreaterThanOrEqual(2400);
});

it.each(["wrong-identity", "unhealthy"])(
  "refuses %s health without changing the installed runtime",
  async (mode) => {
    const f = await fixture();
    const service = await start(f.root, mode);
    const failed = await waitFor(service, "failed");
    expect(failed.result).toMatchObject({
      phase: "healthy",
      healthy: true,
      canary: { state: "failed", error: "runtime-canary-health-unavailable" },
    });
    expect(failed.holds.map((hold) => hold.id)).toContain(f.id);
    expect(await alerts(f.root)).toHaveLength(1);
  },
);

it("rejects an unsafe policy and exposes a claimed notification's delivery uncertainty without replay", async () => {
  const f = await fixture();
  const pending = readRuntimeUpdate(join(f.updates, f.id));
  writeRuntimeUpdate(join(f.updates, f.id), {
    ...pending,
    canary: { state: "failed", error: "runtime-canary-cpu-budget-exceeded", alertState: "claimed" },
  });
  const service = await start(f.root);
  await expect(service.call("configure", { windowMs: 50 })).rejects.toThrow();
  await expect(service.call("configure", { cpuPercent: -1 })).rejects.toThrow();
  await expect(service.call("configure", { extra: "customer content" })).rejects.toThrow();
  expect((await service.status()).result.canary).toMatchObject({
    state: "failed",
    alertState: "claimed",
    holdEstablished: true,
  });
  expect(await alerts(f.root)).toEqual([]);
});

it("retains the last passed checkpoint when an owner advances past a failed candidate and the next candidate fails", async () => {
  const f = await fixture({ policy: { healthLatencyMs: 5 } });
  const first = await start(f.root, "latency");
  expect((await waitFor(first, "failed")).result.canary?.error).toBe(
    "runtime-canary-latency-budget-exceeded",
  );
  await stop(first.child);
  const holds = new DeployHolds(join(f.root, "integration"));
  await holds.release(f.id, "Owner", "Reviewed advance to the next candidate");
  const nextId = randomUUID();
  await mkdir(join(f.updates, nextId), { mode: 0o700 });
  writeRuntimeUpdate(join(f.updates, nextId), {
    id: nextId,
    ref: "main",
    oldCommit: "b".repeat(40),
    newCommit: "c".repeat(40),
    phase: "healthy",
    healthy: true,
    canary: { state: "pending" },
    updatedAt: new Date().toISOString(),
  });
  writePrivateJson(join(f.updates, "latest.json"), { id: nextId });
  const second = await start(f.root, "latency", "c".repeat(40));
  const failed = await waitFor(second, "failed");
  expect(failed.result.canary?.error).toBe("runtime-canary-latency-budget-exceeded");
  expect(failed.result.canary?.previousHealthyCommit).toBe("a".repeat(40));
  expect(failed.checkpoint).toEqual({ commit: "a".repeat(40) });
  expect(failed.holds.map((hold) => hold.id)).toEqual([nextId]);
  expect(readRuntimeUpdate(join(f.updates, f.id)).canary?.state).toBe("failed");
  const notifications = await alerts(f.root);
  expect(notifications).toHaveLength(2);
  expect(notifications[1]!.text).toContain(`Previous healthy commit: ${"a".repeat(40)}`);
});

it("checks a stale hold owner under the landing lock and refuses to promote or release a passed candidate's foreign hold", async () => {
  const f = await fixture();
  const holds = new DeployHolds(join(f.root, "integration"));
  const expected = {
    id: f.id,
    holder: "Clankie runtime canary",
    reason: `Runtime canary for ${"b".repeat(40)}; previous healthy ${"a".repeat(40)}`,
  };
  await holds.acquire(expected);
  await holds.release(f.id, "Owner", "Reviewed transfer after observation");
  const replacement = { id: f.id, holder: "Integrator", reason: "Owner changed during admission" };
  await holds.acquire(replacement);
  await expect(holds.release(f.id, expected.holder, "Stale observer completion", expected)).rejects.toThrow(
    "ownership changed",
  );
  const result = readRuntimeUpdate(join(f.updates, f.id));
  writeRuntimeUpdate(join(f.updates, f.id), {
    ...result,
    canary: { state: "passed", previousHealthyCommit: "a".repeat(40) },
  });
  await expect(start(f.root)).rejects.toThrow("Runtime canary hold ownership changed");
  expect((await holds.list()).map(({ id, holder, reason }) => ({ id, holder, reason }))).toEqual([
    replacement,
  ]);
  expect(JSON.parse(await readFile(join(f.updates, "healthy-canary.json"), "utf8"))).toEqual({
    commit: "a".repeat(40),
  });
  expect(readRuntimeUpdate(join(f.updates, f.id)).canary?.holdReleased).toBeUndefined();
});

it("refuses recovery of an unfinished passed checkpoint from a different running commit", async () => {
  const f = await fixture();
  const result = readRuntimeUpdate(join(f.updates, f.id));
  writeRuntimeUpdate(join(f.updates, f.id), {
    ...result,
    canary: { state: "passed", previousHealthyCommit: "a".repeat(40) },
  });
  await expect(start(f.root, "idle", "c".repeat(40))).rejects.toThrow(
    "Passed runtime canary does not match the running commit",
  );
  expect(JSON.parse(await readFile(join(f.updates, "healthy-canary.json"), "utf8"))).toEqual({
    commit: "a".repeat(40),
  });
  expect(readRuntimeUpdate(join(f.updates, f.id)).canary?.holdReleased).toBeUndefined();
});

it("cleans an armed pre-canary hold only after the ordinary helper confirms rollback and the old runtime is running", async () => {
  const f = await fixture({ phase: "restarting" });
  const holds = new DeployHolds(join(f.root, "integration"));
  const other = { id: randomUUID(), holder: "Owner", reason: "Independent release review" };
  await holds.acquire(other);
  const target = await start(f.root);
  await target.call("prehealthy-outcome", "rolled-back");
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect((await target.status()).holds.map((hold) => hold.id)).toContain(f.id);
  await stop(target.child);
  const previous = await start(f.root, "idle", "a".repeat(40));
  const recovered = await previous.status();
  expect(recovered.result).toMatchObject({ phase: "rolled-back", rollbackHealthy: true });
  expect(recovered.result.canary).toBeUndefined();
  expect(recovered.holds.map((hold) => hold.id)).toEqual([other.id]);
  expect(recovered.checkpoint).toEqual({ commit: "a".repeat(40) });
  expect(await alerts(f.root)).toEqual([]);
  await expect(previous.call("landing")).rejects.toThrow("Independent release review");
});

it.each(["failed", "stop-unconfirmed"] as const)(
  "retains a pre-canary hold for owner reconciliation when helper outcome is %s",
  async (phase) => {
    const f = await fixture({ phase: "restarting" });
    const target = await start(f.root);
    await target.call("prehealthy-outcome", phase);
    await stop(target.child);
    const previous = await start(f.root, "idle", "a".repeat(40));
    const recovered = await previous.status();
    expect(recovered.result.phase).toBe(phase);
    expect(recovered.holds.map((hold) => hold.id)).toEqual([f.id]);
    await expect(previous.call("landing")).rejects.toThrow("Deploy held");
    expect(await alerts(f.root)).toEqual([]);
  },
);

it("preserves a changed hold owner after a confirmed pre-canary rollback", async () => {
  const f = await fixture({ phase: "restarting" });
  const target = await start(f.root);
  await target.call("prehealthy-outcome", "rolled-back");
  await stop(target.child);
  const holds = new DeployHolds(join(f.root, "integration"));
  await holds.release(f.id, "Owner", "Reviewed admission hold transfer");
  await holds.acquire({ id: f.id, holder: "Integrator", reason: "Replacement review hold" });
  const previous = await start(f.root, "idle", "a".repeat(40));
  const recovered = await previous.status();
  expect(recovered.holds).toMatchObject([
    { id: f.id, holder: "Integrator", reason: "Replacement review hold" },
  ]);
  await expect(previous.call("landing")).rejects.toThrow("Replacement review hold");
  expect(recovered.checkpoint).toEqual({ commit: "a".repeat(40) });
});
