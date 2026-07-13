import { get as httpGet } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createLogger } from "@clankie/observability";
import { TerminalManager, type TerminalTransport } from "../src/terminals.ts";
import { TerminalAccessAuthority, type TerminalTokenVerifier } from "../src/terminal-access-authority.ts";
import {
  assertLoopbackHost,
  createTerminalGateway,
  TERMINAL_GATEWAY_DEFAULT_HOST,
  TERMINAL_GATEWAY_DEFAULT_PORT,
  TERMINAL_GATEWAY_PATH,
  type TerminalGateway,
  type TerminalGatewayOptions,
} from "../src/terminal-gateway.ts";

const SECRET = Buffer.alloc(32, 3);
const PRINCIPAL = "principal-1";
const DEVICE = "device-1";
const ATTR = { principalId: PRINCIPAL, deviceId: DEVICE, clientInstanceId: "client-1" };

function scriptedTransport() {
  let data: ((chunk: Buffer) => void) | undefined;
  let exit: ((code: number | null) => void) | undefined;
  return {
    emit: (chunk: Buffer | string) => data?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    finish: (code = 0) => exit?.(code),
    write: () => {},
    resize: () => {},
    kill: () => exit?.(null),
    onData: (listener: (chunk: Buffer) => void) => {
      data = listener;
    },
    onExit: (listener: (code: number | null) => void) => {
      exit = listener;
    },
  } satisfies TerminalTransport & { emit(c: Buffer | string): void; finish(code?: number): void };
}

const teardown: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (teardown.length) await teardown.pop()?.();
});

function spawn(manager: TerminalManager, id = "term-a") {
  const transport = scriptedTransport();
  const session = manager.spawnTerminal({
    id,
    workerRunId: "run-1",
    title: "shell",
    command: "unused",
    transport,
    columns: 80,
    rows: 24,
  });
  return { session, transport };
}

async function startGateway(
  manager: TerminalManager,
  options: Partial<TerminalGatewayOptions> & { authority?: TerminalTokenVerifier; logs?: string[] } = {},
): Promise<{ gateway: TerminalGateway; authority: TerminalAccessAuthority; port: number; logs: string[] }> {
  const logs = options.logs ?? [];
  const logger = createLogger({ service: "test-gateway" }, {}, { write: (line: string) => logs.push(line) });
  const authority =
    (options.authority as TerminalAccessAuthority) ?? new TerminalAccessAuthority({ secret: SECRET });
  const gateway = await createTerminalGateway({
    manager,
    authority: options.authority ?? authority,
    config: { port: 0 },
    logger,
    ...(options.maxInboundMessagesPerConnection !== undefined
      ? { maxInboundMessagesPerConnection: options.maxInboundMessagesPerConnection }
      : {}),
    ...(options.maxOutboundBufferedBytes !== undefined
      ? { maxOutboundBufferedBytes: options.maxOutboundBufferedBytes }
      : {}),
    ...(options.maxInboundMessageBytes !== undefined
      ? { maxInboundMessageBytes: options.maxInboundMessageBytes }
      : {}),
    ...(options.snapshotBoundaryWaitMs !== undefined
      ? { snapshotBoundaryWaitMs: options.snapshotBoundaryWaitMs }
      : {}),
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  teardown.push(() => gateway.close());
  return { gateway, authority, port: gateway.address.port, logs };
}

interface TestClient {
  send(message: unknown): void;
  next(): Promise<any>;
  nextOfType(type: string): Promise<any>;
  received: any[];
  socket: WebSocket;
  pauseReading(): void;
  close(): void;
}

function connect(
  port: number,
  header: string | undefined,
  path = TERMINAL_GATEWAY_PATH,
): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: header ? { authorization: header } : {},
    });
    const received: any[] = [];
    let cursor = 0;
    let notify: (() => void) | null = null;
    ws.on("message", (data: Buffer) => {
      received.push(JSON.parse(data.toString()));
      notify?.();
      notify = null;
    });
    ws.on("open", () => {
      teardown.push(() => ws.terminate());
      const next = async (): Promise<any> => {
        while (cursor >= received.length) await new Promise<void>((r) => (notify = r));
        return received[cursor++];
      };
      resolve({
        received,
        socket: ws,
        send: (message) => ws.send(JSON.stringify(message)),
        next,
        async nextOfType(type) {
          for (;;) {
            const message = await next();
            if (message.type === type) return message;
          }
        },
        pauseReading: () => (ws as unknown as { _socket: { pause(): void } })._socket.pause(),
        close: () => ws.terminate(),
      });
    });
    ws.on("unexpected-response", (_req, res) => reject(new Error(`http ${res.statusCode}`)));
    ws.on("error", () => {
      /* rejection already surfaced via unexpected-response */
    });
  });
}

