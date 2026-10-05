import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { LinearAttributionJournal } from "../src/linear-attribution.ts";
import { LinearWriteReceipts } from "../src/linear-webhook.ts";
import { createMcpHost } from "../src/mcp-host.ts";

const NOW = new Date("2026-10-05T00:00:00.000Z");
const SECRET = "temporary-fixture-webhook-secret";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "linear-webhook-wake-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((value) => ({
    ...value,
    linearWebhook: {
      ...value.linearWebhook,
      following: true,
      url: "https://fixture.example/v1/hooks/linear",
    },
  }));
  const wakes: { id: string; prompt: string | undefined }[] = [];
  let store = new ConversationStore(join(root, "conversations"), async (id, _text, publish, context) => {
    wakes.push({ id, prompt: store.linearWakePrompt(id, context.runId) });
    publish({ type: "message", role: "captain", text: "Reviewed the signed event", streaming: false });
  });
  const writesPath = join(root, "writes.json");
  const writes = new LinearWriteReceipts(writesPath);
  const attribution = new LinearAttributionJournal(join(root, "attribution.json"));
  const account = {
    provider: "linear" as const,
    userId: randomUUID(),
    workspaceId: randomUUID(),
    connectionId: randomUUID(),
    name: "Fixture app",
    email: "fixture@oauthapp.linear.app",
    workspaceName: "Fixture",
    verifiedAt: NOW.toISOString(),
  };
  const issueId = randomUUID();
  let issue: Record<string, unknown> = {
    id: "VUH-1678",
    uuid: issueId,
    title: "Title read through native MCP",
  };
  const issueReads: Record<string, unknown>[] = [];
  const providerToken = randomUUID();
  const provider = await createClankieApp({
    captain: createStubCaptain({
      laneToolBank: async (lane) => ({
        lane,
        tools: [
          {
            name: "get_issue",
            description: "Read the temporary provider issue",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
            call: async (args) => {
              issueReads.push(args);
              return { content: [{ type: "text", text: JSON.stringify(issue) }] };
            },
          },
        ],
      }),
    }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${providerToken}`
        ? { operatorId: "fixture-provider" }
        : undefined,
  });
  const providerServer = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => provider.app.fetch(request),
  }) as HttpServer;
  await new Promise<void>((resolve, reject) => {
    providerServer.once("listening", resolve);
    providerServer.once("error", reject);
  });
  const providerAddress = providerServer.address();
  if (!providerAddress || typeof providerAddress === "string") throw new Error("No provider HTTP address");
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await credentials.set("linear", { type: "api", key: providerToken, account });
  const host = createMcpHost({
    credentials,
    settings,
    curated: [
      {
        id: "linear",
        transport: "http",
        url: `http://127.0.0.1:${providerAddress.port}/v1/mcp`,
        credential: "linear",
        lane: "operator",
        args: [],
        initialTools: ["get_issue"],
        enabled: true,
      },
    ],
    logger: { info() {}, warn() {} },
  });
  let own: { userId: string; workspaceId: string } | undefined = account;
  const clankie = await createClankieApp({
    captain: createStubCaptain({
      receiveLinearActivity: (activity, wake, target) => store.receiveLinearActivity(activity, wake, target),
      linearWakeTargetAllowed: (target) => store.linearWakeTargetAllowed(target),
    }),
    settings,
    clock: () => NOW,
    linearWebhook: {
      secret: async () => SECRET,
      writes,
      ownAccount: async () => own,
      recordActivity: (event) => attribution.record(event, NOW),
      issueContext: (event) => attribution.issueContext(event, host),
    },
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => clankie.app.fetch(request),
  }) as HttpServer;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    await store.close();
    clankie.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await host.close();
    provider.close();
    providerServer.closeAllConnections();
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  function body(envelope: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
    return JSON.stringify({
      action: "create",
      type: "Comment",
      createdAt: NOW.toISOString(),
      webhookTimestamp: NOW.getTime(),
      organizationId: account.workspaceId,
      actor: { id: "james-fixture", name: "James", email: "volpestyle@gmail.com" },
      url: "https://linear.app/fixture/issue/VUH-1678/linear-wake",
      data: {
        id: randomUUID(),
        updatedAt: NOW.toISOString(),
        body: "Please inspect the signed result.",
        issue: { id: issueId, identifier: "VUH-1678", title: "Linear webhook wakes lead" },
        ...data,
      },
      ...envelope,
    });
  }
  async function post(raw: string, signature = createHmac("sha256", SECRET).update(raw).digest("hex")) {
    return fetch(`${endpoint}/v1/hooks/linear`, {
      method: "POST",
      body: raw,
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": randomUUID(),
        "linear-event": "Comment",
      },
    });
  }
  return {
    root,
    settings,
    account,
    writes,
    wakes,
    body,
    post,
    issueId,
    issueReads,
    setIssue: (value: typeof issue) => {
      issue = value;
    },
    store: () => store,
    closeTurns: () => store.close(),
    setOwn: (value: typeof own) => {
      own = value;
    },
    events: (target = "global-default") => new ConversationJournal(join(root, "conversations")).read(target),
    async restart() {
      await store.close();
      store = new ConversationStore(join(root, "conversations"), async (id, _text, publish, context) => {
        wakes.push({ id, prompt: store.linearWakePrompt(id, context.runId) });
        publish({ type: "message", role: "captain", text: "Reviewed", streaming: false });
      });
    },
  };
}

