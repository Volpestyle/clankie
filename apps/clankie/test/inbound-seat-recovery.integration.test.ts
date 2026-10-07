import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  FleetSeatMessageReceiptSchema,
  WorkerReportBridgeStatusSchema,
  type WorkerReportBridgeStatus,
} from "@clankie/protocol";
import { FleetHealthMetrics } from "../src/fleet-health-metrics.ts";
import { DeliveryFence, deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { requestWithAdmissionRetry } from "../../../integrations/claude-plugin/worker/bin/admission.mjs";
import { createInboundSender } from "../../../integrations/claude-plugin/worker/bin/inbound-receipt.mjs";

const pane = "w3Z:pR";
interface Claim {
  deliveryId: string;
  binding: string;
  fingerprint: string;
  text: string;
}
interface FixtureMessage {
  state: string;
  port?: number;
  id?: string;
  receipt?: unknown;
}
interface HttpCall {
  method: string;
  pane: string;
  id: string | null;
}
const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) await stop(child);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "inbound-seat-recovery-"));
  roots.push(root);
  return root;
}
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
  children.delete(child);
}
async function service(
  root: string,
  mode:
    | "normal"
    | "pipe"
    | "hold"
    | "hold-abort"
    | "hold-shutdown"
    | "storage-failure"
    | "journal-failure"
    | "admission-once"
    | "admission-held"
    | "nonmember"
    | "admission-post-once"
    | "admission-post-held"
    | "admission-post-nonmember",
  deadlineMs = 30_000,
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
      fileURLToPath(new URL("./fixtures/inbound-seat-recovery/service.ts", import.meta.url)),
      root,
      mode,
      randomUUID(),
      String(deadlineMs),
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  children.add(child);
  const messages: FixtureMessage[] = [];
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr = `${stderr}${data}`.slice(-8_000);
  });
  child.on("message", (message) => {
    messages.push(message as FixtureMessage);
  });
  const ready = await new Promise<FixtureMessage>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Inbound service fixture never started: ${stderr}`)),
      10_000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Inbound service fixture exited: ${stderr}`));
    });
    child.on("message", (message) => {
      const value = message as FixtureMessage;
      if (value.state === "ready") {
        clearTimeout(timer);
        resolve(value);
      }
    });
  });
  if (!ready.port) throw new Error("Missing service fixture port");
  const origin = `http://127.0.0.1:${ready.port}`;
  return {
    child,
    messages,
    stop: () => stop(child),
    release: () => child.send("release"),
    shutdown: () => child.send("shutdown"),
    request(suffix: string, init?: RequestInit, targetPane = pane) {
      return fetch(`${origin}/v1/fleet/seats/${encodeURIComponent(targetPane)}/messages${suffix}`, {
        ...init,
        headers: {
          authorization: "Bearer fixture-inbound-token",
          "x-clankie-pane": targetPane,
          "content-type": "application/json",
        },
      });
    },
  };
}
function claim(root: string): Claim | undefined {
  const directory = join(root, "worker-claims");
  if (!existsSync(directory)) return undefined;
  const path = readdirSync(directory).find((name) => name.endsWith(".json"));
  return path ? (JSON.parse(readFileSync(join(directory, path), "utf8")) as Claim) : undefined;
}
function rows<T>(root: string, basename: string): T[] {
  const path = join(root, basename);
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    : [];
}
const calls = (root: string) => rows<HttpCall>(root, "http.jsonl");
const effects = (root: string) => rows<{ message: string }>(root, "effects.jsonl");
function acceptance(root: string, id: string): unknown {
  const meta = JSON.parse(readFileSync(join(root, "conversations/global-default/meta.json"), "utf8"));
  return meta.inboundAcceptances?.[id];
}
function worker(
  root: string,
  current: () => Awaited<ReturnType<typeof service>>,
  metrics?: FleetHealthMetrics,
) {
  let controller: AbortController | undefined;
  const send = createInboundSender({
    directory: join(root, "worker-claims"),
    scope: pane,
    ...(metrics
      ? {
          onObservation: (report: WorkerReportBridgeStatus) =>
            metrics.observeReport("default", pane, WorkerReportBridgeStatusSchema.parse(report)),
        }
      : {}),
    request: (suffix, init) =>
      requestWithAdmissionRetry(
        () =>
          current().request(suffix, {
            ...init,
            ...(init?.method === "POST" && controller ? { signal: controller.signal } : {}),
          }),
        controller?.signal,
      ),
  });
  return {
    send,
    interruptNextPost() {
      controller = new AbortController();
      return controller;
    },
    clearInterruption() {
      controller = undefined;
    },
  };
}
async function lookup(
  current: Awaited<ReturnType<typeof service>>,
  original: Claim,
  fields: Partial<Claim> = {},
  targetPane = pane,
) {
  const proof = { ...original, ...fields };
  const query = new URLSearchParams({ binding: proof.binding, fingerprint: proof.fingerprint });
  const response = await current.request(`/${proof.deliveryId}?${query}`, undefined, targetPane);
  expect(response.status).toBe(200);
  return FleetSeatMessageReceiptSchema.parse(await response.json());
}
async function latePost(current: Awaited<ReturnType<typeof service>>, original: Claim) {
  const response = await current.request("", {
    method: "POST",
    redirect: "error",
    body: JSON.stringify({
      schemaVersion: 1,
      text: original.text,
      delivery: { id: original.deliveryId, binding: original.binding },
    }),
  });
  expect(response.status).toBe(200);
  return FleetSeatMessageReceiptSchema.parse(await response.json());
}

