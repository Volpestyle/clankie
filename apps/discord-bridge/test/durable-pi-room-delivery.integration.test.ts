import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClankieApiClient } from "@clankie/api-client";
import {
  DiscordPresenceSession,
  DiscordTextIngress,
  createAdvertisedDiscordPresencePort,
} from "@clankie/discord-presence-core";
import { DiscordTextInbox } from "../src/text-inbox.ts";
import { DM, OWNER, cleanups, privateService } from "../../clankie/test/fixtures/durable-pi-room-service.ts";

// ADR 0284's delivery hop (#368): the bridge's real SQLite inbox, text ingress
// and presence session in this process; the real service as a child process
// that is SIGKILLed mid-shell and started again; its reply leaves through the
// bridge's real bot presence runtime and discord.js REST. Discord itself is a
// loopback fixture, so this does not prove Discord's API or gateway delivery,
// and the model is scripted, so it does not prove model behaviour.
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const MESSAGE = "1400000000000000001";
const BOT = "99999000090";

/**
 * Discord's REST surface on loopback. Channel history serves what was posted, as
 * the mouth's reply reconciliation reads it back. `holdPosts` accepts a post
 * (it is in the channel) and never answers it, as when the sender dies between
 * Discord's send and its acknowledgment.
 */
async function loopbackDiscord(options: { holdPosts?: boolean } = {}) {
  const posts: {
    id: string;
    channel: string;
    content: string;
    message_reference?: { message_id: string };
  }[] = [];
  const unknown: string[] = [];
  let accepted!: () => void;
  const firstPost = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url!, "http://fixture");
    const path = decodeURIComponent(url.pathname);
    response.setHeader("content-type", "application/json");
    if (path.endsWith("/users/@me")) return response.end(JSON.stringify({ id: BOT, bot: true }));
    if (path.endsWith("/typing")) {
      response.removeHeader("content-type");
      response.writeHead(204);
      return response.end();
    }
    const channel = /\/channels\/([^/]+)\/messages$/.exec(path)?.[1];
    const message = (post: (typeof posts)[number]) => ({ ...post, author: { id: BOT }, attachments: [] });
    if (channel !== undefined && request.method === "GET") {
      const after = BigInt(url.searchParams.get("after") ?? "0");
      return response.end(
        JSON.stringify(
          posts.filter((post) => post.channel === channel && BigInt(post.id) > after).map(message),
        ),
      );
    }
    if (channel !== undefined && request.method === "POST") {
      const post = {
        ...JSON.parse(body),
        channel,
        id: String(1500000000000000000n + BigInt(posts.length + 1)),
      };
      posts.push(post);
      accepted();
      if (options.holdPosts === true) return;
      return response.end(JSON.stringify(message(post)));
    }
    const only = /\/channels\/([^/]+)$/.exec(path)?.[1];
    if (only !== undefined) return response.end(JSON.stringify({ id: only, type: 1 }));
    unknown.push(`${request.method} ${path}`);
    response.writeHead(404);
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback address");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return {
    api: `http://127.0.0.1:${address.port}`,
    posts,
    unknown,
    firstPost,
    release: () => {
      options.holdPosts = false;
    },
  };
}

const MESSAGE_BODY = "Write the marker to memory, then run the effect script.";

/** The bridge's half: its SQLite inbox, and one presence session and text ingress per process start. */
function bridge(f: Awaited<ReturnType<typeof privateService>>) {
  const client = new ClankieApiClient({
    baseUrl: f.url,
    captainToken: f.authorization.slice("Bearer ".length),
  });
  const inboxPath = join(f.root, "bridge-inbox.sqlite");
  const state = { inbox: new DiscordTextInbox(inboxPath, "0") };
  cleanups.push(async () => state.inbox.close());
  const body = async () => {
    const presence = new DiscordPresenceSession({
      sessionId: `discord:bot:fixture:${randomUUID()}`,
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      emit: async (event) => (await client.recordDiscordPresencePhase(event)).session,
    });
    await presence.start();
    await presence.gatewayReady();
    return new DiscordTextIngress(state.inbox.port(createAdvertisedDiscordPresencePort(client, presence)), {
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      guildIds: new Set(),
      channelIds: new Set(),
      dmPolicy: "owner_only",
      ownerUserId: OWNER,
      dmUserIds: new Set(),
      contextMessageLimit: 0,
      authenticatedSurfaceUrl: "http://fixture",
    });
  };
  const message = {
    id: MESSAGE,
    channelId: DM,
    authorId: OWNER,
    authorIsBot: false,
    mentionsBot: false,
    body: MESSAGE_BODY,
  };
  return {
    state,
    /** One pass of the bridge's delivery loop; a failed or thrown attempt stays pending for a retry. */
    deliver: async (ingress: DiscordTextIngress) => {
      let outcome: unknown;
      await state.inbox.handle(MESSAGE, async () => {
        outcome = await ingress.handle(message).catch((error: unknown) => ({ thrown: String(error) }));
      });
      return outcome;
    },
    body,
    /** The bridge process restarts: it reopens the same SQLite inbox. */
    reopen: () => {
      state.inbox.close();
      state.inbox = new DiscordTextInbox(inboxPath, "0");
    },
  };
}

