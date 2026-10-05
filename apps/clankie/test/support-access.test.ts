import {
  createECDH,
  createHash,
  createDecipheriv,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
import { createGatewayEncryptedFetch } from "../../../packages/api-client/src/gateway-encryption.ts";
import { GatewayEncryptionHost, sealGatewayValue, openGatewayValue } from "../src/gateway-encryption.ts";
import { PairingOfferWireSchema, TAKE_CONTROL_GRANTS } from "@clankie/protocol";
import { pairingOfferWire } from "../src/pairing.ts";
import type { GatewayEncryptionCredential } from "@clankie/protocol/gateway-encryption";
import { createBodyTelemetry } from "@clankie/observability/body-telemetry";
import {
  SUPPORT_DEVICE_GRANTS,
  HOSTED_SUPPORT_DOMAIN,
  type SupportAccessCommand,
} from "@clankie/protocol/support-access";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { HostedPairing } from "../src/hosted-pairing.ts";
import { HostedBodyClient } from "../src/hosted-body.ts";
import { hostedFixture } from "./fixtures/hosted-body.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createCaptainConversationDispatch } from "../../relay/src/conversation-upstream.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server) {
  if (!server.listening) server.listen(0, "127.0.0.1");
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback fixture address");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  hosted = false,
  history?: { count: number; ended: boolean; restoredActive?: boolean },
  realTime = false,
) {
  const root = mkdtempSync(join(tmpdir(), "support-access-"));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const f = hostedFixture(realTime ? Math.floor(Date.now() / 1000) * 1000 : undefined);
  let now = f.now;
  const key = randomBytes(32),
    log = join(root, "events.jsonl"),
    spool = join(root, "telemetry");
  const telemetry = createBodyTelemetry({ dir: spool, writer: "service", clock: () => now });
  const historicalIds: string[] = [];
  if (history !== undefined) {
    const events = [];
    for (let index = 0; index < history.count; index++) {
      const grantId = randomUUID();
      historicalIds.push(grantId);
      const grant = {
        grantId,
        scope: "read-state",
        supportRef: "historical-private-ref",
        status: "active",
        createdAt: new Date(now - (history.ended ? 120_000 : 0)).toISOString(),
        expiresAt: new Date(now + (history.ended ? -60_000 : 60_000)).toISOString(),
      };
      const base = {
        missionId: `support:${grantId}`,
        streamKind: "mission",
        correlationId: grantId,
        profileHash: "fixture",
        occurredAt: grant.createdAt,
      };
      const grantedId = randomUUID();
      events.push(
        { ...base, id: grantedId, type: "support.grant.granted", data: { schemaVersion: 1, grant } },
        {
          ...base,
          id: randomUUID(),
          type: "support.audit.recorded",
          data: { schemaVersion: 1, sourceEventId: grantedId },
        },
      );
      if (history.ended && !(history.restoredActive && index === 0)) {
        const expiredId = randomUUID();
        events.push(
          {
            ...base,
            id: expiredId,
            type: "support.grant.expired",
            data: { schemaVersion: 1, grant: { ...grant, status: "expired" } },
          },
          {
            ...base,
            id: randomUUID(),
            type: "support.audit.recorded",
            data: { schemaVersion: 1, sourceEventId: expiredId },
          },
        );
      }
    }
    writeFileSync(log, events.map((event) => JSON.stringify(event)).join("\n") + "\n", { mode: 0o600 });
  }
  const store = new ConversationStore(
    join(root, "conversations"),
    async () => {},
    undefined,
    undefined,
    2000,
  );
  cleanups.push(() => store.close());
  const created = await store.serve({
    schemaVersion: 1,
    op: "create",
    scope: { kind: "global" },
    title: "Customer history",
  });
  if (created.op !== "create") throw new Error("No fixture conversation");
  const conversationId = created.conversation.conversationId;
  let tailStarted = latch();
  const nextTail = latch();
  let tailCalls = 0;
  const bodySigning = generateKeyPairSync("ed25519");
  const gatewayHost = new GatewayEncryptionHost(f.hostId, randomBytes(32));
  const pairing = new HostedPairing(
    new HostedBodyClient(f.bootstrap, { clock: () => now }),
    bodySigning.privateKey,
    { clock: () => now, replayPath: join(root, "tickets.json") },
  );
  let body: ClankieApp;
  const makeBody = async () =>
    createClankieApp({
      captain: createStubCaptain({
        serveOperatorConversation: (request, authority) => {
          if (request.op === "tail") {
            tailStarted.resolve();
            if (++tailCalls >= 2) nextTail.resolve();
          }
          return store.serve(request as Parameters<typeof store.serve>[0], authority);
        },
      }),
      deviceSessionKey: key,
      eventLogPath: log,
      supportTelemetry: telemetry,
      clock: () => new Date(now),
      authenticateOperator: async (r) =>
        r.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "owner" } : undefined,
      authenticateCaptain: async (r) =>
        r.headers.get("authorization") === "Bearer fixture-captain-token"
          ? { captainId: "captain", steerSourceLane: "api" }
          : undefined,
      ...(hosted
        ? {
            hostedPairing: pairing,
            pairingOfferPublisher: {
              publishPairingOffer: async () => {},
              protectPairingOffer: (offer: Parameters<typeof pairingOfferWire>[0]) => {
                const wire = pairingOfferWire(offer),
                  credential = gatewayHost.pairingCredential(offer);
                const deepLink = `${wire.deepLink}#${new URLSearchParams(credential).toString()}`;
                return { ...wire, deepLink, code: deepLink, gateway: true };
              },
            },
          }
        : {}),
    });
  body = await makeBody();
  cleanups.push(async () => body.close());
  const server = serve({
    fetch: (request) => body.app.fetch(request),
    port: 0,
    hostname: "127.0.0.1",
  }) as Server;
  const url = await listen(server);
  const owner = new ClankieApiClient({ baseUrl: url, operatorToken: "fixture-owner" });
  const authorizer = new ControlPlaneDeviceAuthorizer({ baseUrl: url });
  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: authorizer,
    dispatch: createCaptainConversationDispatch({ baseUrl: url, bearerToken: "fixture-captain-token" }),
    tailPollMs: 10,
  });
  const relay = await listen(
    createServer((request, response) => {
      void handler(request, response)
        .then((found) => {
          if (!found) {
            response.statusCode = 404;
            response.end();
          }
        })
        .catch(() => {
          response.statusCode = 500;
          response.end();
        });
    }),
  );
  const post = (path: string, input: unknown, token?: string, origin = url) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(input),
    });
  const pair = async (grantId: string) => {
    const offer = await owner.createSupportPairingOffer(grantId);
    const redeem = await post("/v1/pairing/redeem", {
      offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
      device: { name: "Support tester", platform: "unknown" },
    });
    expect(redeem.status).toBe(200);
    const pending = await redeem.json();
    expect(pending.offeredGrants).toEqual(SUPPORT_DEVICE_GRANTS);
    const widened = await post("/v1/pairing/complete", {
      completionToken: pending.completionToken,
      acceptedGrants: { ...SUPPORT_DEVICE_GRANTS, chat: true },
    });
    expect(widened.status).toBe(400);
    const complete = await post("/v1/pairing/complete", {
      completionToken: pending.completionToken,
      acceptedGrants: SUPPORT_DEVICE_GRANTS,
    });
    expect(complete.status).toBe(200);
    return complete.json() as Promise<{ deviceToken: string; deviceId: string; sessionExpiresAt: string }>;
  };
  const audit = () =>
    readdirSync(join(spool, "support-audit"))
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) =>
        readFileSync(join(spool, "support-audit", name), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
  return {
    root,
    historicalIds,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    url,
    relay,
    owner,
    store,
    conversationId,
    post,
    pair,
    audit,
    f,
    gatewayHost,
    bodySigning,
    tail: () => tailStarted.promise,
    nextTail: () => nextTail.promise,
    resetTail: () => {
      tailStarted = latch();
    },
    restart: async () => {
      body.close();
      body = await makeBody();
    },
  };
}

