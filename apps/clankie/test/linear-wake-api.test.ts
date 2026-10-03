import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinearAttributionJournal } from "../src/linear-attribution.ts";
import { LinearNotifications } from "../src/linear-notifications.ts";
import type { LinearActivityEvent } from "../src/linear-webhook.ts";
import { expect, it } from "vitest";
import { ClankieSettingsSchema, LinearWakeSettingsSchema } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
it("authenticates, validates and persists live wake rules without changing following", async () => {
  let settings = ClankieSettingsSchema.parse({ schemaVersion: 1, linearWebhook: { following: true } });
  const { app, close } = await createClankieApp({
    captain: createStubCaptain(),
    settings: { load: async () => settings, update: async (mutate) => (settings = mutate(settings)) },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer test" ? { operatorId: "test" } : undefined,
  });
  try {
    for (const method of ["GET", "PUT"])
      expect((await app.request("/v1/linear/wake", { method })).status).toBe(401);
    const headers = { authorization: "Bearer test", "content-type": "application/json" };
    expect(await (await app.request("/v1/linear/wake", { headers })).json()).toMatchObject({
      wake: { actors: ["owner"], excludedNotificationTypes: ["issueSubscribed"] },
    });
    for (const body of [
      "null",
      '{"actors":["everyone"]}',
      '{"userIds":"name"}',
      '{"unknown":true}',
      "{broken",
    ])
      expect((await app.request("/v1/linear/wake", { method: "PUT", headers, body })).status).toBe(400);
    const response = await app.request("/v1/linear/wake", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        actors: ["self", "users"],
        userIds: ["human-id"],
        notificationTypes: ["issueMention"],
      }),
    });
    expect(response.status).toBe(200);
    expect(await (await app.request("/v1/linear/wake", { headers })).json()).toEqual(await response.json());
    expect(settings.linearWebhook.following).toBe(true);
    expect(settings.linearWebhook.wake.actors).toEqual(["self", "users"]);
  } finally {
    close();
  }
});

it("attributes actor-less MCP notifications through the signed route before waking, while collecting every item", async () => {
  const root = mkdtempSync(join(tmpdir(), "linear-wake-integration-"));
  const journal = new LinearAttributionJournal(join(root, "journal.json"));
  const now = new Date("2026-10-03T01:00:00.000Z");
  const notifications: { id: string; type: string; createdAt: string; url: string }[] = [];
  const received: { activity: LinearActivityEvent; wake: boolean }[] = [];
  let rules = LinearWakeSettingsSchema.parse({ ownerUserIds: ["owner"] });
  const own = {
    binding: "app",
    account: {
      provider: "linear" as const,
      userId: "bot",
      workspaceId: "org",
      connectionId: "connection",
      name: "Clankie",
      email: "bot@example.test",
      workspaceName: "Personal",
      verifiedAt: now.toISOString(),
    },
  };
  const receive = (activity: LinearActivityEvent, wake: boolean) => {
    received.push({ activity, wake });
  };
  const poller = new LinearNotifications({
    path: join(root, "notifications.json"),
    now: () => now,
    host: {
      account: async () => own,
      call: async () => ({
        outcome: "ok",
        content: JSON.stringify({ notifications, hasNextPage: false }),
        isError: false,
      }),
    },
    following: async () => true,
    wakeRules: async () => rules,
    attribute: (item, organization) => journal.attribute(item, organization),
    receive,
    onError: () => {
      throw new Error("notification read failed");
    },
  });
  const { app, close } = await createClankieApp({
    captain: createStubCaptain({ receiveLinearActivity: receive }),
    clock: () => now,
    linearWebhook: {
      secret: async () => "secret",
      recordActivity: (activity) => journal.record(activity, now),
    },
  });
  try {
    const cases = [
      { id: "owner", actor: "owner", actorType: "user", type: "issueNewComment", expected: true },
      { id: "self", actor: "bot", actorType: "app", type: "issueNewComment", expected: false },
      { id: "other", actor: "other", actorType: "user", type: "issueNewComment", expected: false },
      { id: "subscription", actor: "owner", actorType: "user", type: "issueSubscribed", expected: false },
      { id: "unknown", actor: undefined, actorType: undefined, type: "issueNewComment", expected: false },
      { id: "self-opt-in", actor: "bot", actorType: "app", type: "issueNewComment", expected: true },
    ];
    for (const [index, sample] of cases.entries()) {
      if (sample.id === "self-opt-in") rules = LinearWakeSettingsSchema.parse({ actors: ["self"] });
      const url = `https://linear.app/workspace/issue/ABC-${index + 1}/title#comment-${sample.id}`;
      const body = JSON.stringify({
        type: sample.type === "issueSubscribed" ? "Issue" : "Comment",
        action: "create",
        organizationId: "org",
        createdAt: now.toISOString(),
        webhookTimestamp: now.getTime(),
        url,
        actor: { id: sample.actor, type: sample.actorType },
        data: { id: sample.id },
      });
      expect(
        (
          await app.request("/v1/hooks/linear", {
            method: "POST",
            body,
            headers: { "linear-signature": createHmac("sha256", "secret").update(body).digest("hex") },
          })
        ).status,
      ).toBe(200);
      notifications.push({ id: sample.id, type: sample.type, url, createdAt: "2026-10-03T01:00:00.400Z" });
      await poller.poll();
      expect(received.filter((item) => item.activity.notification).at(-1)).toMatchObject({
        wake: sample.expected,
        activity: { actorId: sample.actor, data: { id: sample.id } },
      });
    }
    expect(received.filter((item) => item.activity.notification)).toHaveLength(6);
    expect(received.filter((item) => !item.activity.notification).every((item) => !item.wake)).toBe(true);
  } finally {
    await poller.close();
    close();
    rmSync(root, { recursive: true, force: true });
  }
});
