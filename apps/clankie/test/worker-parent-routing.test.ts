import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import type { HttpBindings } from "@hono/node-server";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import {
  FleetSeatMessageReceiptSchema,
  OperatorConversationServiceResultSchema,
  OperatorConversationStreamEventSchema,
  OperatorSeatEventsPageSchema,
  fleetSeatEventsPath,
  fleetSeatHookPath,
  fleetSeatMessagesPath,
  type FleetSeatMessageDelivery,
  type OperatorConversationScope,
  type OperatorSeatEvent,
  type WorkerReportRouting,
} from "@clankie/protocol";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { LocalFleetLink, type LocalFleetIdentity } from "../src/local-fleet-link.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";

// Herdr transports are injected below. An unavailable native history/OS probe
// cannot escape the fixture into the owner's processes or an SSH connection.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: () => {
    throw new Error("External history and process probes are unavailable in this fixture");
  },
  spawn: () => {
    throw new Error("Unrequested external process launch in parent routing fixture");
  },
}));

interface NativeRow {
  pane_id: string;
  terminal_id: string;
  agent: string;
  agent_status: string;
  title: string;
  name?: string;
  agent_session: { source: string; kind: "id"; value: string };
  cwd?: string;
  parent_pane_id?: string;
}

const WORKER = "w3Z:p1G";
const PARENT = "w3Z:pH";
const roots: string[] = [];
const services: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function row(pane: string, terminal: string, parent?: string): NativeRow {
  return {
    pane_id: pane,
    terminal_id: terminal,
    agent: "claude",
    agent_status: "working",
    title: pane === PARENT ? "Clankie" : "worker",
    agent_session: { source: "herdr:claude", kind: "id", value: randomUUID() },
    ...(parent === undefined ? {} : { parent_pane_id: parent }),
  };
}

