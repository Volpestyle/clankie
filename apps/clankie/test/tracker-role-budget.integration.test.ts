import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { ProjectsSettingsSchema } from "@clankie/protocol";
import type { TrackerRequestBudgetReport } from "@clankie/protocol/tracker-request-budget";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker, trackerRoleRefusal, writeConvention } from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { TrackerRequestBudget } from "../src/tracker-request-budget.ts";
import {
  trackerRepoForPrincipal,
  trackerRoleForPrincipal,
  trackerWorkerNameForPrincipal,
} from "../src/tracker-runner.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { runWorkCommand } from "../../tui/src/command/work.ts";

/**
 * LOCAL-VUH-45 through the real service: hired fleet workers' and reviewers' native MCP
 * sessions see their role's tracker profile and are refused the lead and owner verbs by
 * name; per-actor budgets split interactive from background. One scratch built-in store.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

type Reply = {
  outcome: string;
  content?: string;
  detail?: string;
  reason?: string;
  role?: string;
  retryAt?: number;
  retryAfterMs?: number;
};

async function fixture(budget = new TrackerRequestBudget()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tracker-role-budget-")));
  const trackerDirectory = join(root, "tracker");
  // The service checks evidence references against its evidence store; this fixture holds one record.
  const validateEvidence = async () => {};
  const tracker = createLocalTracker({ directory: trackerDirectory, validateEvidence });
  const settings = new SettingsStore(join(root, "settings.json"));
  const hires = new ProjectHires(join(root, "project-hires.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const logged: Record<string, unknown>[] = [];
  /** Personas bound to `seatId occupantId`, as the captain's live roster binds them. */
  const personaNames = new Map<string, string>();
  /** Panes hired outside the default fleet, such as a linked PC's. */
  const paneFleets = new Map<string, string>();
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
    trackerRepoForCall: (name, args, fence) => workItems.resolveTrackerRepo(name, args, fence),
    trackerRepoForWorker: (principalId, fence) =>
      trackerRepoForPrincipal(
        principalId,
        (fleet, pane) => hires.membershipCandidate(fleet, pane),
        (projectId, projectFence) => workItems.trackerRepoForProject(projectId, projectFence),
        fence,
      ),
    trackerRepoForItem: (references, fence) => workItems.cutoverRepoForReferences(references, fence),
    trackerRoleForWorker: (principalId) =>
      trackerRoleForPrincipal(
        principalId,
        (fleet, pane) => hires.membershipCandidate(fleet, pane),
        async (projectId) =>
          (await settings.read()).projects.projects.find((project) => project.id === projectId)?.review,
      ),
    trackerRequestBudget: budget,
    // As the service names a fleet worker: its bound persona, else its seat (LOCAL-VUH-59).
    trackerWorkerName: (principalId) =>
      trackerWorkerNameForPrincipal(
        principalId,
        (fleet, pane) => hires.membershipCandidate(fleet, pane),
        (seatId, occupantId) => personaNames.get(`${seatId} ${occupantId}`),
      ),
    logger: { info() {}, warn: (context) => void logged.push(context) },
  });
  workItems = createWorkItemsService({
    stateDirectory: join(root, "work"),
    globalTrackerDirectory: trackerDirectory,
    projects: async () => (await settings.load()).projects,
    projectsFence: async () => {
      const snapshot = await settings.loadFenced();
      return { projects: snapshot.settings.projects, assertCurrent: snapshot.assertCurrent };
    },
    localMachineId: "local",
    mcpHost: host,
    builtInTracker: (assertIssueWrite) =>
      assertIssueWrite === undefined
        ? tracker
        : createLocalTracker({ directory: trackerDirectory, validateEvidence, assertIssueWrite }),
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
    settings,
    workerMcp: worker,
    workItems,
    builtInTracker: tracker,
    trackerRequestBudget: budget,
    fleetLinks: {
      identity: () => undefined,
      authenticate: (token) => (token === "local-fleet-test" ? "test-fleet" : undefined),
    },
    // Stands in for the local socket's pane proof (LocalFleetLink); the hire records stay real.
    localFleet: {
      identity: (request) => {
        const pane = request.headers.get("x-test-local-pane");
        return pane === null
          ? undefined
          : {
              fleet: paneFleets.get(pane) ?? "default",
              pane,
              validate: async () => true,
              current: () => true,
            };
      },
    },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  cleanups.push(async () => {
    app.close();
    await rm(root, { recursive: true, force: true });
  });

  const owner = async (name: string, args: Record<string, unknown>) => {
    const response = await app.app.request("/v1/tracker/owner/call", {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });
    const body = (await response.json()) as Record<string, any>;
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.result;
  };
  const team = (await owner("list_teams", {})).teams[0].id as string;
  const workspace = join(root, "x");
  await mkdir(workspace);
  await writeConvention(workspace, {
    schemaVersion: 1,
    backend: "builtin",
    decidedBy: "owner",
    decidedAt: "2026-10-27T00:00:00.000Z",
  });
  const project = await owner("save_project", { name: "Project X", addTeams: [team] });
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "project-x",
          name: "Project X",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: workspace }],
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
          trackerProjectId: project.id,
          review: { role: "reviewer" },
        },
      ],
    }),
  }));
  const hire = async (pane: string, role: string, fleet = "default") => {
    if (fleet !== "default") paneFleets.set(pane, fleet);
    const saved = (await settings.load()).projects;
    const { id } = hires.reserve(saved, "project-x", {
      schemaVersion: 1,
      ...(fleet === "default" ? {} : { fleet }),
      workingDirectory: workspace,
      title: `${role} ${pane}`,
      harness: "claude",
      role,
    });
    hires.launch(id, saved);
    hires.pane(id, pane);
    hires.confirmed(id);
    // A remote fleet's census qualifies the terminal, so the hire records pc/seat-….
    hires.observe(id, fleet === "default" ? `seat-${pane}` : `${fleet}/seat-${pane}`, `occupant-${pane}`, {
      nativeOccupantId: `occupant-${pane}`,
      fleet,
      pane,
      binding: { socketPath: join(root, "herdr.sock") },
      processes: [{ pid: 22, startTime: "today" }],
      shell: { pid: 11, startTime: "earlier" },
    });
  };

  let sequence = 0;
  const sessions = new Map<string, string>();
  const rpc = (method: string, params: unknown, pane: string) =>
    app.app.request("/v1/fleet/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-fleet-test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-test-local-pane": pane,
        ...(sessions.has(pane) ? { "mcp-session-id": sessions.get(pane)! } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
  const tool = async (pane: string, name: string, args: Record<string, unknown>) => {
    if (!sessions.has(pane))
      sessions.set(
        pane,
        (
          await rpc(
            "initialize",
            {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "tracker-role-budget-integration", version: "1" },
            },
            pane,
          )
        ).headers.get("mcp-session-id")!,
      );
    const response = await rpc("tools/call", { name, arguments: args }, pane);
    return ((await response.json()).result as { content: { text: string }[] }).content[0]!.text;
  };
  /** A hired seat's clankie_call from its verified local pane. */
  const raw = async (pane: string, name: string, args: Record<string, unknown>, background?: boolean) =>
    JSON.parse(
      await tool(pane, "clankie_call", {
        name,
        arguments: args,
        ...(background === undefined ? {} : { background }),
      }),
    ) as Reply;
  const call = async (pane: string, name: string, args: Record<string, unknown>) => {
    const reply = await raw(pane, name, args);
    expect(reply, JSON.stringify(reply)).toMatchObject({ outcome: "ok" });
    return JSON.parse(reply.content!);
  };
  /** Full schemas, ten names a request, as clankie_tools serves them. */
  const schemas = async (pane: string, names: readonly string[]) => {
    const found: { name: string; description: string; inputSchema: any }[] = [];
    for (let index = 0; index < names.length; index += 10)
      found.push(...JSON.parse(await tool(pane, "clankie_tools", { names: names.slice(index, index + 10) })));
    return found;
  };
  const budgetReport = async () => {
    const response = await app.app.request("/v1/tracker/request-budget", {
      headers: { authorization: "Bearer owner" },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as TrackerRequestBudgetReport;
  };
  const work = (...args: string[]) =>
    runWorkCommand([...args, "--repo", workspace], {
      env: { CLANKIE_OPERATOR_TOKEN: "owner", CLANKIE_CONTROL_PLANE_URL: "http://clankie.test" },
      fetchImpl: (input, init) => Promise.resolve(app.app.request(String(input), init)),
    }) as Promise<{ ok: boolean; body: Record<string, any> }>;
  /** The same owner route without asserting success, for refusals. */
  const ownerRaw = async (name: string, args: Record<string, unknown>) => {
    const response = await app.app.request("/v1/tracker/owner/call", {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return {
    host,
    tracker,
    team,
    project,
    owner,
    ownerRaw,
    hire,
    raw,
    call,
    tool,
    schemas,
    budgetReport,
    work,
    logged,
    personaNames,
  };
}

const LEAD_VERBS = [
  "linear_post_owner_verdict",
  "linear_post_run_control",
  "linear_save_issue_status",
  "linear_save_project",
  "linear_post_retire_guided_review",
  "linear_inbox_pending_questions",
  "linear_get_inbox_item",
  "linear_post_snooze_inbox_item",
  "linear_post_unsnooze_inbox_item",
];
/** Everything hired seats wrote in the live audit log, plus what they read and follow. */
const KEPT = [
  "linear_save_issue",
  "linear_save_comment",
  "linear_create_comment",
  "linear_post_issue_event",
  "linear_post_bundle_check",
  "linear_save_evidence_bundle",
  "linear_save_lease",
  "linear_save_run",
  "linear_list_changes",
  "linear_list_issues",
  "linear_get_issue",
  "linear_save_status_update",
  "linear_save_guided_review",
];

it("a worker's catalog drops the lead and owner verbs; called by name they are refused with its role and nothing is written", async () => {
  const f = await fixture();
  await f.hire("w1:p1", "builder");
  const issue = await f.call("w1:p1", "linear_save_issue", { title: "Worker issue", project: f.project.id });

  // Discovery: the hidden verbs are neither searchable nor described.
  const all = (await f.host.catalog("operator"))
    .filter((entry) => entry.server === "linear")
    .map((entry) => entry.qualifiedName);
  const visible = (await f.schemas("w1:p1", all)).map((entry) => entry.name);
  for (const name of LEAD_VERBS) expect(visible).not.toContain(name);
  for (const name of KEPT) expect(visible).toContain(name);
  expect(await f.tool("w1:p1", "clankie_tools", { query: "run steer pause stop" })).not.toContain(
    "linear_post_run_control",
  );
  const [saveIssue, issueEvent] = await f.schemas("w1:p1", ["linear_save_issue", "linear_post_issue_event"]);
  expect(saveIssue!.inputSchema.properties).not.toHaveProperty("cycle");
  expect(issueEvent!.inputSchema.properties.stage.enum).not.toContain("owner-verified");
  expect(issueEvent!.description).not.toContain("lead closure");

  // Called by name: refused server-side with the role, possibly-dispatched false.
  const audit = async () => (await f.owner("list_audit_events", { limit: 250 })).events.length as number;
  const before = await audit();
  const run = await f.call("w1:p1", "linear_save_run", {
    issueId: issue.id,
    worktree: "/tmp/w",
    branch: "b",
  });
  const refusals = [
    ["linear_post_run_control", { runId: run.id, action: "pause", idempotencyKey: "pause-key-1" }],
    ["linear_save_issue_status", { name: "Shipped", type: "completed", idempotencyKey: "status-key-1" }],
    ["linear_save_project", { id: f.project.id, cycleDays: 3 }],
    ["linear_save_issue", { id: issue.id, cycle: "current" }],
    ["linear_save_issue", { id: issue.id, state: "Done", idempotencyKey: "close-key-1" }],
    ["linear_save_issue", { id: issue.id, state: "completed" }],
    ["linear_post_issue_event", { issueId: issue.id, type: "result", stage: "owner-verified" }],
  ] as const;
  for (const [name, args] of refusals)
    expect(await f.raw("w1:p1", name, args), name).toMatchObject({
      outcome: "refused",
      reason: "role_not_allowed",
      role: "worker",
      detail: expect.stringContaining("Nothing was written"),
    });
  // Only the run start was written; the refused keys left no receipt and nothing changed.
  expect(await audit()).toBe(before + 1);
  for (const key of ["pause-key-1", "status-key-1", "close-key-1"])
    expect(await f.call("w1:p1", "linear_get_write_receipt", { idempotencyKey: key })).toMatchObject({
      state: "unknown",
    });
  expect((await f.owner("list_runs", { issueId: issue.id })).runs[0]).toMatchObject({ status: "active" });
  expect((await f.owner("get_issue", { id: issue.id })).status).not.toBe("Done");
  expect(
    (await f.owner("list_issue_statuses", { team: f.team })).map((s: { name: string }) => s.name),
  ).not.toContain("Shipped");

  // Ordinary worker state moves still reach the tracker.
  expect(await f.call("w1:p1", "linear_save_issue", { id: issue.id, state: "In Progress" })).toMatchObject({
    status: "In Progress",
  });

  // The refusal is recorded host-side: a service log event and the actor's refusal count.
  expect(f.logged.filter((entry) => entry.event === "tracker.policy.refused")).toHaveLength(refusals.length);
  const report = await f.budgetReport();
  expect(report.actors).toEqual([
    expect.objectContaining({
      actorId: "fleet:default:pane:w1:p1",
      name: "seat-w1:p1",
      role: "worker",
      refusals: { role_not_allowed: refusals.length, tracker_request_budget: 0 },
    }),
  ]);
  const status = await f.work("status");
  expect(status.body.trackerRequestBudget).toMatchObject({ actors: report.actors });

  // The lead keeps run control: Clankie's own operator call pauses the worker's run.
  const paused = await f.host.call({
    lane: "operator",
    server: "linear",
    tool: "post_run_control",
    arguments: { runId: run.id, action: "pause" },
  });
  expect(paused, JSON.stringify(paused)).toMatchObject({ outcome: "ok", isError: false });
});

it("a reviewer keeps what reviewers use, and is named as a reviewer when refused", async () => {
  const f = await fixture();
  await f.hire("w1:p1", "builder");
  await f.hire("w1:p2", "reviewer");
  const issue = await f.call("w1:p1", "linear_save_issue", { title: "Reviewed", project: f.project.id });
  const bundle = await f.call("w1:p1", "linear_save_evidence_bundle", {
    issueId: issue.id,
    references: [
      {
        recordId: "fixture",
        sha256: "0".repeat(64),
        url: `clankie://evidence/sha256/${"0".repeat(64)}`,
        type: "log",
      },
    ],
    gaps: [],
  });
  // The reviewer's live-audit verbs: an independent bundle check and comments.
  await f.call("w1:p2", "linear_post_bundle_check", { bundleId: bundle.id, body: "Checked independently." });
  await f.call("w1:p2", "linear_save_comment", { issueId: issue.id, body: "Review notes." });
  const visible = (await f.schemas("w1:p2", [...KEPT, ...LEAD_VERBS])).map((entry) => entry.name);
  expect(visible.toSorted()).toEqual(KEPT.toSorted());
  expect(
    await f.raw("w1:p2", "linear_save_issue_status", { name: "Shipped", type: "completed" }),
  ).toMatchObject({
    outcome: "refused",
    reason: "role_not_allowed",
    role: "reviewer",
  });
});

it("a background loop over its budget gets retryAt while its interactive calls and other workers still run", async () => {
  const f = await fixture(new TrackerRequestBudget({ requests: 6, writes: 3 }));
  await f.hire("w1:p1", "builder");
  await f.hire("w1:p2", "builder");
  const issue = await f.call("w1:p2", "linear_save_issue", { title: "Polled", project: f.project.id });

  // A runaway background poll: list_changes long-polls count as requests.
  const replies: Reply[] = [];
  for (let index = 0; index < 8; index++)
    replies.push(await f.raw("w1:p1", "linear_list_changes", { project: f.project.id, waitMs: 0 }, true));
  expect(replies.slice(0, 6).map((reply) => reply.outcome)).toEqual(Array(6).fill("ok"));
  for (const reply of replies.slice(6)) {
    expect(reply).toMatchObject({ outcome: "refused", reason: "tracker_request_budget" });
    expect(reply.retryAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(reply.retryAfterMs).toBeGreaterThan(3_500_000);
  }

  // The same worker's interactive turn and another worker are untouched.
  await f.call("w1:p1", "linear_get_issue", { id: issue.id });
  await f.call("w1:p2", "linear_list_changes", { project: f.project.id, waitMs: 0 });

  // Writes have their own per-minute budget inside the class.
  for (let index = 1; index <= 3; index++)
    await f.call("w1:p1", "linear_save_comment", { issueId: issue.id, body: `note ${index}` });
  expect(await f.raw("w1:p1", "linear_save_comment", { issueId: issue.id, body: "note 4" })).toMatchObject({
    outcome: "refused",
    reason: "tracker_request_budget",
    detail: expect.stringContaining("write budget"),
  });
  expect((await f.owner("list_comments", { issueId: issue.id })).comments).toHaveLength(3);

  const report = await f.budgetReport();
  const looping = report.actors.find((actor) => actor.actorId === "fleet:default:pane:w1:p1")!;
  expect(looping.background).toMatchObject({ requests: 6, requestLimit: 6, retryAt: expect.any(Number) });
  expect(looping.interactive).toMatchObject({
    requests: 4,
    writes: 3,
    writeLimit: 3,
    retryAt: expect.any(Number),
  });
  expect(looping.refusals).toEqual({ role_not_allowed: 0, tracker_request_budget: 3 });
  const other = report.actors.find((actor) => actor.actorId === "fleet:default:pane:w1:p2")!;
  expect(other.interactive.retryAt).toBeUndefined();

  // The owner is never limited.
  for (let index = 0; index < 8; index++) await f.owner("list_issues", { project: f.project.id });
});

it("measures the worker tracker catalog against the full one", async () => {
  const f = await fixture();
  await f.hire("w1:p1", "builder");
  const full = (await f.host.catalog("operator"))
    .filter((entry) => entry.server === "linear")
    .map((entry) => ({
      name: entry.qualifiedName,
      description: entry.description,
      inputSchema: entry.inputSchema,
    }));
  const worker = await f.schemas(
    "w1:p1",
    full.map((entry) => entry.name),
  );
  // The owner app's verdict is in no agent catalog, so only the listed lead verbs are subtracted.
  const listed = LEAD_VERBS.filter((name) => full.some((entry) => entry.name === name));
  expect(listed).toEqual(LEAD_VERBS.filter((name) => name !== "linear_post_owner_verdict"));
  expect(worker.length).toBe(full.length - listed.length);
  expect(JSON.stringify(worker).length).toBeLessThan(JSON.stringify(full).length);
  if (process.env.TRACKER_CATALOG_MEASURE)
    await writeFile(process.env.TRACKER_CATALOG_MEASURE, JSON.stringify({ full, worker }));
});

it("no agent lane, and not the operator bearer, gives the owner app's verdict (ADR 0299)", async () => {
  const f = await fixture();
  await f.hire("w1:p1", "builder");
  // A finished item the verdict would otherwise apply to: landed, with a checked current bundle.
  const issue = await f.call("w1:p1", "linear_save_issue", { title: "Finished work", project: f.project.id });
  await f.call("w1:p1", "linear_post_issue_event", { issueId: issue.id, type: "result", stage: "landed" });
  const sha256 = "a".repeat(64);
  const bundle = await f.call("w1:p1", "linear_save_evidence_bundle", {
    issueId: issue.id,
    references: [{ recordId: "clip", sha256, url: `clankie://evidence/sha256/${sha256}`, type: "video" }],
    gaps: [],
  });
  await f.owner("post_bundle_check", { bundleId: bundle.id });
  const verdict = { issueId: issue.id, bundleId: bundle.id, verdict: "works" };

  // No catalog lists it: not Clankie's operator lane, not a hired worker's.
  const all = (await f.host.catalog("operator")).map((entry) => entry.qualifiedName);
  expect(all).not.toContain("linear_post_owner_verdict");
  expect(all).toContain("linear_post_bundle_check");
  expect(await f.tool("w1:p1", "clankie_tools", { query: "owner verdict works send back" })).not.toContain(
    "linear_post_owner_verdict",
  );

  // A worker calling it by name holds no grant for it; its role refuses it too.
  expect(await f.raw("w1:p1", "linear_post_owner_verdict", verdict)).toEqual({
    outcome: "refused",
    reason: "worker_request_failed",
    detail: "Tool or arguments are not granted",
  });
  expect(trackerRoleRefusal("worker", "post_owner_verdict", verdict)).toBe(
    "post_owner_verdict is a lead or owner verb",
  );
  expect(trackerRoleRefusal("reviewer", "post_owner_verdict", verdict)).toBeDefined();
  // Clankie's own lead lane reaches the tracker, which refuses without the owner app.
  const lead = await f.host.call({
    lane: "operator",
    server: "linear",
    tool: "post_owner_verdict",
    arguments: verdict,
  });
  expect(JSON.stringify(lead)).toContain("owner_app_required");
  // The operator bearer on the owner route is a local caller, not the owner's app.
  expect(await f.ownerRaw("post_owner_verdict", verdict)).toMatchObject({
    status: 422,
    body: { reason: "owner_app_required" },
  });
  expect(await f.owner("get_issue", { id: issue.id })).toMatchObject({ stage: "landed" });
});

it("a hired worker's writes carry its persona, and their author fields name the writer (LOCAL-VUH-59)", async () => {
  const f = await fixture();
  await f.hire("w1:p1", "builder");
  await f.hire("w1:p2", "builder");
  f.personaNames.set("seat-w1:p1 occupant-w1:p1", "Lark");
  const issue = await f.call("w1:p1", "linear_save_issue", { title: "Named", project: f.project.id });
  const larkWrite = await f.call("w1:p1", "linear_save_comment", { issueId: issue.id, body: "From Lark." });
  await f.call("w1:p1", "linear_post_issue_event", { issueId: issue.id, type: "ack" });
  await f.call("w1:p1", "linear_save_evidence_bundle", {
    issueId: issue.id,
    references: [
      {
        recordId: "fixture",
        sha256: "0".repeat(64),
        url: `clankie://evidence/sha256/${"0".repeat(64)}`,
        type: "log",
      },
    ],
    gaps: [],
  });
  await f.call("w1:p2", "linear_save_comment", { issueId: issue.id, body: "No persona bound." });
  // A linked PC's worker: its live seat id carries its fleet.
  await f.hire("w2:p1", "builder", "pc");
  f.personaNames.set("pc/seat-w2:p1 occupant-w2:p1", "Wren");
  const pcWrite = await f.call("w2:p1", "linear_save_comment", { issueId: issue.id, body: "From the PC." });
  // An outside member, as the Discord forum mirror writes one: untrusted, never the owner.
  await f.tracker.call(
    "save_comment",
    { issueId: issue.id, body: "From a member." },
    { actor: { type: "external", id: "discord:42", name: "Pip", onBehalfOf: [] }, via: "discord_forum" },
  );
  const leadUpdate = await f.host.call({
    lane: "operator",
    server: "linear",
    tool: "save_status_update",
    arguments: { type: "project", project: f.project.id, body: "On track." },
  });
  expect(leadUpdate, JSON.stringify(leadUpdate)).toMatchObject({ outcome: "ok", isError: false });
  const lead = await f.host.call({
    lane: "operator",
    server: "linear",
    tool: "save_comment",
    arguments: { issueId: issue.id, body: "From Clankie." },
  });
  expect(lead, JSON.stringify(lead)).toMatchObject({ outcome: "ok", isError: false });
  const ownerWrite = await f.owner("save_comment", { issueId: issue.id, body: "From the owner." });
  // Each write's own response names its writer, as the stored record does; the tool reply is compact.
  expect(larkWrite).toMatchObject({ author: "Lark" });
  expect(pcWrite).toMatchObject({ author: "Wren" });
  expect(JSON.parse((lead as { content: string }).content)).toMatchObject({ author: "Clankie" });
  expect(ownerWrite).toMatchObject({ author: { name: "Local owner", isLocal: true } });

  // The pane stays the actor id; the persona is its name, on behalf of the owner and Clankie.
  const lark = {
    type: "agent-worker",
    id: "fleet:default:pane:w1:p1",
    name: "Lark",
    onBehalfOf: [
      { type: "human", id: "owner", name: "Owner" },
      { type: "agent-worker", id: "clankie", name: "Clankie" },
    ],
  };
  const comments = (await f.owner("list_comments", { issueId: issue.id })).comments as Record<string, any>[];
  const comment = (body: string) => comments.find((entry) => entry.body === body)!;
  expect(comment("From Lark.")).toMatchObject({
    createdByActor: lark,
    author: { id: "agent-worker:fleet:default:pane:w1:p1", name: "Lark", isLocal: false },
    user: { name: "Lark", isLocal: false },
  });
  // A seat with no bound persona is still named by its seat.
  expect(comment("No persona bound.")).toMatchObject({
    createdByActor: { id: "fleet:default:pane:w1:p2", name: "seat-w1:p2" },
    author: { name: "seat-w1:p2", isLocal: false },
  });
  // The lead's and the owner's attribution are unchanged; only the lead's author stops reading as the owner.
  expect(comment("From Clankie.")).toMatchObject({
    createdByActor: { type: "agent-worker", id: "clankie", name: "Clankie" },
    author: { name: "Clankie", isLocal: false },
  });
  expect(comment("From the PC.")).toMatchObject({
    createdByActor: { id: "fleet:pc:pane:w2:p1", name: "Wren" },
    author: { name: "Wren", isLocal: false },
  });
  expect(comment("From a member.")).toMatchObject({
    createdByActor: { type: "external", id: "discord:42", name: "Pip" },
    author: { id: "external:discord:42", name: "Pip", isLocal: false },
    user: { name: "Pip", isLocal: false },
  });
  const updates = (await f.owner("get_status_updates", { type: "project", project: f.project.id }))
    .statusUpdates;
  expect(updates.find((entry: { body: string }) => entry.body === "On track.").user).toMatchObject({
    name: "Clankie",
    isLocal: false,
  });
  expect(comment("From the owner.")).toMatchObject({
    createdByActor: { type: "human" },
    author: { name: "Local owner", isLocal: true },
  });
  expect(await f.owner("get_issue", { id: issue.id })).toMatchObject({ createdBy: "Lark" });
  const events = (await f.owner("list_issue_events", { issueId: issue.id })).events as Record<string, any>[];
  expect(events.find((event) => event.type === "ack")?.actor).toMatchObject(lark);
  expect((await f.owner("get_evidence_bundle", { issueId: issue.id })).actor).toMatchObject(lark);
});
