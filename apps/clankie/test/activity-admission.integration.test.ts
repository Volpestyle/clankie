import { serve } from "@hono/node-server";
import { DiscordPresenceSession } from "@clankie/discord-presence-core";
import { ActivityShareFrameSchema } from "@clankie/interactive-environment";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, get, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { RenderedSurfaceHub } from "../../discord-activity/src/frame-hub.ts";
import { createFrameProducerServer } from "../../discord-activity/src/producer.ts";
import { createDiscordActivityServer, forwardAdmissionToService } from "../../discord-activity/src/server.ts";
import { ActivityShareRegistry } from "../../discord-activity/src/share-registry.ts";
import { createActivityLaunches, createSelfHostedActivityAdmission } from "../src/activity-admission.ts";
import { ActivityPlaySource } from "../src/activity-play-source.ts";
import { ActivitySharing } from "../src/activity-sharing.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DeliveredFileStore } from "../src/delivered-files.ts";

const APP = "90001";
const GUILD = "111";
const CHANNEL = "222";
const PRODUCER_BEARER = "control-secret";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);
const frame = ActivityShareFrameSchema.parse({
  schemaVersion: 2,
  sequence: 1,
  width: 1,
  height: 1,
  encoding: "png",
  data: PNG.toString("base64"),
  byteLength: PNG.length,
  sha256: createHash("sha256").update(PNG).digest("hex"),
  capturedAt: new Date().toISOString(),
});
const TUNNEL = { host: "activity.clankie.bot", "cf-connecting-ip": "203.0.113.7", "cf-ray": "1-SJC" };

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

/** Discord's OAuth2 token, user and Activity-instance endpoints, as the service calls them. */
async function discordFixture() {
  const users: Record<string, string> = {
    "member-code": "501",
    "outsider-code": "502",
    "elsewhere-code": "503",
  };
  const instances: Record<string, unknown> = {
    "i-here": {
      application_id: APP,
      instance_id: "i-here",
      location: { kind: "gc", guild_id: GUILD, channel_id: CHANNEL },
      users: ["501"],
    },
    "i-elsewhere": {
      application_id: APP,
      instance_id: "i-elsewhere",
      location: { kind: "gc", guild_id: GUILD, channel_id: "999" },
      users: ["503"],
    },
    "i-foreign": {
      application_id: "77777",
      instance_id: "i-foreign",
      location: { kind: "gc", guild_id: GUILD, channel_id: CHANNEL },
      users: ["501"],
    },
  };
  const seen: string[] = [];
  const body = async (request: IncomingMessage) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    return text;
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    seen.push(`${request.method} ${url.pathname}`);
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "POST" && url.pathname === "/oauth2/token") {
      const form = new URLSearchParams(await body(request));
      const user = users[form.get("code") ?? ""];
      if (
        form.get("client_id") !== APP ||
        form.get("client_secret") !== "fixture-secret" ||
        user === undefined
      )
        return json(401, { error: "invalid_grant" });
      return json(200, {
        access_token: `user-${user}`,
        token_type: "Bearer",
        scope: "identify",
        expires_in: 604800,
      });
    }
    if (request.method === "GET" && url.pathname === "/users/@me") {
      const id = /^Bearer user-(\d+)$/u.exec(request.headers.authorization ?? "")?.[1];
      return id === undefined ? json(401, {}) : json(200, { id, username: `u${id}` });
    }
    const instance = /^\/applications\/(\d+)\/activity-instances\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && instance !== null) {
      if (request.headers.authorization !== "Bot fixture-bot") return json(401, {});
      const found = instances[decodeURIComponent(instance[2]!)];
      return found === undefined ? json(404, { code: 10_000 }) : json(200, found);
    }
    json(404, {});
  });
  return { url: await listen(server), seen };
}

