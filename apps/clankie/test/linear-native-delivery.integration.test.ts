import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { OperatorSeatEventsPageSchema } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import { registerLinearRoutes } from "../src/app/linear-routes.ts";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { createConversationRunner } from "../src/captain/captain-conversation-runner.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { LaneLog } from "../src/captain/lane-log.ts";
import { seatEventKindFor } from "../src/captain/captain-session.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { TurnSettledLog } from "../src/captain/turn-metrics.ts";
import { LinearWriteReceipts } from "../src/linear-webhook.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Owned HTTP ingress, disk settings/journal, production runner, driver fence,
// native mailbox and wire schema. No live credentials, model or harness calls.
async function fixture(boundGraceMs = 20) {
  const root = mkdtempSync(join(tmpdir(), "linear-native-delivery-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const owner = { id: randomUUID(), email: "owner@example.com" };
  await settings.update((value) => ({
    ...value,
    linearWebhook: {
      ...value.linearWebhook,
      following: true,
      url: "https://fixture.example/v1/hooks/linear",
      wake: {
        ...value.linearWebhook.wake,
        ownerUserIds: [owner.id],
        ownerUserEmails: [owner.email],
      },
    },
  }));
  const own = { userId: randomUUID(), workspaceId: randomUUID() };
  const writes = new LinearWriteReceipts(join(root, "writes.json"));
  const secret = randomUUID();
  const bearer = randomUUID();
  const recipient = "a".repeat(64);
  let shutdown = new AbortController();
  const outbox = new SeatOutbox({ boundGraceMs, uncertaintyPath: join(root, "outbox.json") });
  const autonomy = new AutonomyStore(join(root, "autonomy.json"));
  let serviceStarts = 0;
  const forbiddenSession = async (): Promise<never> => {
    serviceStarts += 1;
    throw new Error("The native owner must not fall back to a model");
  };
  const runner = createConversationRunner({
    get shutdown() {
      return shutdown;
    },
    get conversations() {
      return store;
    },
    settings: () => settings.load(),
    options: { repoRoot: root, stateDir: root },
    workingDirectory: root,
    seatEventKind: (id, context, content) =>
      id === "global-default" && outbox.routesToSeat(content) ? seatEventKindFor(context, true) : undefined,
    seatOutbox: () => outbox,
    durableSession: forbiddenSession,
    buildSession: forbiddenSession,
    captureEvaluationStart: () => {},
    autonomy,
    syncModel: async () => {},
    laneLog: new LaneLog(join(root, "lanes")),
    censusFleets: async () => [],
    deps: {} as CaptainDeps,
    turnSettled: new TurnSettledLog(join(root, "metrics.jsonl")),
  });
  let store = new ConversationStore(join(root, "conversations"), runner);
  const configure = () => {
    store.linearFollowing = async () => (await settings.load()).linearWebhook.following;
    store.linearWakeRouting = async () => (await settings.load()).linearWebhook;
    store.linearWakeReceiverAvailable = (id) =>
      id === "global-default" && outbox.routesToSeat("Linear activity arrived.");
  };
  configure();
  store.rememberNativeHead("global-default", "original-claude-session");
  const app = new Hono();
  const issueLookups: string[] = [];
  let pollStarts = 0;
  registerLinearRoutes({
    app,
    dependencies: {
      captain: {
        receiveTrackerActivity: (event, following, target) =>
          store.receiveTrackerActivity(event, following, target),
        linearWakeTargetAllowed: (target) => store.linearWakeTargetAllowed(target),
        linearWakeDeliveries: () => store.linearWakeDeliveries(),
        linearWakeRecoveries: () => store.linearWakeRecoveries(),
      },
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === `Bearer ${bearer}`
          ? { operatorId: "owned-seat" }
          : undefined,
      linearWebhook: {
        secret: async () => secret,
        ownAccount: async () => own,
        writes,
        issueContext: async (activity) => {
          const response = await fetch(`${endpoint}/owned/issues/${activity.issueId}`);
          return response.ok ? response.json() : undefined;
        },
      },
    },
    settingsSource: settings,
    clock: () => new Date(),
  });
  app.get("/v1/seat/events", async (context) => {
    if (context.req.header("authorization") !== `Bearer ${bearer}`) return context.json({}, 401);
    const events = await store.pollConversationDriver(
      "global-default",
      () => {
        pollStarts += 1;
        return outbox.poll(Number(context.req.query("wait") ?? 0), context.req.raw.signal, recipient);
      },
      context.req.raw.signal,
      async () => {
        store.rememberNativeSource("global-default", {
          paneId: "owned:p1",
          terminalId: "owned-seat",
          agent: "claude",
          status: "idle",
          title: "Owned operator",
        });
      },
    );
    return context.json({ schemaVersion: 1, events });
  });
  app.post("/v1/seat/events/:id/ack", (context) => {
    if (context.req.header("authorization") !== `Bearer ${bearer}`) return context.json({}, 401);
    return context.json({ acknowledged: outbox.acknowledge(context.req.param("id"), recipient) });
  });
  app.get("/owned/issues/:id", (context) => {
    issueLookups.push(context.req.param("id"));
    return context.req.param("id") === issue.id ? context.json(issue) : context.json({}, 404);
  });
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing owned HTTP address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    shutdown.abort();
    outbox.close();
    await store.close();
    autonomy.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const issue = {
    id: randomUUID(),
    identifier: "VUH-1538",
    title: "Onboard a project by talking to Clankie",
  };
  const body = (type = "Comment", data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      action: "create",
      type,
      createdAt: new Date().toISOString(),
      webhookTimestamp: Date.now(),
      organizationId: own.workspaceId,
      actor: { ...owner, type: "user", name: "Owned operator" },
      url: "https://linear.app/fixture/issue/VUH-1538/onboard#comment-093e4ffb",
      data: { id: randomUUID(), issue, body: "Can Clankie choose sensible defaults?", ...data },
      ...extra,
    });
  const post = (raw: string, signature = createHmac("sha256", secret).update(raw).digest("hex")) =>
    fetch(`${endpoint}/v1/hooks/linear`, {
      method: "POST",
      body: raw,
      headers: { "linear-signature": signature, "linear-delivery": randomUUID() },
    });
  const events = () => new ConversationJournal(join(root, "conversations")).read("global-default");
  const poll = async (wait = 0) =>
    OperatorSeatEventsPageSchema.parse(
      await (
        await fetch(`${endpoint}/v1/seat/events?wait=${wait}`, {
          headers: { authorization: `Bearer ${bearer}` },
        })
      ).json(),
    ).events;
  const ack = async (id: string) =>
    (
      await fetch(`${endpoint}/v1/seat/events/${id}/ack`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
      })
    ).json();
  return {
    get store() {
      return store;
    },
    settings,
    outbox,
    own,
    writes,
    issue,
    body,
    post,
    events,
    deliveries: async () =>
      (
        await fetch(`${endpoint}/v1/linear/deliveries`, { headers: { authorization: `Bearer ${bearer}` } })
      ).json(),
    root,
    poll,
    pollStarts: () => pollStarts,
    ack,
    serviceStarts: () => serviceStarts,
    issueLookups,
    checkpoint: (conversationId = "global-default") => ({
      conversationId,
      meta: readFileSync(join(root, "conversations", conversationId, "meta.json"), "utf8"),
      journal: existsSync(join(root, "conversations", conversationId, "events.jsonl"))
        ? readFileSync(join(root, "conversations", conversationId, "events.jsonl"), "utf8")
        : "",
    }),
    shutdown: () => shutdown.abort(),
    restart: async (
      checkpoint?:
        | { conversationId?: string; meta: string; journal: string }
        | { conversationId?: string; meta: string; journal: string }[],
    ) => {
      await store.close();
      // An actual metadata snapshot captured before the uncertain settlement,
      // as retained when a process dies before its final metadata save.
      for (const saved of checkpoint ? (Array.isArray(checkpoint) ? checkpoint : [checkpoint]) : []) {
        const directory = join(root, "conversations", saved.conversationId ?? "global-default");
        writeFileSync(join(directory, "meta.json"), saved.meta, { mode: 0o600 });
        writeFileSync(join(directory, "events.jsonl"), saved.journal, {
          mode: 0o600,
        });
      }
      shutdown = new AbortController();
      store = new ConversationStore(join(root, "conversations"), runner);
      configure();
    },
  };
}

