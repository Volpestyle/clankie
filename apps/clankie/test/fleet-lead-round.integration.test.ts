import { once } from "node:events";
import { FleetHealthMetrics } from "../src/fleet-health-metrics.ts";
import { localFleetProof } from "../src/local-fleet-proof.ts";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { OperatorConversationServiceResultSchema, type WorkerReportBridgeStatus } from "@clankie/protocol";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { SeatEfficiencyStore } from "../src/captain/seat-efficiency.ts";
import { DeliveryFence, deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { FleetReportFailureAlerts } from "../src/captain/fleet-review.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { registerSeatRoutes } from "../src/app/seat-routes.ts";
import type { ClankieAppDependencies } from "../src/app/types.ts";

interface NativeRow {
  pane_id: string;
  terminal_id: string;
  agent: string;
  agent_status: string;
  title: string;
  agent_session: { source: string; kind: "path"; value: string };
  cwd: string;
  parent_pane_id?: string;
}
const fixtures: Array<{ root: string; captain: ReturnType<typeof createCaptain> }> = [];
const resources: (() => Promise<void>)[] = [];
const exec = promisify(execFile);
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
  for (const f of fixtures.splice(0)) {
    await f.captain.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

async function fixture(
  roundMs = 60 * 60_000,
  objective?: string,
  rebound = false,
  healthy = false,
  configure?: (root: string, rows: NativeRow[]) => Promise<void>,
  reportHealth?: Map<string, WorkerReportBridgeStatus>,
  oneOwner = false,
  bind = true,
) {
  const root = await mkdtemp(join(tmpdir(), "fleet-lead-round-"));
  const conversations = new ConversationStore(join(root, "conversations"), async () => {});
  const second = await conversations.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "global" },
    title: "Other lead",
  });
  if (second.op !== "create") throw new Error("Missing second lead");
  await conversations.close();
  const rows: NativeRow[] = [];
  const owners = new HireOwners(join(root, "herdr-watches.json.owners.json"));
  const evidence = new SeatEfficiencyStore(join(root, "seat-efficiency.json"));
  for (let i = 1; i <= 4; i++) {
    const nativeId = randomUUID();
    const path = join(root, `rollout-fixture-${nativeId}.jsonl`);
    const timestamp = new Date(Date.now() - (healthy ? 1000 : 3 * 60 * 60_000)).toISOString();
    await writeFile(
      path,
      [
        { timestamp, type: "session_meta", payload: { id: nativeId, cwd: root } },
        { timestamp, type: "turn_context", payload: { model: "gpt-6-sol", effort: "high" } },
        {
          timestamp,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              model_context_window: 100000,
              last_token_usage: { input_tokens: healthy ? 40000 : 80000 },
            },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const row: NativeRow = {
      pane_id: `w1:p${i}`,
      terminal_id: `term_${i}`,
      agent: "codex",
      agent_status: "working",
      title: i === 4 ? "Unowned worker" : `Worker ${i}`,
      agent_session: { source: "herdr:codex", kind: "path", value: path },
      cwd: root,
    };
    rows.push(row);
    if (i === 4) continue;
    const owner = {
      conversationId: i <= 2 || oneOwner ? "global-default" : second.conversation.conversationId,
    };
    const occupantId = occupantIdForHerdrSession(row.agent_session);
    owners.bind(
      row.pane_id,
      owner,
      row.terminal_id,
      undefined,
      occupantId,
      JSON.stringify(["local", "codex", nativeId]),
    );
    evidence.assign(occupantId, {
      owner,
      deliverable: healthy ? `VUH-${1700 + i}` : "VUH-1662",
      assignedAt: timestamp,
      objective,
    });
  }
  if (rebound) rows[0]!.terminal_id = "term_rebound";
  await configure?.(root, rows);
  const waits = new Map<string, Set<() => void>>();
  const nativeRequests: string[][] = [];
  let censusGate: { entered(): void; wait: Promise<void> } | undefined;
  const execute = async (args: readonly string[], signal?: AbortSignal): Promise<string> => {
    nativeRequests.push([...args]);
    if (censusGate && args[0] === "agent" && args[1] === "list") {
      const held = censusGate;
      censusGate = undefined;
      held.entered();
      await held.wait;
    }
    let result: unknown;
    if (args[0] === "agent" && args[1] === "wait") {
      const target = args[2]!;
      const current = rows.find((row) => row.pane_id === target || row.terminal_id === target);
      const until = args.flatMap((arg, index) => (arg === "--until" ? [args[index + 1]] : []));
      if (current?.agent_status !== "working" && (!until.length || until.includes(current?.agent_status)))
        return JSON.stringify({ result: { agent: current } });
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const handlers = waits.get(target) ?? new Set();
        const complete = () => {
          handlers.delete(complete);
          resolve();
        };
        handlers.add(complete);
        waits.set(target, handlers);
        signal?.addEventListener(
          "abort",
          () => {
            handlers.delete(complete);
            reject(signal.reason);
          },
          { once: true },
        );
      });
      result = { agent: rows.find((row) => row.pane_id === target || row.terminal_id === target) };
    } else if (args[0] === "agent" && args[1] === "get") {
      result = { agent: rows.find((row) => row.pane_id === args[2] || row.terminal_id === args[2]) };
    } else if (args[0] === "agent" && args[1] === "list") result = { agents: rows };
    else if (args[0] === "pane" && args[1] === "list") result = { panes: rows };
    else if (args[0] === "workspace" && args[1] === "list") result = { workspaces: [] };
    else throw new Error(`Unexpected native transport request: ${args.join(" ")}`);
    return JSON.stringify({ result });
  };
  const captain = createCaptain(
    {
      herdrAvailable: () => true,
      memory: {},
      embodiment: {},
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp: { catalog: async () => [], call: async () => ({ outcome: "ok", content: "", isError: false }) },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
      nativeHerdrRunner: createHerdrWatchRunner(() => true, execute, undefined, {
        localCodexRecovery: false,
      }),
      nativeCensusRunner: async (_cmd, args) => ({ stdout: await execute(args), stderr: "" }),
      nativeSummariesPath: join(root, "summaries.json"),
      seatAdapters: [],
      discordEnvironment: {},
      fleetRoundIntervalMs: roundMs,
      workerReportBridgeStatus: (_fleet, pane) => reportHealth?.get(pane),
    },
  );
  fixtures.push({ root, captain });
  // Park both native outboxes before a scheduled wake; zero-wait reads do not bind them.
  if (bind) {
    // A seeded unresolved original produces its one VUH-1779 alert, nothing else.
    expect(
      (
        await Promise.all([
          captain.pollSeatEvents(1, undefined, "global-default"),
          captain.pollSeatEvents(1, undefined, second.conversation.conversationId),
        ])
      ).map((events) => events.filter((event) => event.source !== "seat-delivery-alert")),
    ).toEqual([[], []]);
  }
  const leadSessions = new Map([
    ["global-default", randomUUID()],
    [second.conversation.conversationId, randomUUID()],
  ]);
  return {
    root,
    captain,
    rows,
    nativeRequests,
    other: second.conversation.conversationId,
    holdNextCensus: () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      censusGate = { entered, wait };
      return { started, release };
    },
    finish: async (
      eventId: string,
      conversationId = "global-default",
      sessionId = leadSessions.get(conversationId)!,
    ) => {
      expect(await captain.acknowledgeSeatEvent(eventId, conversationId)).toBe(true);
      // The delivery acknowledgment is distinct from the harness completing its turn.
      expect(
        captain.syncSeatTranscript(conversationId, {
          sessionId,
          activity: "waiting",
          entries: [
            { type: "message", id: `review-${eventId}`, role: "agent", text: "Fleet review completed." },
          ],
        }),
      ).toBe(true);
    },
    settle: (index: number) => {
      const row = rows[index]!;
      row.agent_status = "done";
      for (const complete of [...(waits.get(row.pane_id) ?? []), ...(waits.get(row.terminal_id) ?? [])])
        complete();
    },
  };
}

