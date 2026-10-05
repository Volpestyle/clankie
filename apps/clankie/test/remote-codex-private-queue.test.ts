import { readFileSync } from "node:fs";
import { once } from "node:events";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createRemoteCodexControlObserver } from "../src/remote-project-proof.ts";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import { parseHerdrAgentResult, type HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { remoteCodexControl, remoteCodexQueue } from "../src/captain/remote-codex-app-server.ts";

const fleet = { id: "pc", session: "default", ssh: { host: "pc", shell: "powershell" as const } };
const raw = readFileSync(new URL("./fixtures/windows-codex-private-control.json", import.meta.url), "utf8");
const pane = "w8:pB";
const qualified = `${fleet.id}/${pane}`;
const sessionId = "01a10928-d878-7db2-82d0-643dce239a3f";
const cleanups: Array<() => Promise<void>> = [];
const finalAuthorityFailures = [
  "revoked authority",
  "late approval",
  "late rejection",
  "delayed approval",
] as const;
function finalAuthorityGuard(kind: (typeof finalAuthorityFailures)[number]) {
  let authorized = true;
  let calls = 0;
  let settle!: () => void;
  const delayed = new Promise<boolean>((resolve, reject) => {
    settle = () =>
      kind === "late rejection" ? reject(new Error("Late authority lookup failed")) : resolve(true);
  });
  return {
    beforeDispatch: vi.fn(async () => {
      if (++calls === 1 || kind === "revoked authority") return authorized;
      if (kind === "delayed approval") {
        // Timer callbacks cannot run while an authority implementation blocks.
        const deadline = performance.now() + 300;
        while (performance.now() < deadline) {}
        return true;
      }
      return delayed;
    }),
    revoke: () => {
      authorized = false;
    },
    release: () => {
      if (kind === "late approval" || kind === "late rejection") settle();
    },
  };
}
function scriptFromCommand(command: string) {
  const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
  const compressed = /\$bytes=\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(script)?.[1];
  return compressed ? gunzipSync(Buffer.from(compressed, "base64")).toString("utf8") : script;
}
function defaultHomePane() {
  const executable = "C:\\installed\\codex.exe";
  const markers = { pane, socketPath: "C:\\herdr.sock", homeHash: "a".repeat(64) };
  return {
    binding: { session: fleet.session, socketPath: markers.socketPath },
    info: { pane_id: pane, shell_pid: 10, foreground_process_group_id: 20 },
    agent: {
      pane_id: pane,
      terminal_id: "term_default",
      agent: "codex",
      agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: sessionId },
    },
    processes: [
      { pid: 10, parent: 999, startTime: "2026-10-03T10:00:00.000Z", executable: "C:\\Windows\\pwsh.exe" },
      { pid: 20, parent: 10, startTime: "2026-10-03T10:00:01.000Z", executable: "C:\\Windows\\cmd.exe" },
      { pid: 30, parent: 20, startTime: "2026-10-03T10:00:02.000Z", executable },
    ],
    nativeProcesses: [
      { pid: 30, executable, cwd: "C:\\repo", role: "tui", standalone: true, endpoint: null, markers },
    ],
    owners: [],
    installed: [executable],
    foregroundMarkers: { ...markers },
    defaultHomeHash: markers.homeHash as string | null,
  };
}
function queueShell(
  observations: () => { first: ReturnType<typeof defaultHomePane>; last: ReturnType<typeof defaultHomePane> },
) {
  const calls: string[] = [];
  const shell = vi.fn(async (command: string) => {
    const script = scriptFromCommand(command);
    calls.push(script);
    if (script.includes("Observe-ClankieProcess")) return JSON.stringify(observations());
    return script.includes("npm root -g") ? "C:\\npm\\codex.js" : "queued";
  });
  return { shell, calls };
}
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it("refuses queue when a proven private steer becomes idle and its native proof disappears", async () => {
  // The real Windows producer golden proves the initial custom-home backend.
  // A local native-protocol server substitutes only its WebSocket transport.
  let available = true;
  const observe = createRemoteCodexControlObserver({
    fleet: async (id) => (id === fleet.id ? fleet : undefined),
    shell: () => async () => {
      if (!available) throw new Error("Current Windows process facts unavailable");
      return raw;
    },
  });
  const initial = await observe(fleet.id, pane, sessionId);
  expect(initial).toBeDefined();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Test socket unavailable");
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const requests: string[] = [];
  let clientPort: number | undefined;
  server.on("connection", (socket, request) => {
    clientPort = request.socket.remotePort;
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as { id?: number; method: string };
      requests.push(request.method);
      if (request.method === "initialized") return;
      if (request.method === "thread/read") {
        // The private turn settled after proof and read-only connection setup.
        // The next proof fails; it cannot identify any account-default home.
        available = false;
        socket.send(
          JSON.stringify({ id: request.id, result: { thread: { id: sessionId, status: { type: "idle" } } } }),
        );
      } else socket.send(JSON.stringify({ id: request.id, result: {} }));
    });
  });
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}`);
    await once(socket, "open");
    if (clientPort === undefined) throw new Error("Test TCP client unavailable");
    return {
      socket,
      connection: { clientPort, serverPort: address.port },
      alive: () => socket.readyState === WebSocket.OPEN,
      close: () => socket.terminate(),
    };
  };
  let cliCalls = 0;
  const shell = async (command: string) => {
    if (scriptFromCommand(command).includes("Observe-ClankieProcess")) return raw;
    cliCalls++;
    throw new Error("Account-default CLI queue must not be reached");
  };
  const herdr = async () => "";
  const queue = remoteCodexQueue(fleet, shell, (target) =>
    remoteCodexControl(fleet, shell, herdr, target, { observe, connect, mode: "queue" }),
  );
  const snapshots = JSON.parse(raw) as { first: { agent: unknown } };
  const agent = parseHerdrAgentResult(JSON.stringify({ result: { agent: snapshots.first.agent } }));
  const delivery = createFleetSeatControl(
    { resolveTerminal: async () => ({ ...agent, paneId: qualified }) } as unknown as HerdrWatchRunner,
    new Map(),
    undefined,
    async (_fleet, thread, text, guard, target) => queue(thread, text, guard, target),
    (_fleet, target) => remoteCodexControl(fleet, shell, herdr, target, { observe, connect }),
  );
  expect(
    await delivery.deliverToSeat(qualified, "Deliver once to the original private thread"),
  ).toMatchObject({
    outcome: "undelivered",
    deliveryStage: "unavailable",
  });
  expect(requests).toEqual(["initialize", "initialized", "thread/read"]);
  expect(cliCalls).toBe(0);
});

it.each(
  (["queue", "steer"] as const).flatMap((mode) => finalAuthorityFailures.map((kind) => ({ mode, kind }))),
)("refuses private $mode after the final SSH observation with $kind", async ({ mode, kind }) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Test socket unavailable");
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  type Snapshot = {
    owners: number[];
    nativeProcesses: Array<{ pid: number; role: string; endpoint: string; listeners?: { port: number }[] }>;
  };
  const snapshots = JSON.parse(raw) as { first: Snapshot; last: Snapshot };
  for (const snapshot of [snapshots.first, snapshots.last]) {
    const backend = snapshot.nativeProcesses.find((native) => native.role === "server")!;
    backend.listeners![0]!.port = address.port;
    snapshot.nativeProcesses.find((native) => native.role === "tui")!.endpoint =
      `ws://127.0.0.1:${address.port}`;
    snapshot.owners = [backend.pid];
  }
  const requests: string[] = [];
  let clientPort: number | undefined;
  let effects = 0;
  server.on("connection", (socket, request) => {
    clientPort = request.socket.remotePort;
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as {
        id?: number;
        method: string;
        params?: { clientUserMessageId?: string };
      };
      requests.push(request.method);
      if (request.method === "initialized") return;
      let result: unknown = {};
      if (request.method === "thread/read")
        result = { thread: { id: sessionId, status: { type: "active" } } };
      if (request.method === "thread/turns/list")
        result = { data: [{ id: "held-turn", status: "inProgress" }] };
      if (request.method === "thread/queue/add") {
        effects++;
        result = {
          queuedSubmission: { id: "queued-once", clientUserMessageId: request.params?.clientUserMessageId },
        };
      }
      if (request.method === "turn/steer") {
        effects++;
        result = { turnId: "held-turn" };
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    if (clientPort === undefined) throw new Error("Test TCP client unavailable");
    return {
      socket,
      connection: { clientPort, serverPort: address.port },
      alive: () => socket.readyState === WebSocket.OPEN,
      close: () => socket.terminate(),
    };
  };
  let announceProbe!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    announceProbe = resolve;
  });
  let releaseProbe!: () => void;
  const probeReleased = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let probes = 0;
  const shell = async (command: string) => {
    expect(scriptFromCommand(command)).toContain("Observe-ClankieProcess");
    if (++probes === 2) {
      announceProbe();
      await probeReleased;
    }
    return JSON.stringify(snapshots);
  };
  const authority = finalAuthorityGuard(kind);
  const beforeDispatch = authority.beforeDispatch;
  const pending = remoteCodexControl(fleet, shell, async () => "", qualified, { connect, mode })(
    sessionId,
    "revoked private dispatch",
    undefined,
    undefined,
    beforeDispatch,
  );
  try {
    await probeStarted;
    expect(beforeDispatch).toHaveBeenCalledOnce();
    if (kind === "revoked authority") authority.revoke();
    const started = performance.now();
    releaseProbe();
    const result = await pending;
    expect(result).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
    if (kind !== "revoked authority") {
      expect(result).toMatchObject({ detail: expect.stringContaining("timed out") });
      expect(performance.now() - started).toBeLessThan(1_500);
    }
  } finally {
    releaseProbe();
    authority.release();
  }
  // Late guard settlement must never resume native dispatch.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(beforeDispatch).toHaveBeenCalledTimes(2);
  expect(effects).toBe(0);
  expect(requests).toEqual([
    "initialize",
    "initialized",
    "thread/read",
    ...(mode === "steer" ? ["thread/turns/list"] : []),
  ]);
});