async function until(check: () => boolean, timeout = 6000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("Owned delivery did not settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it("recovers signed issue/update comments after an offline receiver returns, once and without Pi", async () => {
  const f = await fixture();
  const comment = f.body();
  expect((await f.post(comment, "bad")).status).toBe(401);
  expect(await (await f.post(comment)).json()).toMatchObject({ ingested: true });
  expect(
    await (
      await f.post(
        f.body("Comment", {
          issue: undefined,
          projectUpdateId: randomUUID(),
          body: "Next update needs gameplay video",
        }),
      )
    ).json(),
  ).toMatchObject({ ingested: true });
  await until(() => f.store.linearWakeRecoveries().some((recovery) => recovery.unavailable));
  expect(f.events().some((event) => event.type === "turn" && event.phase === "failed")).toBe(false);
  expect(f.serviceStarts()).toBe(0);
  const [wake] = await f.poll(4000);
  expect(wake?.kind).toBe("wake");
  expect(wake?.content).toContain("Can Clankie choose sensible defaults?");
  expect(wake?.content).toContain("Next update needs gameplay video");
  expect(wake?.content).toContain("VUH-1538");
  expect(wake?.content).toContain("#comment-093e4ffb");
  expect(await f.ack(wake!.id)).toMatchObject({ acknowledged: true });
  await until(() => f.events().some((event) => event.type === "turn" && event.phase === "completed"));
  expect(await (await f.post(comment)).json()).toMatchObject({ ingested: false });
  expect(await f.poll(30)).toEqual([]);
  expect(f.store.linearWakeTargetAllowed("global-default")).toBe(true);
  expect(
    await (await f.post(f.body("Comment", { body: "Still addresses the attached operator" }))).json(),
  ).toMatchObject({ ingested: true });
  const [next] = await f.poll(4000);
  expect(next?.content).toContain("Still addresses the attached operator");
  expect(next?.content).not.toContain("Next update needs gameplay video");
  await f.ack(next!.id);
  expect(f.serviceStarts()).toBe(0);
});

