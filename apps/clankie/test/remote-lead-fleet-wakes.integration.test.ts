import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import {
  CHANNEL_NOTIFICATION_METHOD,
  connectLaneUpstream,
  pumpSeatEvents,
} from "../../tui/src/command/mcp.ts";
import { createCaptain } from "../src/captain/captain.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createRemoteLeadBridge } from "../src/remote-lead-bridge.ts";
import { RemoteLeadDelegations } from "../src/remote-lead-delegations.ts";

// VUH-1999, VUH-2004: a remote project lead hears its fleet. A real captain and
// conversation store, the real remote-lead bridge routes, and the real seat
// client and channel pump the PC head runs. The PC's Herdr replies and the
// host's process proof are the only fixtures.

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

type Notification = { method: string; params: { content: string; meta: Record<string, string> } };

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remote-lead-fleet-"));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const cwd = "C:\\code\\kh2";
  const seeded = new ConversationStore(join(root, "conversations"), async () => {});
  const lead = seeded.createRemoteWorkspaceConversation({ title: "KH2", workspaceId: cwd, machineId: "pc" });
  await seeded.close();
  const conversationId = lead.conversationId;

  const headSession = randomUUID();
  const head: HerdrAgentSnapshot = {
    paneId: "pc/wR:p1",
    terminalId: "pc/term_head",
    agent: "claude",
    status: "idle",
    title: "KH2 lead",
    session: { source: "herdr:claude", kind: "id", value: headSession },
    workingDirectory: cwd,
  };
  const worker: HerdrAgentSnapshot = {
    paneId: "pc/w9:pR",
    terminalId: "pc/term_reviewer",
    agent: "codex",
    status: "working",
    title: "kh2-reviewer",
    session: { source: "herdr:codex", kind: "id", value: "native-reviewer" },
    workingDirectory: cwd,
  };
  // The head adopted this worker (message_seat) before the bridge restart.
  new HireOwners(join(root, "herdr-watches.json.owners.json")).adopt(
    worker.paneId,
    worker.terminalId,
    occupantIdForHerdrSession(worker.session!),
    { conversationId },
    JSON.stringify(["pc", "codex", "native-reviewer"]),
  );
  // The worker settles when the test says so: a watch must wait for it.
  let workerSettled = false;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = () => {
      workerSettled = true;
      resolve();
    };
  });
  const wire = (agent: HerdrAgentSnapshot) => ({
    pane_id: agent.paneId.slice(3),
    terminal_id: agent.terminalId.slice(3),
    agent: agent.agent,
    agent_status: agent === worker && workerSettled ? "idle" : agent.status,
    title: agent.title,
    agent_session: { ...agent.session! },
    cwd,
  });
  const herdrResponse = (args: readonly string[]) => {
    const agents = [wire(head), wire(worker)];
    let result: unknown;
    if (args[0] === "agent" && args[1] === "list") result = { agents };
    else if (args[0] === "agent" && args[1] === "get")
      result = { agent: agents.find((agent) => args.includes(agent.pane_id)) ?? agents[0] };
    else if (args[0] === "pane" && args[1] === "list") result = { panes: agents };
    else if (args[0] === "workspace" && args[1] === "list") result = { workspaces: [] };
    else if (args[0] === "api" && args[1] === "snapshot")
      result = { snapshot: { workspaces: [], tabs: [], panes: agents, agents } };
    else throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
    return JSON.stringify({ result });
  };
  const byPane = (pane: string) => [head, worker].find((agent) => agent.paneId === pane);
  const byTerminal = (id: string) => [head, worker].find((agent) => agent.terminalId === id);
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    machines: [{ id: "pc", ssh: "fixture.invalid", shell: "posix", aliases: [] }],
    machineAccess: { pc: "workers" },
    execution: {
      ...current.execution,
      connections: [
        { id: "pc", machine: "pc", session: "default", kind: "herdr", enabled: true, capabilities: [] },
      ],
    },
  }));
  const deps = {
    herdrAvailable: () => false,
    embodiment: {},
    memory: {},
    browser: { catalog: async () => ({ available: false, tools: [] }) },
    mcp: { catalog: async () => [], call: async () => ({ outcome: "ok", content: "", isError: false }) },
    fleets: {
      list: [{ id: "pc", session: "default", ssh: { host: "fixture.invalid", shell: "posix" } }],
      run: () => async (args: readonly string[]) => herdrResponse(args),
    },
  } as unknown as CaptainDeps;
  vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  const captain = createCaptain(deps, {
    repoRoot: root,
    stateDir: root,
    workingDirectory: root,
    nativeHerdrRunner: {
      get: async (pane) => byPane(pane) ?? Promise.reject(new Error("gone")),
      resolveTerminal: async (id) => byTerminal(id),
      wait: async (pane) => {
        await settled;
        return { ...byPane(pane)!, status: "idle" };
      },
    },
    nativeCensusRunner: async (_command: string, args: readonly string[]) => ({
      stdout: herdrResponse(args),
      stderr: "",
    }),
    settings,
    discordEnvironment: {},
    seatAdapters: [],
  });
  cleanup.push(() => captain.close());

  // The launch-issued delegation, bound to this head, chat and machine.
  const delegations = new RemoteLeadDelegations(async () => {});
  const binding = {
    fleet: "pc",
    machine: "pc",
    pane: "wR:p1",
    conversationId,
    nativeOccupantId: occupantIdForHerdrSession(head.session!),
    workingDirectory: cwd,
    connectionKey: "connection",
    shell: { pid: 123, startTime: "2026-10-09T00:00:00.0000000Z" },
  };
  const issued = await delegations.issue(binding);
  const bridge = createRemoteLeadBridge({
    captain,
    delegations,
    identity: () => ({
      fleet: "pc",
      pane: "wR:p1",
      current: () => true,
      validate: async () => true,
      projectProof: async () => ({
        ...binding,
        binding: { socketPath: "pipe", session: "default" },
        workspace: { machineId: "pc", platform: "windows" as const, canonicalPath: cwd },
        processes: [{ pid: 456, startTime: "2026-10-09T00:00:01.0000000Z" }],
      }),
    }),
  });
  cleanup.push(() => bridge.close());
  // The head's stdio bridge maps its seat routes onto the fleet lead routes.
  const fetchImpl: typeof fetch = async (resource, init) => {
    const request = new Request(resource, init);
    const url = new URL(request.url);
    if (url.pathname === "/v1/mcp") url.pathname = "/v1/fleet/lead/mcp";
    else url.pathname = url.pathname.replace("/v1/seat/", "/v1/fleet/lead/");
    return bridge.app.fetch(new Request(url, request));
  };
  const upstream = await connectLaneUpstream({
    host: "http://127.0.0.1",
    bearer: issued.token,
    conversationId,
    fetchImpl,
  });
  cleanup.push(() => upstream.close());
  // The head's own session hook attaches it to its conversation.
  const synced = await fetchImpl("http://127.0.0.1/v1/seat/transcript", {
    method: "POST",
    headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: headSession, entries: [] }),
  });
  expect(synced.status).toBe(200);

  const notifications: Notification[] = [];
  /** Starts the head's channel pump, as a running bridge does. */
  const listen = async () => {
    const stop = new AbortController();
    const pump = pumpSeatEvents(
      { notification: async (event) => void notifications.push(event as Notification) },
      upstream,
      stop.signal,
      { waitMs: 200, retryMs: 20 },
    );
    cleanup.push(async () => {
      stop.abort();
      await pump;
    });
    await expect
      .poll(() => captain.serveOperatorConversation({ op: "get", schemaVersion: 1, conversationId }))
      .toMatchObject({ conversation: { driver: {} } });
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await upstream.callTool(name, args);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent;
  };
  const events = (kind: string) =>
    notifications.filter(
      (event) => event.method === CHANNEL_NOTIFICATION_METHOD && event.params.meta.kind === kind,
    );
  return { captain, conversationId, worker, settle, listen, call, events };
}

