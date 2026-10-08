import { createServer, Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, appendFile, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { serve } from "@hono/node-server";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { FileCredentialStore } from "@clankie/credential-broker";
import { ClankieApiClient, DiscordSetupClient } from "../../../packages/api-client/src/index.ts";
import { SettingsStore } from "@clankie/settings";
import {
  DISCORD_SETUP_TEST_POST_PATH,
  DISCORD_SETUP_TEST_TEXT,
  DiscordSettingsSchema,
  DISCORD_PARTICIPANT_INVITE_PERMISSIONS,
  DiscordSetupDefinitionSchema,
  DiscordPermissionsRequestSchema,
  parseProtocolResponse,
  type DiscordPermissionsRequest,
} from "@clankie/protocol";
import {
  tryHandleDiscordDirectoryRequest,
  tryHandleDiscordSetupRequest,
  postDiscordSetupTestMessage,
} from "@clankie/discord-presence-core";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { DiscordRoomObservations } from "../src/discord-room-observations.ts";
import { readDiscordBodyDirectory } from "../src/discord-directory.ts";
import { readDiscordBodyPermissions, postDiscordBodyTest } from "../src/discord-setup-body.ts";
import { runDiscordSetupCommand } from "../../tui/src/command/discord-setup.ts";
import { ClankieFaceShell } from "../../tui/src/shell/shell.ts";
import { buildDiscordCommands } from "../../tui/src/discord-commands.ts";
import { InteractiveSelectPrompt } from "../../tui/src/face/clankie-interactive-flow.ts";
import { observeBotSetupPermissions } from "../../discord-bridge/src/setup-permissions.ts";
import { readBotDiscordDirectory } from "../../discord-bridge/src/directory.ts";
import { botCache } from "../../discord-bridge/test/fixtures/directory.ts";
import { ownerDescriptorPaths } from "../../../scripts/testing/vitest-setup.ts";

const cleanup: Array<() => Promise<unknown>> = [];
async function evidence(name: string, value: unknown) {
  const directory = process.env.SETUP_PERMISSIONS_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), JSON.stringify(value, null, 2));
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server) {
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  );
  if (!server.listening) server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture loopback port");
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}
const bytes = (path: string) =>
  readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

