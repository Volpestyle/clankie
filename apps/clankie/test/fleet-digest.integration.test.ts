import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { FileCredentialStore, mintOperatorToken } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { FleetCapacitySchema, OperatorFleetSnapshotSchema } from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import {
  FLEET_DAILY_DIGEST_PATH,
  FLEET_DIGEST_PATH,
  FleetDailyDigestReadSchema,
  FleetDigestSnapshotSchema,
} from "@clankie/protocol/fleet-digest";
import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { LeadStore } from "../src/captain/lead.ts";
import { FleetRoomJournal } from "../src/captain/fleet-room.ts";
import { leadChangeSources } from "../src/captain/lead-change-sources.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { githubConnection, githubConnectionFenced } from "../src/accounts.ts";
import { createFleetCapacityReader, projectFleetCapacity } from "../src/app/fleet-capacity.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";
import { ConnectorDetection } from "../src/app/connector-detection.ts";
import {
  runFleetDailyDigestCommand,
  runFleetDigestCommand,
  formatFleetDailyDigest,
  formatFleetDigest,
} from "../../tui/src/command/fleet-digest.ts";

const exec = promisify(execFile);
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: { daily?: boolean; digestOff?: boolean } = {}) {
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
  const hires = new ProjectHires(join(root, "project-hires.json"));
  const projects = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "fixture",
        name: "Fixture",
        workerCap: 2,
        roles: [{ role: "Engineer", harness: "claude", model: "fixture", effort: "high", concurrencyCap: 1 }],
      },
    ],
  });
  const hire = hires.reserve(projects, "fixture", {
    schemaVersion: 1,
    workingDirectory: repo,
    title: "PRIVATE-hire-title",
    role: "Engineer",
    effortReason: "Fixture hire for the digest's confirmed hire count, recorded in the real ledger.",
  });
  hires.launch(hire.id, projects);
  hires.pane(hire.id, "PRIVATE-hire-pane");
  hires.confirmed(hire.id);
  const ownerQuestion = await conversations.requestSurfaceQuestion(
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
  let now = new Date(Date.now() + 1000);
  const nowIso = now.toISOString();
  let providerUnavailable = false;
  const providerCalls: string[] = [];
  const github = createServer((request, response) => {
    providerCalls.push(request.method!);
    response.setHeader("content-type", "application/json");
    if (providerUnavailable) return void response.writeHead(503).end("{}");
    const address = new URL(request.url!, "http://fixture");
    if (address.pathname.endsWith("/issues")) {
      const old = new Date(now.getTime() - 40 * 86400_000).toISOString();
      const issue = (labels: string[], created: string, closed: string | null) => ({
        title: "PRIVATE-issue-title",
        created_at: created,
        closed_at: closed,
        labels: labels.map((name) => ({ name })),
      });
      const pull = (created: string, merged: string | null) => ({
        ...issue([], created, merged),
        pull_request: { merged_at: merged },
      });
      return void response.end(
        JSON.stringify(
          address.searchParams.get("labels") === "ci-finding"
            ? [issue(["ci-finding"], nowIso, null), issue(["ci-finding"], old, null)]
            : [
                issue(["ci-finding"], nowIso, null),
                issue([], nowIso, nowIso),
                issue([], old, nowIso),
                issue([], old, old),
                pull(nowIso, null),
                pull(old, nowIso),
                pull(old, old),
              ],
        ),
      );
    }
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
    confirmedHireTimes: () => hires.confirmedHireTimes(),
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
    ...(options.daily ? { fleetDailyDigest: { path: join(root, "daily-digest.json"), intervalMs: 20 } } : {}),
  };
  if (options.digestOff)
    await settings.update((current) => ({ ...current, fleet: { ...current.fleet, digestTime: "off" } }));
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
    settings,
    now: () => now,
    clockAt: (at: Date) => {
      now = at;
    },
    answerOwnerQuestion: () => {
      return conversations.cancelSurfaceQuestion(
        "global-default",
        {
          incarnationId: ownerQuestion.incarnationId!,
          requestId: ownerQuestion.question!.requestId,
          expectedRevision: ownerQuestion.revision!,
        },
        { current: () => true },
      );
    },
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

it.each(
  ["operator", "provider", "origin", "discovery"].flatMap((kind) =>
    [FLEET_DIGEST_PATH, FLEET_DAILY_DIGEST_PATH].map((path) => [kind, path] as const),
  ),
)(
  "the final publication refuses a %s change during the final authentication await of %s",
  async (kind, path) => {
    const f = await fixture({ daily: true, digestOff: true });
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
    const response = await f.read(f.token, path);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "fleet_digest_unavailable" });
  },
);

const launcher = (f: Awaited<ReturnType<typeof fixture>>, ...args: string[]) =>
  exec(process.execPath, [resolve("apps/tui/bin/clankie.ts"), ...args], {
    env: { ...process.env, CLANKIE_CONTROL_PLANE_URL: f.origin, CLANKIE_OPERATOR_TOKEN: f.token },
  });
const hostClock = (at: Date) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
const daily = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const response = await f.read(f.token, FLEET_DAILY_DIGEST_PATH);
  expect(response.status).toBe(200);
  return FleetDailyDigestReadSchema.parse(await response.json());
};
/** Long enough for the 20ms real timer to have ticked repeatedly. */
const ticks = () => new Promise((done) => setTimeout(done, 200));

