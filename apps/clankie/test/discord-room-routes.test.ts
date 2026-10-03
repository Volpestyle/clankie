import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDiscordRoomRoutes, discordSettingsRevision } from "../src/discord-room-routes.ts";
import { DiscordRoomObservations } from "../src/discord-room-observations.ts";
import { SettingsStore, emptySettings } from "@clankie/settings";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "room-routes-"));
  roots.push(root);
  let allowed = true;
  let onRead = () => {};
  const settings = new SettingsStore(join(root, "settings.json"));
  const observations = new DiscordRoomObservations(join(root, "rooms.json"));
  const app = createDiscordRoomRoutes({
    observations,
    settings,
    authorize: async () =>
      allowed
        ? {
            current: () => allowed,
            guard: async () => {
              if (!allowed) throw Error("revoked");
            },
          }
        : undefined,
    captain: {
      serveOperatorConversation: async (request) => {
        onRead();
        return request.op === "get"
          ? { schemaVersion: 1, op: "get" }
          : { schemaVersion: 1, op: "list", conversations: [] };
      },
    },
  });
  return {
    app,
    settings,
    revoke: () => {
      allowed = false;
    },
    onRead: (fn: () => void) => {
      onRead = fn;
    },
  };
}
it("denies room output if authorization changes during registry read", async () => {
  const f = fixture();
  f.onRead(f.revoke);
  expect((await f.app.request("/v1/discord/rooms")).status).toBe(403);
});
it("settings writes are revision fenced", async () => {
  const f = fixture();
  const current = emptySettings().discord;
  const post = () =>
    f.app.request("/v1/discord/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: discordSettingsRevision(current),
        settings: { ...current, ingressContextMessages: 2 },
      }),
    });
  expect((await post()).status).toBe(200);
  expect((await post()).status).toBe(409);
});
it("SettingsStore final guard rejects revocation after the write was queued, before rename", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = f.settings.update(
    (value) => value,
    async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  );
  await ready;
  const response = f.app.request("/v1/discord/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: discordSettingsRevision(emptySettings().discord),
      settings: { ...emptySettings().discord, voiceEnabled: true },
    }),
  });
  f.revoke();
  release();
  await first;
  expect((await response).status).toBe(403);
  expect((await f.settings.load()).discord.voiceEnabled).toBe(false);
});