it("enforces owner grant lifecycle, readonly pairing, durable restart and content-free per-request audit over real HTTP", async () => {
  const f = await fixture();
  expect(
    (
      await f.post(
        "/v1/support/grants",
        { scope: "shell", durationSeconds: 60, supportRef: "ref" },
        "fixture-captain-token",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.post(
        "/v1/support/grants",
        { scope: "shell", durationSeconds: 259201, supportRef: "ref" },
        "fixture-owner",
      )
    ).status,
  ).toBe(400);
  const grant = await f.owner.createSupportGrant({
    scope: "read-state",
    durationSeconds: 120,
    supportRef: "CUSTOMER PRIVATE REFERENCE",
  });
  const device = await f.pair(grant.grantId);
  expect(Date.parse(device.sessionExpiresAt)).toBe(Date.parse(grant.expiresAt));
  const read = () =>
    fetch(`${f.url}/v1/devices/self`, { headers: { authorization: `Bearer ${device.deviceToken}` } });
  expect((await read()).status).toBe(200);
  expect(
    (
      await f.post(
        "/v1/support/grants",
        { scope: "shell", durationSeconds: 60, supportRef: "escalate" },
        device.deviceToken,
      )
    ).status,
  ).toBe(403);
  const relay = (op: string) =>
    f.post(
      "/operator/v1/dispatch",
      { schemaVersion: 1, op, ...(op === "get" ? { conversationId: f.conversationId } : {}) },
      device.deviceToken,
      f.relay,
    );
  expect((await relay("list")).status).toBe(200);
  expect((await relay("get")).status).toBe(200);
  expect((await relay("terminal_catalog")).status).toBe(403);
  expect(
    (
      await f.post(
        "/operator/v1/dispatch",
        { schemaVersion: 1, op: "create", scope: { kind: "global" }, title: "Write" },
        device.deviceToken,
        f.relay,
      )
    ).status,
  ).toBe(403);
  await f.restart();
  expect((await f.owner.listSupportGrants()).grants).toEqual([grant]);
  expect((await read()).status).toBe(200);
  expect((await f.owner.revokeSupportGrant(grant.grantId)).status).toBe("revoked");
  expect((await read()).status).toBe(401);
  expect((await relay("list")).status).toBe(401);
  const events = f.audit();
  expect(events.map((event) => event.action)).toEqual(
    expect.arrayContaining(["granted", "accessed", "revoked"]),
  );
  expect(
    events
      .filter((event) => event.action === "accessed")
      .every((event) => ["device-state", "device-session", "body-state", "other"].includes(event.routeClass)),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain("CUSTOMER PRIVATE REFERENCE");
  expect(JSON.stringify(events)).not.toContain("/operator/v1");
  expect(JSON.stringify(events)).not.toContain(device.deviceToken);
});

it("bounds open windows while keeping more than 1024 ended durable grants and rejecting restored expired authority", async () => {
  const historical = await fixture(false, { count: 1025, ended: true, restoredActive: true });
  const grant = await historical.owner.createSupportGrant({
    scope: "shell",
    durationSeconds: 60,
    supportRef: "new support window",
  });
  const listed = (await historical.owner.listSupportGrants()).grants;
  expect(listed).toHaveLength(1026);
  expect(listed.find((item) => item.grantId === historical.historicalIds[0])?.status).toBe("expired");
  expect(
    (
      await historical.post(
        `/v1/support/grants/${historical.historicalIds[0]}/pairing-offer`,
        {},
        "fixture-owner",
      )
    ).status,
  ).toBe(410);
  expect(listed.find((item) => item.grantId === grant.grantId)?.status).toBe("active");
  const full = await fixture(false, { count: 1024, ended: false });
  const refused = await full.post(
    "/v1/support/grants",
    { scope: "shell", durationSeconds: 60, supportRef: "too many" },
    "fixture-owner",
  );
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "support_window_capacity" });
});

