import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker } from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { createWorkItemsService } from "../src/work-items.ts";

const git = promisify(execFile);

/**
 * VUH-1930 through the real service surfaces: a real git repository with version
 * tags and keyed commits, the owner's release sync route, the built-in tracker and
 * a fleet worker's clankie_call reads. Nothing is mocked; no model turn runs.
 */
it("derives each release's items from the commits since the previous tag and delivers built-in items on the first release that ships them", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-releases-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const repo = join(root, "repo");
  await mkdir(join(repo, ".clankie"), { recursive: true });
  await writeFile(
    join(repo, ".clankie", "tracking.json"),
    JSON.stringify({
      schemaVersion: 1,
      backend: "linear",
      linear: { team: "VUH" },
      decidedBy: "owner",
      decidedAt: "2026-10-09T00:00:00.000Z",
    }),
  );
  let day = 0;
  const run = (...args: string[]) => {
    // Distinct, increasing dates, as real releases have.
    const date = `2026-10-0${String(++day)}T12:00:00Z`;
    return git("git", args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  };
  const commit = (message: string) => run("commit", "--allow-empty", "-q", "-m", message);
  await run("init", "-q", "-b", "main");
  await run("config", "user.email", "releases@example.invalid");
  await run("config", "user.name", "Releases");
  await run("remote", "add", "origin", "git@github.com:example/releases.git");
  await run("add", ".clankie/tracking.json");
  await commit("feat: first item (LOCAL-1)");
  await run("tag", "-a", "v0.1.0", "-m", "v0.1.0");
  await commit("fix: LOCAL-2 and VUH-10\n\nStrings are UTF-8; digests are SHA-256.");
  await commit("chore: LOCAL-1 follow-up");
  await run("tag", "v0.2.0");
  await commit("feat: LOCAL-3 was canceled before it shipped");
  await run("tag", "-a", "v0.10.0", "-m", "v0.10.0");

  const tracker = createLocalTracker({ directory: join(root, "tracker") });
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
      clientInfo: { name: "tracker-releases-integration", version: "1" },
    })
  ).headers.get("mcp-session-id")!;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await rpc("tools/call", { name: "clankie_call", arguments: { name, arguments: args } });
    const result = (await response.json()).result as { content: { text: string }[] };
    const reply = JSON.parse(result.content[0]!.text) as { outcome: string; content?: string };
    expect(reply, JSON.stringify(reply)).toMatchObject({ outcome: "ok" });
    return JSON.parse(reply.content!);
  };
  const post = async (path: string, body: unknown, authorization = "Bearer tracker-owner") => {
    const response = await app.app.request(path, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const owner = async (name: string, args: Record<string, unknown>) => {
    const reply = await post("/v1/tracker/owner/call", { name, arguments: args });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return reply.body.result;
  };
  const sync = async () => {
    const reply = await post("/v1/tracker/releases/sync", { repo });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return reply.body.result;
  };

  for (const title of ["Shipped first", "Shipped second", "Never shipped"])
    await owner("save_issue", { team: "LOCAL", title });
  await call("linear_post_issue_event", { issueId: "LOCAL-2", type: "ack" });
  await owner("save_issue", { id: "LOCAL-3", state: "Canceled" });

  // Only the owner (or the owner's app) asks for a sync.
  expect((await post("/v1/tracker/releases/sync", { repo }, "Bearer someone-else")).status).toBe(401);

  const first = await sync();
  expect(first.repository).toBe("github.com/example/releases");
  expect(first.releases.map((release: { version: string }) => release.version)).toEqual([
    "v0.1.0",
    "v0.2.0",
    "v0.10.0",
  ]);
  expect(first.delivered).toEqual([
    { identifier: "LOCAL-1", version: "v0.1.0" },
    { identifier: "LOCAL-2", version: "v0.2.0" },
  ]);

  // A worker reads what shipped through the same linear_* vocabulary.
  const listed = await call("linear_list_releases", {});
  expect(listed.releases.map((release: { version: string }) => release.version)).toEqual([
    "v0.10.0",
    "v0.2.0",
    "v0.1.0",
  ]);
  const second = await call("linear_get_release", { id: "v0.2.0" });
  expect(second).toMatchObject({
    id: "github.com/example/releases:repository:v0.2.0",
    tag: "v0.2.0",
    lane: "repository",
    dateKind: "commit",
    stage: { name: "Shipped", type: "completed" },
  });
  expect(
    second.items.map((item: { key: string; stage?: string }) => [item.key, item.stage ?? null]).sort(),
  ).toEqual([
    ["LOCAL-1", "delivered"],
    ["LOCAL-2", "delivered"],
    ["VUH-10", null],
  ]);
  expect(second.items.find((item: { key: string }) => item.key === "VUH-10").issueId).toBeUndefined();
  expect((await call("linear_get_release", { id: "v0.10.0" })).items).toEqual([
    expect.objectContaining({ key: "LOCAL-3", stage: "reported" }),
  ]);
  expect(
    (await call("linear_list_releases", { query: "VUH-10" })).releases.map(
      (release: { version: string }) => release.version,
    ),
  ).toEqual(["v0.2.0"]);

  const shipped = await call("linear_get_issue", { id: "LOCAL-1", includeReleases: true });
  expect(shipped).toMatchObject({ stage: "delivered", state: "Delivered" });
  expect(shipped.releases.map((release: { version: string }) => release.version)).toEqual([
    "v0.1.0",
    "v0.2.0",
  ]);
  const events = (await call("linear_list_issue_events", { issueId: "LOCAL-1" })).events;
  expect(events.at(-1)).toMatchObject({
    type: "stage",
    from: "reported",
    to: "delivered",
    body: "Shipped in v0.1.0 (repository)",
    via: "release",
    selfEcho: true,
    actor: { type: "agent-worker", id: "clankie" },
  });
  expect(await call("linear_get_issue", { id: "LOCAL-3" })).toMatchObject({ state: "Canceled" });

  // Syncing again changes no item and records no new event.
  const before = (await call("linear_list_issue_events", {})).events.length;
  expect((await sync()).delivered).toEqual([]);
  expect((await call("linear_list_issue_events", {})).events).toHaveLength(before);
});
