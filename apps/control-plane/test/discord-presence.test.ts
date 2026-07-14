import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile, loadDoctrineLayerFile } from "@clankie/doctrine";
import { FileCredentialStore } from "../../../packages/credential-broker/src/index.ts";
import { SqliteEventStore } from "@clankie/event-store";
import type { DiscordPresenceSessionRecord } from "@clankie/interactive-environment";
import type { DiscordPresenceWrite, DiscordPresenceWriteResult } from "@clankie/protocol";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDiscordPresenceRuntime } from "../../discord-bridge/src/presence-runtime-module.ts";
import {
  createControlPlane,
  type ControlPlaneDependencies,
  type TrustedOperatorIdentity,
} from "../src/app.ts";
import type { DiscordPresenceRuntimePort } from "../src/discord-presence-runtime.ts";

let doctrine: Awaited<ReturnType<typeof compileDoctrine>>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
});

describe("Discord presence control-plane runtime (ADR 0024)", () => {
  it("returns 403 without executing when the profile denies Discord presence", async () => {
    const runtime = new RecordingPresenceRuntime();
    const highAssurance = compileDoctrine([
      await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/structured.yaml")),
      await loadDoctrineLayerFile(
        resolve(import.meta.dirname, "../../../doctrine/profiles/high-assurance-overlay.yaml"),
      ),
    ]);
    const app = await createPresenceControlPlane({
      doctrine: highAssurance,
      discordPresenceRuntime: runtime,
    });
    const deniedWrite = presenceWrite({
      idempotencyKey: "presence-profile-deny",
      action: "discord.presence.reply",
      payload: { kind: "reply", channelId: "c1", messageId: "m1", content: "denied" },
    });
    const response = await post(app, "/v1/discord/presence-actions", {
      ...deniedWrite,
      identity: { ...deniedWrite.identity, profileHash: highAssurance.profileHash },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ decision: { effect: "deny" } });
    expect(runtime.writes).toHaveLength(0);
  });

  it("allows bot narrative actions through the retained narrative policy and executor", async () => {
    const runtime = new RecordingPresenceRuntime();
    const app = await createPresenceControlPlane({
      doctrine,
      discordPresenceRuntime: runtime,
      clock: () => new Date("2026-07-11T22:00:00.000Z"),
    });

    const write = presenceWrite({
      idempotencyKey: "presence-reply-1",
      action: "discord.presence.reply",
      content: "hello friends",
      payload: {
        kind: "reply",
        channelId: "channel-1",
        messageId: "message-1",
        content: "hello friends",
      },
    });

    const response = await post(app, "/v1/discord/presence-actions", write);
    expect(response.status).toBe(200);
    const body = (await response.json()) as DiscordPresenceWriteResult;
    expect(body).toMatchObject({
      id: "presence-reply-1",
      action: "discord.presence.reply",
      transportKind: "bot",
      channelId: "channel-1",
    });
    expect(runtime.writes).toHaveLength(1);
  });

  it("rejects a live loss fence even while the durable projection remains present", async () => {
    const runtime = new RecordingPresenceRuntime();
    const app = await createPresenceControlPlane({ doctrine, discordPresenceRuntime: runtime });
    const response = await app.request("/v1/discord/presence-actions", {
      method: "POST",
      headers: {
        authorization: "Bearer captain-secret",
        "content-type": "application/json",
        "x-clankie-discord-presence-phase": "degraded",
      },
      body: JSON.stringify(
        presenceWrite({
          idempotencyKey: "presence-live-loss-window",
          action: "discord.presence.send_message",
          payload: { kind: "send_message", channelId: "c1", content: "must not execute" },
        }),
      ),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "discord_presence_action_unavailable",
      phase: "degraded",
      source: "live_session",
    });
    expect(runtime.writes).toHaveLength(0);
  });

  it("does not trust an unauthenticated live phase fence", async () => {
    const runtime = new RecordingPresenceRuntime();
    const app = await createPresenceControlPlane({ doctrine, discordPresenceRuntime: runtime });
    const response = await app.request("/v1/discord/presence-actions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clankie-discord-presence-phase": "present",
      },
      body: JSON.stringify(
        presenceWrite({
          idempotencyKey: "presence-untrusted-live-phase",
          action: "discord.presence.send_message",
          payload: { kind: "send_message", channelId: "c1", content: "must not execute" },
        }),
      ),
    });

    expect(response.status).toBe(401);
    expect(runtime.writes).toHaveLength(0);
  });

  it("allows ambient narrative replies under presence-session attribution without a mission", async () => {
    const runtime = new RecordingPresenceRuntime();
    const app = await createPresenceControlPlane({ doctrine, discordPresenceRuntime: runtime });
    const write = presenceWrite({
      idempotencyKey: "presence-ambient-reply",
      action: "discord.presence.reply",
      payload: {
        kind: "reply",
        channelId: "dm-1",
        messageId: "message-1",
        content: "Hello from the presence lane.",
      },
    });

    const response = await post(app, "/v1/discord/presence-actions", {
      ...write,
      identity: {
        ...write.identity,
        missionId: undefined,
        presenceSessionId: "discord:dm:dm-1",
      },
    });

    expect(response.status).toBe(200);
    expect(runtime.writes[0]?.identity).toMatchObject({ presenceSessionId: "discord:dm:dm-1" });
    expect(runtime.writes[0]?.identity.missionId).toBeUndefined();
  });

  it("deduplicates by idempotency key and conflicts on payload drift", async () => {
    const runtime = new RecordingPresenceRuntime();
    const app = await createPresenceControlPlane({
      doctrine,
      discordPresenceRuntime: runtime,
      clock: () => new Date("2026-07-11T22:00:00.000Z"),
    });
    const write = presenceWrite({
      idempotencyKey: "presence-dup-1",
      action: "discord.presence.react",
      // content optional — ledger derives from emoji
      payload: { kind: "react", channelId: "c1", messageId: "m1", emoji: "👍" },
    });

    expect((await post(app, "/v1/discord/presence-actions", write)).status).toBe(200);
    expect((await post(app, "/v1/discord/presence-actions", write)).status).toBe(200);
    expect(
      (
        await post(app, "/v1/discord/presence-actions", {
          ...write,
          payload: { kind: "react", channelId: "c1", messageId: "m1", emoji: "👎" },
        })
      ).status,
    ).toBe(409);
    expect(runtime.writes).toHaveLength(1);
  });

  it("accepts contentless typing and derives ledger content", async () => {
    const runtime = new RecordingPresenceRuntime();
    const app = await createPresenceControlPlane({
      doctrine,
      discordPresenceRuntime: runtime,
      clock: () => new Date("2026-07-11T22:00:00.000Z"),
    });
    const response = await post(
      app,
      "/v1/discord/presence-actions",
      presenceWrite({
        idempotencyKey: "presence-typing-1",
        action: "discord.presence.typing_start",
        payload: { kind: "typing_start", channelId: "c1" },
      }),
    );
    expect(response.status).toBe(200);
    expect(runtime.writes).toHaveLength(1);
  });

  it("enforces the mission narrative rate ledger", async () => {
    const runtime = new RecordingPresenceRuntime();
    const app = await createPresenceControlPlane({
      doctrine,
      discordPresenceRuntime: runtime,
      clock: () => new Date("2026-07-11T22:00:00.000Z"),
    });

    for (let index = 0; index < 20; index += 1) {
      const response = await post(
        app,
        "/v1/discord/presence-actions",
        presenceWrite({
          idempotencyKey: `presence-rate-${index}`,
          action: "discord.presence.send_message",
          content: `msg-${index}`,
          payload: { kind: "send_message", channelId: "c1", content: `msg-${index}` },
        }),
      );
      expect(response.status).toBe(200);
    }
    const denied = await post(
      app,
      "/v1/discord/presence-actions",
      presenceWrite({
        idempotencyKey: "presence-rate-overflow",
        action: "discord.presence.send_message",
        content: "overflow",
        payload: { kind: "send_message", channelId: "c1", content: "overflow" },
      }),
    );
    expect(denied.status).toBe(403);
    expect(runtime.writes).toHaveLength(20);
  });

  it("mints an attachment approval and resumes exactly once with the same idempotency key", async () => {
    const runtime = new RecordingPresenceRuntime();
    const root = await mkdtemp(join(tmpdir(), "clankie-presence-approval-"));
    const store = new SqliteEventStore(join(root, "events.db"));
    const app = await createPresenceControlPlane({
      doctrine,
      eventStore: store,
      discordPresenceRuntime: runtime,
      authenticateOperator: operator,
      clock: () => new Date("2026-07-11T22:00:00.000Z"),
    });
    const write = presenceWrite({
      idempotencyKey: "presence-attach-1",
      action: "discord.presence.send_attachment",
      payload: {
        kind: "send_attachment",
        channelId: "c1",
        artifactRef: "artifact:shot-1",
        filename: "screenshot.png",
      },
    });
    const response = await post(app, "/v1/discord/presence-actions", write);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      error: "discord_presence_approval_required",
      approval: {
        id: "presence-attach-1",
        status: "pending",
        artifactRef: "artifact:shot-1",
        fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
    expect(runtime.writes).toHaveLength(0);
    const approvals = await app.request("/v1/approvals?status=pending", {
      headers: { authorization: "Bearer operator-secret" },
    });
    await expect(approvals.json()).resolves.toMatchObject([
      { id: "presence-attach-1", resource: { type: "discord-attachment", id: "artifact:shot-1" } },
    ]);
    await decide(app, "presence-attach-1", "approve", "Share this screenshot.");
    expect((await post(app, "/v1/discord/presence-actions", write)).status).toBe(200);
    expect((await post(app, "/v1/discord/presence-actions", write)).status).toBe(200);
    expect(runtime.writes).toHaveLength(1);
    expect(runtime.writes[0]?.idempotencyKey).toBe("presence-attach-1");
    const serializedEvents = JSON.stringify((await store.readAll()).map(({ event }) => event));
    expect(serializedEvents).not.toContain("screenshot.png");
    expect(serializedEvents).not.toContain("image-bytes");
    expect(serializedEvents).toContain("artifact:shot-1");
    expect(serializedEvents).toMatch(/sha256:[0-9a-f]{64}/);
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps denied and expired attachment retries terminal and idempotent", async () => {
    let now = new Date("2026-07-11T22:00:00.000Z");
    const runtime = new RecordingPresenceRuntime();
    const app = await createPresenceControlPlane({
      doctrine,
      discordPresenceRuntime: runtime,
      authenticateOperator: operator,
      approvalRequestTtlMs: 1_000,
      clock: () => now,
    });
    const denied = attachmentWrite("presence-attach-denied");
    expect((await post(app, "/v1/discord/presence-actions", denied)).status).toBe(202);
    await decide(app, denied.idempotencyKey, "deny", "Do not share.");
    for (let index = 0; index < 2; index += 1) {
      const response = await post(app, "/v1/discord/presence-actions", denied);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: "discord_presence_approval_denied" });
    }

    const expired = attachmentWrite("presence-attach-expired");
    expect((await post(app, "/v1/discord/presence-actions", expired)).status).toBe(202);
    now = new Date("2026-07-11T22:00:02.000Z");
    for (let index = 0; index < 2; index += 1) {
      const response = await post(app, "/v1/discord/presence-actions", expired);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: "discord_presence_approval_expired" });
    }
    for (let index = 0; index < 2; index += 1) {
      const approval = await decide(app, expired.idempotencyKey, "approve", "Too late.");
      expect(approval.status).toBe(409);
      await expect(approval.json()).resolves.toMatchObject({
        error: "approval_already_expired",
        approval: { id: expired.idempotencyKey, status: "denied", reason: "approval_expired" },
      });
    }
    expect(runtime.writes).toHaveLength(0);
  });

  it("resumes through the broker-backed production runtime and hash-bound resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-presence-production-"));
    const credentialPath = join(root, "credentials.json");
    const artifactRoot = join(root, "artifacts");
    await new FileCredentialStore(credentialPath).set("discord_bot", {
      type: "api",
      key: "broker-only-token",
    });
    await mkdir(artifactRoot, { mode: 0o700 });
    const bytes = Buffer.from("production-image-bytes");
    await writeFile(join(artifactRoot, "shot.png"), bytes, { mode: 0o600 });
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const previousEnv = { ...process.env };
    const store = new SqliteEventStore(join(root, "events.db"));
    try {
      delete process.env.DISCORD_BOT_TOKEN;
      delete process.env.DISCORD_USER_TOKEN;
      process.env.CLANKIE_CREDENTIALS_FILE = credentialPath;
      process.env.CLANKIE_DISCORD_ATTACHMENT_ROOT = artifactRoot;
      process.env.DISCORD_PRESENCE_CHANNEL_IDS = "channel-allowed";
      const postDiscord = vi.fn(async (_route: string, _request?: unknown) => ({ id: "discord-message-1" }));
      const runtime = createDiscordPresenceRuntime({
        rest: { post: postDiscord, put: vi.fn(), delete: vi.fn(), patch: vi.fn() } as never,
      });
      const app = await createPresenceControlPlane({
        doctrine,
        eventStore: store,
        discordPresenceRuntime: runtime,
        authenticateOperator: operator,
      });
      const write = presenceWrite({
        idempotencyKey: "presence-production-attachment",
        action: "discord.presence.send_attachment",
        payload: {
          kind: "send_attachment",
          channelId: "channel-allowed",
          artifactRef: `sha256:${digest}:shot.png`,
          filename: "shot.png",
        },
      });
      expect((await post(app, "/v1/discord/presence-actions", write)).status).toBe(202);
      expect((await decide(app, write.idempotencyKey, "approve", "Approved on TUI.")).status).toBe(200);
      expect((await post(app, "/v1/discord/presence-actions", write)).status).toBe(200);
      expect((await post(app, "/v1/discord/presence-actions", write)).status).toBe(200);
      expect(postDiscord).toHaveBeenCalledOnce();
      const request = postDiscord.mock.calls[0]?.[1] as { files?: Array<{ data?: Buffer }> };
      expect(request.files?.[0]?.data).toEqual(bytes);
      const retained = JSON.stringify((await store.readAll()).map(({ event }) => event));
      expect(retained).toContain(`sha256:${digest}:shot.png`);
      expect(retained).not.toContain(bytes.toString());
    } finally {
      process.env = previousEnv;
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects subsequent actions and retains a semantic degraded event after disconnect", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-presence-disconnect-"));
    const store = new SqliteEventStore(join(root, "events.db"));
    const runtime = new RecordingPresenceRuntime();
    const app = await createPresenceControlPlane({
      doctrine,
      eventStore: store,
      discordPresenceRuntime: runtime,
    });
    expect(
      (
        await post(
          app,
          "/v1/discord/presence-actions",
          presenceWrite({
            idempotencyKey: "presence-before-disconnect",
            action: "discord.presence.send_message",
            payload: { kind: "send_message", channelId: "c1", content: "before" },
          }),
        )
      ).status,
    ).toBe(200);
    const phaseResponse = await recordPhase(app, "degraded", 3, "gateway_disconnected", "present");
    expect(phaseResponse.status).toBe(200);
    const unavailable = await post(
      app,
      "/v1/discord/presence-actions",
      presenceWrite({
        idempotencyKey: "presence-after-disconnect",
        action: "discord.presence.send_message",
        payload: { kind: "send_message", channelId: "c1", content: "after" },
      }),
    );
    expect(unavailable.status).toBe(409);
    await expect(unavailable.json()).resolves.toEqual({
      error: "discord_presence_action_unavailable",
      phase: "degraded",
    });
    expect(runtime.writes).toHaveLength(1);
    expect((await store.readAll()).map(({ event }) => event.type)).toContain(
      "discord.presence.session.phase_changed",
    );
    const restoredRuntime = new RecordingPresenceRuntime();
    const restoredApp = await createControlPlane({
      doctrine,
      eventStore: store,
      discordPresenceRuntime: restoredRuntime,
      authenticateCaptain: presenceCaptain,
    });
    const afterRestart = await post(
      restoredApp,
      "/v1/discord/presence-actions",
      presenceWrite({
        idempotencyKey: "presence-after-restart",
        action: "discord.presence.send_message",
        payload: { kind: "send_message", channelId: "c1", content: "still unavailable" },
      }),
    );
    expect(afterRestart.status).toBe(409);
    expect(restoredRuntime.writes).toHaveLength(0);
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("rebases a forward revision gap and remains unavailable without a process restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-presence-gap-rebase-"));
    const store = new SqliteEventStore(join(root, "events.db"));
    const runtime = new RecordingPresenceRuntime();
    const app = await createPresenceControlPlane({
      doctrine,
      eventStore: store,
      discordPresenceRuntime: runtime,
    });
    const gap = await recordPhase(app, "degraded", 8, "gateway_disconnected", "present");
    expect(gap.status).toBe(200);
    await expect(gap.json()).resolves.toMatchObject({
      accepted: true,
      session: { phase: "degraded", revision: 3 },
    });
    const resumed = await recordPhase(app, "present", 4, "gateway_ready", "degraded");
    expect(resumed.status).toBe(200);
    const disconnected = await recordPhase(app, "degraded", 5, "gateway_disconnected", "present");
    expect(disconnected.status).toBe(200);

    const unavailable = await post(
      app,
      "/v1/discord/presence-actions",
      presenceWrite({
        idempotencyKey: "presence-after-gap-rebase",
        action: "discord.presence.send_message",
        payload: { kind: "send_message", channelId: "c1", content: "after gap" },
      }),
    );
    expect(unavailable.status).toBe(409);
    expect(runtime.writes).toHaveLength(0);

    const restartedRuntime = new RecordingPresenceRuntime();
    const restarted = await createControlPlane({
      doctrine,
      eventStore: store,
      discordPresenceRuntime: restartedRuntime,
      authenticateCaptain: presenceCaptain,
    });
    const afterReplay = await post(
      restarted,
      "/v1/discord/presence-actions",
      presenceWrite({
        idempotencyKey: "presence-after-gap-replay",
        action: "discord.presence.send_message",
        payload: { kind: "send_message", channelId: "c1", content: "after replay" },
      }),
    );
    expect(afterReplay.status).toBe(409);
    expect(restartedRuntime.writes).toHaveLength(0);
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("returns 503 when the presence runtime is not configured", async () => {
    const app = await createControlPlane({ doctrine });
    const response = await post(
      app,
      "/v1/discord/presence-actions",
      presenceWrite({
        idempotencyKey: "presence-unconfigured",
        action: "discord.presence.typing_start",
        content: "typing",
        payload: { kind: "typing_start", channelId: "c1" },
      }),
    );
    expect(response.status).toBe(503);
  });
});

