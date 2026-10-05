import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { HerdrFleet } from "../src/herdr-fleet.ts";
import type { RemoteCodexControlProof } from "../src/remote-project-proof.ts";
import { windowsProcessCommand } from "../src/windows-process-probe.ts";
import { codexSocketControl } from "../src/captain/external-codex-control.ts";
import { openRemoteCodexConnection } from "../src/captain/remote-codex-connection.ts";
import { remoteCodexControl, remoteCodexQueue } from "../src/captain/remote-codex-app-server.ts";

const fleet: HerdrFleet = {
  id: "pc",
  session: "default",
  ssh: { host: "fixture.invalid", shell: "powershell" },
};
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  fixtureOptions: {
    wrongTuple?: boolean;
    lostReceipt?: boolean;
    noReady?: boolean;
    noTuple?: boolean;
    noHandshake?: boolean;
  } = {},
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("No fixture endpoint");
  const requests: Array<{ method: string; params: unknown }> = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id?: number; method: string; params: unknown };
      requests.push(request);
      if (request.id === undefined) return;
      if (["turn/steer", "thread/queue/add"].includes(request.method) && fixtureOptions.lostReceipt)
        return socket.close();
      const result =
        request.method === "thread/read"
          ? { thread: { id: "thread", status: { type: "active", activeFlags: [] } } }
          : request.method === "thread/turns/list"
            ? { data: [{ id: "turn", status: "inProgress" }] }
            : request.method === "thread/queue/add"
              ? {
                  queuedSubmission: {
                    id: "native-queue",
                    clientUserMessageId: (request.params as { clientUserMessageId: string })
                      .clientUserMessageId,
                  },
                }
              : request.method === "turn/steer"
                ? { turnId: "turn" }
                : {};
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const children: ChildProcess[] = [];
  const relay = vi.fn((command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
    expect(command).toBe("ssh");
    expect(args).toContain(fleet.ssh.host);
    expect(args).toContain("ControlMaster=no");
    expect(args).toContain("ControlPath=none");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).not.toContain("-N");
    expect(options.stdio).toEqual(["ignore", "pipe", "ignore"]);
    const binding = args[args.indexOf("-L") + 1]!;
    const ports = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/u.exec(binding)!;
    expect(Number(ports[2])).toBe(address.port);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const net=require('node:net');
        const server=net.createServer(front=>{
          const backend=net.connect({host:'127.0.0.1',port:Number(process.argv[2])},()=>{
            ${fixtureOptions.noTuple ? "" : "process.stdout.write('CLANKIE_CODEX_CONNECTION '+JSON.stringify({clientPort:backend.localPort,serverPort:Number(process.argv[2])" + (fixtureOptions.wrongTuple ? "+1" : "") + "})+'\\n');"}
            ${fixtureOptions.noHandshake ? "" : "front.pipe(backend).pipe(front);"}
          });
          front.on('error',()=>backend.destroy()); backend.on('error',()=>front.destroy());
          front.on('close',()=>backend.destroy()); backend.on('close',()=>front.destroy());
        });
        server.listen({host:'127.0.0.1',port:Number(process.argv[1])},()=>{
          ${fixtureOptions.noReady ? "" : "process.stdout.write('CLANKIE_CODEX_FORWARD_READY\\n');"}
        }); server.on('error',()=>process.exit(1));`,
        ports[1]!,
        ports[2]!,
      ],
      options,
    );
    children.push(child);
    return child;
  });
  // The fixture substitutes a test-owned TCP forward for SSH; the WebSocket handshake and bytes are real.
  cleanups.push(() => {
    for (const child of children) child.kill("SIGTERM");
  });
  const endpoint = `ws://127.0.0.1:${address.port}`;
  const connect: typeof openRemoteCodexConnection = (selected, selectedEndpoint) =>
    openRemoteCodexConnection(selected, selectedEndpoint, 1000, relay as unknown as typeof spawn);
  return { endpoint, connect, requests, relay };
}

function proof(endpoint: string): RemoteCodexControlProof {
  const started = "2026-10-04T00:00:00.0000001Z";
  return {
    fleet: "pc",
    pane: "w1:p1",
    terminalId: "term-one",
    sessionId: "thread",
    cwd: "C:\\fixture",
    nativeOccupantId: "native-one",
    binding: { socketPath: "C:\\herdr.sock", session: "default" },
    endpoint,
    listenEndpoint: "ws://127.0.0.1:0",
    homeHash: "a".repeat(64),
    shell: { pid: 10, startTime: started },
    foreground: { pid: 20, startTime: started },
    tui: { pid: 30, startTime: started, executable: "C:\\native\\codex.exe" },
    server: { pid: 40, startTime: started, executable: "C:\\native\\codex.exe" },
    chains: { tui: [], server: [] },
  };
}