async function stack(options: { clientSecret?: string | undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), "clankie-activity-admission-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const discord = await discordFixture();
  const shares = new ActivityShareRegistry();
  const hub = new RenderedSurfaceHub();
  const producer = createFrameProducerServer({ hub, shares, token: PRODUCER_BEARER });
  const producerPort = await producer.listen(0);
  cleanup.push(() => producer.close());
  const play = new ActivityPlaySource();
  // Holds the next matching producer-control response until released, so a
  // test can stop the launch while an admission waits on a real lookup.
  const gates: {
    match: (method: string, path: string) => boolean;
    hold: Promise<void>;
    reached: () => void;
  }[] = [];
  const hold = (method: string, path: string | RegExp) => {
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const arrived = new Promise<void>((done) => (reached = done));
    gates.push({
      match: (m, p) => m === method && (typeof path === "string" ? p === path : path.test(p)),
      hold: held,
      reached,
    });
    return { release, arrived };
  };
  const sharing = new ActivitySharing({
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      const path = new URL(String(input)).pathname;
      const gate = gates.findIndex((candidate) => candidate.match(init?.method ?? "GET", path));
      if (gate >= 0) {
        const [held] = gates.splice(gate, 1);
        held!.reached();
        await held!.hold;
      }
      return response;
    },
    files: new DeliveredFileStore(join(root, "artifacts")),
    token: async () => PRODUCER_BEARER,
    url: `http://127.0.0.1:${producerPort}`,
    sources: { resolve: async (sourceId) => play.resolve(sourceId) },
  });
  cleanup.push(() => sharing.close());
  const launches = createActivityLaunches(sharing);
  const admission = createSelfHostedActivityAdmission({
    applicationId: APP,
    clientSecret: async () => ("clientSecret" in options ? options.clientSecret : "fixture-secret"),
    botToken: async () => "fixture-bot",
    grant: (guildId, channelId) => launches.grant(guildId, channelId),
    discordApi: discord.url,
  });
  const service = await createClankieApp({
    captain: createStubCaptain(),
    activitySharing: sharing,
    activityAdmission: { token: async () => PRODUCER_BEARER, admit: (input) => admission.admit(input) },
    activityLaunches: launches,
    eventLogPath: join(root, "events.jsonl"),
    authenticateOperator: async () => undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer bridge"
        ? { captainId: "body", steerSourceLane: "discord_text" }
        : undefined,
    // The bot's REST effect itself is out of scope; the route's bookkeeping is the subject.
    discordPresenceRuntime: {
      execute: async (write, _session, guard) => {
        await guard?.();
        return { id: write.idempotencyKey, action: write.action, transportKind: "bot", channelId: CHANNEL };
      },
    },
  });
  const http = serve({ fetch: (req) => service.app.fetch(req), hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((done) => http.once("listening", done));
  cleanup.push(async () => {
    service.close();
    await new Promise<void>((done) => http.close(() => done()));
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("no service address");
  const serviceUrl = `http://127.0.0.1:${address.port}`;
  const activity = createDiscordActivityServer({
    hub,
    shares,
    officialAdmission: {
      applicationId: APP,
      admit: forwardAdmissionToService({ serviceUrl, token: () => PRODUCER_BEARER }),
    },
  });
  const viewerPort = await activity.listen(0);
  cleanup.push(() => activity.close());
  const viewerUrl = `http://127.0.0.1:${viewerPort}`;
  const admit = async (code: string, instanceId: string) => {
    const response = await fetch(`${viewerUrl}/.proxy/activity/admit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, instanceId }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { discord, play, launches, shares, service, hold, serviceUrl, viewerUrl, viewerPort, admit };
}

it("admits a verified participant of Clankie's own launch to live play media, through the tunnel", async () => {
  const s = await stack();
  // node:http, not fetch: fetch replaces a caller's Host header with its own.
  const config = await new Promise<unknown>((done, reject) =>
    get(`${s.viewerUrl}/.proxy/activity/config`, { headers: TUNNEL }, async (response) => {
      let text = "";
      for await (const chunk of response) text += String(chunk);
      done(JSON.parse(text));
    }).once("error", reject),
  );
  expect(config).toEqual({ mode: "official", applicationId: APP, delegated: true });

  const playSink = s.play.createSink("FireRed");
  s.launches.launched(GUILD, CHANNEL);
  const admitted = await s.admit("member-code", "i-here");
  expect(admitted.status).toBe(200);
  expect(admitted.body.session.scope).toMatchObject({
    tenantId: "local",
    guildId: GUILD,
    channelId: CHANNEL,
  });
  expect(admitted.body.session.source).toMatchObject({ kind: "game", id: "play" });
  expect(admitted.body.mediaPath).toBe(`/.proxy/activity/shares/${admitted.body.session.shareId}/frames`);
  expect(admitted.body.accessToken).toBe("user-501");
  expect(JSON.stringify(admitted.body)).not.toContain("fixture-secret");
  expect(JSON.stringify(admitted.body)).not.toContain("fixture-bot");
  expect(s.discord.seen).toEqual([
    "POST /oauth2/token",
    "GET /users/@me",
    `GET /applications/${APP}/activity-instances/i-here`,
  ]);

  const socket = new WebSocket(`ws://127.0.0.1:${s.viewerPort}${admitted.body.mediaPath}`, {
    headers: TUNNEL,
  });
  cleanup.push(() => socket.terminate());
  const messages: Record<string, any>[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise<void>((done, reject) => {
    socket.once("open", done);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ kind: "admit", grant: admitted.body.grant }));
  await vi.waitFor(() => expect(messages[0]?.kind).toBe("session"));
  playSink.publishFrame({ ...frame, schemaVersion: 1, surface: "gba_emulator", frame: 1 });
  await vi.waitFor(() => expect(messages.some((message) => message.kind === "frame")).toBe(true));

  // A second admission reuses the channel's share instead of opening another.
  const again = await s.admit("member-code", "i-here");
  expect(again.status).toBe(200);
  expect(again.body.session.shareId).toBe(admitted.body.session.shareId);
  expect(s.shares.stats()).toHaveLength(1);
});

it("refuses outsiders, unlaunched channels, foreign apps, forged bearers and a missing play source", async () => {
  const s = await stack();
  s.launches.launched(GUILD, CHANNEL);
  // Play has not started: nothing to show, so nothing is granted.
  expect((await s.admit("member-code", "i-here")).status).toBe(403);
  s.play.createSink("FireRed");
  // Authenticated, but not a participant of the instance.
  expect((await s.admit("outsider-code", "i-here")).status).toBe(403);
  // A participant of an instance in a channel Clankie never launched.
  expect((await s.admit("elsewhere-code", "i-elsewhere")).status).toBe(403);
  // An instance of some other application.
  expect((await s.admit("member-code", "i-foreign")).status).toBe(403);
  // An unknown OAuth code.
  expect((await s.admit("forged-code", "i-here")).status).toBe(403);
  expect(s.shares.stats()).toHaveLength(0);
  // Only the activity server's bearer reaches the service route.
  const direct = await fetch(`${s.serviceUrl}/v1/activity/admit`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer guess" },
    body: JSON.stringify({ code: "member-code", instanceId: "i-here" }),
  });
  expect(direct.status).toBe(401);
  // Stopping the launch forgets the channel.
  expect((await s.admit("member-code", "i-here")).status).toBe(200);
  await s.launches.stopped(GUILD, CHANNEL);
  expect(s.shares.stats()).toHaveLength(0);
  expect((await s.admit("member-code", "i-here")).status).toBe(403);
});

it("fails closed with a clear reason when the client secret is not stored", async () => {
  const s = await stack({ clientSecret: undefined });
  s.play.createSink("FireRed");
  s.launches.launched(GUILD, CHANNEL);
  const refused = await s.admit("member-code", "i-here");
  expect(refused.status).toBe(503);
  expect(refused.body).toEqual({
    error: "activity_admission_unavailable",
    detail:
      "Activity admission needs the client secret (store it in the console: /discord → Tokens → Activity client secret)",
  });
  expect(s.discord.seen).toEqual([]);
  expect(s.shares.stats()).toHaveLength(0);
});

// Admission and stop for one channel run one at a time: a stop or a
// replacement waits for the held operation, then the stale one is refused.
it("an admission waiting on its lookup when the launch stops gets nothing", async () => {
  const s = await stack();
  s.play.createSink("FireRed");
  s.launches.launched(GUILD, CHANNEL);
  const lookup = s.hold("GET", "/shares");
  const pending = s.admit("member-code", "i-here");
  await lookup.arrived;
  const stopping = s.launches.stopped(GUILD, CHANNEL);
  lookup.release();
  await stopping;
  expect((await pending).status).toBe(403);
  expect(s.shares.stats()).toHaveLength(0);
});

it("a stop during an in-flight share opening waits for it and ends it", async () => {
  const s = await stack();
  s.play.createSink("FireRed");
  s.launches.launched(GUILD, CHANNEL);
  const opening = s.hold("POST", "/shares");
  const pending = s.admit("member-code", "i-here");
  await opening.arrived;
  const stopping = s.launches.stopped(GUILD, CHANNEL);
  opening.release();
  await stopping;
  expect((await pending).status).toBe(403);
  expect(s.shares.stats()).toHaveLength(0);
});

it("a relaunch does not revive an admission begun under the stopped launch", async () => {
  const s = await stack();
  s.play.createSink("FireRed");
  s.launches.launched(GUILD, CHANNEL);
  const lookup = s.hold("GET", "/shares");
  const stale = s.admit("member-code", "i-here");
  await lookup.arrived;
  const stopping = s.launches.stopped(GUILD, CHANNEL);
  s.launches.launched(GUILD, CHANNEL);
  lookup.release();
  await stopping;
  expect((await stale).status).toBe(403);
  const fresh = await s.admit("member-code", "i-here");
  expect(fresh.status).toBe(200);
  expect(s.shares.stats()).toHaveLength(1);
});

// Adapted from the reviewer's probe: the launch registry follows the real presence route.
it("the authenticated presence route records the bot's launch and stop", async () => {
  const s = await stack();
  s.play.createSink("FireRed");
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    s.service.app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer bridge", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const session = new DiscordPresenceSession({
    sessionId: "fixture-session",
    characterId: "clankie",
    credentialRef: "discord_bot",
    transportKind: "bot",
    emit: async (event) => {
      const response = await post("/v1/discord/presence-session-events", event);
      expect(response.status).toBe(200);
      return (await response.json()).session;
    },
  });
  await session.start();
  await session.gatewayReady();
  await session.voiceStateChanged(GUILD, true, { channelId: CHANNEL, occupants: [] });
  const send = (kind: "activity_start" | "activity_stop") =>
    post(
      "/v1/discord/presence-actions",
      {
        schemaVersion: 1,
        idempotencyKey: `fixture:${kind}`,
        action: `discord.presence.${kind}`,
        identity: {
          presenceSessionId: `discord:${GUILD}:${CHANNEL}`,
          correlationId: `fixture:${kind}`,
          profileHash: "unversioned",
          characterId: "clankie",
          credentialRef: "discord_bot",
          transportKind: "bot",
        },
        payload: {
          kind,
          guildId: GUILD,
          channelId: CHANNEL,
          ...(kind === "activity_start" ? { surface: "gba_emulator" } : {}),
        },
      },
      {
        "x-clankie-discord-presence-session": session.record.sessionId,
        "x-clankie-discord-presence-phase": session.record.phase,
        "x-clankie-discord-presence-revision": String(session.record.revision),
      },
    );
  expect((await s.admit("member-code", "i-here")).status).toBe(403);
  const started = await send("activity_start");
  expect(started.status, await started.text()).toBe(200);
  expect((await s.admit("member-code", "i-here")).status).toBe(200);
  const stopped = await send("activity_stop");
  expect(stopped.status, await stopped.text()).toBe(200);
  expect(s.shares.stats()).toHaveLength(0);
  expect((await s.admit("member-code", "i-here")).status).toBe(403);
});

