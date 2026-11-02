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

async function loopbackDiscord() {
  const posts: { channel: string; content: string; message_reference?: { message_id: string } }[] = [];
  const unknown: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const path = decodeURIComponent(new URL(request.url!, "http://fixture").pathname);
    response.setHeader("content-type", "application/json");
    if (path.endsWith("/users/@me")) return response.end(JSON.stringify({ id: BOT, bot: true }));
    if (path.endsWith("/typing")) {
      response.removeHeader("content-type");
      response.writeHead(204);
      return response.end();
    }
    const channel = /\/channels\/([^/]+)\/messages$/.exec(path)?.[1];
    if (channel !== undefined && request.method === "GET") return response.end("[]");
    if (channel !== undefined && request.method === "POST") {
      const post = { ...JSON.parse(body), channel };
      posts.push(post);
      return response.end(
        JSON.stringify({
          ...post,
          id: String(1500000000000000000n + BigInt(posts.length)),
          author: { id: BOT },
        }),
      );
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
  return { api: `http://127.0.0.1:${address.port}`, posts, unknown };
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
  const client = new ClankieApiClient({
    baseUrl: f.url,
    captainToken: f.authorization.slice("Bearer ".length),
  });
  const inboxPath = join(f.root, "bridge-inbox.sqlite");
  let inbox = new DiscordTextInbox(inboxPath, "0");
  cleanups.push(async () => inbox.close());
  // Like the bridge, each process opens its own presence session.
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
    return new DiscordTextIngress(inbox.port(createAdvertisedDiscordPresencePort(client, presence)), {
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
    body: "Write the marker to memory, then run the effect script.",
  };
  /** One pass of the bridge's delivery loop; a failed or thrown attempt stays pending for a retry. */
  const deliver = async (ingress: DiscordTextIngress) => {
    let outcome: unknown;
    await inbox.handle(MESSAGE, async () => {
      outcome = await ingress.handle(message).catch((error: unknown) => ({ thrown: String(error) }));
    });
    return outcome;
  };

  await f.start();
  inbox.enqueue(MESSAGE, DM);
  const first = deliver(await body());
  await f.until(async () => ((await f.effects()).length === 1 ? true : undefined));
  expect((await f.journal()).steps.find((step) => step.input.name === "bash")?.output).toBeUndefined();
  await f.stop("SIGKILL");
  await f.stopTool();
  // The bridge lost the service mid-turn: nothing was posted and the delivery is still pending.
  expect(await first).not.toMatchObject({ state: "settled" });
  expect(discord.posts).toEqual([]);
  expect(inbox.pending().map((row) => row.id)).toEqual([MESSAGE]);
  const asked = f.model.seen.length;

  // Both sides restart: the service with no new input, the bridge from its SQLite inbox.
  inbox.close();
  inbox = new DiscordTextInbox(inboxPath, "0");
  await f.start();
  expect(await deliver(await body())).toMatchObject({ state: "settled" });

  expect(discord.posts).toMatchObject([
    {
      channel: DM,
      content: `${MESSAGE} recovered: possibly ran`,
      message_reference: { message_id: MESSAGE },
    },
  ]);
  expect(inbox.pending()).toEqual([]);
  expect(f.model.seen.length).toBe(asked + 1);
  expect(await f.effects()).toHaveLength(1);
  expect(await f.memories()).toHaveLength(1);

  // A later bridge pass over the same message neither posts nor runs anything again.
  inbox.close();
  inbox = new DiscordTextInbox(inboxPath, "0");
  inbox.enqueue(MESSAGE, DM);
  await deliver(await body());
  expect(discord.posts).toHaveLength(1);
  expect(f.model.seen.length).toBe(asked + 1);
  expect(discord.unknown).toEqual([]);
}, 240_000);
