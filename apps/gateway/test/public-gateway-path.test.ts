import { FileCredentialStore } from "../../../packages/credential-broker/src/index.ts";
import { SettingsStore } from "../../../packages/settings/src/index.ts";
import { MachineJoins } from "../../../apps/clankie/src/machine-joins.ts";
import { machineJoinHash, machineJoinKey } from "../../../apps/clankie/src/machine-join-crypto.ts";
import {
  exchangeJoinedMachine,
  runJoinedMachineChannel,
} from "../../../apps/tui/bin/joined-machine-client.ts";
import { MachineJoinLeaseSchema, machineJoinLeaseAad } from "@clankie/protocol/machine-join";
import { derivePublicGatewayHostId } from "@clankie/protocol/public-gateway";
// Drives the Mac service, connector and relay from this workspace through the
// gateway: the whole phone path in one checkout.
import { randomBytes } from "node:crypto";
import { createGatewayEncryptedFetch } from "../../../packages/api-client/src/gateway-encryption.ts";
import { GatewayEncryptionCredentialSchema } from "@clankie/protocol/gateway-encryption";
import { sealGatewayValue, openGatewayValue } from "../../../apps/clankie/src/gateway-encryption.ts";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { TAKE_CONTROL_GRANTS, type OperatorConversationServiceRequest } from "@clankie/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClankieApp,
  type ClankieApp,
  type TrustedOperatorIdentity,
} from "../../../apps/clankie/src/app.ts";
import { createStubCaptain } from "../../../apps/clankie/src/captain/port.ts";
import { PublicGatewayConnector } from "../../../apps/clankie/src/public-gateway-connector.ts";
import { createPublicGateway, type PublicGateway } from "../src/gateway.ts";
import { ControlPlaneDeviceAuthorizer } from "../../../apps/relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../../apps/relay/src/operator-conversations.ts";

