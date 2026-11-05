import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { FileCredentialStore, mintOperatorToken } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { FleetCapacitySchema, OperatorFleetSnapshotSchema } from "@clankie/protocol";
import { FleetDigestSnapshotSchema, FLEET_DIGEST_PATH } from "@clankie/protocol/fleet-digest";
import { afterEach, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { LeadStore } from "../src/captain/lead.ts";
import { FleetRoomJournal } from "../src/captain/fleet-room.ts";
import { leadChangeSources } from "../src/captain/lead-change-sources.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { githubConnection, githubConnectionFenced } from "../src/accounts.ts";
import { createFleetCapacityReader, projectFleetCapacity } from "../src/app/fleet-capacity.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";
import { ConnectorDetection } from "../src/app/connector-detection.ts";
import { runFleetDigestCommand, formatFleetDigest } from "../../tui/src/command/fleet-digest.ts";

const exec = promisify(execFile);
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fleet-digest-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "PRIVATE-repo");
  await mkdir(repo);
  await exec("git", ["init", "--quiet", repo]);
  await exec("git", [
    "-C",
    repo,
    "remote",
    "add",
    "origin",
    "https://github.com/fixture/PRIVATE-project.git",
  ]);
  const settings = new SettingsStore(join(root, "settings.json"));
  const operatorStore = new FileCredentialStore(join(root, "operator.json"));
  const provider = new FileCredentialStore(join(root, "provider.json"));
  const token = mintOperatorToken();
  await operatorStore.set("clankie_operator", { type: "api", key: token });
  await provider.set("github", { type: "api", key: "PRIVATE-provider-token" });
  const conversations = new ConversationStore(join(root, "conversations"), async () => {
    throw Error("No model turns");
  });
  cleanups.push(() => conversations.close());
  const lead = new LeadStore(join(root, "lead.json"), join(root, "held.json"));
  lead.set("apps");
  lead.hold({ conversationId: "global-default", origin: "watch", text: "PRIVATE-inbox" });
  const board = new FleetRoomJournal(join(root, "board"));
  board.postAppNote("PRIVATE-author", "PRIVATE-note");
  for (const kind of ["done", "blocked"] as const) {
    const receipts = new InboundSeatReceipts(join(root, `${kind}-receipts.json`), conversations);
    const id = randomUUID();
    expect(
      receipts.accept(
        "PRIVATE-worker",
        { id, binding: "a".repeat(64) },
        "PRIVATE-report",
        "PRIVATE-report",
        "global-default",
        async (_id, _text, _publish, context) => {
          context?.deliveryReceipt?.("unavailable");
        },
        { source: "adoption", conversationId: "global-default" },
        { kind: "conversation", owner: { conversationId: "global-default" } },
        false,
        "PRIVATE-pane",
        undefined,
        kind,
      ).received,
    ).toBe(true);
  }
  await conversations.requestSurfaceQuestion(
    "global-default",
    {
      purpose: "decision",
      kind: "choice",
      prompt: "PRIVATE-question",
      waitingOn: "PRIVATE-wait",
      recommendation: "PRIVATE-recommendation",
      options: [{ label: "Yes" }, { label: "No" }],
      allowFreeform: false,
    },
    { current: () => true },
  );
  const now = new Date(Date.now() + 1000);
  const nowIso = now.toISOString();
  let providerUnavailable = false;
  const providerCalls: string[] = [];
  const github = createServer((request, response) => {
    providerCalls.push(request.method!);
    response.setHeader("content-type", "application/json");
    if (providerUnavailable) return void response.writeHead(503).end("{}");
    const onlyOpen = new URL(request.url!, "http://fixture").searchParams.get("state") === "open";
    const pull = (number: number, merged: boolean) => ({
      number,
      html_url: `https://github.com/fixture/PRIVATE-project/pull/${number}`,
      title: "PRIVATE-pr-title",
      state: merged ? "closed" : "open",
      merged_at: merged ? nowIso : null,
      updated_at: nowIso,
    });
    response.end(JSON.stringify(onlyOpen ? [pull(1, false)] : [pull(1, false), pull(2, true)]));
  });
  github.listen(0, "127.0.0.1");
  await once(github, "listening");
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        github.closeAllConnections();
        github.close(() => done());
      }),
  );
  const work = createWorkItemsService({
    clock: () => now,
    stateDirectory: join(root, "work"),
    workspace: () => repo,
    githubConnection: () => githubConnection(provider),
    githubConnectionFence: () => githubConnectionFenced(provider),
    githubApiBase: `http://127.0.0.1:${(github.address() as { port: number }).port}`,
  });
  const detection = new ConnectorDetection();
  const close = (state: "closed" | "close_unconfirmed" | "reopened", at: string) => ({
    id: randomUUID(),
    paneId: "PRIVATE-closed-pane",
    seatId: "PRIVATE-closed-seat",
    title: "PRIVATE-close-title",
    harness: "codex",
    reason: "PRIVATE-close-reason",
    lastOutput: "PRIVATE-output",
    reportPath: "/PRIVATE/report.md",
    closedAt: at,
    undoUntil: nowIso,
    state,
  });
  const fleet = OperatorFleetSnapshotSchema.parse({
    schemaVersion: 1,
    cursor: "fleet:1",
    seats: ["working", "blocked", "done"].map((status, i) => ({
      seatId: `PRIVATE-seat-${i}`,
      occupantId: `PRIVATE-session-${i}`,
      personaId: `PRIVATE-persona-${i}`,
      harness: "codex",
      status,
      title: "PRIVATE-title",
      workingDirectory: "/PRIVATE/worktree",
      owner: { conversationId: "PRIVATE-lead", hired: i < 2 },
    })),
    personas: [],
    channels: [],
    closedPanes: [
      close("closed", nowIso),
      close("close_unconfirmed", nowIso),
      close("reopened", nowIso),
      close("closed", new Date(now.getTime() - 86400_000).toISOString()),
    ],
  });
  const burn = {
    harness: "codex",
    account: "PRIVATE-account",
    plan: "PRIVATE-plan",
    machines: ["PRIVATE-machine"],
    observedAt: nowIso,
    windows: [
      {
        id: "PRIVATE-window",
        label: "PRIVATE-window",
        usedPercent: 90,
        resetsAt: new Date(now.getTime() + 3600_000).toISOString(),
        hoursToReset: 1,
        percentPerHour: { recent: 20, recentOverMinutes: 30, windowAverage: 20, toUseAllByReset: 10 },
        projectedUsedAtReset: 110,
        runsOutAt: new Date(now.getTime() + 1800_000).toISOString(),
      },
    ],
    lastHour: "unknown",
  };
  const capacity = FleetCapacitySchema.parse({
    ...projectFleetCapacity({
      observedAt: nowIso,
      machines: [
        {
          machine: "PRIVATE-machine",
          accounts: [
            {
              harness: "codex",
              label: "PRIVATE-account",
              home: "/PRIVATE/home",
              identity: "PRIVATE-email",
              signedIn: true,
              headroom: 0.1,
              usable: true,
            },
          ],
        },
      ],
      seats: [],
    }),
    burn: [burn],
    heavy: { slots: 2, used: 1, remaining: 1, queued: 3, lightSlots: 1, lightUsed: 0 },
    machineResources: {
      local: {
        source: "host-reported",
        advisory: true,
        status: "available",
        observedAt: nowIso,
        full: { slots: 2, used: 1, queued: 3, remaining: 1 },
        light: "unknown",
        server: "unknown",
      },
    },
  });
  const operations: string[] = [];
  let capacityUnavailable = false;
  let afterAuthentication: undefined | (() => Promise<void> | void);
  let authenticationCalls = 0;
  const baseAuthentication = createCredentialBackedOperatorAuthenticator({
    store: operatorStore,
    env: {},
    identity: { operatorId: "fixture-owner" },
  });
  const authenticateOperator = Object.assign(
    async (request: Request) => {
      const result = await baseAuthentication(request);
      authenticationCalls++;
      if (authenticationCalls === 2) await afterAuthentication?.();
      return result;
    },
    { readFence: baseAuthentication.readFence! },
  );
  const captain = createStubCaptain({
    leadChangeSources: () =>
      leadChangeSources({
        conversations,
        lead,
        notes: (input) => Promise.resolve(board.readAppNotes(input)),
        herdr: false,
      }),
    serveOperatorConversation: async (request) => {
      operations.push(request.op);
      if (request.op === "fleet") return { op: "fleet", schemaVersion: 1, snapshot: fleet };
      if (request.op === "fleet_capacity") {
        expect(request.includeMachineResources).toBe(true);
        if (capacityUnavailable) throw Error("PRIVATE-capacity-failure");
        return { op: "fleet_capacity", schemaVersion: 1, result: capacity };
      }
      throw Error(`Unexpected mutation ${request.op}`);
    },
  });
  const dependencies = {
    captain,
    settings,
    authenticateOperator,
    workItems: work,
    connectorDetection: detection,
    clock: () => now,
  };
  const service = await createClankieApp(dependencies);
  cleanups.push(() => service.close());
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        if ("closeAllConnections" in server) server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const read = (bearer = token, path = FLEET_DIGEST_PATH) =>
    fetch(origin + path, { headers: { authorization: `Bearer ${bearer}` } });
  const retained = () =>
    JSON.stringify({
      reports: conversations.inboundReports(undefined, { includeRead: true }),
      questions: conversations.pendingLeadQuestions(),
      notes: board.readAppNotes({ cursor: "0" }),
      inbox: lead.inbox(0, 100),
    });
  return {
    root,
    origin,
    token,
    read,
    retained,
    operations,
    captain,
    providerCalls,
    operatorStore,
    provider,
    repo,
    detection,
    unavailable: () => {
      providerUnavailable = capacityUnavailable = true;
    },
    afterAuthentication: (callback: () => Promise<void> | void) => {
      authenticationCalls = 0;
      afterAuthentication = callback;
    },
  };
}

