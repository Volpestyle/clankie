import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DiscordServerActionSchema, DiscordServerActionResultSchema } from "@clankie/protocol";
import { SettingsStore, discordSettingsToEnvironment, resolveDiscordSettings } from "@clankie/settings";
import { discordServerAuthority, executeDiscordServerAction } from "@clankie/discord-presence-core";
import { FileCredentialStore } from "@clankie/credential-broker";
import { createDiscordPresenceRuntime } from "../../discord-bridge/src/presence-runtime-module.ts";
import { createChannelProjection } from "../src/captain/channel-projection.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { replayConversation, sendMessage } from "./conversation-requests.ts";

const SERVER = "10001",
  CHANNEL = "20001",
  OTHER = "20002",
  CATEGORY = "20003",
  THREAD = "20004";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Local REST contract service: the production settings serializer and final adapter run unchanged.
 * This establishes our boundary, not Discord's live permissions or invitation grant. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "discord-role-boundary-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(join(root, "settings.json"));
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let loseProvisionReceipt = false;
  let pausedMembership: { reached: () => void; released: Promise<void> } | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const call = {
      method: request.method!,
      path: request.url!,
      ...(raw ? { body: JSON.parse(raw) as unknown } : {}),
    };
    calls.push(call);
    if (call.method === "GET" && call.path === `/channels/${CHANNEL}` && pausedMembership) {
      const pause = pausedMembership;
      pausedMembership = undefined;
      pause.reached();
      await pause.released;
    }
    if (loseProvisionReceipt && call.method === "POST" && call.path === `/guilds/${SERVER}/channels`) {
      request.socket.destroy();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        call.method === "GET" && call.path.startsWith("/channels/")
          ? { id: call.path.split("/")[2], guild_id: call.path === `/channels/${OTHER}` ? "10002" : SERVER }
          : call.method === "POST" && call.path.endsWith("/webhooks")
            ? {
                id: "40001",
                guild_id: SERVER,
                channel_id: call.path.split("/")[2],
                token: "private-fixture-webhook",
              }
            : call.path.startsWith("/webhooks/")
              ? { id: "40001", guild_id: SERVER, channel_id: CHANNEL, token: "private-fixture-webhook" }
              : { id: "30001", ...(call.body && typeof call.body === "object" ? call.body : {}) },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local REST address");
  const url = `http://127.0.0.1:${address.port}`;
  const execute = async (input: unknown, observeNative?: (result: unknown) => void) => {
    const stored = (await settings.load()).discord;
    const env = discordSettingsToEnvironment(resolveDiscordSettings(stored, {}).settings);
    return DiscordServerActionResultSchema.parse(
      await executeDiscordServerAction(
        DiscordServerActionSchema.parse(input),
        discordServerAuthority(env),
        async (action) => {
          const response = await fetch(`${url}${action.path}`, {
            method: action.method,
            ...(action.body === undefined
              ? {}
              : { headers: { "content-type": "application/json" }, body: JSON.stringify(action.body) }),
          });
          if (!response.ok) throw new Error("Local REST failed");
          const result: unknown = await response.json();
          observeNative?.(result);
          return result;
        },
      ),
    );
  };
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, serverId: SERVER, role: "admin", fleetEnabled: true },
  }));
  return {
    root,
    url,
    settings,
    calls,
    execute,
    pauseMembership: () => {
      let reached!: () => void;
      let release!: () => void;
      const observed = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      pausedMembership = { reached, released };
      return { observed, release };
    },
    loseProvisionReceipt: () => {
      loseProvisionReceipt = true;
    },
  };
}

it("saved Admin settings reach create/place/archive, roles, members and webhooks without approval", async () => {
  const f = await fixture();
  for (const action of [
    {
      method: "POST",
      path: "/guilds/@server/channels",
      body: { name: "project", type: 0, parent_id: CATEGORY },
    },
    { method: "POST", path: "/guilds/@server/channels", body: { name: "projects", type: 4 } },
    { method: "PATCH", path: `/channels/${CHANNEL}`, body: { parent_id: CATEGORY, position: 2 } },
    { method: "PATCH", path: `/channels/${THREAD}`, body: { archived: true } },
    { method: "DELETE", path: `/channels/${THREAD}` },
    { method: "POST", path: "/guilds/@server/roles", body: { name: "Clankie crew" } },
    { method: "PUT", path: "/guilds/@server/members/50001/roles/60001" },
    { method: "POST", path: `/channels/${CHANNEL}/webhooks`, body: { name: "Fleet" } },
  ])
    expect((await f.execute(action)).ok).toBe(true);
  expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(8);
  const webhook = await f.execute({ method: "GET", path: "/webhooks/40001" });
  expect(webhook.data).toMatchObject({ token: "[redacted]" });
});