it("preserves WebSocket bytes through the owned loopback forward and records its actual TCP tuple", async () => {
  const f = await fixture();
  const connection = await f.connect(fleet, f.endpoint);
  expect(connection?.connection).toMatchObject({
    clientPort: expect.any(Number),
    serverPort: Number(f.endpoint.split(":").at(-1)),
  });
  cleanups.push(() => connection?.close());
  const control = codexSocketControl(async () => connection?.socket, 1000);
  expect(await control("thread", 'message "quoted" & 100% 😀')).toMatchObject({
    outcome: "delivered",
    state: "steered",
  });
  expect(f.requests.find((request) => request.method === "turn/steer")).toMatchObject({
    params: {
      threadId: "thread",
      expectedTurnId: "turn",
      input: [{ type: "text", text: 'message "quoted" & 100% 😀' }],
    },
  });
});

it("checks the exact connected TCP tuple and complete fresh proof immediately before steering", async () => {
  const f = await fixture();
  const original = proof(f.endpoint);
  const observe = vi.fn(async () => original);
  const guard = vi.fn(async () => true);
  const control = remoteCodexControl(fleet, vi.fn(), vi.fn(), "pc/w1:p1", { observe, connect: f.connect });
  expect(await control("thread", "hello", undefined, undefined, guard)).toMatchObject({
    outcome: "delivered",
    state: "steered",
  });
  expect(observe.mock.calls).toEqual([
    ["pc", "w1:p1", "thread"],
    [
      "pc",
      "w1:p1",
      "thread",
      { clientPort: expect.any(Number), serverPort: Number(f.endpoint.split(":").at(-1)) },
    ],
  ]);
  expect(guard).toHaveBeenCalledTimes(2);
});

it.each(["server", "tui", "binding", "homeHash", "endpoint", "cwd"] as const)(
  "refuses changed %s proof after read-only preparation without a native write",
  async (field) => {
    const f = await fixture();
    const original = proof(f.endpoint);
    const changed = { ...structuredClone(original) };
    if (field === "server" || field === "tui")
      changed[field] = { ...changed[field], startTime: "2026-10-04T00:00:01.0000001Z" };
    else if (field === "binding")
      changed.binding = { ...changed.binding, socketPath: "C:\\replacement.sock" };
    else if (field === "homeHash") changed.homeHash = "b".repeat(64);
    else if (field === "endpoint") changed.endpoint = "ws://127.0.0.1:12345";
    else changed.cwd = "C:\\replacement";
    const observe = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(changed);
    const guard = vi.fn(async () => true);
    expect(
      await remoteCodexControl(fleet, vi.fn(), vi.fn(), "pc/w1:p1", { observe, connect: f.connect })(
        "thread",
        "hello",
        undefined,
        undefined,
        guard,
      ),
    ).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
    expect(f.requests.some((request) => request.method === "turn/steer")).toBe(false);
    expect(guard).toHaveBeenCalledOnce();
  },
);

it("rechecks native ownership after a yielding caller guard before writing", async () => {
  const f = await fixture();
  const original = proof(f.endpoint);
  let current = original;
  const observe = vi.fn(async () => current);
  const guard = vi.fn(async () => {
    await Promise.resolve();
    current = { ...original, homeHash: "b".repeat(64) };
    return true;
  });
  expect(
    await remoteCodexControl(fleet, vi.fn(), vi.fn(), "pc/w1:p1", { observe, connect: f.connect })(
      "thread",
      "hello",
      undefined,
      undefined,
      guard,
    ),
  ).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
  expect(f.requests.some((request) => request.method === "turn/steer")).toBe(false);
  expect(guard).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledTimes(2);
});

it("never connects when the current pane has no proven private native backend", async () => {
  const connect = vi.fn();
  expect(
    await remoteCodexControl(fleet, vi.fn(), vi.fn(), "pc/w1:p1", {
      observe: vi.fn(async () => undefined),
      connect,
    })("thread", "hello"),
  ).toBeUndefined();
  expect(connect).not.toHaveBeenCalled();
});

it("refuses a malformed connected tuple before any native RPC", async () => {
  const f = await fixture({ wrongTuple: true });
  expect(await f.connect(fleet, f.endpoint)).toBeUndefined();
  expect(f.requests).toEqual([]);
});

