import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  FileCredentialStore,
  ensureOperatorCredential,
  rotateOperatorCredential,
} from "@clankie/credential-broker";
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
const CAPTAIN_TOKEN = "goal-authority-captain-fixture";
const activatingCommands: OperatorAutonomyCommand[] = [
  { action: "set_goal", objective: "Only the owner activates this work" },
  { action: "accept_goal" },
  { action: "set_goal_status", status: "active" },
  { action: "set_enabled", enabled: true },
];

/** Real captain, owner credential broker, signed device authentication, HTTP and disk.
 * Autonomy starts disabled and no provider, external body or live account is used. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-goal-owner-authority-"));
  const path = join(root, "autonomy.json");
  const seeded = new AutonomyStore(path);
  seeded.command(CONVERSATION, { action: "set_enabled", enabled: false });
  seeded.proposeGoal(CONVERSATION, "Verify owner confirmation at the authenticated boundary", 1_000);
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
      correlationId: "goal-authority-fixture",
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
  let fleetBarrier: { entered: () => void; wait: Promise<void> } | undefined;
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      onTurnSettled: () => turns++,
      runtimes: {
        list: async () => [],
        onChange: () => () => undefined,
        configuredBinding: async () => {
          const pending = fleetBarrier;
          fleetBarrier = undefined;
          if (pending !== undefined) {
            pending.entered();
            await pending.wait;
          }
          return undefined;
        },
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
      identity: { operatorId: "goal-fixture-owner", steerSourceLane: "tui" },
    }),
    authenticateCaptain: createBearerAuthenticator(CAPTAIN_TOKEN, {
      captainId: "goal-fixture-captain",
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
    holdNextFleetRefresh() {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      fleetBarrier = { entered, wait };
      return { started, release };
    },
    async close() {
      app.close();
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await captain.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

it("refuses captain and direct no-authority activation without changing durable goals", async () => {
  const f = await fixture();
  try {
    const before = await f.state();
    for (const command of activatingCommands) {
      const response = await f.command(command);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "goal_owner_required" });
      await expect(
        f.captain.serveOperatorConversation({
          op: "autonomy",
          schemaVersion: 1,
          conversationId: CONVERSATION,
          command,
        }),
      ).rejects.toThrow("goal_owner_required");
      expect(await f.state()).toBe(before);
    }
    const status = await f.command({ action: "status" });
    expect(status.status).toBe(200);
    expect(OperatorConversationServiceResultSchema.parse(await status.json())).toMatchObject({
      op: "autonomy",
      status: { enabled: false, goal: { status: "proposed", tokensUsed: 0 } },
    });
    expect(f.turns()).toBe(0);
  } finally {
    await f.close();
  }
});

it("uses the production console and owner-only CLI to activate goals through the real app and captain", async () => {
  const f = await fixture();
  const client = createCaptainOperatorConversationClient(
    createCaptainRouteClient({ host: f.host, captainToken: CAPTAIN_TOKEN }),
    createCaptainRouteClient({ host: f.host, captainToken: f.ownerToken }),
  );
  try {
    const command = (value: OperatorAutonomyCommand) => client.autonomy(CONVERSATION, value);
    expect(await command({ action: "accept_goal" })).toMatchObject({
      goal: { status: "active" },
      enabled: false,
    });
    expect(await command({ action: "set_goal_status", status: "paused" })).toMatchObject({
      goal: { status: "paused" },
    });
    expect(await command({ action: "set_goal_status", status: "active" })).toMatchObject({
      goal: { status: "active" },
    });
    await command({ action: "clear_goal" });
    expect(
      await command({ action: "set_goal", objective: "Owner-requested fixture goal", tokenBudget: 222 }),
    ).toMatchObject({
      goal: { objective: "Owner-requested fixture goal", status: "active", tokenBudget: 222 },
    });
    await command({ action: "clear_goal" });
    // Enabling with no goal proves owner authority without starting a model loop.
    expect(await command({ action: "set_enabled", enabled: true })).toMatchObject({ enabled: true });
    expect(await command({ action: "set_enabled", enabled: false })).toMatchObject({ enabled: false });
    expect(await command({ action: "status" })).toMatchObject({ enabled: false });
    const durable = JSON.parse(await f.state());
    expect(durable.enabled).toBe(false);
    expect(durable.conversations[CONVERSATION]?.goal).toBeUndefined();
    expect(f.turns()).toBe(0);

    // A separate durable proposal exercises the CLI's own owner credential
    // resolution without supplying any captain token or credential store.
    const cli = await fixture();
    try {
      const cliCommand = async (args: string[]) => {
        let output = "";
        expect(
          await runConversationsCommand(["goal", CONVERSATION, ...args], {
            env: {},
            host: cli.host,
            operatorCredentialStore: cli.credentials,
            stdout: { write: (text: string) => (output += text) },
          }),
        ).toBe(0);
        return JSON.parse(output);
      };
      expect(await cliCommand(["accept"])).toMatchObject({
        enabled: false,
        goal: { status: "active", tokensUsed: 0 },
      });
      expect((await cli.command({ action: "set_goal_status", status: "paused" })).status).toBe(200);
      expect(await cliCommand(["resume"])).toMatchObject({ goal: { status: "active" } });
      expect((await cli.command({ action: "clear_goal" })).status).toBe(200);
      expect(
        await cliCommand(["set", "--tokens", "321", "Verify", "the", "CLI", "owner", "path"]),
      ).toMatchObject({
        enabled: false,
        goal: { objective: "Verify the CLI owner path", status: "active", tokenBudget: 321, tokensUsed: 0 },
      });
      expect(JSON.parse(await cli.state()).conversations[CONVERSATION].goal).toMatchObject({
        objective: "Verify the CLI owner path",
        status: "active",
        tokenBudget: 321,
      });
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
      for (const command of activatingCommands) {
        expect((await f.command(command, token)).status).toBe(401);
        expect(await f.state()).toBe(before);
      }
    }
    const accepted = await f.command({ action: "accept_goal" }, f.tokens.control!);
    expect(accepted.status).toBe(200);
    expect(OperatorConversationServiceResultSchema.parse(await accepted.json())).toMatchObject({
      op: "autonomy",
      status: { enabled: false, goal: { status: "active", tokensUsed: 0 } },
    });
    expect((await f.command({ action: "set_goal_status", status: "paused" })).status).toBe(200);
    const paused = await f.state();
    f.expireDevices();
    for (const command of activatingCommands) {
      expect((await f.command(command, f.tokens.control!)).status).toBe(401);
      expect(await f.state()).toBe(paused);
    }
    expect(f.turns()).toBe(0);
  } finally {
    await f.close();
  }
});

it("revalidates the exact owner credential after awaited fleet refresh before activating", async () => {
  const f = await fixture();
  const gate = f.holdNextFleetRefresh();
  try {
    const before = await f.state();
    const request = f.command({ action: "accept_goal" }, f.ownerToken);
    await gate.started;
    const replacement = await rotateOperatorCredential({ env: {}, store: f.credentials });
    gate.release();
    const response = await request;
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "goal_owner_required" });
    expect(await f.state()).toBe(before);
    expect((await f.command({ action: "accept_goal" }, replacement.token)).status).toBe(200);
    expect(f.turns()).toBe(0);
  } finally {
    gate.release();
    await f.close();
  }
});
