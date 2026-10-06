import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { OperatorSeatEventsPageSchema } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { createConversationRunner } from "../src/captain/captain-conversation-runner.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { LaneLog } from "../src/captain/lane-log.ts";
import { createStubCaptain, type LaneTool } from "../src/captain/port.ts";
import { seatEventKindFor } from "../src/captain/captain-session.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { linearWakeTools } from "../src/captain/tools.ts";
import { TurnSettledLog } from "../src/captain/turn-metrics.ts";
import { LinearAttributionJournal } from "../src/linear-attribution.ts";
import { LinearWakeReadReceipts } from "../src/linear-wake-read.ts";
import { LinearRequestBudget } from "../src/linear-request-budget.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { runLinearCommand } from "../../tui/src/command/linear.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(app: Awaited<ReturnType<typeof createClankieApp>>) {
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.app.fetch }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No owned HTTP address");
  cleanups.push(async () => {
    app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

/** Owned signed ingress → production runner/store/outbox → authenticated seat wire → real SDK tool
 * → stateful provider MCP, with persistent original/read receipts. No model or live account calls. */
async function fixture(options: { oldBudgetWindow?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "linear-wake-receipts-"));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((value) => ({
    ...value,
    linearWebhook: {
      ...value.linearWebhook,
      following: true,
      url: "https://fixture.example/v1/hooks/linear",
      wake: { ...value.linearWebhook.wake, ownerUserEmails: ["volpestyle@gmail.com"] },
    },
  }));
  const account = {
    provider: "linear" as const,
    userId: randomUUID(),
    workspaceId: randomUUID(),
    connectionId: randomUUID(),
    name: "Owned app",
    workspaceName: "Owned workspace",
    verifiedAt: new Date().toISOString(),
  };
  const token = randomUUID();
  const credential = { type: "api" as const, key: token, account };
  let budgetTime = options.oldBudgetWindow ? Date.now() - 3_540_000 : undefined;
  const clock = () => budgetTime ?? Date.now();
  const budget = new LinearRequestBudget({ clock });
  cleanups.push(async () => budget.close());
  const secret = randomUUID();
  const project = { id: randomUUID(), name: "KH2" };
  const update = { id: randomUUID(), project };
  const issue = { id: randomUUID(), identifier: "VUH-1538", title: "Owned issue", project };
  type Notification = { id: string; type: string; url: string; createdAt: string; readAt: string | null };
  const notifications: Notification[] = [];
  const marks: string[] = [];
  const reads: Record<string, unknown>[] = [];
  let failedAfterWrite = false;
  let failedWithoutWrite = false;
  let exhaustAfterInbox = false;
  const tools: LaneTool[] = [
    {
      name: "get_issue",
      description: "Read an owned signed issue",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      call: async () => ({ content: [{ type: "text", text: JSON.stringify(issue) }] }),
    },
    {
      name: "get_status_updates",
      description: "Read an owned signed update",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, type: { type: "string" } },
        required: ["type"],
      },
      call: async () => ({ content: [{ type: "text", text: JSON.stringify(update) }] }),
    },
    {
      name: "get_project",
      description: "Read an owned signed project",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      call: async () => ({ content: [{ type: "text", text: JSON.stringify(project) }] }),
    },
    {
      name: "get_notifications",
      description: "Read durable owned inbox state",
      inputSchema: {
        type: "object",
        properties: {
          cursor: { type: "string" },
          limit: { type: "number" },
          unreadOnly: { type: "boolean" },
        },
      },
      call: async (args) => {
        reads.push(args);
        if (exhaustAfterInbox) {
          exhaustAfterInbox = false;
          await budget.fetch(credential, fetch, `${providerUrl}/owned-budget/exhaust`);
        }
        return { content: [{ type: "text", text: JSON.stringify({ notifications, hasNextPage: false }) }] };
      },
    },
    {
      name: "mark_notification",
      description: "Persist an owned read mutation",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, read: { type: "boolean" } },
        required: ["id"],
      },
      call: async (args) => {
        marks.push(String(args.id));
        if (failedWithoutWrite) {
          failedWithoutWrite = false;
          throw new Error("Owned provider read mutation outcome unavailable");
        }
        const notification = notifications.find((item) => item.id === args.id)!;
        notification.readAt = new Date().toISOString();
        if (failedAfterWrite) {
          failedAfterWrite = false;
          throw new Error("Owned provider failed after persisting read");
        }
        return { content: [{ type: "text", text: JSON.stringify(notification) }] };
      },
    },
  ];
  const provider = await createClankieApp({
    captain: createStubCaptain({ laneToolBank: async (lane) => ({ lane, tools }) }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${token}`
        ? { operatorId: "owned-provider" }
        : undefined,
  });
  provider.app.get(
    "/owned-budget/exhaust",
    () =>
      new Response("exhausted", {
        headers: {
          "x-ratelimit-requests-limit": "5000",
          "x-ratelimit-requests-remaining": "0",
          "x-ratelimit-requests-reset": String(clock() + 30_000),
        },
      }),
  );
  const providerUrl = await listen(provider);
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await credentials.set("linear", credential);
  const host = createMcpHost({
    credentials,
    settings,
    linearRequestBudget: budget,
    curated: [
      {
        id: "linear",
        transport: "http",
        url: `${providerUrl}/v1/mcp`,
        credential: "linear",
        lane: "operator",
        args: [],
        enabled: true,
        initialTools: tools.map((tool) => tool.name),
      },
    ],
    logger: { info() {}, warn() {} },
  });
  cleanups.push(() => host.close());
  const attribution = new LinearAttributionJournal(join(root, "attribution.json"));
  const own = async () => (await host.account("linear", "operator")).account;
  const readOptions = {
    path: join(root, "read.json"),
    host,
    attribution,
    ownAccount: own,
    retryMs: 30_000,
    clock,
  };
  let reader = new LinearWakeReadReceipts(readOptions);
  const recipients = new Map<string, string>();
  const outboxes = new Map<string, SeatOutbox>();
  const outbox = (id: string) => {
    let box = outboxes.get(id);
    if (!box) {
      box = new SeatOutbox({ boundGraceMs: 2_000, uncertaintyPath: join(root, `${id}-outbox.json`) });
      outboxes.set(id, box);
    }
    return box;
  };
  let shutdown = new AbortController();
  const autonomy = new AutonomyStore(join(root, "autonomy.json"));
  let serviceStarts = 0;
  const forbidden = async (): Promise<never> => {
    serviceStarts += 1;
    throw new Error("Native wake cannot fall back to Pi");
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
    seatEventKind: (id, context) =>
      outbox(id).bound() || outbox(id).uncertain() ? seatEventKindFor(context, true) : undefined,
    seatOutbox: outbox,
    durableSession: forbidden,
    buildSession: forbidden,
    captureEvaluationStart: () => {},
    autonomy,
    syncModel: async () => {},
    laneLog: new LaneLog(join(root, "lanes")),
    censusFleets: async () => [],
    deps: {} as CaptainDeps,
    turnSettled: new TurnSettledLog(join(root, "turns.jsonl")),
    goalExecutionReason: () => undefined,
    refuseNativeGoal: () => false,
  });
  let store = new ConversationStore(join(root, "conversations"), runner);
  store.onLinearWakeReceived = (references) => reader.received(references);
  const created = await store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "global" },
    title: "KH2 lead",
  });
  if (created.op !== "create") throw new Error("Lead chat missing");
  const leadId = created.conversation.conversationId;
  for (const id of [leadId, "global-default"]) {
    recipients.set(id, (id === leadId ? "b" : "a").repeat(64));
    store.rememberNativeHead(id, `owned-native-${id}`);
  }
  const received = (id: string, wakeId: string) =>
    store.receiveLinearWake(
      id,
      wakeId,
      async (original) =>
        original.recipientBinding === recipients.get(id) && outbox(id).confirmReceived(original),
    );
  const service = await createClankieApp({
    settings,
    captain: createStubCaptain({
      receiveLinearActivity: (event, following, target) =>
        store.receiveLinearActivity(event, following, target),
      linearWakeTargetAllowed: (id) => store.linearWakeTargetAllowed(id),
      linearWakeDeliveries: () => store.linearWakeDeliveries(),
      pollSeatEvents: (wait, signal, id = "global-default") =>
        store.pollConversationDriver(
          id,
          () => outbox(id).poll(wait, signal, recipients.get(id)),
          signal,
          async () =>
            store.rememberNativeSource(id, {
              paneId: `owned:${id}`,
              terminalId: `owned-${id}`,
              agent: "claude",
              status: "idle",
              title: "Owned operator",
            }),
        ),
      acknowledgeSeatEvent: async (eventId, id = "global-default") =>
        outbox(id).acknowledge(eventId, recipients.get(id)),
      laneToolBank: async (lane, conversationId) => {
        const id = conversationId ?? "global-default";
        return {
          lane,
          tools: linearWakeTools(
            { settings, targetAllowed: (target) => store.linearWakeTargetAllowed(target), received },
            {
              conversationAuthority: {
                owner: { conversationId: id },
                current: () => true,
                authorize: async () => true,
              },
            },
          ).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters as Record<string, unknown>,
            call: (args) =>
              tool.execute("owned-native-tool", args as never, undefined, undefined, {} as never),
          })),
        };
      },
    }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${token}` ? { operatorId: "owned-seat" } : undefined,
    linearWebhook: {
      secret: async () => secret,
      ownAccount: own,
      recordActivity: (activity) => attribution.record(activity),
      issueContext: (activity) => attribution.issueContext(activity, host),
      projectContext: (activity) => attribution.projectContext(activity, host),
    },
  });
  const url = await listen(service);
  const clients = new Map<string, Client>();
  const confirm = async (id: string, wakeId: string) => {
    let client = clients.get(id);
    if (!client) {
      client = new Client({ name: "owned-target-seat", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/v1/mcp?conversationId=${id}`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }) as Transport,
      );
      clients.set(id, client);
    }
    return client.callTool({ name: "linear_wake", arguments: { action: "received", wakeId } });
  };
  cleanups.push(async () => {
    reader.close();
    shutdown.abort();
    for (const box of outboxes.values()) box.close();
    await store.close();
    autonomy.close();
    for (const client of clients.values()) await client.close();
  });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const configure = (projectChats: unknown) =>
    fetch(`${url}/v1/linear/routes`, { method: "PUT", headers, body: JSON.stringify({ projectChats }) });
  const poll = async (id = "global-default", wait = 0) =>
    OperatorSeatEventsPageSchema.parse(
      await (await fetch(`${url}/v1/seat/events?conversationId=${id}&wait=${wait}`, { headers })).json(),
    ).events;
  const ack = (id: string, eventId: string) =>
    fetch(`${url}/v1/seat/events/${eventId}/ack?conversationId=${id}`, { method: "POST", headers });
  const event = (data: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) => {
    const commentId = randomUUID();
    const createdAt = new Date().toISOString();
    const body = {
      type: "Comment",
      action: "create",
      createdAt,
      webhookTimestamp: Date.now(),
      organizationId: account.workspaceId,
      actor: { id: randomUUID(), email: "volpestyle@gmail.com", type: "user", name: "James" },
      url: `https://linear.app/fixture/issue/VUH-1538/owned#comment-${commentId}`,
      data: { id: commentId, issueId: issue.id, body: "Inspect this", ...data },
      ...envelope,
    };
    return {
      raw: JSON.stringify(body),
      notification: {
        id: randomUUID(),
        type: "issueNewComment",
        createdAt,
        url: body.url,
        readAt: null,
      } as Notification,
    };
  };
  const post = (raw: string) =>
    fetch(`${url}/v1/hooks/linear`, {
      method: "POST",
      body: raw,
      headers: {
        "linear-signature": createHmac("sha256", secret).update(raw).digest("hex"),
        "linear-delivery": randomUUID(),
      },
    });
  return {
    root,
    settings,
    account,
    project,
    update,
    issue,
    leadId,
    store: () => store,
    reader: () => reader,
    configure,
    poll,
    ack,
    confirm,
    event,
    post,
    notifications,
    marks,
    reads,
    budget,
    clock,
    useCurrentBudgetTime: () => {
      budgetTime = undefined;
    },
    advanceBudgetTime: (at: number) => {
      budgetTime = at;
    },
    exhaustReadBudget: () => {
      exhaustAfterInbox = true;
    },
    mark: (id: string) =>
      host.call({
        lane: "operator",
        server: "linear",
        tool: "mark_notification",
        arguments: { id, read: true },
      }),
    events: (id: string) => new ConversationJournal(join(root, "conversations")).read(id),
    deliveries: async () => (await fetch(`${url}/v1/linear/deliveries`, { headers })).json(),
    serviceStarts: () => serviceStarts,
    changeRecipient: (id: string) => recipients.set(id, "c".repeat(64)),
    failReadAfterWrite: () => {
      failedAfterWrite = true;
    },
    failWithoutWrite: () => {
      failedWithoutWrite = true;
    },
    cli: (args: string[], body = "") =>
      runLinearCommand(args, {
        settings,
        env: { CLANKIE_OPERATOR_TOKEN: token, CLANKIE_CONTROL_PLANE_URL: url },
        stdin: Readable.from([body]),
      }),
    stop: () => shutdown.abort(),
    reload: async () => {
      reader.close();
      reader = new LinearWakeReadReceipts(readOptions);
      shutdown.abort();
      for (const box of outboxes.values()) box.close();
      await store.close();
      outboxes.clear();
      shutdown = new AbortController();
      store = new ConversationStore(join(root, "conversations"), runner);
      store.onLinearWakeReceived = (references) => reader.received(references);
    },
  };
}

async function wake(f: Awaited<ReturnType<typeof fixture>>, id: string, raw: string) {
  expect((await f.post(raw)).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  const events = await f.poll(id, 3_000);
  expect(events).toHaveLength(1);
  return events[0]!;
}

it("routes sparse signed issue/update comments to the configured lead and confirms read only from that target seat", async () => {
  const f = await fixture();
  expect(
    (await f.configure([{ projectId: f.project.id, name: "KH2", conversationId: "missing" }])).status,
  ).toBe(409);
  expect(
    await f.cli(
      ["routes", "set", "--json-stdin"],
      JSON.stringify([{ projectId: f.project.id, name: "KH2", conversationId: f.leadId }]),
    ),
  ).toMatchObject({ projectChats: [{ conversationId: f.leadId }] });
  expect(await f.cli(["routes", "show"])).toMatchObject({ projectChats: [{ conversationId: f.leadId }] });
  const e = f.event();
  f.notifications.push(e.notification);
  const channel = await wake(f, f.leadId, e.raw);
  expect(channel.conversationId).toBe(f.leadId);
  expect(channel.content).toContain("KH2");
  expect(
    f.events("global-default").filter((event) => event.type === "message" && event.role === "external"),
  ).toHaveLength(0);
  expect(f.marks).toEqual([]);
  await f.ack(f.leadId, channel.id);
  expect(f.notifications[0]!.readAt).toBeNull();
  await expect(f.confirm("global-default", channel.id)).rejects.toThrow("Unknown Linear wake");
  expect(f.marks).toEqual([]);
  expect((await f.confirm(f.leadId, channel.id)).isError).not.toBe(true);
  expect(f.marks).toEqual([e.notification.id]);
  await f.reader().reconcile();
  expect(f.reader().report()).toMatchObject({ receipts: [{ notifications: [{ state: "read" }] }] });
  expect(await f.deliveries()).toMatchObject({
    deliveries: expect.arrayContaining([
      expect.objectContaining({ conversationId: f.leadId, receivedAt: expect.any(String) }),
    ]),
  });
  expect(await f.cli(["deliveries"])).toMatchObject({ deliveries: expect.any(Array) });
  const comment = f.event(
    { issueId: undefined, projectUpdateId: f.update.id },
    {
      url: `https://linear.app/fixture/project/kh2/updates#project-update-${f.update.id.slice(0, 8)}&comment-093e4ffb`,
    },
  );
  const updateWake = await wake(f, f.leadId, comment.raw);
  expect(updateWake.content).toContain("KH2");
  await f.ack(f.leadId, updateWake.id);
  expect(f.serviceStarts()).toBe(0);
});

it("falls back to global-default with the project named and records the destination across reload", async () => {
  const f = await fixture();
  const e = f.event();
  const channel = await wake(f, "global-default", e.raw);
  expect(channel.content).toContain('"name":"KH2"');
  await f.ack("global-default", channel.id);
  await f.reload();
  const external = f
    .events("global-default")
    .find((event) => event.type === "message" && event.role === "external");
  expect(external).toMatchObject({
    linear: { conversationId: "global-default", project: f.project, route: "project_fallback" },
  });
  expect(await f.poll()).toEqual([]);
  expect(f.marks).toEqual([]);
});

it("retains receipt-before-inbox and settles a failed response by read-only observation without repeating the mutation", async () => {
  const f = await fixture();
  const e = f.event();
  const channel = await wake(f, "global-default", e.raw);
  expect((await f.confirm("global-default", channel.id)).isError).not.toBe(true);
  expect(f.marks).toEqual([]);
  // Observed KH2 behavior: notification creation may lag the signed webhook by eighteen seconds.
  e.notification.createdAt = new Date(Date.parse(e.notification.createdAt) + 18_000).toISOString();
  f.notifications.push(e.notification);
  f.failReadAfterWrite();
  await f.reader().reconcile();
  expect(f.marks).toEqual([e.notification.id]);
  expect(JSON.parse(readFileSync(join(f.root, "read.json"), "utf8")).claims[e.notification.id].state).toBe(
    "uncertain",
  );
  await f.reload();
  await f.reader().reconcile();
  expect(f.reader().report()).toMatchObject({
    receipts: [{ notifications: [{ id: e.notification.id, state: "read" }] }],
  });
  expect(f.marks).toEqual([e.notification.id]);
  expect(await f.poll()).toEqual([]);
});

it("refuses a changed native recipient and leaves unrelated notifications unread", async () => {
  const f = await fixture();
  const e = f.event();
  f.notifications.push(e.notification);
  const channel = await wake(f, "global-default", e.raw);
  f.changeRecipient("global-default");
  await expect(f.confirm("global-default", channel.id)).rejects.toThrow("recipient or receipt");
  expect(f.marks).toEqual([]);
  const orphan = f.event();
  f.notifications.push(orphan.notification);
  await f.reader().reconcile();
  expect(f.notifications.every((item) => item.readAt === null)).toBe(true);
});

it("settles the exact consumed original after shutdown/reload, then delivers only the fresh comment", async () => {
  const f = await fixture();
  const first = f.event();
  f.notifications.push(first.notification);
  const original = await wake(f, "global-default", first.raw);
  f.stop();
  await f.reload();
  expect(await f.poll()).toEqual([]);
  expect(f.marks).toEqual([]);
  expect((await f.confirm("global-default", original.id)).isError).not.toBe(true);
  expect(f.marks).toEqual([first.notification.id]);
  const next = f.event();
  f.notifications.push(next.notification);
  const fresh = await wake(f, "global-default", next.raw);
  expect(fresh.id).not.toBe(original.id);
  expect(fresh.content).not.toContain(first.notification.url);
  expect(fresh.content).toContain(next.notification.url);
  expect((await f.confirm("global-default", fresh.id)).isError).not.toBe(true);
  await f.reload();
  await f.reader().reconcile();
  expect(await f.poll()).toEqual([]);
  expect(f.marks).toEqual([first.notification.id, next.notification.id]);
});

it("holds an uncertain read mutation across reload even when the notification stays unread", async () => {
  const f = await fixture();
  const e = f.event();
  f.notifications.push(e.notification);
  const original = await wake(f, "global-default", e.raw);
  f.failWithoutWrite();
  expect((await f.confirm("global-default", original.id)).isError).not.toBe(true);
  expect(f.marks).toEqual([e.notification.id]);
  expect(e.notification.readAt).toBeNull();
  await f.reload();
  await f.reader().reconcile();
  expect((await f.confirm("global-default", original.id)).isError).not.toBe(true);
  expect(f.marks).toEqual([e.notification.id]);
  expect(f.reader().report()).toMatchObject({ receipts: [{ notifications: [{ state: "uncertain" }] }] });
});

it("retries a definitely unsent budget refusal without clearing another uncertain original", async () => {
  const f = await fixture({ oldBudgetWindow: true });
  const uncertain = f.event();
  f.notifications.push(uncertain.notification);
  const original = await wake(f, "global-default", uncertain.raw);
  f.useCurrentBudgetTime();
  f.failWithoutWrite();
  expect((await f.confirm("global-default", original.id)).isError).not.toBe(true);
  const before = JSON.parse(readFileSync(join(f.root, "read.json"), "utf8"));
  expect(before.claims[uncertain.notification.id]).toMatchObject({
    state: "uncertain",
    receiver: { userId: f.account.userId, workspaceId: f.account.workspaceId },
  });

  const pending = f.event();
  f.notifications.push(pending.notification);
  const target = await wake(f, "global-default", pending.raw);
  f.exhaustReadBudget();
  expect((await f.confirm("global-default", target.id)).isError).not.toBe(true);
  expect(f.marks).toEqual([uncertain.notification.id]);
  expect(pending.notification.readAt).toBeNull();
  const refused = await f.mark(pending.notification.id);
  expect(refused).toMatchObject({
    outcome: "refused",
    reason: "linear_request_budget",
    possiblyDispatched: false,
  });
  if (refused.outcome !== "refused" || refused.retryAt === undefined)
    throw new Error("The real MCP budget must provide its exact refusal deadline");
  expect(refused.retryAt).toBeGreaterThan(f.clock());
  expect(refused.retryAt).toBeLessThan(f.clock() + 600_000);
  const deferred = JSON.parse(readFileSync(join(f.root, "read.json"), "utf8"));
  expect(deferred.claims[pending.notification.id]).toBeUndefined();
  expect(deferred.claims[uncertain.notification.id]).toEqual(before.claims[uncertain.notification.id]);

  const inboxReads = f.reads.length;
  await f.reader().reconcile();
  expect(f.reads).toHaveLength(inboxReads);
  f.advanceBudgetTime(refused.retryAt);
  await f.reader().reconcile();
  expect(f.marks).toEqual([uncertain.notification.id, pending.notification.id]);
  expect(pending.notification.readAt).not.toBeNull();
  await f.reload();
  await f.reader().reconcile();
  expect(f.marks).toEqual([uncertain.notification.id, pending.notification.id]);
  const settled = JSON.parse(readFileSync(join(f.root, "read.json"), "utf8"));
  expect(settled.claims[uncertain.notification.id]).toEqual({
    ...before.claims[uncertain.notification.id],
    receiver: { userId: f.account.userId, workspaceId: f.account.workspaceId },
  });
  expect(settled.claims[pending.notification.id]).toMatchObject({ state: "read" });
});

it("does not create a new read mutation after the consumed wake retry window expires", async () => {
  const f = await fixture();
  const e = f.event();
  const original = await wake(f, "global-default", e.raw);
  expect((await f.confirm("global-default", original.id)).isError).not.toBe(true);
  const state = JSON.parse(readFileSync(join(f.root, "read.json"), "utf8"));
  const received = Object.values(state.received) as { retryUntil: number }[];
  expect(received).toHaveLength(1);
  f.notifications.push(e.notification);
  f.advanceBudgetTime(received[0]!.retryUntil + 1);
  await f.reader().reconcile();
  expect(f.marks).toEqual([]);
  expect(e.notification.readAt).toBeNull();
});

it("does not mark a comment notification when its signed create evidence is ambiguous", async () => {
  const f = await fixture();
  const e = f.event();
  f.notifications.push(e.notification);
  const original = await wake(f, "global-default", e.raw);
  const conflicting = JSON.parse(e.raw);
  conflicting.data.body = "A different create payload for this same comment UUID";
  expect((await f.post(JSON.stringify(conflicting))).status).toBe(200);
  expect((await f.confirm("global-default", original.id)).isError).not.toBe(true);
  expect(e.notification.readAt).toBeNull();
  expect(f.marks).toEqual([]);
});

it("refuses consumption of an offered native wake before the mailbox takes it", async () => {
  const f = await fixture();
  const e = f.event();
  f.notifications.push(e.notification);
  await f.poll("global-default", 1);
  expect((await f.post(e.raw)).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  const offered = (await f.deliveries()).deliveries.find((item: { native?: unknown }) => item.native);
  expect(offered).toBeDefined();
  await expect(f.confirm("global-default", offered.wakeId)).rejects.toThrow("recipient or receipt");
  expect(f.marks).toEqual([]);
  const taken = await f.poll();
  expect(taken[0]?.id).toBe(offered.wakeId);
  expect((await f.confirm("global-default", offered.wakeId)).isError).not.toBe(true);
  expect(f.marks).toEqual([e.notification.id]);
});
