import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerClient, type CodexSeatEvent } from "../src/captain/codex-app-server.ts";
import { codexSocketControl } from "../src/captain/external-codex-control.ts";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import type { ExternalCodexControl } from "../src/captain/external-codex-control.ts";

const execFileAsync = promisify(execFile);

// Explicit installed-binary integration lane, never a model eval or a cloud call:
// VUH-1563 native Windows acceptance is James's PC-only run, not a worker gate.
// This installed Codex lane alone does not exercise the C# kernel argv producer.
// CODEX_APP_SERVER_INTEGRATION=1 pnpm exec vitest run --config vitest.config.ts \
//   apps/clankie/test/pc-codex-steering.integration.test.ts
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

type RpcMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
type ProviderRequest = { body: Record<string, unknown>; response: ServerResponse; id: string };

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing owned native port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function sse(response: ServerResponse, event: Record<string, unknown>): void {
  response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/** Only HTTP model transport is substituted; all app-server state and RPC are native. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-native-codex-steering-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  const userHome = join(root, "user");
  const cwd = join(root, "workspace");
  await Promise.all([codexHome, userHome, cwd].map((path) => mkdir(path)));
  const providerRequests: ProviderRequest[] = [];
  const forbiddenRequests: string[] = [];
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses" || request.headers.authorization) {
      forbiddenRequests.push(`${request.method} ${request.url}`);
      response.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const id = `fixture-response-${providerRequests.length + 1}`;
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    providerRequests.push({ body, response, id });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sse(response, { type: "response.created", response: { id } });
    // The stream deliberately stays open until the test settles the native turn.
  });
  provider.on("connect", (request, socket) => {
    forbiddenRequests.push(`CONNECT ${request.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === "string")
    throw new Error("Missing fixture provider port");
  const providerUrl = `http://127.0.0.1:${providerAddress.port}`;
  await writeFile(
    join(codexHome, "config.toml"),
    [
      'model = "gpt-5.4"',
      'model_provider = "fixture"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'web_search = "disabled"',
      'cli_auth_credentials_store = "file"',
      'mcp_oauth_credentials_store = "file"',
      "check_for_update_on_startup = false",
      "[features]",
      "shell_snapshot = false",
      "plugins = false",
      "apps = false",
      "remote_plugin = false",
      "recommended_plugins = false",
      "[analytics]",
      "enabled = false",
      "[model_providers.fixture]",
      'name = "Owned deterministic Responses transport"',
      `base_url = "${providerUrl}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "",
    ].join("\n"),
  );
  const token = randomUUID();
  const tokenFile = join(root, "native-token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const endpoint = `ws://127.0.0.1:${await freePort()}`;
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: userHome,
    USERPROFILE: userHome,
    CODEX_HOME: codexHome,
    TMPDIR: root,
    LANG: "en_US.UTF-8",
    // Any attempted non-loopback HTTP traffic is refused and fails the test.
    HTTP_PROXY: providerUrl,
    HTTPS_PROXY: providerUrl,
    ALL_PROXY: providerUrl,
    NO_PROXY: "127.0.0.1,localhost",
  };
  const child = spawn(
    "codex",
    ["app-server", "--listen", endpoint, "--ws-auth", "capability-token", "--ws-token-file", tokenFile],
    {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Deliberately construct the child environment instead of inheriting credentials,
      // model endpoints, user configuration, plugins, MCP servers or agent sessions.
      env: environment,
    },
  );
  cleanups.push(() => stopChild(child));
  let logs = "";
  child.stdout?.on("data", (bytes) => (logs += String(bytes)));
  child.stderr?.on("data", (bytes) => (logs += String(bytes)));
  let launchError: Error | undefined;
  child.once("error", (error) => (launchError = error));
  const connect = () => new WebSocket(endpoint, { headers: { authorization: `Bearer ${token}` } });
  let native: WebSocket | undefined;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Native app-server exited: ${logs}`);
    const candidate = connect();
    try {
      await new Promise<void>((resolve, reject) => {
        candidate.once("open", resolve);
        candidate.once("error", reject);
      });
      native = candidate;
      break;
    } catch {
      candidate.terminate();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!native) throw new Error(`Native app-server startup timed out: ${logs}`);
  const events: CodexSeatEvent[] = [];
  const client = new CodexAppServerClient(native, (event) => events.push(event), 10_000);
  cleanups.push(async () => client.close());
  await client.initialize();
  const started = (await client.request("thread/start", {
    cwd,
    model: "gpt-5.4",
    modelProvider: "fixture",
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions: "Use only this deterministic integration fixture.",
  })) as { thread: { id: string } };
  const threadId = started.thread.id;

  // A transparent local transport proxy records/faults replies from the REAL
  // app-server. It never synthesizes state, turn IDs or mutation receipts.
  const proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => proxy.once("listening", resolve));
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Missing fixture proxy port");
  const rpcRequests: RpcMessage[] = [];
  const queueReplies: RpcMessage[] = [];
  let dropSteerReply = false;
  let dropQueueReply = false;
  let beforeTurnsReply: (() => Promise<void>) | undefined;
  let beforeReadReply: (() => Promise<void>) | undefined;
  const upstreams = new Set<WebSocket>();
  proxy.on("connection", (socket) => {
    const upstream = connect();
    upstreams.add(upstream);
    const pending: string[] = [];
    const methods = new Map<number, string>();
    socket.on("message", (bytes) => {
      const text = bytes.toString();
      const message = JSON.parse(text) as RpcMessage;
      rpcRequests.push(message);
      if (message.id !== undefined && message.method) methods.set(message.id, message.method);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else pending.push(text);
    });
    upstream.once("open", () => {
      for (const text of pending.splice(0)) upstream.send(text);
    });
    upstream.on("message", async (bytes) => {
      const message = JSON.parse(bytes.toString()) as RpcMessage;
      const method = message.id === undefined ? undefined : methods.get(message.id);
      if (method === "thread/read") await beforeReadReply?.();
      if (method === "thread/turns/list") await beforeTurnsReply?.();
      if (method === "turn/steer" && dropSteerReply) return;
      if (method === "thread/queue/add") {
        queueReplies.push(message);
        if (dropQueueReply) return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(bytes.toString());
    });
    upstream.on("error", () => socket.close());
    socket.once("close", () => upstream.close());
  });
  cleanups.push(async () => {
    for (const socket of proxy.clients) socket.terminate();
    for (const socket of upstreams) socket.terminate();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  const control = codexSocketControl(async () => new WebSocket(`ws://127.0.0.1:${proxyAddress.port}`), 1000);
  const queueControl = codexSocketControl(
    async () => new WebSocket(`ws://127.0.0.1:${proxyAddress.port}`),
    1000,
    "queue",
  );
  const start = async (text = "Initial fixture input", params: Record<string, unknown> = {}) => {
    const result = (await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...params,
    })) as { turn: { id: string } };
    await expect.poll(() => providerRequests.length).toBeGreaterThan(0);
    return result.turn.id;
  };
  const complete = (index: number, output?: Record<string, unknown>) => {
    const request = providerRequests[index];
    if (!request) throw new Error(`No fixture response ${index}`);
    sse(request.response, {
      type: "response.output_item.done",
      item: output ?? {
        type: "message",
        role: "assistant",
        id: `fixture-message-${index}`,
        content: [{ type: "output_text", text: "Fixture turn settled." }],
      },
    });
    sse(request.response, {
      type: "response.completed",
      response: {
        id: request.id,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
    request.response.end();
  };
  const queueCalls: string[] = [];
  const fleet = (nativeControl: ExternalCodexControl = control) => {
    const rawAgent = {
      pane_id: "owned/w1:p1",
      terminal_id: "owned/terminal",
      agent: "codex",
      agent_status: "working",
      title: "Owned native integration session",
      agent_session: { source: "herdr:codex", kind: "id", value: threadId },
      cwd,
    };
    // Substitute only the external Herdr/SSH observations and CLI launch; the
    // public fleet dispatcher, native control, queue and receipt fence are real.
    const runner = createHerdrWatchRunner(
      () => true,
      async (args) => {
        if (args[0] === "agent" && args[1] === "get") return JSON.stringify({ result: { agent: rawAgent } });
        if (args[0] === "pane" && args[1] === "list")
          return JSON.stringify({ result: { panes: [rawAgent] } });
        throw new Error(`Unexpected external Herdr command: ${args.join(" ")}`);
      },
    );
    return createFleetSeatControl(
      runner,
      new Map(),
      undefined,
      async (_fleet, sessionId, text, beforeDispatch) => {
        if (beforeDispatch && !(await beforeDispatch())) return false;
        queueCalls.push(text);
        await execFileAsync(
          "codex",
          [
            "queue",
            "--remote",
            endpoint,
            "--remote-auth-token-env",
            "FIXTURE_CODEX_TOKEN",
            "--thread",
            sessionId,
            "--message",
            text,
          ],
          { cwd, env: { ...environment, FIXTURE_CODEX_TOKEN: token }, timeout: 5000 },
        );
        return true;
      },
      () => nativeControl,
      join(root, "fleet-delivery-receipts.json"),
    );
  };
  return {
    root,
    threadId,
    client,
    control,
    queueControl,
    start,
    complete,
    events,
    providerRequests,
    forbiddenRequests,
    rpcRequests,
    queueReplies,
    fleet,
    queueCalls,
    setDropSteerReply: (drop: boolean) => (dropSteerReply = drop),
    setDropQueueReply: (drop: boolean) => (dropQueueReply = drop),
    setBeforeTurnsReply: (before: () => Promise<void>) => (beforeTurnsReply = before),
    setBeforeReadReply: (before: () => Promise<void>) => (beforeReadReply = before),
    logs: () => logs,
  };
}

describe.skipIf(process.env.CODEX_APP_SERVER_INTEGRATION !== "1")("installed Codex native steering", () => {
  it("steers the exact active native turn through production control and real Responses streaming", async () => {
    const f = await fixture();
    const turnId = await f.start();
    expect(await f.fleet().deliverToSeat("owned/terminal", "Native steering proof")).toMatchObject({
      outcome: "delivered",
      state: "steered",
    });
    expect(f.rpcRequests.filter((request) => request.method === "turn/steer")).toMatchObject([
      { params: { threadId: f.threadId, expectedTurnId: turnId } },
    ]);
    expect(f.rpcRequests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/read",
      "thread/turns/list",
      "turn/steer",
    ]);
    f.complete(0);
    await expect.poll(() => f.providerRequests.length).toBe(2);
    expect(JSON.stringify(f.providerRequests[1]!.body.input)).toContain("Native steering proof");
    f.complete(1);
    await expect.poll(() => f.events.some((event) => event.method === "turn/completed")).toBe(true);
    expect(f.forbiddenRequests).toEqual([]);
    expect(f.queueCalls).toEqual([]);
  }, 30_000);

  it("leaves an idle native thread untouched and permits the existing native queue", async () => {
    const f = await fixture();
    expect(await f.control(f.threadId, "Idle control cannot steer")).toBeUndefined();
    expect(f.rpcRequests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/read",
    ]);
    expect(f.providerRequests).toEqual([]);
    const dispatcher = f.fleet();
    expect(await dispatcher.deliverToSeat("owned/terminal", "Idle queued native input")).toMatchObject({
      outcome: "delivered",
      state: "queued",
    });
    expect(f.queueCalls).toEqual(["Idle queued native input"]);
    await expect.poll(() => f.providerRequests.length).toBe(1);
    expect(JSON.stringify(f.providerRequests[0]!.body.input)).toContain("Idle queued native input");
    f.complete(0);
    expect(f.rpcRequests.some((request) => request.method === "turn/steer")).toBe(false);
    expect(f.forbiddenRequests).toEqual([]);
  }, 30_000);

  it("keeps a queued native prompt pending until the original turn settles", async () => {
    const f = await fixture();
    const original = await f.start();
    // A host observer found no owned steering transport. Native queue remains
    // the one existing route; its implementation is the installed Codex CLI.
    const dispatcher = f.fleet(codexSocketControl(async () => undefined));
    expect(await dispatcher.deliverToSeat("owned/terminal", "Queued after original settles")).toMatchObject({
      outcome: "delivered",
      state: "queued",
    });
    expect(f.queueCalls).toEqual(["Queued after original settles"]);
    const turns = (await f.client.request("thread/turns/list", {
      threadId: f.threadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    })) as { data: Array<{ id: string; status: string }> };
    expect(turns.data[0]).toMatchObject({ id: original, status: "inProgress" });
    expect(f.providerRequests).toHaveLength(1);
    expect(JSON.stringify(f.providerRequests[0]!.body.input)).not.toContain("Queued after original settles");
    f.complete(0);
    await expect.poll(() => f.providerRequests.length).toBe(2);
    expect(JSON.stringify(f.providerRequests[1]!.body.input)).toContain("Queued after original settles");
    f.complete(1);
    expect(f.forbiddenRequests).toEqual([]);
  }, 30_000);

  it("refuses revoked authority after real native discovery before any steer", async () => {
    const f = await fixture();
    await f.start();
    expect(
      await f.control(f.threadId, "Revoked native input", undefined, undefined, async () => false),
    ).toMatchObject({
      outcome: "undelivered",
      deliveryStage: "unavailable",
      detail: expect.stringContaining("nothing was sent"),
    });
    expect(f.rpcRequests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/read",
      "thread/turns/list",
    ]);
    f.complete(0);
    await expect.poll(() => f.events.some((event) => event.method === "turn/completed")).toBe(true);
    expect(f.providerRequests).toHaveLength(1);
    expect(f.forbiddenRequests).toEqual([]);
  }, 30_000);

  it("uses expectedTurnId to refuse steering a replacement native turn", async () => {
    const f = await fixture();
    const original = await f.start();
    let replacement: string | undefined;
    f.setBeforeTurnsReply(async () => {
      await f.client.request("turn/interrupt", { threadId: f.threadId, turnId: original });
      await expect.poll(() => f.events.some((event) => event.method === "turn/completed")).toBe(true);
      replacement = await f.start("Replacement native turn input");
      await expect.poll(() => f.providerRequests.length).toBe(2);
    });
    expect(await f.control(f.threadId, "Stale-turn input must not enter replacement")).toMatchObject({
      outcome: "unconfirmed",
      detail: expect.stringContaining("inspect the exact session"),
    });
    expect(replacement).not.toBe(original);
    expect(f.rpcRequests.filter((request) => request.method === "turn/steer")).toMatchObject([
      { params: { expectedTurnId: original } },
    ]);
    expect(JSON.stringify(f.providerRequests[1]!.body.input)).not.toContain("Stale-turn input");
    f.complete(1);
    expect(f.forbiddenRequests).toEqual([]);
  }, 30_000);

  it("refuses a real unresolved native approval without answering or queueing", async () => {
    const f = await fixture();
    await f.start("Approval transport fixture", { approvalPolicy: "on-request" });
    f.complete(0, {
      type: "function_call",
      call_id: "fixture-approval",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: "printf fixture-never-approved",
        sandbox_permissions: "require_escalated",
        justification: "Owned approval refusal integration",
      }),
    });
    await expect
      .poll(() => f.events.some((event) => event.method === "item/commandExecution/requestApproval"))
      .toBe(true);
    const dispatcher = f.fleet();
    expect(await dispatcher.deliverToSeat("owned/terminal", "Approval must not be bypassed")).toMatchObject({
      outcome: "undelivered",
      detail: expect.stringContaining("waiting for owner input or approval"),
    });
    expect(f.queueCalls).toEqual([]);
    expect(f.rpcRequests.some((request) => request.method === "turn/steer")).toBe(false);
    expect(f.rpcRequests.every((request) => request.method !== undefined)).toBe(true);
    expect(f.providerRequests).toHaveLength(1);
    expect(f.forbiddenRequests).toEqual([]);
  }, 30_000);

  it("retains a lost real steer receipt across retry and dispatcher restart without queueing a duplicate", async () => {
    const f = await fixture();
    await f.start();
    f.setDropSteerReply(true);
    const dispatcher = f.fleet();
    const delivery = { stableReceiptKey: "owned-native-lost-receipt" };
    expect(
      await dispatcher.deliverToSeat("owned/terminal", "Lost receipt native input", undefined, delivery),
    ).toMatchObject({
      outcome: "unconfirmed",
      deliveryStage: "uncertain",
    });
    expect(f.rpcRequests.filter((request) => request.method === "turn/steer")).toHaveLength(1);
    expect(
      await dispatcher.deliverToSeat("owned/terminal", "Lost receipt native input", undefined, delivery),
    ).toMatchObject({ outcome: "unconfirmed" });
    const restarted = f.fleet();
    expect(
      await restarted.deliverToSeat("owned/terminal", "Lost receipt native input", undefined, delivery),
    ).toMatchObject({ outcome: "unconfirmed" });
    expect(f.queueCalls).toEqual([]);
    expect(f.rpcRequests.filter((request) => request.method === "turn/steer")).toHaveLength(1);
    f.complete(0);
    await expect.poll(() => f.providerRequests.length).toBe(2);
    expect(JSON.stringify(f.providerRequests[1]!.body.input)).toContain("Lost receipt native input");
    f.complete(1);
    expect(f.forbiddenRequests).toEqual([]);
  }, 30_000);

  it("queues through the bound native API and keeps held input pending until the original turn settles", async () => {
    const f = await fixture();
    const original = await f.start();
    const text = "Bound queue input after the original settles";
    expect(await f.fleet(f.queueControl).deliverToSeat("owned/terminal", text)).toMatchObject({
      outcome: "delivered",
      state: "queued",
    });
    const queued = f.rpcRequests.filter((request) => request.method === "thread/queue/add");
    expect(queued).toMatchObject([
      {
        params: {
          threadId: f.threadId,
          clientUserMessageId: expect.any(String),
          input: [{ type: "text", text, text_elements: [] }],
        },
      },
    ]);
    expect(f.rpcRequests.find((request) => request.method === "initialize")?.params).toMatchObject({
      capabilities: { experimentalApi: true },
    });
    expect(f.queueReplies).toMatchObject([
      {
        result: {
          queuedSubmission: {
            id: expect.any(String),
            clientUserMessageId: queued[0]!.params!.clientUserMessageId,
            input: [{ type: "text", text, text_elements: [] }],
          },
        },
      },
    ]);
    const turns = (await f.client.request("thread/turns/list", {
      threadId: f.threadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    })) as { data: Array<{ id: string; status: string }> };
    expect(turns.data[0]).toMatchObject({ id: original, status: "inProgress" });
    expect(f.providerRequests).toHaveLength(1);
    expect(JSON.stringify(f.providerRequests[0]!.body.input)).not.toContain(text);
    expect(f.queueCalls).toEqual([]);
    expect(f.rpcRequests.some((request) => request.method === "turn/steer")).toBe(false);
    f.complete(0);
    await expect.poll(() => f.providerRequests.length).toBe(2);
    expect(JSON.stringify(f.providerRequests[1]!.body.input).split(text)).toHaveLength(2);
    f.complete(1);
    await expect.poll(() => f.events.filter((event) => event.method === "turn/completed").length).toBe(2);
    expect(f.providerRequests).toHaveLength(2);
    expect(f.forbiddenRequests).toEqual([]);
  }, 30_000);

  it("uses the same bound native queue for an idle thread without account-default discovery", async () => {
    const f = await fixture();
    const text = "Bound idle queue starts its own native turn";
    expect(await f.fleet(f.queueControl).deliverToSeat("owned/terminal", text)).toMatchObject({
      outcome: "delivered",
      state: "queued",
    });
    expect(f.rpcRequests.filter((request) => request.method === "thread/queue/add")).toHaveLength(1);
    expect(f.queueReplies).toHaveLength(1);
    expect(f.queueCalls).toEqual([]);
    expect(f.rpcRequests.some((request) => request.method === "turn/steer")).toBe(false);
    await expect.poll(() => f.providerRequests.length).toBe(1);
    expect(JSON.stringify(f.providerRequests[0]!.body.input).split(text)).toHaveLength(2);
    f.complete(0);
    await expect.poll(() => f.events.some((event) => event.method === "turn/completed")).toBe(true);
    expect(f.providerRequests).toHaveLength(1);
    expect(f.forbiddenRequests).toEqual([]);
  }, 30_000);

  it.each(["stale", "refused"])(
    "refuses a %s native queue guard after discovery before storing input",
    async (failure) => {
      const f = await fixture();
      await f.start();
      let current = true;
      f.setBeforeReadReply(async () => {
        current = false;
      });
      expect(current).toBe(true);
      expect(
        await f.queueControl(
          f.threadId,
          "Guarded queue must never be stored",
          undefined,
          undefined,
          async () => {
            if (failure === "refused") throw new Error("Fresh host proof refused the original recipient");
            return current;
          },
        ),
      ).toMatchObject({
        outcome: "undelivered",
        deliveryStage: "unavailable",
        detail: expect.stringContaining("nothing was sent"),
      });
      expect(current).toBe(false);
      expect(f.rpcRequests.some((request) => request.method === "thread/read")).toBe(true);
      expect(f.rpcRequests.some((request) => request.method === "thread/queue/add")).toBe(false);
      expect(f.queueReplies).toEqual([]);
      expect(f.queueCalls).toEqual([]);
      f.complete(0);
      await expect.poll(() => f.events.some((event) => event.method === "turn/completed")).toBe(true);
      expect(f.providerRequests).toHaveLength(1);
      expect(f.forbiddenRequests).toEqual([]);
    },
    30_000,
  );

  it("retains a lost real queue ACK across retry and dispatcher restart without storing a duplicate", async () => {
    const f = await fixture();
    await f.start();
    f.setDropQueueReply(true);
    const text = "Lost bound queue ACK still enters exactly once";
    const dispatcher = f.fleet(f.queueControl);
    const delivery = { stableReceiptKey: "owned-native-lost-queue-ack" };
    expect(await dispatcher.deliverToSeat("owned/terminal", text, undefined, delivery)).toMatchObject({
      outcome: "unconfirmed",
      deliveryStage: "uncertain",
    });
    expect(f.queueReplies).toMatchObject([
      { result: { queuedSubmission: { id: expect.any(String), clientUserMessageId: expect.any(String) } } },
    ]);
    expect(await dispatcher.deliverToSeat("owned/terminal", text, undefined, delivery)).toMatchObject({
      outcome: "unconfirmed",
    });
    const restarted = f.fleet(f.queueControl);
    expect(await restarted.deliverToSeat("owned/terminal", text, undefined, delivery)).toMatchObject({
      outcome: "unconfirmed",
    });
    expect(f.rpcRequests.filter((request) => request.method === "thread/queue/add")).toHaveLength(1);
    expect(f.queueReplies).toHaveLength(1);
    expect(f.queueCalls).toEqual([]);
    expect(f.providerRequests).toHaveLength(1);
    f.complete(0);
    await expect.poll(() => f.providerRequests.length).toBe(2);
    expect(JSON.stringify(f.providerRequests[1]!.body.input).split(text)).toHaveLength(2);
    f.complete(1);
    await expect.poll(() => f.events.filter((event) => event.method === "turn/completed").length).toBe(2);
    expect(f.providerRequests).toHaveLength(2);
    expect(f.forbiddenRequests).toEqual([]);
  }, 30_000);
});