it.skipIf(process.platform === "win32")(
  "recovers a truly interrupted POST after restart by exact lookup, with no replay or replacement until the following invocation",
  async () => {
    const root = fixtureRoot();
    let current = await service(root, "pipe");
    const leaseOwner = () =>
      JSON.parse(readFileSync(join(root, "body/body-leases.lock/owner.json"), "utf8")) as {
        pid: number;
        nonce: string;
      };
    const previousOwner = leaseOwner();
    expect(previousOwner.pid).toBe(current.child.pid);
    const sender = worker(root, () => current);
    const controller = sender.interruptNextPost();
    const originalPost = sender.send("original report");
    const fencePath = join(root, "inbound.json");
    await expect
      .poll(
        () => {
          const original = claim(root);
          const fence = new DeliveryFence(fencePath);
          return (
            !!original &&
            fence.pending(pane)?.messageId === original.deliveryId &&
            fence.pending(`id:${original.deliveryId}`)?.messageId === original.deliveryId
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const original = claim(root)!;
    expect(acceptance(root, original.deliveryId)).toBeUndefined();
    controller.abort();
    expect(await originalPost).toMatchObject({
      received: false,
      deliveryStage: "uncertain",
      deliveryId: original.deliveryId,
    });
    expect(claim(root)).toEqual(original);
    await current.stop();
    current = await service(root, "normal");
    expect(leaseOwner()).toMatchObject({ pid: current.child.pid });
    expect(leaseOwner().nonce).not.toBe(previousOwner.nonce);
    sender.clearInterruption();
    expect(await sender.send("different follow-up")).toMatchObject({
      received: false,
      deliveryStage: "unavailable",
      definitive: "not_sent",
      deliveryId: original.deliveryId,
      binding: original.binding,
      fingerprint: original.fingerprint,
    });
    expect(claim(root)).toBeUndefined();
    expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(1);
    expect(effects(root)).toEqual([]);
    const sealed = new DeliveryFence(fencePath);
    expect(sealed.pending(pane)).toBeUndefined();
    expect(sealed.pending(`id:${original.deliveryId}`)).toMatchObject({
      notSent: true,
      fingerprint: original.fingerprint,
      sessionId: original.binding,
      paneId: pane,
    });
    expect(await sender.send("fresh report")).toMatchObject({ received: true, deliveryStage: "stored" });
    await expect.poll(() => effects(root)).toEqual([{ message: "Worker output: fresh report" }]);
    expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(2);
    expect(acceptance(root, original.deliveryId)).toBeUndefined();
    expect(await latePost(current, original)).toMatchObject({ received: false, definitive: "not_sent" });
    expect(effects(root)).toEqual([{ message: "Worker output: fresh report" }]);
  },
);

it("keeps a live same-instance original uncertain and reconciles its later acceptance without replacement", async () => {
  const root = fixtureRoot();
  const current = await service(root, "hold");
  const metrics = new FleetHealthMetrics();
  const sender = worker(root, () => current, metrics);
  const controller = sender.interruptNextPost();
  const originalPost = sender.send("still in flight");
  await expect
    .poll(() => current.messages.some((message) => message.state === "held"), { timeout: 10_000 })
    .toBe(true);
  const original = claim(root)!;
  controller.abort();
  expect(await originalPost).toMatchObject({ deliveryStage: "uncertain" });
  sender.clearInterruption();
  expect(await sender.send("replacement must not send")).toMatchObject({
    deliveryStage: "uncertain",
    deliveryId: original.deliveryId,
  });
  expect(claim(root)).toEqual(original);
  expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(1);
  expect(effects(root)).toEqual([]);
  current.release();
  await expect
    .poll(
      () =>
        current.messages.some((message) => message.state === "settled" && message.id === original.deliveryId),
      { timeout: 10_000 },
    )
    .toBe(true);
  const beforeReconciliation = metrics.snapshot().totals.reports;
  expect(await sender.send("replacement must still not send")).toMatchObject({
    received: false,
    deliveryStage: "unavailable",
    detail: "The original message is stored. This different follow-up was not sent.",
  });
  expect(claim(root)).toBeUndefined();
  const afterReconciliation = metrics.snapshot().totals.reports;
  expect(afterReconciliation.attempts).toBe(beforeReconciliation.attempts + 1);
  expect(afterReconciliation.failures).toBe(beforeReconciliation.failures);
  expect(afterReconciliation.byReason.receipt_invalid).toBe(beforeReconciliation.byReason.receipt_invalid);
  expect(acceptance(root, original.deliveryId)).toMatchObject({
    text: original.text,
    fingerprint: original.fingerprint,
  });
  expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(1);
  expect(effects(root)).toEqual([{ message: "Worker output: still in flight" }]);
});

it("fences an aborted HTTP request before its delayed acceptance callback can run", async () => {
  const root = fixtureRoot();
  const current = await service(root, "hold-abort");
  const sender = worker(root, () => current);
  const controller = sender.interruptNextPost();
  const originalPost = sender.send("receiver interrupted");
  await expect
    .poll(() => current.messages.some((message) => message.state === "held"), { timeout: 10_000 })
    .toBe(true);
  const original = claim(root)!;
  controller.abort();
  expect(await originalPost).toMatchObject({ deliveryStage: "uncertain" });
  await expect
    .poll(() => current.messages.some((message) => message.state === "aborted"), { timeout: 10_000 })
    .toBe(true);
  sender.clearInterruption();
  expect(await sender.send("no replacement")).toMatchObject({
    definitive: "not_sent",
    deliveryId: original.deliveryId,
  });
  expect(claim(root)).toBeUndefined();
  expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(1);
  current.release();
  await expect
    .poll(
      () =>
        current.messages.some((message) => message.state === "settled" && message.id === original.deliveryId),
      { timeout: 10_000 },
    )
    .toBe(true);
  expect(acceptance(root, original.deliveryId)).toBeUndefined();
  expect(effects(root)).toEqual([]);
  expect(await sender.send("fresh after abort")).toMatchObject({ received: true, deliveryStage: "stored" });
  await expect.poll(() => effects(root)).toEqual([{ message: "Worker output: fresh after abort" }]);
});

it("invalidates a shutdown request before releasing the process lease and rejects its late callback after handoff", async () => {
  const root = fixtureRoot();
  const originalService = await service(root, "hold-shutdown");
  let current = originalService;
  const sender = worker(root, () => current);
  const controller = sender.interruptNextPost();
  const originalPost = sender.send("old service request");
  await expect
    .poll(() => originalService.messages.some((message) => message.state === "held"), { timeout: 10_000 })
    .toBe(true);
  const original = claim(root)!;
  controller.abort();
  expect(await originalPost).toMatchObject({ deliveryStage: "uncertain" });
  originalService.shutdown();
  await expect
    .poll(() => originalService.messages.some((message) => message.state === "shutdown"), { timeout: 10_000 })
    .toBe(true);
  current = await service(root, "normal");
  const fencePath = join(root, "inbound.json");
  const fenceBytes = () => (existsSync(fencePath) ? readFileSync(fencePath, "utf8") : undefined);
  const before = fenceBytes();
  originalService.release();
  await expect
    .poll(
      () =>
        originalService.messages.some(
          (message) => message.state === "settled" && message.id === original.deliveryId,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const lateReceipt = originalService.messages.find(
    (message) => message.state === "settled" && message.id === original.deliveryId,
  )?.receipt;
  expect(FleetSeatMessageReceiptSchema.parse(lateReceipt)).toMatchObject({
    received: false,
    deliveryStage: "uncertain",
  });
  expect(fenceBytes()).toBe(before);
  expect(acceptance(root, original.deliveryId)).toBeUndefined();
  expect(effects(root)).toEqual([]);
  sender.clearInterruption();
  expect(await sender.send("no replacement at handoff")).toMatchObject({
    definitive: "not_sent",
    deliveryId: original.deliveryId,
  });
  expect(claim(root)).toBeUndefined();
  expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(1);
  expect(await sender.send("new service fresh report")).toMatchObject({
    received: true,
    deliveryStage: "stored",
  });
  await expect.poll(() => effects(root)).toEqual([{ message: "Worker output: new service fresh report" }]);
});

it("retains a committed acceptance claim during shutdown until the replacement clears its pending pane", async () => {
  const root = fixtureRoot();
  let current = await service(root, "journal-failure");
  const sender = worker(root, () => current);
  expect(await sender.send("accepted before journal failure")).toMatchObject({
    received: false,
    deliveryStage: "uncertain",
  });
  const original = claim(root)!;
  expect(acceptance(root, original.deliveryId)).toMatchObject({
    text: original.text,
    fingerprint: original.fingerprint,
  });
  const fencePath = join(root, "inbound.json");
  expect(new DeliveryFence(fencePath).pending(pane)).toMatchObject({ messageId: original.deliveryId });
  const before = readFileSync(fencePath, "utf8");
  current.shutdown();
  await expect
    .poll(() => current.messages.some((message) => message.state === "shutdown"), { timeout: 10_000 })
    .toBe(true);
  expect(await sender.send(original.text)).toMatchObject({
    received: false,
    deliveryStage: "uncertain",
    deliveryId: original.deliveryId,
  });
  expect(claim(root)).toEqual(original);
  expect(readFileSync(fencePath, "utf8")).toBe(before);
  expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(1);
  expect(effects(root)).toEqual([]);
  await current.stop();
  current = await service(root, "normal");
  expect(await sender.send(original.text)).toMatchObject({
    received: true,
    deliveryStage: "stored",
    deliveryId: original.deliveryId,
  });
  expect(claim(root)).toBeUndefined();
  expect(new DeliveryFence(fencePath).pending(pane)).toBeUndefined();
  expect(new DeliveryFence(fencePath).pending(`id:${original.deliveryId}`)).toMatchObject({
    messageId: original.deliveryId,
  });
  expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(1);
  expect(effects(root)).toEqual([]);
  expect(await sender.send("fresh after accepted recovery")).toMatchObject({
    received: true,
    deliveryStage: "stored",
  });
  await expect
    .poll(() => effects(root))
    .toEqual([{ message: "Worker output: fresh after accepted recovery" }]);
  expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(2);
});

it("seals a past-deadline live request and refuses its late callback before any original acceptance", async () => {
  const root = fixtureRoot();
  const current = await service(root, "hold", 150);
  const sender = worker(root, () => current);
  const controller = sender.interruptNextPost();
  const originalPost = sender.send("past deadline");
  await expect
    .poll(() => current.messages.some((message) => message.state === "held"), { timeout: 10_000 })
    .toBe(true);
  const original = claim(root)!;
  controller.abort();
  expect(await originalPost).toMatchObject({ deliveryStage: "uncertain" });
  sender.clearInterruption();
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  expect(await sender.send("not a replacement")).toMatchObject({
    definitive: "not_sent",
    deliveryId: original.deliveryId,
  });
  expect(claim(root)).toBeUndefined();
  expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(1);
  current.release();
  await expect
    .poll(
      () =>
        current.messages.some((message) => message.state === "settled" && message.id === original.deliveryId),
      { timeout: 10_000 },
    )
    .toBe(true);
  expect(acceptance(root, original.deliveryId)).toBeUndefined();
  expect(effects(root)).toEqual([]);
  expect(await sender.send("deliberate fresh report")).toMatchObject({
    received: true,
    deliveryStage: "stored",
  });
  await expect.poll(() => effects(root)).toEqual([{ message: "Worker output: deliberate fresh report" }]);
});

it("clears only an exact expired pending pane fence and leaves all mismatched identities untouched", async () => {
  const root = fixtureRoot();
  const current = await service(root, "storage-failure", 150);
  const sender = worker(root, () => current);
  expect(await sender.send("failed storage")).toMatchObject({ received: false, deliveryStage: "uncertain" });
  const original = claim(root)!;
  const fencePath = join(root, "inbound.json");
  expect(new DeliveryFence(fencePath).pending(pane)).toMatchObject({ messageId: original.deliveryId });
  expect(acceptance(root, original.deliveryId)).toBeUndefined();
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  const before = readFileSync(fencePath, "utf8");
  for (const [fields, targetPane] of [
    [{}, "w4Z:pS"],
    [{ binding: "b".repeat(64) }, pane],
    [{ fingerprint: deliveryFingerprint("different body") }, pane],
    [{ deliveryId: randomUUID() }, pane],
  ] as const) {
    expect(await lookup(current, original, fields, targetPane)).toMatchObject({
      received: false,
      deliveryStage: "uncertain",
    });
    expect(readFileSync(fencePath, "utf8")).toBe(before);
  }
  expect(await sender.send("replacement must not send")).toMatchObject({
    definitive: "not_sent",
    deliveryId: original.deliveryId,
  });
  expect(claim(root)).toBeUndefined();
  expect(new DeliveryFence(fencePath).pending(pane)).toBeUndefined();
  expect(new DeliveryFence(fencePath).pending(`id:${original.deliveryId}`)).toMatchObject({ notSent: true });
  expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(1);
  expect(await latePost(current, original)).toMatchObject({ definitive: "not_sent" });
  expect(effects(root)).toEqual([]);
  expect(await sender.send("fresh after exact recovery")).toMatchObject({
    received: true,
    deliveryStage: "stored",
  });
  await expect.poll(() => effects(root)).toEqual([{ message: "Worker output: fresh after exact recovery" }]);
});

it.each(["admission-once", "admission-post-once"] as const)(
  "retries explicit %s refusal before forwarding the original exactly once",
  async (mode) => {
    const root = fixtureRoot();
    const current = await service(root, mode);
    const sender = worker(root, () => current);
    expect(await sender.send("admitted after temporary proof failure")).toMatchObject({
      received: true,
      deliveryStage: "stored",
    });
    expect(current.messages.filter((message) => message.state === "admission")).toHaveLength(2);
    expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(1);
    await expect
      .poll(() => effects(root))
      .toEqual([{ message: "Worker output: admitted after temporary proof failure" }]);
    expect(claim(root)).toBeUndefined();
  },
);

it.each(["admission-held", "admission-post-held", "nonmember", "admission-post-nonmember"] as const)(
  "surfaces %s without replaying or stranding an undispatched receipt",
  async (mode) => {
    const root = fixtureRoot();
    const current = await service(root, mode);
    const sender = worker(root, () => current);
    const receipt = await sender.send("nothing should dispatch");
    expect(receipt.deliveryStage).toBe(mode.endsWith("nonmember") ? "rejected" : "unavailable");
    if (!mode.endsWith("nonmember"))
      expect(receipt).toMatchObject({
        retryable: true,
        detail: expect.stringContaining("Wait briefly and retry"),
      });
    expect(current.messages.filter((message) => message.state === "admission")).toHaveLength(
      mode.endsWith("nonmember") ? 1 : 2,
    );
    expect(calls(root).filter((call) => call.method === "POST")).toHaveLength(0);
    expect(effects(root)).toEqual([]);
    expect(claim(root)).toBeUndefined();
  },
);
