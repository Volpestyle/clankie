import { createHmac } from "node:crypto";
import { ClankieSettingsSchema, type ClankieSettings } from "@clankie/settings";
import { describe, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { seatEventKindFor } from "../src/captain/captain.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import {
  LinearDeliveryMemory,
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

async function hookApp(following = true) {
  const wakes: LinearActivityEvent[] = [];
  const inbox: LinearActivityEvent[] = [];
  const clankie = await createClankieApp({
    captain: createStubCaptain({
      receiveLinearActivity: (comment, following) => {
        inbox.push(comment);
        if (following) wakes.push(comment);
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
    linearWebhook: { secret: () => Promise.resolve(SECRET) },
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
  return { post, wakes, inbox };
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

describe("linear delivery memory", () => {
  it("forgets the oldest delivery rather than growing without bound", () => {
    const deliveries = new LinearDeliveryMemory();
    for (let index = 0; index < 600; index += 1) expect(deliveries.admit(`d-${index}`)).toBe(true);

    // Evicted, so a very old retry is admitted again — one duplicate wake is the
    // deliberate price of a bounded memory.
    expect(deliveries.admit("d-0")).toBe(true);
    expect(deliveries.admit("d-599")).toBe(false);
  });
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
  it("keeps hooks out of the bound head seat and preserves other wake routing", () => {
    expect(seatEventKindFor({ internal: true, origin: "hook" }, true)).toBeUndefined();
    expect(seatEventKindFor({ internal: true, origin: "hook" }, false)).toBeUndefined();
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