it("records an aggregate proof flood for the default owner without a current native seat or model turn", async () => {
  const f = await fixture(
    60 * 60_000,
    undefined,
    false,
    true,
    async (_root, rows) => {
      rows.splice(0);
    },
    undefined,
    false,
    false,
  );
  let now = Date.now();
  const attempts: Promise<boolean>[] = [];
  const settlements: string[] = [];
  const metrics = new FleetHealthMetrics({
    now: () => now,
    onAggregateProofAlert: (rates) => {
      let observed: import("../src/captain/port.ts").FleetHealthAlertDelivery = { outcome: "unavailable" };
      const delivery = f.captain.notifyFleetHealthAlert(
        undefined,
        `Fleet aggregate proof alert: ${rates.proof.refusals}/${rates.proof.attempts} refused.`,
        (result) => {
          observed = result;
        },
      );
      attempts.push(delivery);
      return delivery.then(() => {
        settlements.push(observed.outcome);
        return observed;
      });
    },
  });
  const proof = localFleetProof({
    platform: "darwin",
    herdrBinary: "herdr",
    binding: async () => undefined,
    diagnostics: (event, pane) => metrics.observeProof("fleet", event, pane),
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (_request, environment) =>
      Response.json({ accepted: await proof(environment.incoming.socket, "") }),
  });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing real proof TCP listener");
  try {
    const refuse = async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      expect(await response.json()).toEqual({ accepted: false });
    };
    for (let count = 0; count < 100; count++) await refuse();
    expect(attempts).toHaveLength(0);
    now += 60_000;
    await refuse();
    expect(await attempts[0]).toBe(true);
    await Promise.resolve();
    expect(settlements).toEqual(["accepted"]);
    for (let minute = 0; minute < 4; minute++) {
      now += 60_000;
      await refuse();
    }
    expect(attempts).toHaveLength(1);
    const replay = await f.captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "replay",
      replay: { schemaVersion: 1, conversationId: "global-default", surfaceClientId: "test" },
    });
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("Missing replay page");
    expect(
      replay.result.events.filter((event) => event.type === "message" && event.role === "external"),
    ).toMatchObject([{ text: "Fleet aggregate proof alert: 101/101 refused." }]);
    expect(
      new ConversationJournal(join(f.root, "conversations"))
        .read("global-default")
        .some((event) => event.type === "turn"),
    ).toBe(false);
    expect(
      f.nativeRequests.filter(
        (args) => !["get", "list", "wait", "snapshot", "process-info"].includes(args[1]!),
      ),
    ).toEqual([]);
  } finally {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("refuses new native health messages behind a durable head receipt until its exact acknowledgment", async () => {
  const originalId = randomUUID();
  const f = await fixture(
    60 * 60_000,
    undefined,
    false,
    true,
    async (root) => {
      new DeliveryFence(join(root, "delivery-receipts", "head", "global-default.json")).begin(originalId, {
        messageId: originalId,
        fingerprint: deliveryFingerprint("An earlier original message"),
      });
    },
    undefined,
    false,
    false,
  );
  expect(await f.captain.notifyRuntimeHealthAlert("Runtime health alert: high CPU held.")).toBe(false);
  expect(await f.captain.notifyFleetHealthAlert("w1:p1", "Fleet proof alert: refusal rate held.")).toBe(
    false,
  );
  expect(await f.captain.pollSeatEvents(0, undefined, "global-default")).toEqual([]);
  expect(await f.captain.pollSeatEvents(0, undefined, f.other)).toEqual([]);
  expect(
    new DeliveryFence(join(f.root, "delivery-receipts", "head", "global-default.json")).entries(),
  ).toHaveLength(1);
  expect(await f.captain.acknowledgeSeatEvent(randomUUID(), "global-default")).toBe(false);
  expect(await f.captain.notifyRuntimeHealthAlert("Runtime health recovery: CPU is normal.")).toBe(false);
  expect(await f.captain.acknowledgeSeatEvent(originalId, "global-default")).toBe(true);
  expect(await f.captain.pollSeatEvents(1, undefined, "global-default")).toEqual([]);
  const poll = f.captain.pollSeatEvents(3000, undefined, "global-default");
  const delivery = f.captain.notifyRuntimeHealthAlert("Runtime health alert: high CPU still held.");
  const [event] = await poll;
  expect(event?.content).toBe("Runtime health alert: high CPU still held.");
  expect(event?.id).not.toBe(originalId);
  expect(await f.captain.acknowledgeSeatEvent(event!.id, "global-default")).toBe(true);
  expect(await delivery).toBe(true);
  expect(
    f.nativeRequests.filter(
      (args) => !["get", "list", "wait", "snapshot", "process-info"].includes(args[1]!),
    ),
  ).toEqual([]);
  expect(
    new ConversationJournal(join(f.root, "conversations"))
      .read("global-default")
      .some((event) => event.type === "turn"),
  ).toBe(false);
});

it("refuses a parent native health message behind its durable fleet mailbox without alternate dispatch", async () => {
  const originalId = randomUUID();
  const f = await fixture(60 * 60_000, undefined, false, true, async (root, rows) => {
    rows[3]!.parent_pane_id = "w1:p3";
    const parent = rows[2]!;
    const binding = deliveryFingerprint(
      JSON.stringify([parent.pane_id, parent.terminal_id, parent.agent, parent.agent_session]),
    );
    new DeliveryFence(join(root, "delivery-receipts", "fleet", "term_3.json")).begin(originalId, {
      messageId: originalId,
      fingerprint: deliveryFingerprint("The parent's earlier original message"),
      sessionId: binding,
    });
  });
  expect(await f.captain.pollFleetSeatEvents("w1:p3", 0)).toEqual([]);
  expect(await f.captain.notifyFleetHealthAlert("w1:p4", "Fleet proof alert: parent-owned failure.")).toBe(
    false,
  );
  expect(await f.captain.pollFleetSeatEvents("w1:p3", 0)).toEqual([]);
  expect(await f.captain.pollSeatEvents(0, undefined, "global-default")).toEqual([]);
  expect(await f.captain.pollSeatEvents(0, undefined, f.other)).toEqual([]);
  expect(await f.captain.acknowledgeFleetSeatEvent("w1:p3", randomUUID())).toBe(false);
  expect(await f.captain.acknowledgeFleetSeatEvent("w1:p3", originalId)).toBe(true);
  const poll = f.captain.pollFleetSeatEvents("w1:p3", 3000);
  const delivery = f.captain.notifyFleetHealthAlert("w1:p4", "Fleet proof alert: parent-owned failure.");
  const [event] = (await poll)!;
  expect(event?.content).toBe("Fleet proof alert: parent-owned failure.");
  expect(event?.id).not.toBe(originalId);
  expect(await f.captain.acknowledgeFleetSeatEvent("w1:p3", event!.id)).toBe(true);
  expect(await delivery).toBe(true);
  expect(
    f.nativeRequests.filter(
      (args) => !["get", "list", "wait", "snapshot", "process-info"].includes(args[1]!),
    ),
  ).toEqual([]);
  expect(
    new ConversationJournal(join(f.root, "conversations"))
      .read("global-default")
      .some((event) => event.type === "turn"),
  ).toBe(false);
});

it("does not accept an older identical native control receipt as a fresh health dispatch", async () => {
  const text = "Fleet proof alert: parent-owned failure.";
  const originalId = randomUUID();
  const f = await fixture(60 * 60_000, undefined, false, true, async (root, rows) => {
    rows[3]!.parent_pane_id = "w1:p3";
    new DeliveryFence(join(root, "herdr-watches.json.delivery-receipts.json")).begin("term_3", {
      messageId: originalId,
      fingerprint: deliveryFingerprint(text),
    });
  });
  expect(await f.captain.pollFleetSeatEvents("w1:p3", 1)).toEqual([]);
  expect(await f.captain.notifyFleetHealthAlert("w1:p4", text)).toBe(false);
  expect(await f.captain.pollFleetSeatEvents("w1:p3", 0)).toEqual([]);
  expect(await f.captain.pollSeatEvents(0, undefined, "global-default")).toEqual([]);
  expect(
    new DeliveryFence(join(f.root, "herdr-watches.json.delivery-receipts.json")).pending("term_3")?.messageId,
  ).toBe(originalId);
  expect(
    f.nativeRequests.filter(
      (args) => !["get", "list", "wait", "snapshot", "process-info"].includes(args[1]!),
    ),
  ).toEqual([]);
});

it("retries an unaccepted report incident after one minute and recovers only after native acceptance", async () => {
  const originalId = randomUUID();
  const f = await fixture(
    60 * 60_000,
    undefined,
    false,
    true,
    async (root) => {
      new DeliveryFence(join(root, "delivery-receipts", "head", "global-default.json")).begin(originalId, {
        messageId: originalId,
        fingerprint: deliveryFingerprint("An earlier original message"),
      });
    },
    undefined,
    true,
  );
  const roster = await f.captain.serveOperatorConversation({ op: "roster", schemaVersion: 1 });
  if (roster.op !== "roster") throw new Error("Missing report health roster");
  const now = Date.now();
  const failed = roster.seats.map((seat) => ({
    ...seat,
    ...(seat.efficiency?.ownerConversationId === "global-default"
      ? {
          workerReportBridge: {
            outcome: "uncertain" as const,
            reason: "binding_timeout" as const,
            observedAt: new Date(now).toISOString(),
          },
        }
      : {}),
  }));
  const alerts = new FleetReportFailureAlerts();
  const [incident] = alerts.observe(failed, now);
  expect(incident?.kind).toBe("incident");
  expect(alerts.observe(failed, now)).toEqual([]); // Nested native census sees a pending dispatch.
  const accepted = await f.captain.notifyFleetHealthAlert("w1:p1", incident!.text);
  expect(accepted).toBe(false);
  alerts.settle(incident!, accepted, now);
  expect(alerts.observe(failed, now + 59_999)).toEqual([]);
  expect(alerts.observe(roster.seats, now + 60_000)).toEqual([]); // No accepted incident to recover.
  const [retry] = alerts.observe(failed, now + 60_000);
  expect(retry?.kind).toBe("incident");
  expect(await f.captain.acknowledgeSeatEvent(originalId, "global-default")).toBe(true);
  const poll = f.captain.pollSeatEvents(3000, undefined, "global-default");
  const delivery = f.captain.notifyFleetHealthAlert("w1:p1", retry!.text);
  const [event] = await poll;
  expect(event?.content).toContain("Fleet report bridge alert");
  expect(await f.captain.acknowledgeSeatEvent(event!.id, "global-default")).toBe(true);
  const retryAccepted = await delivery;
  expect(retryAccepted).toBe(true);
  alerts.settle(retry!, retryAccepted, now + 60_000);
  expect(alerts.observe(failed, now + 60_000)).toEqual([]);
  const [recovery] = alerts.observe(roster.seats, now + 60_000);
  expect(recovery?.kind).toBe("recovery");
  const recoveryPoll = f.captain.pollSeatEvents(3000, undefined, "global-default");
  const recoveryDelivery = f.captain.notifyFleetHealthAlert("w1:p1", recovery!.text);
  const [recovered] = await recoveryPoll;
  expect(recovered?.content).toContain("Fleet report bridge recovery");
  expect(await f.captain.acknowledgeSeatEvent(recovered!.id, "global-default")).toBe(true);
  alerts.settle(recovery!, await recoveryDelivery, now + 60_000);
  expect(alerts.observe(roster.seats, now + 60_000)).toEqual([]);
  expect(await f.captain.pollSeatEvents(0, undefined, f.other)).toEqual([]);
  expect(
    new ConversationJournal(join(f.root, "conversations"))
      .read("global-default")
      .some((event) => event.type === "turn"),
  ).toBe(false);
});

it("alerts only the owning native lead for three current report failures, clears and rearms once", async () => {
  const reports = new Map<string, WorkerReportBridgeStatus>();
  const f = await fixture(60 * 60_000, undefined, false, true, undefined, reports, true);
  const inspect = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const result = await f.captain.serveOperatorConversation({ op: "roster", schemaVersion: 1 });
    expect(result.op).toBe("roster");
    return result;
  };
  const failure = (): WorkerReportBridgeStatus => ({
    outcome: "uncertain",
    reason: "binding_timeout",
    observedAt: new Date().toISOString(),
  });
  reports.set("w1:p1", failure());
  reports.set("w1:p2", failure());
  reports.set("w1:p4", failure()); // An unowned seat never satisfies the lead threshold.
  reports.set("w1:p3", { ...failure(), observedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
  await inspect();
  expect(await f.captain.pollSeatEvents(0, undefined, "global-default")).toEqual([]);
  reports.set("w1:p3", failure());
  const poll = f.captain.pollSeatEvents(3000, undefined, "global-default");
  await inspect();
  const [event] = await poll;
  expect(event?.kind).toBe("message");
  expect(event?.content).toContain("3 of your current seats");
  expect(event?.content).not.toContain("w1:p4");
  expect(await f.captain.pollSeatEvents(0, undefined, f.other)).toEqual([]);
  expect(await f.captain.acknowledgeSeatEvent(event!.id, "global-default")).toBe(true);
  await inspect();
  expect(await f.captain.pollSeatEvents(0, undefined, "global-default")).toEqual([]);
  reports.set("w1:p3", { outcome: "stored", reason: "stored", observedAt: new Date().toISOString() });
  const recoveryPoll = f.captain.pollSeatEvents(3000, undefined, "global-default");
  await inspect();
  const [recovery] = await recoveryPoll;
  expect(recovery?.content).toContain("Fleet report bridge recovery");
  expect(await f.captain.acknowledgeSeatEvent(recovery!.id, "global-default")).toBe(true);
  reports.set("w1:p3", failure());
  const repeatedPoll = f.captain.pollSeatEvents(3000, undefined, "global-default");
  await inspect();
  const [repeated] = await repeatedPoll;
  expect(repeated?.content).toContain("3 of your current seats");
  expect(await f.captain.acknowledgeSeatEvent(repeated!.id, "global-default")).toBe(true);
  const runtimePoll = f.captain.pollSeatEvents(3000, undefined, "global-default");
  const runtimeAlert = f.captain.notifyRuntimeHealthAlert(
    "Runtime health alert: high CPU held for five minutes.",
  );
  const [runtime] = await runtimePoll;
  expect(runtime?.content).toContain("Runtime health alert");
  expect(await f.captain.acknowledgeSeatEvent(runtime!.id, "global-default")).toBe(true);
  expect(await runtimeAlert).toBe(true);
  expect(
    new ConversationJournal(join(f.root, "conversations"))
      .read("global-default")
      .some((event) => event.type === "turn"),
  ).toBe(false);
});

it("ingests content-free seat report health over authenticated HTTP into the real worker service and roster", async () => {
  const reports = new Map<string, WorkerReportBridgeStatus>();
  const f = await fixture(60 * 60_000, undefined, false, true, undefined, reports);
  const settings = new SettingsStore(join(f.root, "settings.json"));
  const credentials = new FileCredentialStore(join(f.root, "credentials.json"));
  const host = createMcpHost({ credentials, settings, curated: [], logger: { info() {}, warn() {} } });
  const worker = new WorkerMcp({
    directory: join(f.root, "grants"),
    credentials,
    host,
    reportBridgeObserved: (_fleet, pane, report) => reports.set(pane, report),
  });
  const app = new Hono();
  registerSeatRoutes({
    app,
    dependencies: { captain: f.captain, workerMcp: worker } as ClankieAppDependencies,
    authenticateLane: async (context) =>
      context.req.header("authorization") === "Bearer report-health-fixture"
        ? { lane: "operator" }
        : { denial: context.json({ error: "authentication_required" }, 401) },
  });
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing health route fixture address");
  resources.push(async () => {
    await worker.close();
    await host.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
  });
  const post = (body: unknown, pane = "w1:p1", token = "report-health-fixture") =>
    fetch(`http://127.0.0.1:${address.port}/v1/fleet/seats/${encodeURIComponent(pane)}/messages/health`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const report: WorkerReportBridgeStatus = {
    outcome: "uncertain",
    reason: "binding_timeout",
    observedAt: new Date().toISOString(),
  };
  expect((await post(report, "w1:p1", "wrong")).status).toBe(401);
  expect((await post({ ...report, text: "private body" })).status).toBe(400);
  expect((await post(report, "missing")).status).toBe(403);
  expect((await post(report)).status).toBe(202);
  expect(worker.reportBridgeStatus("default", "w1:p1")).toEqual(report);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const roster = await f.captain.serveOperatorConversation({ op: "roster", schemaVersion: 1 });
  if (roster.op !== "roster") throw new Error("Missing report health roster");
  expect(roster.seats.find((seat) => seat.seatId === "term_1")?.workerReportBridge).toEqual(report);
  expect(JSON.stringify(roster.seats)).not.toContain("private body");
});

it("a real watch wake includes every owned seat and never another lead's or unowned worker", async () => {
  const f = await fixture();
  const bank = await f.captain.laneToolBank("operator", "global-default");
  const watch = bank.tools.find((tool) => tool.name === "herdr_watch")!;
  const poll = f.captain.pollSeatEvents(3000, undefined, "global-default");
  await watch.call({ agent: f.rows[0]!.pane_id, reason: "Harvest the assigned patch" });
  // The external wait may begin after the arm call. A settled census is also
  // sufficient native proof, so both paths exercise the normal watcher.
  f.settle(0);
  const [event] = await poll;
  expect(event?.content).toContain("Fleet lead round.");
  expect(event?.content).toContain('"seatId":"term_1"');
  expect(event?.content).toContain('"seatId":"term_2"');
  expect(event?.content).not.toContain('"seatId":"term_3"');
  expect(event?.content).not.toContain('"seatId":"term_4"');
  expect(event?.content).toContain("context 80%");
  expect(event?.content).toContain("no progress in 2h");
  expect(event?.content).toContain("overlap");
  await f.finish(event!.id);
  expect(await f.captain.pollSeatEvents(0, undefined, f.other)).toEqual([]);
});

it("periodic rounds independently wake both leading conversations with only their seats", async () => {
  const f = await fixture(500);
  const [first, other] = await Promise.all([
    f.captain.pollSeatEvents(3000, undefined, "global-default"),
    f.captain.pollSeatEvents(3000, undefined, f.other),
  ]);
  expect(first[0]?.content).toContain('"seatId":"term_1"');
  expect(first[0]?.content).toContain('"seatId":"term_2"');
  expect(first[0]?.content).not.toContain('"seatId":"term_3"');
  expect(other[0]?.content).toContain('"seatId":"term_3"');
  expect(other[0]?.content).not.toContain('"seatId":"term_1"');
  expect(other[0]?.content).not.toContain('"seatId":"term_4"');
  // Leave the first review outstanding across two more real periodic ticks.
  // Durable accepted turns reveal a queue even when native delivery is held.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const journal = new ConversationJournal(join(f.root, "conversations"));
  for (const conversationId of ["global-default", f.other])
    expect(
      journal.read(conversationId).filter((event) => event.type === "turn" && event.phase === "accepted"),
    ).toHaveLength(1);
  await f.finish(first[0]!.id);
  await f.finish(other[0]!.id, f.other);
  // An unresolved flag remains worth a later round even with identical evidence.
  const [next, nextOther] = await Promise.all([
    f.captain.pollSeatEvents(3000, undefined, "global-default"),
    f.captain.pollSeatEvents(3000, undefined, f.other),
  ]);
  expect(next[0]?.content).toContain("context 80%");
  expect(nextOther[0]?.content).toContain("context 80%");
  for (const conversationId of ["global-default", f.other])
    expect(
      journal.read(conversationId).filter((event) => event.type === "turn" && event.phase === "accepted"),
    ).toHaveLength(2);
  await f.finish(next[0]!.id);
  await f.finish(nextOther[0]!.id, f.other);
});

it("skips unchanged unflagged rounds despite fresh observation clocks, then wakes only the owner with new evidence", async () => {
  const f = await fixture(200, undefined, false, true);
  const before = await f.captain.fleetEfficiency!("global-default");
  expect(before.seats.every((seat) => seat.efficiency?.flags.length === 0)).toBe(true);
  const [first, other] = await Promise.all([
    f.captain.pollSeatEvents(3000, undefined, "global-default"),
    f.captain.pollSeatEvents(3000, undefined, f.other),
  ]);
  expect(first[0]?.content).toContain('"seatId":"term_1"');
  expect(other[0]?.content).toContain('"seatId":"term_3"');
  await f.finish(first[0]!.id);
  await f.finish(other[0]!.id, f.other);
  expect(
    await Promise.all([
      f.captain.pollSeatEvents(650, undefined, "global-default"),
      f.captain.pollSeatEvents(650, undefined, f.other),
    ]),
  ).toEqual([[], []]);
  const refreshed = await f.captain.fleetEfficiency!("global-default");
  expect(refreshed.seats[0]?.efficiency?.checkedAt).not.toBe(before.seats[0]?.efficiency?.checkedAt);
  const journal = new ConversationJournal(join(f.root, "conversations"));
  const accepted = (conversationId: string) =>
    journal.read(conversationId).filter((event) => event.type === "turn" && event.phase === "accepted");
  expect(accepted("global-default")).toHaveLength(1);
  expect(accepted(f.other)).toHaveLength(1);
  // A fresh native turn setting is useful evidence without creating any problem flag.
  await appendFile(
    f.rows[0]!.agent_session.value,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "turn_context",
      payload: { model: "gpt-6-sol", effort: "medium" },
    }) + "\n",
  );
  const changed = await f.captain.fleetEfficiency!("global-default");
  expect(changed.seats[0]?.efficiency).toMatchObject({ flags: [], effort: "medium" });
  const [fresh, unchanged] = await Promise.all([
    f.captain.pollSeatEvents(3000, undefined, "global-default"),
    f.captain.pollSeatEvents(650, undefined, f.other),
  ]);
  expect(fresh[0]?.content).toContain('"effort":"medium"');
  expect(unchanged).toEqual([]);
  expect(accepted("global-default")).toHaveLength(2);
  expect(accepted(f.other)).toHaveLength(1);
  await f.finish(fresh[0]!.id);
  expect(await f.captain.pollSeatEvents(650, undefined, "global-default")).toEqual([]);
  expect(accepted("global-default")).toHaveLength(2);
});

it("does not consume healthy evidence when a periodic native turn is canceled before delivery", async () => {
  const f = await fixture(200, undefined, false, true);
  const sessionId = randomUUID();
  expect(
    f.captain.syncSeatTranscript("global-default", { sessionId, entries: [], activity: "responding" }),
  ).toBe(true);
  const [held, other] = await Promise.all([
    f.captain.pollSeatEvents(450, undefined, "global-default"),
    f.captain.pollSeatEvents(3000, undefined, f.other),
  ]);
  expect(held).toEqual([]);
  await f.finish(other[0]!.id, f.other);
  const journal = new ConversationJournal(join(f.root, "conversations"));
  const accepted = journal
    .read("global-default")
    .filter((event) => event.type === "turn" && event.phase === "accepted");
  expect(accepted).toHaveLength(1);
  const run = accepted[0]!;
  if (run.type !== "turn") throw new Error("Missing accepted periodic run");
  expect(
    await f.captain.serveOperatorConversation({
      op: "cancel",
      schemaVersion: 1,
      conversationId: "global-default",
      runId: run.runId,
    }),
  ).toMatchObject({ op: "cancel", cancelled: true });
  expect(
    f.captain.syncSeatTranscript("global-default", { sessionId, entries: [], activity: "waiting" }),
  ).toBe(true);
  const [retried] = await f.captain.pollSeatEvents(3000, undefined, "global-default");
  expect(retried?.content).toContain("Fleet lead round.");
  expect(
    journal.read("global-default").filter((event) => event.type === "turn" && event.phase === "accepted"),
  ).toHaveLength(2);
  expect(journal.read("global-default")).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "turn", runId: run.runId, phase: "cancelled" })]),
  );
  await f.finish(retried!.id, "global-default", sessionId);
  expect(await f.captain.pollSeatEvents(650, undefined, "global-default")).toEqual([]);
});

