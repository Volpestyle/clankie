import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { DiscordIngressEventSchema, type DiscordIngressEvent } from "@clankie/protocol/discord-ingress";
import { prepareDiscordIngress } from "@clankie/protocol/discord-ingress-crypto";
import { OFFICIAL_DISCORD_PATHS, type OfficialDiscordStatus } from "@clankie/protocol/official-discord";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
import { SettingsStore } from "@clankie/settings";
import { Hono } from "hono";
import { runDiscordOfficialCommand } from "../../tui/src/command/discord-official.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createDiscordIngressRoutes } from "../src/discord-ingress.ts";
import { DiscordRoomObservations } from "../src/discord-room-observations.ts";
import { createDiscordRoomRoutes } from "../src/discord-room-routes.ts";
import {
  OfficialDiscordControl,
  OfficialDiscordIngress,
  officialDiscordKeyProvider,
} from "../src/official-discord.ts";

const routeId = `tn_${"f".repeat(20)}`;
const installationId = "i".repeat(22);
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A real loopback HTTP fleet stands in for the hosted account route: it checks
 * the account bearer, records the machine's key, and signs permits with a real
 * Ed25519 key exactly as the fleet signer does. The edge side seals with the
 * production protocol client.
 */
async function fixture(options: { refuse?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "official-discord-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const signing = generateKeyPairSync("ed25519");
  const kid = createHash("sha256")
    .update(signing.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64url")
    .slice(0, 16);
  const registrations: { authorization?: string; body: { installationId: string; publicKey: string } }[] = [];
  let refuse = options.refuse;
  const server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    response.setHeader("content-type", "application/json");
    if (request.url !== OFFICIAL_DISCORD_PATHS.register || request.method !== "POST") {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (request.headers.authorization !== "Bearer account-token") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (refuse !== undefined) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: refuse }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    registrations.push({ authorization: request.headers.authorization, body });
    response.end(
      JSON.stringify({
        routeId,
        installationId: body.installationId,
        verifyKeys: {
          keys: [{ publicKeyPem: signing.publicKey.export({ format: "pem", type: "spki" }).toString() }],
        },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback port");
  const store = new FileCredentialStore(join(root, "credentials.json"));
  const submitDiscordTurn = vi.fn(async () => ({
    state: "settled" as const,
    captainSessionId: "session",
    turnId: "turn",
    response: "PRIVATE_REPLY",
  }));
  const codes: string[] = [];
  const open = () =>
    new OfficialDiscordIngress({
      gatewayUrl: `http://127.0.0.1:${String(address.port)}`,
      installationId,
      store,
      statePath: join(root, "ingress.json"),
      captain: createStubCaptain({ submitDiscordTurn }),
      resolveAccountToken: async () => ({ token: "account-token" }),
      onCode: (code) => codes.push(code),
      retryMs: 20,
    });
  function sealed(event: DiscordIngressEvent, publicKey: string) {
    const prepared = prepareDiscordIngress(event, publicKey);
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "clankie-discord", kid })).toString(
      "base64url",
    );
    const iat = Math.floor(Date.now() / 1000);
    const claims = Buffer.from(
      JSON.stringify({
        typ: "clankie-discord",
        aud: "clankie-body",
        iss: "clankie-fleet",
        tid: event.tenantId,
        inst: event.installationId,
        dig: prepared.digest,
        jti: randomBytes(16).toString("base64url"),
        iat,
        exp: iat + 60,
      }),
    ).toString("base64url");
    return prepared.seal(
      `${header}.${claims}.${sign(null, Buffer.from(`${header}.${claims}`), signing.privateKey).toString("base64url")}`,
    );
  }
  return {
    root,
    store,
    open,
    sealed,
    registrations,
    submitDiscordTurn,
    codes,
    allow: () => {
      refuse = undefined;
    },
  };
}

function event(overrides: Partial<DiscordIngressEvent> = {}): DiscordIngressEvent {
  const now = Date.now();
  return DiscordIngressEventSchema.parse({
    schemaVersion: 1,
    tenantId: routeId,
    installationId,
    deliveryId: "discord:900",
    eventAtMs: now,
    expiresAtMs: now + 300_000,
    guildId: "100",
    channelId: "200",
    messageId: "900",
    actorId: "300",
    owner: true,
    kind: "message",
    content: "PRIVATE_TRIGGER clankie what do you think?",
    context: [
      { messageId: "898", actorId: "301", content: "PRIVATE_CONTEXT one", atMs: now - 2_000 },
      { messageId: "899", actorId: "302", content: "PRIVATE_CONTEXT two", atMs: now - 1_000 },
    ],
    ...overrides,
  });
}

it("registers a self-hosted machine with its account and answers sealed official-bot deliveries locally", async () => {
  const f = await fixture();
  const ingress = f.open();
  cleanups.push(() => ingress.close());
  const app = createDiscordIngressRoutes(ingress);
  // Nothing can have been sealed to a key the fleet has not confirmed.
  expect(
    (
      await app.request("/v1/discord/ingress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(503);
  const registration = await ingress.register();
  expect(registration?.routeId).toBe(routeId);
  expect(f.registrations).toHaveLength(1);
  const stored = await f.store.get(officialDiscordKeyProvider(installationId));
  expect(stored?.type).toBe("api");
  const publicKey = f.registrations[0]!.body.publicKey;

  const delivered = event();
  const request = f.sealed(delivered, publicKey);
  const first = await (
    await app.request("/v1/discord/ingress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.envelope),
    })
  ).json();
  expect(request.openResponse(first.sealed)).toEqual({ state: "pending" });
  await vi.waitFor(() => expect(f.submitDiscordTurn).toHaveBeenCalledTimes(1));
  const [turn, authority] = f.submitDiscordTurn.mock.calls[0] as unknown as [
    { trigger: { kind: string; body: string }; contextMessages: { id: string; body: string }[] },
    { verifiedOwner: boolean },
  ];
  // The edge's owner flag grants nothing on a self-hosted machine.
  expect(authority.verifiedOwner).toBe(false);
  expect(turn.trigger).toMatchObject({ kind: "message", body: "PRIVATE_TRIGGER clankie what do you think?" });
  expect(turn.contextMessages.map((message) => [message.id, message.body])).toEqual([
    ["898", "PRIVATE_CONTEXT one"],
    ["899", "PRIVATE_CONTEXT two"],
  ]);
  await vi.waitFor(async () => {
    const poll = f.sealed(delivered, publicKey);
    const answer = await (
      await app.request("/v1/discord/ingress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(poll.envelope),
      })
    ).json();
    expect(JSON.stringify(answer)).not.toContain("PRIVATE_REPLY");
    expect(poll.openResponse(answer.sealed)).toEqual({ state: "reply", text: "PRIVATE_REPLY" });
  });
  // A permit for another route never opens here.
  const foreign = f.sealed(event({ tenantId: `tn_${"g".repeat(20)}`, deliveryId: "discord:901" }), publicKey);
  expect(
    (
      await app.request("/v1/discord/ingress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(foreign.envelope),
      })
    ).status,
  ).toBe(401);
  expect(readFileSync(join(f.root, "credentials.json"), "utf8")).not.toContain("PRIVATE");

  // A restart keeps the same machine key, so the edge's sealed deliveries still open.
  const restarted = f.open();
  cleanups.push(() => restarted.close());
  await restarted.register();
  expect(f.registrations.at(-1)?.body.publicKey).toBe(publicKey);
});

it("retries a refused registration and reports why, without accepting deliveries", async () => {
  const f = await fixture({ refuse: "official_discord_blocked" });
  const ingress = f.open();
  cleanups.push(() => ingress.close());
  expect(await ingress.register()).toBeUndefined();
  expect(ingress.ready).toBe(false);
  expect(f.codes).toContain("official_discord_register_failed:official_discord_blocked");
  f.allow();
  await vi.waitFor(() => expect(ingress.ready).toBe(true));
});

/**
 * The body route the app and `clankie discord official` share (VUH-1766): a
 * real loopback fleet reports registration, server, blocks and usage; the
 * service's route, its ingress and the CLI run over real HTTP.
 */
async function routeFixture() {
  const root = mkdtempSync(join(tmpdir(), "official-discord-route-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const fleet = {
    registered: false,
    unregistered: 0,
    registrations: 0,
    blocked: undefined as OfficialDiscordStatus["blocked"],
    usage: undefined as OfficialDiscordStatus["usage"],
  };
  let gatewayUrl = "";
  const server = createServer(async (request: IncomingMessage, response) => {
    for await (const _ of request) void _;
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== "Bearer account-token") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.url === OFFICIAL_DISCORD_PATHS.register && request.method === "POST") {
      fleet.registered = true;
      fleet.registrations++;
      const signing = generateKeyPairSync("ed25519");
      response.end(
        JSON.stringify({
          routeId,
          installationId,
          verifyKeys: {
            keys: [{ publicKeyPem: signing.publicKey.export({ format: "pem", type: "spki" }).toString() }],
          },
        }),
      );
      return;
    }
    if (request.url === OFFICIAL_DISCORD_PATHS.unregister && request.method === "POST") {
      fleet.registered = false;
      fleet.unregistered++;
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === OFFICIAL_DISCORD_PATHS.status && request.method === "GET") {
      const status: OfficialDiscordStatus = {
        registered: fleet.registered,
        ...(fleet.registered ? { routeId, installationId } : {}),
        applicationId: "424242",
        installUrl: `${gatewayUrl}/fleet/account/?discord=self-hosted`,
        ...(fleet.blocked ? { blocked: fleet.blocked } : {}),
        discord: fleet.registered
          ? { connected: true, guildId: "100", guildName: "Fixture server" }
          : { connected: false },
        ...(fleet.usage ? { usage: fleet.usage } : {}),
      };
      response.end(JSON.stringify(status));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  const fleetAddress = server.address();
  if (!fleetAddress || typeof fleetAddress === "string") throw new Error("no loopback port");
  gatewayUrl = `http://127.0.0.1:${String(fleetAddress.port)}`;

  const settings = new SettingsStore(join(root, "settings.json"));
  const store = new FileCredentialStore(join(root, "credentials.json"));
  const control = new OfficialDiscordControl({
    settings,
    account: { gatewayUrl, installationId, resolveAccountToken: async () => ({ token: "account-token" }) },
    open: (account) =>
      new OfficialDiscordIngress({
        ...account,
        store,
        statePath: join(root, "ingress.json"),
        captain: createStubCaptain(),
        retryMs: 20,
      }),
  });
  await control.start();
  cleanups.push(() => control.close());
  const app = new Hono();
  app.route(
    "/",
    createDiscordRoomRoutes({
      settings,
      environment: {},
      observations: new DiscordRoomObservations(join(root, "rooms.json")),
      captain: createStubCaptain(),
      officialBot: control,
      // The operator takes control; an observing device only reads.
      authorize: async (request, access) => {
        const bearer = request.headers.get("authorization");
        return bearer === "Bearer fixture-operator" ||
          (bearer === "Bearer fixture-observer" && access === "observe")
          ? { current: () => true, guard: async () => undefined }
          : undefined;
      },
    }),
  );
  app.route("/", createDiscordIngressRoutes(control));
  const host = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const result = await app.request(`http://127.0.0.1${request.url ?? "/"}`, {
      method: request.method ?? "GET",
      headers: new Headers(
        Object.entries(request.headers).flatMap(([key, value]): [string, string][] =>
          value ? [[key, String(value)]] : [],
        ),
      ),
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  cleanups.push(() => new Promise<void>((done) => host.close(() => done())));
  const hostAddress = host.address();
  if (!hostAddress || typeof hostAddress === "string") throw new Error("no loopback port");
  const url = `http://127.0.0.1:${String(hostAddress.port)}`;
  const cli = (verb: string) =>
    runDiscordOfficialCommand([verb], { host: url, env: { CLANKIE_OPERATOR_TOKEN: "fixture-operator" } });
  const ingress = async () =>
    (
      await fetch(`${url}/v1/discord/ingress`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status;
  return { url, fleet, settings, cli, ingress };
}

it("turns the official bot on and off through the body route without a restart, reporting fleet status", async () => {
  const f = await routeFixture();
  expect(await f.cli("status")).toMatchObject({
    ok: true,
    schemaVersion: 1,
    enabled: false,
    running: false,
    signedIn: true,
    official: { registered: false, discord: { connected: false } },
  });
  expect(await f.ingress()).toBe(404);

  const on = await f.cli("on");
  expect(on).toMatchObject({
    enabled: true,
    running: true,
    official: { registered: true, discord: { connected: true, guildName: "Fixture server" } },
  });
  expect(on).not.toHaveProperty("next");
  expect(f.fleet.registrations).toBe(1);
  expect((await f.settings.load()).discord.officialBotEnabled).toBe(true);
  // Deliveries now reach the registered ingress, which refuses this unsealed one.
  expect(await f.ingress()).toBe(401);
  // Turning it on again is idempotent: no second registration.
  await f.cli("on");
  expect(f.fleet.registrations).toBe(1);

  // An observing device reads usage and a block, as the fleet reports them.
  f.fleet.usage = [{ limit: "account_wakes_per_day", used: 3, max: 3, resetsAtMs: 1 }];
  f.fleet.blocked = { scope: "server", reason: "spam reports", atMs: 1 };
  const observer = new ClankieApiClient({ baseUrl: f.url, operatorToken: "fixture-observer" });
  const read = await observer.discordOfficial();
  expect(read.official?.usage).toEqual(f.fleet.usage);
  expect(read.official?.blocked).toMatchObject({ scope: "server", reason: "spam reports" });
  expect(read.next).toContain("spam reports");
  // Only the operator turns it on or off.
  await expect(observer.setDiscordOfficial(false)).rejects.toThrow("Clankie API 403");
  expect((await f.settings.load()).discord.officialBotEnabled).toBe(true);

  const off = await new ClankieApiClient({
    baseUrl: f.url,
    operatorToken: "fixture-operator",
  }).setDiscordOfficial(false);
  expect(off).toMatchObject({ enabled: false, running: false, official: { registered: false } });
  expect(f.fleet.unregistered).toBe(1);
  expect((await f.settings.load()).discord.officialBotEnabled).toBe(false);
  expect(await f.ingress()).toBe(404);
});

it("refuses to turn on while this machine's own bot is the official application, changing nothing", async () => {
  const f = await routeFixture();
  await f.settings.update((value) => ({
    ...value,
    discord: { ...value.discord, applicationId: "424242", activeBody: "bot" },
  }));
  await expect(f.cli("on")).rejects.toThrow("own Discord bot is the official Clankie application");
  const response = await fetch(`${f.url}/v1/discord/official`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-operator", "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "official_application_is_local_bot" });
  expect((await f.settings.load()).discord.officialBotEnabled).toBe(false);
  expect(f.fleet.registrations).toBe(0);
  expect(await f.ingress()).toBe(404);
});
