import { createStubCaptain } from "../src/captain/port.ts";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { publicGatewayTargetFor } from "@clankie/protocol/public-gateway";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { registerLinearRoutes } from "../src/app/linear-routes.ts";
import { runLinearCommand } from "../../tui/src/command/linear.ts";

it("uses one durable owner path for CLI follow/wake, fences stale revisions and rejects nonowners", async () => {
  const root = await mkdtemp(join(tmpdir(), "linear-owner-settings-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((value) => ({
    ...value,
    linearWebhook: { ...value.linearWebhook, url: "https://example.com/hooks/linear" },
  }));
  const app = new Hono();
  let authorized = true;
  let revokeAfterEntry = false;
  let checks = 0;
  registerLinearRoutes({
    app,
    settingsSource: settings,
    clock: () => new Date(),
    authorizeOwnerSettings: async (request) =>
      request.headers.get("authorization") === "Bearer owner" &&
      authorized &&
      (!revokeAfterEntry || ++checks < 2)
        ? true
        : "forbidden",
    dependencies: {
      captain: createStubCaptain(),
      linearWebhook: { secret: async () => "signed-webhook-secret" },
    },
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server");
  const host = `http://127.0.0.1:${address.port}`;
  const env = { CLANKIE_OPERATOR_TOKEN: "owner" };
  const options = { host, env };
  const headers = { authorization: "Bearer owner", "content-type": "application/json" };
  try {
    const before = await (await fetch(`${host}/v1/linear/wake`, { headers })).json();
    await runLinearCommand(["wake", "set", "--owner-user-ids", "james", "--actors", "owner,self"], options);
    expect((await settings.load()).linearWebhook.wake).toMatchObject({
      ownerUserIds: ["james"],
      actors: ["owner", "self"],
    });
    expect((await runLinearCommand(["follow", "on"], options)).following).toBe(true);
    const stale = await fetch(`${host}/v1/linear/wake`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: before.revision, wake: before.wake }),
    });
    expect(stale.status).toBe(409);
    expect((await settings.load()).linearWebhook.wake.ownerUserIds).toEqual(["james"]);
    expect(
      (await fetch(`${host}/v1/linear/follow`, { headers: { authorization: "Bearer worker" } })).status,
    ).toBe(403);
    for (const path of ["/v1/linear/follow", "/v1/linear/wake"]) {
      expect(hostedOperatorAllows("POST", path)).toBe(true);
      expect(publicGatewayTargetFor("POST", path)).toBe("relay");
      expect(hostedOperatorAllows("POST", `${path}?unexpected=1`)).toBe(false);
    }
    const snapshot = await (await fetch(`${host}/v1/linear/follow`, { headers })).json();
    revokeAfterEntry = true;
    checks = 0;
    expect(
      (
        await fetch(`${host}/v1/linear/follow`, {
          method: "POST",
          headers,
          body: JSON.stringify({ expectedRevision: snapshot.revision, following: false }),
        })
      ).status,
    ).toBe(409);
    expect((await settings.load()).linearWebhook.following).toBe(true);
    revokeAfterEntry = false;
    authorized = false;
    expect(
      (
        await fetch(`${host}/v1/linear/follow`, {
          method: "POST",
          headers,
          body: JSON.stringify({ expectedRevision: snapshot.revision, following: false }),
        })
      ).status,
    ).toBe(403);
    expect((await settings.load()).linearWebhook.following).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