class RecordingPresenceRuntime implements DiscordPresenceRuntimePort {
  public readonly writes: DiscordPresenceWrite[] = [];
  public readonly sessions: DiscordPresenceSessionRecord[] = [];

  public async execute(
    write: DiscordPresenceWrite,
    session: DiscordPresenceSessionRecord,
  ): Promise<DiscordPresenceWriteResult> {
    this.writes.push(write);
    this.sessions.push(session);
    return {
      id: write.idempotencyKey,
      action: write.action,
      transportKind: "bot",
      channelId: "channelId" in write.payload ? write.payload.channelId : undefined,
      messageId: "messageId" in write.payload ? write.payload.messageId : undefined,
    };
  }
}

async function createPresenceControlPlane(dependencies: ControlPlaneDependencies) {
  const app = await createControlPlane({
    ...dependencies,
    authenticateCaptain: presenceCaptain,
  });
  for (const transition of [
    ["connecting", 1, "process_start", "off"],
    ["present", 2, "gateway_ready", "connecting"],
  ] as const) {
    const response = await recordPhase(app, transition[0], transition[1], transition[2], transition[3]);
    if (response.status !== 200) {
      throw new Error(`presence fixture failed: ${response.status.toString()} ${await response.text()}`);
    }
  }
  return app;
}

