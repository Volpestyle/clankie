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
import { createWorkItemsService } from "../src/work-items.ts";

/**
 * VUH-1931 through the real service surfaces: the owner's tracker route, a fleet
 * worker's clankie_call, and the built-in tracker with an injected clock that
 * crosses two cycle boundaries. Nothing sleeps and nothing is mocked.
 */
it("plans a project cycle, reads its summary from the event stream and rolls unfinished items into the next cycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-cycles-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  let now = "2026-10-05T09:00:00.000Z";
  const tracker = createLocalTracker({ directory: join(root, "tracker"), clock: () => new Date(now) });
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
      clientInfo: { name: "tracker-cycles-integration", version: "1" },
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
  const current = async () =>
    (await call("linear_list_cycles", { type: "current", project: "Clankie Work" })).cycles[0];

  const project = await owner("save_project", { name: "Clankie Work", addTeams: ["LOCAL"] });
  expect(project.cycleDays).toBe(7);
  for (const title of ["Ship releases", "Build cycles", "Spike import", "Ready queue", "Polish"])
    await owner("save_issue", { team: "LOCAL", title, project: project.id });
  await owner("save_issue", { team: "LOCAL", title: "No project" });

  // Workers report work; the owner or the lead plans the cycle.
  const refused = await raw("linear_save_issue", { id: "LOCAL-1", cycle: "current" });
  expect(refused.detail).toContain("cycle_planning_reserved");
  for (const id of ["LOCAL-1", "LOCAL-2", "LOCAL-3"]) await owner("save_issue", { id, cycle: "current" });
  const next = await owner("save_issue", { id: "LOCAL-4", cycle: "next" });
  const unscoped = await app.app.request("/v1/tracker/owner/call", {
    method: "POST",
    headers: { authorization: "Bearer tracker-owner", "content-type": "application/json" },
    body: JSON.stringify({ name: "save_issue", arguments: { id: "LOCAL-6", cycle: "current" } }),
  });
  expect((await unscoped.json()).detail).toContain("Cycles are per project");

  const first = await current();
  expect(first).toMatchObject({
    number: 1,
    name: "Cycle 1",
    startsAt: "2026-10-05T00:00:00.000Z",
    endsAt: "2026-10-12T00:00:00.000Z",
    isActive: true,
  });
  expect(next.cycleId).not.toBe(first.id);

  // During the week: one finishes, one is dropped from the cycle, one is added late.
  now = "2026-10-07T15:00:00.000Z";
  await call("linear_post_issue_event", { issueId: "LOCAL-1", type: "ack" });
  await owner("save_issue", { id: "LOCAL-1", state: "Done" });
  await owner("save_issue", { id: "LOCAL-3", cycle: null });
  now = "2026-10-09T10:00:00.000Z";
  await owner("save_issue", { id: "LOCAL-5", cycle: 1 });
  expect((await current()).summary).toEqual({
    planned: [],
    added: ["LOCAL-1", "LOCAL-2", "LOCAL-3", "LOCAL-5"],
    rolledIn: [],
    removed: ["LOCAL-3"],
    finished: ["LOCAL-1"],
    rolledOver: [],
    inFlight: ["LOCAL-2", "LOCAL-5"],
  });

  // The boundary passes. The first access after it rolls unfinished items forward.
  now = "2026-10-12T08:00:00.000Z";
  const second = await current();
  expect(second).toMatchObject({ number: 2, startsAt: "2026-10-12T00:00:00.000Z", isActive: true });
  expect(second.summary).toMatchObject({
    planned: ["LOCAL-4"],
    rolledIn: ["LOCAL-2", "LOCAL-5"],
    inFlight: ["LOCAL-2", "LOCAL-4", "LOCAL-5"],
  });
  const closed = await call("linear_get_cycle", { id: first.id });
  expect(closed).toMatchObject({ isPast: true, issues: ["LOCAL-1"] });
  expect(closed.summary).toMatchObject({
    finished: ["LOCAL-1"],
    rolledOver: ["LOCAL-2", "LOCAL-5"],
    inFlight: [],
  });
  const rolled = (await call("linear_list_issue_events", { issueId: "LOCAL-2" })).events.at(-1);
  expect(rolled).toMatchObject({
    type: "cycle",
    from: first.id,
    to: second.id,
    body: "Cycle 1 → Cycle 2",
    via: "rollover",
    selfEcho: true,
    actor: { type: "agent-worker", id: "clankie" },
  });
  expect(
    (await call("linear_list_issues", { project: "Clankie Work", cycle: "current" })).issues
      .map((issue: { identifier: string }) => issue.identifier)
      .sort(),
  ).toEqual(["LOCAL-2", "LOCAL-4", "LOCAL-5"]);

  // Cycle length is a stored project setting. It applies from the next cycle, and
  // an access long after several boundaries rolls straight into the current cycle.
  await owner("save_project", { id: project.id, cycleDays: 14 });
  now = "2026-10-27T12:00:00.000Z";
  const third = await current();
  expect(third).toMatchObject({
    number: 3,
    startsAt: "2026-10-19T00:00:00.000Z",
    endsAt: "2026-11-02T00:00:00.000Z",
  });
  expect(third.summary.rolledIn).toEqual(["LOCAL-2", "LOCAL-4", "LOCAL-5"]);
  const events = (await call("linear_list_issue_events", {})).events.length;
  await current();
  expect((await call("linear_list_issue_events", {})).events).toHaveLength(events);
});
