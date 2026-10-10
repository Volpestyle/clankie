import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { ProjectsSettingsSchema, TAKE_CONTROL_GRANTS, type TrackerSyncCommand } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker, type LinearImportSnapshot, type LinearRecord } from "@clankie/work-items";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createDeviceConversationDispatch } from "../../relay/src/conversation-upstream.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { LinearCutover } from "../src/linear-cutover.ts";
import { LinearMirrors } from "../src/linear-mirror.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { projectWorkRepoId } from "../src/project-work-items.ts";
import { startTrackerOwnerLoop } from "../src/tracker-owner-loop.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { createWorkItemsService } from "../src/work-items.ts";

/**
 * Manual scratch rehearsal (VUH-1987), never the live service. A disposable host and
 * relay on the given ports run the cutover end to end with the real `clankie work`
 * CLI, a paired device over the relay, and a fleet worker's clankie_call writes.
 *
 *   tsx scripts/linear-cutover-rehearsal.ts COPY_STORE FRESH_STORE CONVENTION PORT RELAY_PORT
 *
 * COPY_STORE is a copy of a real read-only Linear import (`clankie work import linear`);
 * it becomes the scratch import. FRESH_STORE is read (never written) when the cutover
 * asks Linear for its current records: a fresh rerun of that same import, so drift is
 * judged against Linear as it is at cutover time. CONVENTION is the project's real
 * `.clankie/tracking.json`, copied. Linear wake owner identity comes from the env.
 */
const [copyStore, freshStore, conventionFile, port, relayPort] = process.argv.slice(2);
if (!copyStore || !freshStore || !conventionFile || !port || !relayPort)
  throw new Error("Usage: linear-cutover-rehearsal.ts COPY_STORE FRESH_STORE CONVENTION PORT RELAY_PORT");
const run = promisify(execFile);
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const OPERATOR = `rehearsal-${randomUUID()}`;
const root = await realpath(await mkdtemp(join(tmpdir(), "linear-cutover-rehearsal-")));
const state = join(root, "state");
const imports = join(state, "tracker-imports");
const trackerDirectory = join(state, "tracker");
const workspace = join(root, "clankie-work");
await mkdir(join(workspace, ".clankie"), { recursive: true });
await copyFile(conventionFile, join(workspace, ".clankie", "tracking.json"));
await mkdir(join(imports, "clankie-work"), { recursive: true });
await copyFile(copyStore, join(imports, "clankie-work", "tracker.json"));
const copied = JSON.parse(await readFile(join(imports, "clankie-work", "tracker.json"), "utf8"));
const linearProjectId = copied.projects[0].id as string;

const settings = new SettingsStore(join(root, "settings.json"));
const ownerIds = (process.env.REHEARSAL_OWNER_IDS ?? "").split(",").filter(Boolean);
await settings.update((current) => ({
  ...current,
  herdr: { ...current.herdr, runtime: "disabled" },
  linearWebhook: {
    ...current.linearWebhook,
    wake: { ...current.linearWebhook.wake, ownerUserIds: ownerIds },
  },
  projects: ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "clankie-work",
        name: "Clankie Work",
        workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: workspace }],
        trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
      },
    ],
  }),
}));

/** Linear's current records, from a fresh read-only import rerun taken at cutover time. */
const linearSnapshot = async (): Promise<{ snapshot: LinearImportSnapshot; requests: number }> => {
  const fresh = JSON.parse(await readFile(freshStore, "utf8"));
  const records = fresh.linearMirror.records as Record<string, LinearRecord[]>;
  return {
    snapshot: {
      workspaceId: fresh.linearMirror.workspaceId,
      team: fresh.team,
      ...(Object.fromEntries(
        [
          "projects",
          "issues",
          "comments",
          "labels",
          "milestones",
          "documents",
          "statusUpdates",
          "cycles",
          "actors",
          "relations",
        ].map((key) => [key, records[key] ?? []]),
      ) as Omit<LinearImportSnapshot, "workspaceId" | "team">),
    },
    requests: 0,
  };
};