it.each([
  "ws://localhost:1234",
  "ws://127.0.0.1:0",
  "ws://127.0.0.1:1234/other",
  "ws://127.0.0.1:1234/?token=x",
  "wss://127.0.0.1:1234",
  "ws://127.0.0.1:65536",
])("refuses unsupported endpoint %s before any remote process", async (endpoint) => {
  const start = vi.fn();
  expect(await openRemoteCodexConnection(fleet, endpoint, 100, start)).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
});

it("retains uncertainty after a lost steering response on the selected connection", async () => {
  const f = await fixture({ lostReceipt: true });
  const observe = vi.fn(async () => proof(f.endpoint));
  expect(
    await remoteCodexControl(fleet, vi.fn(), vi.fn(), "pc/w1:p1", { observe, connect: f.connect })(
      "thread",
      "hello",
    ),
  ).toMatchObject({ outcome: "unconfirmed" });
  expect(f.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1);
});

it.each(["noReady", "noTuple", "noHandshake"] as const)(
  "bounds and closes an owned forward with %s without native RPC",
  async (failure) => {
    const f = await fixture({ [failure]: true });
    expect(await f.connect(fleet, f.endpoint)).toBeUndefined();
    expect(f.requests).toEqual([]);
  },
);

it("queues to the proven pane backend, preserving private home and the final authority fence", async () => {
  const f = await fixture();
  const original = proof(f.endpoint);
  const observe = vi.fn(async () => original);
  const shell = vi.fn();
  const guard = vi.fn(async () => true);
  const queue = remoteCodexQueue(fleet, shell, (pane) =>
    remoteCodexControl(fleet, shell, vi.fn(), pane, { observe, connect: f.connect, mode: "queue" }),
  );
  expect(await queue("thread", "Held until turn settles", guard, "pc/w1:p1")).toMatchObject({
    outcome: "delivered",
    state: "queued",
  });
  expect(guard).toHaveBeenCalledTimes(2);
  expect(shell.mock.calls).toEqual([
    [
      windowsProcessCommand({
        session: fleet.session,
        pane: "w1:p1",
        codexControl: true,
        codexDefaultHome: true,
      }),
      10_000,
    ],
  ]);
  expect(f.requests.find((r) => r.method === "initialize")).toMatchObject({
    params: { capabilities: { experimentalApi: true } },
  });
  expect(f.requests.filter((r) => r.method === "thread/queue/add")).toHaveLength(1);
  expect(f.requests.some((r) => r.method === "turn/steer")).toBe(false);
  expect(observe).toHaveBeenLastCalledWith("pc", "w1:p1", "thread", {
    clientPort: expect.any(Number),
    serverPort: Number(f.endpoint.split(":").at(-1)),
  });
});

it("refuses an unavailable proven private queue instead of falling through to the account home", async () => {
  const shell = vi.fn();
  const queue = remoteCodexQueue(fleet, shell, (pane) =>
    remoteCodexControl(fleet, shell, vi.fn(), pane, {
      observe: vi.fn(async () => proof("ws://127.0.0.1:12345")),
      connect: vi.fn(async () => undefined),
      mode: "queue",
    }),
  );
  expect(await queue("thread", "must not fall through", undefined, "pc/w1:p1")).toMatchObject({
    outcome: "undelivered",
    deliveryStage: "unavailable",
  });
  expect(shell.mock.calls).toEqual([
    [
      windowsProcessCommand({
        session: fleet.session,
        pane: "w1:p1",
        codexControl: true,
        codexDefaultHome: true,
      }),
      10_000,
    ],
  ]);
});

it("retains uncertainty for a lost private native queue receipt without the account queue", async () => {
  const f = await fixture({ lostReceipt: true });
  const shell = vi.fn();
  const queue = remoteCodexQueue(fleet, shell, (pane) =>
    remoteCodexControl(fleet, shell, vi.fn(), pane, {
      observe: vi.fn(async () => proof(f.endpoint)),
      connect: f.connect,
      mode: "queue",
    }),
  );
  expect(await queue("thread", "one native submission", undefined, "pc/w1:p1")).toMatchObject({
    outcome: "unconfirmed",
  });
  expect(f.requests.filter((r) => r.method === "thread/queue/add")).toHaveLength(1);
  expect(shell.mock.calls).toEqual([
    [
      windowsProcessCommand({
        session: fleet.session,
        pane: "w1:p1",
        codexControl: true,
        codexDefaultHome: true,
      }),
      10_000,
    ],
  ]);
});
