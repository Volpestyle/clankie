import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderAccount } from "@clankie/credential-broker";
import { ClankieSettingsSchema, type ClankieSettings } from "@clankie/settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { seatEventKindFor } from "../src/captain/captain.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import {
  LinearWriteReceipts,
  classifyLinearDelivery,
  linearActivityHeadline,
  linearActivityPrompt,
  linearWriteIssue,
  linearActivityUpdateParent,
  type LinearActivityEvent,
} from "../src/linear-webhook.ts";
import type { LinearRecipient } from "../src/captain/conversation-owner.ts";

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
async function hookApp(
  following = true,
  writes?: LinearWriteReceipts,
  existingRoot?: string,
  ownAccount?: () => Promise<{ userId: string; workspaceId: string } | undefined>,
) {
  const root = existingRoot ?? (await mkdtemp("/tmp/clankie-linear-ingress-"));
  const store = new ConversationStore(root, async () => {});
  const wakes: LinearActivityEvent[] = [];
  const inbox: LinearActivityEvent[] = [];
  const requestNotificationPoll = vi.fn();
  const recordActivity = vi.fn();
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
      requestNotificationPoll,
      recordActivity,
      ...(writes === undefined ? {} : { writes }),
      ...(ownAccount === undefined ? {} : { ownAccount }),
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
  return { post, wakes, inbox, root, store, requestNotificationPoll, recordActivity };
}

