import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import type { DiscordPresenceWrite, DiscordPresenceWriteResult } from "@clankie/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane, type TrustedOperatorIdentity } from "../src/app.ts";
import type { DiscordPresenceRuntimePort } from "../src/discord-presence-runtime.ts";

let doctrine: Awaited<ReturnType<typeof compileDoctrine>>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
});

describe("Discord presence control-plane runtime (ADR 0024 P1)", () => {
  it("allows bot narrative actions through the retained narrative policy and executor", async () => {
    const runtime = new RecordingPresenceRuntime();
    const app = await createControlPlane({
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

  it("deduplicates by idempotency key and conflicts on payload drift", async () => {
    const runtime = new RecordingPresenceRuntime();
    const app = await createControlPlane({
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
    const app = await createControlPlane({
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
    const app = await createControlPlane({
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
    const app = await createControlPlane({
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
    const app = await createControlPlane({
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
    expect((await decide(app, expired.idempotencyKey, "approve", "Too late.")).status).toBe(200);
    expect(runtime.writes).toHaveLength(0);
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

  public async execute(write: DiscordPresenceWrite): Promise<DiscordPresenceWriteResult> {
    this.writes.push(write);
    return {
      id: write.idempotencyKey,
      action: write.action,
      transportKind: "bot",
      channelId: "channelId" in write.payload ? write.payload.channelId : undefined,
      messageId: "messageId" in write.payload ? write.payload.messageId : undefined,
    };
  }
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
    headers: { "content-type": "application/json" },
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
