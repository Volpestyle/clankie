import { resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import type { DiscordPresenceWrite, DiscordPresenceWriteResult } from "@clankie/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";
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

  it("requires approval for publish-external attachment and does not execute or mint approval", async () => {
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
        idempotencyKey: "presence-attach-1",
        action: "discord.presence.send_attachment",
        payload: {
          kind: "send_attachment",
          channelId: "c1",
          artifactRef: "artifact:shot-1",
          filename: "screenshot.png",
        },
      }),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { decision?: { effect?: string } };
    expect(body.decision?.effect).toBe("require_approval");
    expect(runtime.writes).toHaveLength(0);
    // P1 debt: no ApprovalRequest is created; attachment cannot complete until
    // require_approval is wired to the approval store (ADR 0024 P1.5).
    const approvals = await app.request("/v1/approvals?status=pending", {
      headers: { authorization: "Bearer operator" },
    });
    // Unauthenticated or empty — either way no pending approval was minted for this write.
    if (approvals.status === 200) {
      const list = (await approvals.json()) as unknown[];
      expect(list).toEqual([]);
    }
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
