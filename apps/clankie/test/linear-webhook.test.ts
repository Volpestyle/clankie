import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderAccount } from "@clankie/credential-broker";
import { ClankieSettingsSchema, type ClankieSettings } from "@clankie/settings";
import { afterEach, describe, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { seatEventKindFor } from "../src/captain/captain.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import {
  LinearWriteReceipts,
  linearActivityHeadline,
  linearActivityPrompt,
  type LinearActivityEvent,
} from "../src/linear-webhook.ts";

/**
 * Signed Linear activity ingest. Every case drives the real route so
 * the raw-body reading is exercised: a test that hands the verifier an object
 * would pass while the live hook rejects everything Linear sends.
 */

const SECRET = "linear-webhook-signing-secret";
const OWNER = "volpestyle@gmail.com";
const NOW = new Date("2026-09-07T01:00:00.000Z");

function commentBody(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "create",
    type: "Comment",
    webhookTimestamp: NOW.getTime(),
    createdAt: NOW.toISOString(),
    url: "https://linear.app/vuhlp/issue/VUH-1234#comment-abc",
    actor: { id: "user-james", name: "James", email: OWNER },
    data: {
      id: "comment-abc",
      body: "This one is blocked on the gateway header allowlist.",
      issue: { id: "issue-1", identifier: "VUH-1234", title: "Linear comment ingress" },
      ...data,
    },
    ...overrides,
  });
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
}

const hookStores: Array<{ root: string; store: ConversationStore; close(): void }> = [];
afterEach(async () => {
  for (const { root, store, close } of hookStores.splice(0)) {
    await store.close();
    close();
    await rm(root, { recursive: true, force: true });
  }
});
async function hookApp(following = true, writes?: LinearWriteReceipts, existingRoot?: string) {
  const root = existingRoot ?? (await mkdtemp("/tmp/clankie-linear-ingress-"));
  const store = new ConversationStore(root, async () => {});
  const wakes: LinearActivityEvent[] = [];
  const inbox: LinearActivityEvent[] = [];
  const clankie = await createClankieApp({
    captain: createStubCaptain({
      receiveLinearActivity: (comment, following) => {
        const accepted = store.receiveLinearActivity(comment, following);
        if (accepted) {
          inbox.push(comment);
          if (following) wakes.push(comment);
        }
        return accepted;
      },
    }),
    settings: {
      load: () =>
        Promise.resolve(
          ClankieSettingsSchema.parse({
            schemaVersion: 1,
            linearWebhook: { following },
          }),
        ),
    },
    linearWebhook: {
      secret: () => Promise.resolve(SECRET),
      ...(writes === undefined ? {} : { writes }),
    },
    clock: () => NOW,
  });
  const post = (body: string, headers: Record<string, string> = {}) =>
    clankie.app.request("/v1/hooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-event": "Comment",
        "linear-delivery": "delivery-1",
        "linear-signature": sign(body),
        ...headers,
      },
      body,
    });
  hookStores.push({ root, store, close: () => clankie.close() });
  return { post, wakes, inbox, root, store };
}

