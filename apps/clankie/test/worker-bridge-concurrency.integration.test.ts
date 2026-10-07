import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { FileCredentialStore } from "@clankie/credential-broker";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import { PeerSeatMessages } from "../src/captain/peer-seat-messages.ts";
import { createStubCaptain, type LaneTool } from "../src/captain/port.ts";
import type { ProjectHireProcessProof } from "../src/captain/project-hires.ts";
import {
  FleetAdmissionUnavailableError,
  fleetAdmissionUnavailableResponse,
} from "../src/local-fleet-admission.ts";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { createMcpHost, type McpHostOptions } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

const bridgeModule = fileURLToPath(
  new URL("../../../integrations/claude-plugin/worker/bin/seat-channel.mjs", import.meta.url),
);
const fleetTools = ["clankie_tools", "clankie_call"];
const peerTools = ["list_fleet_seats", "message_peer"];
const expectedHireTools = [...fleetTools, ...peerTools].sort();
const nativeCatalogTools = ["message_clankie", ...expectedHireTools];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function listen(
  service: Awaited<ReturnType<typeof createClankieApp>>,
  local?: LocalFleetLink,
  observe?: (request: Request) => Promise<Response | undefined>,
) {
  const forward = local?.fetch((request) => service.app.fetch(request));
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, env) => {
      const refusal = await observe?.(request);
      if (refusal) return refusal;
      return forward ? forward(request, env) : service.app.fetch(request);
    },
  }) as HttpServer;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener has no TCP address");
  if (local) await local.publish(address.port);
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type NativeBridge = {
  client: Client;
  transport: StdioClientTransport;
  expected: readonly string[];
  startedAt: string;
  stderr: string;
};

