import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
async function fixture() {
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
  const shutdown = new AbortController();
  const outbox = new SeatOutbox({ boundGraceMs: 20, uncertaintyPath: join(root, "outbox.json") });
  const autonomy = new AutonomyStore(join(root, "autonomy.json"));
  let serviceStarts = 0;
  const forbiddenSession = async (): Promise<never> => {
    serviceStarts += 1;
    throw new Error("The native owner must not fall back to a model");
  };
  const runner = createConversationRunner({
    shutdown,
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
  const store = new ConversationStore(join(root, "conversations"), runner);
  store.rememberNativeHead("global-default", "original-claude-session");
  const app = new Hono();
  registerLinearRoutes({
    app,
    dependencies: {
      captain: {
        receiveLinearActivity: (event, following, target) =>
          store.receiveLinearActivity(event, following, target),
        linearWakeTargetAllowed: (target) => store.linearWakeTargetAllowed(target),
      },
      linearWebhook: { secret: async () => secret, ownAccount: async () => own, writes },
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
    store,
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

it("does not replay a taken wake whose native acknowledgment was lost", async () => {
  const f = await fixture();
  await f.post(f.body());
  const [wake] = await f.poll(4000);
  expect(wake?.kind).toBe("wake");
  await until(() => f.events().some((event) => event.type === "turn" && event.deliveryStage === "uncertain"));
  expect(await f.poll(1800)).toEqual([]);
  expect(await f.ack(wake!.id)).toMatchObject({ acknowledged: true });
  expect(f.serviceStarts()).toBe(0);
});

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
  await f.post(
    f.body("Reaction", {
      emoji: "eyes",
      commentId: randomUUID(),
      comment: { body: "Clankie result", userId: f.own.userId },
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
  expect(wake?.content).not.toContain("Someone else's");
  await f.ack(wake!.id);
});