describe("linear activity ingress", () => {
  it("requests a notification refresh only after verified, newly persisted activity, even while off", async () => {
    const f = await hookApp(false);
    expect((await f.post(commentBody(), { "linear-signature": "bad" })).status).toBe(401);
    expect((await f.post(commentBody({ webhookTimestamp: NOW.getTime() - 61_000 }))).status).toBe(401);
    expect((await f.post(commentBody({ data: "bad" }))).status).toBe(400);
    await f.post(commentBody({ action: "test" }));
    expect(f.requestNotificationPoll).not.toHaveBeenCalled();
    await f.post(commentBody());
    expect(f.inbox).toHaveLength(1);
    expect(f.requestNotificationPoll).toHaveBeenCalledTimes(1);
    await f.post(commentBody());
    expect(f.requestNotificationPoll).toHaveBeenCalledTimes(1);
    expect(f.wakes).toEqual([]);
  });
  it("persists a signed comment without waking even while following", async () => {
    const { post, wakes, inbox } = await hookApp();
    const body = commentBody();

    const response = await post(body);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ingested: true });
    expect(wakes).toHaveLength(0);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
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
      const { post, inbox, recordActivity, requestNotificationPoll } = await hookApp(true, resumed);
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
      expect(recordActivity).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          actorId: "bot",
          organizationId: "org",
          data: expect.objectContaining({ id: own }),
        }),
      );
      expect(inbox).toHaveLength(0);
      expect(requestNotificationPoll).toHaveBeenCalledTimes(1);
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
        const { post, inbox } = await hookApp();
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
        expect(inbox).toMatchObject([
          { type, action, data: { id: "entity-1", title: "new title" }, updatedFrom: { title: "old title" } },
        ]);
      }
    }
    const { post, inbox } = await hookApp();
    await post(commentBody({ actor: { name: "Worker", email: "worker@example.com" } }));
    expect(inbox[0]?.actorName).toBe("Worker");
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
    expect(first.requestNotificationPoll).not.toHaveBeenCalled();
    await rm(path, { recursive: true });
    expect(await (await first.post(commentBody())).json()).toMatchObject({ ingested: true });
    expect(first.requestNotificationPoll).toHaveBeenCalledTimes(1);
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

  it("keeps his own account's activity in the inbox without waking him", async () => {
    const own = { userId: "user-clankie", workspaceId: "org-1" };
    const { post, wakes, inbox } = await hookApp(true, undefined, undefined, async () => own);
    const clankie = { id: "user-clankie", name: "clankie", email: "clankie@example.com" };

    await post(commentBody({ organizationId: "org-1", actor: clankie }, { id: "comment-own" }));
    await post(commentBody({ organizationId: "org-1" }, { id: "comment-james" }));
    await post(commentBody({ organizationId: "org-2", actor: clankie }, { id: "comment-elsewhere" }));

    expect(inbox.map((event) => event.data.id)).toEqual([
      "comment-own",
      "comment-james",
      "comment-elsewhere",
    ]);
    expect(wakes).toEqual([]);
  });

  it("keeps history passive when his own identity cannot be verified", async () => {
    const clankie = { id: "user-clankie", name: "clankie" };
    for (const ownAccount of [async () => undefined, () => Promise.reject(new Error("disconnected"))]) {
      const { post, wakes } = await hookApp(true, undefined, undefined, ownAccount);
      await post(commentBody({ organizationId: "org-1", actor: clankie }));
      expect(wakes).toHaveLength(0);
    }
  });

  describe("a reply to his own post (VUH-1365, inbox event 000000002807)", () => {
    // Shaped like the delivered event: James asking on a Rivals Agent update the clankie account posted.
    const ORG = "75f1d1f0-542b-4095-9967-fd7b27093472";
    const JAMES = "634ad2c8-4992-48b5-b14d-af650cd30030";
    const CLANKIE = "47376ffa-abe2-4a44-81d0-70cfbf23bd76";
    const UPDATE = "5087a961-ae50-4504-b06a-8ea9111cf1c5";
    const own = async () => ({ userId: CLANKIE, workspaceId: ORG });
    const projectUpdate = {
      id: UPDATE,
      body: "**The corpus is close to its target…** Record one test take.",
      userId: CLANKIE,
      project: {
        id: "bff1b565-3f05-4c53-bdba-6b3d10e486a6",
        name: "Rivals Agent",
        url: "https://linear.app/vuhlp/project/rivals-agent-762337b8bf64",
      },
    };
    const question = (
      actor = { id: JAMES, name: "James Volpe", email: OWNER },
      id = "e899310b-8c4f-406a-a8d4-07e8cb226840",
    ) =>
      JSON.stringify({
        action: "create",
        type: "Comment",
        webhookTimestamp: NOW.getTime(),
        createdAt: NOW.toISOString(),
        url: "https://linear.app/vuhlp/project/rivals-agent-762337b8bf64/activity#project-update-5087a961&comment-e899310b",
        organizationId: ORG,
        actor,
        data: {
          id,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          body: "whats the test take for?\n\nwhats the significance of the chart?",
          projectUpdateId: UPDATE,
          userId: actor.id,
          botActor: null,
          user: actor,
          projectUpdate,
        },
      });
    const statusEdit = (actor: { id: string; name: string }) =>
      JSON.stringify({
        action: "update",
        type: "ProjectUpdate",
        webhookTimestamp: NOW.getTime(),
        organizationId: ORG,
        actor,
        url: "https://linear.app/vuhlp/project/rivals-agent-762337b8bf64/updates#project-update-5087a961",
        data: { ...projectUpdate, health: "atRisk", projectId: projectUpdate.project.id, user: actor },
        updatedFrom: { health: "onTrack" },
      });

    it("names the update and marks the reply in passive history", async () => {
      const { post, wakes, inbox, store } = await hookApp(true, undefined, undefined, own);
      await post(question());

      expect(inbox).toHaveLength(1);
      expect(inbox[0]!.replyTo).toEqual({ type: "ProjectUpdate", id: UPDATE });
      expect(wakes).toHaveLength(0);
      expect(linearActivityHeadline(inbox[0]!)).toBe(
        "Linear Comment create · Rivals Agent update 5087a961 · reply to your post · James Volpe",
      );
      const prompt = linearActivityPrompt(inbox[0]!);
      expect(prompt).toContain("whoever owns the work");
      expect(prompt).not.toContain("Routine updates can pass silently");
      expect(prompt).not.toContain("no obligation");
      expect(store.linearWakePrompt()).toBeUndefined();
    });

    it("names the worker whose write receipt posted the update", async () => {
      const writes = new LinearWriteReceipts();
      const worker = { grantId: "grant", principalId: "rivals-worker", workId: "VUH-1346" };
      writes.record(
        {
          server: "linear",
          tool: "save_project_update",
          content: JSON.stringify({ id: UPDATE, updatedAt: NOW.toISOString(), body: projectUpdate.body }),
          isError: false,
          account: {
            provider: "linear",
            connectionId: "account-1",
            userId: CLANKIE,
            workspaceId: ORG,
            name: "clankie",
            email: "clankie@example.test",
            workspaceName: "Vuhlp",
            verifiedAt: NOW.toISOString(),
          },
          worker,
        },
        NOW,
      );
      // The receipt proves authorship even while his identity is unverified.
      const { post, inbox } = await hookApp(true, writes, undefined, async () => undefined);
      await post(question());
      expect(inbox[0]!.replyTo).toEqual({ type: "ProjectUpdate", id: UPDATE, worker });
    });

    it("leaves his own comments, status edits and unknown authorship unmarked", async () => {
      const clankie = { id: CLANKIE, name: "clankie", email: "clankie@example.test" };
      const { post, wakes, inbox, store } = await hookApp(true, undefined, undefined, own);
      await post(question(clankie, "11111111-1111-4111-8111-111111111111"));
      await post(statusEdit(clankie));
      expect(inbox.map((event) => event.replyTo)).toEqual([undefined, undefined]);
      expect(wakes).toHaveLength(0);
      expect(store.linearWakePrompt()).toBeUndefined();
      expect(linearActivityHeadline(inbox[1]!)).toBe(
        "Linear ProjectUpdate update · Rivals Agent update 5087a961 · clankie",
      );

      await post(statusEdit({ id: JAMES, name: "James Volpe" }));
      expect(inbox[2]!.replyTo).toBeUndefined();
      expect(store.linearWakePrompt()).toBeUndefined();

      const unknown = await hookApp(true, undefined, undefined, async () => undefined);
      await unknown.post(question());
      expect(unknown.inbox[0]!.replyTo).toBeUndefined();
      expect(unknown.wakes).toHaveLength(0);
    });
  });

  it("persists once without waking when Linear retries the same delivery", async () => {
    const { post, wakes, inbox } = await hookApp();
    const body = commentBody();

    const first = await post(body);
    const retry = await post(body);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ ingested: false });
    expect(inbox).toHaveLength(1);
    expect(wakes).toHaveLength(0);
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