// Adapted from the reviewer's probes: a launch's cleanup never reaches media
// granted under the launch that replaced it, including when the replacement's
// grant response is itself delayed; without a replacement the second viewer
// shares the first viewer's share.
it.each([
  { replacement: "none", delayGrant: false },
  { replacement: "relaunch", delayGrant: false },
  { replacement: "relaunch", delayGrant: true },
  { replacement: "stop then relaunch", delayGrant: false },
  { replacement: "stop then relaunch", delayGrant: true },
] as const)(
  "a fresh viewer keeps its stream when a held opening resolves ($replacement, delayed grant: $delayGrant)",
  async ({ replacement, delayGrant }) => {
    const s = await stack();
    const playSink = s.play.createSink("FireRed");
    s.launches.launched(GUILD, CHANNEL);
    const opening = s.hold("POST", "/shares");
    const stale = s.admit("member-code", "i-here");
    await opening.arrived;
    const stopping = replacement === "stop then relaunch" ? s.launches.stopped(GUILD, CHANNEL) : undefined;
    if (replacement !== "none") s.launches.launched(GUILD, CHANNEL);
    const granting = delayGrant ? s.hold("POST", /^\/shares\/[^/]+\/grant$/u) : undefined;
    const pending = s.admit("member-code", "i-here");
    opening.release();
    expect((await stale).status).toBe(replacement === "none" ? 200 : 403);
    await stopping;
    if (granting !== undefined) {
      await granting.arrived;
      granting.release();
    }
    const fresh = await pending;
    expect(fresh.status).toBe(200);
    const socket = new WebSocket(`ws://127.0.0.1:${s.viewerPort}${fresh.body.mediaPath}`, {
      headers: TUNNEL,
    });
    cleanup.push(() => socket.terminate());
    const messages: Record<string, any>[] = [];
    let closed: number | undefined;
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    socket.on("close", (code) => (closed = code));
    await new Promise<void>((done, reject) => {
      socket.once("open", done);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ kind: "admit", grant: fresh.body.grant }));
    await vi.waitFor(() => expect(messages[0]?.kind).toBe("session"));
    expect(s.shares.stats()).toHaveLength(1);
    playSink.publishFrame({ ...frame, schemaVersion: 1, surface: "gba_emulator", frame: 1 });
    await vi.waitFor(() => expect(messages.some((message) => message.kind === "frame")).toBe(true));
    expect(messages.some((message) => message.kind === "stopped")).toBe(false);
    expect(closed).toBeUndefined();
  },
);