async function git(path: string, args: readonly string[]) {
  await exec(
    "git",
    [
      "--no-optional-locks",
      "-C",
      path,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      encoding: "utf8",
      timeout: 5000,
    },
  );
}

it("attributes advanced commits only with fresh exclusive worktree and branch claims across the entire census", async () => {
  let repository = "";
  let worktree = "";
  let otherWorktree = "";
  const f = await fixture(undefined, undefined, false, false, async (root, rows) => {
    repository = join(root, "primary-repository");
    worktree = join(root, "owned-worktree");
    otherWorktree = join(root, "unowned-worktree");
    await mkdir(repository);
    await git(repository, ["init", "--initial-branch", "main"]);
    await git(repository, ["config", "user.name", "Local fixture"]);
    await git(repository, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(repository, "base.txt"), "Retained baseline\n");
    await git(repository, ["add", "base.txt"]);
    await git(repository, ["commit", "--quiet", "-m", "fixture baseline"]);
    await git(repository, ["worktree", "add", "-b", "owned-native", worktree]);
    await git(repository, ["worktree", "add", "-b", "unowned-native", otherWorktree]);
    await mkdir(join(worktree, "nested"));
    rows[0]!.cwd = worktree;
    rows[3]!.cwd = otherWorktree;
  });
  const baseline = await f.captain.fleetEfficiency!("global-default");
  expect(baseline.seats.find((seat) => seat.seatId === "term_1")?.efficiency?.flags).toContain(
    "no progress in 2h",
  );
  // Discovery grants no ownership, but every native claimant still prevents exclusive commit attribution.
  f.rows[3]!.cwd = join(worktree, "nested");
  await writeFile(join(worktree, "delivered.txt"), "Advanced native deliverable\n");
  await git(worktree, ["add", "delivered.txt"]);
  await git(worktree, ["commit", "--quiet", "-m", "native deliverable"]);
  const shared = await f.captain.fleetEfficiency!("global-default");
  expect(shared.seats.find((seat) => seat.seatId === "term_1")?.efficiency?.flags).toContain(
    "no progress in 2h",
  );
  const [unowned] = f.rows.splice(3, 1);
  const exclusive = await f.captain.fleetEfficiency!("global-default");
  const own = exclusive.seats.find((seat) => seat.seatId === "term_1")?.efficiency;
  expect(own?.lastProgressAt).toBeDefined();
  expect(own?.flags).not.toContain("no progress in 2h");
  expect(exclusive.seats.find((seat) => seat.seatId === "term_2")?.efficiency?.flags).toContain(
    "no progress in 2h",
  );
  // The other seat returns on its original different branch, then changes
  // branches after discovery. A cached initial claim cannot establish exclusivity.
  unowned!.cwd = otherWorktree;
  f.rows.push(unowned!);
  await f.captain.fleetEfficiency!("global-default");
  await git(otherWorktree, ["checkout", "--ignore-other-worktrees", "owned-native"]);
  await writeFile(join(worktree, "later.txt"), "Commit while another native seat claims the branch\n");
  await git(worktree, ["add", "later.txt"]);
  // Git timestamps have one-second precision; a later timestamp makes a false
  // new progress attribution observable instead of coincidentally unchanged.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await git(worktree, ["commit", "--quiet", "-m", "shared branch commit"]);
  const collided = await f.captain.fleetEfficiency!("global-default");
  expect(collided.seats.find((seat) => seat.seatId === "term_1")?.efficiency?.lastProgressAt).toBe(
    own!.lastProgressAt,
  );
  // A forced primary-checkout claimant has no linked baseline and must not
  // make the linked branch appear exclusive merely because its claim is unknown.
  unowned!.cwd = repository;
  await git(repository, ["checkout", "--ignore-other-worktrees", "owned-native"]);
  await writeFile(join(worktree, "primary-shared.txt"), "Primary claimant remains unproven\n");
  await git(worktree, ["add", "primary-shared.txt"]);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await git(worktree, ["commit", "--quiet", "-m", "primary-shared branch commit"]);
  const primaryShared = await f.captain.fleetEfficiency!("global-default");
  expect(primaryShared.seats.find((seat) => seat.seatId === "term_1")?.efficiency?.lastProgressAt).toBe(
    own!.lastProgressAt,
  );
});