/** Raw Herdr and kernel observations are the only substituted dependencies. */
async function fixture(
  options: {
    remote?: boolean;
    parent?: boolean;
    parentAdapter?: boolean;
    nonApiCaptain?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "worker-parent-routing-"));
  roots.push(root);
  const local = [row(WORKER, "term_aaa", options.parent === false ? undefined : PARENT)];
  if (options.parent !== false) local.push(row(PARENT, "term_bbb"));
  const remote = options.remote ? structuredClone(local) : [];
  for (const native of remote) native.agent_session.value = randomUUID();
  const rows = options.remote ? remote : local;
  const nativeSends: string[] = [];
  let nativeReplyLost = false;
  const calls: Array<{ fleet: string; args: readonly string[] }> = [];
  let failRemoteInventory: "unavailable" | "missing" | "malformed" | "unidentified" | undefined;
  let inventoryFailures = 0;
  let gate: { remaining: number; entered(): void; wait: Promise<void> } | undefined;
  const execute = async (fleet: string, args: readonly string[], signal?: AbortSignal) => {
    calls.push({ fleet, args });
    if (failRemoteInventory && fleet === "away" && args[0] === "pane" && args[1] === "list") {
      const failure = failRemoteInventory;
      failRemoteInventory = undefined;
      inventoryFailures += 1;
      if (failure === "missing") return JSON.stringify({ result: { agents: [] } });
      if (failure === "malformed") return JSON.stringify({ result: { panes: [{}] } });
      if (failure === "unidentified") {
        const panes = structuredClone(remote);
        return JSON.stringify({
          result: { panes: panes.map(({ agent_session: _session, ...pane }) => pane) },
        });
      }
      throw new Error("Linked native inventory is unavailable");
    }
    const current = fleet === "default" ? local : remote;
    if (args[0] === "agent" && args[1] === "wait") {
      return new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    let result: unknown;
    if (args[0] === "agent" && args[1] === "get") {
      const agent = current.find((item) => item.pane_id === args[2] || item.terminal_id === args[2]);
      if (!agent) throw new Error("agent_not_found");
      result = { agent: structuredClone(agent) };
    } else if ((args[0] === "agent" && args[1] === "list") || (args[0] === "api" && args[1] === "snapshot")) {
      const agents = structuredClone(current);
      result = args[0] === "api" ? { snapshot: { agents, panes: structuredClone(current) } } : { agents };
      const authorityCensus = options.remote
        ? fleet === "away" && args[0] === "api"
        : fleet === "default" && args[0] === "agent";
      if (authorityCensus && gate && --gate.remaining === 0) {
        const held = gate;
        gate = undefined;
        held.entered();
        await held.wait;
      }
    } else if (args[0] === "pane" && args[1] === "list") {
      result = { panes: structuredClone(current) };
    } else if (args[0] === "workspace" && args[1] === "list") {
      result = { workspaces: [] };
    } else {
      throw new Error(`Unexpected external command: ${fleet} ${args.join(" ")}`);
    }
    return JSON.stringify({ result });
  };
  const proof = (fleet: string, pane: string): ProjectProcessProof | undefined => {
    const native = (fleet === "default" ? local : remote).find((item) => item.pane_id === pane);
    return (
      native && {
        fleet,
        pane,
        nativeOccupantId: occupantIdForHerdrSession(native.agent_session),
        binding: { socketPath: join(root, `${fleet}.socket`) },
        shell: { pid: 10, startTime: "kernel-shell-start" },
        processes: [{ pid: 20, startTime: "kernel-native-start" }],
      }
    );
  };
  const settings = new SettingsStore(join(root, "settings.json"));
  const adapter = options.parentAdapter
    ? createCodexSeatAdapter({
        trackerOverrides: async () => [],
        herdr: async () => undefined,
        start: async (input) => {
          if (!input.startView) throw new Error("Native provider fixture requires an interactive view hook");
          const observeNativeEvent = input.onEvent;
          if (!observeNativeEvent) throw new Error("Native provider fixture requires an event observer");
          await input.startView(["--remote", "unix:///fixture-native.socket"]);
          return {
            threadId: rows[1]!.agent_session.value,
            viewArgs: ["--remote", "unix:///fixture-native.socket"],
            send: async (text, guard) => {
              await guard?.();
              nativeSends.push(text);
              if (nativeReplyLost) throw new Error("Native provider accepted input but lost its receipt");
              const turnId = randomUUID();
              observeNativeEvent({
                method: "turn/started",
                params: { threadId: rows[1]!.agent_session.value, turn: { id: turnId } },
              });
              return { turnId, state: "started" };
            },
            interrupt: async () => true,
            close: async () => undefined,
          };
        },
      })
    : undefined;
  if (adapter) {
    rows[1]!.agent = "codex";
    rows[1]!.agent_session.source = "herdr:codex";
    expect(
      await adapter.start(
        { harness: "codex", cwd: root, brief: "", resumeSessionId: rows[1]!.agent_session.value },
        { paneId: PARENT, run: async () => undefined },
      ),
    ).toMatchObject({ outcome: "started" });
  }
  const open = async () => {
    const deps = {
      herdrAvailable: () => true,
      memory: {},
      embodiment: {},
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp: { catalog: async () => [], call: async () => ({ outcome: "ok", content: "", isError: false }) },
      ...(options.remote
        ? {
            fleets: {
              list: [{ id: "away", session: "default", ssh: { host: "fixture.invalid", shell: "posix" } }],
              run: () => (args: readonly string[], signal?: AbortSignal) => execute("away", args, signal),
            },
          }
        : {}),
    } as unknown as CaptainDeps;
    const captain = createCaptain(deps, {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings,
      seatAdapters: adapter ? [adapter] : [],
      nativeHerdrRunner: createHerdrWatchRunner(
        () => true,
        (args, signal) => execute("default", args, signal),
      ),
      nativeCensusRunner: async (_command, args) => ({ stdout: await execute("default", args), stderr: "" }),
      nativeSummariesPath: join(root, "summaries.json"),
      discordEnvironment: {},
    });
    const link = new LocalFleetLink({
      directory: join(root, "local-link"),
      binding: async () => ({
        runtime: "external",
        session: "default",
        socketPath: join(root, "default.socket"),
      }),
      prove: async (_socket, pane) => proof("default", pane) !== undefined,
      projectProof: async (_socket, pane) => proof("default", pane),
    });
    const admitted = new WeakMap<Request, LocalFleetIdentity>();
    const app = await createClankieApp({
      captain,
      localFleet: link,
      fleetLinks: {
        authenticate: (token) => (token === "away-token" ? "away" : undefined),
        identity: (request) => admitted.get(request),
      },
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer operator"
          ? { operatorId: "fixture-owner", steerSourceLane: "tui" }
          : undefined,
      ...(options.nonApiCaptain
        ? {
            authenticateCaptain: async (request: Request) =>
              request.headers.get("authorization") === "Bearer discord-text"
                ? { captainId: "fixture-captain", steerSourceLane: "discord_text" as const }
                : undefined,
          }
        : {}),
    });
    const socket = { destroyed: false } as Socket;
    const localFetch = link.fetch((request) => app.app.fetch(request));
    const nativeRequest = async (pane: string, path: string, body?: unknown) => {
      const content = body === undefined ? undefined : JSON.stringify(body);
      const request = new Request(`http://localhost${path}`, {
        ...(content === undefined ? {} : { method: "POST", body: content }),
        headers: {
          "x-clankie-pane": pane,
          "content-type": "application/json",
          ...(content === undefined ? {} : { "content-length": String(Buffer.byteLength(content)) }),
          ...(options.remote ? { authorization: "Bearer away-token" } : {}),
        },
      });
      if (!options.remote) return localFetch(request, { incoming: { socket } } as HttpBindings);
      const original = proof("away", pane);
      admitted.set(request, {
        fleet: "away",
        pane,
        validate: async () => JSON.stringify(proof("away", pane)) === JSON.stringify(original),
        projectProof: async () => proof("away", pane),
      });
      try {
        return await app.app.fetch(request);
      } finally {
        admitted.delete(request);
      }
    };
    const operatorRequest = (path: string, body?: unknown, signal?: AbortSignal) =>
      app.app.request(path, {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
        headers: { authorization: "Bearer operator", "content-type": "application/json" },
      });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await link.close();
      app.close();
      await captain.close();
    };
    services.push({ close });
    return { captain, app, nativeRequest, operatorRequest, close };
  };
  const service = await open();
  return {
    root,
    rows,
    local,
    remote,
    calls,
    settings,
    service,
    open,
    nativeSends,
    failNextRemoteInventory: (failure: "unavailable" | "missing" | "malformed" | "unidentified") => {
      failRemoteInventory = failure;
    },
    inventoryFailures: () => inventoryFailures,
    loseNativeReply: () => {
      nativeReplyLost = true;
    },
    pane: (value: string) => (options.remote ? `away/${value}` : value),
    async pauseCensus(nth = 2) {
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { remaining: nth, entered, wait };
      return { ready, release };
    },
  };
}

type Service = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["open"]>>;