it("a DM turn killed mid-shell reaches Discord once after the service restarts, through the bridge's durable inbox", async () => {
  const discord = await loopbackDiscord();
  const f = await privateService({
    requestId: MESSAGE,
    env: {
      CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE: join(
        import.meta.dirname,
        "fixtures/loopback-presence-runtime.ts",
      ),
      CLANKIE_TEST_DISCORD_API: discord.api,
    },
  });
  const b = bridge(f);

  await f.start();
  b.state.inbox.enqueue(MESSAGE, DM);
  const first = b.deliver(await b.body());
  await f.until(async () => ((await f.effects()).length === 1 ? true : undefined));
  expect((await f.journal()).steps.find((step) => step.input.name === "bash")?.output).toBeUndefined();
  await f.stop("SIGKILL");
  await f.stopTool();
  // The bridge lost the service mid-turn: nothing was posted and the delivery is still pending.
  expect(await first).not.toMatchObject({ state: "settled" });
  expect(discord.posts).toEqual([]);
  expect(b.state.inbox.pending().map((row) => row.id)).toEqual([MESSAGE]);
  const asked = f.model.seen.length;

  // Both sides restart: the service with no new input, the bridge from its SQLite inbox.
  b.reopen();
  await f.start();
  expect(await b.deliver(await b.body())).toMatchObject({ state: "settled" });

  expect(discord.posts).toMatchObject([
    {
      channel: DM,
      content: `${MESSAGE} recovered: possibly ran`,
      message_reference: { message_id: MESSAGE },
    },
  ]);
  expect(b.state.inbox.pending()).toEqual([]);
  expect(f.model.seen.length).toBe(asked + 1);
  expect(await f.effects()).toHaveLength(1);
  expect(await f.memories()).toHaveLength(1);

  // A later bridge pass over the same message neither posts nor runs anything again.
  b.reopen();
  b.state.inbox.enqueue(MESSAGE, DM);
  await b.deliver(await b.body());
  expect(discord.posts).toHaveLength(1);
  expect(f.model.seen.length).toBe(asked + 1);
  expect(discord.unknown).toEqual([]);
}, 240_000);

it("a reply Discord accepted just before the service died is reconciled after the restart, never posted twice", async () => {
  const discord = await loopbackDiscord({ holdPosts: true });
  const f = await privateService({
    requestId: MESSAGE,
    // One answer, no tools: the turn settles and its reply is the only effect.
    reply: (_messages, { requestId }) => ({ text: `${requestId} answered` }),
    env: {
      CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE: join(
        import.meta.dirname,
        "fixtures/loopback-presence-runtime.ts",
      ),
      CLANKIE_TEST_DISCORD_API: discord.api,
    },
  });
  const b = bridge(f);

  await f.start();
  b.state.inbox.enqueue(MESSAGE, DM);
  const first = b.deliver(await b.body());
  // Discord has the reply, but the service dies before it learns that.
  await discord.firstPost;
  await f.stop("SIGKILL");
  discord.release();
  expect(await first).not.toMatchObject({ state: "settled" });
  expect(discord.posts).toMatchObject([
    { channel: DM, content: `${MESSAGE} answered`, message_reference: { message_id: MESSAGE } },
  ]);
  expect(b.state.inbox.pending().map((row) => row.id)).toEqual([MESSAGE]);
  const asked = f.model.seen.length;
  expect((await f.journal()).result).toBeDefined();

  // Both sides restart; the bridge redelivers from its inbox.
  b.reopen();
  await f.start();
  expect(await b.deliver(await b.body())).toMatchObject({ state: "settled" });
  // The service read the reply back from the channel instead of posting it again.
  expect(discord.posts).toHaveLength(1);
  expect(f.model.seen.length).toBe(asked);
  expect(b.state.inbox.pending()).toEqual([]);

  // A further pass after another restart still posts nothing.
  await f.stop("SIGKILL");
  b.reopen();
  await f.start();
  b.state.inbox.enqueue(MESSAGE, DM);
  await b.deliver(await b.body());
  expect(discord.posts).toHaveLength(1);
  expect(f.model.seen.length).toBe(asked);
  expect(discord.unknown).toEqual([]);
}, 240_000);
