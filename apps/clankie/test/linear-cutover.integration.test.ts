import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { ProjectsSettingsSchema } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker, writeConvention, type LinearImportSnapshot } from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { LinearCutover } from "../src/linear-cutover.ts";
import { linearActorMap } from "../src/linear-import.ts";
import { LinearMirrors } from "../src/linear-mirror.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { projectWorkRepoId } from "../src/project-work-items.ts";
import { startTrackerOwnerLoop } from "../src/tracker-owner-loop.ts";
import { trackerRepoForPrincipal } from "../src/tracker-runner.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { captured, OWNER_ID } from "./helpers/linear-mirror.ts";

/**
 * VUH-1987 through the real service surfaces: the owner's cutover route over HTTP, a
 * scratch store imported from the captured Clankie Work project, the World project's
 * settings and `.clankie/tracking.json`, the live built-in store, the in-process
 * owner loop with a real conversation store, and a fleet worker's clankie_call writes.
 * Only Linear's read is the captured project, standing in for api.linear.app.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function cutoverFixture(linear: (source: LinearImportSnapshot) => LinearImportSnapshot = (s) => s) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "linear-cutover-")));
  const workspace = join(root, "clankie-work");
  await mkdir(workspace);
  await writeConvention(workspace, {
    schemaVersion: 1,
    backend: "linear",
    linear: { team: "VUH", project: "Clankie Work" },
    decidedBy: "owner",
    decidedAt: "2026-10-09T12:13:36.731Z",
  });
  // Two neighbours for VUH-2014: a project still on Linear, and one with no saved tracker.
  const linearWorkspace = join(root, "linear-work");
  const looseWorkspace = join(root, "loose");
  // Like the live `clankie` project: no trackerRef, a `linear` convention in its workspace.
  const unboundWorkspace = join(root, "unbound-linear");
  await mkdir(linearWorkspace);
  await mkdir(looseWorkspace);
  await mkdir(unboundWorkspace);
  for (const path of [linearWorkspace, unboundWorkspace])
    await writeConvention(path, {
      schemaVersion: 1,
      backend: "linear",
      linear: { team: "VUH", project: "Still On Linear" },
      decidedBy: "owner",
      decidedAt: "2026-10-09T12:13:36.731Z",
    });
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "clankie-work",
          name: "Clankie Work",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: workspace }],
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
        },
        {
          id: "linear-work",
          name: "Linear Work",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: linearWorkspace }],
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
        },
        {
          id: "loose",
          name: "Loose",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: looseWorkspace }],
        },
        {
          id: "unbound-linear",
          name: "Unbound Linear",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: unboundWorkspace }],
        },
      ],
    }),
  }));
  // The host's own hire records: which project each fleet pane was hired for.
  const hires = new ProjectHires(join(root, "project-hires.json"));
  const hire = async (projectId: string, pane: string, directory: string) => {
    const projects = (await settings.load()).projects;
    const { id } = hires.reserve(projects, projectId, {
      schemaVersion: 1,
      workingDirectory: directory,
      title: `Work on ${projectId}`,
      harness: "claude",
    });
    hires.launch(id, projects);
    hires.pane(id, pane);
    hires.confirmed(id);
    hires.observe(id, `seat-${pane}`, `occupant-${pane}`, {
      nativeOccupantId: `occupant-${pane}`,
      fleet: "default",
      pane,
      binding: { socketPath: join(root, "herdr.sock") },
      processes: [{ pid: 22, startTime: "today" }],
      shell: { pid: 11, startTime: "earlier" },
    });
  };
  const source = await captured();
  const projectId = source.projects[0]!.id;
  const imports = join(root, "tracker-imports");
  const identity = { ownerIds: [OWNER_ID], ownerEmails: [], appUserId: randomUUID() };
  await createLocalTracker({ directory: join(imports, "work") }).importLinear(
    source,
    linearActorMap(source.actors, identity),
  );
  const mirrors = new LinearMirrors({
    root: imports,
    identity: async () => identity,
    session: async () => {
      throw new Error("No Linear session in this fixture");
    },
  });
  const trackerDirectory = join(root, "tracker");
  const live = createLocalTracker({ directory: trackerDirectory });
  // The live store as a fresh service leaves it: seeded, persisted, holding no records.
  await live.sync({ action: "bootstrap", type: "full", projects: ["*"], lazy: false });
  const linearReads: string[] = [];
  const cutover = new LinearCutover({
    trackerDirectory,
    importsRoot: imports,
    mirrors,
    settings,
    localMachineId: "local",
    linearSnapshot: async (id) => {
      linearReads.push(id);
      return { snapshot: linear(structuredClone(source)), requests: 0 };
    },
  });
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  let workItems!: ReturnType<typeof createWorkItemsService>;
  const host = createMcpHost({
    credentials,
    settings,
    localTracker: live,
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
    trackerRepoForWorker: (principalId) =>
      trackerRepoForPrincipal(
        principalId,
        (fleet, pane) => hires.membershipCandidate(fleet, pane),
        (projectId) => workItems.trackerRepoForProject(projectId),
      ),
    logger: { info() {}, warn() {} },
  });
  workItems = createWorkItemsService({
    stateDirectory: join(root, "work"),
    globalTrackerDirectory: trackerDirectory,
    projects: async () => (await settings.load()).projects,
    localMachineId: "local",
    mcpHost: host,
    builtInTracker: (assertIssueWrite) =>
      assertIssueWrite === undefined
        ? live
        : createLocalTracker({ directory: trackerDirectory, assertIssueWrite }),
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
  const conversations = new ConversationStore(join(root, "conversations"), async () => {});
  const wakes: string[] = [];
  const captain = createStubCaptain({
    serveOperatorConversation: (request, owner) =>
      conversations.serve(request as Parameters<ConversationStore["serve"]>[0], owner),
    requestOwnerAsk: (conversationId, draft, publicationId) =>
      conversations.requestSurfaceQuestion(conversationId, draft, {
        current: () => true,
        ...(publicationId === undefined ? {} : { publicationId }),
      }),
    readOwnerAsk: (requestId) => conversations.readOwnerAsk(requestId),
    observeQuestionResolutions: (listener) => conversations.observeQuestionResolutions(listener),
    linearWakeTargetAllowed: (conversationId) => conversations.linearWakeTargetAllowed(conversationId),
    wakeConversation: async (_owner, text) => {
      wakes.push(text);
      return true;
    },
  });
  const app = await createClankieApp({
    captain,
    settings,
    workerMcp: worker,
    workItems,
    builtInTracker: live,
    linearMirrors: mirrors,
    linearCutover: cutover,
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
          : { fleet: "default", pane, validate: async () => true, current: () => true };
      },
    },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const stopLoop = await startTrackerOwnerLoop({
    tracker: live,
    captain,
    settings,
    statePath: join(trackerDirectory, "owner-loop.json"),
    logger: { info() {}, warn() {} },
  });
  cleanups.push(async () => {
    await stopLoop();
    app.close();
    await rm(root, { recursive: true, force: true });
  });
  const post = async (path: string, body: unknown, authorization = "Bearer owner") => {
    const response = await app.app.request(path, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  let sequence = 0;
  const sessions = new Map<string, string>();
  const rpc = (method: string, params: unknown, pane?: string) =>
    app.app.request("/v1/fleet/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-fleet-test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(pane === undefined ? {} : { "x-test-local-pane": pane }),
        ...(sessions.has(pane ?? "") ? { "mcp-session-id": sessions.get(pane ?? "")! } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
  /** A fleet worker's clankie_call: bearer-linked, or from a verified local pane. */
  const workerCall = async (name: string, args: Record<string, unknown>, pane?: string) => {
    if (!sessions.has(pane ?? ""))
      sessions.set(
        pane ?? "",
        (
          await rpc(
            "initialize",
            {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "linear-cutover-integration", version: "1" },
            },
            pane,
          )
        ).headers.get("mcp-session-id")!,
      );
    const response = await rpc(
      "tools/call",
      { name: "clankie_call", arguments: { name, arguments: args } },
      pane,
    );
    const result = (await response.json()).result as { content: { text: string }[] };
    return JSON.parse(result.content[0]!.text) as { outcome: string; content?: string; detail?: string };
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const files = async () => ({
    live: await readFile(join(trackerDirectory, "tracker.json"), "utf8"),
    scratch: await readFile(join(imports, "work", "tracker.json"), "utf8"),
    convention: await readFile(join(workspace, ".clankie", "tracking.json"), "utf8"),
    mirrors: await readFile(join(imports, "mirrors.json"), "utf8").catch(() => null),
    projects: JSON.stringify((await settings.load()).projects),
  });
  return {
    root,
    workspace,
    source,
    projectId,
    trackerDirectory,
    live,
    settings,
    post,
    workerCall,
    settle,
    files,
    wakes,
    linearReads,
    hire,
    linearWorkspace,
    looseWorkspace,
    unboundWorkspace,
    repo: projectWorkRepoId("clankie-work"),
  };
}