it("fails support admission when durable audit storage fails, retains revocation and retries its audit after restart", async () => {
  const f = await fixture();
  const grant = await f.owner.createSupportGrant({
    scope: "read-state",
    durationSeconds: 120,
    supportRef: "private-ref",
  });
  const device = await f.pair(grant.grantId);
  const path = join(f.root, "telemetry", "support-audit"),
    previous = `${path}.saved`;
  renameSync(path, previous);
  writeFileSync(path, "fixture storage failure");
  const read = () =>
    fetch(`${f.url}/v1/devices/self`, { headers: { authorization: `Bearer ${device.deviceToken}` } });
  expect((await read()).status).toBe(503);
  expect(
    (
      await f.post(
        "/v1/support/grants",
        { scope: "shell", durationSeconds: 120, supportRef: "another-ref" },
        "fixture-owner",
      )
    ).status,
  ).toBe(503);
  expect((await f.owner.revokeSupportGrant(grant.grantId)).status).toBe("revoked");
  await f.restart();
  expect((await read()).status).toBe(401);
  rmSync(path);
  renameSync(previous, path);
  expect((await f.owner.listSupportGrants()).grants).toHaveLength(1);
  expect(f.audit().filter((event) => event.action === "revoked")).toHaveLength(1);
  await f.restart();
  await f.owner.listSupportGrants();
  expect(f.audit().filter((event) => event.action === "revoked")).toHaveLength(1);
});