async function fixture() {
  const before = await Promise.all(ownerDescriptorPaths.map(bytes));
  cleanup.push(async () => {
    expect(await Promise.all(ownerDescriptorPaths.map(bytes))).toEqual(before);
  });
  const root = await mkdtemp(join(tmpdir(), "discord-permissions-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cache = botCache(); // Real discord.js Guild/Member/Channel caches, no login or live guild writes.
  cleanup.push(async () => cache.client.destroy());
  const permissions = observeBotSetupPermissions(cache.client);
  const packet = (t: string, d: Record<string, unknown>) => cache.client.emit("raw", { t, d, op: 0, s: 1 });
  const ready = () =>
    packet("READY", { user: { id: "30001", bot: true }, guilds: [{ id: "10001", unavailable: true }] });
  const raw = structuredClone(cache.raw);
  raw.roles[1]!.permissions = String(BigInt(DISCORD_PARTICIPANT_INVITE_PERMISSIONS) | 16n | (1n << 29n));
  raw.members[0]!.roles = ["10002"];
  raw.channels[1]!.permission_overwrites = [
    { id: "30001", type: 1, allow: "0", deny: String(2048n | (1n << 29n)) },
  ];
  ready();
  packet("GUILD_CREATE", raw);
  const deliveries: Array<{ channelId: string; content: string; allowed_mentions: unknown }> = [];
  let loseReceipt = false;
  const nativeRest = await listen(
    createServer(async (request, response) => {
      // A loopback Discord REST wire fixture records native effects durably. Never forwards to Discord.
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      expect(request.method).toBe("POST");
      expect(request.url).toMatch(/^\/channels\/\d+\/messages$/u);
      const channelId = request.url!.split("/")[2]!;
      const delivery = {
        channelId,
        content: message.content as string,
        allowed_mentions: message.allowed_mentions as unknown,
      };
      deliveries.push(delivery);
      await appendFile(join(root, "native-posts.jsonl"), `${JSON.stringify(delivery)}\n`);
      if (loseReceipt) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: String(70000 + deliveries.length) }));
    }),
  );
  const requests: Array<{ method: string; path: string }> = [];
  const token = "fixture-body-bearer";
  const body = await listen(
    createServer((request, response) => {
      requests.push({ method: request.method ?? "GET", path: request.url ?? "/" });
      if (
        tryHandleDiscordSetupRequest(request, response, {
          token,
          read: (query) => permissions.read(query, "bot", cache.client.isReady()),
          post: (query) =>
            postDiscordSetupTestMessage(query, {
              authorization: "Bot fixture-native-token",
              baseUrl: nativeRest.url,
            }),
        })
      )
        return;
      if (
        tryHandleDiscordDirectoryRequest(request, response, {
          token,
          read: (query) => readBotDiscordDirectory(cache.client, query),
        })
      )
        return;
      response.writeHead(404);
      response.end();
    }),
  );
  const env = {
    CLANKIE_DISCORD_BRIDGE_CONTROL_PORT: String(body.port),
    CLANKIE_USER_SESSION_CONTROL_PORT: String(body.port),
  };
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: {
      ...current.discord,
      serverId: "10001",
      role: "participant",
      applicationId: "90001",
      guildId: "10001",
      ingressGuildIds: ["10001"],
      presenceGuildIds: ["10001"],
      ingressChannelIds: ["20001"],
      presenceChannelIds: ["20001"],
      swarmGuildId: "10001",
    },
  }));
  const operatorEnv: NodeJS.ProcessEnv = { CLANKIE_OPERATOR_TOKEN: "fixture-owner" };
  let afterPermissions = async () => {};
  const service = await createClankieApp({
    captain: createStubCaptain(), // Unrelated model lane is never invoked in this integration.
    settings,
    eventLogPath: join(root, "events.jsonl"),
    deviceSessionKey: Buffer.alloc(32, 9),
    roomObservations: new DiscordRoomObservations(join(root, "rooms.json")),
    hostDisplayName: "Fixture Mac",
    discordEnvironment: {},
    authenticateOperator: createCredentialBackedOperatorAuthenticator({
      env: operatorEnv,
      store: new FileCredentialStore(join(root, "credentials.json")),
      identity: { operatorId: "fixture-owner" },
    }),
    discordDirectory: (query, activeBody) =>
      readDiscordBodyDirectory(query, { body: activeBody, env, token }),
    discordPermissions: async (query, activeBody) => {
      const result = await readDiscordBodyPermissions(query, { body: activeBody, env, token });
      await afterPermissions();
      return result;
    },
    discordTestPost: (query, activeBody) => postDiscordBodyTest(query, { body: activeBody, env, token }),
  });
  cleanup.push(async () => service.close());
  const hostServer = serve({
    fetch: (request) => service.app.fetch(request),
    hostname: "127.0.0.1",
    port: 0,
  });
  if (!(hostServer instanceof Server)) throw new Error("Expected owned HTTP fixture server");
  const host = await listen(hostServer);
  const client = new ClankieApiClient({ baseUrl: host.url, operatorToken: "fixture-owner" });
  const setup = new DiscordSetupClient(client);
  return {
    ...cache,
    root,
    client,
    setup,
    host,
    body,
    raw,
    packet,
    ready,
    settings,
    deliveries,
    requests,
    operatorEnv,
    read: (query: DiscordPermissionsRequest) =>
      readDiscordBodyPermissions(query, { body: "bot", env, token }),
    afterPermissions: (hook: () => Promise<void>) => {
      afterPermissions = hook;
    },
    loseReceipt: () => {
      loseReceipt = true;
    },
  };
}