it("POSTs signed James comments through HTTP into global-default as one compact burst wake", async () => {
  const f = await fixture();
  for (const message of ["First signed comment", "Second signed comment", "Third signed comment"])
    expect(await (await f.post(f.body({}, { body: message }))).json()).toMatchObject({ ingested: true });
  await f.closeTurns();
  expect(f.wakes).toHaveLength(1);
  expect(f.wakes[0]).toMatchObject({ id: "global-default" });
  const prompt = f.wakes[0]!.prompt!;
  for (const text of [
    "VUH-1678",
    "Linear webhook wakes lead",
    "create",
    "James",
    "First signed comment",
    "Third signed comment",
    "https://linear.app/fixture/issue/VUH-1678",
  ])
    expect(prompt).toContain(text);
  expect(prompt).not.toContain("inbox");
  expect(f.events().filter((event) => event.type === "message" && event.role === "external")).toHaveLength(3);
});

it("enriches the official sparse Comment shape through native MCP and rejects mismatched issue results", async () => {
  const f = await fixture();
  const sparse = () =>
    f.body({
      data: {
        id: randomUUID(),
        issueId: f.issueId,
        updatedAt: NOW.toISOString(),
        body: "Sparse signed comment, without nested issue title",
      },
    });
  expect(await (await f.post(sparse())).json()).toMatchObject({ ingested: true });
  await f.closeTurns();
  expect(f.issueReads).toEqual([{ id: f.issueId }]);
  expect(f.wakes[0]?.prompt).toContain("Title read through native MCP");
  expect(f.wakes[0]?.prompt).toContain("VUH-1678");
  f.setIssue({ id: "WRONG-9", uuid: randomUUID(), title: "A different issue" });
  await f.restart();
  expect(await (await f.post(sparse())).json()).toMatchObject({ ingested: true });
  await f.closeTurns();
  expect(f.wakes.at(-1)?.prompt).toContain("Title unavailable");
  expect(f.wakes.at(-1)?.prompt).not.toContain("A different issue");
});

it("wakes for newly added Linear mentions while routine issue edits remain passive", async () => {
  const f = await fixture();
  const description = "Please see https://linear.app/fixture/profiles/owner";
  expect(
    await (
      await f.post(
        f.body({
          type: "Issue",
          action: "update",
          updatedFrom: { description: "Before" },
          data: { id: f.issueId, identifier: "VUH-1678", title: "Signed issue mention", description },
        }),
      )
    ).json(),
  ).toMatchObject({ ingested: true });
  expect(
    await (
      await f.post(
        f.body({
          type: "Issue",
          action: "update",
          updatedFrom: { description },
          data: {
            id: f.issueId,
            identifier: "VUH-1678",
            title: "Passive edit",
            description: `${description} Extra text`,
          },
        }),
      )
    ).json(),
  ).toMatchObject({ ingested: true });
  await f.closeTurns();
  expect(f.wakes).toHaveLength(1);
  expect(f.wakes[0]?.prompt).toContain("Signed issue mention");
  expect(f.wakes[0]?.prompt).not.toContain("Passive edit");
  await f.restart();
  await f.settings.update((value) => ({
    ...value,
    linearWebhook: {
      ...value.linearWebhook,
      wake: { ...value.linearWebhook.wake, excludedNotificationTypes: ["issueCommentMention"] },
    },
  }));
  expect(await (await f.post(f.body({}, { body: description }))).json()).toMatchObject({ ingested: true });
  await f.closeTurns();
  // An excluded mention cannot bypass its rule by also being a new comment.
  expect(f.wakes).toHaveLength(1);
});

