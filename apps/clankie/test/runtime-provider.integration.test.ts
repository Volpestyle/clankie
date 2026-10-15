import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  ProjectsSettingsSchema,
  ProjectsSnapshotSchema,
  OperatorConversationServiceResultSchema,
  OperatorSeatEventKindSchema,
  SUPERVISE_GRANTS,
  type DiscordPresenceChannelTurnRequest,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import { createBearerAuthenticator, createClankieApp } from "../src/app.ts";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { createLocalTracker, TRACKER_LEAD, TRACKER_OWNER, type TrackerActor } from "@clankie/work-items";
import { AutoRoundsResponseSchema } from "@clankie/protocol/auto-rounds";
import { AutoRoundRecord } from "../src/captain/auto-rounds.ts";
import { readProjectOutcomes } from "../src/project-outcomes.ts";
import { createCaptain } from "../src/captain/captain.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { ConversationStore, type ConversationTurnContext } from "../src/captain/conversations.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { RuntimeProvider } from "../src/runtime-provider.ts";
import { runConversationsCommand } from "../../tui/src/command/conversations.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Real app, captain, native channel, HTTP and durable stores; no model calls.
// Unconnected capabilities fail if this fixture ever falls through to Pi.
async function fixture(
  provider?: RuntimeProvider,
  autoRounds: boolean | "captured-ownership" = false,
  outcomeProof?: {
    projectId: string;
    read: NonNullable<Parameters<typeof createCaptain>[1]["projectOutcomes"]>;
  },
  cadenceProof?: { intervalMs: number },
) {
  const root = await mkdtemp(join(tmpdir(), "clankie-runtime-provider-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  await mkdir(state);
  const seeded = new ConversationStore(join(state, "conversations"), async () => {});
  const roomId = seeded.roomConversation("discord_presence", "12345:67890");
  let projectLead: string | undefined;
  const settings = new SettingsStore(join(state, "settings.json"));
  if (autoRounds) {
    const autonomy = new AutonomyStore(join(state, "autonomy.json"));
    autonomy.command("global-default", { action: "set_enabled", enabled: false });
    autonomy.close();
    await mkdir(join(root, "project"));
    await mkdir(join(root, "clankie"));
    await mkdir(join(root, "tracker-research-20261008"));
    const captured = autoRounds === "captured-ownership";
    const leadWorkspace = join(root, captured ? "clankie" : "project");
    const created = await seeded.serve({
      schemaVersion: 1,
      op: "create",
      title: "Project lead",
      scope: { kind: "workspace", workspaceId: leadWorkspace },
    });
    if (created.op !== "create") throw new Error("Missing project lead");
    projectLead = created.conversation.conversationId;
    await settings.update((current) => ({
      ...current,
      projects: ProjectsSettingsSchema.parse({
        projects: captured
          ? [
              {
                id: "clankie",
                name: "clankie",
                auto: true,
                workspaces: [
                  { id: "primary", machineId: "local", platform: "posix", path: join(root, "clankie") },
                ],
              },
              {
                id: "clankie-work",
                name: "Clankie Work",
                auto: false,
                trackerProjectId: "cbd205ab-cad4-48b8-9724-7109410fc921",
                workspaces: [
                  {
                    id: "primary",
                    machineId: "local",
                    platform: "posix",
                    path: join(root, "tracker-research-20261008"),
                  },
                ],
              },
            ]
          : [
              {
                id: "led",
                name: "Led project",
                auto: true,
                focus: "Lead backlog",
                ...(outcomeProof
                  ? { trackerProjectId: outcomeProof.projectId }
                  : {
                      linearProjectBinding: {
                        provider: "linear",
                        projectId: "11111111-1111-4111-8111-111111111111",
                      },
                    }),
                workspaces: [
                  { id: "repo", machineId: "local", platform: "posix", path: join(root, "project") },
                ],
              },
              { id: "fallback", name: "Fallback project", auto: true, focus: "Head backlog" },
            ],
      }),
      linearWebhook: {
        ...current.linearWebhook,
        projectChats: [
          {
            projectId: captured
              ? "cbd205ab-cad4-48b8-9724-7109410fc921"
              : (outcomeProof?.projectId ?? "11111111-1111-4111-8111-111111111111"),
            name: "Lead project",
            conversationId: projectLead!,
          },
        ],
      },
    }));
  }
  await seeded.close();
  const unavailable = (): never => {
    throw new Error("This native-channel fixture has no model or external capabilities");
  };
  const deps: CaptainDeps = {
    herdrAvailable: () => false,
    mcp: { catalog: async () => [], call: unavailable },
    email: { list: unavailable, read: unavailable, search: unavailable, send: unavailable },
    browser: { catalog: async () => ({ schemaVersion: 1, available: false, tools: [] }), call: unavailable },
    media: { generateImage: unavailable, generateVideo: unavailable, finishedRenders: async () => [] },
    embodiment: {
      submitIntent: unavailable,
      getSession: unavailable,
      getLiveSession: unavailable,
    },
    activity: { current: unavailable },
    presence: {
      listSessions: unavailable,
      listVoiceHistory: unavailable,
      listRecentVoiceSpeech: unavailable,
    },
    memory: {
      writeMemory: unavailable,
      recallMemoryCard: unavailable,
      searchMemory: unavailable,
      editMemory: unavailable,
      forgetMemory: unavailable,
    },
  };
  const captainOptions: Parameters<typeof createCaptain>[1] = {
    repoRoot: root,
    stateDir: state,
    workingDirectory: root,
    settings,
    ...(autoRounds ? { autoRoundIntervalMs: cadenceProof?.intervalMs ?? 100 } : {}),
    ...(outcomeProof ? { projectOutcomes: outcomeProof.read } : {}),
    ...(provider === undefined ? {} : { runtimeProvider: provider }),
  };
  let captain = createCaptain(deps, captainOptions);
  cleanups.push(() => captain.close());
  const ownerCaptain = createBearerAuthenticator("fixture-owner", {
    captainId: "fixture-captain",
    steerSourceLane: "api" as const,
  });
  const contextCaptain = createBearerAuthenticator("fixture-context", {
    captainId: "fixture-context",
    steerSourceLane: "api" as const,
  });
  const service = await createClankieApp({
    captain,
    settings,
    autoRounds: new AutoRoundRecord(join(state, "auto-rounds")),
    deviceSessionKey: randomBytes(32),
    eventLogPath: join(root, "events.jsonl"),
    authenticateOperator: createBearerAuthenticator("fixture-owner", { operatorId: "owner" }),
    authenticateCaptain: async (request) => (await ownerCaptain(request)) ?? contextCaptain(request),
    ...(provider === undefined ? {} : { runtimeProvider: provider }),
  });
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(async () => {
    service.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture port");
  const host = `http://127.0.0.1:${address.port}`;
  const request = (path: string, token?: string, body?: unknown) =>
    fetch(`${host}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
  const command = async (body: OperatorConversationServiceRequest, token = "fixture-owner") => {
    const response = await request(OPERATOR_CONVERSATION_DISPATCH_PATH, token, body);
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  const attach = async (id: string) => {
    expect(await captain.pollSeatEvents(0, undefined, id)).toEqual([]);
    expect(
      captain.syncSeatTranscript(id, { sessionId: `native-${id}`, entries: [], activity: "waiting" }),
    ).toBe(true);
  };
  await attach("global-default");
  await attach(roomId);
  if (projectLead) await attach(projectLead);
  const journal = new ConversationJournal(join(state, "conversations"));
  return {
    get captain() {
      return captain;
    },
    roomId,
    projectLead,
    command,
    request,
    journal,
    attach,
    root,
    host,
    state,
    settings,
    // Restart the real runtime and its native endpoints over the same durable stores.
    // The original HTTP app is unused after restart; commands use the native service port.
    restart: async () => {
      await captain.close();
      captain = createCaptain(deps, captainOptions);
      await Promise.all(["global-default", roomId, ...(projectLead ? [projectLead] : [])].map(attach));
    },
  };
}

it("the default public app has no quota routes and native captain turns still complete", async () => {
  const f = await fixture();
  for (const path of ["/v1/runtime-fixture/quota", "/v1/hosted/credits"])
    expect((await f.request(path, "fixture-owner")).status).toBe(404);
  const polled = f.captain.pollSeatEvents(5_000, undefined, "global-default", {
    schemaVersion: 1,
    eventKinds: [...OperatorSeatEventKindSchema.options],
    ownerOrigin: true,
  });
  const current = await f.command({ schemaVersion: 1, op: "get", conversationId: "global-default" });
  if (current.op !== "get" || !current.conversation) throw new Error("Missing default conversation");
  const sending = f.command({
    schemaVersion: 1,
    op: "send",
    turn: {
      schemaVersion: 1,
      kind: "message",
      conversationId: "global-default",
      surfaceClientId: "fixture",
      expectedRevision: current.conversation.revision,
      message: "Native request without hosted policy",
      delivery: "queue",
    },
  });
  const [event] = await polled;
  expect(event?.content).toContain("Native request without hosted policy");
  expect(event).toMatchObject({
    kind: "turn",
    ownerOrigin: { surfaceClientId: "fixture", principal: { kind: "operator", id: "owner" } },
  });
  expect(await f.captain.acknowledgeSeatEvent(event!.id, "global-default")).toBe(true);
  expect((await sending).op).toBe("send");
  expect(await f.captain.replySeatEvent(event!.id, "Separate tool answer", "global-default")).toBe(false);
  expect(
    f.captain.syncSeatTranscript("global-default", {
      sessionId: "native-global-default",
      entries: [{ type: "message", id: "native-answer", role: "agent", text: "Native answer" }],
      activity: "waiting",
    }),
  ).toBe(true);
  await expect
    .poll(() => f.journal.read("global-default"))
    .toContainEqual(expect.objectContaining({ type: "turn", phase: "completed" }));
  expect(
    f.journal.read("global-default").filter((entry) => entry.type === "message" && entry.role === "captain"),
  ).toMatchObject([{ text: "Native answer" }]);
});

it("injected quota routes keep paired-device authorization and heartbeat tracks native escalation lifetime", async () => {
  let quotaReads = 0;
  const starts: ConversationTurnContext["origin"][] = [];
  let finishes = 0;
  const f = await fixture({
    quota: {
      routes(authorize) {
        return new Hono().get("/v1/runtime-fixture/quota", async (context) => {
          const admitted = await authorize(context.req.raw);
          if (admitted !== true)
            return context.json({ error: admitted }, admitted === "forbidden" ? 403 : 401);
          quotaReads++;
          return context.json({ remaining: 7 });
        });
      },
    },
    heartbeat: {
      begin(origin) {
        starts.push(origin);
        return () => {
          finishes++;
        };
      },
      interactive() {},
      authenticatedWork() {},
      activitySharing() {},
      start() {},
      close() {},
    },
  });
  expect((await f.request("/v1/runtime-fixture/quota")).status).toBe(401);
  expect(quotaReads).toBe(0);
  expect(await (await f.request("/v1/runtime-fixture/quota", "fixture-owner")).json()).toEqual({
    remaining: 7,
  });
  const offer = await (await f.request("/v1/pairing/offer", "fixture-owner", {})).json();
  const pending = await (
    await f.request("/v1/pairing/redeem", undefined, {
      offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
      device: { name: "Fixture phone", platform: "ios" },
    })
  ).json();
  const paired = await (
    await f.request("/v1/pairing/complete", undefined, {
      completionToken: pending.completionToken,
      acceptedGrants: SUPERVISE_GRANTS,
    })
  ).json();
  expect((await f.request("/v1/runtime-fixture/quota", paired.deviceToken)).status).toBe(200);
  expect((await f.request(`/v1/devices/${pending.deviceId}/revoke`, "fixture-owner", {})).status).toBe(200);
  expect((await f.request("/v1/runtime-fixture/quota", paired.deviceToken)).status).toBe(401);
  expect(quotaReads).toBe(2);

  for (const unprompted of [false, true]) {
    const deliveryId = `fixture-${unprompted}`;
    const request: DiscordPresenceChannelTurnRequest = {
      schemaVersion: 1,
      deliveryId,
      identity: {
        presenceSessionId: "fixture-body",
        correlationId: deliveryId,
        profileHash: "fixture-profile",
        characterId: "clankie",
        credentialRef: "fixture",
        transportKind: "bot",
      },
      trigger: {
        kind: "message",
        id: deliveryId,
        guildId: "12345",
        channelId: "67890",
        actorId: "11111",
        body: "Native room request",
        attachments: [],
        ...(unprompted ? { unprompted: true } : {}),
      },
      contextMessages: [],
    };
    // No native parent is proved and no model is connected. Failure still closes the activity hook.
    expect(await f.captain.submitDiscordTurn(request)).toMatchObject({
      state: "failed",
      code: "captain_session_failed",
    });
    expect(await f.captain.pollSeatEvents(0, undefined, f.roomId)).toEqual([]);
    expect(finishes).toBe(unprompted ? 2 : 1);
  }
  expect(starts).toEqual([undefined, "wake"]);
  expect(finishes).toBe(2);

  for (const completion of ["reply", "cancel"] as const) {
    const before = finishes;
    const polled = f.captain.pollSeatEvents(5_000, undefined, "global-default");
    const current = await f.command({ schemaVersion: 1, op: "get", conversationId: "global-default" });
    if (current.op !== "get" || !current.conversation) throw new Error("Missing default conversation");
    const message = `Native operator turn: ${completion}`;
    const sending = f.command(
      {
        schemaVersion: 1,
        op: "send",
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: "global-default",
          surfaceClientId: "fixture",
          expectedRevision: current.conversation.revision,
          message,
          delivery: "queue",
        },
      },
      "fixture-context",
    );
    const [event] = await polled;
    expect(event?.content).toContain(message);
    expect(event).toMatchObject({ kind: "escalation" });
    expect(await f.captain.acknowledgeSeatEvent(event!.id, "global-default")).toBe(true);
    expect((await sending).op).toBe("send");
    expect(finishes).toBe(before);
    if (completion === "reply") {
      expect(await f.captain.replySeatEvent(event!.id, "Native operator answer", "global-default")).toBe(
        true,
      );
    } else {
      const accepted = f.journal
        .read("global-default")
        .findLast((event) => event.type === "turn" && event.phase === "accepted");
      if (accepted?.type !== "turn") throw new Error("Missing accepted turn");
      expect(
        await f.command({
          schemaVersion: 1,
          op: "cancel",
          conversationId: "global-default",
          runId: accepted.runId,
        }),
      ).toMatchObject({ op: "cancel", cancelled: true });
    }
    await expect.poll(() => finishes).toBe(before + 1);
    await f.attach("global-default");
  }
  expect(starts).toEqual([undefined, "wake", undefined, undefined]);
  expect(finishes).toBe(4);
});

// VUH-2029 acceptance: a real captain wakes each project's lead without an owner
// prompt, independently deduplicates leads, and starts no work for an off project.
it("routes Auto rounds to the configured project lead and independently wakes the fallback head", async () => {
  const f = await fixture(undefined, true);
  const lead = f.projectLead!;
  const events = (id: string, wait = 5_000) => f.captain.pollSeatEvents(wait, undefined, id);
  const accept = async (id: string) => {
    const round = (await events(id)).find((event) => event.content.startsWith("Auto round."));
    expect(round).toBeDefined();
    expect(await f.captain.acknowledgeSeatEvent(round!.id, id)).toBe(true);
    return round!;
  };
  await f.command({
    schemaVersion: 1,
    op: "autonomy",
    conversationId: "global-default",
    command: { action: "set_enabled", enabled: true },
  });
  const [led, head] = await Promise.all([accept(lead), accept("global-default")]);
  expect(led.content).toContain("Current account capacity (service reading;");
  expect(head.content).toContain("Current account capacity (service reading;");
  expect(led.content).toContain("clankie usage --json");
  expect(led.content).toContain("Lead backlog");
  expect(led.content).toContain("Linear project: 11111111-1111-4111-8111-111111111111");
  expect(led.content).not.toContain("Head backlog");
  expect(head.content).toContain("Head backlog");
  expect(head.content).not.toContain("Lead backlog");
  console.info(
    "Auto routing service capture",
    JSON.stringify({
      lead: { conversationId: lead, eventId: led.id, content: led.content },
      head: { conversationId: "global-default", eventId: head.id, content: head.content },
    }),
  );
  const update = async (projectId: string, changes: { focus?: string; auto?: boolean }) => {
    const before = await f.request("/v1/operator/projects?includeAutonomy=true", "fixture-owner");
    const snapshot = ProjectsSnapshotSchema.parse(await before.json());
    const saved = await f.request("/v1/operator/projects/update?includeAutonomy=true", "fixture-owner", {
      projectId,
      expectedRevision: snapshot.revision,
      changes,
    });
    expect(saved.status).toBe(200);
  };
  // Churn in the head's project must not wake the unchanged project lead.
  await update("fallback", { focus: "Changed head backlog" });
  expect((await accept("global-default")).content).toContain("Changed head backlog");
  expect(await events(lead, 350)).toEqual([]);
  await update("led", { auto: false });
  await update("led", { focus: "Off project must not wake" });
  expect(await events(lead, 350)).toEqual([]);
  // Turning it back on clears that lead's previous idle suppression.
  await update("led", { auto: true });
  expect((await accept(lead)).content).toContain("Off project must not wake");
  await f.command({
    schemaVersion: 1,
    op: "autonomy",
    conversationId: "global-default",
    command: { action: "set_enabled", enabled: false },
  });
  await update("fallback", { focus: "Master off must not wake" });
  expect(await events("global-default", 350)).toEqual([]);
  expect(await events(lead, 350)).toEqual([]);
});

// Captured 2026-10-12 owner configuration: clankie-work's project route is
// conv-4c11af56, whose chat workspace is clankie, not tracker-research-20261008.
// Only the filesystem prefix and generated conversation ID are fixture-local.
it("keeps clankie Auto at the global head when another project owns the matching workspace lead", async () => {
  const f = await fixture(undefined, "captured-ownership");
  const lead = f.projectLead!;
  await f.command({
    schemaVersion: 1,
    op: "autonomy",
    conversationId: "global-default",
    command: { action: "set_enabled", enabled: true },
  });
  const head = (await f.captain.pollSeatEvents(5_000, undefined, "global-default")).find((event) =>
    event.content.startsWith("Auto round."),
  );
  expect(head?.content).toContain("clankie (clankie)");
  expect(head?.content).not.toContain("Clankie Work");
  expect(await f.captain.acknowledgeSeatEvent(head!.id, "global-default")).toBe(true);
  expect(await f.captain.pollSeatEvents(350, undefined, lead)).toEqual([]);
  const before = await f.request("/v1/operator/projects?includeAutonomy=true", "fixture-owner");
  const snapshot = ProjectsSnapshotSchema.parse(await before.json());
  const enabled = await f.request("/v1/operator/projects/update?includeAutonomy=true", "fixture-owner", {
    projectId: "clankie-work",
    expectedRevision: snapshot.revision,
    changes: { auto: true },
  });
  expect(enabled.status).toBe(200);
  const round = (await f.captain.pollSeatEvents(5_000, undefined, lead)).find((event) =>
    event.content.startsWith("Auto round."),
  );
  expect(round?.content).toContain("Clankie Work (clankie-work)");
  expect(round?.content).not.toContain("clankie (clankie)");
  expect(await f.captain.acknowledgeSeatEvent(round!.id, lead)).toBe(true);
  expect(await f.captain.pollSeatEvents(350, undefined, "global-default")).toEqual([]);
});

it("a live tracker parent closure wakes its Auto lead once and links the post in the operator round record", async () => {
  const trackerRoot = await mkdtemp(join(tmpdir(), "auto-milestone-live-"));
  cleanups.push(() => rm(trackerRoot, { recursive: true, force: true }));
  const actor: TrackerActor = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
  const tracker = createLocalTracker({ directory: trackerRoot, validateEvidence: async () => {} });
  const call = (name: string, args: Record<string, unknown>) => tracker.call(name, args, { actor });
  const project = (await call("save_project", { name: "Milestone proof", addTeams: ["LOCAL"] })) as {
    id: string;
  };
  const parent = (await call("save_issue", {
    title: "Playable route",
    team: "LOCAL",
    project: project.id,
  })) as { id: string; identifier: string };
  await call("save_issue", { title: "Route child", team: "LOCAL", project: project.id, parentId: parent.id });
  const f = await fixture(undefined, true, {
    projectId: project.id,
    read: (target, input) =>
      readProjectOutcomes(target, input, {
        route: async () => "project:led",
        builtIn: tracker,
        linearQuery: async () => {
          throw new Error("Not a Linear proof");
        },
      }),
  });
  const lead = f.projectLead!;
  const accept = async (id: string) => {
    const event = (await f.captain.pollSeatEvents(5_000, undefined, id)).find((entry) =>
      entry.content.startsWith("Auto round."),
    );
    expect(event).toBeDefined();
    expect(await f.captain.acknowledgeSeatEvent(event!.id, id)).toBe(true);
    return event!;
  };
  await f.command({
    schemaVersion: 1,
    op: "autonomy",
    conversationId: "global-default",
    command: { action: "set_enabled", enabled: true },
  });
  const [routine] = await Promise.all([accept(lead), accept("global-default")]);
  expect(routine.content).toContain("Do not post a project status update");
  const rounds = async () =>
    AutoRoundsResponseSchema.parse(
      await (await f.request("/v1/auto/rounds?project=led", "fixture-owner")).json(),
    ).rounds;
  await expect.poll(async () => (await rounds()).some((round) => round.delivery?.delivered)).toBe(true);
  await call("post_issue_event", { issueId: parent.id, type: "result", stage: "landed" });
  await call("save_evidence_bundle", {
    issueId: parent.id,
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
  await tracker.call(
    "save_issue",
    { id: parent.id, state: "Done" },
    { actor: { ...TRACKER_OWNER, onBehalfOf: [] } },
  );
  const milestone = await accept(lead);
  expect(milestone.content).toContain(parent.identifier);
  expect(milestone.content).toContain("Post exactly one project status update");
  expect(milestone.content).toContain("with media and evidence links");
  const update = (await call("save_status_update", {
    type: "project",
    project: project.id,
    body: "Playable route complete; native-channel proof. [Evidence](clankie://evidence/sha256/fixture)",
  })) as { id: string };
  await expect
    .poll(async () =>
      (await rounds())
        .flatMap((round) => round.projects)
        .flatMap((entry) => entry.report?.updates ?? [])
        .some((entry) => entry.id === update.id && !entry.unexpected),
    )
    .toBe(true);
  expect(await f.captain.pollSeatEvents(300, undefined, lead)).toEqual([]);
  console.info(
    "Live Auto milestone proof",
    JSON.stringify({
      routine: routine.content,
      milestone: milestone.content,
      updateId: update.id,
      rounds: await rounds(),
    }),
  );
  await f.command({
    schemaVersion: 1,
    op: "autonomy",
    conversationId: "global-default",
    command: { action: "set_enabled", enabled: false },
  });
});

it("Auto reaches native delivery despite repeated early restarts, then preserves idle suppression on overdue restart", async () => {
  const intervalMs = 5_000;
  const f = await fixture(undefined, true, undefined, { intervalMs });
  const lead = f.projectLead!;
  const cadence = async () =>
    JSON.parse(await readFile(join(f.state, "auto-rounds", "cadence.json"), "utf8")) as {
      nextTickAt: number;
      leads: Record<string, { accepted?: { fingerprint: string; at: number } }>;
    };
  const initialDeadline = (await cadence()).nextTickAt;
  const ownerCommand = (enabled: boolean) =>
    f.captain.serveOperatorConversation(
      {
        schemaVersion: 1,
        op: "autonomy",
        conversationId: "global-default",
        command: { action: "set_enabled", enabled },
      },
      {
        principal: { kind: "operator", id: "fixture-owner" },
        authorize: async () => true,
        current: () => true,
      },
    );
  await ownerCommand(true);
  for (let restart = 0; restart < 3; restart++) {
    await delay(100);
    await f.restart();
    expect((await cadence()).nextTickAt).toBe(initialDeadline);
  }
  expect(Date.now()).toBeLessThan(initialDeadline);
  await f.captain.close();
  await delay(Math.max(0, initialDeadline - Date.now()) + 30);
  await f.restart();
  await expect.poll(async () => (await cadence()).nextTickAt).toBeGreaterThan(initialDeadline);
  const receive = async (conversationId: string) => {
    const event = (await f.captain.pollSeatEvents(8_000, undefined, conversationId)).find((entry) =>
      entry.content.startsWith("Auto round."),
    );
    expect(event).toBeDefined();
    expect(await f.captain.acknowledgeSeatEvent(event!.id, conversationId)).toBe(true);
    return event!;
  };
  await Promise.all([receive(lead), receive("global-default")]);
  await expect.poll(async () => (await cadence()).leads[lead]?.accepted).toBeDefined();
  const accepted = (await cadence()).leads[lead]!.accepted!;
  const record = new AutoRoundRecord(join(f.state, "auto-rounds"));
  expect(
    record.read().filter((round) => round.conversationId === lead && round.delivery?.delivered),
  ).toHaveLength(1);
  // Restart while stopped past the next tick, but well within the two-hour idle window.
  await f.captain.close();
  const stoppedDeadline = (await cadence()).nextTickAt;
  await delay(Math.max(0, stoppedDeadline - Date.now()) + 30);
  await f.restart();
  await expect.poll(async () => (await cadence()).nextTickAt).toBeGreaterThan(stoppedDeadline);
  expect(await f.captain.pollSeatEvents(250, undefined, lead)).toEqual([]);
  expect((await cadence()).leads[lead]!.accepted).toEqual(accepted);
  expect(record.read().filter((round) => round.conversationId === lead)).toHaveLength(1);
  // An overdue startup while paused still consumes its tick without dispatching work.
  await ownerCommand(false);
  await f.captain.close();
  const pausedDeadline = (await cadence()).nextTickAt;
  await delay(Math.max(0, pausedDeadline - Date.now()) + 30);
  await f.restart();
  await expect.poll(async () => (await cadence()).nextTickAt).toBeGreaterThan(pausedDeadline);
  expect(await f.captain.pollSeatEvents(200, undefined, lead)).toEqual([]);
  expect(record.read().filter((round) => round.conversationId === lead)).toHaveLength(1);
  console.info(
    "Restart Auto cadence proof",
    JSON.stringify({ intervalMs, initialDeadline, accepted, final: await cadence(), rounds: record.read() }),
  );
});

it("an isolated Auto runtime records the lead's drift choice and checks started state and subsequent product landings", async () => {
  const trackerRoot = await mkdtemp(join(tmpdir(), "auto-correction-runtime-"));
  cleanups.push(() => rm(trackerRoot, { recursive: true, force: true }));
  let clock = new Date(Date.now() - 2 * 86_400_000);
  const actor: TrackerActor = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
  const tracker = createLocalTracker({ directory: trackerRoot, clock: () => clock });
  const call = (name: string, args: Record<string, unknown>) => tracker.call(name, args, { actor });
  const project = (await call("save_project", { name: "Drift correction proof", addTeams: ["LOCAL"] })) as {
    id: string;
  };
  const old = (await call("save_issue", {
    team: "LOCAL",
    project: project.id,
    title: "Earlier tooling",
  })) as { id: string };
  await call("save_issue", { id: old.id, state: "In Progress" });
  clock = new Date();
  const chosen = (await call("save_issue", {
    team: "LOCAL",
    project: project.id,
    title: "Playable milestone feature",
  })) as { id: string; identifier: string };
  const f = await fixture(undefined, true, {
    projectId: project.id,
    read: (target, input) =>
      readProjectOutcomes(target, input, {
        route: async () => "project:led",
        builtIn: tracker,
        linearQuery: async () => {
          throw new Error("Not a Linear proof");
        },
      }),
  });
  const exec = promisify(execFile);
  const workspace = join(f.root, "project");
  const origin = join(f.root, "origin.git");
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);
  await exec("git", ["init", "-q", "-b", "main", workspace]);
  const git = (...args: string[]) =>
    exec("git", [
      "-C",
      workspace,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ]);
  await git("remote", "add", "origin", origin);
  await writeFile(join(workspace, "game.ts"), "export const playable = false;\n");
  await git("add", "game.ts");
  await git("commit", "-q", "-m", "Earlier product scaffold");
  await git("push", "-q", "origin", "main");
  await git("remote", "set-head", "origin", "main");
  const leadId = f.projectLead!;
  const accept = async () => {
    const event = (await f.captain.pollSeatEvents(5_000, undefined, leadId)).find((entry) =>
      entry.content.startsWith("Auto round."),
    );
    expect(event).toBeDefined();
    await f.captain.acknowledgeSeatEvent(event!.id, leadId);
    return event!;
  };
  const rounds = async () =>
    AutoRoundsResponseSchema.parse(
      await (await f.request("/v1/auto/rounds?project=led", "fixture-owner")).json(),
    ).rounds;
  await f.command({
    schemaVersion: 1,
    op: "autonomy",
    conversationId: "global-default",
    command: { action: "set_enabled", enabled: true },
  });
  // The fallback head has its own round and cannot answer this project's detection.
  const fallback = f.captain.pollSeatEvents(5_000, undefined, "global-default").then(async (events) => {
    for (const event of events) await f.captain.acknowledgeSeatEvent(event.id, "global-default");
  });
  const detection = await accept();
  await fallback;
  expect(detection.content).toContain("nothing_closed");
  expect(detection.content).toContain("record_drift_correction");
  const roundId = (await rounds())[0]!.roundId;
  expect(detection.content).toContain(roundId);
  const input = {
    projectId: "led",
    roundId,
    issue: chosen.identifier,
    reason: "Staff the playable milestone instead of more tooling",
  };
  const ownBank = await f.captain.laneToolBank("operator", leadId);
  const own = ownBank.tools.find((tool) => tool.name === "record_drift_correction")!;
  const foreign = (await f.captain.laneToolBank("operator", "global-default")).tools.find(
    (tool) => tool.name === "record_drift_correction",
  )!;
  expect((await foreign.call(input)).isError).toBe(true);
  expect(
    (await f.captain.laneToolBank("discord_presence")).tools.some(
      (tool) => tool.name === "record_drift_correction",
    ),
  ).toBe(false);
  const result = await own.call(input);
  expect(result.isError).not.toBe(true);
  expect(await own.call(input)).toEqual(result);
  expect((await own.call({ ...input, reason: "Silently replace the original choice" })).isError).toBe(true);
  const original = (await rounds()).find((round) => round.roundId === roundId)!.projects[0]!;
  expect(original).toMatchObject({
    drift: [{ signal: "nothing_closed" }],
    correction: { issue: chosen.identifier, reason: input.reason },
  });
  const checkWake = await accept();
  expect(checkWake.content).toContain(`correction check for ${chosen.identifier}: unresolved`);
  expect(checkWake.content).toContain("No product churn landed after the correction");
  await expect
    .poll(async () => (await rounds())[0]?.projects[0]?.correctionCheck)
    .toMatchObject({ state: "unresolved", issueStarted: false, productLines: 0 });
  // Product that predates the response did not count. Now start the choice and land real product.
  clock = new Date();
  await call("save_issue", { id: chosen.id, state: "In Progress" });
  await new Promise((resolve) => setTimeout(resolve, 1_100)); // Git dates have second precision.
  await writeFile(join(workspace, "game.ts"), "export const playable = true;\nexport const party = 2;\n");
  await git("add", "game.ts");
  await git("commit", "-q", "-m", `Playable milestone (${chosen.identifier})`);
  await git("push", "-q", "origin", "main");
  const checked = await accept();
  expect(checked.content).toContain(`correction check for ${chosen.identifier}: satisfied`);
  await expect.poll(async () => (await rounds())[0]?.projects[0]?.correctionCheck?.state).toBe("satisfied");
  const record = new AutoRoundRecord(join(f.state, "auto-rounds"));
  expect(record.pendingCorrection("led")).toBeUndefined();
  const proof = await rounds();
  expect(proof[0]!.projects[0]!.correctionCheck!.productLines).toBeGreaterThan(0);
  let cliOutput = "";
  expect(
    await runConversationsCommand(["auto", "rounds", "--project", "led"], {
      env: {
        HOME: f.root,
        CLANKIE_STATE: f.state,
        CLANKIE_OPERATOR_TOKEN: "fixture-owner",
        CLANKIE_CONTROL_PLANE_URL: f.host,
      },
      stdout: { write: (chunk: string) => ((cliOutput += chunk), true) },
    }),
  ).toBe(0);
  expect(AutoRoundsResponseSchema.parse(JSON.parse(cliOutput)).rounds).toEqual(proof);
  if (process.env.AUTO_DRIFT_PROOF_DIRECTORY) {
    await mkdir(process.env.AUTO_DRIFT_PROOF_DIRECTORY, { recursive: true });
    await writeFile(
      join(process.env.AUTO_DRIFT_PROOF_DIRECTORY, "isolated-runtime.json"),
      JSON.stringify(
        {
          method:
            "Isolated runtime: real captain, native-channel poll/ACK, HTTP, CLI, built-in tracker and origin; no model or deployed-project claim",
          detection: detection.content,
          unresolved: checkWake.content,
          followup: checked.content,
          cli: JSON.parse(cliOutput),
        },
        null,
        2,
      ) + "\n",
    );
  }
  console.info(
    "Isolated Auto drift correction runtime proof",
    JSON.stringify({ detection: detection.content, followup: checked.content, rounds: proof }),
  );
  await f.command({
    schemaVersion: 1,
    op: "autonomy",
    conversationId: "global-default",
    command: { action: "set_enabled", enabled: false },
  });
});