const HOST_ID = "mac_james_12345678";
const HOST_TOKEN = "gateway-host-token-that-is-longer-than-thirty-two-characters";
const DEVICE_KEY = Uint8Array.from(Buffer.alloc(32, 7));
const servers: Server[] = [];
const gateways: PublicGateway[] = [];
const connectors: PublicGatewayConnector[] = [];
const apps: ClankieApp[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const connector of connectors.splice(0)) connector.close();
  for (const app of apps.splice(0)) app.close();
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("public gateway product path", () => {
  it.each(["legacy host token", "signed-in account"])(
    "a Mac on a %s pairs, joins, executes and revokes through the real gateway and connector",
    async (mode) => {
      const installationId = "installed_mac_inst0001";
      const accountId = "fixture-join-owner";
      // The account path's verifier is a fixture standing in for Cognito's
      // (cognito-jwt.test.ts covers the real one): it accepts one access token.
      const accessToken = `fixture-access-${randomBytes(8).toString("hex")}`;
      const signedIn = mode === "signed-in account";
      const hostId = signedIn ? derivePublicGatewayHostId(accountId, installationId) : HOST_ID;
      const gateway = createPublicGateway({
        hostTokens: new Map([[HOST_ID, HOST_TOKEN]]),
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
          if (token !== accessToken) throw new Error("denied");
          return { accountId, expiresAtMs: Date.now() + 6 * 3600000 };
        },
      });
      gateways.push(gateway);
      const gatewayOrigin = await listen(gateway.server);
      const hostBaseUrl = `${gatewayOrigin}/h/${hostId}`;
      const directory = await realpath(await mkdtemp(join(tmpdir(), "clankie-public-path-")));
      directories.push(directory);

      const settings = new SettingsStore(join(directory, "settings.json"));
      const secrets = new FileCredentialStore(join(directory, "fixture-body-secrets.json"));
      const joins = new MachineJoins({
        settings,
        secrets,
        directory: join(directory, "joins"),
        changed: () => {},
      });
      let connector: PublicGatewayConnector | undefined;
      const clankie = await createClankieApp({
        captain: createStubCaptain(),
        machineJoins: joins,
        settings,
        deviceSessionKey: DEVICE_KEY,
        eventLogPath: join(directory, "events.jsonl"),
        hostDisplayName: "James Mac",
        publicGatewayHostBaseUrl: hostBaseUrl,
        pairingOfferPublisher: {
          protectPairingOffer: (offer) => connector!.protectPairingOffer(offer),
          publishPairingOffer: (offer) => {
            if (connector === undefined) return Promise.reject(new Error("connector not ready"));
            return connector.publishPairingOffer(offer);
          },
        },
        authenticateOperator: operator,
      });
      apps.push(clankie);
      const controlServer = serve({ fetch: clankie.app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
      servers.push(controlServer);
      const controlOrigin = await listeningOrigin(controlServer);

      const relayHandler = createOperatorConversationRelayHandler({
        authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: controlOrigin }),
        tailMaxPages: 1,
        dispatch: dispatch,
      });
      const relayServer = createServer((request, response) => {
        void relayHandler(request, response).then((handled) => {
          if (handled) return;
          response.statusCode = 404;
          response.end();
        });
      });
      const relayOrigin = await listen(relayServer);

      connector = new PublicGatewayConnector({
        gatewayUrl: gatewayOrigin,
        hostId,
        ...(signedIn
          ? {
              installationId,
              resolveHostToken: async () => ({ token: accessToken, expiresAt: Date.now() + 6 * 3600000 }),
            }
          : { hostToken: HOST_TOKEN }),
        encryptionKey: randomBytes(32),
        controlPlaneUrl: controlOrigin,
        relayUrl: relayOrigin,
      });
      connectors.push(connector);
      connector.start();

      const offerResponse = await fetch(`${controlOrigin}/v1/pairing/offer`, {
        method: "POST",
        headers: { authorization: "Bearer operator-secret", "content-type": "application/json" },
        body: "{}",
      });
      expect(offerResponse.status).toBe(200);
      const offer = (await offerResponse.json()) as { readonly deepLink: string };
      const offerSecret = new URL(offer.deepLink).searchParams.get("offer");
      expect(offerSecret).toBeTruthy();

      const credential = GatewayEncryptionCredentialSchema.parse(
        Object.fromEntries(new URLSearchParams(new URL(offer.deepLink).hash.slice(1))),
      );
      const encryptedFetch = createGatewayEncryptedFetch({
        credential: () => credential,
        crypto: {
          randomBytes,
          seal: async (key, plain, aad) => sealGatewayValue(Buffer.from(key, "base64"), plain, aad),
          open: async (key, sealed, aad) => openGatewayValue(Buffer.from(key, "base64"), sealed, aad),
        },
      });
      const redeem = await encryptedFetch(`${hostBaseUrl}/v1/pairing/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offerSecret, device: { name: "James iPhone", platform: "ios" } }),
      });
      expect(redeem.status).toBe(200);
      credential.ticket = redeem.headers.get("x-clankie-encryption-ticket")!;
      const redeemed = (await redeem.json()) as {
        readonly completionToken: string;
        readonly hostBaseUrl: string;
      };
      expect(redeemed.hostBaseUrl).toBe(hostBaseUrl);

      const complete = await encryptedFetch(`${redeemed.hostBaseUrl}/v1/pairing/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          completionToken: redeemed.completionToken,
          acceptedGrants: TAKE_CONTROL_GRANTS,
        }),
      });
      expect(complete.status).toBe(200);
      credential.ticket = complete.headers.get("x-clankie-encryption-ticket")!;
      credential.key = complete.headers.get("x-clankie-encryption-key")!;
      const completed = (await complete.json()) as {
        readonly deviceToken: string;
        readonly relayUrl: string;
      };
      expect(completed.relayUrl).toBe(hostBaseUrl);

      const headers = {
        authorization: `Bearer ${completed.deviceToken}`,
        "content-type": "application/json",
      };
      const conversations = await encryptedFetch(`${completed.relayUrl}/operator/v1/dispatch`, {
        method: "POST",
        headers,
        body: JSON.stringify({ op: "list", schemaVersion: 1 }),
      });
      expect(await conversations.json()).toEqual({ op: "list", schemaVersion: 1, conversations: [] });

      const terminal = await encryptedFetch(`${completed.relayUrl}/operator/v1/terminal-tail`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          op: "terminal_tail",
          schemaVersion: 1,
          observation: {
            schemaVersion: 1,
            terminalId: "term-worker",
            surfaceClientId: "native-ios",
            columns: 120,
            rows: 40,
            limit: 1,
          },
        }),
      });
      expect(terminal.status).toBe(200);
      expect((await terminal.text()).trim()).toContain('"kind":"frame"');

      const post = (path: string, body: unknown, bearer?: string) =>
        fetch(hostBaseUrl + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          },
          body: JSON.stringify(body),
        });
      const code = randomBytes(32).toString("base64url");
      const claimSecret = randomBytes(32).toString("base64url");
      const started = await post("/v1/machine-joins/start", {
        name: "fixture native host",
        platform: "darwin",
        directories: [directory],
        claimSecret,
        approvalHash: machineJoinHash(code),
      });
      expect(started.status).toBe(200);
      const ticket = (await started.json()) as { joinId: string };
      expect(
        await (await post("/v1/machine-joins/status", { joinId: ticket.joinId }, claimSecret)).json(),
      ).toEqual({ state: "pending" });
      expect(
        (
          await post(
            "/v1/machine-joins/approve",
            { code, accessLevel: "shell", directories: [directory] },
            completed.deviceToken,
          )
        ).status,
      ).toBe(426);
      const unauthorized = await encryptedFetch(hostBaseUrl + "/v1/machine-joins/approve", {
        method: "POST",
        headers: { ...headers, authorization: "Bearer invalid-fixture-device" },
        body: JSON.stringify({ code, accessLevel: "shell", directories: [directory] }),
      });
      expect(unauthorized.status).toBe(401);
      const approval = await encryptedFetch(hostBaseUrl + "/v1/machine-joins/approve", {
        method: "POST",
        headers,
        body: JSON.stringify({ code, accessLevel: "shell", directories: [directory] }),
      });
      expect(approval.status).toBe(200);
      const status = (await (
        await post("/v1/machine-joins/status", { joinId: ticket.joinId }, claimSecret)
      ).json()) as { state: string; sealedLease: string };
      expect(status.state).toBe("approved");
      const lease = MachineJoinLeaseSchema.parse(
        JSON.parse(
          openGatewayValue(machineJoinKey(code), status.sealedLease, machineJoinLeaseAad(ticket.joinId)),
        ),
      );
      expect(status.sealedLease).not.toContain(lease.token);
      const machineCredential = { origin: hostBaseUrl, lease, localDirectories: [directory] };
      const abort = new AbortController();
      let capturedEnvelope: unknown;
      const capturedFetch: typeof fetch = async (input, init) => {
        if (String(input).endsWith("/v1/joined-machines/channel")) {
          capturedEnvelope ??= JSON.parse(String(init?.body));
          expect(String(init?.body)).not.toContain(lease.token);
          expect(String(init?.body)).not.toContain("joined-through-private-gateway");
          expect(init?.headers).not.toHaveProperty("authorization");
        }
        return fetch(input, init);
      };
      const channel = runJoinedMachineChannel(machineCredential, {
        fetchImpl: capturedFetch,
        store: new FileCredentialStore(join(directory, "fixture-native-secrets.json")),
        signal: abort.signal,
        intervalMs: 20,
      });
      try {
        const result = await joins.request(
          lease.machineId,
          { kind: "shell", directory, command: "printf 'joined-through-private-gateway'" },
          4000,
        );
        // The joined machine reports its own exit status first (core VUH-2319).
        expect(result).toMatchObject({ ok: true, output: "[exit 0]\njoined-through-private-gateway" });
        // The native loop uses the real guarded local shell, with no SSH route.
        expect((await joins.inventory())[0]).toMatchObject({
          state: "available",
          accessEnforcement: "joined-host",
        });
      } finally {
        abort.abort();
        await channel;
      }
      expect(capturedEnvelope).toBeDefined();
      expect((await post("/v1/joined-machines/channel", capturedEnvelope)).status).toBe(403);
      const validShapeForgedCipher = {
        ...(capturedEnvelope as Record<string, unknown>),
        sealedRequest: "forged-ciphertext",
      };
      expect((await post("/v1/joined-machines/channel", validShapeForgedCipher)).status).toBe(403);
      expect(await exchangeJoinedMachine(machineCredential, { op: "leave", results: [] })).toEqual({
        ok: true,
      });
      await expect(exchangeJoinedMachine(machineCredential, { op: "poll", results: [] })).rejects.toThrow(
        "revoked",
      );
      expect(await joins.inventory()).toEqual([]);
    },
  );
});

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer operator-secret"
      ? { operatorId: "operator-james" }
      : undefined,
  );
}

function dispatch(request: OperatorConversationServiceRequest) {
  if (request.op === "list")
    return Promise.resolve({ op: "list" as const, schemaVersion: 1 as const, conversations: [] });
  if (request.op !== "terminal_tail") return Promise.reject(new Error(`unexpected ${request.op}`));
  return Promise.resolve({
    op: "terminal_tail" as const,
    schemaVersion: 1 as const,
    result: {
      schemaVersion: 1 as const,
      status: "page" as const,
      terminalId: request.observation.terminalId,
      surfaceClientId: request.observation.surfaceClientId,
      cursor: { streamId: "stream-1", sequence: 1 },
      frames: [
        {
          schemaVersion: 1 as const,
          type: "terminal.frame" as const,
          terminalId: request.observation.terminalId,
          sequence: 1,
          encoding: "base64" as const,
          data: "G1sySg==",
          columns: 120,
          rows: 40,
          full: true,
        },
      ],
      hasMore: false,
    },
  });
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  return await listeningOrigin(server);
}

async function listeningOrigin(server: Server): Promise<string> {
  if (!server.listening) await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}
