import { expect, it } from "vitest";
import { ClankieSettingsSchema } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { linearRoutes, linearWakeRoutes } from "../src/app/linear-routes.ts";
it("authenticates, validates and persists live wake rules without changing following", async () => {
  let settings = ClankieSettingsSchema.parse({ schemaVersion: 1, linearWebhook: { following: true } });
  const { app, close } = await createClankieApp({
    captain: createStubCaptain(),
    extensionRoutes: [linearWakeRoutes({})],
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
    const snapshot = await (await app.request("/v1/linear/wake", { headers })).json();
    const response = await app.request("/v1/linear/wake", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        expectedRevision: snapshot.revision,
        wake: { actors: ["self", "users"], userIds: ["human-id"], notificationTypes: ["issueMention"] },
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

it("switches wake routes independently of Linear's mirror and cutover routes", async () => {
  const settings = ClankieSettingsSchema.parse({ schemaVersion: 1 });
  for (const wakeOn of [false, true]) {
    const { app, close } = await createClankieApp({
      captain: createStubCaptain(),
      extensionRoutes: [linearRoutes({}, false), ...(wakeOn ? [linearWakeRoutes({})] : [])],
      settings: { load: async () => settings },
      authenticateOperator: async () => ({ operatorId: "test" }),
    });
    try {
      expect((await app.request("/v1/linear/wake")).status).toBe(wakeOn ? 200 : 404);
      expect((await app.request("/v1/linear/deliveries")).status).toBe(wakeOn ? 200 : 404);
      expect((await app.request("/v1/hooks/linear", { method: "POST" })).status).toBe(wakeOn ? 503 : 404);
      // Both compositions still mount the tracker route; no mirror is configured here.
      expect(
        (
          await app.request("/v1/tracker/mirror/linear", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              projectId: "11111111-1111-4111-8111-111111111111",
              scratch: "test",
              action: "status",
            }),
          })
        ).status,
      ).toBe(503);
    } finally {
      close();
    }
  }
});
