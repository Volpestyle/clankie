import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile, loadDoctrineLayerFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import type { DiscordPresenceSessionRecord } from "@clankie/interactive-environment";
import type {
  DiscordPresenceWrite,
  DiscordPresenceWriteResult,
  DiscordTransportKind,
} from "@clankie/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createControlPlane,
  type ControlPlaneDependencies,
  type TrustedCaptainIdentity,
  type TrustedOperatorIdentity,
} from "../src/app.ts";
import type { DiscordPresenceRuntimePort } from "../src/discord-presence-runtime.ts";

let doctrine: Awaited<ReturnType<typeof compileDoctrine>>;
let highAssurance: Awaited<ReturnType<typeof compileDoctrine>>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
  highAssurance = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/structured.yaml")),
    await loadDoctrineLayerFile(
      resolve(import.meta.dirname, "../../../doctrine/profiles/high-assurance-overlay.yaml"),
    ),
  ]);
});

describe("Discord user-session transport (ADR 0048)", () => {
  it("records, reads back, and revokes an operator opt-in", async () => {
    await withRoot(async (root) => {
      const app = await plane({ doctrine, root });

      await expect(readOptIn(app)).resolves.toEqual({ schemaVersion: 1, optIn: null });

      const recorded = await recordOptIn(app);
      expect(recorded.status).toBe(201);
      const body = (await recorded.json()) as { optIn: { optInId: string; profileHash: string } };
      expect(body.optIn).toMatchObject({
        characterId: "clankie",
        credentialRef: "discord_user_session",
        profileHash: doctrine.profileHash,
        guildIds: ["guild-1"],
        channelIds: ["channel-1"],
        dmPolicy: "owner_only",
      });

      const live = (await readOptIn(app)) as { optIn: Record<string, unknown> };
      expect(live.optIn.optInId).toBe(body.optIn.optInId);
      expect(live.optIn).not.toHaveProperty("revokedAt");

      const revoked = await app.request("/v1/discord/user-session/opt-in", {
        method: "DELETE",
        headers: { authorization: "Bearer operator-secret" },
      });
      expect(revoked.status).toBe(200);
      await expect(readOptIn(app)).resolves.toMatchObject({
        optIn: { optInId: body.optIn.optInId, revokedAt: expect.any(String) },
      });

      // A second revoke has nothing live to revoke and must not invent one.
      const again = await app.request("/v1/discord/user-session/opt-in", {
        method: "DELETE",
        headers: { authorization: "Bearer operator-secret" },
      });
      expect(again.status).toBe(409);
    });
  });

  it("requires operator authority to record an opt-in", async () => {
    await withRoot(async (root) => {
      const app = await plane({ doctrine, root });
      const asCaptain = await app.request("/v1/discord/user-session/opt-in", {
        method: "POST",
        headers: { authorization: "Bearer user-captain-secret", "content-type": "application/json" },
        body: JSON.stringify(optInRequest()),
      });
      expect(asCaptain.status).toBe(401);
      await expect(readOptIn(app)).resolves.toEqual({ schemaVersion: 1, optIn: null });
    });
  });

  it("refuses the opt-in outright under a profile that denies the transport", async () => {
    await withRoot(async (root) => {
      // The high-assurance denial has to bite here, not action-by-action later:
      // if the record cannot exist, the plane can never start at all.
      const app = await plane({ doctrine: highAssurance, root });
      const response = await recordOptIn(app);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: "discord_user_session_denied_by_doctrine",
        decision: { effect: "deny" },
      });
      await expect(readOptIn(app)).resolves.toEqual({ schemaVersion: 1, optIn: null });
    });
  });

  it("executes a user-session write on the user runtime once the owner opted in", async () => {
    await withRoot(async (root) => {
      const botRuntime = new RecordingRuntime("bot");
      const userRuntime = new RecordingRuntime("user_session");
      const app = await plane({ doctrine, root, botRuntime, userRuntime });
      await startUserSession(app);
      expect((await recordOptIn(app)).status).toBe(201);

      const response = await postWrite(app, "user_session");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ transportKind: "user_session" });
      expect(userRuntime.writes).toHaveLength(1);
      // The planes must not leak into each other's executor.
      expect(botRuntime.writes).toHaveLength(0);
    });
  });

  it("refuses a user-session write with no opt-in, and again after revocation", async () => {
    await withRoot(async (root) => {
      const userRuntime = new RecordingRuntime("user_session");
      const app = await plane({ doctrine, root, userRuntime });
      await startUserSession(app);

      const before = await postWrite(app, "user_session", "write-before-opt-in");
      expect(before.status).toBe(403);
      await expect(before.json()).resolves.toMatchObject({ error: "discord_user_session_opt_in_required" });

      expect((await recordOptIn(app)).status).toBe(201);
      expect((await postWrite(app, "user_session", "write-during")).status).toBe(200);

      await app.request("/v1/discord/user-session/opt-in", {
        method: "DELETE",
        headers: { authorization: "Bearer operator-secret" },
      });
      const after = await postWrite(app, "user_session", "write-after-revoke");
      expect(after.status).toBe(403);
      expect(userRuntime.writes).toHaveLength(1);
    });
  });

  it("binds transport to the authenticated bearer, not the request body", async () => {
    await withRoot(async (root) => {
      const botRuntime = new RecordingRuntime("bot");
      const userRuntime = new RecordingRuntime("user_session");
      const app = await plane({ doctrine, root, botRuntime, userRuntime });
      await startUserSession(app);
      expect((await recordOptIn(app)).status).toBe(201);

      // Bot bearer claiming the user session: the capability a user token would
      // unlock (Go Live) must not be reachable by relabelling a request.
      const spoofed = await app.request("/v1/discord/presence-actions", {
        method: "POST",
        headers: {
          ...liveClaimHeaders(),
          authorization: "Bearer bot-captain-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(write("user_session", "spoofed-by-bot")),
      });
      expect(spoofed.status).toBe(403);
      await expect(spoofed.json()).resolves.toMatchObject({
        error: "discord_presence_transport_not_authenticated",
      });

      // …and the reverse: the user bearer cannot act as the official bot.
      const inverted = await app.request("/v1/discord/presence-actions", {
        method: "POST",
        headers: {
          ...liveClaimHeaders(),
          authorization: "Bearer user-captain-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(write("bot", "spoofed-by-user")),
      });
      expect(inverted.status).toBe(403);
      expect(botRuntime.writes).toHaveLength(0);
      expect(userRuntime.writes).toHaveLength(0);
    });
  });

  it("fails closed when no user-session runtime is configured", async () => {
    await withRoot(async (root) => {
      const app = await plane({ doctrine, root, userRuntime: undefined });
      await startUserSession(app);
      expect((await recordOptIn(app)).status).toBe(201);
      const response = await postWrite(app, "user_session");
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: "discord_presence_runtime_unavailable",
      });
    });
  });

  it("replays a recorded opt-in across a control-plane restart", async () => {
    await withRoot(async (root) => {
      const path = join(root, "events.db");
      const first = await plane({ doctrine, root, eventStorePath: path });
      const recorded = await recordOptIn(first);
      const body = (await recorded.json()) as { optIn: { optInId: string } };

      const restarted = await plane({ doctrine, root, eventStorePath: path });
      await expect(readOptIn(restarted)).resolves.toMatchObject({
        optIn: { optInId: body.optIn.optInId },
      });
    });
  });
});