it.each([false, true])(
  "does not re-offer a taken wake after a late ACK and new comment (restart=%s)",
  async (restart) => {
    const f = await fixture(400);
    await f.post(f.body());
    const [wake] = await f.poll(4000);
    expect(wake?.kind).toBe("wake");
    const checkpoint = f.checkpoint();
    expect(JSON.parse(checkpoint.meta).linearWakeCheckpoint).toBeDefined();
    await until(() =>
      f.events().some((event) => event.type === "turn" && event.deliveryStage === "uncertain"),
    );
    expect(await f.poll(1800)).toEqual([]);
    expect(await f.ack(wake!.id)).toMatchObject({ acknowledged: true });
    if (restart) await f.restart(checkpoint);
    // A live native receiver keeps a poll parked while owner activity arrives.
    // Posting first left a 400 ms detach window under gate load, allowing a
    // legitimate service fallback instead of exercising late-ACK recovery.
    const previousPolls = f.pollStarts();
    const nextPoll = f.poll(4000);
    await until(() => f.pollStarts() > previousPolls);
    await f.post(f.body("Comment", { body: "Brand new owner comment after the late ACK" }));
    const [next] = await nextPoll;
    expect(next?.content).toContain("Brand new owner comment after the late ACK");
    expect(next?.content).not.toContain("Can Clankie choose sensible defaults?");
    await f.ack(next!.id);
    expect(f.serviceStarts()).toBe(0);
  },
);

it("suppresses deferred wakes when following turns off and keeps external history", async () => {
  const f = await fixture();
  await f.post(f.body());
  await until(() => f.store.linearWakeRecoveries().some((recovery) => recovery.unavailable));
  await f.settings.update((value) => ({
    ...value,
    linearWebhook: { ...value.linearWebhook, following: false },
  }));
  expect(await f.poll(1800)).toEqual([]);
  expect(f.events().filter((event) => event.type === "message" && event.linear)).toHaveLength(1);
  expect(f.serviceStarts()).toBe(0);
});

