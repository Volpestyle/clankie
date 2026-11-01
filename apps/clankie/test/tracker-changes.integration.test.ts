import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { ProjectsSettingsSchema } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker, writeConvention, type LocalTrackerBackend } from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { linearMcp } from "../src/linear-mcp.ts";
import { trackerRepoForPrincipal } from "../src/tracker-runner.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { runWorkCommand } from "../../tui/src/command/work.ts";

/**
 * LOCAL-VUH-43 through the real service: hired fleet workers' clankie_call routed by
 * their hire's built-in project (VUH-2014), the owner's tracker route, and the
 * `clankie work changes` CLI over HTTP, all on one scratch built-in store.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

type Change = { model: string; id: string; action: string; fields?: Record<string, unknown> };
type Commit = { syncId: number; tool: string; actor: { id: string }; changes: Change[] };
type Changes =
  | { outcome: "changes"; storeId: string; syncId: number; changes: Commit[]; hasMore: boolean }
  | { outcome: "rebootstrap"; reason: string; storeId: string; syncId: number };

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tracker-changes-")));
  const trackerDirectory = join(root, "tracker");
  // Records when each real backend call settles and whether its caller had gone.
  const settled: { name: string; at: number; aborted: boolean }[] = [];
  const observed = (backend: LocalTrackerBackend): LocalTrackerBackend => ({
    ...backend,
    async call(name, args, options) {
      try {
        return await backend.call(name, args, options);
      } finally {
        settled.push({ name, at: Date.now(), aborted: options?.signal?.aborted === true });
      }
    },
  });
  const tracker = observed(createLocalTracker({ directory: trackerDirectory }));
  const settings = new SettingsStore(join(root, "settings.json"));
  const hires = new ProjectHires(join(root, "project-hires.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  let workItems!: ReturnType<typeof createWorkItemsService>;
  const host = createMcpHost({
    trackerMcp: linearMcp,
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
    logger: { info() {}, warn() {} },
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
        : observed(createLocalTracker({ directory: trackerDirectory, assertIssueWrite })),
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
  const projects: Record<string, { id: string; workspace: string }> = {};
  for (const key of ["x", "y"]) {
    const workspace = join(root, key);
    await mkdir(workspace);
    await writeConvention(workspace, {
      schemaVersion: 1,
      backend: "builtin",
      decidedBy: "owner",
      decidedAt: "2026-10-27T00:00:00.000Z",
    });
    const project = await owner("save_project", { name: `Project ${key.toUpperCase()}`, addTeams: [team] });
    projects[key] = { id: project.id, workspace };
  }
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: Object.entries(projects).map(([key, project]) => ({
        id: `project-${key}`,
        name: `Project ${key.toUpperCase()}`,
        workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: project.workspace }],
        trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
        trackerProjectId: project.id,
      })),
    }),
  }));
  const hire = async (key: string, pane: string) => {
    const saved = (await settings.load()).projects;
    const { id } = hires.reserve(saved, `project-${key}`, {
      schemaVersion: 1,
      workingDirectory: projects[key]!.workspace,
      title: `Work on ${key}`,
      harness: "claude",
    });
    hires.launch(id, saved);
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

  let sequence = 0;
  const sessions = new Map<string, string>();
  const rpc = (method: string, params: unknown, pane: string, signal?: AbortSignal) =>
    app.app.request("/v1/fleet/mcp", {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
      headers: {
        authorization: "Bearer local-fleet-test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-test-local-pane": pane,
        ...(sessions.has(pane) ? { "mcp-session-id": sessions.get(pane)! } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
  const session = async (pane: string) => {
    if (!sessions.has(pane))
      sessions.set(
        pane,
        (
          await rpc(
            "initialize",
            {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "tracker-changes-integration", version: "1" },
            },
            pane,
          )
        ).headers.get("mcp-session-id")!,
      );
  };
  /** A hired worker's clankie_call from its verified local pane. */
  const raw = async (pane: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    await session(pane);
    const response = await rpc(
      "tools/call",
      { name: "clankie_call", arguments: { name, arguments: args } },
      pane,
      signal,
    );
    const result = (await response.json()).result as { content: { text: string }[] };
    return JSON.parse(result.content[0]!.text) as { outcome: string; content?: string; detail?: string };
  };
  const call = async (pane: string, name: string, args: Record<string, unknown>) => {
    const reply = await raw(pane, name, args);
    expect(reply, JSON.stringify(reply)).toMatchObject({ outcome: "ok" });
    return JSON.parse(reply.content!);
  };
  /** `clankie work` as the lead seat runs it: the CLI over HTTP with the operator credential. */
  const work = (...args: string[]) =>
    runWorkCommand([...args, "--repo", projects.x!.workspace], {
      env: { CLANKIE_OPERATOR_TOKEN: "owner", CLANKIE_CONTROL_PLANE_URL: "http://clankie.test" },
      fetchImpl: (input, init) => Promise.resolve(app.app.request(String(input), init)),
    }) as Promise<{ ok: boolean; body: Record<string, any> }>;
  return { app, root, trackerDirectory, settled, team, projects, owner, hire, raw, call, work };
}

