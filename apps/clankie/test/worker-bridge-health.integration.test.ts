import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import type { LocalFleetIdentity } from "../src/local-fleet-link.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-worker-bridge-health-"));
  const settings = new HeldSettings(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    fleet: { ...current.fleet, tools: "connected", peerMessages: "off" },
  }));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const host = createMcpHost({ credentials, settings, curated: [], logger: { info() {}, warn() {} } });
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    requestTimeoutMs,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetPeerMessages: async () => (await settings.load()).fleet.peerMessages,
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
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => worker.handleLocalFleet(request, identity()),
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
  ) =>
    post(bridgeId, session, {
      method: "notifications/clankie/bridge_status",
      params: { status, reason, tools },
    });
  return {
    worker,
    settings,
    initialize,
    report,
    url,
    headers,
    identity,
    status: () => worker.bridgeStatus("default", "w1:p1"),
    validations: () => validations,
    revoke() {
      valid = false;
    },
  };
}

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
