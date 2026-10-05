import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { expect } from "vitest";
import { createBodyTelemetry } from "@clankie/observability/body-telemetry";
import { SUPERVISE_GRANTS, type DeviceGrantSet } from "@clankie/protocol";
import { derivePublicGatewayHostId } from "@clankie/protocol/public-gateway";
import { type GatewayEncryptionCredential } from "@clankie/protocol/gateway-encryption";
import {
  COMPOSER_TRANSCRIPTION_CHUNK_BYTES_MAX,
  ComposerTranscriptionReceiptSchema,
  ComposerTranscriptionStatusSchema,
  parseComposerWav,
} from "@clankie/protocol/composer-transcription";
import { createComposerTranscriptionApi } from "../../../../packages/api-client/src/composer-transcription.ts";
import { createGatewayEncryptedFetch } from "../../../../packages/api-client/src/gateway-encryption.ts";
import {
  ComposerTranscriptions,
  ComposerTranscriptionAdmissionRefusalSchema,
  type ComposerTranscriptionCloud,
  type ComposerTranscriptionPrincipal,
} from "../../src/composer-transcription.ts";
import { createClankieApp, type ClankieApp } from "../../src/app.ts";
import { createStubCaptain } from "../../src/captain/port.ts";
import { GatewayEncryptionHost, sealGatewayValue, openGatewayValue } from "../../src/gateway-encryption.ts";
import { HostedDeviceSecurity } from "../../src/hosted-device-security.ts";
import { HostedBodyClient } from "../../src/hosted-body.ts";
import { hostedFixture } from "./hosted-body.ts";
import {
  HostedDevicePurposeRequestSchema,
  type HostedSupportDeviceState,
} from "@clankie/protocol/hosted-device-security";