it("an admitted lead can record a scope finding, and another lead cannot change that exact seat", async () => {
  const f = await fixture();
  expect(
    await f.captain.fleetEfficiency!("global-default", {
      seatId: "term_1",
      offScope: true,
      assignmentStatus: "paused",
      evidence: "Owner paused VUH-1662; worker still active",
    }),
  ).toMatchObject({
    seats: [
      {
        seatId: "term_1",
        efficiency: { flags: expect.arrayContaining(["off-scope", "context 80%", "no progress in 2h"]) },
      },
      { seatId: "term_2" },
    ],
  });
  await expect(
    f.captain.fleetEfficiency!(f.other, {
      seatId: "term_1",
      offScope: false,
      evidence: "A different lead's attempted edit",
    }),
  ).rejects.toThrow(/does not lead/u);
  const roster = OperatorConversationServiceResultSchema.parse(
    await f.captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 }),
  );
  if (roster.op !== "fleet") throw new Error("No fleet roster");
  expect(roster.snapshot.seats.find((seat) => seat.seatId === "term_1")?.efficiency?.flags).toContain(
    "off-scope",
  );
  expect(roster.snapshot.seats.find((seat) => seat.seatId === "term_4")?.efficiency).toBeUndefined();
});

it("large native objectives stay available in the roster while the wake carries bounded untrusted summaries", async () => {
  const objective = "Long untrusted native context.\n".repeat(500);
  const f = await fixture(500, objective);
  const [event] = await f.captain.pollSeatEvents(3000, undefined, "global-default");
  expect(event?.content.length).toBeLessThanOrEqual(10_000);
  expect(event?.content).toContain("Untrusted seat context:");
  expect(event?.content).toContain('"seatId":"term_1"');
  expect(event?.content).toContain('"seatId":"term_2"');
  expect(event?.content).not.toContain(objective);
  const result = await f.captain.fleetEfficiency!("global-default");
  expect(result.seats[0]?.efficiency?.objective).toBe(objective);
  await f.finish(event!.id);
});

