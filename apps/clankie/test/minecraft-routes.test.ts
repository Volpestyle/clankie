import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { BodyLeaseStore } from "../src/body-leases.ts";
import type { BodyConversationIdentity } from "../src/body-lease-router.ts";
import { MinecraftService } from "../src/minecraft.ts";
import { createMinecraftRoutes } from "../src/minecraft-routes.ts";
import { FakeMinecraftPort } from "./minecraft-fake.ts";

const identity: BodyConversationIdentity = {
  conversationId: "operator-friends",
  current: () => true,
  authorize: async () => true,
};
function command(app: ReturnType<typeof createMinecraftRoutes>, body: unknown) {
  return app.request("/v1/minecraft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("requires operator authority for reads/configuration/commands and bounds input", async () => {
  const authorize = vi.fn().mockResolvedValue(undefined);
  const app = createMinecraftRoutes({ authorize });
  expect((await app.request("/v1/minecraft")).status).toBe(403);
  expect((await app.request("/v1/minecraft/configuration")).status).toBe(403);
  expect((await command(app, { action: "join", profileId: "paper" })).status).toBe(403);
  authorize.mockResolvedValue(identity);
  expect((await command(app, { action: "join", profileId: "paper", host: "public.example" })).status).toBe(
    400,
  );
  expect(
    (await command(app, { action: "act", request: { type: "chat", text: "x".repeat(40_000) } })).status,
  ).toBe(413);
  expect((await command(app, { action: "status" })).status).toBe(503);
});

it("stores owner configuration separately from the safe body profiles and rechecks revocation before persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minecraft-routes-settings-"));
  try {
    const settings = new SettingsStore(join(dir, "settings.json"));
    const app = createMinecraftRoutes({ settings, authorize: async () => identity });
    const configuration = {
      profiles: [{ id: "paper", name: "Paper", host: "127.0.0.1", version: "1.21.4" }],
    };
    const response = await app.request("/v1/minecraft/configuration", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(configuration),
    });
    expect(response.status).toBe(200);
    expect((await settings.load()).minecraft.profiles[0]).toMatchObject({
      host: "127.0.0.1",
      auth: "offline",
    });
    const invalid = await app.request("/v1/minecraft/configuration", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...configuration, secret: "account-token" }),
    });
    expect(invalid.status).toBe(400);
    let checks = 0;
    const revoking = createMinecraftRoutes({
      settings,
      authorize: async () => ({ ...identity, authorize: async () => ++checks < 3 }),
    });
    const refused = await revoking.request("/v1/minecraft/configuration", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profiles: [] }),
    });
    expect(refused.status).toBe(403);
    expect((await settings.load()).minecraft.profiles).toHaveLength(1);
    const readOnly = createMinecraftRoutes({
      settings: { load: () => settings.load() },
      authorize: async () => identity,
    });
    expect(
      (
        await readOnly.request("/v1/minecraft/configuration", {
          method: "PUT",
          body: JSON.stringify(configuration),
        })
      ).status,
    ).toBe(503);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("dispatches typed operations with captured conversation authority and retains play until exact disconnect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minecraft-routes-body-"));
  const store = new BodyLeaseStore(join(dir, "leases"));
  try {
    const port = new FakeMinecraftPort([{ id: "paper", name: "Paper" }]);
    const service = new MinecraftService({ port, store, path: join(dir, "minecraft.json") });
    const app = createMinecraftRoutes({ service, authorize: async () => identity });
    const profileResult = await command(app, { action: "profiles" });
    expect(await profileResult.json()).toEqual({ profiles: [{ id: "paper", name: "Paper" }] });
    const joinResult = await command(app, { action: "join", profileId: "paper" });
    const joined = await joinResult.json();
    expect(joinResult.status).toBe(200);
    port.confirmJoined(joined.session);
    const action = await command(app, {
      action: "act",
      actionId: "follow-1",
      request: { type: "follow", player: "James", distance: 2 },
    });
    expect(await action.json()).toMatchObject({ actionId: "follow-1", state: "running" });
    const status = await command(app, { action: "status" });
    expect(await status.json()).toMatchObject({ actions: [{ actionId: "follow-1" }] });
    const stranger = createMinecraftRoutes({
      service,
      authorize: async () => ({ ...identity, conversationId: "other" }),
    });
    expect((await command(stranger, { action: "leave" })).status).toBe(409);
    expect((await command(app, { action: "cancel" })).status).toBe(200);
    expect((await command(app, { action: "leave" })).status).toBe(200);
    expect(store.status("play")).toMatchObject({ conversationId: "operator-friends" });
    port.confirmDisconnected(joined.session);
    await command(app, { action: "status" });
    expect(store.status("play")).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
