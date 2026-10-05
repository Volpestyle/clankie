import { expect, it } from "vitest";
import { ClankieSettingsSchema } from "@clankie/settings";
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
