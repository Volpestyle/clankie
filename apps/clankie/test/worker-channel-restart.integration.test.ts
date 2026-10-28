import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { decodeMcpResult } from "@clankie/protocol/mcp-result";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

const children = new Set<ChildProcess>();
const roots: string[] = [];
let compiledRoot: string;
let serviceEntry: string;
beforeAll(async () => {
  compiledRoot = await mkdtemp(join(tmpdir(), "channel-restart-build-"));
  serviceEntry = join(compiledRoot, "service.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/worker-channel-restart-service.ts", import.meta.url))],
    outfile: serviceEntry,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);",
    },
  });
});
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
  children.delete(child);
}
afterEach(async () => {
  for (const child of children) await stop(child);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await rm(compiledRoot, { recursive: true, force: true });
});

// Whitelist rather than inheriting live service, tracker, harness or account env.
const environment = (root: string) => ({
  PATH: process.env.PATH,
  HOME: root,
  USERPROFILE: root,
  XDG_CONFIG_HOME: join(root, ".config"),
  XDG_STATE_HOME: join(root, ".local", "state"),
  XDG_DATA_HOME: join(root, ".local", "share"),
  XDG_CACHE_HOME: join(root, ".cache"),
  NODE_ENV: "test",
  VITEST: "true",
  HERDR_SOCKET_PATH: join(root, "herdr.sock"),
});
interface State {
  bound: { sable: boolean; kit: boolean };
  acks: string[];
  ackAttempts: string[];
  pendingReports: string[];
}
async function runtime(root: string, mode: string) {
  const child = spawn(process.execPath, [serviceEntry, root, mode], {
    env: environment(root),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const messages: {
    state: string;
    id?: number;
    port?: number;
    eventId?: string;
    result?: unknown;
    error?: string;
  }[] = [];
  child.on("message", (message) => messages.push(message as (typeof messages)[number]));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Runtime never started: ${stderr}`)), 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Runtime exited: ${stderr}`));
    });
    child.on("message", (message) => {
      if ((message as { state: string }).state === "ready") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const port = messages.find((m) => m.state === "ready")!.port!;
  let id = 0;
  const call = async (action: string, pane: string, extra: Record<string, string> = {}) => {
    const current = ++id;
    child.send({ id: current, action, pane, ...extra });
    await expect.poll(() => messages.find((m) => m.id === current), { timeout: 10_000 }).toBeTruthy();
    const reply = messages.find((m) => m.id === current)!;
    expect(reply.error).toBeUndefined();
    return reply.result;
  };
  await mkdir(join(root, ".clankie", "links"), { recursive: true });
  await writeFile(
    join(root, ".clankie", "links", "default.json"),
    JSON.stringify({
      schemaVersion: 2,
      fleet: "default",
      socket: join(root, "herdr.sock"),
      url: `http://127.0.0.1:${port}`,
      authentication: "local-process",
    }),
  );
  return { child, messages, call, status: async () => (await call("status", "sable")) as State };
}

async function bridge(root: string, pane: string) {
  const module = pathToFileURL(
    join(import.meta.dirname, "../../../integrations/claude-plugin/worker/bin/seat-channel.mjs"),
  );
  // A shorter production request budget makes an outage exceed the old ACK
  // deadline without spending twenty seconds per crash-window case.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runSeatChannel} from ${JSON.stringify(module.href)};runSeatChannel({paneId:${JSON.stringify(pane)},parentArgv:'claude --channels plugin:clankie-worker@clankie',requestTimeoutMs:1000,unknownAckTimeoutMs:1000});`,
    ],
    { env: { ...environment(root), HERDR_PANE_ID: pane }, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.add(child);
  const events: string[] = [];
  const replies = new Map<number, unknown>();
  let stderr = "";
  let buffer = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.method === "notifications/claude/channel") events.push(message.params.meta.event_id);
      if (message.id !== undefined) replies.set(message.id, message);
    }
  });
  let id = 0;
  const call = async (method: string, params: unknown) => {
    const current = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
    await expect.poll(() => replies.get(current), { timeout: 5_000 }).toBeTruthy();
    return replies.get(current);
  };
  await call("initialize", { protocolVersion: "2025-06-18" });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { child, events, call, stderr: () => stderr };
}