async function hook(
  service: Service,
  native: NativeRow,
  event: "SessionStart" | "UserPromptSubmit" = "SessionStart",
) {
  const response = await service.nativeRequest(native.pane_id, fleetSeatHookPath(native.pane_id), {
    schemaVersion: 1,
    event,
    sessionId: native.agent_session.value,
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function delivery(service: Service, pane = WORKER): Promise<FleetSeatMessageDelivery> {
  const response = await service.nativeRequest(pane, fleetSeatMessagesPath(pane));
  expect(response.status).toBe(200);
  const binding = (await response.json()).binding;
  expect(binding).toMatch(/^[a-f0-9]{64}$/u);
  return { id: randomUUID(), binding };
}

async function report(service: Service, text: string, receipt: FleetSeatMessageDelivery, pane = WORKER) {
  const response = await service.nativeRequest(pane, fleetSeatMessagesPath(pane), {
    schemaVersion: 1,
    text,
    delivery: receipt,
  });
  expect(response.status).toBe(200);
  return FleetSeatMessageReceiptSchema.parse(await response.json());
}

async function conversation(service: Service, scope: OperatorConversationScope = { kind: "global" }) {
  const result = OperatorConversationServiceResultSchema.parse(
    await service.captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "create",
      scope,
      title: "Parent routing lead",
    }),
  );
  if (result.op !== "create") throw new Error("Conversation creation failed");
  return result.conversation.conversationId;
}

async function poll(service: Service, conversationId: string) {
  const stop = new AbortController();
  const pending = service.operatorRequest(
    `/v1/seat/events?conversationId=${conversationId}&wait=30000`,
    undefined,
    stop.signal,
  );
  // Complete the HTTP authentication and real attachment reservation before ingress.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    stop,
    events: async () => {
      const response = await pending;
      expect(response.status).toBe(200);
      return OperatorSeatEventsPageSchema.parse(await response.json()).events;
    },
  };
}

function metas(root: string) {
  return readdirSync(join(root, "conversations")).map((id) =>
    JSON.parse(readFileSync(join(root, "conversations", id, "meta.json"), "utf8")),
  );
}

function accepted(root: string, id: string) {
  return metas(root).filter((meta) => meta.inboundAcceptances?.[id]);
}

async function roster(service: Service) {
  const result = OperatorConversationServiceResultSchema.parse(
    await service.captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" }),
  );
  if (result.op !== "roster") throw new Error("Roster unavailable");
  return result.seats;
}

async function diagnostic(service: Service, root: string, id: string, expected: WorkerReportRouting) {
  const [meta] = accepted(root, id);
  expect(meta.inboundAcceptances[id]).toMatchObject({ workerReportRouting: expected });
  const journal = readFileSync(join(root, "conversations", meta.conversationId, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => OperatorConversationStreamEventSchema.parse(JSON.parse(line)));
  expect(journal).toContainEqual(
    expect.objectContaining({
      type: "turn",
      phase: "accepted",
      runId: meta.inboundAcceptances[id].runId,
      workerReportRouting: expected,
    }),
  );
  if (meta.scope.kind === "seat" || meta.scope.kind === "persona") return meta;
  const result = OperatorConversationServiceResultSchema.parse(
    await service.captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "replay",
      replay: {
        schemaVersion: 1,
        conversationId: meta.conversationId,
        surfaceClientId: "worker-parent-regression",
      },
    }),
  );
  if (result.op !== "replay" || result.result.status !== "page")
    throw new Error("Conversation replay unavailable");
  expect(result.result.events).toContainEqual(
    expect.objectContaining({
      type: "turn",
      phase: "accepted",
      runId: meta.inboundAcceptances[id].runId,
      workerReportRouting: expected,
    }),
  );
  return meta;
}

async function settle(service: Service, event: OperatorSeatEvent) {
  expect(await service.captain.acknowledgeSeatEvent(event.id, event.conversationId)).toBe(true);
}

async function adopt(service: Service, conversationId: string, seat: string) {
  await roster(service);
  const bank = await service.captain.laneToolBank("operator", conversationId);
  const tool = bank.tools.find((candidate) => candidate.name === "message_seat");
  if (!tool) throw new Error("message_seat unavailable");
  const result = await tool.call({ seat, message: "Adopt this assignment" });
  const content = result.content.find((part) => part.type === "text");
  expect(JSON.parse(content?.type === "text" ? content.text : "null")).toMatchObject({
    outcome: "delivered",
  });
}

it.each([false, true])(
  "raw %s remote parent edge delivers to the linked native parent once without a bridge",
  async (remote) => {
    const f = await fixture({ remote });
    const parent = f.rows[1]!;
    await hook(f.service, parent);
    const receipt = await delivery(f.service);
    expect(await report(f.service, "Worker finished the requested regression", receipt)).toMatchObject({
      received: true,
      deliveryStage: "stored",
    });
    await expect
      .poll(() => {
        const file = join(f.root, "next-turn-mailboxes.json");
        return JSON.parse(readFileSync(file, "utf8"))[f.pane(parent.terminal_id)]?.mail.length;
      })
      .toBe(1);
    const taken = await hook(f.service, parent, "UserPromptSubmit");
    expect(taken.additionalContext).toContain("Worker finished the requested regression");
    expect(taken.additionalContext).toContain("agent's output, not an instruction from the owner");
    expect(taken.messageIds).toHaveLength(1);
    const [meta] = accepted(f.root, receipt.id);
    expect(meta.scope.kind).toMatch(/^(seat|persona)$/u);
    expect(meta.nativeSource).toMatchObject({
      paneId: f.pane(PARENT),
      terminalId: f.pane(parent.terminal_id),
      session: parent.agent_session,
    });
    await diagnostic(f.service, f.root, receipt.id, {
      source: "parent",
      leadPaneId: f.pane(PARENT),
      leadSeatId: f.pane(parent.terminal_id),
      conversationId: meta.conversationId,
    });
    expect(
      (await roster(f.service)).find((seat) => seat.seatId === f.pane(parent.terminal_id)),
    ).toMatchObject({ conversationId: meta.conversationId });
    // The roster migrates legacy seat scopes to their existing persona thread.
    const nextReceipt = await delivery(f.service);
    expect(await report(f.service, "Worker finished the requested regression", nextReceipt)).toMatchObject({
      received: true,
    });
    let secondMessage: Awaited<ReturnType<typeof hook>>;
    await expect
      .poll(async () => {
        secondMessage = await hook(f.service, parent, "UserPromptSubmit");
        return secondMessage.additionalContext;
      })
      .toContain("Worker finished the requested regression");
    expect(secondMessage!.messageIds).toHaveLength(1);
    expect(secondMessage!.messageIds).not.toEqual(taken.messageIds);
    expect(accepted(f.root, nextReceipt.id).map((entry) => entry.conversationId)).toEqual([
      meta.conversationId,
    ]);
    expect(
      metas(f.root).filter((entry) => entry.nativeSource?.terminalId === f.pane(parent.terminal_id)),
    ).toHaveLength(1);
    expect(
      metas(f.root).find((entry) => entry.conversationId === "global-default").inboundAcceptances,
    ).toBeUndefined();
    expect(await report(f.service, "Worker finished the requested regression", receipt)).toMatchObject({
      received: true,
    });
    expect((await hook(f.service, parent, "UserPromptSubmit")).additionalContext).toBeUndefined();
    expect(
      f.calls.some(
        (call) =>
          call.fleet === (remote ? "away" : "default") &&
          call.args[0] === (remote ? "api" : "agent") &&
          call.args[1] === (remote ? "snapshot" : "list"),
      ),
    ).toBe(true);
  },
);