describe("linear activity ingress", () => {
  it("admits a signed comment while following", async () => {
    const { post, wakes } = await hookApp();
    const body = commentBody();

    const response = await post(body);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ingested: true });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      type: "Comment",
      actorEmail: OWNER,
      data: { body: "This one is blocked on the gateway header allowlist." },
    });
  });

  it("correlates exact revisions across restart without hiding human or worker activity", async () => {
    const root = await mkdtemp("/tmp/clankie-linear-receipts-");
    const path = join(root, "writes.json");
    const own = "0f5a2d1e-7c3b-4a1d-9e2f-1234567890ab";
    const issue = "a06a1c92-8a14-4240-8802-a0bb868d639c";
    const account: ProviderAccount = {
      provider: "linear",
      connectionId: "account-1",
      userId: "bot",
      workspaceId: "org",
      name: "Clankie",
      email: "bot@example.test",
      workspaceName: "Test",
      verifiedAt: NOW.toISOString(),
    };
    const revision = { id: own, updatedAt: NOW.toISOString(), body: "Worker result" };
    const call = {
      server: "linear",
      tool: "create_comment",
      content: JSON.stringify({ ...revision, issue: { id: issue } }),
      isError: false,
      account,
    };
    try {
      const writes = new LinearWriteReceipts(path);
      writes.record(call, NOW);
      const persisted = await readFile(path, "utf8");
      expect(persisted).not.toContain("Worker result");
      expect(persisted).not.toContain(issue);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const resumed = new LinearWriteReceipts(path);
      const { post, inbox } = await hookApp(true, resumed);
      let delivery = 0;
      const send = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
        post(
          commentBody(
            { actor: { id: "bot" }, organizationId: "org", ...overrides },
            { ...revision, ...data },
          ),
          { "linear-delivery": `echo-${delivery++}` },
        );
      await expect((await send()).json()).resolves.toMatchObject({ ingested: false });
      await expect(
        (await send({ action: "update", updatedFrom: { body: "Before" } })).json(),
      ).resolves.toMatchObject({ ingested: false });
      expect(
        resumed.match(
          JSON.parse(commentBody({ actor: { id: "bot" }, organizationId: "org" }, revision)),
          new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000),
        ),
      ).toBeUndefined();
      for (const [overrides, data] of [
        [{ actor: { id: "human", name: "Clankie", email: account.email } }, {}],
        [{ organizationId: "other-org" }, {}],
        [{ type: "Issue" }, {}],
        [{ action: "remove" }, {}],
        [{ action: "update", updatedFrom: { unknownField: "before" } }, {}],
        [{}, { updatedAt: new Date(NOW.getTime() + 1).toISOString() }],
        [{}, { body: "Human correction in the same millisecond" }],
        [{}, { id: issue }],
        [{ actor: null }, {}],
      ] as const)
        await expect((await send(overrides, data)).json()).resolves.toMatchObject({ ingested: true });
      expect(inbox).toHaveLength(9);
      const provenance = { grantId: "grant", principalId: "worker-1", workId: issue };
      const workerRevision = { ...revision, id: "24c07157-d8de-4f24-aaac-8118d3c2c969" };
      resumed.record({ ...call, content: JSON.stringify(workerRevision), worker: provenance }, NOW);
      const workerApp = await hookApp(true, new LinearWriteReceipts(path));
      await workerApp.post(commentBody({ actor: { id: "bot" }, organizationId: "org" }, workerRevision));
      expect(workerApp.inbox).toMatchObject([{ actorId: "bot", organizationId: "org", worker: provenance }]);
      resumed.record({ ...call, worker: provenance }, NOW);
      await expect((await send()).json()).resolves.toMatchObject({ ingested: true });
      expect(inbox.at(-1)?.worker).toBeUndefined();
      // Reads, unverified accounts, errors and incomplete/ambiguous outputs do not suppress anything.
      const empty = new LinearWriteReceipts();
      for (const change of [
        { tool: "get_comment" },
        { account: undefined },
        { isError: true },
        { content: JSON.stringify({ id: own, body: revision.body }) },
        { content: `Saved ${own}` },
        { content: JSON.stringify({ id: own, updatedAt: revision.updatedAt }) },
      ])
        empty.record({ ...call, ...change }, NOW);
      const uncorrelated = await hookApp(true, empty);
      await uncorrelated.post(commentBody({ actor: { id: "bot" }, organizationId: "org" }, revision));
      expect(uncorrelated.inbox).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a body the signature does not cover", async () => {
    const { post, wakes } = await hookApp();
    const body = commentBody();

    // The signature of a different body: exactly what a replayed or forged POST
    // looks like, and what re-serializing a parsed payload would produce.
    const response = await post(body, { "linear-signature": sign(commentBody({ url: "https://evil" })) });

    expect(response.status).toBe(401);
    expect(wakes).toHaveLength(0);
  });

  it("refuses a correctly signed delivery that is too old to be live", async () => {
    const { post, wakes } = await hookApp();
    const body = commentBody({ webhookTimestamp: NOW.getTime() - 61_000 });

    const response = await post(body);

    expect(response.status).toBe(401);
    expect(wakes).toHaveLength(0);
  });

  it("admits all data-change resource types and actors, including missing actors", async () => {
    for (const type of [
      "Comment",
      "Issue",
      "Project",
      "ProjectUpdate",
      "Cycle",
      "IssueLabel",
      "FutureResource",
    ]) {
      for (const action of ["create", "update", "remove"]) {
        const { post, wakes } = await hookApp();
        const response = await post(
          commentBody({
            type,
            action,
            actor: null,
            updatedFrom: { title: "old title" },
            data: { id: "entity-1", title: "new title" },
          }),
        );
        expect(response.status).toBe(200);
        expect(wakes).toMatchObject([
          { type, action, data: { id: "entity-1", title: "new title" }, updatedFrom: { title: "old title" } },
        ]);
      }
    }
    const { post, wakes } = await hookApp();
    await post(commentBody({ actor: { name: "Worker", email: "worker@example.com" } }));
    expect(wakes[0]?.actorName).toBe("Worker");
  });

  it("acknowledges unsupported actions without retrying them", async () => {
    const { post, wakes } = await hookApp();
    const response = await post(commentBody({ action: "test" }));
    expect(response.status).toBe(200);
    expect(wakes).toEqual([]);
  });

  it("acknowledges activity without waking while follow is off", async () => {
    const { post, wakes, inbox } = await hookApp(false);
    expect(await (await post(commentBody())).json()).toMatchObject({ ingested: true });
    expect(wakes).toEqual([]);
    expect(inbox).toHaveLength(1);
  });

  it("rejects malformed envelopes, including a scalar data field", async () => {
    const { post, wakes } = await hookApp();
    expect((await post(commentBody({ data: "bad" }))).status).toBe(400);
    expect((await post("{broken")).status).toBe(400);
    expect(wakes).toEqual([]);
  });

  it("deduplicates signed event identity across restart and trimming, and retries failed storage", async () => {
    const first = await hookApp(false);
    const path = join(first.root, "linear-inbox", "events.jsonl");
    first.store.linearInboxConversationId();
    await mkdir(path);
    expect((await first.post(commentBody())).status).toBe(500);
    await rm(path, { recursive: true });
    expect(await (await first.post(commentBody())).json()).toMatchObject({ ingested: true });
    await first.store.close();
    const second = await hookApp(false, undefined, first.root);
    expect(
      await (
        await second.post(commentBody({ webhookTimestamp: NOW.getTime() + 1000 }), {
          "linear-delivery": "another-header",
        })
      ).json(),
    ).toMatchObject({ ingested: false });
    expect(second.store.readLinearInbox().unreadCount).toBe(1);
    expect(await (await second.post(commentBody({}, { body: "A new change" }))).json()).toMatchObject({
      ingested: true,
    });
    for (let i = 0; i < 600; i++) second.store.receiveLinearActivity(`fixture ${i}`, false);
    for (;;) {
      const page = second.store.readLinearInbox({ limit: 100 });
      if (!page.ackCursor) break;
      second.store.acknowledgeLinearInbox(page.ackCursor);
    }
    second.store.receiveLinearActivity("trigger retention", false);
    expect(await readFile(join(first.root, "linear-inbox", "meta.json"), "utf8")).toContain("linearSeen");
    await second.store.close();
    const third = await hookApp(false, undefined, first.root);
    expect(await (await third.post(commentBody())).json()).toMatchObject({ ingested: false });
  });

  it("wakes him once when Linear retries the same delivery", async () => {
    const { post, wakes } = await hookApp();
    const body = commentBody();

    const first = await post(body);
    const retry = await post(body);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ ingested: false });
    expect(wakes).toHaveLength(1);
  });

  it("reports itself unavailable until the owner has pasted the signing secret", async () => {
    const clankie = await createClankieApp({
      captain: createStubCaptain(),
      linearWebhook: { secret: () => Promise.resolve(undefined) },
    });

    const response = await clankie.app.request("/v1/hooks/linear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: commentBody(),
    });

    expect(response.status).toBe(503);
  });

  it("defaults to no wakes before the owner enables follow", async () => {
    const wakes: LinearActivityEvent[] = [];
    const clankie = await createClankieApp({
      captain: createStubCaptain({
        receiveLinearActivity: (comment, following) => {
          if (following) wakes.push(comment);
        },
      }),
      settings: { load: () => Promise.resolve(ClankieSettingsSchema.parse({ schemaVersion: 1 })) },
      linearWebhook: { secret: () => Promise.resolve(SECRET) },
      clock: () => NOW,
    });
    const body = commentBody();

    const response = await clankie.app.request("/v1/hooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-delivery": "delivery-1",
        "linear-signature": sign(body),
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(wakes).toHaveLength(0);
  });
});