it("suppresses exact own and worker receipt echoes, regardless of self rules", async () => {
  const f = await fixture();
  await f.settings.update((value) => ({
    ...value,
    linearWebhook: {
      ...value.linearWebhook,
      wake: { ...value.linearWebhook.wake, actors: ["self"], notificationTypes: [] },
    },
  }));
  for (const worker of [undefined, { grantId: "fixture-grant", principalId: "worker", workId: "VUH-1678" }]) {
    const revision = { id: randomUUID(), updatedAt: NOW.toISOString(), body: "Own write" };
    f.writes.record(
      {
        server: "linear",
        tool: "save_comment",
        content: JSON.stringify(revision),
        isError: false,
        account: f.account,
        ...(worker ? { worker } : {}),
      },
      NOW,
    );
    expect(
      await (await f.post(f.body({ actor: { id: f.account.userId, type: "app" } }, revision))).json(),
    ).toMatchObject({ ingested: false });
  }
  // A known own actor also remains passive even when no exact receipt was available.
  expect(await (await f.post(f.body({ actor: { id: f.account.userId, type: "app" } }))).json()).toMatchObject(
    { ingested: true },
  );
  await f.closeTurns();
  expect(f.wakes).toHaveLength(0);
  expect(f.events().filter((event) => event.type === "message" && event.role === "external")).toHaveLength(1);
});

it("keeps rule misses and unavailable identity visible without waking", async () => {
  const f = await fixture();
  for (const envelope of [
    { actor: { id: "other", type: "user", email: "other@example.test" } },
    { type: "Issue", action: "update", updatedFrom: { title: "Previous title" } },
  ])
    expect(await (await f.post(f.body(envelope))).json()).toMatchObject({ ingested: true });
  f.setOwn(undefined);
  expect(await (await f.post(f.body())).json()).toMatchObject({ ingested: true });
  f.setOwn({ userId: "bot", workspaceId: "another-workspace" });
  expect(await (await f.post(f.body())).json()).toMatchObject({ ingested: true });
  await f.closeTurns();
  expect(f.wakes).toHaveLength(0);
  expect(f.events().filter((event) => event.type === "message" && event.role === "external")).toHaveLength(4);
});

it("rejects bad signatures and stale replay and durably deduplicates valid retry deliveries", async () => {
  const f = await fixture();
  const raw = f.body();
  expect((await f.post(raw, "bad")).status).toBe(401);
  expect((await f.post(f.body({ webhookTimestamp: NOW.getTime() - 61_000 }))).status).toBe(401);
  expect((await f.post("{broken")).status).toBe(400);
  expect(await (await f.post(raw)).json()).toMatchObject({ ingested: true });
  expect(await (await f.post(raw)).json()).toMatchObject({ ingested: false });
  await f.restart();
  expect(await (await f.post(raw)).json()).toMatchObject({ ingested: false });
  await f.closeTurns();
  expect(f.wakes).toHaveLength(1);
  expect(f.events().filter((event) => event.type === "message" && event.role === "external")).toHaveLength(1);
});

it("keeps failed journal writes retryable and drops unavailable configured targets with 200", async () => {
  const f = await fixture();
  const raw = f.body();
  const journalPath = join(f.root, "conversations", "global-default", "events.jsonl");
  await mkdir(journalPath);
  expect((await f.post(raw)).status).toBe(500);
  await rm(journalPath, { recursive: true });
  expect(await (await f.post(raw)).json()).toMatchObject({ ingested: true });
  await f.settings.update((value) => ({
    ...value,
    linearWebhook: { ...value.linearWebhook, wakeConversationId: "removed-chat" },
  }));
  const unavailable = await f.post(f.body());
  expect(unavailable.status).toBe(200);
  expect(await unavailable.json()).toMatchObject({ ingested: false });
  await f.closeTurns();
  expect(f.wakes).toHaveLength(1);
});