it("same-thread workers needing readoption remain visible to their historical lead without permission to edit the new occupant", async () => {
  const f = await fixture(500, undefined, true);
  const show = await f.captain.fleetEfficiency!("global-default");
  expect(show.seats.find((seat) => seat.seatId === "term_rebound")?.efficiency?.flags).toContain(
    "reports failing",
  );
  await expect(
    f.captain.fleetEfficiency!("global-default", {
      seatId: "term_rebound",
      offScope: false,
      evidence: "Historical hire only",
    }),
  ).rejects.toThrow(/re-adopted/u);
  const [event] = await f.captain.pollSeatEvents(3000, undefined, "global-default");
  expect(event?.content).toContain('"seatId":"term_rebound"');
  expect(event?.content).toContain("reports failing");
  await f.finish(event!.id);
});

it("periodic inspection queues behind an active native turn and coalesces until that turn finishes", async () => {
  const f = await fixture(250);
  const sessionId = randomUUID();
  expect(
    f.captain.syncSeatTranscript("global-default", { sessionId, entries: [], activity: "responding" }),
  ).toBe(true);
  expect(await f.captain.pollSeatEvents(900, undefined, "global-default")).toEqual([]);
  const journal = new ConversationJournal(join(f.root, "conversations"));
  expect(
    journal.read("global-default").filter((event) => event.type === "turn" && event.phase === "accepted"),
  ).toHaveLength(1);
  expect(
    f.captain.syncSeatTranscript("global-default", { sessionId, entries: [], activity: "waiting" }),
  ).toBe(true);
  const [event] = await f.captain.pollSeatEvents(3000, undefined, "global-default");
  expect(event?.content).toContain("Fleet lead round.");
  await f.finish(event!.id, "global-default", sessionId);
});

