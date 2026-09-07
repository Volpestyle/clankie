import { createHmac } from "node:crypto";
import { ClankieSettingsSchema } from "@clankie/settings";
import { describe, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { seatEventKindFor } from "../src/captain/captain.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import {
  LinearDeliveryMemory,
  linearCommentWakePrompt,
  suggestSeatForIssue,
  type LinearCommentEvent,
} from "../src/linear-webhook.ts";

/**
 * Signed Linear comment ingest (ADR 0164). Every case drives the real route so
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

async function hookApp() {
  const wakes: LinearCommentEvent[] = [];
  const clankie = await createClankieApp({
    captain: createStubCaptain({
      wakeFromLinearComment: (comment) => {
        wakes.push(comment);
      },
    }),
    settings: {
      load: () =>
        Promise.resolve(
          ClankieSettingsSchema.parse({
            schemaVersion: 1,
            linearWebhook: { actorEmail: OWNER },
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
  return { post, wakes };
}

describe("linear comment ingress", () => {
  it("wakes the operator thread once for a signed comment from him", async () => {
    const { post, wakes } = await hookApp();
    const body = commentBody();

    const response = await post(body);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ingested: true });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      issueIdentifier: "VUH-1234",
      actorEmail: OWNER,
      body: "This one is blocked on the gateway header allowlist.",
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

  it("takes a verified delivery it will not act on without asking Linear to retry", async () => {
    const cases: readonly [string, string][] = [
      ["another author", commentBody({ actor: { id: "bot", name: "Clankie", email: "bot@example.com" } })],
      ["an edit rather than a new comment", commentBody({ action: "update" })],
      ["a different record type", commentBody({ type: "Issue" })],
    ];
    for (const [name, body] of cases) {
      const { post, wakes } = await hookApp();

      const response = await post(body);

      expect(response.status, name).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ingested: false });
      expect(wakes, name).toHaveLength(0);
    }
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

  it("drops every comment while no owner is configured, rather than admitting all of them", async () => {
    const wakes: LinearCommentEvent[] = [];
    const clankie = await createClankieApp({
      captain: createStubCaptain({
        wakeFromLinearComment: (comment) => {
          wakes.push(comment);
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

describe("the pane a comment suggests", () => {
  const seats = [
    { seatId: "seat-a", title: "VUH-1234 linear comment ingress" },
    { seatId: "seat-b", title: "mailbox wave", workingDirectory: "/Users/james/dev/clankie" },
  ];

  it("names the one seat already carrying the ticket", () => {
    expect(suggestSeatForIssue("VUH-1234", seats)).toBe("seat-a");
    expect(suggestSeatForIssue("vuh-1234", seats)).toBe("seat-a");
  });

  it("finds a ticket in the worktree a seat is sitting in", () => {
    expect(
      suggestSeatForIssue("VUH-905", [
        {
          seatId: "seat-c",
          title: "pokemmo",
          workingDirectory: "/Users/james/dev/clankie-worktrees/vuh-905",
        },
      ]),
    ).toBe("seat-c");
  });

  it("says nothing rather than guessing between two seats", () => {
    expect(
      suggestSeatForIssue("VUH-1234", [
        { seatId: "seat-a", title: "VUH-1234 one" },
        { seatId: "seat-b", title: "VUH-1234 two" },
      ]),
    ).toBeUndefined();
    expect(suggestSeatForIssue(undefined, seats)).toBeUndefined();
    expect(suggestSeatForIssue("VUH-9999", seats)).toBeUndefined();
  });
});

describe("the prompt a comment becomes", () => {
  const comment: LinearCommentEvent = {
    deliveryId: "delivery-1",
    actorName: "James",
    actorEmail: OWNER,
    body: "ship the header allowlist first",
    issueIdentifier: "VUH-1234",
    issueTitle: "Linear comment ingress",
    url: "https://linear.app/vuhlp/issue/VUH-1234#comment-abc",
  };

  it("quotes him as untrusted text and forbids dispatching a pane", () => {
    const prompt = linearCommentWakePrompt(comment, "seat-a");

    expect(prompt).toContain("VUH-1234");
    expect(prompt).toContain("> ship the header allowlist first");
    expect(prompt).toContain("untrusted");
    expect(prompt).toMatch(/do not prompt or dispatch any\npane/iu);
    expect(prompt).toContain("seat-a");
  });

  it("bounds a comment long enough to cost a turn real money", () => {
    const prompt = linearCommentWakePrompt({ ...comment, body: "x".repeat(10_000) }, undefined);

    expect(prompt.length).toBeLessThan(5_000);
    expect(prompt).toContain("…");
  });
});

describe("where a hook's wake is delivered", () => {
  it("reaches the seat he is sitting in, the way a watch does", () => {
    // Otherwise a Linear comment would open a second turn somewhere he is not
    // looking, while a settled watch reaches him in his pane.
    expect(seatEventKindFor({ internal: true, origin: "hook" }, true)).toBe("wake");
    expect(seatEventKindFor({ internal: true, origin: "hook" }, false)).toBe("wake");
  });

  it("leaves every other origin's delivery exactly as it was", () => {
    expect(seatEventKindFor({ internal: true, origin: "watch" }, false)).toBe("watch");
    expect(seatEventKindFor({ internal: true, origin: "wake" }, false)).toBe("wake");
    expect(seatEventKindFor({ internal: true, origin: "goal" }, true)).toBeUndefined();
    expect(seatEventKindFor({}, true)).toBe("escalation");
    expect(seatEventKindFor({}, false)).toBeUndefined();
  });
});