it("the sole destructive floor and cross-server references are refused before mutations", async () => {
  const f = await fixture();
  for (const action of [
    { method: "DELETE", path: "/guilds/@server" },
    { method: "PATCH", path: `/guilds/${SERVER}`, body: { owner_id: "50001" } },
    { method: "PATCH", path: "/guilds/10002", body: { name: "wrong server" } },
    { method: "PATCH", path: `/channels/${CHANNEL}`, body: { parent_id: OTHER } },
    { method: "POST", path: "/guilds/@server/channels", body: { name: "wrong parent", parent_id: OTHER } },
    { method: "POST", path: `/channels/${CHANNEL}/followers`, body: { webhook_channel_id: OTHER } },
  ])
    expect((await f.execute(action)).ok).toBe(false);
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
  for (const path of [
    "/guilds/10001/../10002",
    "/guilds/%31%30%30%30%31",
    "/webhooks/40001/bearer-secret",
    "/channels/20001?guild_id=10002",
  ])
    expect(DiscordServerActionSchema.safeParse({ method: "DELETE", path }).success).toBe(false);
});

it("Participant uses only the designated projection channel and tracking is independent of fleet", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    discord: {
      ...current.discord,
      role: "participant",
      fleetEnabled: false,
      fleetChannelId: CHANNEL,
      trackingLevel: "project_updates",
    },
  }));
  expect(
    (await f.execute({ method: "POST", path: "/guilds/@server/channels", body: { name: "no" } })).ok,
  ).toBe(false);
  expect(
    (await f.execute({ method: "POST", path: `/channels/${OTHER}/messages`, body: { content: "no" } })).ok,
  ).toBe(false);
  expect(
    (
      await f.execute({
        method: "POST",
        path: `/channels/${CHANNEL}/messages`,
        body: { content: "Project update", allowed_mentions: { parse: ["everyone"] } },
      })
    ).ok,
  ).toBe(true);
  expect(f.calls.at(-1)?.body).toMatchObject({ allowed_mentions: { parse: [] } });
  const before = f.calls.length;
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, trackingLevel: "off" },
  }));
  expect(
    (await f.execute({ method: "POST", path: `/channels/${CHANNEL}/messages`, body: { content: "off" } })).ok,
  ).toBe(false);
  expect(f.calls).toHaveLength(before);
  const effective = resolveDiscordSettings((await f.settings.load()).discord, {}).settings;
  expect(effective.ingressGuildIds).toEqual([SERVER]);
  expect(effective.ingressChannelIds).toEqual([]);
  expect(effective.systemActorGuildIds).toEqual([]);
});

it("fleet disable retains credentials and Participant posts need no webhook provisioning", async () => {
  const f = await fixture();
  const retained = {
    guildId: SERVER,
    channelId: CHANNEL,
    webhookId: "40001",
    webhookToken: "fixture-only",
    username: "Crew",
    content: "Working",
  };
  const projection = createChannelProjection({
    fleetSettings: async () => resolveDiscordSettings((await f.settings.load()).discord, {}).settings,
    participantPost: async (channelId, content) => {
      const result = await f.execute({
        method: "POST",
        path: `/channels/${channelId}/messages`,
        body: { content },
      });
      if (!result.ok) throw new Error(result.message);
    },
  });
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, fleetEnabled: false },
  }));
  await expect(projection.post(retained)).rejects.toThrow(/fleet enabled/u);
  expect(f.calls).toEqual([]);
  expect(retained.webhookToken).toBe("fixture-only");
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, role: "participant", fleetEnabled: true, fleetChannelId: CHANNEL },
  }));
  expect(await projection.participantPost!({ username: "Crew", content: "Working" })).toBe(true);
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([
    {
      method: "POST",
      path: `/channels/${CHANNEL}/messages`,
      body: { content: "**Crew**\nWorking", allowed_mentions: { parse: [] } },
    },
  ]);
});

