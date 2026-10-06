import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import type { WorkerReportBridgeStatus } from "@clankie/protocol";
import { afterEach, expect, it } from "vitest";
import type { LocalFleetIdentity } from "../src/local-fleet-link.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { FleetHealthMetrics } from "../src/fleet-health-metrics.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Delayed settings still come from the real isolated store; no host or worker is replaced. */
class HeldSettings extends SettingsStore {
  held: { entered: ReturnType<typeof gate>; released: ReturnType<typeof gate> } | undefined;
  private readonly reading = new Set<Promise<void>>();

  hold() {
    const held = { entered: gate(), released: gate() };
    this.held = held;
    return held;
  }

  override async load() {
    const finished = gate();
    this.reading.add(finished.promise);
    try {
      const held = this.held;
      if (held) {
        this.held = undefined;
        held.entered.release();
        await held.released.promise;
      }
      return await super.load();
    } finally {
      this.reading.delete(finished.promise);
      finished.release();
    }
  }

  async drain() {
    do {
      await Promise.all(this.reading);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } while (this.reading.size > 0);
  }
}

const wrappers = ["clankie_tools", "clankie_call"];
const requestTimeoutMs = 250;

async function fixture(slowBinding = false) {
  const root = await mkdtemp(join(tmpdir(), "clankie-worker-bridge-health-"));
  const settings = new HeldSettings(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    fleet: { ...current.fleet, tools: "connected", peerMessages: "off" },
  }));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const host = createMcpHost({ credentials, settings, curated: [], logger: { info() {}, warn() {} } });
  const metrics = new FleetHealthMetrics();
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    requestTimeoutMs,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetPeerMessages: async () => (await settings.load()).fleet.peerMessages,
    reportBridgeObserved: (fleet, pane, report) => metrics.observeReport(fleet, pane, report),
  });
  let valid = true;
  let validations = 0;
  const identity = (): LocalFleetIdentity => ({
    fleet: "default",
    pane: "w1:p1",
    current: () => valid,
    validate: async () => {
      validations += 1;
      return valid;
    },
  });
  let bindingGets = 0;
  let messagePosts = 0;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname.endsWith("/messages")) {
        if (request.method === "POST") messagePosts++;
        else {
          bindingGets++;
          if (slowBinding) await new Promise((resolve) => setTimeout(resolve, 750));
        }
        return Response.json({ binding: "a".repeat(64) });
      }
      return worker.handleLocalFleet(request, identity());
    },
  });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing bridge health fixture address");
  const url = `http://127.0.0.1:${address.port}/v1/fleet/mcp`;
  cleanup.push(async () => {
    settings.held?.released.release();
    await worker.close();
    await host.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  });
  const headers = (bridgeId: string, session?: string) => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-clankie-bridge-id": bridgeId,
    ...(session === undefined ? {} : { "mcp-session-id": session }),
  });
  let sequence = 0;
  const post = (bridgeId: string, session: string | undefined, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: headers(bridgeId, session),
      body: JSON.stringify({ jsonrpc: "2.0", ...(body as Record<string, unknown>) }),
      signal: AbortSignal.timeout(2_000),
    });
  const initialize = async (bridgeId: string) => {
    const response = await post(bridgeId, undefined, {
      id: ++sequence,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bridge-health-fixture", version: "1" },
      },
    });
    expect(response.status).toBe(200);
    const message = await response.json();
    expect(message).toMatchObject({
      jsonrpc: "2.0",
      id: sequence,
      result: { serverInfo: { name: "clankie-worker" } },
    });
    const session = response.headers.get("mcp-session-id");
    if (!session) throw new Error("Initialized bridge health session has no id");
    expect((await post(bridgeId, session, { method: "notifications/initialized" })).status).toBe(202);
    return session;
  };
  const report = (
    bridgeId: string,
    session: string,
    status: "ready" | "missing" | "stalled",
    reason: string,
    tools = wrappers,
    reportHealth?: WorkerReportBridgeStatus,
  ) =>
    post(bridgeId, session, {
      method: "notifications/clankie/bridge_status",
      params: { status, reason, tools, ...(reportHealth ? { report: reportHealth } : {}) },
    });
  return {
    worker,
    root,
    metrics,
    settings,
    initialize,
    report,
    url,
    headers,
    identity,
    status: () => worker.bridgeStatus("default", "w1:p1"),
    reportStatus: () => worker.reportBridgeStatus("default", "w1:p1"),
    bindingGets: () => bindingGets,
    messagePosts: () => messagePosts,
    validations: () => validations,
    revoke() {
      valid = false;
    },
  };
}

