import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  await settings.update((value) => ({
    ...value,
    linearWebhook: {
      ...value.linearWebhook,
      following: true,
      url: "https://fixture.example/v1/hooks/linear",
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
    seatEventKind: (_id, context) =>
      outbox.bound() || outbox.uncertain() ? seatEventKindFor(context, true) : undefined,
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
    goalExecutionReason: () => undefined,
    refuseNativeGoal: () => false,
  });
  let store = new ConversationStore(join(root, "conversations"), runner);
  store.rememberNativeHead("global-default", "original-claude-session");
  const app = new Hono();
  const issueLookups: string[] = [];
  registerLinearRoutes({
    app,
    dependencies: {
      captain: {
        receiveLinearActivity: (event, following, target) =>
          store.receiveLinearActivity(event, following, target),
        linearWakeTargetAllowed: (target) => store.linearWakeTargetAllowed(target),
      },
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
      () => outbox.poll(Number(context.req.query("wait") ?? 0), context.req.raw.signal, recipient),
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
      actor: { id: randomUUID(), type: "user", name: "James Volpe", email: "volpestyle@gmail.com" },
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
    poll,
    ack,
    serviceStarts: () => serviceStarts,
    issueLookups,
    checkpoint: () => ({
      meta: readFileSync(join(root, "conversations/global-default/meta.json"), "utf8"),
      journal: readFileSync(join(root, "conversations/global-default/events.jsonl"), "utf8"),
    }),
    shutdown: () => shutdown.abort(),
    restart: async (checkpoint?: { meta: string; journal: string }) => {
      await store.close();
      // An actual metadata snapshot captured before the uncertain settlement,
      // as retained when a process dies before its final metadata save.
      if (checkpoint) {
        writeFileSync(join(root, "conversations/global-default/meta.json"), checkpoint.meta, { mode: 0o600 });
        writeFileSync(join(root, "conversations/global-default/events.jsonl"), checkpoint.journal, {
          mode: 0o600,
        });
      }
      shutdown = new AbortController();
      store = new ConversationStore(join(root, "conversations"), runner);
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
  await until(() => f.events().some((event) => event.type === "turn" && event.phase === "failed"));
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
    await f.post(f.body("Comment", { body: "Brand new owner comment after the late ACK" }));
    const [next] = await f.poll(4000);
    expect(next?.content).toContain("Brand new owner comment after the late ACK");
    expect(next?.content).not.toContain("Can Clankie choose sensible defaults?");
    await f.ack(next!.id);
    expect(f.serviceStarts()).toBe(0);
  },
);

it("suppresses deferred wakes when following turns off and keeps external history", async () => {
  const f = await fixture();
  await f.post(f.body());
  await until(() => f.events().some((event) => event.type === "turn" && event.phase === "failed"));
  await f.settings.update((value) => ({
    ...value,
    linearWebhook: { ...value.linearWebhook, following: false },
  }));
  expect(await f.poll(1800)).toEqual([]);
  expect(f.events().filter((event) => event.type === "message" && event.role === "external")).toHaveLength(1);
  expect(f.serviceStarts()).toBe(0);
});

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
