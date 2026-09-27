import { randomBytes, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { HostedBodyClient } from "../src/hosted-body.ts";
import { HostedPairing } from "../src/hosted-pairing.ts";
import { GatewayEncryptionHost } from "../src/gateway-encryption.ts";
import { hostedFixture } from "./fixtures/hosted-body.ts";
import {
  createHostedTransport,
  pairHostedAccount,
  disconnectHosted,
  loadHostedSession,
  accountHasHostedClankie,
} from "../../tui/src/hosted-session.ts";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../../tui/src/session/operator-conversations.ts";

const apps: ClankieApp[] = [],
  roots: string[] = [];
afterEach(async () => {
  apps.splice(0).forEach((app) => app.close());
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(purpose: "operator" | null = "operator", tamper = false) {
  const f = hostedFixture();
  vi.spyOn(Date, "now").mockReturnValue(f.now);
  const root = await mkdtemp(join(tmpdir(), "hosted-tui-"));
  roots.push(root);
  const store = new FileCredentialStore(join(root, "credentials.json")),
    settings = new SettingsStore(join(root, "settings.json"));
  const credential = {
    type: "oauth" as const,
    access: "account-only-secret",
    refresh: "refresh-only-secret",
    accountId: "account-1",
    expires: f.now + 3600_000,
  };
  const bodyKey = generateKeyPairSync("ed25519");
  const hostedPairing = new HostedPairing(
    new HostedBodyClient(f.bootstrap, { clock: () => f.now }),
    bodyKey.privateKey,
    { clock: () => f.now },
  );
  const encryption = new GatewayEncryptionHost(f.hostId, randomBytes(32));
  const serviceSettings = new SettingsStore(join(root, "body-settings.json"));
  let finish!: () => void;
  const work = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let runningSignal: AbortSignal | undefined;
  const conversations = new ConversationStore(
    join(root, "conversations"),
    async (_id, message, publish, context) => {
      runningSignal = context.signal;
      await work;
      publish({ type: "message", role: "captain", text: `Completed: ${message}`, streaming: false });
    },
  );
  const app = await createClankieApp({
    captain: createStubCaptain({
      serveOperatorConversation: async (request) => {
        if (
          request.op !== "list" &&
          request.op !== "get" &&
          request.op !== "send" &&
          request.op !== "replay" &&
          request.op !== "tail"
        )
          throw new Error("Unexpected conversation operation");
        return conversations.serve(request);
      },
    }),
    hostedPairing,
    settings: serviceSettings,
    deviceSessionKey: randomBytes(32),
    clock: () => new Date(f.now),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    pairingOfferPublisher: {
      publishPairingOffer: async () => {},
      protectPairingOffer: (offer) => ({
        version: 1,
        deepLink: `clankie://connect?v=1&offer=${offer.offerSecret}#${new URLSearchParams(encryption.pairingCredential(offer))}`,
        code: offer.code,
        expiresAt: offer.expiresAt,
      }),
    },
  });
  apps.push(app);
  const seen: { path: string; body: string; authorization: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input, init),
      url = new URL(req.url),
      body = await req.text();
    seen.push({ path: url.pathname, body, authorization: req.headers.get("authorization") });
    if (url.pathname === "/fleet/v1/pairing/ticket") {
      expect(req.headers.get("authorization")).toBe("Bearer account-only-secret");
      const binding = JSON.parse(body);
      expect(binding.purpose).toBe("operator");
      return Response.json({
        ticket: f.pair({
          bkh: binding.browserPublicKeyHash,
          non: binding.nonce,
          ...(purpose ? { purpose } : {}),
        }),
        ticketId: "j".repeat(22),
        hostId: f.hostId,
        bodyPairingKey: bodyKey.publicKey.export({ format: "jwk" }).x,
      });
    }
    const path = url.pathname.slice(`/h/${f.hostId}`.length);
    if (path === "/v1/hosted/pair-offer") {
      const response = await app.app.request(path, { method: "POST", body });
      if (!tamper) return response;
      return Response.json({ ...(await response.json()), signature: randomBytes(64).toString("base64url") });
    }
    return encryption.handle(path, body, req.signal, async (request) => app.app.fetch(request));
  };
  return {
    f,
    app,
    store,
    settings,
    serviceSettings,
    fetchImpl,
    seen,
    async pair() {
      return pairHostedAccount({
        gatewayUrl: "https://api.example.test",
        credential,
        store,
        settings,
        fetchImpl,
      });
    },
    settleWork: finish,
    isRunning: () => runningSignal !== undefined && !runningSignal.aborted,
  };
}
it("pairs the Mac with signed operator authority; encrypted reconnect shares the host conversation and persona, then revocation denies it", async () => {
  const f = await fixture(),
    session = await f.pair();
  const transport = createHostedTransport(session, f.store, f.fetchImpl);
  const client = createCaptainOperatorConversationClient(createCaptainRouteClient(transport));
  expect((await client.list())[0]?.conversationId).toBe("global-default");
  await transport.request("/v1/operator/persona", { displayName: "Shared hosted identity" });
  expect((await f.serviceSettings.load()).persona.displayName).toBe("Shared hosted identity");
  const conversation = (await client.list())[0]!;
  expect(
    await client.send({
      schemaVersion: 1,
      conversationId: conversation.conversationId,
      surfaceClientId: "mac-tui",
      expectedRevision: conversation.revision,
      kind: "message",
      message: "retained context from the Mac",
    }),
  ).toMatchObject({ status: "accepted" });
  await vi.waitFor(() => expect(f.isRunning()).toBe(true));
  // The real ConversationStore owns the running job, independently of either client.
  f.settleWork();
  const second = createHostedTransport(await loadHostedSession(f.store), f.store, f.fetchImpl);
  const secondClient = createCaptainOperatorConversationClient(createCaptainRouteClient(second));
  await vi.waitFor(async () => {
    const history = await secondClient.replay({
      schemaVersion: 1,
      conversationId: "global-default",
      surfaceClientId: "companion",
    });
    expect(JSON.stringify(history)).toContain("Completed: retained context from the Mac");
  });
  expect(f.isRunning()).toBe(true);
  const wire = JSON.stringify(f.seen.filter((r) => r.path.startsWith("/h/")));
  for (const secret of [
    session.deviceToken,
    session.encryption.key,
    "account-only-secret",
    "Shared hosted identity",
  ])
    expect(wire).not.toContain(secret);
  expect(
    (
      await f.app.app.request(`/v1/devices/${session.deviceId}/revoke`, {
        method: "POST",
        headers: { authorization: "Bearer owner" },
        body: JSON.stringify({ deviceId: session.deviceId }),
      })
    ).status,
  ).toBe(200);
  await expect(second.request("/health")).rejects.toThrow("revoked");
});
it("ordinary hosted pairing cannot become an operator by claiming macOS", async () => {
  const f = await fixture(null),
    session = await f.pair();
  await expect(createHostedTransport(session, f.store, f.fetchImpl).request("/health")).rejects.toThrow(
    "operator_device_required",
  );
});
it("refuses substituted pairing signatures without saving a device or hosted mode", async () => {
  const f = await fixture("operator", true);
  await expect(f.pair()).rejects.toThrow("unauthenticated");
  await expect(loadHostedSession(f.store)).rejects.toThrow("sign-in required");
  expect((await f.settings.load()).client).toBeUndefined();
});
it("disconnect prevents cached clients from continuing and never stops hosted work", async () => {
  const f = await fixture(),
    session = await f.pair(),
    transport = createHostedTransport(session, f.store, f.fetchImpl);
  const before = f.seen.length;
  await disconnectHosted(f.settings, f.store);
  expect(f.seen.length).toBe(before);
  await expect(transport.request("/health")).rejects.toThrow("sign-in required");
  expect((await f.settings.load()).client).toEqual({ mode: "local" });
});
it("the gateway guard distinguishes an existing tenant, no tenant and an unavailable account service", async () => {
  const credential = {
    type: "oauth" as const,
    access: "account",
    refresh: "refresh",
    expires: Date.now() + 10000,
  };
  expect(
    await accountHasHostedClankie("https://api.example.test", credential, async () =>
      Response.json({ tenant: { id: "tenant" } }),
    ),
  ).toBe(true);
  expect(
    await accountHasHostedClankie("https://api.example.test", credential, async () =>
      Response.json({ tenant: null }),
    ),
  ).toBe(false);
  await expect(
    accountHasHostedClankie(
      "https://api.example.test",
      credential,
      async () => new Response(null, { status: 503 }),
    ),
  ).rejects.toThrow("unavailable");
});

it("renews near-expiry credentials through the encrypted channel and refuses expired sessions", async () => {
  const f = await fixture(),
    session = await f.pair();
  const transport = createHostedTransport(
    { ...session, sessionExpiresAt: new Date(f.f.now + 60_000).toISOString() },
    f.store,
    f.fetchImpl,
  );
  expect(await transport.request("/health")).toMatchObject({ ok: true });
  const renewed = await loadHostedSession(f.store);
  expect(renewed.encryption.key).not.toBe(session.encryption.key);
  const expired = createHostedTransport(
    { ...renewed, sessionExpiresAt: new Date(f.f.now - 1).toISOString() },
    f.store,
    f.fetchImpl,
  );
  await expect(expired.request("/health")).rejects.toThrow("expired");
});
it("cannot nest an operator bridge or route operator authority to the gateway or webhook", async () => {
  const f = await fixture(),
    session = await f.pair();
  const transport = createHostedTransport(session, f.store, f.fetchImpl);
  for (const path of ["/v1/hosted/operator", "/v1/gateway/encrypted", "/v1/hooks/linear"])
    await expect(transport.request(path, {})).rejects.toThrow("invalid_operator_route");
});