it("requires operator authority and an expected owner to rebind Linear work", async () => {
  const fixture = await hookApp(false);
  const store = fixture.store;
  store.linearInboxConversationId();
  const app = await createClankieApp({
    captain: createStubCaptain({
      linearWorkOwners: () => store.linearWorkOwners(),
      setLinearWorkOwner: (owner, expected, remove) => store.setLinearWorkOwner(owner, expected, remove),
    }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const binding = {
    organizationId: "96d2a27b-950b-4a8a-afae-8776605c0ef1",
    issueId: "593644be-7b60-4a77-9b58-7b0dc20be894",
    conversationId: "global-default",
  };
  const request = (body: unknown, method = "PUT", token = "owner") =>
    app.app.request("/v1/linear/work", {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    expect((await request(binding, "PUT", "social")).status).toBe(401);
    expect((await request({ ...binding, issueId: "VUH-123" })).status).toBe(400);
    expect((await request({ ...binding, conversationId: "missing" })).status).toBe(409);
    expect((await request(binding)).status).toBe(200);
    expect((await request({ ...binding, conversationId: "linear-inbox" })).status).toBe(409);
    expect(
      (
        await request({
          ...binding,
          conversationId: "linear-inbox",
          expectedConversationId: "global-default",
        })
      ).status,
    ).toBe(200);
    expect((await request(binding, "DELETE")).status).toBe(409);
    expect((await request({ ...binding, conversationId: "linear-inbox" }, "DELETE")).status).toBe(200);
    expect(store.linearWorkOwners()).toEqual([]);
  } finally {
    app.close();
  }
});

describe("the prompt an activity becomes", () => {
  const activity: LinearActivityEvent = {
    deliveryId: "delivery-1",
    type: "Issue",
    action: "update",
    actorName: "James",
    actorEmail: OWNER,
    createdAt: NOW.toISOString(),
    url: "https://linear.app/vuhlp/issue/VUH-1234",
    data: { identifier: "VUH-1234", title: "new title" },
    updatedFrom: { title: "old title" },
  };

  it("quotes external context without attributing human direction or requiring a reply", () => {
    const prompt = linearActivityPrompt(activity);
    expect(prompt).toContain('>   "type": "Issue"');
    expect(prompt).toContain('>     "title": "old title"');
    expect(prompt).toContain("Routine updates can pass silently");
    expect(prompt).toContain("same account");
    expect(prompt).toContain("untrusted external context");
    expect(prompt).not.toContain("This is him talking to you");
    expect(prompt).not.toContain("This wake is the approval");
  });

  it("leads with a one-line headline a folded transcript can show", () => {
    expect(linearActivityHeadline(activity)).toBe("Linear Issue update · VUH-1234 new title · James");
    expect(linearActivityPrompt(activity).split("\n")[0]).toBe(linearActivityHeadline(activity));
    expect(
      linearActivityHeadline({
        ...activity,
        type: "Comment",
        action: "create",
        data: { body: "x", issue: { identifier: "VUH-9", title: "t".repeat(300) } },
      }),
    ).toMatch(/^Linear Comment create · VUH-9 t+…$/u);
  });

  it("bounds large activity payloads", () => {
    const prompt = linearActivityPrompt({ ...activity, data: { description: "x".repeat(20_000) } });
    expect(prompt.length).toBeLessThan(9_000);
    expect(prompt).toContain("[truncated]");
  });
});

describe("where a hook is delivered", () => {
  it("routes hooks to the bound conversation seat and preserves other wake routing", () => {
    expect(seatEventKindFor({ internal: true, origin: "hook" }, true)).toBe("wake");
    expect(seatEventKindFor({ internal: true, origin: "hook" }, false)).toBe("wake");
    expect(seatEventKindFor({ internal: true, origin: "watch" }, false)).toBe("watch");
    expect(seatEventKindFor({ internal: true, origin: "wake" }, false)).toBe("wake");
    expect(seatEventKindFor({ internal: true, origin: "goal" }, true)).toBeUndefined();
    expect(seatEventKindFor({}, true)).toBe("escalation");
    expect(seatEventKindFor({}, false)).toBeUndefined();
  });
});

describe("Linear follow control", () => {
  it("requires the operator, validates writes, and applies them to the next delivery", async () => {
    let settings = ClankieSettingsSchema.parse({ schemaVersion: 1 });
    const wakes: LinearActivityEvent[] = [];
    const { app } = await createClankieApp({
      captain: createStubCaptain({
        acknowledgeLinearInbox: (cursor) => cursor === "000000000001",
        receiveLinearActivity: (activity, following) => {
          if (following) wakes.push(activity);
        },
      }),
      settings: {
        load: async () => settings,
        update: async (mutate: (value: ClankieSettings) => ClankieSettings) => {
          settings = mutate(settings);
          return settings;
        },
      },
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer test-operator" ? { operatorId: "test" } : undefined,
      linearWebhook: { secret: async () => SECRET },
      clock: () => NOW,
    });
    const headers = { authorization: "Bearer test-operator", "content-type": "application/json" };
    for (const method of ["GET", "POST"]) {
      expect((await app.request("/v1/linear/inbox", { method })).status).toBe(401);
      const response = await app.request("/v1/linear/inbox", { method, headers });
      if (method === "POST") expect(response.status).toBe(400);
      else expect(await response.json()).toMatchObject({ items: [], unreadCount: 0, hasMore: false });
    }
    expect(
      (
        await app.request("/v1/linear/inbox", {
          method: "POST",
          headers,
          body: JSON.stringify({ ackCursor: "000000000099" }),
        })
      ).status,
    ).toBe(409);
    expect(
      await (
        await app.request("/v1/linear/inbox", {
          method: "POST",
          headers,
          body: JSON.stringify({ ackCursor: "000000000001" }),
        })
      ).json(),
    ).toEqual({ schemaVersion: 1, acknowledged: "000000000001" });
    expect((await app.request("/v1/linear/follow")).status).toBe(401);
    expect(
      (await app.request("/v1/linear/follow", { method: "PUT", body: '{"following":true}' })).status,
    ).toBe(401);
    expect(await (await app.request("/v1/linear/follow", { headers })).json()).toMatchObject({
      following: false,
    });
    for (const body of ["{}", '{"following":"yes"}', '{"following":true,"actorEmail":"x"}']) {
      expect((await app.request("/v1/linear/follow", { method: "PUT", headers, body })).status).toBe(400);
    }
    for (const following of [true, false]) {
      expect(
        await (
          await app.request("/v1/linear/follow", {
            method: "PUT",
            headers,
            body: JSON.stringify({ following }),
          })
        ).json(),
      ).toMatchObject({ following, conversationId: "linear-inbox" });
      const body = commentBody({ type: "Issue", action: "create" });
      const response = await app.request("/v1/hooks/linear", {
        method: "POST",
        body,
        headers: { "linear-signature": sign(body), "linear-delivery": String(following) },
      });
      expect(await response.json()).toMatchObject({ ingested: true });
    }
    expect(wakes).toHaveLength(1);
  });
});