it("the owner HTTP/CLI read composes real reports, asks and provider projections without leaking or acknowledging them", async () => {
  const f = await fixture();
  expect((await f.read("not-owner")).status).toBe(401);
  expect((await f.read(f.token, FLEET_DIGEST_PATH + "?includePrivate=true")).status).toBe(400);
  const retained = f.retained();
  const response = await f.read();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = FleetDigestSnapshotSchema.parse(await response.json());
  expect(body.attention).toEqual([
    { kind: "owner_questions", count: 1 },
    { kind: "blocked_workers", count: 1 },
  ]);
  expect(body.workers).toMatchObject({ hired: 2, working: 1, blocked: 1, finished: 1 });
  expect(body.activity).toEqual({ doneReportsToday: 1, blockedReportsToday: 1, confirmedClosesToday: 1 });
  expect(body.pullRequests).toMatchObject({ open: 1, merged: 1 });
  expect(body.burn).toEqual({
    accountsObserved: 1,
    accountsRunningOut: 1,
    accountsWithUnknownPace: 0,
    lastHourKnownTokens: "unknown",
    accountsMissingTokens: 1,
  });
  expect(body.resources).toEqual({
    heavy: { slots: 2, used: 1, queued: 3 },
    machines: { available: 1, unavailable: 0 },
  });
  expect(JSON.stringify(body)).not.toContain("PRIVATE");
  expect(f.operations).toEqual(["fleet", "fleet_capacity"]);
  const cli = await runFleetDigestCommand(["--json"], {
    host: f.origin,
    env: { CLANKIE_OPERATOR_TOKEN: f.token },
  });
  expect(cli).toEqual(body);
  expect(formatFleetDigest(cli)).not.toContain("PRIVATE");
  expect(formatFleetDigest(cli).indexOf("Owner decisions pending: 1")).toBeLessThan(
    formatFleetDigest(cli).indexOf("Workers:"),
  );
  const launch = await exec(
    process.execPath,
    [resolve("apps/tui/bin/clankie.ts"), "fleet", "digest", "--json"],
    { env: { ...process.env, CLANKIE_CONTROL_PLANE_URL: f.origin, CLANKIE_OPERATOR_TOKEN: f.token } },
  );
  expect(JSON.parse(launch.stdout)).toEqual(body);
  const human = await exec(process.execPath, [resolve("apps/tui/bin/clankie.ts"), "fleet", "digest"], {
    env: { ...process.env, CLANKIE_CONTROL_PLANE_URL: f.origin, CLANKIE_OPERATOR_TOKEN: f.token },
  });
  expect(human.stdout).toBe(formatFleetDigest(body));
  expect(f.retained()).toBe(retained);
  expect(f.providerCalls.every((method) => method === "GET")).toBe(true);
});

