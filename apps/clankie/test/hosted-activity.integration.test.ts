import { serve } from "@hono/node-server";
import { createServer } from "node:http";
import {
  createHash,
  generateKeyPairSync,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { activityViewerDigest } from "@clankie/protocol/activity-sharing-crypto";
import { derivePublicGatewayHostId } from "@clankie/protocol/public-gateway";
import { ActivitySharing } from "../src/activity-sharing.ts";
import { createActivityArtifactSources } from "../src/activity-artifact-source.ts";
import { startHostedActivityRuntime } from "../src/activity-runtime.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { activityTools } from "../src/captain/activity-tools.ts";
import { DeliveredFileStore } from "../src/delivered-files.ts";
import { HostedBodyClient } from "../src/hosted-body.ts";
import type { RuntimeProvider } from "../src/runtime-provider.ts";
import type { ActivitySession } from "@clankie/protocol/activity-sharing";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(options: { local?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "hosted-activity-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const key = generateKeyPairSync("ed25519");
  const kid = createHash("sha256")
    .update(key.publicKey.export({ format: "der", type: "spki" }))
    .digest("base64url")
    .slice(0, 16);
  let now = Date.now(),
    allowed = true,
    session: ActivitySession | undefined;
  const accountId = "owner-account",
    tenantId = `tn_${"a".repeat(20)}`,
    installationId = "i".repeat(22);
  const hostId = derivePublicGatewayHostId(accountId, installationId),
    authorization = randomBytes(32).toString("base64url");
  const jwt = (typ: string, claims: object) => {
    const value = [{ alg: "EdDSA", typ, kid }, claims]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    return `${value}.${sign(null, Buffer.from(value), key.privateKey).toString("base64url")}`;
  };
  const iat = Math.floor(now / 1000),
    exp = iat + 21_600;
  const credential = jwt("clankie-host", {
    iss: "clankie-fleet",
    aud: "clankie-gateway",
    sub: accountId,
    tid: tenantId,
    inst: installationId,
    hid: hostId,
    iat,
    exp,
  });
  const bodyKey = generateKeyPairSync("ed25519");
  const seen: string[] = [];
  const nonces = new Set<string>();
  const fleet = createServer(async (request, response) => {
    try {
      const path = request.url!,
        chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks),
        command = JSON.parse(bytes.toString());
      if (path !== "/fleet/v1/body/pairing-key") {
        const timestamp = request.headers["x-clankie-body-timestamp"] as string;
        const nonce = request.headers["x-clankie-body-nonce"] as string;
        const digest = createHash("sha256").update(bytes).digest("base64url");
        const transcript = [
          "clankie-body-request-v1",
          "POST",
          path,
          tenantId,
          installationId,
          timestamp,
          nonce,
          digest,
        ].join("\n");
        if (
          request.headers.authorization !== `Bearer ${credential}` ||
          request.headers["x-clankie-body-digest"] !== digest ||
          nonces.has(nonce) ||
          !verify(
            null,
            Buffer.from(transcript),
            bodyKey.publicKey,
            Buffer.from(request.headers["x-clankie-body-signature"] as string, "base64url"),
          )
        )
          throw new Error("bad signature");
        nonces.add(nonce);
      }
      let value: unknown = {};
      if (path === "/fleet/v1/body/pairing-key")
        expect(command.publicKey).toBe(createPublicKey(bodyKey.privateKey).export({ format: "jwk" }).x);
      else if (path === "/fleet/v1/body/heartbeat") value = { desired: "running" };
      else {
        seen.push(command.action);
        if (
          !allowed ||
          command.installationId !== installationId ||
          (command.scope && command.scope.guildId !== "123")
        ) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "activity_denied" }));
          return;
        }
        if (command.action === "authorize") value = { authorized: true };
        else if (command.action === "launch" || command.action === "stop") {
          session = command.session;
          value = {
            receiptId: command.requestId,
            outcome: "confirmed",
            session,
            ...(command.action === "launch" ? { inviteUrl: "https://discord.gg/localFixture" } : {}),
          };
        } else if (command.action === "revalidate" && command.authorization === authorization && session)
          value = { session, authorization, expiresAt: new Date(now + 15_000).toISOString() };
        else throw new Error("invalid fixture request");
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
  await new Promise<void>((done) => fleet.listen(0, "127.0.0.1", done));
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        fleet.closeAllConnections();
        fleet.close(() => done());
      }),
  );
  const address = fleet.address();
  if (!address || typeof address === "string") throw new Error("missing fleet");
  const body = new HostedBodyClient(
    {
      hostCredential: credential,
      credentialExpiresAtMs: exp * 1000,
      gatewayOrigin: `http://127.0.0.1:${address.port}`,
      accountId,
      tenantId,
      installationId,
      fleetVerifyKeysJson: JSON.stringify({
        keys: [{ publicKeyPem: key.publicKey.export({ format: "pem", type: "spki" }) }],
      }),
    },
    { clock: () => now },
  );
  await body.registerPairingKey(bodyKey.privateKey);
  const runtime = await startHostedActivityRuntime();
  cleanup.push(() => runtime.close());
  const files = new DeliveredFileStore(join(root, "files"));
  const conversationId = options.local ? randomUUID() : "owner-conversation";
  await writeFile(join(root, "picture.png"), PNG);
  const artifact = await files.publish({
    conversationId,
    sourceRoot: root,
    path: "picture.png",
  });
  const busyEdges: boolean[] = [];
  const heartbeat: Pick<NonNullable<RuntimeProvider["heartbeat"]>, "activitySharing"> = {
    activitySharing: (active) => busyEdges.push(active),
  };
  const privateWrites: string[] = [];
  const sharing = new ActivitySharing({
    files,
    url: runtime.url,
    token: async () => runtime.token,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST") privateWrites.push(new URL(request.url).pathname);
      return fetch(request);
    },
    sources: createActivityArtifactSources({ files }),
    ...(options.local
      ? {}
      : {
          tenantId,
          installationId,
          authorizeDestination: (scope) => body.authorizeActivityDestination(scope),
          launch: (session, requestId) => body.launchActivity(session, requestId),
          stop: (session, requestId) => body.stopActivity(session, requestId),
        }),
    onBusyChange: (active) => heartbeat.activitySharing(active),
  });
  const app = await createClankieApp({
    captain: createStubCaptain(),
    activitySharing: sharing,
    ...(options.local ? {} : { hostedActivity: body }),
    clock: () => new Date(now),
    eventLogPath: join(root, "events.jsonl"),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const server = serve({ fetch: (request) => app.app.fetch(request), hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((done) => server.once("listening", done));
  cleanup.push(async () => {
    app.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const http = server.address();
  if (!http || typeof http === "string") throw new Error("missing body");
  const origin = `http://127.0.0.1:${http.port}`;
  const owner = async (command: unknown) =>
    fetch(`${origin}/v1/activity/shares`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify(command),
    });
  const permit = (
    share: ActivitySession,
    dig = activityViewerDigest(share, authorization),
    extra: object = {},
  ) =>
    jwt("clankie-discord", {
      typ: "clankie-discord",
      aud: "clankie-body",
      iss: "clankie-fleet",
      tid: tenantId,
      inst: installationId,
      dig,
      jti: randomBytes(16).toString("base64url"),
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 60,
      ...extra,
    });
  const viewer = (share: ActivitySession, token = permit(share), signal?: AbortSignal) =>
    fetch(`${origin}/v1/activity/viewer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: share, authorization, permit: token }),
      ...(signal ? { signal } : {}),
    });
  return {
    root,
    body,
    sharing,
    busyEdges,
    artifact,
    conversationId,
    origin,
    owner,
    viewer,
    permit,
    seen,
    privateWrites,
    privateStatus: async () => {
      const response = await fetch(`${runtime.url}/shares`, {
        headers: { authorization: `Bearer ${runtime.token}` },
      });
      expect(response.status).toBe(200);
      return (await response.json()).sessions as ActivitySession[];
    },
    delegatedViewer: (share: ActivitySession, grant: string) =>
      fetch(`${runtime.url}/shares/${share.shareId}/viewer`, {
        method: "POST",
        headers: { authorization: `Bearer ${runtime.token}`, "content-type": "application/json" },
        body: JSON.stringify({ generation: share.generation, grant }),
      }),
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    advance: () => {
      now += 16_000;
    },
    start: async () => {
      const response = await owner({
        action: "image",
        conversationId,
        artifactId: artifact.artifactId,
        guildId: "123",
        channelId: "456",
      });
      expect(response.status).toBe(200);
      return (await response.json()).session as ActivitySession;
    },
  };
}

it("uses signed body HTTP, fleet media permits and an embedded private producer; refuses cross scope and wrong purpose", async () => {
  const f = await fixture(),
    session = await f.start();
  expect(f.busyEdges).toEqual([true]);
  expect(f.seen).toContain("launch");
  expect(
    (
      await fetch(`${f.origin}/v1/activity/shares`, {
        method: "POST",
        headers: { authorization: "Bearer captain" },
        body: JSON.stringify({ action: "list" }),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.owner({
        action: "image",
        conversationId: "owner-conversation",
        artifactId: f.artifact.artifactId,
        guildId: "999",
        channelId: "456",
      })
    ).status,
  ).toBe(403);
  await expect(f.body.resolveHostToken()).resolves.toHaveProperty("token");
  expect(
    (await f.viewer({ ...session, scope: { ...session.scope, tenantId: `tn_${"b".repeat(20)}` } })).status,
  ).toBe(403);
  expect((await f.viewer(session, f.permit(session, "x".repeat(43)))).status).toBe(403);
  expect(
    (await f.viewer(session, f.permit(session, undefined, { exp: Math.floor(Date.now() / 1000) + 61 })))
      .status,
  ).toBe(403);
  const controller = new AbortController();
  const response = await f.viewer(session, undefined, controller.signal);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let media = "";
  while (!media.includes('"kind":"frame"')) {
    const next = await reader.read();
    if (next.done) throw new Error("media ended before frame");
    media += Buffer.from(next.value!).toString();
  }
  expect(media).toContain(PNG.toString("base64"));
  controller.abort();
  await reader.cancel().catch(() => undefined);
  await f.owner({ action: "stop", shareId: session.shareId, generation: session.generation });
  expect(f.busyEdges).toEqual([true, false]);
}, 15_000);

it("revokes a quiet admitted HTTP media stream without rejecting the body account", async () => {
  const f = await fixture(),
    session = await f.start();
  const controller = new AbortController();
  const response = await f.viewer(session, undefined, controller.signal);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  await reader.read();
  f.setAllowed(false);
  f.advance();
  let ended = false;
  const drain = (async () => {
    while (!(await reader.read()).done) {
      /* drain retained metadata */
    }
    ended = true;
  })();
  await vi.waitFor(() => expect(ended).toBe(true), { timeout: 5000 });
  await drain;
  controller.abort();
  await expect(f.body.resolveHostToken()).resolves.toHaveProperty("token");
  f.sharing.close();
  expect(f.busyEdges).toEqual([true, false]);
}, 15_000);

it("captain sharing pins artifact ownership and rejects a foreign server or stale conversation", async () => {
  const f = await fixture();
  let current = true;
  const turn = {
    conversationAuthority: {
      owner: {
        conversationId: "owner-conversation",
        discord: {
          baseSessionKey: "discord:123",
          targetId: "456",
          actorId: "789",
          guildId: "123",
          channelId: "456",
          messageId: "987",
          transportKind: "bot" as const,
        },
      },
      current: () => current,
      authorize: async () => current,
    },
  };
  const tool = activityTools(f.sharing, turn)[0]!;
  const invoke = (input: Record<string, unknown>) =>
    tool.execute("call", input as never, undefined, undefined, undefined as never);
  expect(
    (
      await invoke({
        action: "start",
        sourceId: `artifact:foreign:${f.artifact.artifactId}`,
        guildId: "123",
        channelId: "456",
      })
    ).details,
  ).toMatchObject({ outcome: "refused", reason: "activity_artifact_unavailable" });
  expect(
    (await invoke({ action: "image", artifactId: f.artifact.artifactId, guildId: "999", channelId: "456" }))
      .details,
  ).toMatchObject({ outcome: "refused", reason: "activity_destination_refused" });
  const result = await invoke({
    action: "image",
    artifactId: f.artifact.artifactId,
    guildId: "123",
    channelId: "456",
  });
  expect(result.details).toHaveProperty("session");
  expect(result.details).toMatchObject({ receipt: { outcome: "confirmed" } });
  expect(f.seen).toContain("launch");
  current = false;
  expect((await invoke({ action: "list" })).details).toMatchObject({ outcome: "refused" });
}, 15_000);

it("official bot turns without a launch adapter refuse media mutations before private effects while local owner delegation still works", async () => {
  const f = await fixture({ local: true });
  const owner = { conversationId: f.conversationId };
  const authority = {
    current: () => true,
    authorize: async () => true,
  };
  const bot = activityTools(f.sharing, {
    conversationAuthority: {
      ...authority,
      owner: {
        ...owner,
        discord: {
          baseSessionKey: "discord:123",
          targetId: "456",
          actorId: "789",
          guildId: "123",
          channelId: "456",
          messageId: "987",
          transportKind: "bot" as const,
        },
      },
    },
  })[0]!;
  const invokeBot = (input: Record<string, unknown>) =>
    bot.execute("call", input as never, undefined, undefined, undefined as never);
  const sourceId = `artifact:${f.conversationId}:${f.artifact.artifactId}`;
  expect((await invokeBot({ action: "start", sourceId, guildId: "123", channelId: "456" })).details).toEqual({
    outcome: "refused",
    reason: "activity_official_bot_required",
  });
  expect(await f.privateStatus()).toEqual([]);
  expect(f.privateWrites).toEqual([]);
  expect(
    (
      await invokeBot({
        action: "image",
        artifactId: f.artifact.artifactId,
        guildId: "123",
        channelId: "456",
      })
    ).details,
  ).toEqual({ outcome: "refused", reason: "activity_official_bot_required" });
  expect(await f.privateStatus()).toEqual([]);
  expect(f.privateWrites).toEqual([]);

  const seeded = await f.start();
  expect(seeded.scope.tenantId).toBe("local");
  const before = await f.privateStatus();
  const writesBeforeSwitch = [...f.privateWrites];
  expect(before).toEqual([seeded]);
  expect(
    (await invokeBot({ action: "switch", shareId: seeded.shareId, generation: 1, sourceId })).details,
  ).toEqual({ outcome: "refused", reason: "activity_official_bot_required" });
  expect(await f.privateStatus()).toEqual(before);
  expect(f.privateWrites).toEqual(writesBeforeSwitch);
  const delegated = await f.owner({ action: "grant", shareId: seeded.shareId, generation: 1 });
  expect(delegated.status).toBe(200);
  const grant = (await delegated.json()).grant as string;
  const response = await f.delegatedViewer(seeded, grant);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let media = "";
  while (!media.includes('"kind":"frame"')) {
    const next = await reader.read();
    if (next.done) throw new Error("delegated media ended before frame");
    media += Buffer.from(next.value!).toString();
  }
  expect(media).toContain(PNG.toString("base64"));
  await reader.cancel();
  expect((await f.owner({ action: "stop", shareId: seeded.shareId, generation: 1 })).status).toBe(200);
  const local = activityTools(f.sharing, { conversationAuthority: { ...authority, owner } })[0]!;
  const created = await local.execute(
    "call",
    { action: "start", sourceId, guildId: "123", channelId: "456" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  expect(created.details).toHaveProperty("session");
  expect((await f.privateStatus())[0]?.source.id).toBe(sourceId);
  expect(f.seen).toEqual([]);
}, 15_000);