it.each([false, true])(
  "an authenticated %s remote parent's native session routes to its live workspace outbox",
  async (remote) => {
    const f = await fixture({ remote });
    const parent = f.rows[1]!;
    const target = await conversation(f.service, { kind: "workspace", workspaceId: f.root });
    const upload = await f.service.operatorRequest(`/v1/seat/transcript?conversationId=${target}`, {
      sessionId: parent.agent_session.value,
      entries: [],
      activity: "waiting",
    });
    expect(upload.status).toBe(200);
    const attached = await poll(f.service, target);
    const receipt = await delivery(f.service);
    expect(await report(f.service, "Attached parent receives this", receipt)).toMatchObject({
      received: true,
    });
    const [event] = await attached.events();
    expect(event).toMatchObject({ conversationId: target, source: "worker-report", kind: "message" });
    expect(event!.content).toContain("Attached parent receives this");
    await diagnostic(f.service, f.root, receipt.id, {
      source: "parent",
      leadPaneId: f.pane(PARENT),
      leadSeatId: f.pane(parent.terminal_id),
      conversationId: target,
    });
    await settle(f.service, event!);
    const next = await poll(f.service, target);
    const repeated = await delivery(f.service);
    expect(await report(f.service, "Attached parent receives this", repeated)).toMatchObject({
      received: true,
    });
    const [second] = await next.events();
    expect(second!.content).toContain(`Worker report ${repeated.id}`);
    expect(second!.content).not.toContain(`Worker report ${receipt.id}`);
    await settle(f.service, second!);
  },
);

it("a managed clankie head excluded from fleet seats receives its native child's report in the attached global conversation", async () => {
  const f = await fixture();
  f.rows[1]!.name = "clankie";
  const seats = await roster(f.service);
  expect(seats.some((seat) => seat.seatId === "term_bbb")).toBe(false);
  expect(seats.find((seat) => seat.seatId === "term_aaa")).toMatchObject({ parentSeatId: "term_bbb" });
  expect(
    (
      await f.service.operatorRequest("/v1/seat/transcript?conversationId=global-default", {
        sessionId: f.rows[1]!.agent_session.value,
        entries: [],
        activity: "waiting",
      })
    ).status,
  ).toBe(200);
  const attached = await poll(f.service, "global-default");
  const receipt = await delivery(f.service);
  expect(await report(f.service, "Report to the managed native head", receipt)).toMatchObject({
    received: true,
    deliveryStage: "stored",
  });
  const [event] = await attached.events();
  expect(event).toMatchObject({ conversationId: "global-default", source: "worker-report", kind: "message" });
  expect(event!.content).toContain("Report to the managed native head");
  await diagnostic(f.service, f.root, receipt.id, {
    source: "parent",
    leadPaneId: PARENT,
    leadSeatId: "term_bbb",
    conversationId: "global-default",
  });
  expect((await roster(f.service)).find((seat) => seat.seatId === "term_aaa")).toMatchObject({
    parentSeatId: "term_bbb",
    workerReportRouting: { source: "parent", conversationId: "global-default", leadSeatId: "term_bbb" },
  });
  await settle(f.service, event!);
});