/** Follows hasMore from a cursor and returns every page. */
async function follow(read: (since: number) => Promise<Changes>, since: number) {
  const pages: Extract<Changes, { outcome: "changes" }>[] = [];
  for (let cursor = since; ;) {
    const page = await read(cursor);
    if (page.outcome !== "changes") throw new Error(JSON.stringify(page));
    pages.push(page);
    cursor = page.syncId;
    if (!page.hasMore) return pages;
  }
}

it("a hired worker follows only its project from a stable snapshot, and the cursor still passes other projects' commits", async () => {
  const f = await fixture();
  await f.hire("x", "w1:p1");
  await f.hire("x", "w1:p2");
  await f.hire("y", "w1:p3");
  // Seed both projects before the snapshot.
  for (let index = 1; index <= 5; index++)
    await f.owner("save_issue", { team: f.team, project: f.projects.x!.id, title: `X seed ${index}` });
  const ySeed = await f.owner("save_issue", { team: f.team, project: f.projects.y!.id, title: "Y seed" });

  // Worker A orients from a snapshot, two items a page.
  const first = await f.call("w1:p1", "linear_list_issues", { snapshot: true, limit: 2, fields: ["title"] });
  expect(first).toMatchObject({ hasNextPage: true, syncId: expect.any(Number), storeId: expect.any(String) });
  const { syncId, storeId } = first as { syncId: number; storeId: string };

  // Another worker in X writes 17 creates and 30 comments; a Y worker writes 5 times in between.
  const created: string[] = [];
  const yWrites: string[] = [];
  for (let index = 1; index <= 17; index++) {
    created.push((await f.call("w1:p2", "linear_save_issue", { title: `X new ${index}` })).id);
    if (index % 4 === 0)
      yWrites.push(
        (await f.call("w1:p3", "linear_save_comment", { issueId: ySeed.id, body: `Y note ${index}` })).id,
      );
  }
  const comments: string[] = [];
  for (let index = 1; index <= 30; index++)
    comments.push(
      (
        await f.call("w1:p2", "linear_save_comment", {
          issueId: created[index % created.length],
          body: `X comment ${index} with a body the change feed leaves out`,
        })
      ).id,
    );
  yWrites.push((await f.call("w1:p3", "linear_save_issue", { title: "Y last write" })).id);
  expect(yWrites).toHaveLength(5);

  // Later snapshot pages still read the snapshot, not the 17 new items.
  const pages = [first];
  while (pages.at(-1).hasNextPage)
    pages.push(
      await f.call("w1:p1", "linear_list_issues", {
        snapshot: true,
        limit: 2,
        fields: ["title"],
        cursor: pages.at(-1).cursor,
      }),
    );
  expect(pages.flatMap((page) => page.issues.map((issue: { title: string }) => issue.title)).sort()).toEqual([
    "X seed 1",
    "X seed 2",
    "X seed 3",
    "X seed 4",
    "X seed 5",
  ]);
  expect(pages.every((page) => page.syncId === syncId && page.storeId === storeId)).toBe(true);
  // One read from the snapshot's syncId: exactly X's 47 commits, in order, nothing of Y.
  const read = (since: number, limit = 250) =>
    f.call("w1:p1", "linear_list_changes", { since, storeId, limit }) as Promise<Changes>;
  const all = await follow((since) => read(since), syncId);
  const commits = all.flatMap((page) => page.changes);
  expect(commits.map((commit) => commit.tool)).toEqual([
    ...Array<string>(17).fill("save_issue"),
    ...Array<string>(30).fill("save_comment"),
  ]);
  const order = commits.map((commit) => commit.syncId);
  expect(order).toEqual(order.toSorted((a, b) => a - b));
  const touched = commits.flatMap((commit) => commit.changes.map((change) => change.id));
  for (const id of created) expect(touched).toContain(id);
  for (const id of comments) expect(touched).toContain(id);
  for (const id of [...yWrites, ySeed.id, f.projects.y!.id]) expect(touched).not.toContain(id);
  const serialized = JSON.stringify(commits);
  expect(serialized).not.toContain("Y note");
  expect(serialized).not.toContain("Y last write");
  // Compact: changed fields and ids, comment bodies left for list_comments.
  const comment = commits.at(-1)!.changes.find((change) => change.model === "comment")!;
  expect(comment).toMatchObject({ action: "insert", omitted: ["body", "quotedText"] });
  expect(serialized).not.toContain("the change feed leaves out");
  // The cursor ends past Y's trailing write, at the store's head.
  const head = (await f.owner("list_changes", { project: f.projects.y!.id })) as Changes;
  expect(all.at(-1)!.syncId).toBe((head as { syncId: number }).syncId);
  expect(all.at(-1)!.syncId).toBeGreaterThan(commits.at(-1)!.syncId);
  // hasMore paging is stable: small pages replay the same commits, and a repeat is identical.
  const small = await follow((since) => read(since, 7), syncId);
  expect(small.length).toBeGreaterThan(5);
  expect(small.every((page, index) => index === small.length - 1 || page.changes.length === 7)).toBe(true);
  expect(small.flatMap((page) => page.changes)).toEqual(commits);
  expect(await follow((since) => read(since, 7), syncId)).toEqual(small);

  // The Y worker sees only Y from the same cursor.
  const yCommits = (
    await follow(
      (since) => f.call("w1:p3", "linear_list_changes", { since, storeId }) as Promise<Changes>,
      syncId,
    )
  ).flatMap((page) => page.changes);
  expect(yCommits).toHaveLength(5);
  expect(JSON.stringify(yCommits)).not.toContain("X new");
});