it("Participant per-channel off keeps operator messages, member replies and notices local across restart", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, role: "participant", fleetEnabled: true, fleetChannelId: CHANNEL },
  }));
  const projection = createChannelProjection({
    fleetSettings: async () => resolveDiscordSettings((await f.settings.load()).discord, {}).settings,
    participantPost: async (channelId, content) => {
      const result = await f.execute({
        method: "POST",
        path: `/channels/${channelId}/messages`,
        body: { content },
      });
      if (!result.ok) throw new Error(result.message);
    },
  });
  const conversationsRoot = join(f.root, "conversations");
  let seated = true;
  let reply = "";
  let presentationPause: { skip: number; observed: () => void; released: Promise<void> } | undefined;
  let store: ConversationStore;
  const openStore = () =>
    new ConversationStore(
      conversationsRoot,
      async () => {},
      undefined,
      async (seatId) => {
        if (!seated) return false;
        const text = reply;
        // Deliver a native reply through the public event surface after the
        // channel round has registered its waiter; no model or pane is used.
        setImmediate(() =>
          store.publishSeatEvent(seatId, { type: "message", role: "agent", text, streaming: false }),
        );
        return true;
      },
      undefined,
      undefined,
      projection,
      undefined,
      async (personaId) => {
        const pause = presentationPause;
        if (pause && pause.skip-- === 0) {
          presentationPause = undefined;
          pause.observed();
          await pause.released;
        }
        return { username: personaId };
      },
    );
  store = openStore();
  cleanups.push(() => store.close());
  const group = async (title: string) => {
    const created = await store.serve({
      schemaVersion: 1,
      op: "channel",
      channel: { schemaVersion: 1, title, members: ["crew"] },
    });
    if (created.op !== "channel") throw new Error("Channel result required");
    return created;
  };
  const say = async (conversationId: string, message: string) => {
    const current = await store.serve({ schemaVersion: 1, op: "get", conversationId });
    if (current.op !== "get" || !current.conversation) throw new Error("Conversation required");
    const sent = await sendMessage(store, {
      conversationId,
      surfaceClientId: "fixture-tui",
      expectedRevision: current.conversation.revision,
      message,
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("Accepted message required");
    await store.awaitRun(sent.result.runId);
  };
  const posts = () => f.calls.filter((call) => call.method === "POST");
  const hidden = await group("Hidden crew");
  const visible = await group("Visible crew");
  let observed!: () => void;
  let release!: () => void;
  const presentationObserved = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const presentationReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanups.push(async () => release());
  // The round first resolves roster names; pause the later member projection.
  presentationPause = { skip: 1, observed, released: presentationReleased };
  reply = "Hidden member reply racing off";
  const racingRound = say(hidden.conversation.conversationId, "Operator before per-channel off");
  await presentationObserved;
  const beforeOff = posts().length;
  expect(beforeOff).toBe(1);
  await store.serve({
    schemaVersion: 1,
    op: "channel",
    channel: {
      schemaVersion: 1,
      channelId: hidden.channel.channelId,
      title: hidden.channel.title,
      members: ["crew"],
      discord: { kind: "off" },
    },
  });
  release();
  await racingRound;
  expect(posts()).toHaveLength(beforeOff);
  reply = "Hidden member reply before restart";
  await say(hidden.conversation.conversationId, "Hidden operator before restart");
  expect(posts()).toHaveLength(beforeOff);

  reply = "Visible member reply";
  await say(visible.conversation.conversationId, "Visible operator");
  expect(
    posts()
      .slice(beforeOff)
      .map((call) => call.body),
  ).toEqual([
    { content: "**operator**\n**Visible crew**\nVisible operator", allowed_mentions: { parse: [] } },
    { content: "**crew**\n**Visible crew**\nVisible member reply", allowed_mentions: { parse: [] } },
  ]);
  const beforeNotice = posts().length;
  seated = false;
  await say(hidden.conversation.conversationId, "Hidden offline notice");
  expect(posts()).toHaveLength(beforeNotice);
  await say(visible.conversation.conversationId, "Visible offline notice");
  expect(posts().at(-1)?.body).toMatchObject({
    content: expect.stringContaining("No one here has a live seat"),
  });

  await store.close();
  store = openStore();
  const beforeRestart = posts().length;
  seated = true;
  reply = "Hidden member reply after restart";
  await say(hidden.conversation.conversationId, "Hidden operator after restart");
  seated = false;
  await say(hidden.conversation.conversationId, "Hidden offline notice after restart");
  expect(posts()).toHaveLength(beforeRestart);
  seated = true;
  reply = "Visible member reply after restart";
  await say(visible.conversation.conversationId, "Visible operator after restart");
  expect(posts()).toHaveLength(beforeRestart + 2);
  const replay = await replayConversation(store, {
    conversationId: hidden.conversation.conversationId,
    surfaceClientId: "fixture-tui",
  });
  if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("Replay page required");
  expect(replay.result.events.flatMap((event) => (event.type === "message" ? [event.text] : []))).toEqual([
    "Operator before per-channel off",
    "Hidden member reply racing off",
    "Hidden operator before restart",
    "Hidden member reply before restart",
    "Hidden offline notice",
    "Hidden operator after restart",
    "Hidden member reply after restart",
    "Hidden offline notice after restart",
  ]);
  expect(
    JSON.parse(
      await readFile(join(conversationsRoot, hidden.conversation.conversationId, "meta.json"), "utf8"),
    ),
  ).toMatchObject({ channelDiscordAutoProvision: "disabled" });
  expect(
    f.calls.every((call) => [`/channels/${CHANNEL}`, `/channels/${CHANNEL}/messages`].includes(call.path)),
  ).toBe(true);
  expect(f.calls.every((call) => call.method === "GET" || call.method === "POST")).toBe(true);
});