it("computes connected gateway permissions through native body HTTP, owner API, shared setup and CLI without posting on reads", async () => {
  const f = await fixture();
  const allowed = await f.read({ guildId: "10001", channelId: "20001" });
  expect(allowed.permissions).toMatchObject({
    view_channel: "passed",
    send_messages: "passed",
    manage_channels: "passed",
    manage_webhooks: "passed",
  });
  expect((await f.read({ channelId: "20002" })).permissions).toMatchObject({
    send_messages: "failed",
    manage_webhooks: "failed",
  });
  expect((await f.read({ channelId: "20003" })).permissions).toMatchObject({
    view_channel: "failed",
    send_messages: "failed",
    manage_webhooks: "failed",
  });
  const view = await f.setup.read();
  expect(
    view.sentences
      .find((sentence) => sentence.id === "connect")!
      .checks.every((check) => check.status === "passed"),
  ).toBe(true);
  expect(new URL(view.snapshot.setup!.invite!.url).searchParams.get("permissions")).toBe(
    DISCORD_PARTICIPANT_INVITE_PERMISSIONS,
  );
  expect(await runDiscordSetupCommand([], f.client)).toEqual(view);
  await runDiscordSetupCommand(["choices", "connect"], f.client);
  const participant = await runDiscordSetupCommand(
    ["connect", "--server", "Studio", "--role", "participant"],
    f.client,
  );
  expect("snapshot" in participant && participant.snapshot.settings.ingressChannelIds).toEqual([]);
  await runDiscordSetupCommand(["connect", "--role", "admin"], f.client);
  const denied = await f.setup.read();
  expect(
    denied.sentences
      .find((sentence) => sentence.id === "connect")!
      .checks.find((check) => check.kind === "administrator")!.status,
  ).toBe("failed");
  expect(new URL(denied.snapshot.setup!.invite!.url).searchParams.get("permissions")).toBe("8");
  f.packet("GUILD_ROLE_UPDATE", { guild_id: "10001", role: { id: "10002", permissions: "8" } });
  expect(
    (await f.setup.read()).sentences
      .find((sentence) => sentence.id === "connect")!
      .checks.find((check) => check.kind === "administrator")!.status,
  ).toBe("passed");
  expect(f.deliveries).toHaveLength(0);
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  // Exact two-field setup response schema shipped at 2fcb9d73; no checks/action capability.
  const oldClient = z
    .object({
      settings: DiscordSettingsSchema,
      revision: z.string(),
      setup: z
        .object({ definition: DiscordSetupDefinitionSchema, machineName: z.string() })
        .strict()
        .optional(),
    })
    .strict();
  const wire = await f.client.discordSettings();
  expect(parseProtocolResponse(oldClient, wire).setup).toEqual({
    definition: wire.setup!.definition,
    machineName: "Fixture Mac",
  });
  f.disconnect();
  expect(
    (await f.setup.read(view.snapshot)).sentences
      .find((sentence) => sentence.id === "connect")!
      .checks.find((check) => check.kind === "send_messages")!.status,
  ).toBe("not_checked");
  expect(
    Object.values((await f.read({ channelId: "20001" })).permissions).every(
      (status) => status === "not_checked",
    ),
  ).toBe(true);
  expect(
    (await f.setup.read()).sentences
      .find((sentence) => sentence.id === "connect")!
      .checks.find((check) => check.kind === "administrator")!.status,
  ).toBe("not_checked");
  await evidence("setup-checks.json", {
    allowed,
    allowedSentences: view.sentences,
    deniedSentences: denied.sentences,
    requests: f.requests,
    nativePosts: f.deliveries,
  });
});

it("honors role-union and member-overwrite precedence, owner/admin bypass, timeouts and incomplete evidence", async () => {
  const f = await fixture();
  const update = (permission_overwrites: unknown, type = 0) =>
    f.packet("CHANNEL_UPDATE", { guild_id: "10001", id: "20001", type, permission_overwrites });
  f.packet("GUILD_ROLE_CREATE", { guild_id: "10001", role: { id: "10003", permissions: "0" } });
  f.packet("GUILD_MEMBER_UPDATE", { guild_id: "10001", user: { id: "30001" }, roles: ["10002", "10003"] });
  update([
    { id: "10001", type: 0, allow: "0", deny: "2048" },
    { id: "10002", type: 0, allow: "0", deny: "2048" },
    { id: "10003", type: 0, allow: "2048", deny: "0" },
  ]);
  expect((await f.read({ channelId: "20001" })).permissions.send_messages).toBe("passed");
  update([
    { id: "10003", type: 0, allow: "2048", deny: "0" },
    { id: "30001", type: 1, allow: "0", deny: "2048" },
  ]);
  expect((await f.read({ channelId: "20001" })).permissions.send_messages).toBe("failed");
  update([
    { id: "10001", type: 0, allow: "0", deny: "2048" },
    { id: "30001", type: 1, allow: "2048", deny: "0" },
  ]);
  expect((await f.read({ channelId: "20001" })).permissions.send_messages).toBe("passed");
  update([{ id: "10001", type: 0, allow: "invalid", deny: "0" }]);
  expect((await f.read({ channelId: "20001" })).permissions.send_messages).toBe("not_checked");
  f.packet("GUILD_ROLE_UPDATE", { guild_id: "10001", role: { id: "10002", permissions: "8" } });
  expect((await f.read({ channelId: "20001" })).permissions.send_messages).toBe("passed");
  f.packet("GUILD_ROLE_DELETE", { guild_id: "10001", role_id: "10002" });
  expect((await f.read({ channelId: "20001" })).permissions.send_messages).toBe("not_checked");
  f.packet("GUILD_UPDATE", { id: "10001", owner_id: "30001" });
  expect((await f.read({ channelId: "20001" })).permissions.manage_webhooks).toBe("passed");
  f.packet("GUILD_CREATE", f.raw);
  f.packet("GUILD_MEMBER_UPDATE", {
    guild_id: "10001",
    user: { id: "30001" },
    communication_disabled_until: "2099-01-01T00:00:00Z",
  });
  expect((await f.read({ channelId: "20001" })).permissions).toMatchObject({
    view_channel: "passed",
    send_messages: "failed",
    manage_webhooks: "failed",
  });
  f.packet("GUILD_CREATE", f.raw);
  f.packet("GUILD_ROLE_UPDATE", {
    guild_id: "10001",
    role: { id: "10002", permissions: String(2048n | 16n | (1n << 29n)) },
  });
  update([], 2);
  expect((await f.read({ channelId: "20001" })).permissions.manage_channels).toBe("failed");
  f.packet("GUILD_ROLE_UPDATE", {
    guild_id: "10001",
    role: { id: "10002", permissions: String(2048n | 16n | (1n << 20n)) },
  });
  expect((await f.read({ channelId: "20001" })).permissions.manage_channels).toBe("passed");
  update([{ id: "30001", type: 1, allow: "0", deny: String(1n << 20n) }], 2);
  expect((await f.read({ channelId: "20001" })).permissions.manage_channels).toBe("failed");
  f.packet("GUILD_CREATE", f.raw);
  f.packet("GUILD_MEMBER_UPDATE", {
    guild_id: "10001",
    user: { id: "30001" },
    communication_disabled_until: 42,
  });
  expect((await f.read({ channelId: "20001" })).permissions.send_messages).toBe("not_checked");
  f.packet("GUILD_CREATE", f.raw);
  update([], 12);
  expect((await f.read({ channelId: "20001" })).permissions.send_messages).toBe("not_checked");
  const incomplete = { ...f.raw, channels: [{ id: "20001", type: 0 }] };
  f.packet("GUILD_CREATE", incomplete);
  expect((await f.read({ channelId: "20001" })).permissions.send_messages).toBe("not_checked");
  f.packet("GUILD_DELETE", { id: "10001", unavailable: true });
  expect((await f.read({ guildId: "10001" })).permissions.manage_channels).toBe("not_checked");
  expect(f.deliveries).toHaveLength(0);
});