it("long-polls to the matching commit, skips other projects while waiting, times out empty and stops when the caller goes away", async () => {
  const f = await fixture();
  await f.hire("x", "w1:p1");
  const head = (await f.call("w1:p1", "linear_list_changes", {})) as Extract<Changes, { outcome: "changes" }>;
  expect(head).toMatchObject({ outcome: "changes", changes: [], hasMore: false });

  // A Y write does not end X's wait; the X write does, within a second.
  let xWrittenAt = 0;
  const writes = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await f.owner("save_issue", { team: f.team, project: f.projects.y!.id, title: "Y during wait" });
    await new Promise((resolve) => setTimeout(resolve, 700));
    xWrittenAt = Date.now();
    return f.owner("save_issue", { team: f.team, project: f.projects.x!.id, title: "X during wait" });
  })();
  const started = Date.now();
  const woke = (await f.call("w1:p1", "linear_list_changes", {
    since: head.syncId,
    storeId: head.storeId,
    waitMs: 10_000,
  })) as Extract<Changes, { outcome: "changes" }>;
  const returnedAt = Date.now();
  const xIssue = await writes;
  expect(returnedAt - started).toBeGreaterThanOrEqual(900);
  expect(returnedAt - xWrittenAt).toBeLessThan(1_000);
  expect(woke.changes).toHaveLength(1);
  expect(woke.changes[0]!.changes.map((change) => change.id)).toContain(xIssue.id);
  expect(woke.syncId).toBe(head.syncId + 2);

  // Nothing arrives: the wait ends empty at its deadline, cursor unchanged.
  const quiet = Date.now();
  expect(
    await f.call("w1:p1", "linear_list_changes", {
      since: woke.syncId,
      storeId: woke.storeId,
      waitMs: 1_000,
    }),
  ).toEqual({ outcome: "changes", storeId: woke.storeId, syncId: woke.syncId, changes: [], hasMore: false });
  expect(Date.now() - quiet).toBeGreaterThanOrEqual(950);
  expect(Date.now() - quiet).toBeLessThan(3_000);

  // The caller disconnects: the tracker's own wait ends then, not after 20 s.
  const disconnect = async (request: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = new AbortController();
    const before = f.settled.length;
    const waits = () => f.settled.slice(before).filter((entry) => entry.name === "list_changes");
    const pending = request(controller.signal).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const abortedAt = Date.now();
    controller.abort();
    await pending;
    for (let tries = 0; tries < 100 && waits().length === 0; tries++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(waits()).toEqual([{ name: "list_changes", at: expect.any(Number), aborted: true }]);
    expect(waits()[0]!.at - abortedAt).toBeLessThan(1_000);
  };
  const cursor = { since: woke.syncId, storeId: woke.storeId, waitMs: 20_000 };
  // The `clankie work changes --wait` route.
  await disconnect(async (signal) =>
    f.app.app.request("/v1/tracker/call", {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ name: "list_changes", arguments: { project: f.projects.x!.id, ...cursor } }),
      signal,
    }),
  );
  // A hired worker's clankie_call.
  await disconnect((signal) => f.raw("w1:p1", "linear_list_changes", cursor, signal));
});