class RecordingRuntime implements DiscordPresenceRuntimePort {
  public readonly writes: DiscordPresenceWrite[] = [];
  private readonly transportKind: DiscordTransportKind;

  public constructor(transportKind: DiscordTransportKind) {
    this.transportKind = transportKind;
  }

  public execute(
    write: DiscordPresenceWrite,
    _session: DiscordPresenceSessionRecord,
  ): Promise<DiscordPresenceWriteResult> {
    this.writes.push(write);
    return Promise.resolve({
      id: write.idempotencyKey,
      action: write.action,
      transportKind: this.transportKind,
      ...("channelId" in write.payload ? { channelId: write.payload.channelId } : {}),
    });
  }
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "clankie-discord-user-session-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function plane(options: {
  doctrine: Awaited<ReturnType<typeof compileDoctrine>>;
  root: string;
  botRuntime?: DiscordPresenceRuntimePort;
  userRuntime?: DiscordPresenceRuntimePort | undefined;
  eventStorePath?: string;
}) {
  const dependencies: ControlPlaneDependencies = {
    doctrine: options.doctrine,
    eventStore: new SqliteEventStore(options.eventStorePath ?? join(options.root, "events.db")),
    captainChannelTurns: { submit: () => Promise.reject(new Error("not invoked")) },
    discordPresenceRuntime: options.botRuntime ?? new RecordingRuntime("bot"),
    ...("userRuntime" in options
      ? options.userRuntime === undefined
        ? {}
        : { discordUserPresenceRuntime: options.userRuntime }
      : { discordUserPresenceRuntime: new RecordingRuntime("user_session") }),
    authenticateCaptain: captain,
    authenticateOperator: operator,
  };
  return createControlPlane(dependencies);
}

