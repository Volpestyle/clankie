import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach } from "vitest";
import type { SeatControl } from "@clankie/agent-hosts";
import { createPrimeSeatAdapter } from "../../src/captain/prime-seat-adapter.ts";
import { createCodexSeatAdapter } from "../../src/captain/codex-seat-adapter.ts";
import { createClaudeWorkerSeatAdapter, SeatHookLog } from "../../src/captain/claude-worker-seat.ts";
import { SeatOutbox } from "../../src/captain/seat-outbox.ts";
import type { HerdrSeatTranscript } from "../../src/captain/herdr-transcript.ts";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function scratch(name: string) {
  const root = await mkdtemp(join(tmpdir(), name));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
const unsettled = async () => ({
  type: "settlement_unconfirmed" as const,
  at: new Date().toISOString(),
  reason: "message_correlation_unavailable" as const,
});
/** Arm only inside the actual send, not earlier discovery/status reads. */
function admissionProbe(control: SeatControl, setHook: (hook: () => Promise<void>) => void) {
  let sending = false,
    hook = async () => {};
  setHook(async () => {
    if (sending) {
      const next = hook;
      hook = async () => {};
      await next();
    }
  });
  const send = control.send.bind(control);
  control.send = async (...args) => {
    sending = true;
    try {
      return await send(...args);
    } finally {
      sending = false;
    }
  };
  return (next: () => Promise<void>) => {
    hook = next;
  };
}

export async function primeReceiptFixture() {
  const root = await scratch("receipt-prime-"),
    socketPath = join(root, "daemon.sock"),
    sessionId = randomUUID(),
    activeSessionId = "native-active";
  let admitted = 0,
    hook = async () => {};
  const sockets = new Set<Socket>();
  const summary = {
    activeSessionId,
    sessionId,
    cwd: root,
    lifecycle: "running",
    activity: "idle",
    attachedClients: 1,
    workerPid: process.pid,
    workerInstanceId: "fixture-native-instance",
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write(
      JSON.stringify({
        type: "daemon_hello",
        protocol: { name: "prime-agent.daemon", version: 7 },
        appVersion: "fixture",
      }) + "\n",
    );
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          frame = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (frame.command.type === "prompt") admitted++;
        socket.write(
          JSON.stringify({
            type: "response",
            id: frame.id,
            command: frame.command.type,
            success: true,
            data: ["create", "get_state"].includes(frame.command.type) ? summary : {},
          }) + "\n",
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const proof = {
    nativeOccupantId: "fixture-prime",
    pane: "fixture-pane",
    fleet: "default",
    binding: { socketPath: join(root, "herdr.sock") },
    processes: [{ pid: process.pid, startTime: "1" }],
    shell: { pid: process.pid, startTime: "1" },
  };
  const native = {
    capture: async () => ({
      paneId: "fixture-pane",
      terminalId: "fixture-seat",
      process: proof.shell,
      verifyAllocation: async () => {},
      check: async () => true,
      proof: async () => {
        await hook();
        return proof;
      },
      report: async () => {},
    }),
    createCommandTab: async () => "fixture-pane",
    register: () => () => {},
    session: () => undefined,
    allows: async () => true,
  };
  const adapter = createPrimeSeatAdapter({
    repoRoot: root,
    stateDir: root,
    native,
    install: async () => ({
      launcher: process.execPath,
      executable: process.execPath,
      version: "fixture",
      socketPath,
      agentDir: root,
      env: {},
    }),
  });
  const prepared = await adapter.prepare!({ harness: "prime", cwd: root, brief: "" });
  cleanup.push(() => prepared.dispose());
  const started = await prepared.start({ paneId: "fixture-pane", name: "fixture", run: async () => {} });
  if (started.outcome !== "started") throw new Error(JSON.stringify(started));
  const control = started.control;
  const beforeMutation = admissionProbe(control, (next) => {
    hook = next;
  });
  return { control, admitted: () => admitted, beforeMutation };
}

export async function codexReceiptFixture() {
  const root = await scratch("receipt-codex-"),
    sessionId = randomUUID();
  let admitted = 0,
    hook = async () => {};
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("No fixture address");
  cleanup.push(async () => {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const methods: string[] = [];
  server.on("connection", (peer) =>
    peer.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString());
      methods.push(request.method);
      if (request.id === undefined) return;
      if (["turn/start", "turn/steer", "thread/queue/add"].includes(request.method)) admitted++;
      const result =
        request.method === "hooks/list"
          ? { data: [{ cwd: root, hooks: [], errors: [] }] }
          : request.method === "thread/loaded/list"
            ? { data: [sessionId] }
            : request.method === "thread/read"
              ? { thread: { id: sessionId, cwd: root, status: { type: "idle" } } }
              : request.method === "thread/resume"
                ? { thread: { id: sessionId, turns: [] } }
                : request.method === "turn/start"
                  ? { turn: { id: randomUUID() } }
                  : request.method === "turn/steer"
                    ? { turnId: randomUUID() }
                    : {};
      peer.send(JSON.stringify({ id: request.id, result }));
    }),
  );
  const adapter = createCodexSeatAdapter({
    trackerOverrides: async () => [],
    herdr: async () => undefined,
    nativePolicy: () => ({
      connected: async () => {},
      audit: async () => {},
      failed: async () => {},
      beforeTurn: async () => {
        await hook();
      },
    }),
    server: async () => ({
      endpoint: "fixture",
      failure: () => undefined,
      output: () => "",
      close: async () => {},
      connect: async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
        await once(socket, "open");
        return socket;
      },
    }),
  });
  const started = await adapter.start(
    { harness: "codex", cwd: root, brief: "" },
    { paneId: "fixture-pane", name: "fixture", run: async () => {} },
  );
  if (started.outcome !== "started") throw new Error(JSON.stringify(started));
  cleanup.push(() => started.control.close());
  return {
    control: started.control,
    methods,
    admitted: () => admitted,
    beforeMutation: admissionProbe(started.control, (next) => {
      hook = next;
    }),
  };
}

export async function claudeReceiptFixture() {
  const root = await scratch("receipt-claude-"),
    sessionId = randomUUID();
  await mkdir(root, { recursive: true });
  const hooks = new SeatHookLog(join(root, "native-hooks.json"));
  hooks.record("fixture-pane", { schemaVersion: 1, event: "SessionStart", sessionId });
  const entries: HerdrSeatTranscript["entries"][number][] = [];
  let admitted = 0,
    hook = async () => {};
  const outbox = new SeatOutbox({
    explicitAcknowledgments: false,
    uncertaintyPath: join(root, "outbox.json"),
  });
  cleanup.push(() => outbox.close());
  let stopped = false;
  const polling = (async () => {
    while (!stopped) {
      const events = await outbox.poll(1000);
      for (const event of events)
        entries.push({
          type: "message",
          id: event.id,
          role: "operator",
          text: `<channel source="clankie-worker">\n${event.content}\n</channel>`,
        });
    }
  })();
  cleanup.push(async () => {
    stopped = true;
    outbox.close();
    await polling;
  });
  const adapter = createClaudeWorkerSeatAdapter({
    hooks,
    consent: async () => ({ approved: true }),
    agent: async () => ({
      paneId: "fixture-pane",
      terminalId: "fixture-seat",
      status: "idle",
      session: { kind: "id", value: sessionId },
    }),
    transcript: async () => ({ sessionKey: sessionId, entries: [...entries] }),
    prepareMessage: async (text) => {
      await hook();
      return { text, remove: async () => {} };
    },
    mailbox: {
      bound: () => outbox.bound(),
      deliver: (_seat, text) => {
        admitted++;
        const delivery = outbox.deliver({
          kind: "message",
          conversationId: "receipt-conversation",
          source: "captain",
          content: text,
          wantsReply: false,
        });

        return delivery.then((result) => result.outcome === "delivered");
      },
    },
    timing: { receiptMs: 500, pollMs: 5 },
  });
  const control = await adapter.attach!({ harness: "claude", paneId: "fixture-pane", sessionId });
  if (!control) throw new Error("Native Claude control did not attach");
  return {
    control,
    admitted: () => admitted,
    beforeMutation: admissionProbe(control, (next) => {
      hook = next;
    }),
  };
}

/** Existing-seat socket paths have discovery RPCs but no later positive permission replies. */
export async function externalCodexReceiptFixture(mode: "queue" | "steer", remote = false) {
  const sessionId = randomUUID(),
    turnId = randomUUID();
  let admitted = 0,
    hook = async () => {},
    sending = false;
  const { codexSocketControl } = await import("../../src/captain/external-codex-control.ts");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("No fixture address");
  cleanup.push(async () => {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.on("connection", (peer) =>
    peer.on("message", (bytes) => {
      void (async () => {
        const frame = JSON.parse(bytes.toString());
        if (frame.id === undefined) return;
        if (
          !remote &&
          sending &&
          (mode === "queue" ? frame.method === "thread/read" : frame.method === "thread/turns/list")
        ) {
          const next = hook;
          hook = async () => {};
          await next();
        }
        if (["thread/queue/add", "turn/steer"].includes(frame.method)) admitted++;
        const result =
          frame.method === "thread/read"
            ? { thread: { id: sessionId, status: { type: mode === "queue" ? "idle" : "active" } } }
            : frame.method === "thread/turns/list"
              ? { data: [{ id: turnId, status: "inProgress" }] }
              : frame.method === "thread/queue/add"
                ? {
                    queuedSubmission: {
                      id: randomUUID(),
                      clientUserMessageId: frame.params.clientUserMessageId,
                    },
                  }
                : frame.method === "turn/steer"
                  ? { turnId }
                  : {};
        peer.send(JSON.stringify({ id: frame.id, result }));
      })();
    }),
  );
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    return socket;
  };
  const { remoteCodexControl } = await import("../../src/captain/remote-codex-app-server.ts");
  const life = { pid: process.pid, startTime: "fixture-birth", executable: process.execPath };
  const proof = {
    fleet: "loopback",
    pane: "w1:p1",
    terminalId: "fixture-seat",
    sessionId,
    nativeOccupantId: "fixture-native",
    binding: { socketPath: "fixture-herdr", session: "default" },
    endpoint: "ws://127.0.0.1:12345",
    listenEndpoint: "ws://127.0.0.1:12345",
    homeHash: "a".repeat(64),
    cwd: "fixture",
    shell: life,
    foreground: life,
    tui: life,
    server: life,
    chains: { tui: [], server: [] },
  };
  const noPc = async (): Promise<never> => {
    throw new Error("No PC or SSH call is permitted in this loopback proof");
  };
  const native = remote
    ? remoteCodexControl(
        { id: "loopback", session: "default", ssh: { host: "unused.invalid", shell: "powershell" } },
        noPc,
        noPc,
        "loopback/w1:p1",
        {
          mode,
          observe: async (_fleet, _pane, _session, connection) => {
            if (connection) {
              const next = hook;
              hook = async () => {};
              await next();
            }
            return proof;
          },
          connect: async () => {
            const socket = await connect();
            return {
              socket,
              connection: { clientPort: 12346, serverPort: 12345 },
              alive: () => socket.readyState === WebSocket.OPEN,
              close: () => socket.terminate(),
            };
          },
        },
      )
    : codexSocketControl(connect, 2000, mode);
  const control: SeatControl = {
    ref: { harness: "codex", sessionId, paneId: "fixture-pane" },
    status: async () => "idle",
    interrupt: async () => false,
    close: async () => {},
    settled: unsettled,
    send: async (text, options) => {
      sending = true;
      try {
        const result = await native(sessionId, text, undefined, undefined, options?.beforeDispatch);
        if (result?.outcome === "delivered")
          return {
            outcome: "accepted",
            state: result.state ?? "started",
            deliveryStage: result.deliveryStage ?? "consumed",
            messageId: result.messageId ?? "fixture-native-input",
          };
        return {
          outcome: "offline",
          deliveryStage: "unavailable",
          detail: "Original native control refused admission",
        };
      } finally {
        sending = false;
      }
    },
  };
  return {
    control,
    admitted: () => admitted,
    beforeMutation: (next: () => Promise<void>) => {
      hook = next;
    },
  };
}