function expectUpgradeStatus(
  port: number,
  header: string | undefined,
  path = TERMINAL_GATEWAY_PATH,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: header ? { authorization: header } : {},
    });
    let settled = false;
    ws.on("unexpected-response", (_req, res) => {
      settled = true;
      res.resume();
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      ws.terminate();
      reject(new Error("connection unexpectedly opened"));
    });
    ws.on("error", () => {
      if (!settled) reject(new Error("socket error before response"));
    });
  });
}

function token(authority: TerminalAccessAuthority, ttlMs?: number): string {
  return authority.mintObserveToken({
    principalId: PRINCIPAL,
    deviceId: DEVICE,
    ...(ttlMs ? { ttlMs } : {}),
  });
}
const bearer = (t: string) => `Bearer ${t}`;

const discover = (requestId = "r-disc") => ({
  protocolVersion: 1,
  type: "terminal.discover",
  requestId,
  supportedProtocolVersions: [1],
  attribution: ATTR,
});
const subscribe = (terminalId: string, requestId = "r-sub") => ({
  protocolVersion: 1,
  type: "terminal.subscribe",
  requestId,
  terminalId,
  attribution: ATTR,
});
const resume = (terminalId: string, sequence: number, requestId = "r-res") => ({
  protocolVersion: 1,
  type: "terminal.resume",
  requestId,
  terminalId,
  cursor: { sequence },
  attribution: ATTR,
});
const resync = (terminalId: string, sequence: number, requestId = "r-rsy") => ({
  protocolVersion: 1,
  type: "terminal.resync",
  requestId,
  terminalId,
  cursor: { sequence },
  cause: "reconnect",
  attribution: ATTR,
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("terminal gateway — binding and configuration", () => {
  it("exposes the canonical default endpoint constants", () => {
    expect(TERMINAL_GATEWAY_DEFAULT_HOST).toBe("127.0.0.1");
    expect(TERMINAL_GATEWAY_DEFAULT_PORT).toBe(4312);
    expect(TERMINAL_GATEWAY_PATH).toBe("/v1/terminals");
  });

  it("rejects every non-loopback bind address including 127/8, IPv6, and hostnames", () => {
    expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
    for (const host of ["0.0.0.0", "127.0.0.2", "::1", "::", "localhost", "10.0.0.1", "example.com"]) {
      expect(() => assertLoopbackHost(host)).toThrow();
    }
  });

  it("binds only 127.0.0.1 and refuses a non-loopback configuration", async () => {
    const manager = new TerminalManager();
    const { gateway } = await startGateway(manager);
    expect(gateway.address.host).toBe("127.0.0.1");
    await expect(
      createTerminalGateway({
        manager,
        authority: new TerminalAccessAuthority({ secret: SECRET }),
        config: { host: "0.0.0.0", port: 0 },
      }),
    ).rejects.toThrow(/127\.0\.0\.1/);
  });

  it("rejects invalid queue, payload, rate, and timeout bounds before binding", async () => {
    const manager = new TerminalManager();
    const authority = new TerminalAccessAuthority({ secret: SECRET });
    for (const invalid of [
      { maxInboundMessageBytes: 0 },
      { maxInboundMessagesPerConnection: -1 },
      { maxOutboundBufferedBytes: 0 },
      { snapshotBoundaryWaitMs: 0 },
      { rateLimit: { capacity: 0 } },
      { rateLimit: { refillPerSecond: Number.NaN } },
    ]) {
      await expect(
        createTerminalGateway({ manager, authority, config: { port: 0 }, ...invalid }),
      ).rejects.toThrow();
    }
  });

  it("does not expose an unauthenticated route (plain GET is 404)", async () => {
    const { port } = await startGateway(new TerminalManager());
    const status = await new Promise<number>((resolve) => {
      httpGet({ host: "127.0.0.1", port, path: TERMINAL_GATEWAY_PATH }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    expect(status).toBe(404);
  });
});

describe("terminal gateway — authentication", () => {
  it("returns 401 for missing, malformed, invalid, and expired bearer tokens", async () => {
    let now = 1_000;
    const authority = new TerminalAccessAuthority({ secret: SECRET, now: () => now });
    const { port } = await startGateway(new TerminalManager(), { authority });
    const expiring = authority.mintObserveToken({ principalId: PRINCIPAL, deviceId: DEVICE, ttlMs: 2_000 });
    expect(await expectUpgradeStatus(port, undefined)).toBe(401);
    expect(await expectUpgradeStatus(port, "Basic abc")).toBe(401);
    expect(await expectUpgradeStatus(port, "Bearer not.a.valid.token")).toBe(401);
    now = 5_000;
    expect(await expectUpgradeStatus(port, bearer(expiring))).toBe(401);
  });

  it("returns 403 for a valid token that lacks the observe scope", async () => {
    const fakeVerifier: TerminalTokenVerifier = {
      verify: () => ({ ok: true, grant: { principalId: PRINCIPAL, deviceId: DEVICE, scopes: ["control"] } }),
    };
    const { port } = await startGateway(new TerminalManager(), { authority: fakeVerifier });
    expect(await expectUpgradeStatus(port, bearer("any-token"))).toBe(403);
  });

  it("returns 404 for a wrong path", async () => {
    const { authority, port } = await startGateway(new TerminalManager());
    expect(await expectUpgradeStatus(port, bearer(token(authority)), "/v1/wrong")).toBe(404);
  });

  it("rejects a cf07 message whose attribution does not match the token identity", async () => {
    const manager = new TerminalManager();
    spawn(manager);
    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send({ ...discover(), attribution: { ...ATTR, principalId: "someone-else" } });
    const message = await client.next();
    expect(message).toMatchObject({ type: "terminal.error", code: "attribution_mismatch", retryable: false });
  });

  it("fails closed on attribution mismatch: emits the static typed error, then closes and processes no later frame", async () => {
    const manager = new TerminalManager();
    spawn(manager);
    const { authority, port } = await startGateway(manager);
    const secretToken = token(authority);
    const client = await connect(port, bearer(secretToken));
    const closed = new Promise<void>((resolve) => client.socket.on("close", () => resolve()));
    // A mismatched discover, immediately followed on the same socket by a correctly attributed one.
    client.send({ ...discover("mismatch"), attribution: { ...ATTR, principalId: "someone-else" } });
    client.send(discover("good"));
    const error = await client.nextOfType("terminal.error");
    expect(error).toMatchObject({
      type: "terminal.error",
      code: "attribution_mismatch",
      retryable: false,
      requestId: "mismatch",
    });
    // The authorization boundary is terminated: the socket closes and the correctly
    // attributed follow-up on that same socket is never answered with a discovery.
    await closed;
    expect(client.socket.readyState).toBe(WebSocket.CLOSED);
    expect(client.received.filter((message) => message.type === "terminal.discovery")).toHaveLength(0);
    // Exactly one error and no duplicate close-driven error frame.
    expect(client.received.filter((message) => message.type === "terminal.error")).toHaveLength(1);
    // Static/redacted content only: no token or mismatched attribution payload is echoed back.
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("someone-else");
    expect(serialized).not.toContain(secretToken);
  });
});

describe("terminal gateway — strict cf07 framing", () => {
  it("fails closed on malformed JSON without echoing the payload", async () => {
    const { authority, port } = await startGateway(new TerminalManager());
    const client = await connect(port, bearer(token(authority)));
    client.socket.send("{not json");
    const message = await client.next();
    expect(message).toMatchObject({ type: "terminal.error", code: "malformed_message" });
    expect(JSON.stringify(message)).not.toContain("not json");
  });

  it("fails closed on binary frames", async () => {
    const { authority, port } = await startGateway(new TerminalManager());
    const client = await connect(port, bearer(token(authority)));
    client.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    expect(await client.next()).toMatchObject({ type: "terminal.error", code: "malformed_message" });
  });

  it("rejects an unknown protocol version and an unknown message shape", async () => {
    const { authority, port } = await startGateway(new TerminalManager());
    const client = await connect(port, bearer(token(authority)));
    client.send({ protocolVersion: 2, type: "terminal.discover", requestId: "r", attribution: ATTR });
    expect(await client.next()).toMatchObject({ type: "terminal.error", code: "unsupported_version" });
    client.send({ protocolVersion: 1, type: "terminal.nope", requestId: "r2", attribution: ATTR });
    expect(await client.next()).toMatchObject({ type: "terminal.error", code: "malformed_message" });
    client.send({ ...discover("r3"), extra: "field" });
    expect(await client.next()).toMatchObject({ type: "terminal.error", code: "malformed_message" });
  });
});

describe("terminal gateway — discovery and capabilities", () => {
  it("returns discovery from the live manager with observe-only capabilities", async () => {
    const manager = new TerminalManager();
    spawn(manager, "term-a");
    spawn(manager, "term-b");
    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send(discover());
    const message = await client.next();
    expect(message.type).toBe("terminal.discovery");
    expect(message.grantedScopes).toEqual(["observe"]);
    expect(message.sessions).toHaveLength(2);
    expect(message.sessions[0]).toMatchObject({
      source: "runner_pty",
      lifecycle: { state: "open" },
      capabilities: {
        observe: true,
        resume: true,
        vtRestoreSnapshot: true,
        controlLease: false,
        input: false,
        resize: false,
      },
    });
    expect(message.sessions[0].capabilitiesRevision).toBeGreaterThan(0);
  });

  it("answers capabilities.get with the observe-only value or a typed not_found", async () => {
    const manager = new TerminalManager();
    spawn(manager, "term-a");
    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send({
      protocolVersion: 1,
      type: "terminal.capabilities.get",
      requestId: "r-cap",
      terminalId: "term-a",
      attribution: ATTR,
    });
    const message = await client.next();
    expect(message).toMatchObject({
      type: "terminal.capabilities",
      terminalId: "term-a",
      capabilities: { observe: true, controlLease: false, input: false, resize: false },
    });
    client.send({
      protocolVersion: 1,
      type: "terminal.capabilities.get",
      requestId: "r-cap2",
      terminalId: "ghost",
      attribution: ATTR,
    });
    expect(await client.next()).toMatchObject({ type: "terminal.error", code: "not_found" });
  });

  it("refuses the alternate sessions.list path with a typed capability error", async () => {
    const manager = new TerminalManager();
    spawn(manager);
    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send({
      protocolVersion: 1,
      type: "terminal.sessions.list",
      requestId: "r-list",
      attribution: ATTR,
    });
    expect(await client.next()).toMatchObject({ type: "terminal.error", code: "capability_unavailable" });
  });
});

describe("terminal gateway — subscribe, snapshot, and output ordering", () => {
  it("acks subscribed(snapshot) with a positive revision before delivering ordered output", async () => {
    const manager = new TerminalManager();
    const { transport } = spawn(manager);
    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send(subscribe("term-a"));
    const subscribed = await client.next();
    expect(subscribed).toMatchObject({
      type: "terminal.subscribed",
      initialDelivery: "snapshot",
      capabilities: { observe: true, controlLease: false, input: false, resize: false },
    });
    expect(subscribed.capabilitiesRevision).toBeGreaterThan(0);
    const snapshot = await client.next();
    expect(snapshot.type).toBe("terminal.snapshot");
    expect(snapshot.boundary).toMatchObject({ parserState: "quiescent" });
    expect(snapshot.boundary.nextSequence).toBe(snapshot.boundary.afterSequence + 1);
    transport.emit("hello ");
    transport.emit("world\n");
    const out1 = await client.nextOfType("terminal.output");
    const out2 = await client.next();
    expect(out2.type).toBe("terminal.output");
    expect(out2.sequence).toBe(out1.sequence + 1);
    expect(Buffer.from(out1.data, "base64").toString()).toBe("hello ");
    expect(Buffer.from(out2.data, "base64").toString()).toBe("world\n");
  });

  it("delivers a closed frame carrying the exit code when the terminal exits", async () => {
    const manager = new TerminalManager();
    const { transport } = spawn(manager);
    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send(subscribe("term-a"));
    await client.nextOfType("terminal.snapshot");
    transport.emit("done\n");
    transport.finish(0);
    const closed = await client.nextOfType("terminal.closed");
    expect(closed).toMatchObject({ reason: "exited", exitCode: 0, signal: null });
    expect(typeof closed.closedAt).toBe("string");
  });
});

describe("terminal gateway — resume and resync", () => {
  it("replays frames strictly after a retained resume cursor with a matching ack cursor", async () => {
    const manager = new TerminalManager();
    const { transport } = spawn(manager);
    transport.emit("a");
    transport.emit("b");
    transport.emit("c");
    await manager.whenIdle("term-a");
    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send(resume("term-a", 1));
    const subscribed = await client.next();
    expect(subscribed).toMatchObject({ type: "terminal.subscribed", initialDelivery: "replay" });
    expect(subscribed.cursor.sequence).toBe(1);
    const out2 = await client.nextOfType("terminal.output");
    const out3 = await client.next();
    expect(out2.sequence).toBe(2);
    expect(out3.sequence).toBe(3);
  });

  it("tails live with no backlog when resuming from the head", async () => {
    const manager = new TerminalManager();
    const { transport } = spawn(manager);
    transport.emit("a");
    await manager.whenIdle("term-a");
    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send(resume("term-a", 1));
    const subscribed = await client.next();
    expect(subscribed).toMatchObject({ type: "terminal.subscribed", initialDelivery: "live" });
    expect(subscribed.cursor.sequence).toBe(1);
    transport.emit("b");
    const out = await client.nextOfType("terminal.output");
    expect(out.sequence).toBe(2);
    expect(Buffer.from(out.data, "base64").toString()).toBe("b");
  });

  it("emits resync_required with no subscribed ack, then converges via client resync to subscribed(snapshot)", async () => {
    const manager = new TerminalManager({ maxBufferedFrames: 2 });
    const { transport } = spawn(manager);
    for (const chunk of ["a", "b", "c", "d"]) transport.emit(chunk);
    await manager.whenIdle("term-a");
    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send(resume("term-a", 1));
    const first = await client.next();
    expect(first).toMatchObject({
      type: "terminal.resync_required",
      requestedAfterSequence: 1,
      reason: "replay_unavailable",
    });
    expect(first.availableFromSequence).toBeGreaterThan(1);
    expect(client.received.some((m) => m.type === "terminal.subscribed")).toBe(false);
    client.send(resync("term-a", 1));
    const subscribed = await client.nextOfType("terminal.subscribed");
    expect(subscribed.initialDelivery).toBe("snapshot");
    const snapshot = await client.nextOfType("terminal.snapshot");
    expect(snapshot.boundary.afterSequence).toBeGreaterThanOrEqual(3);
  });

  it("waits for a split parser boundary and never acknowledges a snapshot below the requested floor", async () => {
    const manager = new TerminalManager();
    const { transport } = spawn(manager);
    transport.emit(Buffer.from([0xe2, 0x82, 0x1b, 0x5b]));
    await manager.whenIdle("term-a");
    const floor = manager.observation("term-a").lastSequence;
    const { authority, port } = await startGateway(manager, { snapshotBoundaryWaitMs: 1_000 });
    const client = await connect(port, bearer(token(authority)));
    client.send(resync("term-a", floor));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.received).toHaveLength(0);
    transport.emit(Buffer.from([0xac, 0x6d]));
    const subscribed = await client.nextOfType("terminal.subscribed");
    const snapshot = await client.nextOfType("terminal.snapshot");
    expect(subscribed.cursor.sequence).toBeGreaterThanOrEqual(floor);
    expect(snapshot.boundary.afterSequence).toBeGreaterThanOrEqual(floor);
  });

  it("projects geometry through closure at the requested floor without mutating legacy replay or duplicating close", async () => {
    const manager = new TerminalManager({ maxBufferedFrames: 64 });
    const { transport, session } = spawn(manager);
    transport.emit("before");
    await manager.whenIdle(session.id);
    expect(manager.observation(session.id).snapshot.sequence).toBe(1);
    const lease = await manager.acquireControl(session.id, "human");
    await manager.resize(session.id, lease.id, 101, 37);
    const floor = manager.observation(session.id).lastSequence;
    transport.finish(0);
    await manager.whenIdle(session.id);
    expect(manager.observation(session.id).snapshot.sequence).toBe(1);

    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send(resync(session.id, floor));
    const subscribed = await client.nextOfType("terminal.subscribed");
    const snapshot = await client.nextOfType("terminal.snapshot");
    expect(subscribed.lifecycle).toMatchObject({ state: "closed", sequence: 3 });
    expect(snapshot).toMatchObject({
      lifecycle: { state: "closed", sequence: 3 },
      geometry: { columns: 101, rows: 37 },
    });
    expect(snapshot.boundary.afterSequence).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.received.filter((message) => message.type === "terminal.closed")).toHaveLength(0);
    expect(manager.observerCount(session.id)).toBe(0);
  });
});

describe("terminal gateway — geometry and single attachment", () => {
  it("preserves the geometry sequence and converges resync to a replacement snapshot boundary >= N", async () => {
    const manager = new TerminalManager();
    const { session } = spawn(manager);
    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send(subscribe(session.id));
    await client.nextOfType("terminal.snapshot");
    const lease = await manager.acquireControl(session.id, "human");
    await manager.resize(session.id, lease.id, 132, 43);
    const geometry = await client.nextOfType("terminal.geometry");
    expect(geometry).toMatchObject({ cause: "pty", geometry: { columns: 132, rows: 43 } });
    const geometrySequence = geometry.sequence;
    client.send(resync(session.id, geometrySequence - 1));
    const snapshot = await client.nextOfType("terminal.snapshot");
    expect(snapshot.boundary.afterSequence).toBeGreaterThanOrEqual(geometrySequence);
    expect(snapshot.geometry).toEqual({ columns: 132, rows: 43 });
  });

  it("enforces exactly one attachment: a new subscribe leaves no stale-subscription frames after its ack", async () => {
    const manager = new TerminalManager();
    const { transport } = spawn(manager);
    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send(subscribe("term-a", "first"));
    const subscribedA = await client.nextOfType("terminal.subscribed");
    await client.nextOfType("terminal.snapshot");
    transport.emit("x");
    await client.nextOfType("terminal.output");
    client.send(subscribe("term-a", "second"));
    const subscribedB = await client.nextOfType("terminal.subscribed");
    expect(subscribedB.subscriptionId).not.toBe(subscribedA.subscriptionId);
    const markerIndex = client.received.indexOf(subscribedB);
    transport.emit("y");
    await client.nextOfType("terminal.output");
    const afterB = client.received.slice(markerIndex + 1);
    for (const message of afterB) {
      if ("subscriptionId" in message) expect(message.subscriptionId).toBe(subscribedB.subscriptionId);
    }
  });

  it("replaces a quiet live attachment promptly and tears every observer down on close", async () => {
    const manager = new TerminalManager();
    spawn(manager);
    const { gateway, authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send(subscribe("term-a", "quiet-a"));
    await client.nextOfType("terminal.snapshot");
    await waitFor(() => manager.observerCount("term-a") === 1);
    client.send(subscribe("term-a", "quiet-b"));
    await client.nextOfType("terminal.subscribed");
    await client.nextOfType("terminal.snapshot");
    expect(manager.observerCount("term-a")).toBe(1);
    await gateway.close();
    expect(manager.observerCount("term-a")).toBe(0);
  });
});

describe("terminal gateway — observe-only denials and isolation", () => {
  it("denies every lease/input/resize request with a typed error and never calls manager control", async () => {
    const manager = new TerminalManager();
    const { session } = spawn(manager);
    const acquire = vi.spyOn(manager, "acquireControl");
    const sendInput = vi.spyOn(manager, "sendInput");
    const resize = vi.spyOn(manager, "resize");
    const { authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send({
      protocolVersion: 1,
      type: "terminal.lease.request",
      requestId: "r1",
      terminalId: session.id,
      requestedTtlMs: 60_000,
      attribution: ATTR,
    });
    expect(await client.next()).toMatchObject({ type: "terminal.error", code: "scope_denied" });
    client.send({
      protocolVersion: 1,
      type: "terminal.input",
      requestId: "r2",
      terminalId: session.id,
      leaseId: "lease-x",
      operationId: "op-1",
      encoding: "base64",
      data: "QQ==",
      attribution: ATTR,
    });
    expect(await client.next()).toMatchObject({ type: "terminal.error", code: "scope_denied" });
    client.send({
      protocolVersion: 1,
      type: "terminal.resize",
      requestId: "r3",
      terminalId: session.id,
      leaseId: "lease-x",
      operationId: "op-2",
      geometry: { columns: 80, rows: 24 },
      attribution: ATTR,
    });
    expect(await client.next()).toMatchObject({ type: "terminal.error", code: "scope_denied" });
    expect(acquire).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
  });

  it("serves two independent observers of the same terminal without interference", async () => {
    const manager = new TerminalManager();
    const { transport } = spawn(manager);
    const { authority, port } = await startGateway(manager);
    const a = await connect(port, bearer(token(authority)));
    const b = await connect(port, bearer(token(authority)));
    a.send(subscribe("term-a", "a"));
    b.send(subscribe("term-a", "b"));
    await a.nextOfType("terminal.snapshot");
    await b.nextOfType("terminal.snapshot");
    transport.emit("shared\n");
    const outA = await a.nextOfType("terminal.output");
    const outB = await b.nextOfType("terminal.output");
    expect(Buffer.from(outA.data, "base64").toString()).toBe("shared\n");
    expect(Buffer.from(outB.data, "base64").toString()).toBe("shared\n");
    expect(outA.subscriptionId).not.toBe(outB.subscriptionId);
  });
});

describe("terminal gateway — backpressure, shutdown, and log hygiene", () => {
  it("enforces burst and sustained inbound rate limits independently of the lifetime cap", async () => {
    let now = 10_000;
    const manager = new TerminalManager();
    const { authority, port } = await startGateway(manager, {
      now: () => now,
      rateLimit: { capacity: 2, refillPerSecond: 1 },
      maxInboundMessagesPerConnection: 100,
    });
    const client = await connect(port, bearer(token(authority)));
    client.send(discover("burst-1"));
    client.send(discover("burst-2"));
    expect((await client.next()).type).toBe("terminal.discovery");
    expect((await client.next()).type).toBe("terminal.discovery");
    now += 1_000;
    client.send(discover("refilled"));
    expect((await client.next()).requestId).toBe("refilled");
    client.send(discover("excess"));
    expect(await client.next()).toMatchObject({ type: "terminal.error", retryable: false });
  });

  it("terminates a slow consumer once the outbound buffer ceiling is exceeded", async () => {
    const manager = new TerminalManager({ maxBufferedBytes: 64 * 1024 * 1024 });
    const { transport } = spawn(manager);
    const { gateway, authority, port } = await startGateway(manager, { maxOutboundBufferedBytes: 1024 });
    const client = await connect(port, bearer(token(authority)));
    client.pauseReading();
    client.send(subscribe("term-a"));
    transport.emit(Buffer.alloc(512 * 1024, 65));
    await waitFor(() => gateway.connectionCount === 0);
    expect(gateway.connectionCount).toBe(0);
  });

  it("closes sockets and drops observers on gateway shutdown", async () => {
    const manager = new TerminalManager();
    spawn(manager);
    const { gateway, authority, port } = await startGateway(manager);
    const client = await connect(port, bearer(token(authority)));
    client.send(subscribe("term-a"));
    await client.nextOfType("terminal.snapshot");
    const closedPromise = new Promise<void>((resolve) => client.socket.on("close", () => resolve()));
    await gateway.close();
    await closedPromise;
    expect(gateway.connectionCount).toBe(0);
  });

  it("keeps tokens, headers, and raw terminal bytes out of structured logs", async () => {
    const manager = new TerminalManager();
    const { transport } = spawn(manager);
    const logs: string[] = [];
    const { authority, port } = await startGateway(manager, { logs });
    const secretToken = token(authority);
    const client = await connect(port, bearer(secretToken));
    client.send(subscribe("term-a"));
    await client.nextOfType("terminal.snapshot");
    const secret = "SUPERSECRETTERMINALOUTPUT";
    transport.emit(secret);
    await client.nextOfType("terminal.output");
    const joined = logs.join("\n");
    expect(joined).not.toContain(secretToken);
    expect(joined).not.toContain(secret);
    expect(joined).not.toContain(Buffer.from(secret).toString("base64"));
    expect(joined).not.toContain("Bearer");
    expect(joined).not.toContain(PRINCIPAL);
  });
});