it("holds a missing receiver quietly across bursts and restarts, then delivers on its proven poll", async () => {
  const f = await fixture();
  for (let round = 0; round < 3; round += 1) {
    await f.post(f.body("Comment", { body: `Offline round ${round}` }));
    await until(() =>
      f.store.linearWakeRecoveries().some((recovery) => recovery.pendingEventIds.length === round + 1),
    );
    await f.restart();
  }
  // Drain the restored burst without a receiver: no accepted or failed turn.
  await f.store.close();
  expect(f.events().filter((event) => event.type === "turn")).toEqual([]);
  expect(
    f
      .events()
      .filter((event) => event.type === "message" && event.text.startsWith("Linear receiver unavailable:")),
  ).toHaveLength(1);
  await f.restart();
  const [wake] = await f.poll(4000);
  for (let round = 0; round < 3; round += 1) expect(wake?.content).toContain(`Offline round ${round}`);
  await f.ack(wake!.id);
  await until(() => f.events().some((event) => event.type === "turn" && event.phase === "completed"));
  expect(f.serviceStarts()).toBe(0);
});

it.each([false, true])(
  "recovers a dead KH2 lead backlog to the current lead without silent loss (destination already retained=%s)",
  async (alreadyRetained) => {
    const f = await fixture();
    const old = f.store.createRemoteWorkspaceConversation({
      title: "KH2 lead",
      workspaceId: "C:\\repos\\kh2-multiplayer",
      machineId: "pc",
    });
    f.store.rememberNativeHead(old.conversationId, "exited-native-session");
    const project = { id: randomUUID(), name: "KH2 Multiplayer" };
    await f.settings.update((value) => ({
      ...value,
      linearWebhook: {
        ...value.linearWebhook,
        projectChats: [{ projectId: project.id, name: project.name, conversationId: old.conversationId }],
      },
    }));
    const before = f.checkpoint();
    await f.post(f.body("Comment", { issue: { ...f.issue, project }, body: "Retained KH2 owner comment" }));
    const backlog = f.checkpoint(old.conversationId);
    backlog.meta = JSON.stringify({ ...JSON.parse(backlog.meta), updatedAt: new Date(0).toISOString() });
    // This retained ingress checkpoint is the old service's unread backlog.
    // In the second case destination-first recovery already persisted its copy
    // before a crash lost the source-side resolution.
    if (!alreadyRetained)
      await f.settings.update((value) => ({
        ...value,
        linearWebhook: { ...value.linearWebhook, projectChats: [] },
      }));
    await f.restart(alreadyRetained ? backlog : [before, backlog]);
    const [wake] = await f.poll(4000);
    expect(wake?.content).toContain("Retained KH2 owner comment");
    await f.ack(wake!.id);
    const received = await f.store.receiveLinearWake("global-default", wake!.id, async (original) =>
      f.outbox.confirmReceived(original),
    );
    expect(received.receivedAt).toBeDefined();
    await until(() =>
      f.store
        .linearWakeRecoveries()
        .some(
          (recovery) =>
            recovery.conversationId === old.conversationId && Object.keys(recovery.resolutions).length === 1,
        ),
    );
    const report = await f.deliveries();
    const recovery = (report.recoveries as ReturnType<ConversationStore["linearWakeRecoveries"]>).find(
      (entry) => entry.conversationId === old.conversationId,
    )!;
    expect(recovery.pendingEventIds).toEqual([]);
    expect(Object.values(recovery.resolutions)).toMatchObject([
      { conversationId: "global-default", state: alreadyRetained ? "already_handled" : "rerouted" },
    ]);
    const receipt = f.store.linearWakeDeliveries().find((entry) => entry.wakeId === wake!.id)!;
    expect(receipt.events).toMatchObject([{ project, route: "project_fallback" }]);
    expect(receipt.receivedAt).toBeDefined();
    expect(f.store.conversation(old.conversationId)?.title).toBe("KH2 lead (inactive)");
    for (let round = 0; round < 3; round += 1) await f.restart();
    expect(
      new ConversationJournal(join(f.root, "conversations"))
        .read(old.conversationId)
        .some((event) => event.type === "turn" && event.phase === "failed"),
    ).toBe(false);
    expect(f.events().filter((event) => event.type === "message" && event.linear)).toHaveLength(1);
    expect(await f.poll(30)).toEqual([]);
    expect(f.serviceStarts()).toBe(0);
  },
);