it.each(["missing control", "unavailable proof"])(
  "refuses %s for a targeted Windows queue before account CLI discovery",
  async (kind) => {
    let cliCalls = 0;
    const shell = async () => {
      cliCalls++;
      return "{}";
    };
    const queue = remoteCodexQueue(
      fleet,
      shell,
      kind === "missing control" ? undefined : () => async () => undefined,
    );
    expect(await queue(sessionId, "unproven queue", undefined, qualified)).toMatchObject({
      outcome: "undelivered",
      deliveryStage: "unavailable",
    });
    // A fresh read-only probe is allowed; CLI discovery and dispatch are not.
    expect(cliCalls).toBe(1);
  },
);

it("queues a hired --no-daemon pane through SSH CLI only after fresh default-home proof and final authority", async () => {
  const observation = defaultHomePane();
  const { shell, calls } = queueShell(() => ({ first: observation, last: observation }));
  const privateQueue = vi.fn();
  const beforeDispatch = vi.fn(async () => true);
  expect(
    await remoteCodexQueue(fleet, shell, privateQueue)(sessionId, "queue once", beforeDispatch, qualified),
  ).toBe(true);
  expect(calls).toHaveLength(4);
  expect(calls[0]).toContain("[Environment+SpecialFolder]::UserProfile");
  expect(calls[0]).toContain("[ClankieProcess]::Markers([int]$PID).homeHash -ceq $defaultHash");
  expect(calls[1]).toContain("npm root -g");
  expect(calls[2]).toContain("Observe-ClankieProcess");
  const commandLine = Buffer.from(/FromBase64String\('([^']+)'\)/u.exec(calls[3]!)![1]!, "base64").toString(
    "utf8",
  );
  expect(commandLine).toBe(`C:\\npm\\codex.js queue --thread ${sessionId} --message "queue once"`);
  expect(beforeDispatch).toHaveBeenCalledTimes(2);
  expect(privateQueue).not.toHaveBeenCalled();
});

