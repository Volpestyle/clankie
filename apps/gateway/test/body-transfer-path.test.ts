import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
// Drives the body, transfer routes and connector from this workspace through
// the gateway, as public-gateway-path.test.ts does (VUH-2582).
import { SettingsStore } from "../../../packages/settings/src/index.ts";
import { createGatewayEncryptedFetch } from "../../../packages/api-client/src/gateway-encryption.ts";
import { sealGatewayValue, openGatewayValue } from "../../../apps/clankie/src/gateway-encryption.ts";
import {
  createClankieApp,
  type ClankieApp,
  type TrustedOperatorIdentity,
} from "../../../apps/clankie/src/app.ts";
import { createStubCaptain } from "../../../apps/clankie/src/captain/port.ts";
import { PublicGatewayConnector } from "../../../apps/clankie/src/public-gateway-connector.ts";
import { BodyTransfer, createBodyTransferRoutes } from "../../../apps/clankie/src/body-transfer.ts";
import { createDormantApp } from "../../../apps/clankie/src/dormant-body.ts";
import { GatewayEncryptionCredentialSchema } from "@clankie/protocol/gateway-encryption";
import { derivePublicGatewayHostId } from "@clankie/protocol/public-gateway";
import { SUPERVISE_GRANTS, TAKE_CONTROL_GRANTS, type DeviceGrantSet } from "@clankie/protocol";
import {
  BODY_TRANSFER_DOWNLOAD_CHUNK_BYTES,
  BODY_TRANSFER_UPLOAD_CHUNK_BYTES,
  BodyAuthoritySchema,
  BodyTransferBundleChunkSchema,
} from "@clankie/protocol/body-transfer";
import { createPublicGateway, type PublicGateway } from "../src/gateway.ts";

const DEVICE_KEY = Uint8Array.from(Buffer.alloc(32, 9));
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

