import {
  createECDH,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "@clankie/credential-broker";
import { DiscordIngressEventSchema, DiscordIngressResultSchema } from "@clankie/protocol/discord-ingress";
import { prepareDiscordIngress } from "@clankie/protocol/discord-ingress-crypto";
import { derivePublicGatewayHostId } from "@clankie/protocol/public-gateway";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createStubCaptain, type CaptainPort } from "../src/captain/port.ts";
import { createClankieApp } from "../src/app.ts";
import {
  createDiscordIngressRoutes,
  createHostedDiscordIngress,
  createHostedDiscordVoiceCallback,
} from "../src/discord-ingress.ts";
import { HostedBodyClient } from "../src/hosted-body.ts";

it("binds encrypted hosted room handoffs to signed owner and live source proof, with durable retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosted-room-handoff-"));
  const fleet = generateKeyPairSync("ed25519");
  const kid = createHash("sha256")
    .update(fleet.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64url")
    .slice(0, 16);
  const tenantId = `tn_${"a".repeat(20)}`;
  const accountId = "hosted-room-owner";
  const installationId = "i".repeat(22);
  const hostId = derivePublicGatewayHostId(accountId, installationId);
  const now = Date.now();
  const issuedAt = Math.floor(now / 1000);
  const token = (typ: string, claims: Record<string, unknown>) => {
    const data = [
      { alg: "EdDSA", typ, kid },
      { iss: "clankie-fleet", tid: tenantId, iat: issuedAt, ...claims },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    return `${data}.${sign(null, Buffer.from(data), fleet.privateKey).toString("base64url")}`;
  };
  const hostCredential = token("clankie-host", {
    aud: "clankie-gateway",
    hid: hostId,
    sub: accountId,
    inst: installationId,
    exp: issuedAt + 21_600,
  });
  let bodySigningKey: KeyObject | undefined;
  const registeredDiscordKeys: string[] = [];
  const app = new Hono();
  app.post("/fleet/v1/body/pairing-key", async (c) => {
    expect(c.req.header("authorization")).toBe(`Bearer ${hostCredential}`);
    const body = await c.req.json();
    expect(body).toMatchObject({ installationId, registrationToken: "fixture-registration" });
    bodySigningKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: body.publicKey },
      format: "jwk",
    });
    return c.json({});
  });
  app.post("/fleet/v1/body/discord-key", async (c) => {
    expect(c.req.header("authorization")).toBe(`Bearer ${hostCredential}`);
    const bytes = await c.req.text();
    const digest = createHash("sha256").update(bytes).digest("base64url");
    expect(c.req.header("x-clankie-body-digest")).toBe(digest);
    const transcript = [
      "clankie-body-request-v1",
      "POST",
      c.req.path,
      tenantId,
      installationId,
      c.req.header("x-clankie-body-timestamp"),
      c.req.header("x-clankie-body-nonce"),
      digest,
    ].join("\n");
    expect(bodySigningKey).toBeDefined();
    expect(
      verify(
        null,
        Buffer.from(transcript),
        bodySigningKey!,
        Buffer.from(c.req.header("x-clankie-body-signature")!, "base64url"),
      ),
    ).toBe(true);
    const body = JSON.parse(bytes);
    expect(body.installationId).toBe(installationId);
    registeredDiscordKeys.push(body.publicKey);
    return c.json({});
  });
  let ingressRoutes: Hono | undefined;
  const server = serve({
    fetch: (request) =>
      new URL(request.url).pathname === "/v1/discord/ingress"
        ? (ingressRoutes?.fetch(request) ?? new Response(null, { status: 503 }))
        : app.fetch(request),
    hostname: "127.0.0.1",
    port: 0,
  }) as Server;
  let hosted: Awaited<ReturnType<typeof createHostedDiscordIngress>> | undefined;
  let restarted: Awaited<ReturnType<typeof createHostedDiscordIngress>> | undefined;
  let voiceApp: Awaited<ReturnType<typeof createClankieApp>> | undefined;
  let prepared: ReturnType<typeof prepareDiscordIngress> | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture HTTP address");
    const localOrigin = `http://127.0.0.1:${address.port}`;
    const client = new HostedBodyClient(
      {
        hostCredential,
        credentialExpiresAtMs: (issuedAt + 21_600) * 1000,
        gatewayOrigin: "https://room-handoff.example.test",
        tenantId,
        accountId,
        installationId,
        fleetVerifyKeysJson: JSON.stringify({
          keys: [{ publicKeyPem: fleet.publicKey.export({ type: "spki", format: "pem" }) }],
        }),
        pairingKeyRegistrationToken: "fixture-registration",
      },
      {
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          expect(url.origin).toBe("https://room-handoff.example.test");
          return fetch(new URL(url.pathname, localOrigin), init);
        },
      },
    );
    await client.registerPairingKey(generateKeyPairSync("ed25519").privateKey);
    const credentialsPath = join(directory, "credentials.json");
    const statePath = join(directory, "discord-inbox.json");
    const submit = vi.fn<CaptainPort["submitDiscordTurn"]>(async () => {
      await held;
      return {
        state: "waiting_user",
        captainSessionId: "hosted-room-child",
        turnId: "hosted-room-turn",
        approvalRequired: true,
        prompt: "PRIVATE_APPROVAL_PROMPT: approve machine access here",
      };
    });
    const selfTool = vi.fn<CaptainPort["voiceSelfTool"]>(async () => ({
      content: [{ type: "text", text: JSON.stringify({ written: true }) }],
    }));
    const captain = createStubCaptain({ submitDiscordTurn: submit, voiceSelfTool: selfTool });
    voiceApp = await createClankieApp({
      captain,
      authenticateCaptain: async (request) =>
        request.headers.get("authorization") === "Bearer fixture-local-voice"
          ? { captainId: "fixture", steerSourceLane: "discord_voice" as const }
          : undefined,
    });
    const voiceCallback = createHostedDiscordVoiceCallback(
      (request) => voiceApp!.app.fetch(request),
      "fixture-local-voice",
    );
    hosted = await createHostedDiscordIngress({
      client,
      store: new FileCredentialStore(credentialsPath),
      statePath,
      captain,
      voice: voiceCallback,
    });
    ingressRoutes = createDiscordIngressRoutes(hosted.ingress);
    await vi.waitFor(() => expect(registeredDiscordKeys).toHaveLength(1));
    const credential = await new FileCredentialStore(credentialsPath).get(
      `clankie-discord-ingress-${hostId}`,
    );
    if (credential?.type !== "api") throw new Error("Discord key was not persisted");
    const persisted = createECDH("prime256v1");
    persisted.setPrivateKey(Buffer.from(credential.key, "hex"));
    expect(persisted.getPublicKey().toString("base64url")).toBe(registeredDiscordKeys[0]);
    const event = DiscordIngressEventSchema.parse({
      schemaVersion: 1,
      tenantId,
      installationId,
      deliveryId: "discord:hosted-room-1",
      eventAtMs: now,
      expiresAtMs: now + 300_000,
      channelId: "2",
      messageId: "3",
      actorId: "4",
      owner: true,
      kind: "dm",
      content: "Please investigate this room request.",
      context: [
        {
          messageId: "1",
          actorId: "5",
          content: "Earlier conversation, kept as context rather than a new trigger.",
          atMs: now - 1_000,
        },
      ],
    });
    prepared = prepareDiscordIngress(event, registeredDiscordKeys[0]!);
    const request = prepared.seal(
      token("clankie-discord", {
        typ: "clankie-discord",
        aud: "clankie-body",
        inst: installationId,
        dig: prepared.digest,
        jti: "j".repeat(22),
        exp: issuedAt + 60,
      }),
    );
    const post = (body: unknown) =>
      fetch(`${localOrigin}/v1/discord/ingress`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post(event)).status).toBe(401);
    expect(submit).not.toHaveBeenCalled();
    const first = await post(request.envelope);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(request.openResponse((await first.json()).sealed)).toEqual({ state: "pending" });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const [turn, authority] = submit.mock.calls[0]!;
    expect(turn.deliveryId).toBe(event.deliveryId);
    expect(turn.trigger).toMatchObject({
      actorId: event.actorId,
      channelId: event.channelId,
      body: event.content,
    });
    expect(authority?.verifiedOwner).toBe(event.owner);
    expect(turn.contextMessages).toEqual([
      {
        id: "1",
        authorId: "5",
        body: event.context![0]!.content,
        createdAt: new Date(now - 1_000).toISOString(),
      },
    ]);
    expect(typeof authority?.sourceCurrent).toBe("function");
    expect(authority?.sourceCurrent?.()).toBe(true);
    release();
    const expected = {
      state: "reply",
      text: "I need you to continue that request on the authenticated operator surface.",
    };
    await vi.waitFor(async () => {
      const response = await post(request.envelope);
      const wire = await response.text();
      expect(wire).not.toContain("PRIVATE_APPROVAL_PROMPT");
      expect(wire).not.toContain(expected.text);
      expect(request.openResponse(JSON.parse(wire).sealed)).toEqual(expected);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await readFile(statePath, "utf8")).not.toContain("PRIVATE_APPROVAL_PROMPT");
    hosted.close();
    expect(authority?.sourceCurrent?.()).toBe(false);
    restarted = await createHostedDiscordIngress({
      client,
      store: new FileCredentialStore(credentialsPath),
      statePath,
      captain,
      voice: voiceCallback,
    });
    ingressRoutes = createDiscordIngressRoutes(restarted.ingress);
    await vi.waitFor(() => expect(registeredDiscordKeys).toHaveLength(2));
    expect(registeredDiscordKeys[1]).toBe(registeredDiscordKeys[0]);
    const cached = await (await post(request.envelope)).json();
    expect(request.openResponse(cached.sealed)).toEqual(expected);
    expect(submit).toHaveBeenCalledTimes(1);

    // Voice uses the same sealed admission, source proof and durable retry path.
    const voiceEvent = DiscordIngressEventSchema.parse({
      ...event,
      deliveryId: "discord:hosted-voice-1",
      guildId: "1",
      kind: "voice",
      context: undefined,
      owner: false,
      voice: {
        action: "handoff",
        request: {
          schemaVersion: 1,
          deliveryId: "untrusted-nested-delivery",
          identity: {
            presenceSessionId: "untrusted-nested-session",
            correlationId: "untrusted-nested-correlation",
            profileHash: "untrusted-nested-profile",
            characterId: "clankie",
            credentialRef: "hosted_discord",
            transportKind: "bot",
          },
          trigger: {
            kind: "voice_event",
            id: "voice:1",
            guildId: "1",
            channelId: "2",
            actorId: "4",
            body: "Please investigate this room request.",
          },
          contextMessages: [],
        },
      },
    });
    const voicePrepared = prepareDiscordIngress(voiceEvent, registeredDiscordKeys[1]!);
    const voiceRequest = voicePrepared.seal(
      token("clankie-discord", {
        typ: "clankie-discord",
        aud: "clankie-body",
        inst: installationId,
        dig: voicePrepared.digest,
        jti: "v".repeat(22),
        exp: issuedAt + 60,
      }),
    );
    try {
      expect((await post(voiceEvent)).status).toBe(401);
      await post(voiceRequest.envelope);
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
      const [voiceTurn, voiceAuthority] = submit.mock.calls[1]!;
      expect(voiceTurn).toMatchObject({
        deliveryId: voiceEvent.deliveryId,
        identity: {
          presenceSessionId: "discord:2",
          correlationId: voiceEvent.deliveryId,
          profileHash: "hosted-discord-v1",
          credentialRef: "hosted_discord",
        },
        trigger: { kind: "voice_event", guildId: "1", channelId: "2", actorId: "4" },
      });
      expect(voiceAuthority?.verifiedOwner).toBe(false);
      expect(voiceAuthority?.sourceCurrent?.()).toBe(true);
      await vi.waitFor(async () => {
        const response = await post(voiceRequest.envelope);
        const wire = await response.text();
        expect(wire).not.toContain("PRIVATE_APPROVAL_PROMPT");
        expect(voiceRequest.openResponse(JSON.parse(wire).sealed)).toMatchObject({
          state: "voice",
          result: { state: "waiting_user", approvalRequired: true, prompt: expected.text },
        });
      });
      expect(await readFile(statePath, "utf8")).not.toContain("PRIVATE_APPROVAL_PROMPT");
      restarted.close();
      expect(voiceAuthority?.sourceCurrent?.()).toBe(false);
      restarted = await createHostedDiscordIngress({
        client,
        store: new FileCredentialStore(credentialsPath),
        statePath,
        captain,
        voice: voiceCallback,
      });
      ingressRoutes = createDiscordIngressRoutes(restarted.ingress);
      expect(
        voiceRequest.openResponse((await (await post(voiceRequest.envelope)).json()).sealed),
      ).toMatchObject({ state: "voice" });
      expect(submit).toHaveBeenCalledTimes(2);
      expect(
        DiscordIngressEventSchema.safeParse({
          ...voiceEvent,
          voice: {
            ...voiceEvent.voice,
            request: { ...voiceTurn, trigger: { ...voiceTurn.trigger, actorId: "9" } },
          },
        }).success,
      ).toBe(false);
      const foreign = prepareDiscordIngress(
        { ...voiceEvent, tenantId: `tn_${"b".repeat(20)}`, deliveryId: "discord:foreign-voice" },
        registeredDiscordKeys[1]!,
      );
      try {
        const foreignRequest = foreign.seal(
          token("clankie-discord", {
            typ: "clankie-discord",
            aud: "clankie-body",
            tid: `tn_${"b".repeat(20)}`,
            inst: installationId,
            dig: foreign.digest,
            jti: "f".repeat(22),
            exp: issuedAt + 60,
          }),
        );
        expect((await post(foreignRequest.envelope)).status).toBe(401);
        expect(submit).toHaveBeenCalledTimes(2);
      } finally {
        foreign.destroy();
      }
      for (const operation of [
        { action: "briefing" as const, consentedUserIds: ["34567"] },
        {
          action: "self_tool" as const,
          tool: "remember_episode" as const,
          arguments: { text: "A fixture voice memory.", visibility: "private" },
        },
      ]) {
        const callbackEvent = DiscordIngressEventSchema.parse({
          ...event,
          guildId: "12345",
          channelId: "23456",
          actorId: "34567",
          kind: "voice",
          context: undefined,
          deliveryId: `discord:voice-${operation.action}`,
          voice: operation,
        });
        const callbackPrepared = prepareDiscordIngress(callbackEvent, registeredDiscordKeys[1]!);
        try {
          const callbackRequest = callbackPrepared.seal(
            token("clankie-discord", {
              typ: "clankie-discord",
              aud: "clankie-body",
              inst: installationId,
              dig: callbackPrepared.digest,
              jti: "c".repeat(22),
              exp: issuedAt + 60,
            }),
          );
          await post(callbackRequest.envelope);
          await vi.waitFor(async () => {
            const wire = await (await post(callbackRequest.envelope)).json();
            const result = DiscordIngressResultSchema.parse(callbackRequest.openResponse(wire.sealed));
            expect(result.state).toBe("voice");
            if (result.state !== "voice") throw new Error("Voice callback did not settle");
            expect(result.result).not.toHaveProperty("schemaVersion");
            if (operation.action === "briefing")
              expect(result.result).toMatchObject({
                instructions: expect.any(String),
                briefing: expect.any(String),
              });
            else
              expect(result.result).toEqual({
                text: JSON.stringify({ remembered: true }, null, 2),
                isError: false,
              });
            expect(JSON.stringify(wire)).not.toContain("fixture-local-voice");
          });
          await post(callbackRequest.envelope);
        } finally {
          callbackPrepared.destroy();
        }
      }
      expect(selfTool).toHaveBeenCalledTimes(1);
      expect(selfTool.mock.calls[0]?.[0]).toMatchObject({
        guildId: "12345",
        channelId: "23456",
        speakerId: "34567",
        name: "remember_episode",
      });
      expect(selfTool.mock.calls[0]?.[0].arguments).not.toHaveProperty("visibility");
    } finally {
      voicePrepared.destroy();
    }
  } finally {
    release();
    prepared?.destroy();
    hosted?.close();
    restarted?.close();
    voiceApp?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