it("existing Admin fleet groups provision once, retain their mirror across toggles/restart, and never replay an uncertain create", async () => {
  const f = await fixture();
  const conversationsRoot = join(f.root, "conversations");
  const nativeFetch: typeof fetch = (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return fetch(`${f.url}${target.pathname.replace(/^\/api\/v10/u, "")}${target.search}`, init);
  };
  const projection = createChannelProjection({
    fetch: nativeFetch,
    fleetSettings: async () => resolveDiscordSettings((await f.settings.load()).discord, {}).settings,
    swarmGuildId: () => SERVER,
    provision: async ({ name }) => {
      const channel = await f.execute({
        method: "POST",
        path: "/guilds/@server/channels",
        body: { name, type: 0 },
      });
      if (!channel.ok || !channel.resourceId) throw new Error("Channel receipt unavailable");
      let credential: { id: string; token: string } | undefined;
      const webhook = await f.execute(
        { method: "POST", path: `/channels/${channel.resourceId}/webhooks`, body: { name: "Fleet" } },
        (result) => {
          // The trusted provisioning callback retains the fixture credential;
          // the generic server-action result remains redacted for callers.
          if (
            result &&
            typeof result === "object" &&
            "id" in result &&
            "token" in result &&
            typeof result.id === "string" &&
            typeof result.token === "string"
          )
            credential = { id: result.id, token: result.token };
        },
      );
      if (!webhook.ok || !credential) throw new Error("Webhook receipt unavailable");
      return {
        guildId: SERVER,
        channelId: channel.resourceId,
        webhookId: credential.id,
        webhookToken: credential.token,
      };
    },
  });
  const openStore = () =>
    new ConversationStore(
      conversationsRoot,
      async () => {},
      undefined,
      async () => false,
      undefined,
      undefined,
      projection,
    );
  let store = openStore();
  cleanups.push(() => store.close());
  const meta = async (id: string) =>
    JSON.parse(await readFile(join(conversationsRoot, id, "meta.json"), "utf8"));
  const group = async (title: string) => {
    const created = await store.serve({
      schemaVersion: 1,
      op: "channel",
      channel: {
        schemaVersion: 1,
        title,
        members: ["crew"],
      },
    });
    if (created.op !== "channel") throw new Error("Channel result required");
    return created.conversation.conversationId;
  };
  const say = async (conversationId: string, message: string) => {
    const current = await meta(conversationId);
    const sent = await store.serve({
      schemaVersion: 1,
      op: "send",
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId,
        surfaceClientId: "fixture-tui",
        expectedRevision: current.revision,
        message,
      },
    });
    if (sent.op !== "send" || sent.result.status !== "accepted")
      throw new Error("Accepted group message required");
    await store.awaitRun(sent.result.runId);
  };
  const creates = () =>
    f.calls.filter((call) => call.method === "POST" && call.path === `/guilds/${SERVER}/channels`);
  const webhookCreates = () =>
    f.calls.filter((call) => call.method === "POST" && call.path.endsWith("/webhooks"));
  const webhookPosts = () =>
    f.calls.filter((call) => call.method === "POST" && call.path.startsWith("/webhooks/"));

  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, fleetEnabled: false },
  }));
  const existing = await group("Existing crew group");
  await say(existing, "Fleet display is disabled");
  expect(f.calls).toEqual([]);
  expect((await meta(existing)).channelDiscord).toBeUndefined();

  await f.settings.update((current) => ({ ...current, discord: { ...current.discord, fleetEnabled: true } }));
  await say(existing, "Show this existing group");
  expect(creates()).toHaveLength(1);
  expect(webhookCreates()).toHaveLength(1);
  expect(webhookPosts().length).toBeGreaterThan(0);
  const retained = (await meta(existing)).channelDiscord;
  expect(retained).toMatchObject({
    guildId: SERVER,
    channelId: "30001",
    webhookId: "40001",
    provisioned: true,
  });
  await say(existing, "Reuse the same mirror");
  expect(creates()).toHaveLength(1);
  expect(webhookCreates()).toHaveLength(1);

  const posts = webhookPosts().length;
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, fleetEnabled: false },
  }));
  await say(existing, "Hide without deleting");
  expect(webhookPosts()).toHaveLength(posts);
  expect((await meta(existing)).channelDiscord).toEqual(retained);
  await store.close();
  store = openStore();
  await f.settings.update((current) => ({ ...current, discord: { ...current.discord, fleetEnabled: true } }));
  await say(existing, "Reuse after restart");
  expect(webhookPosts().length).toBeGreaterThan(posts);
  expect(creates()).toHaveLength(1);
  expect(webhookCreates()).toHaveLength(1);
  expect((await meta(existing)).channelDiscord).toEqual(retained);

  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, role: "participant" },
  }));
  await expect(projection.remove!(retained)).rejects.toThrow(/Admin/u);
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, role: "admin", serverId: "10002" },
  }));
  await expect(projection.remove!(retained)).rejects.toThrow(/connected server/u);
  expect(f.calls.filter((call) => call.method === "DELETE")).toEqual([]);

  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, role: "admin", serverId: SERVER },
  }));
  f.loseProvisionReceipt();
  const uncertain = await group("Unconfirmed crew group");
  await say(uncertain, "Create only once even if the receipt is lost");
  expect(creates()).toHaveLength(2);
  expect((await meta(uncertain)).channelDiscordAutoProvision).toBe("uncertain");
  await store.close();
  store = openStore();
  await say(uncertain, "Do not replay after restart");
  expect(creates()).toHaveLength(2);
  expect(webhookCreates()).toHaveLength(1);
  expect((await meta(uncertain)).channelDiscordAutoProvision).toBe("uncertain");
});

