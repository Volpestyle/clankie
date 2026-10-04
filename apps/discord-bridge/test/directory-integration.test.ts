import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Client, ClientUser, Guild, GatewayIntentBits } from "discord.js";
import { ClankieApiClient } from "@clankie/api-client";
import { tryHandleDiscordDirectoryRequest } from "@clankie/discord-presence-core";
import { SettingsStore } from "@clankie/settings";
import {
  DiscordDirectoryRequestSchema,
  parseProtocolResponse,
  DiscordSettingsSchema,
  DiscordSettingsSnapshotSchema,
} from "@clankie/protocol";
import { hostedOperatorAllows } from "../../../packages/protocol/src/hosted-operator.ts";
import { readBotDiscordDirectory } from "../src/directory.ts";
import { readDiscordBodyDirectory } from "../../clankie/src/discord-directory.ts";
import { createDiscordRoomRoutes } from "../../clankie/src/discord-room-routes.ts";
import { DiscordRoomObservations } from "../../clankie/src/discord-room-observations.ts";
import { runDiscordCommand } from "../../tui/src/command/discord.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No loopback address");
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}
function botCache() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.user = Reflect.construct(ClientUser, [
    client,
    {
      id: "30001",
      username: "Clankie",
      discriminator: "0",
      avatar: null,
      bot: true,
    },
  ]) as ClientUser;
  let connected = true;
  client.isReady = (() => connected) as Client["isReady"];
  const raw = {
    id: "10001",
    name: "Studio",
    owner_id: "30002",
    unavailable: false,
    member_count: 10,
    roles: [
      { id: "10001", name: "@everyone", permissions: "1024", position: 0, color: 0 },
      { id: "10002", name: "Builders", permissions: "0", position: 1, color: 0 },
    ],
    members: [
      {
        user: { id: "30001", username: "Clankie", discriminator: "0", avatar: null, bot: true },
        roles: [],
        joined_at: "2026-10-04T12:00:00Z",
      },
      {
        user: { id: "30002", username: "James", discriminator: "0", avatar: null },
        roles: ["10002"],
        joined_at: "2026-10-04T12:00:00Z",
      },
    ],
    channels: [
      { id: "20001", guild_id: "10001", name: "general", type: 0, position: 0, permission_overwrites: [] },
      { id: "20002", guild_id: "10001", name: "dev", type: 0, position: 1, permission_overwrites: [] },
      {
        id: "20003",
        guild_id: "10001",
        name: "secret-room",
        type: 0,
        position: 2,
        permission_overwrites: [{ id: "10001", type: 0, allow: "0", deny: "1024" }],
      },
      { id: "20004", guild_id: "10001", name: "Talk", type: 2, position: 3, permission_overwrites: [] },
    ],
  };
  const guild = Reflect.construct(Guild, [client, raw]) as Guild;
  client.guilds.cache.set(guild.id, guild);
  return {
    client,
    guild,
    disconnect: () => {
      connected = false;
    },
  };
}
async function fixture() {
  const cache = botCache();
  const body = await listen(
    createServer((request, response) => {
      if (
        !tryHandleDiscordDirectoryRequest(request, response, {
          token: "fixture-bridge",
          read: (query) => readBotDiscordDirectory(cache.client, query),
        })
      ) {
        response.writeHead(404);
        response.end();
      }
    }),
  );
  const root = mkdtempSync(join(tmpdir(), "discord-directory-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  let allowed = true;
  let afterRead: () => void | Promise<void> = () => {};
  const app = createDiscordRoomRoutes({
    settings,
    machineName: "Fixture Mac",
    environment: {},
    observations: new DiscordRoomObservations(join(root, "rooms.json")),
    captain: { serveOperatorConversation: async () => ({ schemaVersion: 1, op: "list", conversations: [] }) },
    authorize: async (request) =>
      allowed &&
      ["Bearer fixture-operator", "Bearer fixture-device"].includes(
        request.headers.get("authorization") ?? "",
      )
        ? {
            current: () => allowed,
            guard: async () => {
              if (!allowed) throw Error("revoked");
            },
          }
        : undefined,
    directory: async (query, activeBody) => {
      const result = await readDiscordBodyDirectory(query, {
        body: activeBody,
        env: {
          CLANKIE_DISCORD_BRIDGE_CONTROL_PORT: String(body.port),
          CLANKIE_USER_SESSION_CONTROL_PORT: String(body.port),
        },
        token: "fixture-bridge",
      });
      await afterRead();
      return result;
    },
  });
  const fetchImpl: typeof fetch = async (url, init) => app.request(new Request(String(url), init));
  const client = new ClankieApiClient({
    baseUrl: "http://fixture.invalid",
    operatorToken: "fixture-operator",
    fetchImpl,
  });
  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: {
      authorize: async (token) =>
        allowed && token === "fixture-device"
          ? {
              authorized: true,
              device: {
                deviceId: "fixture-device",
                name: "Fixture phone",
                platform: "ios",
                grants: { chat: true, steer: false, terminalObserve: true, terminalControl: false },
                host: { name: "Fixture Mac" },
                sessionExpiresAt: "2026-10-05T00:00:00Z",
              },
            }
          : { authorized: false, denial: "revoked" },
    },
    dispatch: async () => {
      throw Error("Directory must not enter conversation dispatch");
    },
    roomRequest: async (path, method, token) =>
      app.request(path, { method, headers: { authorization: `Bearer ${token}` } }),
  });
  const relay = await listen(
    createServer((request, response) => {
      void handler(request, response).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
    }),
  );
  const remote = new ClankieApiClient({ baseUrl: relay.url, operatorToken: "fixture-device" });
  return {
    ...cache,
    app,
    settings,
    client,
    remote,
    fetchImpl,
    body,
    relay,
    revoke: () => {
      allowed = false;
    },
    afterRead: (callback: () => void | Promise<void>) => {
      afterRead = callback;
    },
  };
}
it("native bot cache, body HTTP, API, CLI and paired relay agree on visible names and kinds", async () => {
  const f = await fixture();
  expect((await f.client.discordDirectory()).entries).toEqual([
    { id: "10001", name: "Studio", kind: "server" },
  ]);
  const first = await f.remote.discordDirectory({ kind: "channels", guildId: "10001", limit: 1 });
  expect(first.entries).toEqual([{ id: "20001", name: "general", kind: "text", guildId: "10001" }]);
  expect(first).toMatchObject({ state: "partial", hasMore: true, nextCursor: "20001" });
  const rest = await f.remote.discordDirectory({
    kind: "channels",
    guildId: "10001",
    after: first.nextCursor,
  });
  expect(rest.entries.map((entry) => entry.name)).toEqual(["dev", "Talk"]);
  expect(rest.hasMore).toBe(false);
  const direct = await f.client.discordDirectory({ kind: "channels", guildId: "10001" });
  expect(
    await runDiscordCommand(["directory", "channels", "--server", "10001"], {
      host: "http://fixture.invalid",
      fetchImpl: f.fetchImpl,
      env: { CLANKIE_OPERATOR_TOKEN: "fixture-operator" },
    }),
  ).toEqual(direct);
  expect(JSON.stringify(direct)).not.toContain("secret-room");
  expect(
    (await f.remote.discordDirectory({ kind: "roles", guildId: "10001" })).entries.map((entry) => entry.name),
  ).toEqual(["@everyone", "Builders"]);
  expect(await f.remote.discordDirectory({ kind: "people", guildId: "10001" })).toMatchObject({
    state: "partial",
    reason: "people_not_fully_loaded",
    entries: [
      { name: "Clankie", kind: "bot" },
      { name: "James", kind: "person" },
    ],
  });
  expect(hostedOperatorAllows("GET", "/v1/discord/directory")).toBe(true);
  expect(hostedOperatorAllows("POST", "/v1/discord/directory")).toBe(false);
});
it("disconnection, inaccessible servers and input errors are explicit through the route", async () => {
  const f = await fixture();
  expect(await f.client.discordDirectory({ kind: "channels", guildId: "99999" })).toMatchObject({
    state: "unavailable",
    reason: "server_unavailable",
    entries: [],
  });
  expect(
    (
      await f.app.request("/v1/discord/directory?kind=channels", {
        headers: { authorization: "Bearer fixture-operator" },
      })
    ).status,
  ).toBe(400);
  await expect(runDiscordCommand(["directory", "people"], { env: {} })).rejects.toThrow("Choose a server");
  await expect(f.client.discordDirectory({ limit: 201 })).rejects.toThrow();
  expect((await fetch(`${f.body.url}/directory`)).status).toBe(403);
  expect((await f.app.request("/v1/discord/directory")).status).toBe(403);
  f.disconnect();
  expect(await f.remote.discordDirectory()).toMatchObject({
    state: "disconnected",
    reason: "runtime_not_connected",
    entries: [],
  });
});
it("remote directory output is withheld after authorization changes while reading the body", async () => {
  const f = await fixture();
  f.afterRead(f.revoke);
  await expect(f.remote.discordDirectory()).rejects.toThrow();
});
it("old settings readers survive additive nested fields through the same paired remote route", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({ ...current, discord: { ...current.discord, teamVisible: false } }));
  const response = await fetch(`${f.relay.url}/v1/discord/settings`, {
    headers: { authorization: "Bearer fixture-device" },
  });
  expect(response.status).toBe(200);
  const wire = await response.json();
  const old = DiscordSettingsSnapshotSchema.omit({ setup: true }).extend({
    settings: DiscordSettingsSchema.omit({ teamVisible: true }),
  });
  expect(old.safeParse(wire).success).toBe(false);
  expect(parseProtocolResponse(old, wire).settings).not.toHaveProperty("teamVisible");
  expect(wire.settings.teamVisible).toBe(false);
  expect(wire.setup.machineName).toBe("Fixture Mac");
});
it("unknown optional body response fields are stripped, while malformed known fields fail closed", async () => {
  const query = DiscordDirectoryRequestSchema.parse({});
  const valid = {
    schemaVersion: 1,
    body: "bot",
    kind: "servers",
    state: "connected",
    entries: [{ id: "10001", name: "Studio", kind: "server", futureColor: "blue" }],
    hasMore: false,
    futureAccount: "added",
  };
  const read = (response: unknown) =>
    readDiscordBodyDirectory(query, {
      body: "bot",
      env: {},
      token: "fixture-bridge",
      fetchImpl: async () => Response.json(response),
    });
  expect(await read(valid)).toMatchObject({
    state: "connected",
    entries: [{ id: "10001", name: "Studio", kind: "server" }],
  });
  expect((await read(valid)).entries[0]).not.toHaveProperty("futureColor");
  expect(await read({ ...valid, entries: [{ ...valid.entries[0], id: false }] })).toMatchObject({
    state: "unavailable",
    reason: "directory_unavailable",
    entries: [],
  });
});

it("the API withholds a captured account view if the active body changes during its read", async () => {
  const f = await fixture();
  f.afterRead(async () => {
    await f.settings.update((current) => ({
      ...current,
      discord: { ...current.discord, activeBody: "user_session" },
    }));
  });
  const response = await f.app.request("/v1/discord/directory", {
    headers: { authorization: "Bearer fixture-operator" },
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "discord_body_changed" });
});
