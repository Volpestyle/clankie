import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker } from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { trackerRunner } from "../src/tracker-runner.ts";
import { createWorkItemsService } from "../src/work-items.ts";

/**
 * VUH-1918 through the real service surfaces: the owner's tracker route, a fleet
 * worker's clankie_call, and the built-in tracker with an injected clock. The run
 * link reads the service's hire lookup; this test fleet's pane is unverified, so the
 * link names the fleet and says it cannot name a hire.
 */
it("orders the ready queue, expires leases, rolls run cost up to the item and shows drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-runs-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  let now = "2026-10-05T09:00:00.000Z";
  const tracker = createLocalTracker({
    directory: join(root, "tracker"),
    clock: () => new Date(now),
    runner: (actor) => trackerRunner(actor.id, () => ({ state: "none" })),
  });
  let workItems!: ReturnType<typeof createWorkItemsService>;
  const host = createMcpHost({
    credentials,
    settings,
    localTracker: tracker,
    curated: [
      {
        id: "linear",
        credential: "linear",
        transport: "http",
        url: "http://127.0.0.1:1/mcp",
        args: [],
        lane: "everywhere",
        initialTools: [],
        enabled: true,
      },
    ],
    trackerForRepo: ({ name, args, repo, local, ...publication }) =>
      workItems.callTracker(name, args, { repo, local, ...publication }),
    trackerRepoForCall: (name, args) => workItems.resolveTrackerRepo(name, args),
    logger: { info() {}, warn() {} },
  });
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  workItems = createWorkItemsService({
    stateDirectory: join(root, "work"),
    globalTrackerDirectory: join(root, "tracker"),
    workspace: () => workspace,
    mcpHost: host,
  });
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const snapshot = await settings.loadFenced();
      return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
    },
  });
  const app = await createClankieApp({
    captain: createStubCaptain({}),
    workerMcp: worker,
    workItems,
    builtInTracker: tracker,
    fleetLinks: {
      identity: () => undefined,
      authenticate: (token) => (token === "local-fleet-test" ? "test-fleet" : undefined),
    },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer tracker-owner" ? { operatorId: "owner" } : undefined,
  });
  let sequence = 0;
  let session: string | undefined;
  const rpc = (method: string, params: unknown) =>
    app.app.request("/v1/fleet/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-fleet-test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
  session = (
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tracker-runs-integration", version: "1" },
    })
  ).headers.get("mcp-session-id")!;
  const raw = async (name: string, args: Record<string, unknown>) => {
    const response = await rpc("tools/call", { name: "clankie_call", arguments: { name, arguments: args } });
    const result = (await response.json()).result as { content: { text: string }[] };
    return JSON.parse(result.content[0]!.text) as { outcome: string; content?: string; detail?: string };
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await raw(name, args);
    expect(reply, JSON.stringify(reply)).toMatchObject({ outcome: "ok" });
    return JSON.parse(reply.content!);
  };
  const owner = async (name: string, args: Record<string, unknown>) => {
    const response = await app.app.request("/v1/tracker/owner/call", {
      method: "POST",
      headers: { authorization: "Bearer tracker-owner", "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.result;
  };

  const ids = (issues: { identifier: string }[]) => issues.map((issue) => issue.identifier);
  const ready = async () => ids((await call("linear_list_ready_issues", { project: "Clankie Work" })).issues);

  const project = await owner("save_project", { name: "Clankie Work", addTeams: ["LOCAL"] });
  for (const [title, priority] of [
    ["Medium", 3],
    ["Urgent", 1],
    ["High, in the cycle", 2],
    ["Blocked", 2],
    ["Low blocker", 4],
    ["Unprioritized", 0],
  ] as const)
    await owner("save_issue", { team: "LOCAL", title, priority, project: project.id });
  await owner("save_issue", { id: "LOCAL-3", cycle: "current" });
  await owner("save_issue", { id: "LOCAL-4", blockedBy: ["LOCAL-5"] });

  // Current cycle first, then urgent to low with none last; blocked work waits.
  expect(await ready()).toEqual(["LOCAL-3", "LOCAL-2", "LOCAL-1", "LOCAL-5", "LOCAL-6"]);

  // A worker leases an item: it leaves the queue, and nobody else can lease or run it.
  const leased = await call("linear_save_lease", { issueId: "LOCAL-1", ttlMinutes: 30 });
  // Write times are strictly increasing, so they sit a few milliseconds past the clock.
  expect(leased.lease.expiresAt).toMatch(/^2026-10-05T09:30:00\.\d{3}Z$/u);
  expect(await ready()).toEqual(["LOCAL-3", "LOCAL-2", "LOCAL-5", "LOCAL-6"]);
  const taken = await app.app.request("/v1/tracker/owner/call", {
    method: "POST",
    headers: { authorization: "Bearer tracker-owner", "content-type": "application/json" },
    body: JSON.stringify({ name: "save_run", arguments: { issueId: "LOCAL-1" } }),
  });
  expect((await taken.json()).detail).toContain("lease_held");

  // The lease expires on its own: the item is ready again, and drift shows the stale lease.
  now = "2026-10-05T09:31:00.000Z";
  expect(await ready()).toEqual(["LOCAL-3", "LOCAL-2", "LOCAL-1", "LOCAL-5", "LOCAL-6"]);
  expect((await call("linear_list_drift", { project: "Clankie Work" })).staleLeases).toEqual([
    { identifier: "LOCAL-1", holder: expect.any(String), expiresAt: leased.lease.expiresAt },
  ]);
  const takeover = await owner("save_lease", { issueId: "LOCAL-1" });
  expect(takeover.lease).toMatchObject({ actor: { type: "human" } });
  expect(takeover.lease.expiresAt).toMatch(/^2026-10-05T10:01:00\.\d{3}Z$/u);
  expect((await call("linear_list_issue_events", { issueId: "LOCAL-1" })).events.at(-1).body).toContain(
    `lease expired at ${leased.lease.expiresAt as string}`,
  );

  // Runs: an attempt fails, its retry is a child run; cost and time roll up to the item.
  const attempt = await call("linear_save_run", {
    issueId: "LOCAL-2",
    worktree: "/work/vuh-1918",
    branch: "clankie2/vuh-1918",
  });
  expect(attempt).toMatchObject({ number: 1, status: "active", identifier: "LOCAL-2" });
  expect(attempt.link).toEqual({ fleet: "test-fleet", hired: "unverified" });
  expect(await ready()).not.toContain("LOCAL-2");
  now = "2026-10-05T10:01:00.000Z";
  await call("linear_save_run", {
    id: attempt.id,
    status: "failed",
    tokens: 120_000,
    costUsd: 1.5,
    summary: "Flaky gate",
  });
  const retry = await call("linear_save_run", { issueId: "LOCAL-2", parentRunId: attempt.id });
  expect(retry).toMatchObject({ number: 2, parentRunId: attempt.id });
  now = "2026-10-05T10:31:00.000Z";
  await call("linear_save_run", { id: retry.id, tokens: 80_000, costUsd: 1 });
  const work = (await call("linear_get_issue", { id: "LOCAL-2" })).work;
  expect(work).toMatchObject({ runs: 2, activeRuns: 1, tokens: 200_000, costUsd: 2.5, leased: false });
  // 30 minutes failed, then 30 so far on the retry (plus write-time milliseconds).
  expect(Math.round(work.durationMs / 60_000)).toBe(60);
  const runs = (await call("linear_list_runs", { issueId: "LOCAL-2" })).runs;
  expect(runs.map((run: { number: number; status: string }) => [run.number, run.status])).toEqual([
    [2, "active"],
    [1, "failed"],
  ]);
  const events = (await call("linear_list_issue_events", { issueId: "LOCAL-2" })).events.filter(
    (event: { type: string }) => event.type === "run",
  );
  expect(events.map((event: { body: string }) => event.body)).toEqual([
    "Run 1 started in /work/vuh-1918",
    "Run 1 failed: Flaky gate",
    "Run 2 started",
  ]);

  // Drift: the owner closes the item while its retry is still running, and the rest go quiet.
  await owner("save_issue", { id: "LOCAL-2", state: "Done" });
  now = "2026-11-06T00:00:00.000Z";
  const drifted = await call("linear_list_drift", { project: "Clankie Work" });
  expect(drifted.activeRunsOnClosedIssues).toEqual([
    expect.objectContaining({ identifier: "LOCAL-2", state: "Done", runId: retry.id, worktree: null }),
  ]);
  expect(ids(drifted.idleIssues).sort()).toEqual(["LOCAL-1", "LOCAL-3", "LOCAL-4", "LOCAL-5", "LOCAL-6"]);
  expect(drifted.staleLeases).toEqual([expect.objectContaining({ identifier: "LOCAL-1" })]);
  await owner("save_run", { id: retry.id, status: "canceled" });
  expect((await call("linear_list_drift", { project: "Clankie Work" })).activeRunsOnClosedIssues).toEqual([]);
});