it("dry-runs, promotes the mirrored import, switches Clankie Work to the built-in tracker for its workers, and switches back exactly", async () => {
  const f = await cutoverFixture();
  expect(
    (await f.post("/v1/tracker/mirror/linear", { scratch: "work", projectId: f.projectId, action: "enable" }))
      .status,
  ).toBe(200);
  const request = { worldProject: "clankie-work", scratch: "work", linearProjectId: f.projectId };

  // Only the owner cuts over.
  expect(
    (await f.post("/v1/tracker/cutover/linear", { ...request, dryRun: true }, "Bearer worker")).status,
  ).toBe(401);

  // The dry run prints every change and its switch-back, and writes nothing.
  const before = await f.files();
  const dry = await f.post("/v1/tracker/cutover/linear", { ...request, dryRun: true });
  expect(dry.status, JSON.stringify(dry.body)).toBe(200);
  expect(dry.body).toMatchObject({
    action: "cutover",
    dryRun: true,
    ready: true,
    refusals: [],
    trackerProjectId: f.projectId,
    mirror: { enabled: true, unresolvedDrift: 0 },
    switchBack: "clankie work cutover linear --world-project clankie-work --switch-back",
  });
  expect(dry.body.counts.issues).toEqual({
    linear: f.source.issues.length,
    builtIn: f.source.issues.length,
    missing: 0,
    extra: 0,
    stale: 0,
  });
  expect(dry.body.counts.comments.missing).toBe(0);
  expect(dry.body.changes.map((change: { what: string }) => change.what)).toEqual([
    "mirror",
    "store",
    "setting",
    "file",
  ]);
  expect(dry.body.changes[3]).toMatchObject({
    from: { backend: "linear", linear: { team: "VUH", project: "Clankie Work" } },
    to: { backend: "builtin", linear: { team: "VUH", project: "Clankie Work" } },
  });
  expect(await f.files()).toEqual(before);
  expect(f.linearReads).toEqual([f.projectId]);

  // Apply: the copy becomes the live store, the project binds, the convention switches.
  const applied = await f.post("/v1/tracker/cutover/linear", request);
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  expect(applied.body.applied).toEqual(["mirror", "store", "setting", "convention"]);
  const convention = JSON.parse(await readFile(join(f.workspace, ".clankie", "tracking.json"), "utf8"));
  expect(convention).toMatchObject({ backend: "builtin", linear: { team: "VUH", project: "Clankie Work" } });
  expect((await f.settings.load()).projects.projects[0]!.trackerProjectId).toBe(f.projectId);
  expect(
    (await f.post("/v1/tracker/mirror/linear", { scratch: "work", projectId: f.projectId, action: "status" }))
      .body,
  ).toMatchObject({ enabled: false });
  expect(await readFile(join(f.root, "tracker-imports", "work", "tracker.json"), "utf8")).toBe(
    before.scratch,
  );
  // A second cutover is refused while this one is active.
  expect((await f.post("/v1/tracker/cutover/linear", request)).status).toBe(409);

  // Imported Linear history is not owner activity: once the owner loop has read the
  // promoted store's whole stream, it has woken no one and asked nothing.
  const promoted = JSON.parse(await readFile(join(f.trackerDirectory, "tracker.json"), "utf8"));
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(join(f.trackerDirectory, "owner-loop.json"), "utf8").catch(() => "{}")),
      { timeout: 10_000, interval: 100 },
    )
    .toMatchObject({ storeId: promoted.storeId, cursor: promoted.events.length });
  expect(f.wakes).toEqual([]);

  // A worker's linear_* writes for this project now land in the built-in tracker, as the worker.
  const issue = f.source.issues.find((entry) => entry.identifier === "VUH-1905")!;
  const comment = await f.workerCall("linear_save_comment", {
    repo: f.repo,
    issueId: issue.identifier,
    body: "Pilot: written to the built-in tracker after cutover.",
  });
  expect(comment, JSON.stringify(comment)).toMatchObject({ outcome: "ok" });
  const created = await f.workerCall("linear_save_issue", {
    repo: f.repo,
    title: "Pilot item made after cutover",
  });
  expect(created, JSON.stringify(created)).toMatchObject({ outcome: "ok" });
  expect(JSON.parse(created.content!)).toMatchObject({ identifier: "LOCAL-VUH-1" });
  const store = JSON.parse(await readFile(join(f.trackerDirectory, "tracker.json"), "utf8"));
  expect(
    store.issues.find((entry: { identifier: string }) => entry.identifier === "LOCAL-VUH-1"),
  ).toMatchObject({
    projectId: f.projectId,
  });
  expect(
    store.comments.find((entry: { body: string }) => entry.body.startsWith("Pilot:")).createdByActor,
  ).toMatchObject({ type: "agent-worker" });

  // Writes stay inside the bound project.
  await f.post("/v1/tracker/owner/call", {
    name: "save_project",
    arguments: { name: "Elsewhere", addTeams: ["VUH"] },
  });
  const elsewhere = await f.post("/v1/tracker/owner/call", {
    name: "save_issue",
    arguments: { team: "VUH", project: "Elsewhere", title: "Not Clankie Work" },
  });
  const outside = await f.workerCall("linear_save_comment", {
    repo: f.repo,
    issueId: elsewhere.body.result.identifier,
    body: "Out of scope",
  });
  expect(outside.outcome).not.toBe("ok");
  expect(JSON.stringify(outside)).toMatch(/not proven to belong to this repo's tracker/u);

  // Landing it raises the owner's "check it works" ask once.
  for (const event of [{ type: "ack" }, { type: "result", stage: "landed", body: "Landed in the pilot." }])
    expect(
      await f.workerCall("linear_post_issue_event", { repo: f.repo, issueId: issue.identifier, ...event }),
    ).toMatchObject({ outcome: "ok" });
  const verifyAsks = async () =>
    (
      await f.post("/operator/v1/dispatch", { schemaVersion: 1, op: "input_list" })
    ).body.result.questions.filter(
      (entry: { question: { purpose: string; status: string } }) =>
        entry.question.purpose === "verify" && entry.question.status === "pending",
    ).length;
  await expect.poll(verifyAsks, { timeout: 10_000, interval: 100 }).toBe(1);
  await f.settle();
  expect(await verifyAsks()).toBe(1);

  // Switch back: dry run first, then the exact pre-cutover convention, binding and store.
  const back = { worldProject: "clankie-work", switchBack: true };
  const preview = await f.post("/v1/tracker/cutover/linear", { ...back, dryRun: true });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body).toMatchObject({ action: "switch-back", ready: true });
  expect(preview.body.pilotWrites).toBeGreaterThan(0);
  const pilot = await readFile(join(f.trackerDirectory, "tracker.json"), "utf8");
  const switched = await f.post("/v1/tracker/cutover/linear", back);
  expect(switched.status, JSON.stringify(switched.body)).toBe(200);
  const after = await f.files();
  expect(after.convention).toBe(before.convention);
  expect(after.live).toBe(before.live);
  expect((await f.settings.load()).projects.projects[0]!.trackerProjectId).toBeUndefined();
  const keep = preview.body.changes.find((change: { what: string }) => change.what === "store").keep;
  expect(
    await readFile(switched.body.changes.find((c: { what: string }) => c.what === "store").keep, "utf8"),
  ).toBe(pilot);
  expect(keep).toMatch(/pilot-.*\.json$/u);
  // Workers are back on the Linear convention, not the built-in store.
  expect(
    (
      await f.workerCall("linear_save_comment", {
        repo: f.repo,
        issueId: issue.identifier,
        body: "After switch-back",
      })
    ).outcome,
  ).not.toBe("ok");
  expect(await readFile(join(f.trackerDirectory, "tracker.json"), "utf8")).toBe(before.live);
});