describe("body transfer through the public gateway (ADR 0286, VUH-2582)", () => {
  it("moves Clankie from a Mac into a body reached through the gateway with an owner device, in envelope-sized chunks", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-transfer-path-")));
    closers.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));

    // The real gateway, admitting the destination body by its account sign-in.
    // The verifier is a fixture standing in for Cognito's (cognito-jwt.test.ts
    // covers the real one): it accepts one access token. The public service
    // still names a gateway-reached destination `hosted:<hostId>`.
    const installationId = "installed_mac_inst0001";
    const accountId = "fixture-transfer-owner";
    const hostId = derivePublicGatewayHostId(accountId, installationId);
    const hostToken = `fixture-access-${randomBytes(8).toString("hex")}`;
    const gateway: PublicGateway = createPublicGateway({
      hostTokens: new Map(),
      accountConfig: {
        schemaVersion: 1,
        account: {
          provider: "cognito_email_otp",
          endpoint: "https://cognito-idp.us-east-1.amazonaws.com",
          issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
          clientId: "client123",
          selfSignUpEnabled: false,
        },
      },
      authenticateAccountToken: async (token) => {
        if (token !== hostToken) throw new Error("denied");
        return { accountId, expiresAtMs: Date.now() + 6 * 3600000 };
      },
    });
    closers.push(() => gateway.close());
    const gatewayOrigin = await listen(gateway.server);
    const hostBaseUrl = `${gatewayOrigin}/h/${hostId}`;
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const relayOrigin = await listen(relay);

    // The destination body. Its broker keeps the gateway encryption key across restarts, as production does.
    const hostedState = join(root, "hosted/state");
    await mkdir(hostedState, { recursive: true });
    const encryptionKey = randomBytes(32);
    let body:
      | { app: ClankieApp; server: Server; connector: PublicGatewayConnector; controlOrigin: string }
      | undefined;
    let restarts = 0;
    const startHostedBody = async () => {
      const settings = new SettingsStore(join(root, "hosted/settings.json"));
      const transfer = new BodyTransfer({
        roots: {
          state: hostedState,
          memory: join(hostedState, "memory"),
          attachments: join(hostedState, "attachments"),
        },
        settings,
        label: "hosted",
      });
      // A launcher restart: boot finishes a committed apply before anything opens.
      await transfer.boot();
      let connector: PublicGatewayConnector | undefined;
      // A frozen or released body boots into its dormant doorway, as the service does.
      const app = transfer.dormant()
        ? await (async () => {
            await transfer.prepareOutgoing();
            return createDormantApp({
              transfer,
              restart: () => void restartHostedBody(),
              settings,
              deviceSessionKey: DEVICE_KEY,
              eventLogPath: join(hostedState, "events.jsonl"),
              authenticateOperator: operator,
              publicGatewayHostBaseUrl: hostBaseUrl,
            });
          })()
        : await createClankieApp({
            captain: createStubCaptain(),
            settings,
            deviceSessionKey: DEVICE_KEY,
            eventLogPath: join(hostedState, "events.jsonl"),
            hostDisplayName: "Hosted Clankie",
            publicGatewayHostBaseUrl: hostBaseUrl,
            pairingOfferPublisher: {
              protectPairingOffer: (offer) => connector!.protectPairingOffer(offer),
              publishPairingOffer: (offer) => connector!.publishPairingOffer(offer),
            },
            authenticateOperator: operator,
            bodyTransfer: {
              transfer,
              cutover: async (commit) => {
                await commit();
                // Like the service: admission is closed, then the launcher restarts the body.
                setTimeout(() => void restartHostedBody(), 100);
                return "ready";
              },
            },
          });
      const server = serve({ fetch: app.app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
      const controlOrigin = await listeningOrigin(server);
      connector = new PublicGatewayConnector({
        gatewayUrl: gatewayOrigin,
        hostId,
        installationId,
        resolveHostToken: async () => ({ token: hostToken, expiresAt: Date.now() + 6 * 3600000 }),
        encryptionKey,
        controlPlaneUrl: controlOrigin,
        relayUrl: relayOrigin,
      });
      connector.start();
      body = { app, server, connector, controlOrigin };
    };
    const stopHostedBody = async () => {
      if (body === undefined) return;
      body.connector.close();
      body.app.close();
      await closeServer(body.server);
      body = undefined;
    };
    let stopped = false;
    const restartHostedBody = async () => {
      if (stopped) return;
      restarts += 1;
      await stopHostedBody();
      await startHostedBody();
    };
    closers.push(async () => {
      stopped = true;
      await stopHostedBody();
    });
    await startHostedBody();

    // The owner's devices, paired through the gateway like the app.
    const owner = await pairDevice(hostBaseUrl, body!.controlOrigin, TAKE_CONTROL_GRANTS, "Owner iPhone");
    const supervisor = await pairDevice(hostBaseUrl, body!.controlOrigin, SUPERVISE_GRANTS, "Watching iPad");
    const status = async () =>
      BodyAuthoritySchema.loose().parse(await (await owner.fetch("GET", "/v1/body-transfer/status")).json());
    expect((await status()).selfId).toBeUndefined();
    expect((await supervisor.fetch("GET", "/v1/body-transfer/status")).status).toBe(403);
    expect((await owner.fetch("GET", "/v1/body-transfer/status", undefined, false)).status).toBe(401);
    // Transfer routes never travel outside the encryption gate.
    expect((await fetch(`${hostBaseUrl}/v1/body-transfer/status`)).status).not.toBe(200);

    // The Mac: real history on disk, including an attachment that spans many chunks.
    const macState = join(root, "mac/state");
    await mkdir(join(macState, "memory/captain-episodes"), { recursive: true });
    await mkdir(join(macState, "captain/conversations/global-default"), { recursive: true });
    await mkdir(join(macState, "attachments/delivered"), { recursive: true });
    const note = `{"summary":"The transfer codeword is ${randomBytes(4).toString("hex")}."}\n`;
    await writeFile(join(macState, "memory/captain-episodes/operator.jsonl"), note);
    await writeFile(
      join(macState, "captain/conversations/global-default/events.jsonl"),
      '{"type":"message","role":"operator","text":"hello"}\n',
    );
    const attachment = randomBytes(9 * 1024 * 1024);
    await writeFile(join(macState, "attachments/delivered/screen.bin"), attachment);
    const macSettings = new SettingsStore(join(root, "mac/settings.json"));
    await macSettings.update((current) => ({
      ...current,
      projects: {
        ...current.projects,
        projects: [
          {
            id: "proof",
            name: "Proof",
            workspaces: [
              { id: "primary", machineId: "local", path: "/Users/owner/proof", platform: "posix" },
            ],
            worktreeRoots: [],
            roles: [],
            labelRoleMap: [],
            grants: [],
          },
        ],
      },
    }));
    const macRoots = {
      state: macState,
      memory: join(macState, "memory"),
      attachments: join(macState, "attachments"),
    };
    const mac = new BodyTransfer({
      roots: macRoots,
      settings: macSettings,
      label: "local:owner-mac",
    });
    const macRoutes = createBodyTransferRoutes({
      transfer: mac,
      authorize: async (request) =>
        request.headers.get("authorization") === "Bearer operator-secret" ? true : "authentication_required",
      cutover: async (commit) => {
        await commit();
        return "ready";
      },
    });
    const macPost = async (path: string, value: unknown) =>
      macRoutes.request(path, {
        method: "POST",
        headers: { authorization: "Bearer operator-secret", "content-type": "application/json" },
        body: JSON.stringify(value),
      });

    const transferId = "5d6c1b0e-6a52-4c6c-9f4e-2b8d1f6c3a10";
    expect(
      (await macPost("/v1/body-transfer/freeze", { transferId, destination: `hosted:${hostId}` })).status,
    ).toBe(200);
    const bundle: Buffer[] = [];
    let expected: { size: number; sha256: string } | undefined;
    for (let offset = 0; expected === undefined || offset < expected.size;) {
      const chunk = BodyTransferBundleChunkSchema.parse(
        await (await macPost("/v1/body-transfer/bundle", { transferId, offset })).json(),
      );
      expected = { size: chunk.size, sha256: chunk.sha256 };
      const bytes = Buffer.from(chunk.bytesBase64, "base64");
      expect(bytes.length).toBeLessThanOrEqual(BODY_TRANSFER_DOWNLOAD_CHUNK_BYTES);
      bundle.push(bytes);
      offset += bytes.length;
    }
    const bytes = Buffer.concat(bundle);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected!.sha256);

    // Every upload chunk crosses the gateway inside one encrypted envelope.
    let chunks = 0;
    for (let offset = 0; offset < bytes.length; offset += BODY_TRANSFER_UPLOAD_CHUNK_BYTES) {
      const slice = bytes.subarray(offset, offset + BODY_TRANSFER_UPLOAD_CHUNK_BYTES);
      const response = await owner.fetch("POST", "/v1/body-transfer/stage-chunk", {
        transferId,
        offset,
        bytesBase64: slice.toString("base64"),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      chunks += 1;
    }
    expect(chunks).toBeGreaterThan(10);
    const staged = await owner.fetch("POST", "/v1/body-transfer/stage", {
      transferId,
      size: bytes.length,
      sha256: expected!.sha256,
    });
    expect(staged.status, await staged.clone().text()).toBe(200);
    expect(await staged.json()).toMatchObject({ transferId, outcome: "staged", files: 3 });
    // A supervising device cannot apply it.
    expect((await supervisor.fetch("POST", "/v1/body-transfer/apply", { transferId })).status).toBe(403);
    // The restart the apply starts can cut its reply; the body's status decides, as in the CLI.
    const applied = await owner.fetch("POST", "/v1/body-transfer/apply", { transferId }).then(
      (response) => response.status,
      (error: unknown) => (error as { status?: number }).status,
    );
    expect([200, 503]).toContain(applied);

    // The body restarts, applies at boot, and answers again through the gateway.
    let activation: Awaited<ReturnType<typeof status>> | undefined;
    for (let attempt = 0; attempt < 200 && activation === undefined; attempt++) {
      try {
        const current = await status();
        if (current.state === "active" && current.transferId === transferId) activation = current;
      } catch {
        // allow-swallowed-rejection -- the body is restarting behind the gateway; the attempt bound fails the test
      }
      if (activation === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(restarts).toBe(1);
    expect(activation).toMatchObject({ state: "active", dormant: false, epoch: 1, transferId });
    const released = await macPost("/v1/body-transfer/release", {
      transferId,
      destination: `hosted:${hostId}`,
      activation: { ...activation, transfers: undefined },
    });
    expect(released.status, await released.clone().text()).toBe(200);
    expect(await released.json()).toMatchObject({
      state: "released",
      selfId: activation!.selfId,
      releasedTo: { peer: `hosted:${hostId}`, epoch: 1 },
    });

    // The same Clankie on the hosted body: memory, conversation, attachment and project.
    expect(await readFile(join(hostedState, "memory/captain-episodes/operator.jsonl"), "utf8")).toBe(note);
    expect(
      await readFile(join(hostedState, "captain/conversations/global-default/events.jsonl"), "utf8"),
    ).toContain("hello");
    expect((await readFile(join(hostedState, "attachments/delivered/screen.bin"))).equals(attachment)).toBe(
      true,
    );
    const moved = await new SettingsStore(join(root, "hosted/settings.json")).load();
    expect(moved.projects.projects[0]!.workspaces[0]!.machineId).toBe(`transferred:${transferId}`);
    // A repeated apply through the gateway is a no-op and restarts nothing.
    expect((await owner.fetch("POST", "/v1/body-transfer/apply", { transferId })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(restarts).toBe(1);

    // The return trip (VUH-2583): the hosted body learns something, freezes, and
    // restarts into its dormant doorway, which its owner still reaches through the gateway.
    const learned = `{"summary":"Learned while hosted ${randomBytes(4).toString("hex")}."}\n`;
    await writeFile(join(hostedState, "memory/captain-episodes/hosted.jsonl"), learned);
    // The old Mac joined the hosted body; its workspace runs there now.
    const rebound = await owner.fetch("POST", "/v1/body-transfer/rebind", {
      transferId,
      machineId: "join-owner-mac",
    });
    expect(await rebound.json()).toEqual({ rebound: 1 });
    const backId = "9a7e3c21-4b6d-4f80-8c2e-1d5b7a9f0e43";
    const frozen = await owner
      .fetch("POST", "/v1/body-transfer/freeze", {
        transferId: backId,
        destination: "local:owner-mac",
        destinationMachineId: "join-owner-mac",
      })
      .then(
        (response) => response.status,
        (error: unknown) => (error as { status?: number }).status,
      );
    expect([200, 503]).toContain(frozen);
    let dormant: Awaited<ReturnType<typeof status>> | undefined;
    for (let attempt = 0; attempt < 200 && dormant === undefined; attempt++) {
      try {
        const current = await status();
        if (current.dormant && current.state === "frozen" && current.transferId === backId) dormant = current;
      } catch {
        // allow-swallowed-rejection -- the body is restarting behind the gateway; the attempt bound fails the test
      }
      if (dormant === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(restarts).toBe(2);
    expect(dormant).toMatchObject({ state: "frozen", dormant: true, epoch: 2 });
    // Only the doorway answers: other owner routes and a supervising device are refused.
    const devices = await owner.fetch("GET", "/v1/devices");
    expect(devices.status).toBe(503);
    expect(await devices.json()).toMatchObject({ error: "body_dormant" });
    expect((await supervisor.fetch("GET", "/v1/body-transfer/status")).status).toBe(403);

    // The bundle comes back through the gateway in response-sized chunks.
    const returned: Buffer[] = [];
    let back: { size: number; sha256: string } | undefined;
    let downloads = 0;
    for (let offset = 0; back === undefined || offset < back.size;) {
      const response = await owner.fetch("POST", "/v1/body-transfer/bundle", { transferId: backId, offset });
      expect(response.status, await response.clone().text()).toBe(200);
      const chunk = BodyTransferBundleChunkSchema.parse(await response.json());
      back = { size: chunk.size, sha256: chunk.sha256 };
      const piece = Buffer.from(chunk.bytesBase64, "base64");
      returned.push(piece);
      offset += piece.length;
      downloads += 1;
    }
    expect(downloads).toBeGreaterThan(1);
    const returnedBytes = Buffer.concat(returned);
    expect(createHash("sha256").update(returnedBytes).digest("hex")).toBe(back!.sha256);

    // The released Mac takes Clankie back: stage, apply, restart into an active body.
    let macBody = new BodyTransfer({ roots: macRoots, settings: macSettings, label: "local:owner-mac" });
    await macBody.boot();
    const macDoor = () =>
      createBodyTransferRoutes({
        transfer: macBody,
        authorize: async (request) =>
          request.headers.get("authorization") === "Bearer operator-secret"
            ? true
            : "authentication_required",
        restart: () =>
          void (async () => {
            macBody = new BodyTransfer({ roots: macRoots, settings: macSettings, label: "local:owner-mac" });
            await macBody.boot();
          })(),
      });
    const macDoorPost = async (path: string, value: unknown) =>
      macDoor().request(path, {
        method: "POST",
        headers: { authorization: "Bearer operator-secret", "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    for (let offset = 0; offset < returnedBytes.length; offset += BODY_TRANSFER_UPLOAD_CHUNK_BYTES)
      expect(
        (
          await macDoorPost("/v1/body-transfer/stage-chunk", {
            transferId: backId,
            offset,
            bytesBase64: returnedBytes
              .subarray(offset, offset + BODY_TRANSFER_UPLOAD_CHUNK_BYTES)
              .toString("base64"),
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await macDoorPost("/v1/body-transfer/stage", {
          transferId: backId,
          size: returnedBytes.length,
          sha256: back!.sha256,
        })
      ).status,
    ).toBe(200);
    expect((await macDoorPost("/v1/body-transfer/apply", { transferId: backId })).status).toBe(200);
    for (let attempt = 0; attempt < 100 && macBody.dormant(); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const macActive = macBody.authority();
    expect(macActive).toMatchObject({
      state: "active",
      dormant: false,
      epoch: 2,
      transferId: backId,
      selfId: activation!.selfId,
    });
    const releasedHosted = await owner.fetch("POST", "/v1/body-transfer/release", {
      transferId: backId,
      destination: "local:owner-mac",
      activation: macActive,
    });
    expect(releasedHosted.status, await releasedHosted.clone().text()).toBe(200);
    expect(await releasedHosted.json()).toMatchObject({
      state: "released",
      releasedTo: { peer: "local:owner-mac", epoch: 2 },
    });
    expect(await readFile(join(macState, "memory/captain-episodes/hosted.jsonl"), "utf8")).toBe(learned);
    expect((await readFile(join(macState, "attachments/delivered/screen.bin"))).equals(attachment)).toBe(
      true,
    );
    expect(
      (await new SettingsStore(join(root, "mac/settings.json")).load()).projects.projects[0]!.workspaces[0]!
        .machineId,
    ).toBe("local");
  }, 90_000);
});

/** Pairs a device through the gateway exactly as the app does, with the grants the owner accepts. */
async function pairDevice(hostBaseUrl: string, controlOrigin: string, grants: DeviceGrantSet, name: string) {
  const offerResponse = await fetch(`${controlOrigin}/v1/pairing/offer`, {
    method: "POST",
    headers: { authorization: "Bearer operator-secret", "content-type": "application/json" },
    body: "{}",
  });
  expect(offerResponse.status).toBe(200);
  const offer = (await offerResponse.json()) as { readonly deepLink: string };
  const offerSecret = new URL(offer.deepLink).searchParams.get("offer");
  const credential = GatewayEncryptionCredentialSchema.parse(
    Object.fromEntries(new URLSearchParams(new URL(offer.deepLink).hash.slice(1))),
  );
  const encryptedFetch = createGatewayEncryptedFetch({
    credential: () => credential,
    crypto: {
      randomBytes,
      seal: async (sealKey, plain, aad) => sealGatewayValue(Buffer.from(sealKey, "base64"), plain, aad),
      open: async (openKey, sealed, aad) => openGatewayValue(Buffer.from(openKey, "base64"), sealed, aad),
    },
  });
  const redeem = await encryptedFetch(`${hostBaseUrl}/v1/pairing/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offerSecret, device: { name, platform: "ios" } }),
  });
  expect(redeem.status).toBe(200);
  credential.ticket = redeem.headers.get("x-clankie-encryption-ticket")!;
  const redeemed = (await redeem.json()) as { readonly completionToken: string };
  const complete = await encryptedFetch(`${hostBaseUrl}/v1/pairing/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ completionToken: redeemed.completionToken, acceptedGrants: grants }),
  });
  expect(complete.status).toBe(200);
  credential.ticket = complete.headers.get("x-clankie-encryption-ticket")!;
  credential.key = complete.headers.get("x-clankie-encryption-key")!;
  const { deviceToken } = (await complete.json()) as { readonly deviceToken: string };
  return {
    fetch: (method: "GET" | "POST", path: string, value?: unknown, authenticated = true) =>
      encryptedFetch(`${hostBaseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: `Bearer ${deviceToken}` } : {}),
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }),
  };
}

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer operator-secret"
      ? { operatorId: "operator-owner" }
      : undefined,
  );
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  closers.push(() => closeServer(server));
  return listeningOrigin(server);
}

async function listeningOrigin(server: Server): Promise<string> {
  if (!server.listening) await once(server, "listening");
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
}