it.each(finalAuthorityFailures)(
  "refuses CLI queue after the final default-home SSH observation with %s",
  async (kind) => {
    const observation = defaultHomePane();
    let announceProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      announceProbe = resolve;
    });
    let releaseProbe!: () => void;
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let probes = 0;
    let effects = 0;
    const calls: string[] = [];
    const shell = async (command: string) => {
      const script = scriptFromCommand(command);
      calls.push(script);
      if (script.includes("Observe-ClankieProcess")) {
        if (++probes === 2) {
          announceProbe();
          await probeReleased;
        }
        return JSON.stringify({ first: observation, last: observation });
      }
      if (script.includes("npm root -g")) return "C:\\npm\\codex.js";
      effects++;
      return "queued";
    };
    const privateQueue = vi.fn();
    const authority = finalAuthorityGuard(kind);
    const beforeDispatch = authority.beforeDispatch;
    const pending = remoteCodexQueue(fleet, shell, privateQueue)(
      sessionId,
      "revoked queue",
      beforeDispatch,
      qualified,
    );
    try {
      await probeStarted;
      expect(beforeDispatch).toHaveBeenCalledOnce();
      if (kind === "revoked authority") authority.revoke();
      const started = performance.now();
      releaseProbe();
      const result = await pending;
      expect(result).toMatchObject({
        outcome: "undelivered",
        deliveryStage: "unavailable",
        detail: expect.stringContaining("authority"),
      });
      if (kind !== "revoked authority") {
        expect(result).toMatchObject({ detail: expect.stringContaining("timed out") });
        expect(performance.now() - started).toBeLessThan(1_500);
      }
    } finally {
      releaseProbe();
      authority.release();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(beforeDispatch).toHaveBeenCalledTimes(2);
    expect(effects).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)).toContain("Observe-ClankieProcess");
    expect(privateQueue).not.toHaveBeenCalled();
  },
);