it("refuses to cut over when the copy has drifted from Linear, and changes nothing", async () => {
  const f = await cutoverFixture((linear) => {
    const [first, second] = linear.issues;
    linear.issues.push({
      ...first!,
      id: randomUUID(),
      identifier: "VUH-2999",
      title: "Made in Linear after import",
    });
    second!.updatedAt = "2026-10-10T00:00:00.000Z";
    return linear;
  });
  const before = await f.files();
  const refused = await f.post("/v1/tracker/cutover/linear", {
    worldProject: "clankie-work",
    scratch: "work",
    linearProjectId: f.projectId,
  });
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ ready: false });
  expect(refused.body.counts.issues).toMatchObject({ missing: 1, stale: 1 });
  expect(refused.body.refusals.join(" ")).toMatch(/drifted from Linear/u);
  expect(await f.files()).toEqual(before);
});

it("routes a hired worker's tracker calls without repo by its project's saved convention (VUH-2014)", async () => {
  const f = await cutoverFixture();
  const cut = await f.post("/v1/tracker/cutover/linear", {
    worldProject: "clankie-work",
    scratch: "work",
    linearProjectId: f.projectId,
  });
  expect(cut.status, JSON.stringify(cut.body)).toBe(200);
  await f.hire("clankie-work", "w1:p1", f.workspace);
  await f.hire("linear-work", "w1:p2", f.linearWorkspace);
  await f.hire("loose", "w1:p3", f.looseWorkspace);
  await f.hire("unbound-linear", "w1:p4", f.unboundWorkspace);
  const store = async () => JSON.parse(await readFile(join(f.trackerDirectory, "tracker.json"), "utf8"));

  // The builtin project's worker writes without repo: it lands in the built-in store,
  // in the bound project, as that worker.
  const created = await f.workerCall("linear_save_issue", { title: "Routed by my hire" }, "w1:p1");
  expect(created, JSON.stringify(created)).toMatchObject({ outcome: "ok" });
  const issue = (await store()).issues.find(
    (entry: { title: string }) => entry.title === "Routed by my hire",
  );
  expect(issue).toMatchObject({ projectId: f.projectId });
  const comment = await f.workerCall(
    "linear_save_comment",
    { issueId: issue.identifier, body: "Routed comment" },
    "w1:p1",
  );
  expect(comment, JSON.stringify(comment)).toMatchObject({ outcome: "ok" });
  expect(
    (await store()).comments.find((entry: { body: string }) => entry.body === "Routed comment")
      .createdByActor,
  ).toMatchObject({ type: "agent-worker", id: "fleet:default:pane:w1:p1" });

  // A cross-project write from that worker is refused, and nothing is written.
  await f.post("/v1/tracker/owner/call", {
    name: "save_project",
    arguments: { name: "Elsewhere", addTeams: ["VUH"] },
  });
  const elsewhere = await f.post("/v1/tracker/owner/call", {
    name: "save_issue",
    arguments: { team: "VUH", project: "Elsewhere", title: "Not Clankie Work" },
  });
  const outside = await f.workerCall(
    "linear_save_comment",
    { issueId: elsewhere.body.result.identifier, body: "Cross-project" },
    "w1:p1",
  );
  expect(outside.outcome).not.toBe("ok");
  expect(JSON.stringify(outside)).toMatch(/not proven to belong to this repo's tracker/u);
  const moved = await f.workerCall(
    "linear_save_issue",
    { title: "Into another project", project: "Elsewhere" },
    "w1:p1",
  );
  expect(moved.outcome).not.toBe("ok");
  const after = await store();
  expect(after.comments.some((entry: { body: string }) => entry.body === "Cross-project")).toBe(false);
  expect(after.issues.some((entry: { title: string }) => entry.title === "Into another project")).toBe(false);

  // A Linear project's worker keeps today's path: Linear, here its durable local fallback,
  // unscoped by any project repo, so its write into another project is not refused.
  const onLinear = await f.workerCall(
    "linear_save_issue",
    { team: "VUH", project: "Elsewhere", title: "Linear worker write" },
    "w1:p2",
  );
  expect(onLinear, JSON.stringify(onLinear)).toMatchObject({ outcome: "ok" });
  expect(
    (await store()).issues.find((entry: { title: string }) => entry.title === "Linear worker write"),
  ).toMatchObject({ projectId: elsewhere.body.result.projectId });
  // So does a project with no trackerRef whose workspace convention is `linear`.
  const unbound = await f.workerCall(
    "linear_save_issue",
    { team: "VUH", project: "Elsewhere", title: "Unbound Linear write" },
    "w1:p4",
  );
  expect(unbound, JSON.stringify(unbound)).toMatchObject({ outcome: "ok" });

  // A hire whose project has no saved tracker is refused rather than guessed.
  const loose = await f.workerCall("linear_save_issue", { team: "VUH", title: "Nowhere safe" }, "w1:p3");
  expect(loose.outcome).toBe("refused");
  expect(loose.detail).toMatch(/Loose has no saved work tracker/u);
  expect((await store()).issues.some((entry: { title: string }) => entry.title === "Nowhere safe")).toBe(
    false,
  );

  // An explicit repo still wins over the hire's project.
  const explicit = await f.workerCall(
    "linear_save_issue",
    { repo: projectWorkRepoId("linear-work"), title: "Explicit repo" },
    "w1:p3",
  );
  expect(explicit, JSON.stringify(explicit)).toMatchObject({ outcome: "ok" });
  expect((await store()).issues.some((entry: { title: string }) => entry.title === "Explicit repo")).toBe(
    false,
  );
});