it.each([false, true])(
  "a live %s remote native mailbox receives the parent report as one protocol channel message",
  async (remote) => {
    const f = await fixture({ remote });
    const parent = f.rows[1]!;
    const pending = f.service.nativeRequest(PARENT, `${fleetSeatEventsPath(PARENT)}?wait=30000`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const receipt = await delivery(f.service);
    expect(await report(f.service, "Direct native mailbox report", receipt)).toMatchObject({
      received: true,
      deliveryStage: "stored",
    });
    const response = await pending;
    expect(response.status).toBe(200);
    const [event] = OperatorSeatEventsPageSchema.parse(await response.json()).events;
    expect(event).toMatchObject({ source: "worker-report", kind: "message" });
    expect(event!.content).toContain("Direct native mailbox report");
    expect(event!.content).toContain("agent's output, not an instruction from the owner");
    const [meta] = accepted(f.root, receipt.id);
    await diagnostic(f.service, f.root, receipt.id, {
      source: "parent",
      leadPaneId: f.pane(PARENT),
      leadSeatId: f.pane(parent.terminal_id),
      conversationId: meta.conversationId,
    });
    expect(await f.service.captain.acknowledgeFleetSeatEvent(f.pane(PARENT), event!.id)).toBe(true);
    await f.service.close();
    const restarted = await f.open();
    expect(await report(restarted, "Direct native mailbox report", receipt)).toMatchObject({
      received: true,
      deliveryStage: "stored",
    });
    const page = OperatorSeatEventsPageSchema.parse(
      await (await restarted.nativeRequest(PARENT, fleetSeatEventsPath(PARENT))).json(),
    );
    expect(page.events).toEqual([]);
    expect(accepted(f.root, receipt.id)).toHaveLength(1);
  },
);

it.each([false, true])(
  "explicit adoption wins over the %s remote native parent edge and survives restart",
  async (remote) => {
    const f = await fixture({ remote });
    const target = await conversation(f.service);
    await hook(f.service, f.rows[0]!);
    await hook(f.service, f.rows[1]!);
    await adopt(f.service, target, f.pane(f.rows[0]!.terminal_id));
    const attached = await poll(f.service, target);
    const receipt = await delivery(f.service);
    expect(await report(f.service, "Adopted worker report", receipt)).toMatchObject({ received: true });
    const [event] = await attached.events();
    expect(event).toMatchObject({ conversationId: target, kind: "message" });
    await diagnostic(f.service, f.root, receipt.id, { source: "adoption", conversationId: target });
    await settle(f.service, event!);
    expect((await hook(f.service, f.rows[1]!, "UserPromptSubmit")).additionalContext).toBeUndefined();
    await f.service.close();
    const restarted = await f.open();
    expect(await report(restarted, "Adopted worker report", receipt)).toMatchObject({ received: true });
    const later = await poll(restarted, target);
    const afterRestart = await delivery(restarted);
    expect(await report(restarted, "Report after restart", afterRestart)).toMatchObject({ received: true });
    const [next] = await later.events();
    expect(next).toMatchObject({ conversationId: target, kind: "message" });
    await diagnostic(restarted, f.root, afterRestart.id, { source: "adoption", conversationId: target });
    await settle(restarted, next!);
    expect(accepted(f.root, receipt.id)).toHaveLength(1);
  },
);

it.each(["no_parent", "parent_unavailable", "parent_unlinked"] as const)(
  "fallback %s is durably tagged at HTTP outbox and roster boundaries",
  async (reason) => {
    const f = await fixture({ parent: reason !== "no_parent" });
    if (reason === "parent_unavailable") f.rows.splice(1, 1);
    const global = await poll(f.service, "global-default");
    const receipt = await delivery(f.service);
    expect(await report(f.service, `Fallback ${reason}`, receipt)).toMatchObject({ received: true });
    const [event] = await global.events();
    const route = {
      source: "unadopted" as const,
      reason,
      conversationId: "global-default",
      ...(reason === "no_parent" ? {} : { leadPaneId: PARENT }),
      ...(reason === "parent_unlinked" ? { leadSeatId: "term_bbb" } : {}),
    };
    expect(event).toMatchObject({ conversationId: "global-default", kind: "message" });
    await diagnostic(f.service, f.root, receipt.id, route);
    expect((await roster(f.service)).find((seat) => seat.seatId === "term_aaa")).toMatchObject({
      workerReportRouting: route,
    });
    await settle(f.service, event!);
  },
);

it("a removed explicit owner falls back with owner_removed rather than inheriting the native parent", async () => {
  const f = await fixture();
  const target = await conversation(f.service);
  await hook(f.service, f.rows[0]!);
  await hook(f.service, f.rows[1]!);
  await adopt(f.service, target, "term_aaa");
  await f.service.captain.serveOperatorConversation({
    schemaVersion: 1,
    op: "close",
    conversationId: target,
  });
  const global = await poll(f.service, "global-default");
  const receipt = await delivery(f.service);
  expect(await report(f.service, "Gone adopted lead", receipt)).toMatchObject({ received: true });
  const [event] = await global.events();
  expect(event).toMatchObject({ conversationId: "global-default", kind: "message" });
  await diagnostic(f.service, f.root, receipt.id, {
    source: "unadopted",
    reason: "owner_removed",
    conversationId: "global-default",
  });
  expect((await hook(f.service, f.rows[1]!, "UserPromptSubmit")).additionalContext).toBeUndefined();
  await settle(f.service, event!);
});

it("the no-bridge w3Z:pH → w3Z:p1G golden case cannot borrow an identically labelled parent's link on another fleet", async () => {
  const f = await fixture({ remote: true });
  f.remote[0]!.agent = "codex";
  f.remote[0]!.agent_session.source = "herdr:codex";
  // The local pane has identical title, pane and terminal labels, but a different occupant.
  f.local[1]!.agent_session.value = randomUUID();
  const proof = {
    fleet: "default",
    pane: PARENT,
    nativeOccupantId: occupantIdForHerdrSession(f.local[1]!.agent_session),
    binding: { socketPath: join(f.root, "default.socket") },
    shell: { pid: 10, startTime: "local" },
    processes: [{ pid: 20, startTime: "local" }],
  };
  expect(
    await f.service.captain.recordSeatHook(
      PARENT,
      { schemaVersion: 1, event: "SessionStart", sessionId: f.local[1]!.agent_session.value },
      proof,
    ),
  ).toBe(true);
  const global = await poll(f.service, "global-default");
  const receipt = await delivery(f.service);
  expect(await report(f.service, "Remote child with only local parent link", receipt)).toMatchObject({
    received: true,
  });
  const [event] = await global.events();
  await diagnostic(f.service, f.root, receipt.id, {
    source: "unadopted",
    reason: "parent_unlinked",
    leadPaneId: "away/w3Z:pH",
    leadSeatId: "away/term_bbb",
    conversationId: "global-default",
  });
  await settle(f.service, event!);
  await hook(f.service, f.remote[1]!);
  expect(
    await report(f.service, "Now the correct remote parent is linked", await delivery(f.service)),
  ).toMatchObject({ received: true });
  await expect
    .poll(async () => (await hook(f.service, f.remote[1]!, "UserPromptSubmit")).additionalContext)
    .toContain("Now the correct remote parent is linked");
  expect(
    await f.service.captain.recordSeatHook(
      PARENT,
      { schemaVersion: 1, event: "UserPromptSubmit", sessionId: f.local[1]!.agent_session.value },
      proof,
    ),
  ).toBe(true);
});

it.each([false, true])(
  "a room-associated native parent without its original Discord authority refuses before acceptance (attached: %s)",
  async (live) => {
    const f = await fixture();
    const room = f.service.captain.bodyRoomConversation("discord_presence", "12345:67890");
    expect(
      f.service.captain.syncSeatTranscript(room, { sessionId: f.rows[1]!.agent_session.value, entries: [] }),
    ).toBe(true);
    await hook(f.service, f.rows[1]!);
    const attached = live ? await poll(f.service, room) : undefined;
    const global = await poll(f.service, "global-default");
    const receipt = await delivery(f.service);
    expect(await report(f.service, "Room attachment cannot grant tools", receipt)).toMatchObject({
      received: false,
      deliveryStage: "unavailable",
    });
    expect(accepted(f.root, receipt.id)).toEqual([]);
    attached?.stop.abort();
    global.stop.abort();
    if (attached) expect(await attached.events()).toEqual([]);
    expect(await global.events()).toEqual([]);
  },
);

it.each(["complete", "unavailable", "missing", "malformed", "unidentified"] as const)(
  "a bare native session association cannot borrow an equally named session on another fleet (inventory: %s)",
  async (inventory) => {
    const f = await fixture({ remote: true });
    f.remote[1]!.agent_session.value = f.local[1]!.agent_session.value;
    const target = await conversation(f.service, { kind: "workspace", workspaceId: f.root });
    expect(
      (
        await f.service.operatorRequest(`/v1/seat/transcript?conversationId=${target}`, {
          sessionId: f.local[1]!.agent_session.value,
          entries: [],
        })
      ).status,
    ).toBe(200);
    if (inventory !== "complete") f.failNextRemoteInventory(inventory);
    const attached = await poll(f.service, target);
    const global = await poll(f.service, "global-default");
    const receipt = await delivery(f.service);
    expect(await report(f.service, "Ambiguous native session cannot grant a route", receipt)).toMatchObject({
      received: false,
      deliveryStage: "unavailable",
    });
    expect(accepted(f.root, receipt.id)).toEqual([]);
    expect(f.inventoryFailures()).toBe(inventory === "complete" ? 0 : 1);
    expect(metas(f.root).find((meta) => meta.conversationId === target).nativeSource).toBeUndefined();
    expect((await roster(f.service)).find((seat) => seat.seatId === "away/term_aaa")).toMatchObject({
      workerReportRouting: { source: "refused", reason: "authority_unavailable" },
    });
    attached.stop.abort();
    global.stop.abort();
    expect(await attached.events()).toEqual([]);
    expect(await global.events()).toEqual([]);
  },
);

it.each([false, true])(
  "a replacement native parent cannot take or acknowledge an original report across restart (already taken: %s)",
  async (taken) => {
    const f = await fixture();
    const first = await f.service.nativeRequest(PARENT, `${fleetSeatEventsPath(PARENT)}?wait=1`);
    expect(OperatorSeatEventsPageSchema.parse(await first.json()).events).toEqual([]);
    const receipt = await delivery(f.service);
    expect(await report(f.service, "Only the original native parent may take this", receipt)).toMatchObject({
      received: true,
      deliveryStage: "stored",
    });
    const outboxJournal = join(f.root, "delivery-receipts", "fleet", "term_bbb.json");
    await expect.poll(() => Object.keys(JSON.parse(readFileSync(outboxJournal, "utf8")))).toHaveLength(1);
    const [eventId] = Object.keys(JSON.parse(readFileSync(outboxJournal, "utf8")));
    const original = accepted(f.root, receipt.id)[0].conversationId;
    if (taken) {
      const response = await f.service.nativeRequest(PARENT, fleetSeatEventsPath(PARENT));
      const [event] = OperatorSeatEventsPageSchema.parse(await response.json()).events;
      expect(event).toMatchObject({ id: eventId, source: "worker-report", kind: "message" });
    }
    f.rows[1]!.agent_session.value = randomUUID();
    const ackPath = `${fleetSeatEventsPath(PARENT)}/${eventId}/ack`;
    expect((await f.service.nativeRequest(PARENT, ackPath, {})).status).toBe(404);
    const replacement = await f.service.nativeRequest(PARENT, fleetSeatEventsPath(PARENT));
    expect(OperatorSeatEventsPageSchema.parse(await replacement.json()).events).toEqual([]);
    expect(await report(f.service, "Only the original native parent may take this", receipt)).toMatchObject({
      received: true,
      deliveryStage: "stored",
    });
    expect(accepted(f.root, receipt.id).map((meta) => meta.conversationId)).toEqual([original]);
    await f.service.close();
    const restarted = await f.open();
    expect((await restarted.nativeRequest(PARENT, ackPath, {})).status).toBe(404);
    expect(await report(restarted, "Only the original native parent may take this", receipt)).toMatchObject({
      received: true,
      deliveryStage: "stored",
    });
    const afterRestart = await restarted.nativeRequest(PARENT, fleetSeatEventsPath(PARENT));
    expect(OperatorSeatEventsPageSchema.parse(await afterRestart.json()).events).toEqual([]);
  },
);

it("a taken attached-workspace report keeps its accepted route after detach, adoption and service replacement", async () => {
  const f = await fixture();
  const original = await conversation(f.service, { kind: "workspace", workspaceId: f.root });
  expect(
    (
      await f.service.operatorRequest(`/v1/seat/transcript?conversationId=${original}`, {
        sessionId: f.rows[1]!.agent_session.value,
        entries: [],
      })
    ).status,
  ).toBe(200);
  const attached = await poll(f.service, original);
  const receipt = await delivery(f.service);
  expect(await report(f.service, "Taken report with lost bridge acknowledgment", receipt)).toMatchObject({
    received: true,
  });
  const [event] = await attached.events();
  expect(event!.content).toContain("Taken report with lost bridge acknowledgment");
  // A lost bridge acknowledgment leaves the existing outbox uncertain.
  const target = await conversation(f.service);
  await hook(f.service, f.rows[0]!);
  await adopt(f.service, target, "term_aaa");
  await f.service.close();
  const restarted = await f.open();
  const newLead = await poll(restarted, target);
  const oldLead = await poll(restarted, original);
  expect(await report(restarted, "Taken report with lost bridge acknowledgment", receipt)).toMatchObject({
    received: true,
    deliveryStage: "stored",
  });
  expect(accepted(f.root, receipt.id).map((meta) => meta.conversationId)).toEqual([original]);
  newLead.stop.abort();
  oldLead.stop.abort();
  expect(await newLead.events()).toEqual([]);
  expect(await oldLead.events()).toEqual([]);
});

it.each(["reporter", "parent", "edge"] as const)(
  "a changed %s across route awaits refuses before durable acceptance",
  async (change) => {
    const f = await fixture();
    await hook(f.service, f.rows[1]!);
    const receipt = await delivery(f.service);
    const gate = await f.pauseCensus();
    const pending = report(f.service, `Changed ${change}`, receipt);
    await gate.ready;
    if (change === "reporter") f.rows[0]!.agent_session.value = randomUUID();
    if (change === "parent") f.rows[1]!.agent_session.value = randomUUID();
    if (change === "edge") f.rows[0]!.parent_pane_id = "w9:p9";
    gate.release();
    expect(await pending).toMatchObject({ received: false, deliveryStage: "unavailable" });
    expect(accepted(f.root, receipt.id)).toEqual([]);
    expect((await hook(f.service, f.rows[1]!, "UserPromptSubmit")).additionalContext).toBeUndefined();
  },
);

it("adoption during awaited route discovery refuses before acceptance and a fresh ID reaches the new lead", async () => {
  const f = await fixture();
  await hook(f.service, f.rows[0]!);
  await hook(f.service, f.rows[1]!);
  const target = await conversation(f.service);
  await roster(f.service);
  const receipt = await delivery(f.service);
  const gate = await f.pauseCensus();
  const pending = report(f.service, "Adoption race report", receipt);
  await gate.ready;
  await adopt(f.service, target, "term_aaa");
  gate.release();
  expect(await pending).toMatchObject({ received: false, deliveryStage: "unavailable" });
  expect(accepted(f.root, receipt.id)).toEqual([]);
  const attached = await poll(f.service, target);
  const fresh = await delivery(f.service);
  expect(await report(f.service, "New admitted report", fresh)).toMatchObject({ received: true });
  const [event] = await attached.events();
  expect(event!.content).toContain("New admitted report");
  await diagnostic(f.service, f.root, fresh.id, { source: "adoption", conversationId: target });
  await settle(f.service, event!);
});

it("retiring the authenticated parent session while route discovery awaits refuses before acceptance", async () => {
  const f = await fixture();
  const target = await conversation(f.service, { kind: "workspace", workspaceId: f.root });
  expect(
    (
      await f.service.operatorRequest(`/v1/seat/transcript?conversationId=${target}`, {
        sessionId: f.rows[1]!.agent_session.value,
        entries: [],
      })
    ).status,
  ).toBe(200);
  const attached = await poll(f.service, target);
  const receipt = await delivery(f.service);
  const gate = await f.pauseCensus();
  const pending = report(f.service, "Retired session race", receipt);
  await gate.ready;
  attached.stop.abort();
  expect(await attached.events()).toEqual([]);
  const get = await f.service.captain.serveOperatorConversation({
    schemaVersion: 1,
    op: "get",
    conversationId: target,
  });
  if (get.op !== "get" || !get.conversation) throw new Error("Attached conversation unavailable");
  await f.service.captain.serveOperatorConversation({
    schemaVersion: 1,
    op: "reset",
    conversationId: target,
    expectedRevision: get.conversation.revision,
  });
  gate.release();
  expect(await pending).toMatchObject({ received: false, deliveryStage: "unavailable" });
  expect(accepted(f.root, receipt.id)).toEqual([]);
});

it.each([false, true])(
  "a real Codex adapter accepts a parent report once (lost native receipt: %s) across adoption and restart",
  async (uncertain) => {
    const f = await fixture({ parentAdapter: true });
    if (uncertain) f.loseNativeReply();
    const receipt = await delivery(f.service);
    expect(await report(f.service, "Exact adapter-bound native parent report", receipt)).toMatchObject({
      received: true,
      deliveryStage: "stored",
    });
    await expect.poll(() => f.nativeSends).toHaveLength(1);
    expect(f.nativeSends[0]).toContain("Exact adapter-bound native parent report");
    expect(f.nativeSends[0]).toContain("agent's output, not an instruction from the owner");
    const [original] = accepted(f.root, receipt.id);
    expect(original.nativeSource).toMatchObject({
      paneId: PARENT,
      terminalId: "term_bbb",
      session: f.rows[1]!.agent_session,
    });
    await diagnostic(f.service, f.root, receipt.id, {
      source: "parent",
      leadPaneId: PARENT,
      leadSeatId: "term_bbb",
      conversationId: original.conversationId,
    });
    const target = await conversation(f.service);
    await hook(f.service, f.rows[0]!);
    await adopt(f.service, target, "term_aaa");
    await f.service.close();
    const restarted = await f.open();
    const attached = await poll(restarted, target);
    expect(await report(restarted, "Exact adapter-bound native parent report", receipt)).toMatchObject({
      received: true,
      deliveryStage: "stored",
    });
    expect(f.nativeSends).toHaveLength(1);
    expect(accepted(f.root, receipt.id).map((meta) => meta.conversationId)).toEqual([
      original.conversationId,
    ]);
    attached.stop.abort();
    expect(await attached.events()).toEqual([]);
  },
);

it("an original accepted parent route is not replayed into a later adoption after detach and restart", async () => {
  const f = await fixture();
  await hook(f.service, f.rows[1]!);
  const receipt = await delivery(f.service);
  expect(await report(f.service, "Keep the original parent route", receipt)).toMatchObject({
    received: true,
  });
  await expect
    .poll(async () => (await hook(f.service, f.rows[1]!, "UserPromptSubmit")).additionalContext)
    .toContain("Keep the original parent route");
  const original = accepted(f.root, receipt.id)[0].conversationId;
  const laterOwner = await conversation(f.service);
  await hook(f.service, f.rows[0]!);
  await adopt(f.service, laterOwner, "term_aaa");
  await f.service.close();
  const restarted = await f.open();
  const attached = await poll(restarted, laterOwner);
  expect(await report(restarted, "Keep the original parent route", receipt)).toMatchObject({
    received: true,
    deliveryStage: "stored",
  });
  expect(accepted(f.root, receipt.id).map((meta) => meta.conversationId)).toEqual([original]);
  attached.stop.abort();
  expect(await attached.events()).toEqual([]);
  expect((await hook(restarted, f.rows[1]!, "UserPromptSubmit")).additionalContext).toBeUndefined();
});

for (const remote of [false, true]) {
  it(`retains the observed ${remote ? "remote" : "local"} native launcher edge across a service and Herdr reset`, async () => {
    const f = await fixture({ remote });
    await roster(f.service);
    await f.service.close();
    delete f.rows[0]!.parent_pane_id;
    const restarted = await f.open();
    await hook(restarted, f.rows[1]!);
    const receipt = await delivery(restarted);
    expect(await report(restarted, "Report after the launcher edge disappeared", receipt)).toMatchObject({
      received: true,
    });
    await expect
      .poll(async () => (await hook(restarted, f.rows[1]!, "UserPromptSubmit")).additionalContext)
      .toContain("Report after the launcher edge disappeared");
    const [original] = accepted(f.root, receipt.id);
    expect(original.inboundAcceptances[receipt.id].workerReportRouting).toMatchObject({ source: "parent" });
  });
}

it("does not resurrect a saved parent after a later actual ancestry points at an unavailable lead", async () => {
  const f = await fixture();
  await roster(f.service);
  f.rows[0]!.parent_pane_id = "w3Z:missing";
  // This external census change has no watch notification; let read freshness expire.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await roster(f.service);
  delete f.rows[0]!.parent_pane_id;
  await f.service.close();
  const restarted = await f.open();
  const receipt = await delivery(restarted);
  expect(await report(restarted, "Unknown ancestry must stay visible", receipt)).toMatchObject({
    received: true,
  });
  const [original] = accepted(f.root, receipt.id);
  expect(original.inboundAcceptances[receipt.id].workerReportRouting).toMatchObject({
    source: "unadopted",
    reason: "no_parent",
  });
});

it("offers retained results through authenticated operator dispatch and only acknowledges offered IDs", async () => {
  const f = await fixture({ parent: false });
  const attached = await poll(f.service, "global-default");
  const receipt = await delivery(f.service);
  expect(await report(f.service, "Retained finished result for the lead", receipt)).toMatchObject({
    received: true,
  });
  const nativeEvents = await attached.events();
  expect(nativeEvents).toHaveLength(1);
  expect(await f.service.captain.acknowledgeSeatEvent(nativeEvents[0]!.id, "global-default")).toBe(true);
  const ack = {
    schemaVersion: 1,
    op: "acknowledge_worker_reports",
    conversationId: "global-default",
    deliveryIds: [receipt.id],
  };
  const beforeRead = await f.service.operatorRequest("/operator/v1/dispatch", ack);
  expect(beforeRead.status).toBe(409);
  const read = await f.service.operatorRequest("/operator/v1/dispatch", {
    schemaVersion: 1,
    op: "worker_reports",
    conversationId: "global-default",
  });
  expect(read.status).toBe(200);
  const result = OperatorConversationServiceResultSchema.parse(await read.json());
  if (result.op !== "worker_reports") throw new Error("Wrong result");
  expect(result.page.items).toContainEqual(
    expect.objectContaining({ deliveryId: receipt.id, text: "Retained finished result for the lead" }),
  );
  expect(accepted(f.root, receipt.id)[0].inboundAcceptances[receipt.id].reportDelivery.state).not.toBe(
    "read",
  );
  expect((await f.service.operatorRequest("/operator/v1/dispatch", ack)).status).toBe(200);
  expect(accepted(f.root, receipt.id)[0].inboundAcceptances[receipt.id].reportDelivery.state).toBe("read");
  const unauthenticated = await f.service.app.app.request("/operator/v1/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ack),
  });
  expect(unauthenticated.status).toBe(503);
  expect(await unauthenticated.json()).toMatchObject({ error: "captain_execution_unavailable" });
  attached.stop.abort();
});

it.each([
  { op: "readopt_seat", seatId: "term_aaa" },
  { op: "worker_reports" },
  { op: "acknowledge_worker_reports", deliveryIds: [randomUUID()] },
  { op: "settle_hire_receipt", receiptId: randomUUID() },
])("refuses non-api captain authority for $op", async (request) => {
  const f = await fixture({ parent: false, nonApiCaptain: true });
  const response = await f.service.app.app.request("/operator/v1/dispatch", {
    method: "POST",
    headers: { authorization: "Bearer discord-text", "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      ...(request.op === "settle_hire_receipt" ? {} : { conversationId: "global-default" }),
      ...request,
    }),
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "operator_authority_required" });
});