it("keeps legacy bindings readable without inferring mutation authority from inspection", async () => {
  const root = await mkdtemp("/tmp/clankie-linear-bindings-");
  const binding = {
    organizationId: "96d2a27b-950b-4a8a-afae-8776605c0ef1",
    issueId: "593644be-7b60-4a77-9b58-7b0dc20be894",
    conversationId: "global-default",
  };
  const stored = JSON.stringify([binding]);
  const path = join(root, "linear-work.json");
  await writeFile(path, stored);
  const fixture = await hookApp(false, undefined, root);
  const store = fixture.store;
  const app = await createClankieApp({
    captain: createStubCaptain({
      linearWorkOwners: () => store.linearWorkOwners(),
    }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const request = (method: string, token = "owner") =>
    app.app.request("/v1/linear/work", {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(binding) }),
    });
  try {
    for (const method of ["GET", "PUT", "DELETE"]) expect((await request(method, "social")).status).toBe(401);
    const denied = await request("PUT");
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "linear_work_owner_refused" });
    expect((await request("DELETE")).status).toBe(400);
    const response = await request("GET");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ owners: [binding] });
    expect(await readFile(path, "utf8")).toBe(stored);
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
    expect(
      linearActivityHeadline({
        ...activity,
        type: "Comment",
        action: "create",
        data: { body: "x", documentContent: { document: { title: "Backlog priorities" } } },
      }),
    ).toBe("Linear Comment create · Backlog priorities · James");
    expect(
      linearActivityHeadline({
        ...activity,
        type: "Document",
        action: "update",
        data: { title: "Backlog priorities" },
      }),
    ).toBe("Linear Document update · Backlog priorities · James");
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
  it("requires the operator and changes follow without promoting workspace deliveries", async () => {
    let settings = ClankieSettingsSchema.parse({
      schemaVersion: 1,
      linearWebhook: { url: "https://hooks.example.test/v1/hooks/linear" },
    });
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
      ).toMatchObject({
        following,
        conversationId: "linear-inbox",
        wakeConversationId: "linear-inbox",
        wakeRouting: "work-owner",
      });
      const body = commentBody({ type: "Issue", action: "create" });
      const response = await app.request("/v1/hooks/linear", {
        method: "POST",
        body,
        headers: { "linear-signature": sign(body), "linear-delivery": String(following) },
      });
      expect(await response.json()).toMatchObject({ ingested: true });
    }
    expect(wakes).toHaveLength(0);
  });
});