it("unavailable observations remain unknown and discovery-off never reads a fleet", async () => {
  const f = await fixture();
  f.unavailable();
  f.detection.setMultiplexer("herdr", false);
  const response = await f.read();
  expect(response.status).toBe(200);
  const body = FleetDigestSnapshotSchema.parse(await response.json());
  expect(body.workers.hired).toBe("unknown");
  expect(body.pullRequests.open).toBe("unknown");
  expect(body.burn.accountsObserved).toBe("unknown");
  expect(body.resources.heavy).toBe("unknown");
  expect(body.activity.confirmedClosesToday).toBe("unknown");
  expect(body.attention[0]).toEqual({ kind: "owner_questions", count: 1 });
  expect(f.operations).toEqual([]);
  expect(JSON.stringify(body)).not.toContain("PRIVATE");
});

it("discovery off avoids native inventory through the real capacity reader", async () => {
  const f = await fixture();
  const native = await isolatedHerdr(join(f.root, "native"));
  cleanups.push(() => native.close());
  let inventories = 0;
  const capacity = createFleetCapacityReader({
    settings: async () => ({ execution: { connections: [] } }),
    accounts: async () => ({ machine: "local", accounts: [] }),
    seats: async () => {
      inventories++;
      await native.cli("pane", "list");
      return [];
    },
    leadSeatId: () => undefined,
    heavy: () => undefined,
    tracker: () => undefined,
    sessionBurn: async () => ({ sessions: [], truncated: false }),
  });
  const original = f.captain.serveOperatorConversation.bind(f.captain);
  f.captain.serveOperatorConversation = async (request) =>
    request.op === "fleet_capacity"
      ? { op: "fleet_capacity", schemaVersion: 1, result: await capacity(request.includeMachineResources) }
      : original(request);

  // Confirm the real reader reaches the isolated native inventory when enabled.
  expect((await f.read()).status).toBe(200);
  expect(inventories).toBe(1);
  inventories = 0;
  f.detection.setMultiplexer("herdr", false);
  const response = await f.read();
  expect(response.status).toBe(200);
  const body = FleetDigestSnapshotSchema.parse(await response.json());
  expect(inventories).toBe(0);
  expect(body.workers.hired).toBe("unknown");
  expect(body.sources.capacity).toBe("unavailable");
  expect(body.burn.accountsObserved).toBe("unknown");
  expect(body.resources).toEqual({ heavy: "unknown", machines: "unknown" });
});

it.each(["operator", "provider", "origin", "discovery"])(
  "the final publication refuses a %s change during the final authentication await",
  async (kind) => {
    const f = await fixture();
    f.afterAuthentication(async () => {
      if (kind === "operator")
        await f.operatorStore.set("clankie_operator", { type: "api", key: mintOperatorToken() });
      if (kind === "provider") await f.provider.set("github", { type: "api", key: "PRIVATE-reconnected" });
      if (kind === "origin")
        await exec("git", [
          "-C",
          f.repo,
          "remote",
          "set-url",
          "origin",
          "https://github.com/fixture/PRIVATE-other.git",
        ]);
      if (kind === "discovery") f.detection.setMultiplexer("herdr", false);
    });
    const response = await f.read();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "fleet_digest_unavailable" });
  },
);
