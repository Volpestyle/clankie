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
import { OFFICIAL_DISCORD_PATHS } from "@clankie/protocol/official-discord";
import { createStubCaptain } from "../src/captain/port.ts";
import { createDiscordIngressRoutes } from "../src/discord-ingress.ts";
import { OfficialDiscordIngress, officialDiscordKeyProvider } from "../src/official-discord.ts";

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