it("reports rebootstrap on a replaced store or a cursor gap, and an expired snapshot instead of mixing states", async () => {
  const f = await fixture();
  await f.hire("x", "w1:p1");
  for (let index = 1; index <= 3; index++)
    await f.owner("save_issue", { team: f.team, project: f.projects.x!.id, title: `X ${index}` });
  const snapshot = await f.call("w1:p1", "linear_list_issues", { snapshot: true, limit: 1 });
  const { syncId, storeId } = snapshot as { syncId: number; storeId: string };

  // A cursor ahead of the store is a gap.
  expect(await f.call("w1:p1", "linear_list_changes", { since: syncId + 100, storeId })).toEqual({
    outcome: "rebootstrap",
    reason: "cursor_gap",
    storeId,
    syncId,
  });

  // Snapshots are bounded: sixteen newer ones crowd out the first.
  for (let index = 0; index < 16; index++)
    await f.call("w1:p1", "linear_list_issues", { snapshot: true, limit: 1 });
  expect(
    await f.raw("w1:p1", "linear_list_issues", { snapshot: true, limit: 1, cursor: snapshot.cursor }),
  ).toMatchObject({ detail: expect.stringContaining("snapshot expired") });

  // The store is replaced, as a promoted import or restore would: same project, another storeId.
  const fresh = await f.call("w1:p1", "linear_list_issues", { snapshot: true, limit: 1 });
  const path = join(f.trackerDirectory, "tracker.json");
  const replaced = JSON.parse(await readFile(path, "utf8")) as { storeId?: string };
  replaced.storeId = "replaced-store";
  await writeFile(`${path}.next`, JSON.stringify(replaced));
  await rename(`${path}.next`, path);
  // Changes from the old cursor say rebootstrap, never stale data.
  expect(await f.call("w1:p1", "linear_list_changes", { since: syncId, storeId })).toEqual({
    outcome: "rebootstrap",
    reason: "store_changed",
    storeId: "replaced-store",
    syncId: expect.any(Number),
  });
  // A snapshot taken before the replacement is expired, not read across stores.
  expect(
    await f.raw("w1:p1", "linear_list_issues", { snapshot: true, limit: 1, cursor: fresh.cursor }),
  ).toMatchObject({ detail: expect.stringContaining("snapshot expired") });
});

it("follows changes through the `clankie work changes` CLI, by project or by the repo's binding", async () => {
  const f = await fixture();
  const start = await f.work("changes", "--project", f.projects.x!.id);
  expect(start).toMatchObject({ ok: true, body: { result: { outcome: "changes", changes: [] } } });
  const { syncId, storeId } = start.body.result as { syncId: number; storeId: string };
  const issue = await f.owner("save_issue", { team: f.team, project: f.projects.x!.id, title: "CLI change" });
  await f.owner("save_issue", { team: f.team, project: f.projects.y!.id, title: "Not X" });

  const byProject = await f.work(
    "changes",
    "--project",
    f.projects.x!.id,
    "--since",
    String(syncId),
    "--store-id",
    storeId,
  );
  expect(byProject.ok).toBe(true);
  expect(byProject.body.result).toMatchObject({ outcome: "changes", syncId: syncId + 2, hasMore: false });
  expect(byProject.body.result.changes).toHaveLength(1);
  expect(byProject.body.result.changes[0].changes[0]).toMatchObject({
    model: "issue",
    id: issue.id,
    action: "insert",
    fields: { title: "CLI change" },
  });
  // Without --project the repo's built-in binding (Project X) decides.
  const byRepo = await f.work("changes", "--since", String(syncId), "--store-id", storeId);
  expect(byRepo.body.result).toEqual(byProject.body.result);

  // --wait holds the call until a change arrives.
  const waiting = f.work(
    "changes",
    "--project",
    f.projects.x!.id,
    "--since",
    String(syncId + 2),
    "--store-id",
    storeId,
    "--wait",
    "5",
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  await f.owner("save_comment", { issueId: issue.id, body: "Arrives while waiting" });
  expect((await waiting).body.result.changes).toHaveLength(1);

  // --since without --store-id is a usage error, before any request.
  await expect(f.work("changes", "--since", "1")).rejects.toThrow(/Usage/u);
});