const live = createLocalTracker({ directory: trackerDirectory });
await live.sync({ action: "bootstrap", type: "full", projects: ["*"], lazy: false });
const mirrors = new LinearMirrors({
  root: imports,
  identity: async () => ({ ownerIds, ownerEmails: [], appUserId: undefined }),
  session: async () => {
    throw new Error("The rehearsal has no Linear session");
  },
});
const cutover = new LinearCutover({
  trackerDirectory,
  importsRoot: imports,
  mirrors,
  settings,
  localMachineId: "local",
  linearSnapshot,
});
const credentials = new FileCredentialStore(join(root, "credentials.json"));
let workItems!: ReturnType<typeof createWorkItemsService>;
const host = createMcpHost({
  credentials,
  settings,
  localTracker: live,
  curated: [],
  trackerForRepo: ({ name, args, repo: target, local, ...publication }) =>
    workItems.callTracker(name, args, { repo: target, local, ...publication }),
  trackerRepoForCall: (name, args) => workItems.resolveTrackerRepo(name, args),
  logger: { info() {}, warn() {} },
});
workItems = createWorkItemsService({
  stateDirectory: state,
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
  deviceSessionKey: randomBytes(32),
  eventLogPath: join(root, "events.jsonl"),
  fleetLinks: {
    identity: () => undefined,
    authenticate: (token) => (token === `${OPERATOR}-fleet` ? "rehearsal-fleet" : undefined),
  },
  authenticateOperator: async (request) =>
    request.headers.get("authorization") === `Bearer ${OPERATOR}` ? { operatorId: "owner" } : undefined,
});
const stopLoop = await startTrackerOwnerLoop({
  tracker: live,
  captain,
  settings,
  statePath: join(trackerDirectory, "owner-loop.json"),
  logger: { info() {}, warn() {} },
});
const server = serve({
  fetch: (request) => app.app.fetch(request),
  hostname: "127.0.0.1",
  port: Number(port),
}) as Server;
if (!server.listening) await once(server, "listening");
const origin = `http://127.0.0.1:${port}`;
const handler = createOperatorConversationRelayHandler({
  authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: origin }),
  deviceDispatch: createDeviceConversationDispatch({ baseUrl: origin }),
  dispatch: async () => {
    throw new Error("Sync never substitutes captain authority");
  },
});
const relay = createServer((request, response) => void handler(request, response));
await new Promise<void>((resolve) => relay.listen(Number(relayPort), "127.0.0.1", resolve));
const relayOrigin = `http://127.0.0.1:${relayPort}`;

const cli = async (...args: string[]) => {
  const result = await run(`${repo}apps/tui/node_modules/.bin/tsx`, ["bin/clankie.ts", ...args], {
    cwd: `${repo}apps/tui`,
    env: {
      ...process.env,
      CLANKIE_CONTROL_PLANE_URL: origin,
      CLANKIE_CAPTAIN_URL: origin,
      CLANKIE_OPERATOR_TOKEN: OPERATOR,
    },
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error: { stdout?: string; stderr?: string }) => ({
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? "",
  }));
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as Record<string, any>;
  } catch {
    return { raw: result.stdout, stderr: result.stderr };
  }
};
const post = async (base: string, path: string, body: unknown, token = OPERATOR) =>
  fetch(base + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const pair = async () => {
  const offer = await (await post(origin, "/v1/pairing/offer", {})).json();
  const pending = await (
    await post(origin, "/v1/pairing/redeem", {
      offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
      device: { name: "Rehearsal app", platform: "macos" },
    })
  ).json();
  return (await (
    await post(origin, "/v1/pairing/complete", {
      completionToken: pending.completionToken,
      acceptedGrants: TAKE_CONTROL_GRANTS,
    })
  ).json()) as { deviceId: string; deviceToken: string };
};
const sync = async (token: string, command: TrackerSyncCommand) => {
  const response = await post(
    relayOrigin,
    "/operator/v1/dispatch",
    { op: "tracker_sync", schemaVersion: 1, command },
    token,
  );
  if (command.action === "bootstrap" && response.ok) {
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { meta: lines.at(-1), models: lines.slice(0, -1) };
  }
  return { status: response.status, ...(((await response.json()) as { result?: unknown }).result as object) };
};
let sequence = 0;
let session: string | undefined;
const rpc = (method: string, params: unknown) =>
  app.app.request("/v1/fleet/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPERATOR}-fleet`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
  });