it.each([
  { url: undefined, secret: undefined, missing: ["url", "secret"] },
  { url: "https://hooks.example.test/v1/hooks/linear", secret: undefined, missing: ["secret"] },
  { url: undefined, secret: SECRET, missing: ["url"] },
  { url: "https://hooks.example.test/v1/hooks/linear", secret: "  ", missing: ["secret"] },
])("refuses following without the webhook prerequisites: $missing", async ({ url, secret, missing }) => {
  let settings = ClankieSettingsSchema.parse({ schemaVersion: 1, linearWebhook: { url } });
  const resume = vi.fn();
  const { app } = await createClankieApp({
    captain: createStubCaptain({ resumeLinearActivity: resume }),
    authenticateOperator: async () => ({ operatorId: "test" }),
    settings: { load: async () => settings, update: async (mutate) => (settings = mutate(settings)) },
    linearWebhook: { secret: async () => secret },
  });
  const response = await app.request("/v1/linear/follow", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ following: true }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: "linear_webhook_required",
    reason: "linear_webhook_required",
    missingWebhook: missing,
    following: false,
    active: false,
  });
  expect(settings.linearWebhook.following).toBe(false);
  expect(resume).not.toHaveBeenCalled();
});

it("reports blocked following when its webhook secret or URL is removed, and permits stopping", async () => {
  let settings = ClankieSettingsSchema.parse({
    schemaVersion: 1,
    linearWebhook: { url: "https://hooks.example.test/v1/hooks/linear" },
  });
  let secret: string | undefined = SECRET;
  const resume = vi.fn();
  const { app } = await createClankieApp({
    captain: createStubCaptain({ resumeLinearActivity: resume }),
    authenticateOperator: async () => ({ operatorId: "test" }),
    settings: { load: async () => settings, update: async (mutate) => (settings = mutate(settings)) },
    linearWebhook: { secret: async () => secret },
  });
  const toggle = (following: boolean) =>
    app.request("/v1/linear/follow", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ following }),
    });
  expect(await (await toggle(true)).json()).toMatchObject({ following: true, active: true, reason: null });
  expect(resume).toHaveBeenCalledTimes(1);
  expect(settings.linearWebhook.url).toBe("https://hooks.example.test/v1/hooks/linear");
  secret = undefined;
  expect(await (await app.request("/v1/linear/follow")).json()).toMatchObject({
    following: true,
    active: false,
    reason: "linear_webhook_required",
    missingWebhook: ["secret"],
  });
  secret = SECRET;
  settings.linearWebhook = ClankieSettingsSchema.parse({
    schemaVersion: 1,
    linearWebhook: { following: true },
  }).linearWebhook;
  expect(await (await app.request("/v1/linear/follow")).json()).toMatchObject({
    following: true,
    active: false,
    missingWebhook: ["url"],
  });
  expect(await (await toggle(false)).json()).toMatchObject({ following: false, active: false });
  expect(resume).toHaveBeenCalledTimes(1);
});