it("stops an established history stream after authority expires or is revoked", async () => {
  for (const expire of [false, true]) {
    const f = await fixture();
    const grant = await f.owner.createSupportGrant({
      scope: "read-state",
      durationSeconds: 30,
      supportRef: "support-window",
    });
    const device = await f.pair(grant.grantId);
    const sent = await f.store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: f.conversationId,
        surfaceClientId: "customer",
        expectedRevision: f.store.conversation(f.conversationId)!.revision,
        message: "PRIVATE HISTORY FIRST",
      },
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("Fixture turn not admitted");
    await f.store.awaitRun(sent.result.runId);
    const response = await f.post(
      "/operator/v1/tail",
      {
        schemaVersion: 1,
        op: "tail",
        tail: {
          schemaVersion: 1,
          conversationId: f.conversationId,
          surfaceClientId: "support",
          limit: 100,
          waitMs: 250,
        },
      },
      device.deviceToken,
      f.relay,
    );
    const reader = response.body!.getReader();
    let received = "";
    while (!received.includes("PRIVATE HISTORY FIRST")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Stream closed before initial history");
      received += new TextDecoder().decode(chunk.value);
    }
    await f.nextTail();
    if (expire) f.advance(31_000);
    else await f.owner.revokeSupportGrant(grant.grantId);
    let after = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      after += new TextDecoder().decode(chunk.value);
    }
    expect(after).toContain("auth_failure");
    expect(f.audit().every((event) => !JSON.stringify(event).includes("PRIVATE HISTORY FIRST"))).toBe(true);
  }
});

it("suppresses a parked history page after revoke or expiry, including an already admitted stream", async () => {
  for (const expire of [false, true]) {
    const f = await fixture();
    const grant = await f.owner.createSupportGrant({
      scope: "read-state",
      durationSeconds: 30,
      supportRef: "support-issue",
    });
    const device = await f.pair(grant.grantId);
    const replay = await f.store.serve({
      schemaVersion: 1,
      op: "replay",
      replay: { schemaVersion: 1, conversationId: f.conversationId, surfaceClientId: "support", limit: 100 },
    });
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("No fixture page");
    const request = {
      schemaVersion: 1,
      op: "tail",
      tail: {
        schemaVersion: 1,
        conversationId: f.conversationId,
        surfaceClientId: "support",
        cursor: replay.result.nextCursor,
        limit: 100,
        waitMs: 250,
      },
    };
    const pending = f.post("/operator/v1/tail", request, device.deviceToken, f.relay);
    await f.tail();
    if (expire) f.advance(31_000);
    else await f.owner.revokeSupportGrant(grant.grantId);
    const response = await pending;
    const text = await response.text();
    expect(text).toContain("auth_failure");
    expect(text).not.toContain('"kind":"event"');
    expect((await f.owner.listSupportGrants()).grants[0]?.status).toBe(expire ? "expired" : "revoked");
    expect(f.audit().some((event) => event.action === (expire ? "expired" : "revoked"))).toBe(true);
  }
});

