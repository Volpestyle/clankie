import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { DiscordSettingsSchema, discordServerSettings } from "@clankie/protocol";
import {
  ManagedDiscordPolicyRequestSchema,
  type ManagedDiscordPolicyRequest,
} from "@clankie/protocol/managed-discord";
import { hostedDiscordContext, type HostedDiscordRequest } from "@clankie/protocol/hosted-discord";
import {
  hostedDiscordRequestDigest,
  verifyHostedDiscordPermit,
} from "@clankie/protocol/hosted-discord-crypto";
import { derivePublicGatewayHostId } from "@clankie/protocol/public-gateway";
import { createDiscordSetupApi } from "../../../packages/api-client/src/discord-api.ts";
import { HostedBodyClient } from "../src/hosted-body.ts";
import { HostedDiscordOperator } from "../src/hosted-discord.ts";
import { ManagedDiscord } from "../src/managed-discord.ts";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DiscordRoomObservations } from "../src/discord-room-observations.ts";
import { discordSettingsRevision } from "../src/discord-room-routes.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function listen(server: Server) {
  if (!server.listening) server.listen(0, "127.0.0.1");
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return `http://127.0.0.1:${address.port}`;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "managed-discord-http-"));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const accountId = "fixture-owner",
    tenantId = `tn_${"a".repeat(20)}`,
    installationId = "i".repeat(22),
    generation = "a".repeat(32),
    guildId = "10001";
  const fleetKey = generateKeyPairSync("ed25519"),
    bodyKey = generateKeyPairSync("ed25519");
  const kid = createHash("sha256")
    .update(fleetKey.publicKey.export({ format: "der", type: "spki" }))
    .digest("base64url")
    .slice(0, 16);
  const keys = new Map([[kid, fleetKey.publicKey]]);
  const token = (typ: string, claims: Record<string, unknown>) => {
    const transcript = [{ alg: "EdDSA", typ, kid }, claims]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    return `${transcript}.${sign(null, Buffer.from(transcript), fleetKey.privateKey).toString("base64url")}`;
  };
  const hostCredential = token("clankie-host", {
    iss: "clankie-fleet",
    aud: "clankie-gateway",
    tid: tenantId,
    sub: accountId,
    inst: installationId,
    hid: derivePublicGatewayHostId(accountId, installationId),
    iat: now / 1000,
    exp: now / 1000 + 21600,
  });
  let revision: string | null = null,
    active = true,
    unavailable = false,
    badProof = false;
  let authorizationCalls = 0;
  let authorizationHold:
    | { at: number; started: ReturnType<typeof latch>; release: ReturnType<typeof latch> }
    | undefined;
  let policyHold: { started: ReturnType<typeof latch>; release: ReturnType<typeof latch> } | undefined;
  const policyRequests: ManagedDiscordPolicyRequest[] = [];
  const applied: ManagedDiscordPolicyRequest[] = [];
  const requestNonces = new Set<string>();
  const fleetUrl = await listen(
    createServer(async (request, response) => {
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      try {
        expect(request.method).toBe("POST");
        expect(request.headers.authorization).toBe(`Bearer ${hostCredential}`);
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks),
          input = JSON.parse(bytes.toString("utf8")),
          path = new URL(request.url!, "http://fleet").pathname;
        if (path.endsWith("/pairing-key")) {
          send(200, { ok: true });
          return;
        }
        const timestamp = String(request.headers["x-clankie-body-timestamp"]),
          nonce = String(request.headers["x-clankie-body-nonce"]),
          digest = createHash("sha256").update(bytes).digest("base64url");
        expect(timestamp).toBe(String(now));
        expect(requestNonces.has(nonce)).toBe(false);
        requestNonces.add(nonce);
        expect(request.headers["x-clankie-body-digest"]).toBe(digest);
        expect(
          verify(
            null,
            Buffer.from(
              [
                "clankie-body-request-v1",
                "POST",
                path,
                tenantId,
                installationId,
                timestamp,
                nonce,
                digest,
              ].join("\n"),
            ),
            bodyKey.publicKey,
            Buffer.from(String(request.headers["x-clankie-body-signature"]), "base64url"),
          ),
        ).toBe(true);
        expect(input.installationId).toBe(installationId);
        if (unavailable) {
          send(503, { error: "unavailable" });
          return;
        }
        if (path.endsWith("/discord-authorize")) {
          const claims = verifyHostedDiscordPermit(input.permit, {
            tenantId,
            installationId,
            verifyKeys: keys,
            nowMs: now,
          });
          authorizationCalls++;
          if (authorizationHold?.at === authorizationCalls) {
            authorizationHold.started.resolve();
            await authorizationHold.release.promise;
          }
          if (!active || claims.sub !== accountId || claims.gen !== generation) {
            send(403, { error: "discord_grant_revoked" });
            return;
          }
          const { jti, ...common } = claims;
          send(200, {
            authorization: token("clankie-discord-authorization", {
              ...common,
              typ: "clankie-discord-authorization",
              prm: jti,
              non: badProof ? "x".repeat(22) : input.nonce,
              iat: now / 1000,
              exp: now / 1000 + 5,
            }),
          });
        } else if (path.endsWith("/discord-policy-state"))
          send(200, { generation: active ? generation : null, revision: active ? revision : null });
        else if (path.endsWith("/discord-policy")) {
          const policy = ManagedDiscordPolicyRequestSchema.parse(input);
          policyRequests.push(policy);
          if (policyHold) {
            const hold = policyHold;
            policyHold = undefined;
            hold.started.resolve();
            await hold.release.promise;
          }
          if (!active || policy.generation !== generation || policy.expectedRevision !== revision) {
            send(409, {
              error: "discord_policy_conflict",
              current: { generation: active ? generation : null, revision: active ? revision : null },
            });
            return;
          }
          expect(policy.revision).toBe(discordSettingsRevision(policy.settings));
          revision = policy.revision;
          applied.push(policy);
          send(200, { generation, revision });
        } else if (path.endsWith("/discord-directory")) {
          if (input.query.guildId && input.query.guildId !== guildId) {
            send(403, { error: "wrong_guild" });
            return;
          }
          send(200, {
            generation,
            snapshot: {
              schemaVersion: 1,
              body: "bot",
              kind: input.query.kind,
              state: "partial",
              entries: [{ id: "20001", name: "Private 🪴", kind: "text", guildId }],
              hasMore: true,
              nextCursor: "20001",
              reason: "gateway_cache_incomplete",
            },
          });
        } else if (path.endsWith("/discord-permissions"))
          send(200, {
            generation,
            snapshot: {
              body: "bot",
              guildId: input.query.guildId,
              channelId: input.query.channelId,
              permissions: {
                view_channel: "not_checked",
                send_messages: "not_checked",
                manage_channels: "not_checked",
                manage_webhooks: "not_checked",
              },
            },
          });
        else send(404, { error: "not_found" });
      } catch {
        send(400, { error: "malformed" });
      }
    }),
  );
  const bootstrap = {
    hostCredential,
    credentialExpiresAtMs: now + 21600000,
    gatewayOrigin: "https://fixture.example",
    tenantId,
    accountId,
    installationId,
    fleetVerifyKeysJson: JSON.stringify({
      keys: [{ publicKeyPem: fleetKey.publicKey.export({ type: "spki", format: "pem" }) }],
    }),
  };
  const client = new HostedBodyClient(bootstrap, {
    clock: () => now,
    fetch: (url, options) => fetch(new URL(new URL(String(url)).pathname, fleetUrl), options),
  });
  await client.registerPairingKey(bodyKey.privateKey);
  const settings = new SettingsStore(join(root, "settings.json"));
  const statePath = join(root, "policy.json");
  const manager = (environment: NodeJS.ProcessEnv = {}) =>
    new ManagedDiscord({ client, settings, statePath, environment });
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  let service: ClankieApp | undefined;
  cleanups.push(async () => service?.close());
  const makeBody = async () => {
    service?.close();
    service = await createClankieApp({
      settings,
      captain: createStubCaptain(),
      eventLogPath: join(root, "events.jsonl"),
      clock: () => new Date(now),
      discordEnvironment: {},
      roomObservations: new DiscordRoomObservations(join(root, "rooms.json")),
      hostedDiscordOperator: new HostedDiscordOperator({
        tenantId,
        installationId,
        accountId,
        key: ecdh,
        verifyKeys: keys,
        statePath: join(root, "admissions.json"),
        clock: () => now,
        authorize: (permit) => client.authorizeDiscordWeb(permit),
      }),
      discordDirectory: (query, body) => manager().directory(query, body),
    });
    return service;
  };
  await makeBody();
  const bodyUrl = await listen(
    serve({ fetch: (request) => service!.app.fetch(request), port: 0, hostname: "127.0.0.1" }) as Server,
  );
  const prepare = (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    patch: Record<string, unknown> = {},
  ) => {
    const browser = createECDH("prime256v1");
    browser.generateKeys();
    const nonce = randomBytes(16).toString("base64url");
    const context = hostedDiscordContext({ tenantId, installationId }),
      outerPath = new URL(path, "http://body").pathname;
    const secret = Buffer.from(
      hkdfSync(
        "sha256",
        browser.computeSecret(ecdh.getPublicKey()),
        Buffer.from(nonce, "base64url"),
        context,
        32,
      ),
    );
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", secret, iv);
    cipher.setAAD(Buffer.from(`${context}\nrequest\n${method}\n${outerPath}`));
    const sealed = Buffer.concat([
      iv,
      cipher.update(JSON.stringify({ path, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64url");
    const request: HostedDiscordRequest = {
      tenantId,
      installationId,
      method,
      path: outerPath,
      nonce,
      ephemeralPublicKey: browser.getPublicKey().toString("base64url"),
      sealed,
    };
    const permit = token("clankie-discord-web", {
      iss: "clankie-fleet",
      aud: "clankie-body",
      tid: tenantId,
      inst: installationId,
      sub: accountId,
      gen: generation,
      dig: hostedDiscordRequestDigest(request),
      jti: randomBytes(16).toString("base64url"),
      iat: now / 1000,
      exp: now / 1000 + 30,
      ...patch,
    });
    const envelope = { ...request, permit };
    return {
      envelope,
      async open(response: Response) {
        const wire = await response.json(),
          encrypted = Buffer.from(wire.sealed, "base64url"),
          decipher = createDecipheriv("aes-256-gcm", secret, encrypted.subarray(0, 12));
        decipher.setAAD(Buffer.from(`${context}\nresponse\n${permit}`));
        decipher.setAuthTag(encrypted.subarray(-16));
        return JSON.parse(
          Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]).toString("utf8"),
        ) as { status: number; body: string };
      },
    };
  };
  const send = (envelope: unknown) =>
    fetch(`${bodyUrl}/v1/hosted/operator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
  const api = createDiscordSetupApi({
    request: async (method, path, body) => {
      const request = prepare(method, path, body),
        response = await request.open(await send(request.envelope));
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      return JSON.parse(response.body);
    },
  });
  return {
    root,
    now,
    settings,
    client,
    manager,
    api,
    prepare,
    send,
    makeBody,
    applied,
    policyRequests,
    revoke: () => {
      active = false;
    },
    unavailable: (value: boolean) => {
      unavailable = value;
    },
    badProof: (value: boolean) => {
      badProof = value;
    },
    holdAuthorization: () => {
      const hold = { at: authorizationCalls + 2, started: latch(), release: latch() };
      authorizationHold = hold;
      return hold;
    },
    holdPolicy: () => {
      const hold = { started: latch(), release: latch() };
      policyHold = hold;
      return hold;
    },
    setRemoteRevision: (value: string) => {
      revision = value;
    },
  };
}

it("uses an encrypted account-only Discord bridge with live signed approval, durable replay and no general owner authority", async () => {
  const f = await fixture();
  const initial = await f.api.discordSettings();
  const changed = await f.api.updateDiscordSettings({
    expectedRevision: initial.revision,
    settings: {
      ...initial.settings,
      serverId: "10001",
      role: "participant",
      fleetEnabled: false,
      trackingLevel: "off",
    },
  });
  expect(changed.settings.ingressChannelIds).toEqual([]);
  expect((await f.settings.load()).discord.serverId).toBe("10001");
  const directory = await f.api.discordDirectory({ kind: "channels", guildId: "10001", limit: 1 });
  expect(directory).toMatchObject({
    state: "partial",
    hasMore: true,
    nextCursor: "20001",
    reason: "gateway_cache_incomplete",
  });
  expect(await f.manager().directory({ kind: "channels", guildId: "99999", limit: 1 }, "bot")).toMatchObject({
    state: "unavailable",
    entries: [],
  });
  expect((await f.manager().permissions({ guildId: "10001" }, "bot")).permissions.view_channel).toBe(
    "not_checked",
  );
  const replay = f.prepare("GET", "/v1/discord/settings");
  expect((await f.send(replay.envelope)).status).toBe(200);
  await f.makeBody();
  expect((await f.send(replay.envelope)).status).toBe(409);
  mkdirSync(join(f.root, "admissions.json.tmp"));
  const blocked = f.prepare("POST", "/v1/discord/settings", {
    expectedRevision: changed.revision,
    settings: { ...changed.settings, role: "admin" },
  });
  expect((await f.send(blocked.envelope)).status).toBe(503);
  expect((await f.settings.load()).discord.role).toBe("participant");
  rmSync(join(f.root, "admissions.json.tmp"), { recursive: true });
  for (const request of [
    f.prepare("GET", "/v1/accounts"),
    f.prepare("GET", "/v1/discord/settings", undefined, { sub: "other-owner" }),
    f.prepare("GET", "/v1/discord/settings", undefined, { inst: "x".repeat(22) }),
  ])
    expect((await f.send(request.envelope)).status).toBe(401);
  const altered = f.prepare("GET", "/v1/discord/settings");
  expect((await f.send({ ...altered.envelope, path: "/v1/discord/directory" })).status).toBe(401);
  f.badProof(true);
  expect((await f.send(f.prepare("GET", "/v1/discord/settings").envelope)).status).toBe(403);
  f.badProof(false);
  f.revoke();
  expect((await f.send(f.prepare("GET", "/v1/discord/settings").envelope)).status).toBe(403);
  expect(readFileSync(join(f.root, "admissions.json"), "utf8")).not.toContain("settings");
  const events = join(f.root, "events.jsonl");
  expect(existsSync(events) ? readFileSync(events, "utf8") : "").not.toContain("device.");
});

it("rechecks the live connection grant before an already admitted settings write commits", async () => {
  const f = await fixture(),
    initial = await f.api.discordSettings(),
    held = f.holdAuthorization();
  const request = f.prepare("POST", "/v1/discord/settings", {
    expectedRevision: initial.revision,
    settings: { ...initial.settings, serverId: "10001", role: "admin" },
  });
  const pending = f.send(request.envelope);
  await held.started.promise;
  f.revoke();
  held.release.resolve();
  expect((await request.open(await pending)).status).toBe(403);
  expect((await f.settings.load()).discord.serverId).toBeUndefined();
});

it("retries policy conflicts from current disk and survives outage/restart with effective environment revisions", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    discord: discordServerSettings(
      DiscordSettingsSchema.parse({ ...current.discord, serverId: "10001", role: "participant" }),
    ),
  }));
  const manager = f.manager(),
    held = f.holdPolicy(),
    pending = manager.sync();
  await held.started.promise;
  await f.settings.update((current) => ({
    ...current,
    discord: discordServerSettings({ ...current.discord, role: "admin" }),
  }));
  f.setRemoteRevision("b".repeat(64));
  held.release.resolve();
  await pending;
  expect(f.applied.map((policy) => policy.settings.role)).toEqual(["admin"]);
  expect(f.policyRequests.map((policy) => policy.settings.role)).toEqual(["participant", "admin"]);
  expect((await manager.status()).state).toBe("synced");
  const raw = discordSettingsRevision((await f.settings.load()).discord),
    before = f.applied.at(-1)!.revision;
  f.unavailable(true);
  const restarted = f.manager({ DISCORD_ROLE: "participant" });
  await restarted.sync();
  expect((await restarted.status()).state).toBe("unavailable");
  f.unavailable(false);
  await restarted.sync();
  expect((await restarted.status()).state).toBe("synced");
  expect(f.applied.at(-1)!.settings.role).toBe("participant");
  expect(f.applied.at(-1)!.revision).not.toBe(before);
  expect(discordSettingsRevision((await f.settings.load()).discord)).toBe(raw);
  const count = f.applied.length;
  await f.manager({ DISCORD_ROLE: "participant" }).sync();
  expect(f.applied).toHaveLength(count);
});