describe("canonical Linear issue routing identity", () => {
  const organizationId = "8397840d-889c-49d5-b686-254640d488b3";
  const issueId = "a06a1c92-8a14-4240-8802-a0bb868d639c";
  const otherIssueId = "be9a13a6-2236-4da1-bc7f-a275392e69b8";
  const commentId = "0f5a2d1e-7c3b-4a1d-9e2f-1234567890ab";
  const account: ProviderAccount = {
    provider: "linear",
    connectionId: "connected-linear",
    userId: "bot",
    workspaceId: organizationId,
    email: "bot@example.test",
    name: "Clankie",
    workspaceName: "Workspace",
    verifiedAt: NOW.toISOString(),
  };
  const write = (tool: string, result: unknown, args: Record<string, unknown> = {}) => ({
    server: "linear",
    tool,
    arguments: args,
    content: JSON.stringify(result),
    isError: false,
    account,
  });

  it.each([
    ["create_issue", { uuid: issueId, id: "VUH-1234" }, {}],
    ["update_issue", { id: issueId.toUpperCase() }, { id: "VUH-1234" }],
    ["save_issue", { id: issueId, uuid: issueId.toUpperCase() }, {}],
    ["create_worker_issue", { uuid: issueId, personaId: "worker" }, {}],
    ["create_comment", { id: commentId, issueId }, { issueId: "VUH-1234" }],
    ["update_comment", { id: commentId, issue: { id: issueId } }, {}],
    ["save_comment", { id: commentId, issue: { uuid: issueId, id: "VUH-1234" } }, {}],
    ["create_worker_comment", { id: commentId, issue: { uuid: issueId }, personaId: "worker" }, {}],
    ["create_comment", { id: commentId, body: "Posted" }, { issueId: issueId.toUpperCase() }],
  ] as const)("extracts the canonical addressed issue for %s", (tool, result, args) => {
    expect(linearWriteIssue(write(tool, result, args))).toEqual({ organizationId, issueId });
  });

  it.each([
    ["save_issue", { id: "VUH-1234" }, { id: issueId }],
    ["save_issue", { title: issueId }, { identifier: "VUH-1234" }],
    ["create_issue", { issue: { id: issueId } }, {}],
    ["create_comment", { id: commentId }, { issueId: "VUH-1234" }],
    ["update_comment", { id: commentId, body: `Issue ${issueId}` }, { id: issueId }],
    ["create_issue", { id: issueId, uuid: otherIssueId }, {}],
    ["create_comment", { issueId, issue: { id: otherIssueId } }, {}],
    ["create_comment", { issueId }, { issueId: otherIssueId }],
    ["create_comment", { id: commentId, success: false }, { issueId }],
    ["create_issue", { id: issueId, ok: false }, {}],
    ["get_issue", { id: issueId }, {}],
    ["create_project", { id: issueId }, {}],
    ["create_issue", [issueId], {}],
    ["create_issue", `Issue ${issueId}`, {}],
  ] as const)("refuses ambiguous or noncanonical routing proof from %s", (tool, result, args) => {
    expect(linearWriteIssue(write(tool, result, args))).toBeUndefined();
  });

  it("requires a successful Linear call and the verified connected workspace", () => {
    const call = write("save_issue", { id: issueId });
    for (const altered of [
      { ...call, server: "another-service" },
      { ...call, isError: true },
      { ...call, account: undefined },
      { ...call, account: { ...account, provider: "github" } as unknown as ProviderAccount },
      { ...call, account: { ...account, workspaceId: "display-workspace" } },
      { ...call, content: "malformed" },
    ])
      expect(linearWriteIssue(altered)).toBeUndefined();
    expect(linearWriteIssue({ ...call, account: { ...account, workspaceId: otherIssueId } })).toEqual({
      organizationId: otherIssueId,
      issueId,
    });
  });

  it.each([
    ["Issue", { id: issueId.toUpperCase(), identifier: "VUH-1234" }, issueId],
    ["Comment", { id: commentId, issueId }, issueId],
    ["Comment", { id: commentId, issue: { id: issueId } }, issueId],
    ["Comment", { id: commentId, issueId, issue: { id: otherIssueId } }, undefined],
    ["Comment", { id: commentId, issue: { id: "VUH-1234" } }, undefined],
    ["ProjectUpdate", { id: issueId }, undefined],
  ] as const)("stamps canonical identity only from verified %s resource data", (type, data, expected) => {
    const body = commentBody({ type, data, organizationId });
    const result = classifyLinearDelivery({
      rawBody: Buffer.from(body),
      headers: { signature: sign(body), delivery: "signed", event: type },
      secret: SECRET,
      now: NOW,
    });
    expect(result.kind).toBe("activity");
    if (result.kind !== "activity") throw new Error("verified event unavailable");
    expect(result.activity.issueId).toBe(expected);
  });
});

