import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createDiscordRoomRoutes,
  discordRoomDisplayTitle,
  discordSettingsRevision,
} from "../src/discord-room-routes.ts";
import { DiscordRoomObservations } from "../src/discord-room-observations.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
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
it("lists canonical rooms and applies guidance to the parent while keeping handoff children inspectable", async () => {
  const root = mkdtempSync(join(tmpdir(), "room-handoff-routes-"));
  roots.push(root);
  const conversations = new ConversationStore(join(root, "conversations"), async () => {});
  const roomId = conversations.roomConversation("discord_presence", "123:456");
  conversations.nameRoomConversation(roomId, "Discord text · Friends / #general");
  const children = (["text", "voice"] as const).map((source) =>
    conversations.beginRoomHandoff(
      {
        roomConversationId: roomId,
        deliveryId: `discord:${source}`,
        actorId: "789",
        actorName: "James",
        source,
        request: `Investigate ${source} request`,
        state: "running",
        host: "pi",
      },
      `fingerprint-${source}`,
    ),
  );
  const observations = new DiscordRoomObservations(join(root, "rooms.json"));
  const app = createDiscordRoomRoutes({
    observations,
    settings: new SettingsStore(join(root, "settings.json")),
    captain: {
      serveOperatorConversation: (request) =>
        conversations.serve(request as Parameters<typeof conversations.serve>[0]),
    },
    authorize: async () => ({ current: () => true, guard: async () => {} }),
  });
  const list = await app.request("/v1/discord/rooms");
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({
    rooms: [{ conversationId: roomId, title: "#general · Friends", targetId: "123:456" }],
  });
  const guidance = (conversationId: string) =>
    app.request("/v1/discord/room-guidance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, expectedRevision: 0, text: "Check the room before replying." }),
    });
  for (const child of children) {
    const rejected = await guidance(child.conversationId);
    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toEqual({ error: "room_not_found" });
    expect(observations.status(child.conversationId).guidance).toMatchObject({ revision: 0, state: "empty" });
    expect(
      await conversations.serve({ op: "get", schemaVersion: 1, conversationId: child.conversationId }),
    ).toMatchObject({
      op: "get",
      conversation: { conversationId: child.conversationId, roomHandoff: { roomConversationId: roomId } },
    });
  }
  expect((await guidance(roomId)).status).toBe(200);
  expect(await observations.consume(roomId, () => true)).toBe("Check the room before replying.");
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
it("leaves unrelated routes alone when mounted at the service root", async () => {
  const { Hono } = await import("hono");
  const parent = new Hono();
  parent.route("/", fixture().app);
  parent.post("/v1/seat/transcript", async (context) =>
    context.json({ size: (await context.req.text()).length }),
  );
  const body = "x".repeat(200 * 1024);
  const response = await parent.request("/v1/seat/transcript", { method: "POST", body });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBeNull();
  expect(await response.json()).toEqual({ size: body.length });
  expect((await parent.request("/v1/discord/settings", { method: "POST", body })).status).toBe(403);
});

it("lists a room by its place, never by raw Discord IDs", () => {
  expect(discordRoomDisplayTitle("Discord text · Friends / #general")).toBe("#general · Friends");
  expect(discordRoomDisplayTitle("Discord voice · Friends / Lobby")).toBe("Lobby · Friends");
  expect(discordRoomDisplayTitle("Discord DM · James")).toBe("James");
  expect(discordRoomDisplayTitle("Discord text · 866430493889134672 / #house-hunting")).toBe(
    "#house-hunting",
  );
  expect(discordRoomDisplayTitle("Discord text · 866430493889134672:866430493889134675")).toBeUndefined();
  expect(discordRoomDisplayTitle("Discord text · Friends / #866430493889134675")).toBeUndefined();
  expect(discordRoomDisplayTitle("Planning room")).toBe("Planning room");
});
