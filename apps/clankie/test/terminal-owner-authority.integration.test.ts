import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore, ensureOperatorCredential } from "@clankie/credential-broker";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  SUPERVISE_GRANTS,
  TAKE_CONTROL_GRANTS,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import { createBearerAuthenticator, createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";

const CAPTAIN_TOKEN = "terminal-owner-captain-fixture";

/** Real captain, owner credential broker, signed device authentication, HTTP and disk; no Herdr. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-terminal-owner-"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const owner = await ensureOperatorCredential({ env: {}, store: credentials });
  let now = Date.parse("2026-10-05T12:00:00Z");
  const key = randomBytes(32);
  const signer = new DeviceSessionSigner(key);
  const eventLogPath = join(root, "events.jsonl");
  const events = ["control", "read", "revoked"].flatMap((deviceId) => {
    const grants = deviceId === "read" ? SUPERVISE_GRANTS : TAKE_CONTROL_GRANTS;
    const envelope = {
      occurredAt: new Date(now).toISOString(),
      missionId: `device:${deviceId}`,
      correlationId: "terminal-owner-fixture",
      profileHash: "fixture",
    };
    return [
      {
        ...envelope,
        id: randomUUID(),
        type: "device.pairing.redeemed",
        data: {
          schemaVersion: 1,
          deviceId,
          offerId: deviceId,
          name: deviceId,
          platform: "ios",
          offeredGrants: grants,
          mintedBy: "local-operator",
          pendingExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
      {
        ...envelope,
        id: randomUUID(),
        type: "device.activated",
        data: { schemaVersion: 1, deviceId, grants, sessionExpiresAt: new Date(now + 600_000).toISOString() },
      },
    ];
  });
  await writeFile(eventLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const tokens = Object.fromEntries(
    ["control", "read", "revoked"].map((deviceId) => [
      deviceId,
      signer.issue(mintDeviceSessionClaims({ deviceId, nowEpochSeconds: now / 1_000, ttlSeconds: 60 })),
    ]),
  );
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      runtimes: {
        list: async () => [],
        onChange: () => () => undefined,
        configuredBinding: async () => undefined,
      },
      browser: { catalog: async () => ({ schemaVersion: 1, available: false, tools: [] }) },
      mcp: { catalog: async () => [] },
      media: { finishedRenders: async () => [] },
      embodiment: {
        submitIntent: async () => {
          throw new Error("No body in this fixture");
        },
        getSession: async () => undefined,
        getLiveSession: async () => undefined,
      },
      memory: {
        appendEpisode: async () => ({ corrected: false, retained: false }),
        recallEpisodeCard: async () => "",
        searchEpisodeCard: async () => "",
      },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
    },
  );
  const app = await createClankieApp({
    captain,
    settings: new SettingsStore(join(root, "settings.json")),
    eventLogPath,
    deviceSessionKey: key,
    clock: () => new Date(now),
    authenticateOperator: createCredentialBackedOperatorAuthenticator({
      env: {},
      store: credentials,
      identity: { operatorId: "terminal-fixture-owner", steerSourceLane: "tui" },
    }),
    authenticateCaptain: createBearerAuthenticator(CAPTAIN_TOKEN, {
      captainId: "terminal-fixture-captain",
      steerSourceLane: "api",
    }),
  });
  const server = serve({ fetch: app.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture loopback port");
  const host = `http://127.0.0.1:${address.port}`;
  // Drain the startup census before a test reserves an awaited fleet refresh.
  await captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 });
  const post = (request: OperatorConversationServiceRequest, token: string) =>
    fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, host), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  return {
    ownerToken: owner.token,
    tokens,
    post,
    async close() {
      app.close();
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await captain.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

const control: OperatorConversationServiceRequest = {
  op: "terminal_control",
  schemaVersion: 1,
  control: { schemaVersion: 1, action: "request", terminalId: "term-worker", surfaceClientId: "native-ios" },
};
const input: OperatorConversationServiceRequest = {
  op: "terminal_input",
  schemaVersion: 1,
  input: {
    schemaVersion: 1,
    terminalId: "term-worker",
    surfaceClientId: "native-ios",
    leaseToken: "lease-1",
    dataBase64: "aGVsbG8=",
  },
};

it("refuses terminal control and input on the captain bearer alone", async () => {
  const f = await fixture();
  try {
    for (const request of [control, input]) {
      const response = await f.post(request, CAPTAIN_TOKEN);
      expect(response.status, request.op).toBe(403);
      expect(await response.json()).toEqual({ error: "terminal_owner_required" });
    }
  } finally {
    await f.close();
  }
});

it("refuses a paired device without terminal control", async () => {
  const f = await fixture();
  try {
    for (const request of [control, input]) {
      const response = await f.post(request, f.tokens.read!);
      // A supervise-only device is no captain and no owner here.
      expect([401, 403], request.op).toContain(response.status);
    }
  } finally {
    await f.close();
  }
});

it("serves the machine's operator and a device holding terminal control", async () => {
  const f = await fixture();
  try {
    for (const token of [f.ownerToken, f.tokens.control!])
      for (const request of [control, input]) {
        const response = await f.post(request, token);
        expect(response.status, request.op).toBe(200);
        // No Herdr in this fixture: the owner reaches the terminal layer, which says so.
        expect(await response.json()).toMatchObject({ op: request.op, result: { status: "unavailable" } });
      }
  } finally {
    await f.close();
  }
});