function captain(request: Request): Promise<TrustedCaptainIdentity | undefined> {
  const header = request.headers.get("authorization");
  if (header === "Bearer bot-captain-secret") {
    return Promise.resolve({
      captainId: "discord-bridge",
      steerSourceLane: "discord_text" as const,
      discordTransportKind: "bot" as const,
    });
  }
  if (header === "Bearer user-captain-secret") {
    return Promise.resolve({
      captainId: "discord-user-bridge",
      steerSourceLane: "discord_text" as const,
      discordTransportKind: "user_session" as const,
    });
  }
  return Promise.resolve(undefined);
}

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer operator-secret"
      ? { operatorId: "operator-james" }
      : undefined,
  );
}

function optInRequest() {
  return {
    schemaVersion: 1,
    characterId: "clankie",
    acknowledgement: "I accept Discord ToS and account risk for the personal lab.",
    guildIds: ["guild-1"],
    channelIds: ["channel-1"],
    dmPolicy: "owner_only",
  };
}

function recordOptIn(app: Awaited<ReturnType<typeof createControlPlane>>) {
  return app.request("/v1/discord/user-session/opt-in", {
    method: "POST",
    headers: { authorization: "Bearer operator-secret", "content-type": "application/json" },
    body: JSON.stringify(optInRequest()),
  });
}

async function readOptIn(app: Awaited<ReturnType<typeof createControlPlane>>) {
  const response = await app.request("/v1/discord/user-session/opt-in", {
    headers: { authorization: "Bearer user-captain-secret" },
  });
  expect(response.status).toBe(200);
  return response.json();
}

/** Drives the user-session presence record to `present` so act tools exist. */
async function startUserSession(app: Awaited<ReturnType<typeof createControlPlane>>): Promise<void> {
  for (const [phase, revision, reason, previousPhase] of [
    ["connecting", 1, "process_start", "off"],
    ["present", 2, "gateway_ready", "connecting"],
  ] as const) {
    const response = await app.request("/v1/discord/presence-session-events", {
      method: "POST",
      headers: { authorization: "Bearer user-captain-secret", "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        plane: "semantic",
        id: `user-presence-phase-${String(revision)}`,
        type: "discord.presence.session.phase_changed",
        occurredAt: `2026-07-25T18:00:0${String(revision)}.000Z`,
        correlationId: SESSION_ID,
        sessionId: SESSION_ID,
        data: {
          previousPhase,
          phase,
          reason,
          session: {
            schemaVersion: 1,
            sessionId: SESSION_ID,
            characterId: "clankie",
            credentialRef: "discord_user_session",
            transportKind: "user_session",
            phase,
            gatewayConnected: phase === "present",
            voiceGuildIds: [],
            revision,
            updatedAt: `2026-07-25T18:00:0${String(revision)}.000Z`,
          },
        },
      }),
    });
    if (response.status !== 200) {
      throw new Error(`user-session fixture failed: ${String(response.status)} ${await response.text()}`);
    }
  }
}

const SESSION_ID = "discord:user_session:fixture";

function write(transportKind: DiscordTransportKind, idempotencyKey = "user-write-1"): DiscordPresenceWrite {
  return {
    schemaVersion: 1,
    idempotencyKey,
    action: "discord.presence.reply",
    identity: {
      correlationId: `corr-${idempotencyKey}`,
      presenceSessionId: "discord:guild-1:channel-1",
      profileHash: doctrine.profileHash,
      characterId: "clankie",
      credentialRef: transportKind === "bot" ? "broker:discord_bot:lab" : "discord_user_session",
      transportKind,
    },
    content: "hello from the lab",
    payload: { kind: "reply", channelId: "channel-1", messageId: "message-1", content: "hello from the lab" },
  };
}

function liveClaimHeaders(): Record<string, string> {
  return {
    "x-clankie-discord-presence-phase": "present",
    "x-clankie-discord-presence-revision": "2",
    "x-clankie-discord-presence-session": SESSION_ID,
  };
}

function postWrite(
  app: Awaited<ReturnType<typeof createControlPlane>>,
  transportKind: DiscordTransportKind,
  idempotencyKey = "user-write-1",
) {
  return app.request("/v1/discord/presence-actions", {
    method: "POST",
    headers: {
      ...liveClaimHeaders(),
      authorization: "Bearer user-captain-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify(write(transportKind, idempotencyKey)),
  });
}
