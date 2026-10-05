import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ClankieApiClient } from "@clankie/api-client";
import {
  tryHandleDiscordDirectoryRequest,
  tryHandleDiscordSetupRequest,
} from "@clankie/discord-presence-core";
import { readDiscordBodyPermissions } from "../../clankie/src/discord-setup-body.ts";
import { SettingsStore } from "@clankie/settings";
import { DiscordUserGateway } from "../src/gateway.ts";
import { readDiscordBodyDirectory } from "../../clankie/src/discord-directory.ts";
import { createDiscordRoomRoutes } from "../../clankie/src/discord-room-routes.ts";
import { DiscordRoomObservations } from "../../clankie/src/discord-room-observations.ts";

const servers: Server[] = [];
const sockets: WebSocketServer[] = [];
const gateways: DiscordUserGateway[] = [];
const roots: string[] = [];
afterEach(async () => {
  gateways.splice(0).forEach((gateway) => gateway.close());
  await Promise.all(
    sockets.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const guild = {
  id: "10001",
  name: "Studio",
  owner_id: "39999",
  unavailable: false,
  roles: [
    { id: "10001", name: "@everyone", permissions: "1024" },
    { id: "10002", name: "Builders", permissions: "0" },
  ],
  members: [
    { user: { id: "30001", username: "Clankie" }, roles: ["10002"] },
    { user: { id: "30002", username: "James" }, nick: "James", roles: [] },
  ],
  channels: [
    { id: "20001", name: "general", type: 0, permission_overwrites: [] },
    {
      id: "20002",
      name: "dev",
      type: 0,
      permission_overwrites: [
        { id: "10001", type: 0, allow: "0", deny: "1024" },
        { id: "10002", type: 0, allow: "1024", deny: "0" },
      ],
    },
    {
      id: "20003",
      name: "secret-room",
      type: 0,
      permission_overwrites: [{ id: "10001", type: 0, allow: "0", deny: "1024" }],
    },
    {
      id: "20004",
      name: "member-hidden",
      type: 0,
      permission_overwrites: [{ id: "30001", type: 1, allow: "0", deny: "1024" }],
    },
    { id: "20005", name: "missing-permission-data", type: 0 },
    { id: "20006", name: "private-thread", type: 12, permission_overwrites: [] },
  ],
  voice_states: [],
};
async function fixture() {
  const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  sockets.push(ws);
  await once(ws, "listening");
  const address = ws.address();
  if (!address || typeof address === "string") throw Error("No WS loopback address");
  let socket: WebSocket | undefined;
  ws.on("connection", (client) => {
    socket = client;
    client.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
    client.send(
      JSON.stringify({
        op: 0,
        t: "READY",
        d: {
          user: { id: "30001", username: "Clankie" },
          guilds: [{ id: "10001", unavailable: true }],
          session_id: "synthetic-session",
        },
      }),
    );
    client.send(JSON.stringify({ op: 0, t: "GUILD_CREATE", d: guild }));
  });
  const gateway = new DiscordUserGateway({
    token: "synthetic-user-token",
    url: `ws://127.0.0.1:${address.port}`,
  });
  gateways.push(gateway);
  let connected = false;
  gateway.on("ready", () => {
    connected = true;
  });
  gateway.on("disconnected", () => {
    connected = false;
  });
  const packet = (type: string) =>
    new Promise<void>((resolve) => {
      const unsubscribe = gateway.on("raw", (frame) => {
        if (frame.t === type) {
          unsubscribe();
          resolve();
        }
      });
    });
  const created = packet("GUILD_CREATE");
  gateway.open();
  await created;
  const body = createServer((request, response) => {
    if (
      tryHandleDiscordSetupRequest(request, response, {
        token: "fixture-user-bridge",
        read: (query) => gateway.readPermissions(query, connected),
        post: async () => {
          throw new Error("This read-only gateway fixture must never post");
        },
      })
    )
      return;
    if (
      !tryHandleDiscordDirectoryRequest(request, response, {
        token: "fixture-user-bridge",
        read: (query) => gateway.readDirectory(query, connected),
      })
    ) {
      response.writeHead(404);
      response.end();
    }
  });
  servers.push(body);
  body.listen(0, "127.0.0.1");
  await once(body, "listening");
  const bodyAddress = body.address();
  if (!bodyAddress || typeof bodyAddress === "string") throw Error("No body loopback address");
  const root = mkdtempSync(join(tmpdir(), "user-directory-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, activeBody: "user_session" },
  }));
  const app = createDiscordRoomRoutes({
    settings,
    environment: {},
    observations: new DiscordRoomObservations(join(root, "rooms.json")),
    captain: { serveOperatorConversation: async () => ({ schemaVersion: 1, op: "list", conversations: [] }) },
    authorize: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-operator"
        ? { current: () => true, guard: async () => {} }
        : undefined,
    directory: (query, activeBody) =>
      readDiscordBodyDirectory(query, {
        body: activeBody,
        env: {
          CLANKIE_USER_SESSION_CONTROL_PORT: String(bodyAddress.port),
          CLANKIE_DISCORD_BRIDGE_CONTROL_PORT: String(bodyAddress.port),
        },
        token: "fixture-user-bridge",
      }),
  });
  const client = new ClankieApiClient({
    baseUrl: "http://fixture.invalid",
    operatorToken: "fixture-operator",
    fetchImpl: async (url, init) => app.request(new Request(String(url), init)),
  });
  return {
    client,
    gateway,
    settings,
    app,
    permissions: (channelId: string) =>
      readDiscordBodyPermissions(
        { channelId },
        {
          body: "user_session",
          env: { CLANKIE_USER_SESSION_CONTROL_PORT: String(bodyAddress.port) },
          token: "fixture-user-bridge",
        },
      ),
    async send(type: string, data: unknown) {
      const received = packet(type);
      socket!.send(JSON.stringify({ op: 0, t: type, d: data }));
      await received;
    },
  };
}
it("real gateway dispatches reach the API with account-visible servers, channels, roles and known people", async () => {
  const f = await fixture();
  expect(await f.client.discordDirectory()).toMatchObject({
    body: "user_session",
    state: "connected",
    entries: [{ id: "10001", name: "Studio", kind: "server" }],
  });
  const channels = await f.client.discordDirectory({ kind: "channels", guildId: "10001" });
  expect(channels).toMatchObject({ state: "partial", reason: "permissions_unknown" });
  expect(channels.entries.map((entry) => entry.name)).toEqual(["general", "dev"]);
  expect(JSON.stringify(channels)).not.toMatch(
    /secret-room|member-hidden|private-thread|missing-permission-data/u,
  );
  expect(
    (await f.client.discordDirectory({ kind: "roles", guildId: "10001" })).entries.map((entry) => entry.name),
  ).toEqual(["@everyone", "Builders"]);
  expect(await f.client.discordDirectory({ kind: "people", guildId: "10001" })).toMatchObject({
    state: "partial",
    reason: "people_not_fully_loaded",
    entries: [{ name: "Clankie" }, { name: "James" }],
  });
});
it("the user account's actual gateway packets drive permission evidence across body HTTP", async () => {
  const f = await fixture();
  expect((await f.permissions("20001")).permissions.send_messages).toBe("failed");
  await f.send("GUILD_ROLE_UPDATE", {
    guild_id: "10001",
    role: { id: "10002", name: "Builders", permissions: "536872960" },
  });
  await f.send("GUILD_UPDATE", { id: "10001", mfa_level: 0 });
  expect((await f.permissions("20002")).permissions).toMatchObject({
    view_channel: "passed",
    send_messages: "passed",
    manage_webhooks: "passed",
  });
  await f.send("CHANNEL_UPDATE", {
    guild_id: "10001",
    id: "20002",
    permission_overwrites: [{ id: "30001", type: 1, allow: "0", deny: "536872960" }],
  });
  expect((await f.permissions("20002")).permissions).toMatchObject({
    send_messages: "failed",
    manage_webhooks: "failed",
  });
  expect((await f.permissions("20005")).permissions.send_messages).toBe("not_checked");
  await f.send("GUILD_UPDATE", { id: "10001", mfa_level: 1 });
  expect((await f.permissions("20001")).permissions.manage_webhooks).toBe("not_checked");
  await f.send("READY", { user: { id: "30009", username: "New account" }, guilds: [], session_id: "new" });
  expect((await f.permissions("20001")).permissions.send_messages).toBe("not_checked");
});
it("live membership changes and a fresh READY remove stale account visibility", async () => {
  const f = await fixture();
  await f.send("GUILD_MEMBER_UPDATE", { guild_id: "10001", user: { id: "30001" }, roles: [] });
  expect(
    (await f.client.discordDirectory({ kind: "channels", guildId: "10001" })).entries.map(
      (entry) => entry.name,
    ),
  ).toEqual(["general"]);
  await f.send("GUILD_DELETE", { id: "10001" });
  expect(await f.client.discordDirectory({ kind: "roles", guildId: "10001" })).toMatchObject({
    state: "unavailable",
    reason: "server_unavailable",
    entries: [],
  });
  await f.send("READY", { user: { id: "30009", username: "New account" }, guilds: [], session_id: "new" });
  expect(await f.client.discordDirectory()).toMatchObject({ state: "connected", entries: [] });
});