it("binds web support authority to account, command, browser and one-use durable tickets; seals customer references", async () => {
  const f = await fixture(true),
    browser = createECDH("prime256v1"),
    publicKey = browser.generateKeys().toString("base64url"),
    nonce = randomBytes(16).toString("base64url");
  const command: SupportAccessCommand = {
    action: "create",
    scope: "read-state",
    durationSeconds: 120,
    supportRef: "PRIVATE WEB REF",
  };
  const ticket = f.f.support(command, publicKey, nonce);
  const request = { version: 1, supportTicket: ticket, browserPublicKey: publicKey, nonce, command };
  expect(
    (await f.post("/v1/hosted/support", { ...request, command: { ...command, scope: "shell" } })).status,
  ).toBe(401);
  expect(
    (
      await f.post("/v1/hosted/support", {
        ...request,
        supportTicket: f.f.support(command, publicKey, nonce, { sub: "another-account" }),
      })
    ).status,
  ).toBe(401);
  const response = await f.post("/v1/hosted/support", request);
  expect(response.status).toBe(200);
  const answer = await response.json();
  expect(JSON.stringify(answer)).not.toContain("PRIVATE WEB REF");
  const jti = JSON.parse(Buffer.from(ticket.split(".")[1]!, "base64url").toString()).jti;
  expect(
    verify(
      null,
      Buffer.from(
        [
          HOSTED_SUPPORT_DOMAIN,
          f.f.hostId,
          jti,
          publicKey,
          nonce,
          answer.ephemeralPublicKey,
          answer.iv,
          answer.ciphertext,
        ].join("\n"),
      ),
      f.bodySigning.publicKey,
      Buffer.from(answer.signature, "base64url"),
    ),
  ).toBe(true);
  const info = `${HOSTED_SUPPORT_DOMAIN}\n${f.f.hostId}`,
    key = hkdfSync(
      "sha256",
      browser.computeSecret(Buffer.from(answer.ephemeralPublicKey, "base64url")),
      Buffer.from(nonce, "base64url"),
      info,
      32,
    );
  const ciphertext = Buffer.from(answer.ciphertext, "base64url"),
    decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(answer.iv, "base64url"));
  decipher.setAAD(Buffer.from(info));
  decipher.setAuthTag(ciphertext.subarray(-16));
  const grant = JSON.parse(
    Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString(),
  );
  expect(grant.supportRef).toBe("PRIVATE WEB REF");
  expect((await f.post("/v1/hosted/support", request)).status).toBe(401);
  await f.restart();
  expect((await f.post("/v1/hosted/support", request)).status).toBe(401);
  expect((await f.owner.listSupportGrants()).grants[0]?.grantId).toBe(grant.grantId);
});