/** Native TUI/Herdr observations are fixtures; hire admission and every MCP hop are production. */
async function fixture(
  requestTimeoutMs = 5_000,
  options: {
    host?: Pick<McpHostOptions, "writeAuthorityForWorker" | "observeCall">;
    stallProjectProof?: boolean;
    unrelatedAccount?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "clankie-worker-concurrency-"));
  const stateDirectory = join(root, ".clankie");
  const socketPath = join(root, "herdr.sock");
  const response = gate();
  const allReadsAdmitted = gate();
  const stalledReadAdmitted = gate();
  const calls: { provider: string; id: string }[] = [];
  const bindings: string[] = [];
  const projectProofSignals: (AbortSignal | undefined)[] = [];
  const agents = new Map<string, HerdrAgentSnapshot>();
  const bridges = new Map<string, NativeBridge>();
  const receivedPeerMessages: { seatId: string; text: string }[] = [];
  const providerToken = randomUUID();
  let providerSessions = 0;

  const provider = async (name: string) => {
    const tools: LaneTool[] = [
      {
        name: "get_issue",
        description: "Read one issue from this isolated tracker fixture.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        async call(args) {
          const id = String(args.id);
          calls.push({ provider: name, id });
          if (calls.filter((call) => call.id.startsWith("VUH-read-")).length === 6)
            allReadsAdmitted.release();
          if (id === "VUH-stall") stalledReadAdmitted.release();
          if (id.startsWith("VUH-read-") || id === "VUH-stall") await response.promise;
          return { content: [{ type: "text", text: JSON.stringify({ id, provider: name }) }] };
        },
      },
      {
        name: "save_project_update",
        description: "Publish an update in this isolated tracker fixture.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        async call(args) {
          const id = String(args.id);
          calls.push({ provider: name, id });
          return { content: [{ type: "text", text: JSON.stringify({ id, provider: name }) }] };
        },
      },
    ];
    const service = await createClankieApp({
      captain: createStubCaptain({
        laneToolBank: async (lane) => {
          providerSessions++;
          return { lane, tools };
        },
      }),
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === `Bearer ${providerToken}`
          ? { operatorId: "fixture-tracker" }
          : undefined,
    });
    return listen(service);
  };
  const original = await provider("original");
  const replacement = await provider("replacement");
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await credentials.set("linear", {
    type: "api",
    key: providerToken,
    account: {
      provider: "linear",
      actor: "app",
      connectionId: randomUUID(),
      userId: "fixture-app",
      workspaceId: "fixture-workspace",
      name: "Fixture Clankie app",
      workspaceName: "Isolated tracker",
      verifiedAt: new Date().toISOString(),
    },
  });
  if (options.unrelatedAccount) await credentials.set("unverified", { type: "api", key: providerToken });
  const settings = new SettingsStore(join(root, "settings.json"));
  const setProvider = async (url: string) => {
    await settings.update((current) => ({
      ...current,
      mcp: {
        ...current.mcp,
        servers: [
          {
            id: "linear",
            transport: "http",
            url: `${url}/v1/mcp`,
            args: [],
            lane: "operator",
            credential: "linear",
            initialTools: ["get_issue"],
            enabled: true,
          },
          ...(options.unrelatedAccount
            ? [
                {
                  id: "unverified",
                  transport: "http" as const,
                  url: `${url}/v1/mcp`,
                  args: [],
                  lane: "operator" as const,
                  credential: "unverified",
                  initialTools: ["get_issue"],
                  enabled: true,
                },
              ]
            : []),
        ],
      },
    }));
  };
  await setProvider(original.url);
  const host = createMcpHost({
    credentials,
    settings,
    curated: [],
    logger: { info() {}, warn() {} },
    ...options.host,
  });
  // Observe calls through the real binding implementation; no account result
  // is replaced. Exact invocation must not inspect unrelated account authority.
  const binding = host.binding!.bind(host);
  host.binding = async (server, lane) => {
    bindings.push(server);
    return binding(server, lane);
  };
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    requestTimeoutMs,
    fleetTools: async () => "connected",
    fleetPeerMessages: async () => "on",
    fleetToolsSnapshot: async () => ({ tools: "connected", assertCurrent() {} }),
  });
  const proof = (pane: string): ProjectHireProcessProof | undefined => {
    const agent = agents.get(pane);
    const bridge = bridges.get(pane);
    if (!agent?.session || !bridge?.transport.pid) return undefined;
    return {
      nativeOccupantId: occupantIdForHerdrSession(agent.session),
      fleet: "default",
      pane,
      binding: { socketPath, session: "fixture" },
      processes: [{ pid: bridge.transport.pid, startTime: bridge.startedAt }],
      shell: { pid: process.pid, startTime: "fixture-parent" },
    };
  };
  let refusalMode: "once" | "held" | "nonmember" | undefined;
  const local = new LocalFleetLink({
    directory: join(stateDirectory, "links"),
    binding: async () => ({ runtime: "external", socketPath, session: "fixture" }),
    prove: async (_socket, pane) => {
      if (refusalMode && refusalMode !== "once") {
        if (refusalMode === "nonmember") return false;
        throw new FleetAdmissionUnavailableError("Fixture native observations temporarily unavailable");
      }
      return proof(pane) !== undefined;
    },
    projectProof: async (_socket, pane, signal) => {
      projectProofSignals.push(signal);
      if (options.stallProjectProof) {
        await new Promise<void>((_resolve, reject) => {
          if (!signal) throw new Error("Optional author proof must have a cancellation deadline");
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      return proof(pane);
    },
  });
  const peer = new PeerSeatMessages({
    path: join(root, "peer-receipts.json"),
    enabled: async () => true,
    sender: async (pane) => agents.get(pane),
    recipient: async (seatId) => [...agents.values()].find((agent) => agent.terminalId === seatId),
    seats: async () => [...agents.values()],
    async deliver(seatId, text, options) {
      const target = [...agents.values()].find((agent) => agent.terminalId === seatId);
      if (!(await options.fence?.(target)))
        return { outcome: "undelivered", detail: "Fixture native binding changed." };
      receivedPeerMessages.push({ seatId, text });
      return { outcome: "delivered", messageId: randomUUID(), state: "queued" };
    },
    record() {},
  });
  const service = await createClankieApp({
    captain: createStubCaptain({
      listFleetPeerSeats: (authority) => peer.list(authority),
      sendFleetPeerMessage: (authority, input) => peer.send(authority, input),
      reconcileFleetPeerMessage: (authority, delivery, fingerprint) =>
        peer.reconcile(authority, delivery, fingerprint),
    }),
    workerMcp: worker,
    localFleet: local,
    authenticateOperator: async () => undefined,
  });
  const admissionCalls: unknown[] = [];
  const listener = await listen(service, local, async (request) => {
    if (new URL(request.url).pathname !== "/v1/fleet/mcp" || request.method !== "POST") return;
    const body = await request
      .clone()
      .json()
      .catch(() => undefined);
    if (body?.method === "tools/call" && body.params?.name === "clankie_call") {
      admissionCalls.push(body);
      // Scope the one-shot refusal to this RPC. Background health discovery
      // must not consume the failure intended to exercise mutation admission.
      if (refusalMode === "once") {
        refusalMode = undefined;
        return fleetAdmissionUnavailableResponse();
      }
    }
    return undefined;
  });
  await writeFile(join(root, "auth.json"), "fixture profile presence only; no account sign-in");
  let nextPane = 0;
  const get = (pane: string) => {
    const agent = agents.get(pane);
    if (!agent) throw new Error(`Unknown fixture pane ${pane}`);
    return agent;
  };
  const runner: HerdrWatchRunner = {
    list: async () => [...agents.values()],
    get: async (pane) => get(pane),
    resolveTerminal: async (seatId) => [...agents.values()].find((agent) => agent.terminalId === seatId),
    wait: async (pane) => get(pane),
    createTab: async ({ label }) => {
      const pane = `w1:p${++nextPane}`;
      agents.set(pane, {
        paneId: pane,
        terminalId: `fixture-seat-${nextPane}`,
        title: label,
        agent: "shell",
        status: "idle",
      });
      return pane;
    },
    startAgent: async ({ paneId, name }) => {
      agents.set(paneId, {
        ...get(paneId),
        title: name,
        agent: "codex",
        status: "idle",
        session: { source: "codex", kind: "id", value: randomUUID() },
      });
    },
    runInPane: async () => {
      throw new Error("Fixture never types commands into a terminal");
    },
    closePane: async (pane) => {
      await bridges.get(pane)?.client.close();
      agents.delete(pane);
    },
  };
  const adapter: HarnessSeatAdapter = {
    harness: "codex",
    attach: async () => undefined,
    async start(_launch, view) {
      await view.guard?.();
      await view.start?.("codex", []);
      const ref = {
        harness: "codex" as const,
        paneId: view.paneId,
        sessionId: get(view.paneId).session!.value,
      };
      const client = new Client({ name: "fixture-native-worker", version: "1" }, {});
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `import {runSeatChannel} from ${JSON.stringify(bridgeModule)};runSeatChannel({paneId:${JSON.stringify(view.paneId)},parentArgv:"codex app-server --no-daemon"});`,
        ],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
          HOME: root,
          CLANKIE_STATE: stateDirectory,
          HERDR_SOCKET_PATH: socketPath,
          HERDR_PANE_ID: view.paneId,
          CLANKIE_EXPECTED_TOOL_NAMES: JSON.stringify(view.expectedToolNames ?? []),
        },
        stderr: "pipe",
      });
      const bridge: NativeBridge = {
        client,
        transport,
        expected: view.expectedToolNames ?? [],
        startedAt: new Date().toISOString(),
        stderr: "",
      };
      bridges.set(view.paneId, bridge);
      transport.stderr?.on("data", (chunk) => {
        bridge.stderr += String(chunk);
      });
      await client.connect(transport);
      const bound = await view.bound?.(ref);
      expect(bound && bound.expectedToolNames).toEqual(bridge.expected);
      await client.listTools();
      await view.guard?.();
      const control: SeatControl = {
        ref,
        send: async (_message, options) => {
          if (options?.beforeDispatch && !(await options.beforeDispatch())) return { outcome: "released" };
          return { outcome: "accepted", messageId: randomUUID(), state: "queued" };
        },
        status: async () => "idle",
        settled: async () => ({ type: "released", at: new Date().toISOString() }),
        interrupt: async () => false,
        close: () => client.close(),
      };
      return { outcome: "started", control };
    },
  };
  const projectSettings = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "fixture",
        name: "Isolated concurrency fixture",
        workerCap: 6,
        roles: [
          {
            role: "Engineer",
            harness: "codex",
            concurrencyCap: 6,
            delegation: "native-first",
            account: "fixture",
          },
        ],
      },
    ],
  });
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    runner,
    codexAccounts: async () => [{ label: "fixture", home: root }],
    seatAdapters: [adapter],
    fleetHireTools: () => worker.expectedFleetToolNames(),
    projectHirePolicy: {
      settings: async () => projectSettings,
      project: async () => "fixture",
      proof: async (fleet, pane) => (fleet === "default" ? proof(pane) : undefined),
      tools: (projectId) => worker.expectedProjectToolNames(projectId),
    },
  });
  return {
    refuseAdmission(mode: "once" | "held" | "nonmember") {
      refusalMode = mode;
      admissionCalls.length = 0;
    },
    refusalChecks: () => admissionCalls.length,
    admissionCalls,
    bridges,
    calls,
    bindings,
    projectProofSignals,
    response,
    allReadsAdmitted,
    stalledReadAdmitted,
    receivedPeerMessages,
    bridgeStatus: (pane: string) => worker.bridgeStatus("default", pane),
    providerSessions: () => providerSessions,
    replaceProvider: () => setProvider(replacement.url),
    async hire(count = 6) {
      return Promise.all(
        Array.from({ length: count }, async (_, i) => {
          const workingDirectory = join(root, `workspace-${i}`);
          await mkdir(workingDirectory);
          return store.spawnSeat(
            {
              schemaVersion: 1,
              workingDirectory,
              title: `Concurrent worker ${i}`,
              role: "Engineer",
              deliverable: `VUH-fixture-${i}`,
            },
            undefined,
            "Read your assigned issue through Clankie's connected tracker.",
          );
        }),
      );
    },
    async close() {
      response.release();
      store.close();
      await Promise.allSettled([...bridges.values()].map((bridge) => bridge.client.close()));
      await worker.close();
      await host.close();
      await local.close();
      await Promise.all([listener.close(), original.close(), replacement.close()]);
      await rm(root, { recursive: true, force: true });
    },
  };
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  CallToolResultSchema.parse(result)
    .content.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