it.each([
  "private home",
  "unknown SSH home",
  "missing markers",
  "wrong pane",
  "wrong session",
  "unclassified TUI",
  "reused PID",
])("refuses a targeted CLI queue with %s", async (kind) => {
  const observation = defaultHomePane();
  if (kind === "private home") observation.defaultHomeHash = "b".repeat(64);
  if (kind === "unknown SSH home") observation.defaultHomeHash = null;
  if (kind === "missing markers") observation.nativeProcesses[0]!.markers.homeHash = "";
  if (kind === "wrong pane") observation.info.pane_id = "w9:pC";
  if (kind === "wrong session") observation.agent.agent_session.value = "other-thread";
  if (kind === "unclassified TUI") observation.nativeProcesses[0]!.role = "unavailable";
  if (kind === "reused PID") observation.processes[1]!.startTime = "2026-10-03T10:00:03.000Z";
  const { shell, calls } = queueShell(() => ({ first: observation, last: observation }));
  expect(await remoteCodexQueue(fleet, shell)(sessionId, "do not queue", undefined, qualified)).toMatchObject(
    {
      outcome: "undelivered",
      deliveryStage: "unavailable",
    },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("Observe-ClankieProcess");
});

it.each(["home", "session", "PID", "proof disappears"])(
  "refuses a changed %s after the authority guard yields",
  async (kind) => {
    let observation = defaultHomePane();
    const { shell, calls } = queueShell(() => ({ first: observation, last: observation }));
    const beforeDispatch = async () => {
      observation = structuredClone(observation);
      if (kind === "home") {
        observation.nativeProcesses[0]!.markers.homeHash = "b".repeat(64);
        observation.foregroundMarkers.homeHash = "b".repeat(64);
        observation.defaultHomeHash = "b".repeat(64);
      }
      if (kind === "session") observation.agent.agent_session.value = "replacement";
      if (kind === "PID") observation.processes[2]!.startTime = "2026-10-03T10:00:02.0000001Z";
      if (kind === "proof disappears") observation.defaultHomeHash = null;
      return true;
    };
    expect(
      await remoteCodexQueue(fleet, shell)(sessionId, "do not queue", beforeDispatch, qualified),
    ).toMatchObject({
      outcome: "undelivered",
      deliveryStage: "unavailable",
    });
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)).toContain("Observe-ClankieProcess");
  },
);

it("refuses a pane whose native lifetime changes within the fresh default-home probe", async () => {
  const first = defaultHomePane();
  const last = structuredClone(first);
  last.processes[2]!.startTime = "2026-10-03T10:00:02.0000001Z";
  const { shell, calls } = queueShell(() => ({ first, last }));
  expect(await remoteCodexQueue(fleet, shell)(sessionId, "do not queue", undefined, qualified)).toMatchObject(
    {
      outcome: "undelivered",
      deliveryStage: "unavailable",
    },
  );
  expect(calls).toHaveLength(1);
});

it.each(["unconfirmed", "undelivered"] as const)(
  "never replaces a private native %s receipt with CLI queueing",
  async (outcome) => {
    const observation = defaultHomePane();
    observation.defaultHomeHash = "b".repeat(64);
    const { shell, calls } = queueShell(() => ({ first: observation, last: observation }));
    const result = { outcome, detail: "Native queue receipt" };
    const privateQueue = vi.fn(() => async () => result);
    expect(
      await remoteCodexQueue(fleet, shell, privateQueue)(sessionId, "deliver once", undefined, qualified),
    ).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(privateQueue).toHaveBeenCalledOnce();
  },
);