describe("host ownership of exact signed Linear writes", () => {
  const organizationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const commentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const account: ProviderAccount = {
    provider: "linear",
    connectionId: "connection",
    userId: "bot",
    workspaceId: organizationId,
    name: "Clankie",
    email: "bot@example.test",
    workspaceName: "Personal",
    verifiedAt: NOW.toISOString(),
  };
  const owner = {
    conversationId: "room-owned",
    discord: {
      baseSessionKey: "discord:channel",
      targetId: "channel",
      actorId: "authorized-owner",
      guildId: "guild",
      channelId: "channel",
      messageId: "origin",
      transportKind: "bot" as const,
    },
  };
  const revision = { id: commentId, updatedAt: NOW.toISOString(), body: "Completed the requested fix" };
  const call = {
    server: "linear",
    tool: "save_comment",
    arguments: { issueId: "VUH-1611" },
    content: JSON.stringify(revision),
    isError: false,
    account,
    owner,
  };
  function delivery(
    writes: LinearWriteReceipts | undefined,
    overrides: Record<string, unknown> = {},
    signature?: string,
  ) {
    const body = commentBody(
      { actor: { id: "bot" }, organizationId, ...overrides },
      { ...revision, issueId, issue: { id: issueId, identifier: "VUH-1611" } },
    );
    const seen: LinearActivityEvent[] = [];
    const result = classifyLinearDelivery({
      rawBody: Buffer.from(body),
      headers: { signature: signature ?? sign(body), delivery: "signed-owner", event: "Comment" },
      secret: SECRET,
      now: NOW,
      ...(writes ? { writes } : {}),
      recordActivity: (event) => void seen.push(event),
    });
    return { result, seen };
  }

  it("resolves an identifier-only comment write to its signed parent with durable host ownership before suppression", async () => {
    expect(linearWriteIssue(call)).toBeUndefined();
    const root = await mkdtemp("/tmp/clankie-linear-write-owner-");
    const path = join(root, "writes.json");
    try {
      new LinearWriteReceipts(path).record(call, NOW);
      const stored = await readFile(path, "utf8");
      expect(stored).toContain("room-owned");
      expect(stored).not.toContain(revision.body);
      expect(stored).not.toContain("VUH-1611");
      const resumed = new LinearWriteReceipts(path);
      const { result, seen } = delivery(resumed);
      expect(result).toEqual({ kind: "ignored", reason: "self_echo" });
      expect(seen).toMatchObject([
        { organizationId, issueId, conversationOwner: owner, conversationOwnerRecordedAt: NOW.getTime() },
      ]);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts owner stamps only from exact host receipts, never signed provider owner fields", () => {
    const writes = new LinearWriteReceipts();
    writes.record(call, NOW);
    const forged = { conversationOwner: { conversationId: "forged" }, owner: { conversationId: "forged" } };
    expect(delivery(writes, forged).seen[0]?.conversationOwner).toEqual(owner);
    expect(delivery(undefined, forged).seen[0]?.conversationOwner).toBeUndefined();
    expect(
      delivery(writes, { ...forged, actor: { id: "other-actor" } }).seen[0]?.conversationOwner,
    ).toBeUndefined();
    expect(
      delivery(writes, { ...forged, organizationId: "other-workspace" }).seen[0]?.conversationOwner,
    ).toBeUndefined();
    const bad = delivery(writes, forged, "bad");
    expect(bad.result).toEqual({ kind: "rejected", reason: "bad_signature" });
    expect(bad.seen).toEqual([]);
  });

  it("stamps the original receipt time on delayed echoes without changing suppression", () => {
    const recordedAt = new Date(NOW.getTime() - 30_000);
    const writes = new LinearWriteReceipts();
    writes.record(call, recordedAt);
    const { result, seen } = delivery(writes, { conversationOwnerRecordedAt: NOW.getTime() });
    expect(result).toEqual({ kind: "ignored", reason: "self_echo" });
    expect(seen[0]?.conversationOwner).toEqual(owner);
    expect(seen[0]?.conversationOwnerRecordedAt).toBe(recordedAt.getTime());
  });

  it("does not recover identifier-only ownership when the saved revision lacks proof", () => {
    for (const change of [
      { content: JSON.stringify({ id: commentId, body: revision.body, createdAt: NOW.toISOString() }) },
      { content: JSON.stringify({ id: commentId, updatedAt: NOW.toISOString() }) },
      { content: `Saved comment ${commentId}` },
      { isError: true },
      { account: undefined },
    ]) {
      const writes = new LinearWriteReceipts();
      writes.record({ ...call, ...change }, NOW);
      const { result, seen } = delivery(writes);
      expect(result.kind).toBe("activity");
      expect(seen[0]?.issueId).toBe(issueId);
      expect(seen[0]?.conversationOwner).toBeUndefined();
      expect(seen[0]?.conversationOwnerRecordedAt).toBeUndefined();
    }
  });

  it.each([
    [undefined, undefined],
    [undefined, { conversationId: "another-owner" }],
    [{ grantId: "grant", principalId: "worker", workId: "work" }, { conversationId: "another-owner" }],
  ] as const)(
    "drops ambiguous owners while preserving existing receipt provenance %#",
    (worker, otherOwner) => {
      const writes = new LinearWriteReceipts();
      writes.record({ ...call, ...(worker ? { worker } : {}) }, NOW);
      writes.record({ ...call, owner: otherOwner, ...(worker ? { worker } : {}) }, NOW);
      const { result, seen } = delivery(writes);
      expect(seen[0]?.conversationOwner).toBeUndefined();
      expect(seen[0]?.conversationOwnerRecordedAt).toBeUndefined();
      if (worker) {
        expect(result.kind).toBe("activity");
        expect(seen[0]?.worker).toEqual(worker);
      } else expect(result).toEqual({ kind: "ignored", reason: "self_echo" });
    },
  );
});

describe("exact status update reply recipients", () => {
  const updateId = "d9b90f52-0b0e-463d-a1e9-9457d250592c";
  const commentId = "0707b479-8a50-4496-b6ba-bec2efbd0a1f";
  const organizationId = "75f1d1f0-542b-4095-9967-fd7b27093472";
  const account: ProviderAccount = {
    provider: "linear",
    connectionId: "native-linear",
    userId: "clankie",
    workspaceId: organizationId,
    name: "Clankie",
    email: "bot@example.test",
    workspaceName: "Vuhlp",
    verifiedAt: NOW.toISOString(),
  };
  const native: LinearRecipient = {
    kind: "native",
    paneId: "pc/w3:pK",
    seatId: "kh2-native-claude",
    occupantId: "claude:kh2-session",
    binding: "a".repeat(64),
  };
  function write(type = "project", recipient: LinearRecipient | undefined = native) {
    return {
      server: "linear",
      tool: "save_status_update",
      arguments: { type },
      content: JSON.stringify({
        id: updateId,
        type,
        updatedAt: NOW.toISOString(),
        body: "Status",
        user: { id: "clankie" },
      }),
      isError: false,
      account,
      recipient,
    };
  }
  function classify(
    writes: LinearWriteReceipts,
    type = "project",
    data: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ) {
    const parentFields =
      type === "initiative"
        ? { initiativeUpdateId: updateId, initiativeUpdate: { id: updateId, userId: "clankie" } }
        : { projectUpdateId: updateId, projectUpdate: { id: updateId, userId: "clankie" } };
    const body = commentBody(
      { organizationId, actor: { id: "james", type: "user" }, ...overrides },
      {
        id: commentId,
        body: "I APPROVE all!!",
        ...parentFields,
        ...data,
      },
    );
    return classifyLinearDelivery({
      rawBody: Buffer.from(body),
      headers: { signature: sign(body), delivery: "reply", event: "Comment" },
      secret: SECRET,
      now: NOW,
      writes,
    });
  }

  it.each(["project", "initiative"])(
    "retains an exact %s update's remote native author across receipt restart",
    async (type) => {
      const root = await mkdtemp("/tmp/clankie-status-recipient-");
      const path = join(root, "writes.json");
      try {
        new LinearWriteReceipts(path).record(write(type), NOW);
        const resumed = new LinearWriteReceipts(path);
        const outcome = classify(resumed, type);
        expect(outcome).toMatchObject({
          kind: "activity",
          activity: {
            replyRecipient: {
              parentType: type === "project" ? "ProjectUpdate" : "InitiativeUpdate",
              parentId: updateId,
              recipient: native,
              recordedAt: NOW.getTime(),
            },
            replyTo: { type: type === "project" ? "ProjectUpdate" : "InitiativeUpdate", id: updateId },
          },
        });
        expect(await readFile(path, "utf8")).not.toContain("Status");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("uses existing conversation ownership when a retained legacy write has no native author", () => {
    const writes = new LinearWriteReceipts();
    writes.record({ ...write(), recipient: undefined, owner: { conversationId: "work-owner" } }, NOW);
    expect(classify(writes)).toMatchObject({
      kind: "activity",
      activity: {
        replyRecipient: { recipient: { kind: "conversation", owner: { conversationId: "work-owner" } } },
      },
    });
  });

  it("stamps native ownership for an identifier-only comment from its exact signed revision before suppression", () => {
    const writes = new LinearWriteReceipts();
    const call = {
      server: "linear",
      tool: "save_comment",
      arguments: { issueId: "VUH-1611" },
      content: JSON.stringify({ id: commentId, body: "Result", updatedAt: NOW.toISOString() }),
      isError: false,
      account,
      recipient: native,
    };
    expect(linearWriteIssue(call)).toBeUndefined();
    writes.record(call, NOW);
    const body = commentBody(
      { organizationId, actor: { id: "clankie" } },
      {
        id: commentId,
        body: "Result",
        updatedAt: NOW.toISOString(),
        issueId: updateId,
        issue: { id: updateId },
      },
    );
    const seen: LinearActivityEvent[] = [];
    const receive = () =>
      classifyLinearDelivery({
        rawBody: Buffer.from(body),
        headers: { signature: sign(body), delivery: "native-write", event: "Comment" },
        secret: SECRET,
        now: NOW,
        writes,
        recordActivity: (event) => void seen.push(event),
      });
    expect(receive()).toEqual({ kind: "ignored", reason: "self_echo" });
    expect(seen[0]).toMatchObject({
      issueId: updateId,
      writeRecipient: native,
      writeRecipientRecordedAt: NOW.getTime(),
    });
    expect(seen[0]?.conversationOwner).toBeUndefined();
    writes.record({ ...call, recipient: { ...native, paneId: "pc/another" } }, NOW);
    expect(receive()).toEqual({ kind: "ignored", reason: "self_echo" });
    expect(seen[1]?.writeRecipient).toBeUndefined();
    expect(seen[1]?.writeRecipientRecordedAt).toBeUndefined();
  });

  it("ignores signed provider-selected recipients and refuses bad signatures before stamping", () => {
    const forged = {
      replyRecipient: {
        parentType: "ProjectUpdate",
        parentId: updateId,
        recipient: native,
        recordedAt: NOW.getTime(),
      },
      writeRecipient: native,
    };
    const withoutReceipt = classify(new LinearWriteReceipts(), "project", {}, forged);
    if (withoutReceipt.kind === "activity") {
      expect(withoutReceipt.activity.replyRecipient).toBeUndefined();
      expect(withoutReceipt.activity.writeRecipient).toBeUndefined();
    }
    const writes = new LinearWriteReceipts();
    writes.record(write(), NOW);
    const body = commentBody({ organizationId, ...forged }, { id: commentId, projectUpdateId: updateId });
    expect(
      classifyLinearDelivery({
        rawBody: Buffer.from(body),
        headers: { signature: "bad", delivery: "forged", event: "Comment" },
        secret: SECRET,
        now: NOW,
        writes,
      }),
    ).toEqual({ kind: "rejected", reason: "bad_signature" });
  });

  it("never resolves parent identity from prefixes, URLs, or conflicting signed IDs", () => {
    const writes = new LinearWriteReceipts();
    writes.record(write(), NOW);
    for (const data of [
      { projectUpdateId: "d9b90f52", projectUpdate: {} },
      { projectUpdateId: updateId, projectUpdate: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
      { initiativeUpdateId: updateId, initiativeUpdate: { id: updateId } },
      { projectUpdateId: undefined, projectUpdate: undefined },
      { id: "0707b479" },
    ]) {
      const result = classify(writes, "project", data, {
        url: "https://linear.app/work/project/kh2/activity#project-update-d9b90f52&comment-0707b479",
        replyRecipient: { recipient: native },
      });
      expect(result.kind).toBe("activity");
      if (result.kind === "activity") expect(result.activity.replyRecipient).toBeUndefined();
    }
    expect(
      linearActivityUpdateParent({ type: "Comment", data: { projectUpdateId: updateId.toUpperCase() } }),
    ).toEqual({ parentType: "ProjectUpdate", parentId: updateId });
  });

  it("leaves missing or conflicting recipients in the inbox without changing own echo suppression", () => {
    const writes = new LinearWriteReceipts();
    writes.record(write(), NOW);
    writes.record(write("project", { ...native, paneId: "pc/w3:other" }), NOW);
    expect(classify(writes)).toMatchObject({ kind: "activity" });
    const outcome = classify(writes);
    if (outcome.kind === "activity") expect(outcome.activity.replyRecipient).toBeUndefined();
    const self = classify(writes, "project", {}, { actor: { id: "clankie" } });
    if (self.kind === "activity") expect(self.activity.replyRecipient).toBeUndefined();
    const ownBody = commentBody(
      { type: "ProjectUpdate", actor: { id: "clankie" }, organizationId },
      { id: updateId, body: "Status", updatedAt: NOW.toISOString() },
    );
    expect(
      classifyLinearDelivery({
        rawBody: Buffer.from(ownBody),
        headers: { signature: sign(ownBody), delivery: "echo", event: "ProjectUpdate" },
        secret: SECRET,
        now: NOW,
        writes,
      }),
    ).toEqual({ kind: "ignored", reason: "self_echo" });
  });

  it.each([
    { tool: "get_status_update" },
    { arguments: { type: "initiative" } },
    {
      arguments: {},
      content: JSON.stringify({ id: updateId, updatedAt: NOW.toISOString(), body: "Status" }),
    },
    {
      content: JSON.stringify({
        id: updateId,
        type: "project",
        createdAt: NOW.toISOString(),
        body: "Status",
      }),
    },
    {
      content: JSON.stringify({
        id: "d9b90f52",
        type: "project",
        updatedAt: NOW.toISOString(),
        body: "Status",
      }),
    },
    { isError: true },
    { account: undefined },
  ])("does not retain ownership from unproven status writes %#", (change) => {
    const writes = new LinearWriteReceipts();
    writes.record({ ...write(), ...change }, NOW);
    const outcome = classify(writes);
    expect(outcome.kind).toBe("activity");
    if (outcome.kind === "activity") expect(outcome.activity.replyRecipient).toBeUndefined();
  });
});