it("issues and revokes support through a genuine encrypted Take Control device and the hosted owner bridge", async () => {
  const f = await fixture(true, undefined, true),
    browser = createECDH("prime256v1"),
    browserPublicKey = browser.generateKeys().toString("base64url"),
    nonce = randomBytes(16).toString("base64url");
  const pairTicket = f.f.pair({
    purpose: "operator",
    non: nonce,
    bkh: createHash("sha256").update(Buffer.from(browserPublicKey, "base64url")).digest("base64url"),
  });
  const answer = await (
    await f.post("/v1/hosted/pair-offer", { version: 2, pairTicket, browserPublicKey, nonce })
  ).json();
  expect(
    verify(
      null,
      Buffer.from(
        [
          "clankie-hosted-pair-v2",
          f.f.hostId,
          "j".repeat(22),
          browserPublicKey,
          nonce,
          answer.ephemeralPublicKey,
          answer.iv,
          answer.ciphertext,
        ].join("\n"),
      ),
      f.bodySigning.publicKey,
      Buffer.from(answer.signature, "base64url"),
    ),
  ).toBe(true);
  const info = `clankie-hosted-pair-v2\n${f.f.hostId}`,
    key = hkdfSync(
      "sha256",
      browser.computeSecret(Buffer.from(answer.ephemeralPublicKey, "base64url")),
      Buffer.from(nonce, "base64url"),
      info,
      32,
    );
  const ciphertext = Buffer.from(answer.ciphertext, "base64url"),
    decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(answer.iv, "base64url"));
  decipher.setAAD(Buffer.from(info));
  decipher.setAuthTag(ciphertext.subarray(-16));
  const offer = JSON.parse(
    Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString(),
  );
  const link = new URL(offer.link),
    fragment = new URLSearchParams(link.hash.slice(1));
  const credential: GatewayEncryptionCredential = {
    hostId: fragment.get("hostId")!,
    key: fragment.get("key")!,
    ticket: fragment.get("ticket")!,
  };
  const outside: string[] = [];
  const gateway = await listen(
    serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const body = await request.text();
        outside.push(body);
        return f.gatewayHost.handle(
          new URL(request.url).pathname.slice(`/h/${f.f.hostId}`.length),
          body,
          request.signal,
          (inner) => fetch(new Request(`${f.url}${new URL(inner.url).pathname}`, inner)),
        );
      },
    }) as Server,
  );
  const encrypted = createGatewayEncryptedFetch({
    credential: () => credential,
    crypto: {
      randomBytes,
      seal: async (key, value, aad) => sealGatewayValue(Buffer.from(key, "base64"), value, aad),
      open: async (key, value, aad) => openGatewayValue(Buffer.from(key, "base64"), value, aad),
    },
  });
  const pairStep = async (path: string, body: unknown) => {
    const response = await encrypted(`${gateway}/h/${f.f.hostId}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    credential.ticket = response.headers.get("x-clankie-encryption-ticket")!;
    credential.key = response.headers.get("x-clankie-encryption-key")!;
    return response.json();
  };
  const pending = await pairStep("/v1/pairing/redeem", {
    offerSecret: link.searchParams.get("offer"),
    device: { name: "Customer control phone", platform: "ios" },
  });
  const control = await pairStep("/v1/pairing/complete", {
    completionToken: pending.completionToken,
    acceptedGrants: TAKE_CONTROL_GRANTS,
  });
  const bridge: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    return encrypted(`${gateway}/h/${f.f.hostId}/v1/hosted/operator`, {
      method: "POST",
      headers: { authorization: `Bearer ${control.deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        method: request.method,
        path: new URL(request.url).pathname,
        ...(request.method === "GET" ? {} : { body: await request.text() }),
      }),
    });
  };
  const owner = new ClankieApiClient({
    baseUrl: gateway,
    operatorToken: control.deviceToken,
    fetchImpl: bridge,
  });
  const grant = await owner.createSupportGrant({
    scope: "read-state",
    durationSeconds: 120,
    supportRef: "ENCRYPTED CUSTOMER SUPPORT REF",
  });
  expect((await owner.listSupportGrants()).grants).toEqual([grant]);
  expect(
    PairingOfferWireSchema.parse(await owner.createSupportPairingOffer(grant.grantId)).deepLink,
  ).toContain("clankie://");
  expect((await owner.revokeSupportGrant(grant.grantId)).status).toBe("revoked");
  expect((await owner.listSupportGrants()).grants[0]?.status).toBe("revoked");
  const wire = outside.join("\n");
  expect(wire).not.toContain(control.deviceToken);
  expect(wire).not.toContain("ENCRYPTED CUSTOMER SUPPORT REF");
});