it("generates the digest on the real timer at the owner's time, after quiet hours, once per day", async () => {
  const f = await fixture({ daily: true, digestOff: true });
  const path = join(f.root, "daily-digest.json");
  expect((await f.read("not-owner", FLEET_DAILY_DIGEST_PATH)).status).toBe(401);
  expect((await f.read(f.token, FLEET_DAILY_DIGEST_PATH + "?all=true")).status).toBe(400);

  await ticks();
  expect((await daily(f)).digest).toBeNull();
  expect((await daily(f)).schedule.time).toBe("off");

  const time = hostClock(new Date(f.now().getTime() - 60_000));
  const quietEnd = new Date(f.now().getTime() + 3600_000).toISOString().slice(11, 16);
  await f.settings.update((current) => ({
    ...current,
    desktop: {
      quietHours: {
        start: new Date(f.now().getTime() - 3600_000).toISOString().slice(11, 16),
        end: quietEnd,
        timeZone: "UTC",
      },
    },
  }));
  await launcher(f, "fleet", "set", "--digest-time", time);
  await ticks();
  expect((await daily(f)).digest).toBeNull();

  f.clockAt(new Date(f.now().getTime() + 3700_000));
  await vi.waitFor(async () => expect((await daily(f)).digest).not.toBeNull());
  const first = await daily(f);
  const digest = first.digest!;
  expect(first.schedule).toEqual({ time, timeZone: digest.timeZone });
  expect(digest).toMatchObject({
    generatedAt: f.now().toISOString(),
    since: new Date(f.now().getTime() - 86400_000).toISOString(),
    pullRequests: { opened: 1, merged: 1 },
    issues: { opened: 2, closed: 2 },
    ciFindings: { opened: 1, open: 2 },
    workers: { hired: 1, closed: 1 },
    reports: { done: 1, blocked: 1 },
    burn: { accountsObserved: 1, accountsRunningOut: 1 },
    sources: { github: "ready", reports: "ready", hires: "ready", closeHistory: "ready", capacity: "ready" },
  });
  const stored = await readFile(path, "utf8");
  expect(stored).not.toContain("PRIVATE");
  expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");

  // The same slot never generates twice, and a read is not what generates it.
  f.clockAt(new Date(f.now().getTime() + 3600_000));
  await ticks();
  expect((await daily(f)).digest).toEqual(digest);

  // The next day covers only what happened since the last digest.
  f.clockAt(new Date(Date.parse(digest.generatedAt) + 86400_000));
  await vi.waitFor(async () => expect((await daily(f)).digest?.generatedAt).toBe(f.now().toISOString()));
  const next = (await daily(f)).digest!;
  expect(next.since).toBe(digest.generatedAt);
  expect(next.slot > digest.slot).toBe(true);
  expect(next.workers.hired).toBe(0);
  expect(next.issues).toEqual({ opened: 0, closed: 0 });
  expect(next.ciFindings.open).toBe(2);
});

it("reads through API and shipped CLI with only live waits and without touching source state", async () => {
  const f = await fixture({ daily: true });
  await vi.waitFor(async () => expect((await daily(f)).digest).not.toBeNull());
  const retained = f.retained();
  const before = await daily(f);
  expect(before.waits.attention).toEqual([
    { kind: "owner_questions", count: 1 },
    { kind: "blocked_workers", count: 1 },
  ]);
  expect(JSON.stringify(before)).not.toContain("PRIVATE");
  const cli = await runFleetDailyDigestCommand(["--daily", "--json"], {
    host: f.origin,
    env: { CLANKIE_OPERATOR_TOKEN: f.token },
  });
  expect(cli).toEqual(before);
  expect(JSON.parse((await launcher(f, "fleet", "digest", "--daily", "--json")).stdout)).toEqual(before);
  const human = (await launcher(f, "fleet", "digest", "--daily")).stdout;
  expect(human).toBe(formatFleetDailyDigest(before));
  expect(human).toContain("Owner decisions pending: 1");
  expect(human).toContain("CI findings: 1 filed, 2 open now.");
  expect(f.retained()).toBe(retained);
  expect(f.providerCalls.every((method) => method === "GET")).toBe(true);

  // A question resolved after generation is gone; the stored digest did not change.
  await f.answerOwnerQuestion();
  const after = await daily(f);
  expect(after.waits.attention).toEqual([{ kind: "blocked_workers", count: 1 }]);
  expect(after.digest).toEqual(before.digest);
});

it("a provider outage records unknown, never zero activity", async () => {
  const f = await fixture({ daily: true });
  f.unavailable();
  await vi.waitFor(async () => expect((await daily(f)).digest).not.toBeNull());
  const { digest, waits } = await daily(f);
  expect(digest).toMatchObject({
    pullRequests: { opened: "unknown", merged: "unknown" },
    issues: { opened: "unknown", closed: "unknown" },
    ciFindings: { opened: "unknown", open: "unknown" },
    burn: { accountsObserved: "unknown" },
    sources: { github: "unavailable", capacity: "unavailable" },
  });
  expect(waits.attention.some((item) => item.kind === "incomplete_sources")).toBe(true);
});