it("records a real subprocess binding timeout independently of its healthy tool catalog", async () => {
  const f = await fixture(true);
  const socket = join(f.root, "herdr.sock");
  await mkdir(join(f.root, ".clankie", "links"), { recursive: true });
  await writeFile(
    join(f.root, ".clankie", "links", "default.json"),
    JSON.stringify({
      schemaVersion: 2,
      fleet: "default",
      socket,
      url: new URL(f.url).origin,
      authentication: "local-process",
    }),
  );
  const bridge = pathToFileURL(
    join(import.meta.dirname, "../../../integrations/claude-plugin/worker/bin/seat-channel.mjs"),
  );
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runSeatChannel} from ${JSON.stringify(bridge.href)};runSeatChannel({paneId:"w1:p1",parentArgv:"test",requestTimeoutMs:250});`,
    ],
    { env: { PATH: process.env.PATH, HOME: f.root, HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "w1:p1" } },
  );
  cleanup.push(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await exited;
  });
  const replies = new Map<number, { result?: { content?: { text: string }[] }; error?: unknown }>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += String(chunk);
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.id !== undefined) replies.set(message.id, message);
    }
  });
  let id = 0;
  const call = async (method: string, params: unknown) => {
    const current = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
    await expect.poll(() => replies.has(current), { timeout: 5000 }).toBe(true);
    const response = replies.get(current)!;
    expect(response.error).toBeUndefined();
    return response;
  };
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  await call("tools/list", {});
  await expect.poll(() => f.status().status).toBe("ready");
  const reply = await call("tools/call", {
    name: "message_clankie",
    arguments: { text: "private report body must remain local" },
  });
  expect(JSON.parse(reply.result!.content![0]!.text)).toMatchObject({
    received: false,
    deliveryStage: "uncertain",
  });
  await expect
    .poll(() => f.reportStatus())
    .toMatchObject({ outcome: "uncertain", reason: "binding_timeout" });
  expect(f.status().status).toBe("ready");
  expect(f.bindingGets()).toBe(1);
  expect(f.messagePosts()).toBe(0);
  expect(JSON.stringify(f.reportStatus())).not.toContain("private report body");
  expect(f.metrics.snapshot().totals.reports).toEqual({
    attempts: 1,
    failures: 1,
    byReason: { binding_timeout: 1 },
  });
});

it("preserves stored report time across failures and fences old bridge generations", async () => {
  const f = await fixture();
  const first = randomUUID();
  const session = await f.initialize(first);
  const stored = {
    outcome: "stored" as const,
    reason: "stored" as const,
    observedAt: "2026-10-05T12:00:00.000Z",
  };
  await f.report(first, session, "ready", "Ready catalog", wrappers, stored);
  await f.report(first, session, "stalled", "Tools have stalled", wrappers);
  const failed = {
    outcome: "unavailable" as const,
    reason: "binding_timeout" as const,
    observedAt: "2026-10-05T12:01:00.000Z",
  };
  await f.report(first, session, "ready", "Ready catalog", wrappers, failed);
  await f.report(first, session, "ready", "Repeated unchanged report heartbeat", wrappers, failed);
  expect(f.reportStatus()).toEqual({ ...failed, lastStoredAt: stored.observedAt });
  expect(f.status().status).toBe("stalled");
  expect(f.metrics.snapshot().totals.reports).toEqual({
    attempts: 2,
    failures: 1,
    byReason: { binding_timeout: 1 },
  });
  const replacement = randomUUID();
  await f.initialize(replacement);
  expect(f.reportStatus()).toBeUndefined();
  await f.report(first, session, "ready", "Late previous process", wrappers, failed);
  expect(f.reportStatus()).toBeUndefined();
  expect(f.metrics.snapshot().totals.reports.attempts).toBe(2);
});

it.each(["stalled", "missing"] as const)(
  "replaces %s health on a new authenticated bridge process, preserves reconnects and rejects old observations",
  async (oldStatus) => {
    const f = await fixture();
    const firstId = randomUUID();
    const firstSession = await f.initialize(firstId);
    expect((await f.report(firstId, firstSession, oldStatus, "Previous bridge observation")).status).toBe(
      202,
    );
    expect(f.status()).toMatchObject({
      status: oldStatus,
      reason: "Native bridge reported: Previous bridge observation",
    });
    const previous = f.status();
    const reconnected = await f.initialize(firstId);
    expect(f.status()).toEqual(previous);

    const replacementId = randomUUID();
    const replacement = await f.initialize(replacementId);
    expect(f.status().status).toBe("not-observed");
    expect(
      (await f.report(replacementId, firstSession, "ready", "An old session cannot claim the new process ID"))
        .status,
    ).toBe(403);
    expect(f.status().status).toBe("not-observed");
    await f.report(firstId, reconnected, "missing", "Late previous process report", ["clankie_tools"]);
    expect(f.status().status).toBe("not-observed");
    expect(
      (await f.report(replacementId, replacement, "ready", "Replacement catalog acknowledged")).status,
    ).toBe(202);
    const current = f.status();
    expect(current).toMatchObject({
      status: "ready",
      reason: "Native bridge reported: Replacement catalog acknowledged",
      tools: wrappers,
    });
    await f.report(firstId, firstSession, "stalled", "Late stalled result from the previous process");
    expect(f.status()).toEqual(current);
    expect(f.validations()).toBeGreaterThan(8);
    f.revoke();
    expect((await f.report(replacementId, replacement, "missing", "Unadmitted report")).status).toBe(403);
    expect(f.status()).toEqual(current);
    await f.worker.close();
    expect(f.status().status).toBe("not-observed");
  },
);

it("fences a previous process notification already awaiting settings when its replacement initializes", async () => {
  const f = await fixture();
  const firstId = randomUUID();
  const firstSession = await f.initialize(firstId);
  const held = f.settings.hold();
  const pending = f.report(firstId, firstSession, "missing", "Late previous process settings result");
  try {
    await held.entered.promise;
    const replacementId = randomUUID();
    const replacement = await f.initialize(replacementId);
    expect(f.status().status).toBe("not-observed");
    expect(
      (await f.report(replacementId, replacement, "ready", "Replacement catalog acknowledged")).status,
    ).toBe(202);
    const current = f.status();
    held.released.release();
    expect((await pending).status).toBe(202);
    await f.settings.drain();
    expect(f.status()).toEqual(current);
    expect(f.status().status).toBe("ready");
  } finally {
    held.released.release();
    await pending.catch(() => undefined);
  }
});

it("bounds notification settings reads and does not publish after the timed-out read resumes", async () => {
  const f = await fixture();
  const bridgeId = randomUUID();
  const session = await f.initialize(bridgeId);
  const held = f.settings.hold();
  const started = performance.now();
  const pending = f.report(bridgeId, session, "ready", "This timed-out observation must not become healthy");
  try {
    await held.entered.promise;
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: "worker_request_failed",
      reason: expect.stringMatching(/timeout|timed out|deadline|cancel/iu),
    });
    expect(performance.now() - started).toBeLessThan(1_500);
    const afterTimeout = f.status();
    expect(afterTimeout.status).not.toBe("ready");
    held.released.release();
    await f.settings.drain();
    expect(f.status()).toEqual(afterTimeout);
  } finally {
    held.released.release();
    await pending.catch(() => undefined);
  }
});

it("bounds an unfinished notification body and fences its late JSON completion", async () => {
  const f = await fixture();
  const bridgeId = randomUUID();
  const session = await f.initialize(bridgeId);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(
        new TextEncoder().encode('{"jsonrpc":"2.0","method":"notifications/clankie/bridge_status","params":'),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  // The session is real HTTP/SDK state. A Web body stream keeps late parser
  // completion observable even if a TCP server would close its failed request.
  const request = new Request(f.url, {
    method: "POST",
    headers: f.headers(bridgeId, session),
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const started = performance.now();
  const response = await f.worker.handleLocalFleet(request, f.identity());
  expect(response.status).toBe(504);
  expect(await response.json()).toMatchObject({
    error: "worker_request_failed",
    reason: expect.stringMatching(/timeout|timed out|deadline|cancel/iu),
  });
  expect(performance.now() - started).toBeLessThan(1_500);
  const afterTimeout = f.status();
  if (!cancelled) {
    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          status: "ready",
          reason: "Late body observation must not become healthy",
          tools: wrappers,
        }) + "}",
      ),
    );
    controller.close();
  }
  await f.settings.drain();
  expect(f.status()).toEqual(afterTimeout);
  expect(f.status().status).not.toBe("ready");
});

it("bounds an unfinished initialize body without activating a late replacement session", async () => {
  const f = await fixture();
  const originalId = randomUUID();
  const originalSession = await f.initialize(originalId);
  expect((await f.report(originalId, originalSession, "ready", "Original catalog acknowledged")).status).toBe(
    202,
  );
  const originalHealth = f.status();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1000,"method":"initialize","params":'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(f.url, {
    method: "POST",
    headers: f.headers(randomUUID()),
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const started = performance.now();
  const response = await f.worker.handleLocalFleet(request, f.identity());
  expect(response.status).toBe(504);
  expect(response.headers.get("mcp-session-id")).toBeNull();
  expect(await response.json()).toMatchObject({
    error: "worker_request_failed",
    reason: expect.stringMatching(/timeout|timed out|deadline|cancel/iu),
  });
  expect(performance.now() - started).toBeLessThan(1_500);
  expect(f.status()).toEqual(originalHealth);
  if (!cancelled) {
    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "bridge-health-fixture", version: "1" },
        }) + "}",
      ),
    );
    controller.close();
  }
  await f.settings.drain();
  expect(f.status()).toEqual(originalHealth);
  // The old cohort still accepts fresh observations after the delayed SDK
  // initialization could finish; no late session took over its pane's health.
  expect(
    (await f.report(originalId, originalSession, "ready", "Original catalog still accepted")).status,
  ).toBe(202);
  expect(f.status()).toMatchObject({
    status: "ready",
    reason: "Native bridge reported: Original catalog still accepted",
  });
});