it("reads through the native worker bridge without optional native publishing proof", async () => {
  let authorRequests = 0;
  const f = await fixture(2_000, {
    stallProjectProof: true,
    host: {
      writeAuthorityForWorker: async (_principal, observe) => {
        authorRequests++;
        await observe?.();
        return undefined;
      },
    },
  });
  try {
    expect((await f.hire(1))[0]?.outcome).toBe("spawned");
    const worker = [...f.bridges.values()][0]!;
    const read = await worker.client.callTool({
      name: "clankie_call",
      arguments: { name: "linear_get_issue", arguments: { id: "VUH-independent-read" } },
    });
    expect(JSON.parse(text(read))).toMatchObject({ outcome: "ok", receiptId: expect.any(String) });
    expect(f.calls).toEqual([{ provider: "original", id: "VUH-independent-read" }]);
    expect(authorRequests).toBe(0);
    expect(f.projectProofSignals).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each(["capture", "revalidation"] as const)(
  "bounds optional author %s without blocking or attributing the independent connected write",
  async (stage) => {
    let authorRequests = 0;
    const attribution: unknown[] = [];
    const f = await fixture(2_000, {
      stallProjectProof: true,
      host: {
        writeAuthorityForWorker: async (_principal, observe) => {
          authorRequests++;
          if (stage === "capture") {
            await observe?.();
            return undefined;
          }
          return {
            nativeRecipientAuthority: {
              recipient: {
                kind: "native",
                paneId: "default/w1:p1",
                seatId: "fixture-seat-1",
                occupantId: "fixture-original",
                binding: "a".repeat(64),
              },
              current: () => true,
              authorize: async () => {
                await observe?.();
                return true;
              },
            },
          };
        },
        observeCall: (call) => void attribution.push({ owner: call.owner, recipient: call.recipient }),
      },
    });
    try {
      expect((await f.hire(1))[0]?.outcome).toBe("spawned");
      const worker = [...f.bridges.values()][0]!;
      const started = performance.now();
      const write = await worker.client.callTool({
        name: "clankie_call",
        arguments: { name: "linear_save_project_update", arguments: { id: `VUH-write-${stage}` } },
      });
      expect(JSON.parse(text(write))).toMatchObject({ outcome: "ok", receiptId: expect.any(String) });
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(authorRequests).toBe(1);
      expect(f.projectProofSignals).toHaveLength(1);
      expect(f.projectProofSignals[0]?.aborted).toBe(true);
      expect(attribution).toEqual([{ owner: undefined, recipient: undefined }]);
      expect(f.calls).toEqual([{ provider: "original", id: `VUH-write-${stage}` }]);
    } finally {
      await f.close();
    }
  },
);

it("verifies only the exact tool account on invocation and receipt lookup while discovery spans all accounts", async () => {
  const f = await fixture(5_000, { unrelatedAccount: true });
  try {
    expect((await f.hire(1))[0]?.outcome).toBe("spawned");
    const worker = [...f.bridges.values()][0]!;
    const search = await worker.client.callTool({ name: "clankie_tools", arguments: { query: "issue" } });
    expect(text(search)).toContain("linear_get_issue");
    expect(f.bindings).toContain("unverified");
    f.bindings.length = 0;
    const read = await worker.client.callTool({
      name: "clankie_call",
      arguments: { name: "linear_get_issue", arguments: { id: "VUH-exact-account" } },
    });
    const receipt = JSON.parse(text(read));
    expect(receipt).toMatchObject({ outcome: "ok", receiptId: expect.any(String) });
    expect(f.bindings.length).toBeGreaterThan(0);
    expect(new Set(f.bindings)).toEqual(new Set(["linear"]));
    f.bindings.length = 0;
    const reconciled = await worker.client.callTool({
      name: "clankie_call",
      arguments: { receiptId: receipt.receiptId },
    });
    expect(JSON.parse(text(reconciled))).toMatchObject({ outcome: "ok", receiptId: receipt.receiptId });
    expect(new Set(f.bindings)).toEqual(new Set(["linear"]));
    expect(f.calls).toEqual([{ provider: "original", id: "VUH-exact-account" }]);
  } finally {
    await f.close();
  }
});

it("keeps six native-first hires' tools and admitted tracker reads through shared client replacement", async () => {
  const f = await fixture();
  try {
    const hires = await f.hire();
    expect(hires.map((hire) => hire.outcome)).toEqual(Array(6).fill("spawned"));
    const workers = [...f.bridges.values()];
    expect(workers).toHaveLength(6);
    for (const bridge of workers) expect(bridge.expected).toEqual(expectedHireTools);
    const catalogs = await Promise.all(workers.map((bridge) => bridge.client.listTools()));
    for (const catalog of catalogs)
      expect(catalog.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(nativeCatalogTools));
    const reads = workers.map((bridge, i) =>
      bridge.client.callTool({
        name: "clankie_call",
        arguments: { name: "linear_get_issue", arguments: { id: `VUH-read-${i}` } },
      }),
    );
    await Promise.race([
      f.allReadsAdmitted.promise,
      Promise.all(reads).then((results) => {
        throw new Error(`Tracker reads returned before admission: ${results.map(text).join("; ")}`);
      }),
    ]);
    await f.replaceProvider();
    for (let i = 0; i < 3; i++) {
      const listed = await Promise.all(workers.map((bridge) => bridge.client.listTools()));
      for (const catalog of listed)
        expect(catalog.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(nativeCatalogTools));
      const searched = await Promise.all(
        workers.map((bridge) =>
          bridge.client.callTool({ name: "clankie_tools", arguments: { query: "linear get issue" } }),
        ),
      );
      for (const result of searched) expect(text(result)).toContain("linear_get_issue");
    }
    const replacementRead = await workers[0]!.client.callTool({
      name: "clankie_call",
      arguments: { name: "linear_get_issue", arguments: { id: "VUH-after-replacement" } },
    });
    expect(replacementRead.isError).not.toBe(true);
    const replacementReceipt = JSON.parse(text(replacementRead));
    expect(replacementReceipt).toMatchObject({ outcome: "ok", receiptId: expect.any(String) });
    expect(JSON.parse(replacementReceipt.content)).toMatchObject({ provider: "replacement" });
    f.response.release();
    const completed = await Promise.all(reads);
    for (const [i, result] of completed.entries()) {
      expect(result.isError, `VUH-read-${i}: ${text(result)}`).not.toBe(true);
      const receipt = JSON.parse(text(result));
      expect(receipt).toMatchObject({ outcome: "ok", receiptId: expect.any(String) });
      expect(JSON.parse(receipt.content)).toMatchObject({ id: `VUH-read-${i}`, provider: "original" });
    }
    expect(f.calls.filter((call) => call.id.startsWith("VUH-read-"))).toHaveLength(6);
    expect(f.providerSessions()).toBe(2);
    const roster = await workers[0]!.client.callTool({ name: "list_fleet_seats", arguments: {} });
    expect(roster.isError).not.toBe(true);
    const peer = JSON.parse(text(roster)).seats[0];
    const delivered = await workers[0]!.client.callTool({
      name: "message_peer",
      arguments: { seat: peer.seatId, text: "Fixture peer interface is ready." },
    });
    expect(delivered.isError).not.toBe(true);
    expect(f.receivedPeerMessages).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("returns a specific stalled tracker error within the worker request budget and keeps its catalog", async () => {
  const f = await fixture(250);
  try {
    expect((await f.hire(1))[0]?.outcome).toBe("spawned");
    const worker = [...f.bridges.values()][0]!;
    const started = performance.now();
    const pending = worker.client.callTool({
      name: "clankie_call",
      arguments: { name: "linear_get_issue", arguments: { id: "VUH-stall" } },
    });
    await Promise.race([
      f.stalledReadAdmitted.promise,
      pending.then((result) => {
        throw new Error(`Stalled tracker read returned before admission: ${text(result)}`);
      }),
    ]);
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(JSON.parse(text(result))).toMatchObject({
      outcome: "uncertain",
      receiptId: expect.any(String),
      detail: "may have applied; reconcile, don’t retry",
    });
    expect(text(result)).toMatch(/timed out|timeout|deadline/iu);
    expect(text(result)).not.toContain("inspect the current grant and account");
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(f.calls.filter((call) => call.id === "VUH-stall")).toHaveLength(1);
    expect(f.bridgeStatus("w1:p1")).toMatchObject({
      status: "stalled",
      reason: expect.stringMatching(/timed out|timeout|deadline/iu),
    });
    expect((await worker.client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(nativeCatalogTools),
    );
    expect(f.bridgeStatus("w1:p1").status).toBe("stalled");
  } finally {
    await f.close();
  }
});

it.each(["once", "held", "nonmember"] as const)(
  "shared native connected-call bridge handles %s admission refusal before dispatch",
  async (mode) => {
    const f = await fixture();
    try {
      expect((await f.hire(1))[0]?.outcome).toBe("spawned");
      const worker = [...f.bridges.values()][0]!;
      f.refuseAdmission(mode);
      const result = await worker.client.callTool({
        name: "clankie_call",
        arguments: { name: "linear_save_project_update", arguments: { id: "VUH-admission" } },
      });
      const receipt = JSON.parse(text(result));
      if (mode === "once") {
        expect(receipt.outcome).toBe("ok");
        expect(f.calls).toEqual([{ provider: "original", id: "VUH-admission" }]);
      } else {
        expect(receipt.outcome).toBe("refused");
        expect(f.calls).toEqual([]);
        expect(receipt).not.toHaveProperty("receiptId");
        if (mode === "held")
          expect(receipt).toMatchObject({
            retryable: true,
            detail: expect.stringContaining("Wait briefly and retry"),
          });
        else expect(receipt.detail).toContain("Ask Clankie");
      }
      expect(f.refusalChecks()).toBe(mode === "nonmember" ? 1 : 2);
      if (mode !== "nonmember") expect(f.admissionCalls[1]).toEqual(f.admissionCalls[0]);
    } finally {
      await f.close();
    }
  },
);

it.each(["held", "nonmember"] as const)(
  "preserves the original connected receipt when %s admission prevents reconciliation",
  async (mode) => {
    const f = await fixture();
    try {
      expect((await f.hire(1))[0]?.outcome).toBe("spawned");
      const worker = [...f.bridges.values()][0]!;
      const original = JSON.parse(
        text(
          await worker.client.callTool({
            name: "clankie_call",
            arguments: { name: "linear_save_project_update", arguments: { id: "VUH-original" } },
          }),
        ),
      );
      expect(original.outcome).toBe("ok");
      f.refuseAdmission(mode);
      const reconciled = await worker.client.callTool({
        name: "clankie_call",
        arguments: { receiptId: original.receiptId },
      });
      expect(JSON.parse(text(reconciled))).toMatchObject({
        outcome: "uncertain",
        receiptId: original.receiptId,
      });
      expect(reconciled.isError).toBe(false);
      expect(f.calls).toEqual([{ provider: "original", id: "VUH-original" }]);
    } finally {
      await f.close();
    }
  },
);