it("the production bot adapter refuses a mutation revoked during its native membership read", async () => {
  const f = await fixture();
  const credentialsPath = join(f.root, "credentials.json");
  await new FileCredentialStore(credentialsPath).set("discord_bot", {
    type: "api",
    key: "integration-only-token",
  });
  const previousCredentialsPath = process.env.CLANKIE_CREDENTIALS_FILE;
  process.env.CLANKIE_CREDENTIALS_FILE = credentialsPath;
  cleanups.push(async () => {
    if (previousCredentialsPath === undefined) delete process.env.CLANKIE_CREDENTIALS_FILE;
    else process.env.CLANKIE_CREDENTIALS_FILE = previousCredentialsPath;
  });
  // The existing REST injection forwards real HTTP. Settings, broker grants,
  // membership checks, and the mutation dispatch guard are production paths.
  const request = async (method: string, path: string, options?: { body?: unknown }) => {
    const response = await fetch(`${f.url}${path}`, {
      method,
      ...(options?.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(options.body),
          }),
    });
    if (!response.ok) throw new Error("Local REST failed");
    return response.json() as Promise<unknown>;
  };
  const runtime = createDiscordPresenceRuntime({
    env: { CLANKIE_SETTINGS_FILE: f.settings.path },
    rest: {
      get: (path: string) => request("GET", path),
      post: (path: string, options?: { body?: unknown }) => request("POST", path, options),
    } as never,
  });
  const pause = f.pauseMembership();
  const pending = runtime.serverAction({
    method: "POST",
    path: `/channels/${CHANNEL}/messages`,
    body: { content: "must not publish" },
  });
  try {
    await pause.observed;
    await f.settings.update((current) => ({
      ...current,
      discord: { ...current.discord, role: "participant" },
    }));
  } finally {
    pause.release();
  }
  expect((await pending).ok).toBe(false);
  expect(f.calls).toEqual([{ method: "GET", path: `/channels/${CHANNEL}` }]);
});