function presenceCaptain(request: Request) {
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer captain-secret"
      ? { captainId: "discord-bridge", steerSourceLane: "discord_text" as const }
      : undefined,
  );
}

function recordPhase(
  app: Awaited<ReturnType<typeof createControlPlane>>,
  phase: "connecting" | "present" | "degraded",
  revision: number,
  reason: "process_start" | "gateway_ready" | "gateway_disconnected",
  previousPhase: "off" | "connecting" | "present" | "degraded",
) {
  return app.request("/v1/discord/presence-session-events", {
    method: "POST",
    headers: { authorization: "Bearer captain-secret", "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      plane: "semantic",
      id: `presence-phase-${revision.toString()}`,
      type: "discord.presence.session.phase_changed",
      occurredAt: `2026-07-14T18:00:0${revision.toString()}.000Z`,
      correlationId: "discord:bot:fixture",
      sessionId: "discord:bot:fixture",
      data: {
        previousPhase,
        phase,
        reason,
        session: {
          schemaVersion: 1,
          sessionId: "discord:bot:fixture",
          characterId: "clankie",
          credentialRef: "broker:discord_bot:lab",
          transportKind: "bot",
          phase,
          gatewayConnected: phase === "present",
          voiceGuildIds: [],
          revision,
          updatedAt: `2026-07-14T18:00:0${revision.toString()}.000Z`,
        },
      },
    }),
  });
}