it.each(["hold-ack", "lost-ack"])(
  "reconnects two live channels after a real runtime crash during %s, without replay or a bridge relaunch",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "worker-channel-restart-"));
    roots.push(root);
    const first = await runtime(root, mode);
    const reportId = randomUUID();
    expect(await first.call("seed-report", "sable", { reportId })).toMatchObject({ received: true });
    const sable = await bridge(root, "sable");
    const kit = await bridge(root, "kit");
    await expect.poll(async () => (await first.status()).bound).toEqual({ sable: true, kit: true });
    // Real mailbox delivery carries pending sender receipts, matching the live
    // asymmetry: Sable is ACKing a report while Kit is parked on a normal poll.
    const original = first.call("deliver", "sable", { text: "Before restart" });
    await expect.poll(() => first.messages.find((m) => m.state === "ack-held")).toBeTruthy();
    expect(await original).toMatchObject({ outcome: "delivered" });
    const heldId = first.messages.find((m) => m.state === "ack-held")!.eventId!;
    expect(sable.events.filter((id) => id === heldId)).toHaveLength(1);
    await stop(first.child);
    // Longer than the bridge's original one-second ACK budget. The old bridge
    // exits poll() permanently here, while its outbound tools remain callable.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const second = await runtime(root, "normal");
    const recoveredAt = Date.now();
    await expect
      .poll(async () => (await second.status()).bound, { timeout: 10_000 })
      .toEqual({ sable: true, kit: true });
    expect(Date.now() - recoveredAt).toBeLessThan(10_000);
    expect(children.has(sable.child) && children.has(kit.child)).toBe(true);
    expect(sable.child.exitCode).toBeNull();
    expect(kit.child.exitCode).toBeNull();
    expect(await second.call("deliver", "sable", { text: "After restart, Sable" })).toMatchObject({
      outcome: "delivered",
    });
    expect(await second.call("deliver", "kit", { text: "After restart, Kit" })).toMatchObject({
      outcome: "delivered",
    });
    // Includes the exact receipt whose HTTP response was lost, and the rest of
    // that page. Every original notification crosses stdio once only.
    expect(sable.events.filter((id) => id === heldId)).toHaveLength(1);
    expect(new Set(sable.events).size).toBe(sable.events.length);
    expect((await second.status()).acks).toContain(heldId);
    expect((await second.status()).pendingReports).toEqual([]);
    const report = await sable.call("tools/call", {
      name: "message_clankie",
      arguments: { text: "Report after restart" },
    });
    expect(decodeMcpResult((report as { result: unknown }).result)).toMatchObject({
      received: true,
      deliveryStage: "stored",
    });
    expect(sable.stderr()).not.toContain("stopped polling without replay");
  },
  30_000,
);

it("bounds a permanently mismatched native binding's unknown ACK without replaying the notification", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-channel-unknown-ack-"));
  roots.push(root);
  const service = await runtime(root, "binding-changed");
  const reportId = randomUUID();
  expect(await service.call("seed-report", "sable", { reportId })).toMatchObject({ received: true });
  const sable = await bridge(root, "sable");
  await expect.poll(async () => (await service.status()).bound.sable).toBe(true);
  const started = Date.now();
  expect(await service.call("deliver", "sable", { text: "Carry the original receipt" })).toMatchObject({
    outcome: "delivered",
  });
  await expect
    .poll(sable.stderr, { timeout: 5_000 })
    .toContain("Channel receive loop stopped: Exact acknowledgment remained unknown_event");
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(sable.stderr()).toContain("Reload the plugin in this pane (/reload-plugins)");
  const attempts = (await service.status()).ackAttempts.length;
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect((await service.status()).ackAttempts).toHaveLength(attempts);
  expect((await service.status()).bound.sable).toBe(false);
  expect(sable.events.filter((id) => id === `report:${reportId}:stored`)).toHaveLength(1);
  expect(new Set(sable.events).size).toBe(sable.events.length);
  expect((await service.status()).pendingReports).toContain(`report:${reportId}:stored`);
});