it("a held fleet refresh cannot recreate efficiency persistence after Captain closes", async () => {
  const f = await fixture();
  await f.captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
  expect(existsSync(join(f.root, "seat-efficiency.json"))).toBe(true);
  // Let the documented one-second read projection expire before holding a
  // new native census; otherwise this roster read correctly reuses the cache.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const held = f.holdNextCensus();
  const refresh = f.captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
  try {
    await held.started;
    f.rows[0]!.agent_status = "idle";
    await f.captain.close();
    await rm(f.root, { recursive: true, force: true });
    held.release();
    await refresh;
    expect(existsSync(f.root)).toBe(false);
  } finally {
    held.release();
    await refresh.catch(() => undefined);
  }
});

it("proof threshold retries an unavailable native alert, then cools down only after exact head acknowledgment", async () => {
  const originalId = randomUUID();
  const f = await fixture(
    60 * 60_000,
    undefined,
    false,
    true,
    async (root) => {
      new DeliveryFence(join(root, "delivery-receipts", "head", "global-default.json")).begin(originalId, {
        messageId: originalId,
        fingerprint: deliveryFingerprint("Earlier original"),
      });
    },
    undefined,
    false,
    false,
  );
  let now = Date.now();
  const attempts: Promise<boolean>[] = [];
  const settlements: string[] = [];
  const metrics = new FleetHealthMetrics({
    now: () => now,
    onProofAlert: (pane, rates) => {
      let observed: import("../src/captain/port.ts").FleetHealthAlertDelivery = { outcome: "unavailable" };
      const delivery = f.captain.notifyFleetHealthAlert(
        pane,
        `Fleet proof alert: ${rates.proof.refusals}/${rates.proof.attempts} refused.`,
        (result) => {
          observed = result;
        },
      );
      attempts.push(delivery);
      return delivery.then(() => {
        settlements.push(observed.outcome);
        return observed;
      });
    },
  });
  const proof = localFleetProof({
    platform: "darwin",
    herdrBinary: "herdr",
    binding: async () => undefined,
    diagnostics: (event, pane) => metrics.observeProof("fleet", event, pane),
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (_request, environment) =>
      Response.json({ accepted: await proof(environment.incoming.socket, "w1:p1") }),
  });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing real proof TCP listener");
  try {
    const refuse = async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      expect(await response.json()).toEqual({ accepted: false });
    };
    for (let count = 0; count < 100; count++) await refuse();
    expect(attempts).toHaveLength(0);
    now += 60_000;
    await refuse();
    expect(attempts).toHaveLength(1);
    expect(await attempts[0]).toBe(false);
    expect(await f.captain.pollSeatEvents(0, undefined, "global-default")).toEqual([]);
    expect(await f.captain.acknowledgeSeatEvent(originalId, "global-default")).toBe(true);
    now += 60_000;
    const poll = f.captain.pollSeatEvents(3000, undefined, "global-default");
    await refuse();
    const [event] = await poll;
    expect(event?.content).toBe("Fleet proof alert: 102/102 refused.");
    expect(attempts).toHaveLength(2);
    expect(await f.captain.acknowledgeSeatEvent(event!.id, "global-default")).toBe(true);
    expect(await attempts[1]).toBe(true);
    await Promise.resolve();
    expect(settlements).toEqual(["unavailable", "accepted"]);
    now += 60_000;
    await refuse();
    expect(attempts).toHaveLength(2);
    expect(await f.captain.pollSeatEvents(0, undefined, "global-default")).toEqual([]);
    expect(metrics.snapshot().totals.proof).toEqual({
      attempts: 103,
      refusals: 103,
      byReason: { missing_binding: 103 },
    });
  } finally {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
