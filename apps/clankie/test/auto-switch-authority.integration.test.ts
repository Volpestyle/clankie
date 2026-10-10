import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore, ensureOperatorCredential } from "@clankie/credential-broker";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  SUPERVISE_GRANTS,
  TAKE_CONTROL_GRANTS,
  type OperatorAutonomyCommand,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import { createBearerAuthenticator, createClankieApp } from "../src/app.ts";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../../tui/src/session/operator-conversations.ts";
import { runConversationsCommand } from "../../tui/src/command/conversations.ts";

const CONVERSATION = "global-default";
const CAPTAIN_TOKEN = "auto-authority-captain-fixture";
const AUTO_ON: OperatorAutonomyCommand = { action: "set_enabled", enabled: true };

/** Real captain, owner credential broker, signed device authentication, HTTP and disk.
 * Autonomy starts disabled and no provider, external body or live account is used. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-auto-owner-authority-"));
  const path = join(root, "autonomy.json");
  const seeded = new AutonomyStore(path);
  seeded.command(CONVERSATION, { action: "set_enabled", enabled: false });
  seeded.close();
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
      correlationId: "auto-authority-fixture",
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
  let turns = 0;
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      onTurnSettled: () => turns++,
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
      identity: { operatorId: "auto-fixture-owner", steerSourceLane: "tui" },
    }),
    authenticateCaptain: createBearerAuthenticator(CAPTAIN_TOKEN, {
      captainId: "auto-fixture-captain",
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
    root,
    path,
    captain,
    credentials,
    ownerToken: owner.token,
    tokens,
    host,
    turns: () => turns,
    state: () => readFile(path, "utf8"),
    expireDevices: () => {
      now += 61_000;
    },
    command: (command: OperatorAutonomyCommand, token = CAPTAIN_TOKEN) =>
      post({ op: "autonomy", schemaVersion: 1, conversationId: CONVERSATION, command }, token),
    revoke: (deviceId: string) =>
      fetch(new URL(`/v1/devices/${deviceId}/revoke`, host), {
        method: "POST",
        headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
        body: "{}",
      }),
    async close() {
      app.close();
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await captain.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

it("refuses captain and direct no-authority Auto on without changing the switch", async () => {
  const f = await fixture();
  try {
    const before = await f.state();
    const response = await f.command(AUTO_ON);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "goal_owner_required" });
    await expect(
      f.captain.serveOperatorConversation({
        op: "autonomy",
        schemaVersion: 1,
        conversationId: CONVERSATION,
        command: AUTO_ON,
      }),
    ).rejects.toThrow("goal_owner_required");
    expect(await f.state()).toBe(before);
    // Turning Auto off stays open to the captain: it only stops unprompted work.
    expect((await f.command({ action: "set_enabled", enabled: false })).status).toBe(200);
    const status = await f.command({ action: "status" });
    expect(status.status).toBe(200);
    expect(OperatorConversationServiceResultSchema.parse(await status.json())).toMatchObject({
      op: "autonomy",
      status: { enabled: false },
    });
    expect(f.turns()).toBe(0);
  } finally {
    await f.close();
  }
});

it("uses the production console and owner-only CLI to turn Auto on through the real app and captain", async () => {
  const f = await fixture();
  const client = createCaptainOperatorConversationClient(
    createCaptainRouteClient({ host: f.host, captainToken: CAPTAIN_TOKEN }),
    createCaptainRouteClient({ host: f.host, captainToken: f.ownerToken }),
  );
  try {
    const command = (value: OperatorAutonomyCommand) => client.autonomy(CONVERSATION, value);
    // No project is on Auto, so the switch proves owner authority without starting a model loop.
    expect(await command(AUTO_ON)).toMatchObject({ enabled: true });
    expect(JSON.parse(await f.state()).enabled).toBe(true);
    expect(await command({ action: "set_enabled", enabled: false })).toMatchObject({ enabled: false });
    expect(await command({ action: "status" })).toMatchObject({ enabled: false });
    expect(f.turns()).toBe(0);

    // A separate store exercises the CLI's own owner credential resolution
    // without supplying any captain token or credential store.
    const cli = await fixture();
    try {
      const auto = async (args: string[]) => {
        let output = "";
        expect(
          await runConversationsCommand(["auto", ...args], {
            env: {},
            host: cli.host,
            operatorCredentialStore: cli.credentials,
            stdout: { write: (text: string) => (output += text) },
          }),
        ).toBe(0);
        return output;
      };
      await auto(["on"]);
      expect(JSON.parse(await cli.state()).enabled).toBe(true);
      expect((await cli.command({ action: "set_enabled", enabled: false })).status).toBe(200);
      expect(JSON.parse(await cli.state()).enabled).toBe(false);
      expect(cli.turns()).toBe(0);
    } finally {
      await cli.close();
    }
  } finally {
    await f.close();
  }
});

it("accepts an active terminalControl device and rejects insufficient, revoked and expired devices", async () => {
  const f = await fixture();
  try {
    expect((await f.revoke("revoked")).status).toBe(200);
    const before = await f.state();
    for (const token of [f.tokens.read!, f.tokens.revoked!]) {
      expect((await f.command(AUTO_ON, token)).status).toBe(401);
      expect(await f.state()).toBe(before);
    }
    const accepted = await f.command(AUTO_ON, f.tokens.control!);
    expect(accepted.status).toBe(200);
    expect(OperatorConversationServiceResultSchema.parse(await accepted.json())).toMatchObject({
      op: "autonomy",
      status: { enabled: true },
    });
    expect((await f.command({ action: "set_enabled", enabled: false })).status).toBe(200);
    const off = await f.state();
    f.expireDevices();
    expect((await f.command(AUTO_ON, f.tokens.control!)).status).toBe(401);
    expect(await f.state()).toBe(off);
    expect(f.turns()).toBe(0);
  } finally {
    await f.close();
  }
});