it("an adopted remote worker's report reaches its remote lead's channel instead of not_sent", async () => {
  const f = await fixture();
  await f.listen();
  const binding = await f.captain.fleetSeatMessageBinding(f.worker.paneId);
  expect(binding).toBeDefined();
  const delivery = { id: randomUUID(), binding: binding! };

  const receipt = await f.captain.receiveFleetSeatMessage(
    f.worker.paneId,
    "Review done: 2 findings",
    delivery,
  );
  expect(receipt).toMatchObject({ received: true, deliveryStage: "stored" });
  expect(receipt).not.toHaveProperty("definitive");

  await expect.poll(() => f.events("message").length).toBe(1);
  const report = f.events("message")[0]!;
  expect(report.params.meta).toMatchObject({ source: "worker-report", conversation: f.conversationId });
  expect(report.params.content).toContain("Review done: 2 findings");
  expect(report.params.content).toContain(f.worker.paneId);
});

it("a watch armed by the remote head waits for its channel, then wakes it exactly once when the worker settles", async () => {
  const f = await fixture();
  expect(await f.call("herdr_watch", { agent: f.worker.paneId, reason: "Harvest the review" })).toMatchObject(
    { outcome: "watching", alreadyWatching: false },
  );
  // No head channel is polling yet: the settled watch stays armed, nothing is lost.
  f.settle();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(f.events("watch")).toHaveLength(0);

  await f.listen();
  await expect.poll(() => f.events("watch").length, { timeout: 12_000 }).toBe(1);
  const wake = f.events("watch")[0]!;
  expect(wake.params.meta).toMatchObject({ source: "watch", conversation: f.conversationId });
  expect(wake.params.content).toContain("Harvest the review");
  // The fired watch is gone and never delivered again.
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  expect(f.events("watch")).toHaveLength(1);
}, 30_000);

it("the remote head's schedule_wake fires once on its channel instead of being dropped", async () => {
  const f = await fixture();
  await f.listen();
  const at = new Date(Date.now() + 1_000).toISOString();
  expect(await f.call("schedule_wake", { at, reason: "Check the KH2 build" })).toMatchObject({
    reason: "Check the KH2 build",
  });
  await expect.poll(() => f.events("wake").length, { timeout: 8_000 }).toBe(1);
  expect(f.events("wake")[0]!.params.content).toContain("Check the KH2 build");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(f.events("wake")).toHaveLength(1);
}, 20_000);