it("only an explicit authenticated owner mutation posts once, with stale account/config and observer requests refused", async () => {
  const f = await fixture();
  const snapshot = await f.client.discordSettings();
  const query = { guildId: "10001", channelId: "20001", expectedRevision: snapshot.revision };
  const mutate = (bearer?: string, input: unknown = query) =>
    fetch(`${f.host.url}${DISCORD_SETUP_TEST_POST_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(input),
    });
  expect((await mutate()).status).toBe(403);
  expect((await mutate("wrong-token")).status).toBe(403);
  expect(
    (
      await fetch(`${f.host.url}${DISCORD_SETUP_TEST_POST_PATH}`, {
        headers: { authorization: "Bearer fixture-owner" },
      })
    ).status,
  ).toBe(404);
  const offer = await (
    await fetch(`${f.host.url}/v1/pairing/offer`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-owner" },
    })
  ).json();
  const redeemed = await (
    await fetch(`${f.host.url}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: offer.localCode, device: { name: "Fixture observer", platform: "ios" } }),
    })
  ).json();
  const paired = await (
    await fetch(`${f.host.url}/v1/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        completionToken: redeemed.completionToken,
        acceptedGrants: { chat: false, steer: false, terminalObserve: true, terminalControl: false },
      }),
    })
  ).json();
  expect((await mutate(paired.deviceToken)).status).toBe(403);
  expect(f.deliveries).toHaveLength(0);
  const posted = await runDiscordSetupCommand(["test-post", "--channel", "general"], f.client);
  expect(posted).toMatchObject({
    outcome: "posted",
    body: "bot",
    channelId: "20001",
    messageId: "70001",
  });
  expect(f.deliveries).toEqual([
    { channelId: "20001", content: DISCORD_SETUP_TEST_TEXT, allowed_mentions: { parse: [] } },
  ]);
  expect(await f.client.discordSetupTestPost({ ...query, channelId: "20002" })).toEqual({
    outcome: "unavailable",
    reason: "permissions_not_verified",
  });
  f.afterPermissions(async () => {
    await f.settings.update((current) => ({
      ...current,
      // Mutate the owner setting, not its derived legacy body projection.
      discord: { ...current.discord, fleetEnabled: true },
    }));
  });
  expect((await mutate("fixture-owner")).status).toBe(409);
  expect(f.deliveries).toHaveLength(1);
  f.afterPermissions(async () => {
    f.ready();
  }); // Old actor ID is gone before body admission.
  const fresh = await f.client.discordSettings();
  f.packet("GUILD_CREATE", f.raw);
  f.afterPermissions(async () => {
    f.packet("READY", { user: { id: "30009", bot: true }, guilds: [] });
  });
  expect(await f.client.discordSetupTestPost({ ...query, expectedRevision: fresh.revision })).toEqual({
    outcome: "unavailable",
    reason: "account_changed",
  });
  expect(f.deliveries).toHaveLength(1);
  f.afterPermissions(async () => {});
  f.ready();
  f.packet("GUILD_CREATE", f.raw);
  const latest = await f.client.discordSettings();
  f.afterPermissions(async () => {
    delete f.operatorEnv.CLANKIE_OPERATOR_TOKEN;
  });
  expect((await mutate("fixture-owner", { ...query, expectedRevision: latest.revision })).status).toBe(403);
  expect(f.deliveries).toHaveLength(1);
  await evidence("explicit-post.json", {
    posted,
    refused: [
      "unauthenticated",
      "wrong token",
      "GET",
      "paired observer",
      "denied permission",
      "stale settings",
      "changed account",
      "revoked owner",
    ],
    nativePosts: f.deliveries,
    bodyRequests: f.requests,
  });
});

it("reports a lost native receipt as unconfirmed and never retries the post", async () => {
  const f = await fixture();
  f.loseReceipt();
  const result = await runDiscordSetupCommand(["test-post", "--channel", "general"], f.client);
  expect(result).toEqual({
    outcome: "unconfirmed",
    reason: "post_receipt_unavailable",
  });
  expect(f.deliveries).toHaveLength(1);
  await f.setup.read();
  expect(f.deliveries).toHaveLength(1);
  expect(DiscordPermissionsRequestSchema.safeParse({ guildId: "10001", extra: true }).success).toBe(false);
  await evidence("lost-receipt.json", {
    result,
    nativePosts: f.deliveries,
    bodyRequests: f.requests,
  });
});

it("the real TUI opens the role setup and rechecks grants without offering a default room picker or posting", async () => {
  const f = await fixture();
  const shell = new ClankieFaceShell({
    commands: buildDiscordCommands({
      setup: f.client,
      settings: new SettingsStore(join(f.root, "tui-settings.json")),
      localAdvanced: false,
      listCredentials: async () => ({}),
      removeCredential: async () => undefined,
      setCredential: async () => {},
    }),
    cwd: f.root,
    env: { PATH: process.env.PATH, HOME: f.root, CLANKIE_STATE: join(f.root, "tui-state") },
    bannerFields: { title: "Clankie" },
  });
  let finished = false;
  const running = (shell as unknown as { submitEditorText(text: string): Promise<void> })
    .submitEditorText("/discord")
    .finally(() => {
      finished = true;
    });
  const prompt = async (text: string) => {
    let current!: InteractiveSelectPrompt;
    await vi.waitFor(() => {
      const focused = shell.tui.getFocusedComponent();
      expect(focused instanceof InteractiveSelectPrompt).toBe(true);
      expect(stripVTControlCharacters(focused!.render(180).join("\n")).toLocaleLowerCase()).toContain(
        text.toLocaleLowerCase(),
      );
      current = focused as InteractiveSelectPrompt;
    });
    return current;
  };
  const choose = async (text: string, choice: string) => {
    const current = await prompt(text);
    current.handleInput("\x15");
    for (const char of choice) current.handleInput(char);
    current.handleInput("\r");
  };
  try {
    const opening = await prompt("Fleet in Discord");
    const openingFrame = stripVTControlCharacters(opening.render(180).join("\n"));
    expect(openingFrame).toContain("✓ Send Messages");
    expect(openingFrame).toContain("Project tracking");
    expect(openingFrame).not.toContain("Send a test post");
    expect(openingFrame).not.toContain("He talks with");
    expect(f.deliveries).toHaveLength(0);
    await choose("Fleet in Discord", "Recheck setup");
    await prompt("Fleet in Discord");
    expect(f.deliveries).toHaveLength(0);
    await choose("Fleet in Discord", "Done");
    await running;
    await evidence("tui-role-setup.json", { openingFrame, nativePosts: f.deliveries });
  } finally {
    for (let attempt = 0; !finished && attempt < 10; attempt++) {
      shell.setupFlow.handleSubmit("/cancel");
      await new Promise((resolveTick) => setTimeout(resolveTick, 50));
    }
    await running;
  }
});