const workerCall = async (name: string, args: Record<string, unknown>) => {
  session ??= (
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "rehearsal", version: "1" },
    })
  ).headers.get("mcp-session-id")!;
  const response = await rpc("tools/call", { name: "clankie_call", arguments: { name, arguments: args } });
  const result = (await response.json()).result as { content: { text: string }[] };
  return JSON.parse(result.content[0]!.text) as { outcome: string; content?: string; detail?: string };
};
const file = (path: string) => readFile(path, "utf8");
const conventionPath = join(workspace, ".clankie", "tracking.json");
const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 15_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > until) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const evidence: Record<string, unknown> = { root, ports: { host: Number(port), relay: Number(relayPort) } };
try {
  const before = {
    live: await file(join(trackerDirectory, "tracker.json")),
    convention: await file(conventionPath),
  };
  evidence.mirrorEnable = await cli(
    "work",
    "mirror",
    "linear",
    "--scratch",
    "clankie-work",
    "--project",
    linearProjectId,
    "enable",
  );
  const args = [
    "work",
    "cutover",
    "linear",
    "--world-project",
    "clankie-work",
    "--scratch",
    "clankie-work",
    "--project",
    linearProjectId,
  ];
  const dry = await cli(...args, "--dry-run");
  evidence.dryRun = dry;
  assert.equal(dry.ready, true, JSON.stringify(dry.refusals));
  assert.equal(await file(join(trackerDirectory, "tracker.json")), before.live);
  assert.equal(await file(conventionPath), before.convention);

  const device = await pair();
  const firstBoot = await sync(device.deviceToken, {
    action: "bootstrap",
    type: "full",
    projects: ["*"],
    lazy: true,
  });
  const applied = await cli(...args);
  evidence.cutover = { applied: applied.applied, storeId: applied.storeId, refusals: applied.refusals };
  assert.deepEqual(applied.applied, ["mirror", "store", "setting", "convention"]);
  evidence.conventionAfter = JSON.parse(await file(conventionPath));
  evidence.bindingAfter = (await settings.load()).projects.projects[0]!.trackerProjectId;

  // The app's path: its saved cursor is for the old store, so it rebootstraps and sees the project.
  const resumed = await sync(device.deviceToken, {
    action: "subscribe",
    projects: ["workspace"],
    storeId: (firstBoot as { meta: { storeId: string } }).meta.storeId,
    lastSyncId: (firstBoot as { meta: { lastSyncId: number } }).meta.lastSyncId,
    waitMs: 0,
    limit: 10,
  } as TrackerSyncCommand);
  const reboot = (await sync(device.deviceToken, {
    action: "bootstrap",
    type: "full",
    projects: ["*"],
    lazy: true,
  })) as {
    meta: Record<string, unknown>;
    models: { modelName: string; data: Record<string, unknown> }[];
  };
  evidence.device = {
    before: (firstBoot as { meta: unknown }).meta,
    resumeOldCursor: resumed,
    after: reboot.meta,
    models: Object.fromEntries(
      [...new Set(reboot.models.map((m) => m.modelName))].map((name) => [
        name,
        reboot.models.filter((m) => m.modelName === name).length,
      ]),
    ),
  };

  const loopState = await waitFor(
    async () => JSON.parse(await file(join(trackerDirectory, "owner-loop.json")).catch(() => "{}")),
    (value) => value.storeId === applied.storeId,
  );
  evidence.ownerLoopAfterPromotion = { ...loopState, wakes: wakes.length };

  // A worker moves a real Clankie Work item through the stages, through the built-in tracker.
  const target = process.env.REHEARSAL_ITEM ?? "VUH-1987";
  const repoId = projectWorkRepoId("clankie-work");
  const workerWrites = [];
  for (const [tool, toolArgs] of [
    [
      "linear_save_comment",
      { issueId: target, body: "Rehearsal (scratch store only): a worker writes after cutover." },
    ],
    ["linear_post_issue_event", { issueId: target, type: "ack" }],
    [
      "linear_post_issue_event",
      { issueId: target, type: "result", stage: "landed", body: "Rehearsal landing." },
    ],
  ] as const) {
    const reply = await workerCall(tool, { repo: repoId, ...toolArgs });
    workerWrites.push({
      tool,
      outcome: reply.outcome,
      ...(reply.outcome === "ok" ? {} : { detail: reply.detail ?? reply.content }),
    });
  }
  evidence.workerWrites = workerWrites;
  evidence.cliShow = await cli("work", "show", target, "--repo", workspace);
  const asks = await waitFor(
    async () =>
      (
        (await (await post(origin, "/operator/v1/dispatch", { schemaVersion: 1, op: "input_list" })).json())
          .result.questions as {
          question: { purpose: string; status: string; prompt: string };
        }[]
      ).filter((entry) => entry.question.purpose === "verify"),
    (value) => value.length > 0,
  );
  evidence.checkItWorksAsks = asks.map((entry) => ({
    status: entry.question.status,
    prompt: entry.question.prompt,
  }));
  const store = JSON.parse(await file(join(trackerDirectory, "tracker.json")));
  evidence.workerEventActors = (
    store.events as { issueId: string; type: string; actor: unknown; via?: string }[]
  )
    .filter((event) => event.via === undefined)
    .slice(-4)
    .map(({ type, actor }) => ({ type, actor }));
  evidence.wakesTotal = wakes.length;

  const back = ["work", "cutover", "linear", "--world-project", "clankie-work", "--switch-back"];
  evidence.switchBackDryRun = await cli(...back, "--dry-run");
  const pilot = await file(join(trackerDirectory, "tracker.json"));
  const switched = await cli(...back);
  evidence.switchBack = { applied: switched.applied, refusals: switched.refusals };
  const keep = (switched.changes as { what: string; keep?: string }[]).find((c) => c.what === "store")!.keep!;
  evidence.restored = {
    conventionExact: (await file(conventionPath)) === before.convention,
    storeExact: (await file(join(trackerDirectory, "tracker.json"))) === before.live,
    binding: (await settings.load()).projects.projects[0]!.trackerProjectId ?? null,
    pilotKept: (await file(keep)) === pilot,
  };
  console.log(JSON.stringify({ outcome: "passed", ...evidence }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ outcome: "failed", error: String(error), ...evidence }, null, 2));
  process.exitCode = 1;
} finally {
  await stopLoop();
  for (const instance of [relay, server]) {
    instance.closeAllConnections();
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
  app.close();
  if (process.env.REHEARSAL_KEEP !== "1") await rm(root, { recursive: true, force: true });
}