it.each(["shutdown", "cancel"] as const)(
  "does not re-offer a native take after %s, late ACK and reload",
  async (mode) => {
    const f = await fixture(400);
    await f.post(f.body());
    const [original] = await f.poll(4000);
    const runId = JSON.parse(f.checkpoint().meta).linearWakeCheckpoint.runId;
    expect(original?.content).toContain("Can Clankie choose sensible defaults?");
    if (mode === "shutdown") f.shutdown();
    else expect(f.store.cancel("global-default", runId)).toBe(true);
    await until(() =>
      f
        .events()
        .some(
          (event) =>
            event.type === "turn" && event.runId === runId && ["failed", "cancelled"].includes(event.phase),
        ),
    );
    expect(await f.ack(original!.id)).toMatchObject({ acknowledged: true });
    await f.restart();
    await f.post(f.body("Comment", { body: "Fresh comment after shutdown or cancellation" }));
    const [fresh] = await f.poll(4000);
    expect(fresh?.content).toContain("Fresh comment after shutdown or cancellation");
    expect(fresh?.content).not.toContain("Can Clankie choose sensible defaults?");
    await f.ack(fresh!.id);
    expect(f.serviceStarts()).toBe(0);
  },
);

it("maps signed assignments, delegation and comment reactions using the connected app identity", async () => {
  const f = await fixture();
  await f.post(
    f.body(
      "Issue",
      { ...f.issue, assigneeId: f.own.userId },
      { action: "update", updatedFrom: { assigneeId: null, stateId: "old" } },
    ),
  );
  await f.post(
    f.body(
      "Issue",
      { ...f.issue, delegateId: f.own.userId },
      { action: "update", updatedFrom: { delegateId: null } },
    ),
  );
  const reactionCommentId = randomUUID();
  await f.post(
    f.body("Reaction", {
      // Linear's CommentChildWebhookPayload can carry the only issue UUID.
      // Do not inherit the fixture's outer Issue display context.
      issue: undefined,
      emoji: "eyes",
      commentId: reactionCommentId,
      comment: { id: reactionCommentId, body: "Clankie result", userId: f.own.userId, issueId: f.issue.id },
    }),
  );
  const ownCommentId = randomUUID();
  const now = new Date();
  f.writes.record(
    {
      server: "linear",
      tool: "save_comment",
      content: JSON.stringify({
        id: ownCommentId,
        body: "Recorded Clankie comment",
        updatedAt: now.toISOString(),
      }),
      isError: false,
      account: {
        provider: "linear",
        ...f.own,
        connectionId: randomUUID(),
        verifiedAt: now.toISOString(),
        name: "Owned Clankie app",
        workspaceName: "Owned workspace",
      },
    },
    now,
  );
  await f.post(f.body("Reaction", { emoji: "thumbsup", commentId: ownCommentId }));
  await f.post(
    f.body(
      "Issue",
      { ...f.issue, title: "Someone else's assignment", assigneeId: randomUUID() },
      { action: "update", updatedFrom: { assigneeId: null } },
    ),
  );
  await f.post(
    f.body("Reaction", {
      emoji: "heart",
      commentId: ownCommentId,
      comment: { body: "Someone else's comment", userId: randomUUID() },
    }),
  );
  const [wake] = await f.poll(4000);
  expect(wake?.content).toContain("4 new events");
  expect(wake?.content).toContain("delegateId");
  expect(wake?.content).toContain("eyes");
  expect(wake?.content).toContain("thumbsup");
  const reaction = f
    .events()
    .find(
      (event) =>
        event.type === "message" && event.role === "external" && event.text.includes('"reaction":"eyes"'),
    );
  expect(reaction).toMatchObject({ text: expect.stringContaining(f.issue.id) });
  expect(reaction).toMatchObject({ text: expect.stringContaining(f.issue.identifier) });
  expect(reaction).toMatchObject({ text: expect.stringContaining(f.issue.title) });
  expect(f.issueLookups).toContain(f.issue.id);
  expect(wake?.content).not.toContain("Someone else's");
  await f.ack(wake!.id);
});

it("does not enrich a reaction whose signed parent UUIDs disagree", async () => {
  const f = await fixture();
  const commentId = randomUUID();
  await f.post(
    f.body("Reaction", {
      issue: undefined,
      issueId: f.issue.id,
      commentId,
      emoji: "eyes",
      comment: { id: commentId, userId: f.own.userId, issueId: randomUUID(), body: "Conflicting parents" },
    }),
  );
  const [wake] = await f.poll(4000);
  expect(wake?.content).toContain("Conflicting parents");
  expect(wake?.content).not.toContain('"issueId":');
  expect(f.issueLookups).toEqual([]);
  await f.ack(wake!.id);
});
