import { randomBytes, generateKeyPairSync, createHash, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { serve } from "@hono/node-server";
import { ActivitySharing } from "../src/activity-sharing.ts";
import { DeliveredFileStore } from "../src/delivered-files.ts";
import { RenderedSurfaceHub } from "../../discord-activity/src/frame-hub.ts";
import { ActivityShareRegistry } from "../../discord-activity/src/share-registry.ts";
import { createFrameProducerServer } from "../../discord-activity/src/producer.ts";
import { hostedCommand } from "../../tui/src/command/hosted.ts";
import { runShareCommand, shareConsoleCommand } from "../../tui/src/command/share.ts";
import type { ClankieFaceShell } from "../../tui/src/shell/shell.ts";
import { runHeadlessCaptainCommand } from "../../tui/bin/headless-captain.ts";
import { FLEET_AUTONOMY_DEFAULTS } from "@clankie/protocol";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
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
async function fixture(
  purpose: "operator" | null = "operator",
  tamper = false,
  options: { activitySharing?: ActivitySharing; realClock?: boolean } = {},
) {
  const f = hostedFixture(options.realClock ? Math.floor(Date.now() / 1000) * 1000 : undefined);
  if (!options.realClock) vi.spyOn(Date, "now").mockReturnValue(f.now);
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
    ...(options.activitySharing === undefined ? {} : { activitySharing: options.activitySharing }),
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
    const machine = { id: "machine-1", name: "My hosted Clankie", hostId: f.hostId, state: "running" };
    if (url.pathname === "/fleet/v1/machines") return Response.json({ machines: [machine] });
    if (url.pathname === "/fleet/v1/pairing/offer") {
      expect(req.headers.get("authorization")).toBe("Bearer account-only-secret");
      const binding = JSON.parse(body);
      expect(binding.machineId).toBe(machine.id);
      const pairTicket = f.pair({
        bkh: createHash("sha256")
          .update(Buffer.from(binding.browserPublicKey, "base64url"))
          .digest("base64url"),
        non: binding.nonce,
        ...(purpose ? { purpose } : {}),
      });
      const response = await app.app.request("/v1/hosted/pair-offer", {
        method: "POST",
        body: JSON.stringify({
          version: 2,
          pairTicket,
          browserPublicKey: binding.browserPublicKey,
          nonce: binding.nonce,
        }),
      });
      const answer = (await response.json()) as Record<string, unknown>;
      return Response.json({
        machine,
        ticketId: "j".repeat(22),
        bodyPairingKey: bodyKey.publicKey.export({ format: "jwk" }).x,
        answer: tamper ? { ...answer, signature: randomBytes(64).toString("base64url") } : answer,
      });
    }
    const path = url.pathname.slice(`/h/${f.hostId}`.length);
    return encryption.handle(path, body, req.signal, async (request) => app.app.fetch(request));
  };
  return {
    f,
    app,
    store,
    settings,
    env: {
      CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
      CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
    },
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
it("hosted share CLI and console use the signed paired-device encrypted HTTP route, retain receipts, and refuse after revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-share-"));
  roots.push(root);
  const shares = new ActivityShareRegistry();
  const producer = createFrameProducerServer({
    hub: new RenderedSurfaceHub(),
    shares,
    token: "fixture-private-media",
  });
  const port = await producer.listen(0);
  const sharing = new ActivitySharing({
    files: new DeliveredFileStore(join(root, "files")),
    token: async () => "fixture-private-media",
    url: `http://127.0.0.1:${port}`,
    tenantId: `tn_${"a".repeat(20)}`,
    installationId: "i".repeat(22),
    authorizeDestination: async (scope) => scope.guildId === "10001" && scope.channelId === "20001",
    sources: {
      resolve: async (id) =>
        id === "play"
          ? { source: { kind: "game", id: "firered", title: "FireRed" }, attach: () => {} }
          : undefined,
    },
    launch: async (session, receiptId) => ({
      outcome: "confirmed",
      receiptId,
      session,
      inviteUrl: "https://discord.gg/fixtureInvite",
    }),
  });
  const f = await fixture("operator", false, { activitySharing: sharing, realClock: true });
  const paired = await f.pair();
  // The established signed-pairing fixture supplies the account boundary;
  // command requests themselves use actual loopback HTTP and production crypto.
  const gateway = serve({ fetch: (request) => f.fetchImpl(request), hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((done) => gateway.once("listening", done));
  const address = gateway.address();
  if (address === null || typeof address === "string") throw new Error("gateway_fixture_unavailable");
  const session = { ...paired, gatewayUrl: `http://127.0.0.1:${address.port}` };
  await f.store.set("clankie-hosted-device", { type: "api", key: JSON.stringify(session) });
  await f.settings.update((settings) => ({
    ...settings,
    client: { mode: "hosted", gatewayUrl: session.gatewayUrl, hostId: session.encryption.hostId },
  }));
  const transport = createHostedTransport(session, f.store);
  try {
    const started = (await hostedCommand(
      [
        "share",
        "request",
        JSON.stringify({ action: "start", sourceId: "play", guildId: "10001", channelId: "20001" }),
      ],
      transport,
    )) as {
      session: { shareId: string; generation: number; scope: unknown };
      receipt: { outcome: string; inviteUrl: string };
    };
    expect(started.receipt).toMatchObject({
      outcome: "confirmed",
      inviteUrl: "https://discord.gg/fixtureInvite",
    });
    expect(started.session.scope).toEqual({
      tenantId: f.f.bootstrap.tenantId,
      installationId: f.f.bootstrap.installationId,
      guildId: "10001",
      channelId: "20001",
    });
    const client = new ClankieApiClient({
      baseUrl: transport.host,
      fetchImpl: transport.fetchImpl,
      operatorToken: "hosted-device-transport",
    });
    expect(await client.activityShares({ action: "list" })).toMatchObject({ sessions: [started.session] });
    let cliOutput = "",
      cliError = "";
    expect(
      await runHeadlessCaptainCommand(["share", "list"], {
        repoRoot: root,
        env: f.env,
        stdout: {
          write: (value) => {
            cliOutput += value;
          },
        },
        stderr: {
          write: (value) => {
            cliError += value;
          },
        },
      }),
      cliError,
    ).toBe(0);
    expect(JSON.parse(cliOutput)).toMatchObject({ sessions: [started.session] });
    const results: { text: string; tone: string }[] = [];
    const command = shareConsoleCommand((args) => runShareCommand(args, { request: transport.request }));
    const shell = {
      insertCommandResult: (_name: string, text: string, tone: string) => results.push({ text, tone }),
    } as unknown as ClankieFaceShell;
    await command.run("list", shell);
    expect(results[0]?.tone).toBe("success");
    expect(JSON.parse(results[0]!.text)).toMatchObject({ sessions: [started.session] });
    await hostedCommand(
      [
        "share",
        "request",
        JSON.stringify({
          action: "stop",
          shareId: started.session.shareId,
          generation: started.session.generation,
        }),
      ],
      transport,
    );
    expect(await hostedCommand(["share", "list"], transport)).toEqual({ sessions: [] });
    const wire = JSON.stringify(f.seen.filter((request) => request.path.startsWith("/h/")));
    for (const secret of [
      session.deviceToken,
      session.encryption.key,
      "fixture-private-media",
      "fixtureInvite",
      "sourceId",
      "account-only-secret",
    ])
      expect(wire).not.toContain(secret);
    await f.app.app.request(`/v1/devices/${session.deviceId}/revoke`, {
      method: "POST",
      headers: { authorization: "Bearer owner" },
      body: JSON.stringify({ deviceId: session.deviceId }),
    });
    await expect(hostedCommand(["share", "list"], transport)).rejects.toThrow("revoked");
    await command.run("list", shell);
    expect(results.at(-1)?.tone).toBe("error");
    expect(results.at(-1)?.text).toContain("revoked");
  } finally {
    await sharing.close();
    await producer.close();
    await new Promise<void>((done) => gateway.close(() => done()));
  }
});
it("persists fleet and project autonomy over the real signed encrypted operator bridge while preserving its route boundary", async () => {
  const f = await fixture(),
    session = await f.pair();
  await f.serviceSettings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [{ id: "garden", name: "Garden", autonomy: { fleet: { closure: "owner" } } }],
    }),
  }));
  const transport = createHostedTransport(session, f.store, f.fetchImpl);
  const client = new ClankieApiClient({
    baseUrl: transport.host,
    operatorToken: session.deviceToken,
    fetchImpl: transport.fetchImpl,
  });
  const fleet = await client.fleetSettings();
  await client.updateFleetSettings({
    schemaVersion: 1,
    expectedRevision: fleet.revision,
    changes: { closure: "owner", machineSetup: "owner" },
  });
  const projects = await client.projects();
  expect(projects.autonomyDefaults?.fleet).toEqual({
    ...FLEET_AUTONOMY_DEFAULTS,
    closure: "owner",
    machineSetup: "owner",
  });
  const changed = await client.updateProjectSettings({
    projectId: "garden",
    expectedRevision: projects.revision,
    changes: { autonomy: { fleet: { closure: null, machineSetup: "lead" } } },
  });
  expect(changed.settings.projects[0]!.autonomy).toEqual({ fleet: { machineSetup: "lead" } });
  const saved = await new SettingsStore(f.serviceSettings.path).load();
  expect(saved.autonomy.fleet).toEqual({
    ...FLEET_AUTONOMY_DEFAULTS,
    closure: "owner",
    machineSetup: "owner",
  });
  expect(saved.projects.projects[0]!.autonomy).toEqual({ fleet: { machineSetup: "lead" } });
  for (const path of [
    "/v1/operator/fleet-settings/context",
    "/v1/operator/projects/create",
    "/v1/operator/projects?includeAutonomy=true&unknown=true",
    "/v1/operator/projects?includeAutonomy=true&includeAutonomy=true",
  ]) {
    await expect(transport.request(path)).rejects.toThrow();
    const direct = await f.app.app.request("/v1/hosted/operator", {
      method: "POST",
      headers: { authorization: `Bearer ${session.deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ method: "GET", path }),
    });
    expect(direct.status).toBe(400);
  }
  const ordinary = await fixture(null),
    ordinarySession = await ordinary.pair();
  const ordinaryTransport = createHostedTransport(ordinarySession, ordinary.store, ordinary.fetchImpl);
  await expect(ordinaryTransport.request("/v1/operator/fleet-settings")).rejects.toThrow(
    "operator_device_required",
  );
  expect((await ordinary.serviceSettings.load()).autonomy.fleet).toEqual(FLEET_AUTONOMY_DEFAULTS);
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
  for (const path of [
    "/v1/hosted/operator",
    "/v1/gateway/encrypted",
    "/v1/hooks/linear",
    "/v1/restart",
    "/v1/reset",
    "/v1/deprovision",
    "/v1/pairing/offer",
  ])
    await expect(transport.request(path, {})).rejects.toThrow("invalid_operator_route");
});

it("denies reset even through a valid encrypted operator request", async () => {
  const f = await fixture(),
    session = await f.pair();
  const transport = createHostedTransport(session, f.store, f.fetchImpl);
  await expect(
    transport.request("/operator/v1/dispatch", {
      op: "reset",
      schemaVersion: 1,
      conversationId: "global-default",
      expectedRevision: 0,
    }),
  ).rejects.toThrow("invalid_operator_route");
});

it("wakes an asleep host with a device-signed challenge and exposes status transitions", async () => {
  const f = await fixture(),
    session = await f.pair();
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  session.wakePrivateKey = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let sleeping = true;
  const challenge = `${f.f.now}.${"n".repeat(22)}.${"s".repeat(43)}`;
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input, init),
      path = new URL(req.url).pathname;
    if (path.endsWith("/wake/challenge")) {
      expect(req.headers.has("authorization")).toBe(false);
      return Response.json({ challenge, expiresAtMs: f.f.now + 60_000 });
    }
    if (path.endsWith("/wake")) {
      const request = (await req.json()) as { deviceId: string; signature: string };
      expect(request.deviceId).toBe(session.deviceId);
      expect(
        verify(
          "sha256",
          Buffer.from(`clankie-wake-v1\n${session.encryption.hostId}\n${session.deviceId}\n${challenge}`),
          { key: key.publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(request.signature, "base64url"),
        ),
      ).toBe(true);
      sleeping = false;
      return Response.json({ state: "waking", retryAfterMs: 1 }, { status: 202 });
    }
    if (sleeping) return Response.json({ error: "host_unavailable" }, { status: 503 });
    return f.fetchImpl(input, init);
  };
  const transport = createHostedTransport(session, f.store, fetchImpl),
    states: string[] = [];
  transport.subscribe(() => states.push(transport.status()));
  expect(await transport.request("/health")).toMatchObject({ ok: true });
  expect(states).toEqual(["Asleep", "Waking", "Connected"]);
});
