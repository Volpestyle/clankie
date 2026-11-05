import { installedPiReceiptFixture } from "./fixtures/installed-pi-message-receipts.ts";
import { supportedPiUnavailable } from "./fixtures/supported-pi.ts";
import { grokReceiptFixture } from "./fixtures/grok-message-receipts.ts";
import {
  primeReceiptFixture,
  codexReceiptFixture,
  claudeReceiptFixture,
  externalCodexReceiptFixture,
} from "./fixtures/native-single-admission-receipts.ts";
import { openCodeReceiptFixture } from "./fixtures/opencode-message-receipts.ts";
import { piFixture } from "./fixtures/pi-message-receipts.ts";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CONNECTOR_GRANTS,
  AgentMessageReceiptLookupSchema,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { SettingsStore } from "@clankie/settings";
import {
  FileCredentialStore,
  mintOperatorToken,
  operatorCredentialReadFence,
} from "@clankie/credential-broker";
import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { AgentMessageReceipts } from "../src/agent-message-receipts.ts";
import { AgentMessageObservations } from "../src/agent-message-observations.ts";
import { ConnectorDetection } from "../src/app/connector-detection.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import {
  createCaptainConversationDispatch,
  createDeviceConversationDispatch,
} from "../../relay/src/conversation-upstream.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { createConnectorMcpHandler, createLoopbackConnectorOperator } from "../../relay/src/connector-mcp.ts";
import { ClankieGuide } from "../../relay/src/connector-guide.ts";