function presenceWrite(
  partial: Pick<DiscordPresenceWrite, "idempotencyKey" | "action" | "payload"> &
    Partial<Pick<DiscordPresenceWrite, "content">>,
): DiscordPresenceWrite {
  return {
    schemaVersion: 1,
    ...partial,
    identity: {
      missionId: "mission-discord-presence",
      correlationId: `corr-${partial.idempotencyKey}`,
      profileHash: doctrine.profileHash,
      characterId: "clankie",
      credentialRef: "broker:discord_bot:lab",
      transportKind: "bot",
    },
  };
}

async function post(app: Awaited<ReturnType<typeof createControlPlane>>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: {
      authorization: "Bearer captain-secret",
      "content-type": "application/json",
      "x-clankie-discord-presence-phase": "present",
    },
    body: JSON.stringify(body),
  });
}

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer operator-secret"
      ? { operatorId: "operator-james" }
      : undefined,
  );
}

async function decide(
  app: Awaited<ReturnType<typeof createControlPlane>>,
  id: string,
  decision: "approve" | "deny",
  reason: string,
) {
  return app.request(`/v1/approvals/${id}/decision`, {
    method: "POST",
    headers: { authorization: "Bearer operator-secret", "content-type": "application/json" },
    body: JSON.stringify({ decision, reason }),
  });
}

function attachmentWrite(idempotencyKey: string): DiscordPresenceWrite {
  return presenceWrite({
    idempotencyKey,
    action: "discord.presence.send_attachment",
    payload: {
      kind: "send_attachment",
      channelId: "c1",
      artifactRef: `artifact:${idempotencyKey}`,
      filename: "fixture.png",
    },
  });
}
