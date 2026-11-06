import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CONNECTOR_GRANTS } from "@clankie/protocol";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { SettingsStore } from "@clankie/settings";
import {
  FileCredentialStore,
  mintOperatorToken,
  operatorCredentialReadFence,
} from "@clankie/credential-broker";
import { vi } from "vitest";
import { createClankieApp } from "../../src/app.ts";
import { createCaptain } from "../../src/captain/captain.ts";
import type { CaptainDeps } from "../../src/captain/deps.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../../src/captain/herdr-watch.ts";
import type { RemoteOpenCodeWorkers } from "../../src/captain/remote-opencode-workers.ts";
import type { FleetShellRun, HerdrFleet, HerdrFleetRun } from "../../src/herdr-fleet.ts";
import { AgentMessageReceipts } from "../../src/agent-message-receipts.ts";
import { ConnectorDetection } from "../../src/app/connector-detection.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../../src/device-session.ts";
import { createCredentialBackedOperatorAuthenticator } from "../../src/operator-auth.ts";
import { ControlPlaneDeviceAuthorizer } from "../../../relay/src/device-auth.ts";
import {
  createCaptainConversationDispatch,
  createDeviceConversationDispatch,
} from "../../../relay/src/conversation-upstream.ts";
import { createOperatorConversationRelayHandler } from "../../../relay/src/operator-conversations.ts";
import { createConnectorMcpHandler, createLoopbackConnectorOperator } from "../../../relay/src/connector-mcp.ts";
import { ClankieGuide } from "../../../relay/src/connector-guide.ts";

/** Each test's teardown, run in reverse by its test file's afterEach. */
export const closes: Array<() => Promise<unknown> | unknown> = [];

/** The seat lives on this machine instead of the fixture's own local pane. */
export interface LinkedMachine {
  readonly fleet: HerdrFleet;
  readonly run: HerdrFleetRun;
  readonly shell: FleetShellRun;
}

export const decoded = (value: Awaited<ReturnType<Client["callTool"]>>) => {
  const blocks = value.content as Array<{ type: string; text?: string }>;
  const text = blocks
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
  if (value.isError) throw new Error(text);
  return JSON.parse(text);
};

export async function fixture(
  pi?: { control: SeatControl; file?: string },
  linked?: LinkedMachine,
) {
  const root = await mkdtemp(join(tmpdir(), "agent-message-connector-"));
  closes.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv("HC_SOCKET", join(root, "no-owner-desktop.sock"));
  const state = join(root, "captain");
  await mkdir(state);
  const settings = new SettingsStore(join(root, "settings.json"));
  if (linked)
    await settings.update((current) => ({
      ...current,
      machines: [{ id: "linked-box", ssh: linked.fleet.ssh.host, shell: linked.fleet.ssh.shell, aliases: [] }],
      machineAccess: { "linked-box": "workers" },
      execution: {
        ...current.execution,
        connections: [
          {
            id: linked.fleet.id,
            machine: "linked-box",
            session: linked.fleet.session,
            ssh: linked.fleet.ssh,
          },
        ],
      },
    }));
  let nativeId = pi?.control.ref.sessionId ?? randomUUID(),
    sends = 0,
    queued = true,
    queueDetail = true;
  let nativeDetail = "The native queue is waiting for its turn.";
  let beforeNative: undefined | (() => Promise<void>);
  let afterAuthentication: undefined | (() => Promise<void>);
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
    list: async () => (linked ? [] : [live()]),
    get: async (pane) => {
      if (linked) throw new Error(`No local pane ${pane}`);
      return live();
    },
    resolveTerminal: async () => (linked ? undefined : live()),
    transcript: async () => undefined,
    wait: async (_target, signal) =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  };
  const census = async (_command: string, args: readonly string[]) => {
    const agent = live();
    const wires = (wire: unknown) => (linked ? [] : [wire]);
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
              : { agents: wires(wire) }
            : { snapshot: { workspaces: [], tabs: [], panes: wires(wire) } },
      }),
      stderr: "",
    };
  };
  const makeCaptain = () =>
    createCaptain(
      {
        herdrAvailable: () => true,
        ...(linked && {
          fleets: {
            list: [linked.fleet],
            run: () => linked.run,
            shell: () => linked.shell,
            remoteWorkspace: async () => true,
          },
        }),
      } as CaptainDeps,
      {
      repoRoot: root,
      stateDir: state,
      workingDirectory: root,
      settings,
      seatAdapters: linked ? [] : [adapter],
      // The one per-fleet adapter a captain takes from outside; the rest need a real hire.
      ...(linked && pi
        ? {
            remoteOpenCode: {
              forFleet: () => ({ adapter }),
              close: async () => {},
            } as unknown as RemoteOpenCodeWorkers,
          }
        : {}),
      nativeHerdrRunner: runner,
      nativeCensusRunner: census,
      nativeSummariesPath: join(root, "summaries.json"),
      discordEnvironment: {},
      fleetRoundIntervalMs: 3600_000,
      },
    );
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
      authenticateCaptain: async (request) => {
        const result =
          request.headers.get("authorization") === "Bearer fixture-relay-credential-176"
            ? { captainId: "relay", steerSourceLane: "api" as const }
            : undefined;
        await afterAuthentication?.();
        return result;
      },
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
      guide: new ClankieGuide(resolve(import.meta.dirname, "../../../..")),
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
    afterAuthentication: (hook: () => Promise<void>) => {
      afterAuthentication = hook;
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