// Real HTTP service, signed device authorizer, relay, MCP SDK and CLI process.
// Protocol cases record native harness/census facts; the installed-Pi case launches
// a real owned TUI with recorded loopback responses. No lead model can initialize.
vi.mock("../src/captain/model.ts", () => ({
  createCaptainModelRuntime: async () => {
    throw new Error("No model call is permitted in this native receipt proof");
  },
}));
vi.mock("@clankie/agent-transcript", async (original) => ({
  ...(await original<object>()),
  readCodexGoal: async () => undefined,
  readClaudeSubagents: async () => undefined,
  readCodexSubagents: async () => undefined,
}));
const exec = promisify(execFile);
const closes: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const decoded = (value: Awaited<ReturnType<Client["callTool"]>>) => {
  const blocks = value.content as Array<{ type: string; text?: string }>;
  const text = blocks
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
  if (value.isError) throw new Error(text);
  return JSON.parse(text);
};
async function fixture(pi?: { control: SeatControl; file?: string }) {
  const root = await mkdtemp(join(tmpdir(), "agent-message-connector-"));
  closes.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv("HC_SOCKET", join(root, "no-owner-desktop.sock"));
  const state = join(root, "captain");
  await mkdir(state);
  const settings = new SettingsStore(join(root, "settings.json"));
  let nativeId = pi?.control.ref.sessionId ?? randomUUID(),
    sends = 0,
    queued = true,
    queueDetail = true;
  let nativeDetail = "The native queue is waiting for its turn.";
  let beforeNative: undefined | (() => Promise<void>);
  const originalMessages: string[] = [];
  const live = (): HerdrAgentSnapshot => ({
    paneId: "fixture-pane",
    terminalId: "fixture-seat",
    name: "fixture-worker",
    agent: pi ? pi.control.ref.harness : "claude",
    status: "idle",
    title: "Receipt fixture",
    workingDirectory: root,
    session: pi
      ? pi.control.ref.harness === "pi"
        ? { source: "herdr:pi", kind: "path", value: pi.file! }
        : { source: `herdr:${pi.control.ref.harness}`, kind: "id", value: nativeId }
      : { source: "herdr:claude", kind: "id", value: nativeId },
  });
  const controller: SeatControl = {
    ref: { harness: pi ? pi.control.ref.harness : "claude", sessionId: nativeId, paneId: "fixture-pane" },
    status: async () => "idle",
    interrupt: async () => false,
    close: async () => {},
    settled: async (...args) =>
      pi
        ? pi.control.settled(...args)
        : {
            type: "settlement_unconfirmed",
            at: new Date().toISOString(),
            reason: "message_correlation_unavailable",
          },
    send: async (message, options) => {
      await beforeNative?.();
      if (pi) return pi.control.send(message, options);
      if (options?.beforeDispatch && !(await options.beforeDispatch()))
        return { outcome: "offline", detail: "Original authority or occupant changed" };
      sends += 1;
      originalMessages.push(message);
      return {
        outcome: "accepted",
        state: queued ? "queued" : "started",
        messageId: "fixture-input-" + sends,
        ...(queued && queueDetail ? { detail: nativeDetail } : {}),
      };
    },
  };
  const adapter: HarnessSeatAdapter = {
    harness: pi ? pi.control.ref.harness : "claude",
    start: async () => {
      throw new Error("No hire or model start is permitted");
    },
    attach: async (ref) => (ref.sessionId === nativeId ? controller : undefined),
  };
  const runner: HerdrWatchRunner = {
    list: async () => [live()],
    get: async () => live(),
    resolveTerminal: async () => live(),
    transcript: async () => undefined,
    wait: async (_target, signal) =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  };
  const census = async (_command: string, args: readonly string[]) => {
    const agent = live();
    const wire = {
      pane_id: agent.paneId,
      terminal_id: agent.terminalId,
      name: agent.name,
      agent: agent.agent,
      agent_status: agent.status,
      title: agent.title,
      cwd: root,
      agent_session: agent.session,
    };
    return {
      stdout: JSON.stringify({
        result:
          args[0] === "agent"
            ? args[1] === "get"
              ? { agent: wire }
              : { agents: [wire] }
            : { snapshot: { workspaces: [], tabs: [], panes: [wire] } },
      }),
      stderr: "",
    };
  };
  const makeCaptain = () =>
    createCaptain({ herdrAvailable: () => true } as CaptainDeps, {
      repoRoot: root,
      stateDir: state,
      workingDirectory: root,
      settings,
      seatAdapters: [adapter],
      nativeHerdrRunner: runner,
      nativeCensusRunner: census,
      nativeSummariesPath: join(root, "summaries.json"),
      discordEnvironment: {},
      fleetRoundIntervalMs: 3600_000,
    });
  let captain = makeCaptain();
  const ownerToken = mintOperatorToken();
  const credentials = new FileCredentialStore(join(root, "operator-credentials.json"));
  await credentials.set("clankie_operator", { type: "api", key: ownerToken });
  const operatorEnv: NodeJS.ProcessEnv = {};
  const key = randomBytes(32),
    eventLogPath = join(root, "events.jsonl");
  let now = Date.now();
  const events = ["app-a", "app-b"].flatMap((deviceId) =>
    [
      {
        type: "device.pairing.redeemed",
        data: {
          offerId: deviceId,
          name: deviceId,
          platform: "unknown",
          offeredGrants: CONNECTOR_GRANTS,
          mintedBy: "local-operator",
          scope: "connector",
          pendingExpiresAt: new Date(now + 60_000).toISOString(),
        },
      },
      {
        type: "device.activated",
        data: { grants: CONNECTOR_GRANTS, sessionExpiresAt: new Date(now + 3600_000).toISOString() },
      },
    ].map((event) => ({
      id: randomUUID(),
      type: event.type,
      occurredAt: new Date(now).toISOString(),
      missionId: "device:" + deviceId,
      correlationId: "receipt-proof",
      profileHash: "fixture",
      data: { schemaVersion: 1, deviceId, ...event.data },
    })),
  );
  await writeFile(eventLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const signer = new DeviceSessionSigner(key);
  const token = (deviceId: string) =>
    signer.issue(
      mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 3600 }),
    );
  const tokens = new Map(["app-a", "app-b"].map((id) => [id, token(id)]));
  const receiptsPath = join(state, "agent-message-receipts.json"),
    nativeEvidencePath = join(state, "herdr-watches.json");
  const makeService = () =>
    createClankieApp({
      captain,
      settings,
      eventLogPath,
      deviceSessionKey: key,
      connectorDetection: new ConnectorDetection(),
      clock: () => new Date(now),
      agentMessageReceipts: new AgentMessageReceipts(receiptsPath, Date.now, nativeEvidencePath),
      leadChangesAuthorityFence: (_request, kind) =>
        kind === "operator"
          ? operatorCredentialReadFence({ store: credentials, env: operatorEnv })
          : { assertCurrent() {} },
      authenticateOperator: createCredentialBackedOperatorAuthenticator({
        store: credentials,
        env: operatorEnv,
        identity: { operatorId: "owner" },
      }),
      authenticateCaptain: async (request) =>
        request.headers.get("authorization") === "Bearer fixture-relay-credential-176"
          ? { captainId: "relay", steerSourceLane: "api" }
          : undefined,
    });
  let service = await makeService();
  closes.push(async () => {
    await service.close();
    await captain.close();
  });
  const primary = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => service.app.fetch(request) });
  if (!primary.listening) await once(primary, "listening");
  closes.push(() => {
    if ("closeAllConnections" in primary) primary.closeAllConnections();
    return new Promise<void>((done) => primary.close(() => done()));
  });
  const primaryUrl = "http://127.0.0.1:" + (primary.address() as { port: number }).port;
  let authorizer = new ControlPlaneDeviceAuthorizer({ baseUrl: primaryUrl });
  const makeOperator = () =>
    createOperatorConversationRelayHandler({
      authorizeDevice: authorizer,
      dispatch: createCaptainConversationDispatch({
        baseUrl: primaryUrl,
        bearerToken: "fixture-relay-credential-176",
      }),
      deviceDispatch: createDeviceConversationDispatch({ baseUrl: primaryUrl }),
    });
  let relayUrl = "";
  const makeConnector = () =>
    createConnectorMcpHandler({
      authorizeDevice: authorizer,
      operator: createLoopbackConnectorOperator("http://placeholder.invalid", (input, init) =>
        fetch(new URL(new URL(String(input)).pathname, relayUrl), init),
      ),
      localAuthorizationServer: primaryUrl,
      version: "fixture",
      guide: new ClankieGuide(resolve(import.meta.dirname, "../../..")),
    });
  let operator = makeOperator(),
    connector = makeConnector();
  const restartRelay = () => {
    authorizer = new ControlPlaneDeviceAuthorizer({ baseUrl: primaryUrl });
    operator = makeOperator();
    connector = makeConnector();
  };
  const relay = createServer((request, response) => {
    void (async () => {
      if (await connector(request, response)) return;
      if (await operator(request, response)) return;
      response.writeHead(404).end();
    })();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  closes.push(() => {
    relay.closeAllConnections();
    return new Promise<void>((done) => relay.close(() => done()));
  });
  relayUrl = "http://127.0.0.1:" + (relay.address() as { port: number }).port;
  const post = (body: unknown, who = "app-a") =>
    fetch((who === "owner" || who === "relay" ? primaryUrl : relayUrl) + "/operator/v1/dispatch", {
      method: "POST",
      headers: {
        authorization:
          "Bearer " +
          (who === "owner"
            ? ownerToken
            : who === "relay"
              ? "fixture-relay-credential-176"
              : tokens.get(who)!),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const client = async (who = "app-a") => {
    const value = new Client({ name: "receipt-proof", version: "1" });
    await value.connect(
      new StreamableHTTPClientTransport(new URL(relayUrl + "/mcp"), {
        requestInit: { headers: { authorization: "Bearer " + tokens.get(who)! } },
      }) as unknown as Transport,
    );
    closes.push(() => value.close());
    return value;
  };
  const fleet = await captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 });
  if (fleet.op !== "fleet" || fleet.snapshot.seats.length !== 1)
    throw new Error("Fixture must expose exactly its native occupant");
  const seat = fleet.snapshot.seats[0]!;
  return {
    root,
    state,
    primaryUrl,
    ownerToken,
    post,
    client,
    receiptsPath,
    receiptSnapshot: async () => {
      const files = [
        receiptsPath,
        ...(await readdir(receiptsPath + ".d")).sort().map((file) => join(receiptsPath + ".d", file)),
      ];
      return Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")]));
    },
    seat,
    originalMessages,
    advanceClock: (ms: number) => {
      now += ms;
    },
    thread: async () =>
      captain.serveOperatorConversation({
        op: "create",
        schemaVersion: 1,
        scope: { kind: "persona", personaId: seat.personaId },
        title: "Fixture",
      }),
    freshSession: () => {
      tokens.set("app-a", token("app-a"));
    },
    queueCanary: () => {
      nativeDetail = "PRIVATE_NATIVE_DETAIL_CANARY sk-proj-" + "x".repeat(100);
      return nativeDetail;
    },
    sends: () => sends,
    consumedQueue: () => {
      queueDetail = false;
    },
    immediate: () => {
      queued = false;
    },
    replace: () => {
      nativeId = randomUUID();
      if (pi?.control.ref.harness === "pi") pi.file = join(root, `replacement_${nativeId}.jsonl`);
    },
    beforeNative: (hook: () => Promise<void>) => {
      beforeNative = hook;
    },
    nativeProof: async (
      messageId: string,
      text: string,
      occupantId = seat.occupantId,
      completionMessageId = messageId,
    ) =>
      writeFile(
        nativeEvidencePath,
        JSON.stringify({
          schemaVersion: 1,
          watches: [],
          harvestedTurns: [
            {
              terminalId: seat.seatId,
              occupantId,
              messageId,
              watchId: randomUUID(),
              completion: {
                type: "turn_completed",
                at: new Date().toISOString(),
                messageId: completionMessageId,
                ok: true,
                text,
              },
            },
          ],
        }),
      ),
    revoke: () =>
      fetch(primaryUrl + "/v1/devices/app-a/revoke", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: "{}",
      }),
    async downgradeAndRestart() {
      await service.close();
      await captain.close();
      const lines = (await readFile(eventLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const event of lines)
        if (event.type === "device.activated" && event.data.deviceId === "app-a")
          event.data.grants.steer = false;
      await writeFile(eventLogPath, lines.map((event) => JSON.stringify(event)).join("\n") + "\n");
      captain = makeCaptain();
      service = await makeService();
      restartRelay();
    },
    async restart() {
      await service.close();
      await captain.close();
      captain = makeCaptain();
      service = await makeService();
      restartRelay();
    },
  };
}

it("carries the original receipt through real service, signed relay, MCP and CLI and retains it across restart", async () => {
  const f = await fixture(),
    client = await f.client();
  expect(
    (await client.listTools()).tools.find((tool) => tool.name === "message_agent_status")?.annotations
      ?.readOnlyHint,
  ).toBe(true);
  const requestId = randomUUID();
  const sent = decoded(
    await client.callTool({
      name: "message_agent",
      arguments: {
        agent: "herdr:" + f.seat.seatId,
        message: "Run the fixture check",
        receipt: true,
        requestId,
      },
    }),
  );
  expect(sent.status).toBe("queued");
  expect(sent.receiptId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(f.sends()).toBe(1);
  const lookup = () =>
    client.callTool({ name: "message_agent_status", arguments: { receiptId: sent.receiptId } }).then(decoded);
  expect(await lookup()).toMatchObject({ outcome: "found", receipt: { progress: [{ stage: "queued" }] } });
  const other = await f.client("app-b");
  expect(
    decoded(await other.callTool({ name: "message_agent_status", arguments: { receiptId: sent.receiptId } })),
  ).toEqual({ outcome: "unknown" });
  expect(
    (
      await f.post(
        { op: "agent_message_status", schemaVersion: 1, receiptId: sent.receiptId, appDeviceId: "app-a" },
        "app-b",
      )
    ).status,
  ).toBe(400);
  expect(
    (await f.post({ op: "agent_message_status", schemaVersion: 1, receiptId: sent.receiptId }, "relay"))
      .status,
  ).toBe(403);
  const before = await f.receiptSnapshot();
  await f.nativeProof("unrelated-input", "Run the fixture check");
  expect((await lookup()).receipt.progress.map((entry: { stage: string }) => entry.stage)).toEqual([
    "queued",
  ]);
  await f.nativeProof("fixture-input-1", "Fixture check passed", "replacement-occupant");
  expect((await lookup()).receipt.progress.map((entry: { stage: string }) => entry.stage)).toEqual([
    "queued",
  ]);
  await f.nativeProof("fixture-input-1", "Fixture check passed", f.seat.occupantId, "different-input");
  expect((await lookup()).receipt.progress.map((entry: { stage: string }) => entry.stage)).toEqual([
    "queued",
  ]);
  await f.nativeProof("fixture-input-1", "Fixture check passed");
  expect((await lookup()).receipt.progress.map((entry: { stage: string }) => entry.stage)).toEqual([
    "queued",
    "acted_on",
    "answered",
  ]);
  expect(await f.receiptSnapshot()).toEqual(before);
  const cli = await exec(
    process.execPath,
    [
      "--import",
      resolve("apps/tui/node_modules/tsx/dist/loader.mjs"),
      resolve("apps/tui/bin/clankie.ts"),
      "connector",
      "message-status",
      sent.receiptId,
      "--json",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: f.root,
        NODE_ENV: "test",
        CLANKIE_OPERATOR_TOKEN: f.ownerToken,
        CLANKIE_CONTROL_PLANE_URL: f.primaryUrl,
      },
      timeout: 30_000,
    },
  );
  expect(AgentMessageReceiptLookupSchema.parse(JSON.parse(cli.stdout))).toMatchObject({
    outcome: "found",
    receipt: { receiptId: sent.receiptId },
  });
  await f.restart();
  const restarted = decoded(
    await (
      await f.client()
    ).callTool({
      name: "message_agent",
      arguments: {
        agent: "herdr:" + f.seat.seatId,
        message: "Run the fixture check",
        receipt: true,
        requestId,
      },
    }),
  );
  expect(restarted.receiptId).toBe(sent.receiptId);
  expect(f.sends()).toBe(1);
  const lookupResponse = await f.post({
    op: "agent_message_status",
    schemaVersion: 1,
    receiptId: sent.receiptId,
  });
  const retained = OperatorConversationServiceResultSchema.parse(await lookupResponse.json());
  expect(retained).toMatchObject({ op: "agent_message_status", result: { outcome: "found" } });
  if (retained.op !== "agent_message_status" || retained.result.outcome !== "found")
    throw new Error("Original receipt missing");
  expect(retained.result.receipt.progress.map((entry) => entry.stage)).toEqual([
    "queued",
    "acted_on",
    "answered",
  ]);
});

it("reports a consumed native queue acknowledgment as delivered without claiming it was read", async () => {
  const f = await fixture(),
    client = await f.client();
  f.consumedQueue();
  const sent = decoded(
    await client.callTool({
      name: "message_agent",
      arguments: {
        agent: "herdr:" + f.seat.seatId,
        message: "Consumed input",
        receipt: true,
      },
    }),
  );
  expect(sent.status).toBe("delivered");
  const status = decoded(
    await client.callTool({ name: "message_agent_status", arguments: { receiptId: sent.receiptId } }),
  );
  expect(status.receipt.delivery).toBe("delivered");
  expect(status.receipt.progress.map((entry: { stage: string }) => entry.stage)).toEqual(["delivered"]);
  expect(f.sends()).toBe(1);
});

it("preserves ordinary results and refuses changed keyed originals without another native mutation", async () => {
  const f = await fixture(),
    client = await f.client();
  f.immediate();
  const ordinary = decoded(
    await client.callTool({
      name: "message_agent",
      arguments: { agent: "herdr:" + f.seat.seatId, message: "Ordinary message" },
    }),
  );
  expect(ordinary.status).toBe("delivered");
  expect(ordinary).not.toHaveProperty("receiptId");
  const requestId = randomUUID();
  const sent = decoded(
    await client.callTool({
      name: "message_agent",
      arguments: { agent: "herdr:" + f.seat.seatId, message: "Original input", receipt: true, requestId },
    }),
  );
  expect(sent.status).toBe("delivered");
  expect(f.sends()).toBe(2);
  const changed = await client.callTool({
    name: "message_agent",
    arguments: { agent: "herdr:" + f.seat.seatId, message: "Different input", receipt: true, requestId },
  });
  expect(changed.isError).toBe(true);
  expect(f.sends()).toBe(2);
  expect(
    decoded(
      await client.callTool({ name: "message_agent_status", arguments: { receiptId: sent.receiptId } }),
    ).receipt.progress.map((entry: { stage: string }) => entry.stage),
  ).toEqual(["delivered"]);
});

it("rechecks a device revoked after native preparation and does not dispatch the original", async () => {
  const f = await fixture(),
    client = await f.client();
  f.beforeNative(async () => {
    const revoked = await f.revoke();
    expect(revoked.status).toBe(200);
  });
  const sent = await client.callTool({
    name: "message_agent",
    arguments: {
      agent: "herdr:" + f.seat.seatId,
      message: "Must not reach the harness",
      receipt: true,
      requestId: randomUUID(),
    },
  });
  expect(sent.isError).toBe(true);
  expect(f.sends()).toBe(0);
  expect(
    (await f.post({ op: "agent_message_status", schemaVersion: 1, receiptId: randomUUID() })).status,
  ).toBe(401);
});

it("recovers a discarded successful API reply with its original revision and never replays it", async () => {
  const f = await fixture();
  const thread = await f.thread();
  if (thread.op !== "create") throw new Error("Fixture thread missing");
  const original = {
    op: "send",
    schemaVersion: 1,
    receiptRequestId: randomUUID(),
    turn: {
      schemaVersion: 1,
      conversationId: thread.conversation.conversationId,
      surfaceClientId: "lost-reply-fixture",
      expectedRevision: thread.conversation.revision,
      kind: "message",
      message: "An original whose response was lost",
    },
  };
  const sent = await f.post(original);
  expect(sent.status, await sent.clone().text()).toBe(200);
  await sent.arrayBuffer(); // Deliberately discard the response, keeping only the original request key.
  expect(f.sends()).toBe(1);
  f.replace();
  await f.restart();
  const recovered = await f.post(original);
  expect(recovered.status, await recovered.clone().text()).toBe(200);
  const body = OperatorConversationServiceResultSchema.parse(await recovered.json());
  expect(body).toMatchObject({ op: "send", receiptId: expect.any(String), result: { status: "accepted" } });
  expect(f.sends()).toBe(1);
});

it("refuses native replacement during preparation without sending to the new occupant", async () => {
  const f = await fixture(),
    client = await f.client();
  f.beforeNative(async () => {
    f.replace();
  });
  const sent = await client.callTool({
    name: "message_agent",
    arguments: { agent: "herdr:" + f.seat.seatId, message: "For the original only", receipt: true },
  });
  expect(f.sends()).toBe(0);
  const text = JSON.stringify(sent);
  expect(text).not.toContain('"status":"delivered"');
  if (!sent.isError) expect(decoded(sent).status).toBe("offline");
});

it("expires the authenticated sending session during preparation and refuses caller deadline stamps", async () => {
  const f = await fixture(),
    client = await f.client();
  expect(
    (
      await f.post({
        op: "agent_message_status",
        schemaVersion: 1,
        receiptId: randomUUID(),
        appSessionExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
      })
    ).status,
  ).toBe(400);
  f.beforeNative(async () => {
    f.advanceClock(3600_001);
  });
  const sent = await client.callTool({
    name: "message_agent",
    arguments: { agent: "herdr:" + f.seat.seatId, message: "The session will have expired", receipt: true },
  });
  expect(sent.isError).toBe(true);
  expect(f.sends()).toBe(0);
});

it("withholds an existing receipt after restart with reduced device grants", async () => {
  const f = await fixture(),
    client = await f.client();
  const sent = decoded(
    await client.callTool({
      name: "message_agent",
      arguments: { agent: "herdr:" + f.seat.seatId, message: "Original before downgrade", receipt: true },
    }),
  );
  expect(f.sends()).toBe(1);
  await f.downgradeAndRestart();
  const denied = await f.post({ op: "agent_message_status", schemaVersion: 1, receiptId: sent.receiptId });
  expect(denied.status).toBe(403);
  expect(f.sends()).toBe(1);
});

it("refuses unsupported queued receipt modes before creating a native delivery", async () => {
  const f = await fixture();
  const thread = await f.thread();
  if (thread.op !== "create") throw new Error("Fixture thread missing");
  const refused = await f.post({
    op: "send",
    schemaVersion: 1,
    receiptRequestId: randomUUID(),
    turn: {
      schemaVersion: 1,
      conversationId: thread.conversation.conversationId,
      expectedRevision: thread.conversation.revision,
      surfaceClientId: "receipt-queue-fixture",
      kind: "message",
      message: "Not a durable unfenced queue",
      delivery: "queue",
    },
  });
  expect(refused.status, await refused.clone().text()).toBe(400);
  expect(f.sends()).toBe(0);
});

it.each(["beforeSendPreparation", "beforeNativeClaim", "beforeNativeClaimReply", "stable"] as const)(
  "refuses a revoked app through the production Pi adapter at %s",
  async (boundary) => {
    const p = await piFixture();
    const { prepared } = await p.prepare();
    const started = await prepared.start(p.view);
    if (started.outcome !== "started") throw new Error("Pi fixture failed");
    p.finish();
    const before = p.sendMessage.mock.calls.length;
    const commands = p.sendCommands();
    const replies = p.positiveReplies().length;
    let revoked = false;
    const f = await fixture({ control: started.control, file: p.file }),
      client = await f.client();
    if (boundary !== "stable")
      p[boundary](async () => {
        revoked = (await f.revoke()).status === 200;
      });
    const result = await client.callTool({
      name: "message_agent",
      arguments: {
        agent: "herdr:" + f.seat.seatId,
        message: "Revoked original must not be admitted",
        receipt: true,
      },
    });
    expect(revoked).toBe(boundary !== "stable");
    if (boundary === "stable") {
      expect(p.sendMessage.mock.calls.length - before).toBe(1);
      expect(decoded(result).status).toBe("delivered");
    } else {
      expect(p.sendMessage.mock.calls.length - before).toBe(0);
      expect(result.isError || JSON.stringify(result).includes("offline")).toBe(true);
    }
    expect(p.sendCommands() - commands).toBe(boundary === "beforeSendPreparation" ? 0 : 1);
    expect(p.positiveReplies().slice(replies)).toEqual(
      boundary === "stable"
        ? ["authorize", "claim"]
        : boundary === "beforeNativeClaimReply"
          ? ["authorize"]
          : [],
    );
  },
);

it("keeps receipt lookup and original recovery bound to the same signed session across restart", async () => {
  const f = await fixture(),
    client = await f.client();
  const requestId = randomUUID();
  const sent = decoded(
    await client.callTool({
      name: "message_agent",
      arguments: {
        agent: "herdr:" + f.seat.seatId,
        message: "Original session only",
        receipt: true,
        requestId,
      },
    }),
  );
  await f.restart();
  const same = decoded(
    await (
      await f.client()
    ).callTool({ name: "message_agent_status", arguments: { receiptId: sent.receiptId } }),
  );
  expect(same.outcome).toBe("found");
  f.freshSession();
  const fresh = await f.client();
  expect(
    decoded(await fresh.callTool({ name: "message_agent_status", arguments: { receiptId: sent.receiptId } })),
  ).toEqual({ outcome: "unknown" });
  const replay = await fresh.callTool({
    name: "message_agent",
    arguments: {
      agent: "herdr:" + f.seat.seatId,
      message: "Original session only",
      receipt: true,
      requestId,
    },
  });
  expect(replay.isError).toBe(true);
  expect(f.sends()).toBe(1);
  const forged = await f.post({
    op: "agent_message_status",
    schemaVersion: 1,
    receiptId: sent.receiptId,
    appSessionId: "a".repeat(64),
  });
  expect(forged.status).toBe(400);
});

it("never persists synthetic native detail or credential canaries, including replay after restart", async () => {
  const f = await fixture(),
    client = await f.client(),
    canary = f.queueCanary();
  const sent = decoded(
    await client.callTool({
      name: "message_agent",
      arguments: {
        agent: "herdr:" + f.seat.seatId,
        message: "Metadata only",
        receipt: true,
      },
    }),
  );
  expect(sent.status).toBe("queued");
  expect(JSON.stringify(await f.receiptSnapshot())).not.toContain(canary);
  expect(JSON.stringify(await f.receiptSnapshot())).not.toContain("PRIVATE_NATIVE_DETAIL_CANARY");
  await f.restart();
  expect(
    decoded(
      await (
        await f.client()
      ).callTool({ name: "message_agent_status", arguments: { receiptId: sent.receiptId } }),
    ).outcome,
  ).toBe("found");
  expect(JSON.stringify(await f.receiptSnapshot())).not.toContain("PRIVATE_NATIVE_DETAIL_CANARY");
});

it.each([1, 2] as const)(
  "rechecks the original sender at each production OpenCode %s reply",
  async (version) => {
    for (const phase of ["authorize", "authorize-proof", "claim", "claim-proof", "stable"] as const) {
      const native = await openCodeReceiptFixture(version);
      const f = await fixture({ control: native.control }),
        client = await f.client();
      let revoked = false;
      native.pauseAt(phase, async () => {
        revoked = (await f.revoke()).status === 200;
      });
      const result = await client.callTool({
        name: "message_agent",
        arguments: { agent: "herdr:" + f.seat.seatId, message: "Native OpenCode admission", receipt: true },
      });
      expect(revoked).toBe(phase !== "stable");
      expect(native.admitted()).toBe(phase === "stable" ? 1 : 0);
      expect(native.positiveReplies()).toEqual(
        phase === "stable" ? ["authorize", "claim"] : phase.startsWith("claim") ? ["authorize"] : [],
      );
      if (phase === "stable") expect(decoded(result).status).toBe("delivered");
    }
  },
);

it.each([
  ["prime", primeReceiptFixture],
  ["codex", codexReceiptFixture],
  ["claude", claudeReceiptFixture],
  ["grok", grokReceiptFixture],
] as const)("gates the production %s native admission after preparation", async (_harness, makeNative) => {
  for (const revoke of [false, true]) {
    const native = await makeNative(),
      f = await fixture({ control: native.control }),
      client = await f.client();
    let revoked = false;
    if (revoke)
      native.beforeMutation(async () => {
        revoked = (await f.revoke()).status === 200;
      });
    const result = await client.callTool({
      name: "message_agent",
      arguments: {
        agent: "herdr:" + f.seat.seatId,
        message: "Original must pass its final native admission gate",
        receipt: true,
      },
    });
    expect(revoked).toBe(revoke);
    expect(native.admitted()).toBe(revoke ? 0 : 1);
    if (!revoke) expect(result.isError).not.toBe(true);
  }
});

it.each([
  ["queue", false],
  ["steer", false],
  ["queue", true],
  ["steer", true],
] as const)("rechecks sender after Codex %s discovery (remote=%s)", async (mode, remote) => {
  for (const revoke of [false, true]) {
    const native = await externalCodexReceiptFixture(mode, remote),
      f = await fixture({ control: native.control }),
      client = await f.client();
    let revoked = false;
    if (revoke)
      native.beforeMutation(async () => {
        revoked = (await f.revoke()).status === 200;
      });
    const result = await client.callTool({
      name: "message_agent",
      arguments: {
        agent: "herdr:" + f.seat.seatId,
        message: "Exact native Codex socket admission",
        receipt: true,
      },
    });
    expect(revoked).toBe(revoke);
    expect(native.admitted()).toBe(revoke ? 0 : 1);
    if (!revoke) expect(result.isError).not.toBe(true);
  }
});

it("retains exact-input native Pi receipt progress through API, MCP, CLI and restart", async ({ skip }) => {
  const unavailable = await supportedPiUnavailable();
  skip(unavailable !== undefined, unavailable);
  const native = await installedPiReceiptFixture((close) => {
    closes.push(close);
  });
  const f = await fixture(native);
  let client = await f.client();
  const sent = decoded(
    await client.callTool({
      name: "message_agent",
      arguments: {
        agent: "herdr:" + f.seat.seatId,
        message: "Return the fixed loopback receipt answer.",
        receipt: true,
        requestId: randomUUID(),
      },
    }),
  );
  expect(sent.receiptId).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent.status).toBe("delivered");
  const lookup = async () =>
    decoded(
      await client.callTool({ name: "message_agent_status", arguments: { receiptId: sent.receiptId } }),
    );
  native.releaseAnswer();

  await expect
    .poll(async () => (await lookup()).receipt.progress.map((p: any) => p.stage), { timeout: 30000 })
    .toContain("answered");
  const final = await lookup();
  expect(final.receipt.progress.map((p: any) => p.stage)).toEqual(
    expect.arrayContaining(["delivered", "acted_on", "answered"]),
  );
  expect(
    final.receipt.progress.every((p: any) => p.observedAt !== undefined || p.occurredAt !== undefined),
  ).toBe(true);
  expect(native.requests()).toBe(2);
  const cli = await exec(
    process.execPath,
    [
      resolve(import.meta.dirname, "../../tui/bin/clankie.ts"),
      "connector",
      "message-status",
      sent.receiptId,
      "--json",
    ],
    {
      env: { ...process.env, CLANKIE_CONTROL_PLANE_URL: f.primaryUrl, CLANKIE_OPERATOR_TOKEN: f.ownerToken },
      timeout: 10000,
    },
  );
  expect(JSON.parse(cli.stdout).receipt.receiptId).toBe(sent.receiptId);
  const old = await lookup();
  await f.restart();
  client = await f.client();
  expect((await lookup()).receipt.receiptId).toBe(old.receipt.receiptId);
  expect(native.requests()).toBe(2);
}, 120000);

it.each(["stable", "revoked", "expired", "replaced", "wrong-input", "fresh-session", "shutdown"] as const)(
  "retains only the original native receipt observation (%s)",
  async (mode) => {
    const observation = vi.spyOn(AgentMessageObservations.prototype, "start");
    try {
      const native = await piFixture();
      const { prepared } = await native.prepare();
      const started = await prepared.start(native.view);
      if (started.outcome !== "started") throw new Error("Native Pi fixture failed");
      native.finish();
      const before = native.sendCommands();
      let enteredRead = () => {};
      const entered = new Promise<void>((resolve) => {
        enteredRead = resolve;
      });
      let reads = 0;
      const original = started.control;
      const control: SeatControl = {
        ...original,
        settled: async (...args) => {
          reads++;
          enteredRead();
          const event = await original.settled(...args);
          return mode === "wrong-input" && event.type === "turn_completed"
            ? { ...event, messageId: randomUUID() }
            : event;
        },
      };
      const f = await fixture({ control, file: native.file });
      let client = await f.client();
      const sent = decoded(
        await client.callTool({
          name: "message_agent",
          arguments: { agent: "herdr:" + f.seat.seatId, message: "Original native progress", receipt: true },
        }),
      );
      expect(sent.status).toBe("delivered");
      const done = observation.mock.results[0]?.value;
      expect(done).toBeInstanceOf(Promise);
      await entered;
      if (mode === "revoked") expect((await f.revoke()).status).toBe(200);
      if (mode === "replaced") f.replace();
      if (mode === "expired") f.advanceClock(61 * 60_000);
      if (mode === "fresh-session") f.freshSession();
      if (mode === "shutdown") {
        await f.restart();
        client = await f.client();
      }
      const canary = "PRIVATE_NATIVE_ANSWER_CANARY sk-proj-" + "z".repeat(90);
      native.finish(canary);
      await done;
      const response = await f.post(
        { op: "agent_message_status", schemaVersion: 1, receiptId: sent.receiptId },
        "owner",
      );
      const result = OperatorConversationServiceResultSchema.parse(await response.json());
      if (result.op !== "agent_message_status" || result.result.outcome !== "found")
        throw new Error("Original owner receipt unavailable");
      const expected =
        mode === "stable" || mode === "fresh-session" ? ["delivered", "acted_on", "answered"] : ["delivered"];
      expect(result.result.receipt.progress.map((entry) => entry.stage)).toEqual(expected);
      expect(JSON.stringify(await f.receiptSnapshot())).not.toContain("PRIVATE_NATIVE_ANSWER_CANARY");
      expect(JSON.stringify(await f.receiptSnapshot())).not.toContain("sk-proj-" + "z".repeat(90));
      if (mode === "fresh-session") {
        const fresh = await f.client();
        expect(
          decoded(
            await fresh.callTool({ name: "message_agent_status", arguments: { receiptId: sent.receiptId } }),
          ).outcome,
        ).toBe("unknown");
        expect(
          decoded(
            await client.callTool({ name: "message_agent_status", arguments: { receiptId: sent.receiptId } }),
          ).outcome,
        ).toBe("found");
      }
      if (mode === "revoked")
        expect(
          (await f.post({ op: "agent_message_status", schemaVersion: 1, receiptId: sent.receiptId })).status,
        ).toBe(401);
      if (mode === "shutdown") {
        for (let index = 0; index < 3; index++)
          expect(
            decoded(
              await client.callTool({
                name: "message_agent_status",
                arguments: { receiptId: sent.receiptId },
              }),
            ).outcome,
          ).toBe("found");
        expect(reads).toBe(1);
        expect(observation).toHaveBeenCalledTimes(1);
      }
      expect(native.sendCommands()).toBe(before + 1);
    } finally {
      observation.mockRestore();
    }
  },
);

it("keeps two identical Grok messages attached to their own native completions", async () => {
  const observation = vi.spyOn(AgentMessageObservations.prototype, "start");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const native = await grokReceiptFixture();
    const original = native.control;
    let enteredRead = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredRead = resolve;
    });
    let reads = 0;
    const control: SeatControl = {
      ...original,
      settled: async (...args) => {
        if (++reads === 1) {
          enteredRead();
          await gate;
        }
        return original.settled(...args);
      },
    };
    const f = await fixture({ control });
    const client = await f.client();
    const send = async () =>
      decoded(
        await client.callTool({
          name: "message_agent",
          arguments: { agent: "herdr:" + f.seat.seatId, message: "Same visible text", receipt: true },
        }),
      );
    const first = await send();
    await entered;
    const second = await send();
    expect(second.receiptId).not.toBe(first.receiptId);
    const secondDone = observation.mock.results[1]?.value;
    expect(secondDone).toBeInstanceOf(Promise);
    await secondDone;
    release();
    await observation.mock.results[0]!.value;
    for (const receiptId of [first.receiptId, second.receiptId]) {
      const result = decoded(
        await client.callTool({ name: "message_agent_status", arguments: { receiptId } }),
      );
      expect(result.outcome).toBe("found");
      expect(result.receipt.progress.map((entry: { stage: string }) => entry.stage)).toEqual([
        "delivered",
        "acted_on",
      ]);
    }
    expect(native.admitted()).toBe(2);
  } finally {
    release();
    observation.mockRestore();
  }
});

it("does not retarget a Pi settlement to the next native input", async () => {
  const native = await piFixture();
  const { prepared } = await native.prepare();
  const started = await prepared.start(native.view);
  if (started.outcome !== "started") throw new Error("Native Pi fixture failed");
  native.finish("Bootstrap");
  const first = await started.control.send("Same visible text");
  expect(first.outcome).toBe("accepted");
  if (first.outcome !== "accepted") throw new Error("First native input was refused");
  native.finish("First answer");
  const second = await started.control.send("Same visible text");
  expect(second.outcome).toBe("accepted");
  if (second.outcome !== "accepted") throw new Error("Second native input was refused");
  native.finish("Second answer");
  expect(await started.control.settled(AbortSignal.timeout(2000), first.messageId)).toMatchObject({
    type: "settlement_unconfirmed",
    reason: "message_correlation_unavailable",
  });
  expect(await started.control.settled(AbortSignal.timeout(2000), second.messageId)).toMatchObject({
    type: "turn_completed",
    messageId: second.messageId,
    text: "Second answer",
  });
});
