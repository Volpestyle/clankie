import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
    read: NonNullable<Parameters<typeof createCaptain>[1]>["projectOutcomes"];
  },
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
    mcp: { catalog: unavailable, call: unavailable },
    email: { list: unavailable, read: unavailable, search: unavailable, send: unavailable },
    browser: { catalog: unavailable, call: unavailable },
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
  const captain = createCaptain(deps, {
    repoRoot: root,
    stateDir: state,
    workingDirectory: root,
    settings,
    ...(autoRounds ? { autoRoundIntervalMs: 100 } : {}),
    ...(outcomeProof ? { projectOutcomes: outcomeProof.read } : {}),
    ...(provider === undefined ? {} : { runtimeProvider: provider }),
  });
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
  return { captain, roomId, projectLead, command, request, journal, attach };
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