const closes: Array<() => Promise<void>> = [];
export async function closeComposerFixtures() {
  for (const close of closes.splice(0).reverse()) await close();
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
export function composerWavFixture(seconds = 1, extra = true) {
  const dataBytes = seconds * 32_000,
    metadata = Buffer.from("PRIVATE_AUDIO_MARKER");
  const extraBytes = extra ? 8 + metadata.length + (metadata.length % 2) : 0;
  const audio = Buffer.alloc(44 + extraBytes + dataBytes);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16_000, 24);
  audio.writeUInt32LE(32_000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  if (extra) {
    audio.write("LIST", 36);
    audio.writeUInt32LE(metadata.length, 40);
    metadata.copy(audio, 44);
  }
  audio.write("data", 36 + extraBytes);
  audio.writeUInt32LE(dataBytes, 40 + extraBytes);
  return audio;
}
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  closes.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return `http://127.0.0.1:${address.port}`;
}
export async function composerHttpFixture(managed = true) {
  const root = mkdtempSync(join(tmpdir(), "composer-http-"));
  closes.push(async () => rmSync(root, { recursive: true, force: true }));
  let now = Date.now(),
    spent = 0,
    loseResponse = false,
    providerGate: ReturnType<typeof gate> | undefined;
  let cloudState: "available" | "allowance_exhausted" | "unavailable" = "available";
  const hosted = hostedFixture();
  let gen = 0,
    authKey: { kid: string; gen: number } | null = null;
  const supportDevices: HostedSupportDeviceState[] = [];
  const revoked: { dev: string; at: number; gen: number }[] = [];
  let hideSupportAcknowledgement = false;
  let supportPublicationGate:
    | { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> }
    | undefined;
  let supportStateGate: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  const reached = gate(),
    attestations: ComposerTranscriptionPrincipal[] = [];
  const cloudUrl = await listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "application/json");
      if (req.url === "/pairing-key") {
        res.end("{}");
        return;
      }
      if (req.url === "/auth-key") {
        authKey = { kid: body.keyId, gen: ++gen };
        res.end(JSON.stringify({ generation: gen }));
        return;
      }
      if (req.url === "/revoke") {
        if (!revoked.some((entry) => entry.dev === body.deviceId))
          revoked.push({ dev: body.deviceId, at: now, gen: ++gen });
        res.end(JSON.stringify({ generation: gen }));
        return;
      }
      if (req.url === "/device-purpose") {
        const purpose = HostedDevicePurposeRequestSchema.parse(body);
        expect(req.headers["x-clankie-body-signature"]).toBeTypeOf("string");
        supportDevices.push({
          inst: purpose.installationId,
          dev: purpose.deviceId,
          grant: purpose.supportGrantId,
          at: now,
          gen: ++gen,
        });
        supportPublicationGate?.entered.release();
        await supportPublicationGate?.release.promise;
        res.end("{}");
        return;
      }
      if (req.url === "/security-state") {
        supportStateGate?.entered.release();
        await supportStateGate?.release.promise;
        res.end(
          JSON.stringify({
            state: hosted.security(String(req.headers["x-clankie-body-nonce"]), {
              gen,
              rev: revoked,
              ak: authKey,
              sp: hideSupportAcknowledgement ? [] : supportDevices,
            }),
          }),
        );
        return;
      }
      attestations.push(body);
      if (req.url === "/status")
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            mode: "managed",
            state: cloudState,
            maxDurationMs: 180_000,
            maxAudioBytes: 5_825_580,
            maxChunkBytes: 256 * 1024,
            allowance: {
              limitMs: 600_000,
              remainingMs: 600_000,
              resetsAt: new Date(now + 86400_000).toISOString(),
            },
          }),
        );
      else if (req.url === "/receipt")
        res.end(JSON.stringify({ schemaVersion: 1, requestId: body.requestId, state: "uncertain" }));
      else {
        if (cloudState !== "available") {
          res.statusCode = cloudState === "allowance_exhausted" ? 429 : 503;
          res.end(JSON.stringify({ error: cloudState }));
          return;
        }
        const parsed = parseComposerWav(Buffer.from(body.audioBase64, "base64"));
        expect(parsed.durationMs).toBeGreaterThan(0);
        spent++;
        reached.release();
        if (providerGate) await providerGate.promise;
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            requestId: body.requestId,
            state: "complete",
            text: "Draft words 🪴",
          }),
        );
      }
    }),
  );
  const hostedClient = new HostedBodyClient(hosted.bootstrap, {
    clock: () => hosted.now,
    fetch: async (url, options) =>
      fetch(`${cloudUrl}/${new URL(String(url)).pathname.split("/").at(-1)}`, options),
  });
  await hostedClient.registerPairingKey(generateKeyPairSync("ed25519").privateKey);
  // A generic test connection: the device lifecycle has no hosted server wire dependency.
  const cloudRequest = async (
    action: "status" | "transcribe" | "receipt",
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const response = await hostedClient.signedPost(`/fixture/transcription/${action}`, input, signal);
    const answer: unknown = await response.json();
    if (!response.ok) {
      if (action === "transcribe" && [400, 401, 403, 429].includes(response.status)) {
        const refusal = ComposerTranscriptionAdmissionRefusalSchema.safeParse({
          refused: (answer as { error?: unknown })?.error,
        });
        if (refusal.success) return refusal.data;
      }
      throw new Error("fixture_transcription_unavailable");
    }
    return answer;
  };
  const cloud: ComposerTranscriptionCloud = {
    status: async (device) =>
      ComposerTranscriptionStatusSchema.parse(await cloudRequest("status", { ...device })),
    transcribe: async (input, signal) => {
      const response = await cloudRequest("transcribe", { ...input }, signal);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("lost_receipt");
      }
      const refusal = ComposerTranscriptionAdmissionRefusalSchema.safeParse(response);
      return refusal.success ? refusal.data : ComposerTranscriptionReceiptSchema.parse(response);
    },
    receipt: async (input) =>
      ComposerTranscriptionReceiptSchema.parse(await cloudRequest("receipt", { ...input })),
  };
  const key = randomBytes(32),
    installationId = "i".repeat(22),
    hostId = derivePublicGatewayHostId("fixture-owner", installationId);
  const host = new GatewayEncryptionHost(hostId, randomBytes(32));
  let credential!: GatewayEncryptionCredential, app!: ClankieApp;
  const supportTelemetry = createBodyTelemetry({
    dir: join(root, "support-audit"),
    writer: "service",
    clock: () => now,
  });
  const security = new HostedDeviceSecurity(hostedClient, join(root, "auth.json"));
  const make = async () => {
    app = await createClankieApp({
      captain: createStubCaptain(),
      eventLogPath: join(root, "events.jsonl"),
      clock: () => new Date(now),
      deviceSessionKey: key,
      hostedBody: { registerWakeKey: async () => {}, revokeWakeKey: async () => {} },
      hostedDeviceSecurity: security,
      supportTelemetry,
      supportDeviceRefKey: key,
      authenticateOperator: async (request) => {
        const authorization = request.headers.get("authorization");
        if (authorization === "Bearer owner") return { operatorId: "fixture-owner" };
        if (authorization === "Bearer support-owner") return { operatorId: "support:fixture-owner" };
        return undefined;
      },
      authenticateCaptain: async (request) =>
        request.headers.get("authorization") === "Bearer captain"
          ? { captainId: "fixture-captain" }
          : undefined,
      pairingOfferPublisher: {
        publishPairingOffer: async (offer) => {
          credential = host.pairingCredential(offer);
        },
      },
      ...(managed
        ? {
            composerTranscriptions: new ComposerTranscriptions({
              root: join(root, "composer"),
              cloud,
              clock: () => now,
            }),
          }
        : {}),
    });
  };
  await make();
  closes.push(async () => app.close());
  const bodyUrl = await listen(
    serve({ fetch: (request) => app.app.fetch(request), hostname: "127.0.0.1", port: 0 }) as Server,
  );
  const outer: string[] = [];
  const door = await listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      outer.push(raw);
      const path = (req.url ?? "").replace(`/h/${hostId}`, "");
      const response = await host.handle(path, raw, new AbortController().signal, async (request) =>
        app.app.fetch(request),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    }),
  );
  const base = `${door}/h/${hostId}`;
  const encrypted = createGatewayEncryptedFetch({
    credential: () => credential,
    crypto: {
      randomBytes,
      seal: async (k, text, aad) => sealGatewayValue(Buffer.from(k, "base64"), text, aad),
      open: async (k, text, aad) => openGatewayValue(Buffer.from(k, "base64"), text, aad),
    },
  });
  const finishPairing = async (completionToken: string, grants: DeviceGrantSet = SUPERVISE_GRANTS) => {
    const complete = await encrypted(`${base}/v1/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completionToken, acceptedGrants: grants }),
    });
    const device = await complete.json();
    if (!complete.ok)
      throw Object.assign(new Error(device.error), { status: complete.status, completionToken });
    credential.ticket = complete.headers.get("x-clankie-encryption-ticket")!;
    credential.key = complete.headers.get("x-clankie-encryption-key")!;
    return { deviceId: device.deviceId as string, token: device.deviceToken as string };
  };
  const pair = async (
    grants: DeviceGrantSet = SUPERVISE_GRANTS,
    ownerToken = "owner",
    supportGrantId?: string,
  ) => {
    const offer = await (
      await fetch(
        `${bodyUrl}${supportGrantId === undefined ? "/v1/pairing/offer" : `/v1/support/grants/${supportGrantId}/pairing-offer`}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${ownerToken}` },
        },
      )
    ).json();
    const offerSecret = new URL(offer.deepLink).searchParams.get("offer");
    const redeem = await encrypted(`${base}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offerSecret, device: { name: "Fixture phone", platform: "ios" } }),
    });
    const pending = await redeem.json();
    if (!redeem.ok) throw Object.assign(new Error(pending.error), { status: redeem.status });
    credential.ticket = redeem.headers.get("x-clankie-encryption-ticket")!;
    return finishPairing(pending.completionToken, grants);
  };
  const device = await pair();
  const api = createComposerTranscriptionApi({
    request: async (method, path, body, signal) => {
      const response = await encrypted(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
      return result;
    },
  });
  const upload = async (audio: Buffer, requestId = randomUUID()) => {
    await api.begin({ requestId, audioBytes: audio.length });
    for (let offset = 0; offset < audio.length; offset += COMPOSER_TRANSCRIPTION_CHUNK_BYTES_MAX)
      await api.chunk({
        requestId,
        offset,
        dataBase64: audio
          .subarray(offset, offset + COMPOSER_TRANSCRIPTION_CHUNK_BYTES_MAX)
          .toString("base64"),
      });
    return requestId;
  };
  return {
    root,
    api,
    device,
    outer,
    attestations,
    key,
    bodyUrl,
    pair,
    finishPairing,
    createSupportGrant: async (durationSeconds = 600) => {
      const response = await fetch(`${bodyUrl}/v1/support/grants`, {
        method: "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json" },
        body: JSON.stringify({ scope: "read-state", durationSeconds, supportRef: "composer-test" }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).grantId as string;
    },
    supportDevices,
    holdSupportPublication: () => {
      supportPublicationGate = { entered: gate(), release: gate() };
      return {
        entered: supportPublicationGate.entered.promise,
        release: supportPublicationGate.release.release,
      };
    },
    holdSupportState: () => {
      supportStateGate = { entered: gate(), release: gate() };
      return {
        entered: supportStateGate.entered.promise,
        release: supportStateGate.release.release,
      };
    },
    hideSupportAcknowledgement: (hidden: boolean) => {
      hideSupportAcknowledgement = hidden;
    },
    upload,
    spent: () => spent,
    status: (state: typeof cloudState) => {
      cloudState = state;
    },
    hold: () => {
      providerGate = gate();
      return { entered: reached.promise, release: providerGate.release };
    },
    lose: () => {
      loseResponse = true;
    },
    restart: async () => {
      app.close();
      await make();
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
