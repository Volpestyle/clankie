import type {
  CaptainChannelTurnResult,
  DiscordPresenceChannelTurnRequest,
  DiscordPresenceWrite,
  DiscordPresenceWriteResult,
} from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  DiscordTextIngress,
  type DiscordTextIngressConfig,
  type DiscordTextIngressEvidence,
  type DiscordTextIngressPort,
} from "../src/text-ingress.ts";

describe("DiscordTextIngress", () => {
  it("turns an owner DM into a bounded Eve turn and policy-gated reply", async () => {
    const port = new RecordingPort();
    const evidence: DiscordTextIngressEvidence[] = [];
    const ingress = new DiscordTextIngress(port, config(), (event) => evidence.push(event));

    await expect(
      ingress.handle({
        id: "message-1",
        channelId: "dm-1",
        authorId: "james",
        authorIsBot: false,
        mentionsBot: false,
        body: "secret user text",
        contextMessages: [
          { id: "c1", authorId: "james", body: "old", createdAt: "2026-07-12T19:00:00.000Z" },
          { id: "c2", authorId: "friend", body: "recent", createdAt: "2026-07-12T19:01:00.000Z" },
          { id: "c3", authorId: "james", body: "latest", createdAt: "2026-07-12T19:02:00.000Z" },
        ],
      }),
    ).resolves.toEqual({ state: "settled", turnId: "turn-message-1", responseMessageId: "reply-1" });

    expect(port.turns).toHaveLength(1);
    expect(port.turns[0]).toMatchObject({
      identity: {
        presenceSessionId: "discord:dm:dm-1",
        correlationId: "discord-message:message-1",
        profileHash: "profile-1",
      },
      trigger: { kind: "dm", actorId: "james", body: "secret user text" },
      contextMessages: [
        { id: "c2", body: "recent" },
        { id: "c3", body: "latest" },
      ],
    });
    expect(port.writes[0]).toMatchObject({
      action: "discord.presence.reply",
      identity: { presenceSessionId: "discord:dm:dm-1" },
      payload: { kind: "reply", channelId: "dm-1", messageId: "message-1" },
    });
    expect(port.writes[0]?.identity.missionId).toBeUndefined();
    expect(JSON.stringify(evidence)).not.toContain("secret user text");
    expect(evidence.map((event) => event.outcome)).toEqual(["accepted", "settled"]);
  });

  it("drops self loops and non-allowlisted guild or DM traffic before a model turn", async () => {
    const port = new RecordingPort();
    const evidence: DiscordTextIngressEvidence[] = [];
    const ingress = new DiscordTextIngress(port, config(), (event) => evidence.push(event));
    let contextLoads = 0;

    const outcomes = await Promise.all([
      ingress.handle({
        id: "bot",
        channelId: "dm-1",
        authorId: "clankie",
        authorIsBot: true,
        mentionsBot: false,
        body: "loop",
      }),
      ingress.handle({
        id: "stranger-dm",
        channelId: "dm-2",
        authorId: "stranger",
        authorIsBot: false,
        mentionsBot: false,
        body: "hello",
      }),
      ingress.handle({
        id: "wrong-channel",
        guildId: "guild-1",
        channelId: "channel-2",
        authorId: "friend",
        authorIsBot: false,
        mentionsBot: true,
        body: "@Clankie hello",
        loadContextMessages: () => {
          contextLoads += 1;
          return Promise.resolve([]);
        },
      }),
    ]);

    expect(outcomes).toEqual([
      { state: "dropped", reason: "self_or_bot_message" },
      { state: "dropped", reason: "dm_not_owner" },
      { state: "dropped", reason: "channel_not_allowlisted" },
    ]);
    expect(port.turns).toHaveLength(0);
    expect(contextLoads).toBe(0);
    expect(evidence.every((event) => event.outcome === "dropped")).toBe(true);
  });

  it("deduplicates retries and rejects delivery-id drift without retaining message bodies", async () => {
    const port = new RecordingPort();
    const evidence: DiscordTextIngressEvidence[] = [];
    const ingress = new DiscordTextIngress(port, config(), (event) => evidence.push(event));
    const message = {
      id: "message-dedupe",
      guildId: "guild-1",
      channelId: "channel-1",
      authorId: "friend",
      authorIsBot: false,
      mentionsBot: true,
      body: "first body",
    } as const;

    const [first, duplicate] = await Promise.all([ingress.handle(message), ingress.handle(message)]);
    const conflict = await ingress.handle({ ...message, body: "drifted body" });

    expect(first).toEqual(duplicate);
    expect(conflict).toEqual({ state: "dropped", reason: "delivery_id_conflict" });
    expect(port.turns).toHaveLength(1);
    expect(port.writes).toHaveLength(1);
    expect(evidence.map((event) => event.outcome)).toContain("deduplicated");
    expect(JSON.stringify(evidence)).not.toContain("first body");
    expect(JSON.stringify(evidence)).not.toContain("drifted body");
  });

  it("admits interleaved Discord turns without serializing unrelated captain work", async () => {
    const pending = new Map<string, (result: CaptainChannelTurnResult) => void>();
    const port = new RecordingPort(
      (request) =>
        new Promise((resolve) => {
          pending.set(request.deliveryId, resolve);
        }),
    );
    const ingress = new DiscordTextIngress(port, config());

    const first = ingress.handle(guildMessage("message-a"));
    const second = ingress.handle(guildMessage("message-b"));
    await Promise.resolve();
    await Promise.resolve();

    expect(port.turns.map((turn) => turn.deliveryId)).toEqual(["message-a", "message-b"]);
    pending.get("message-b")?.(settled("message-b"));
    await expect(second).resolves.toMatchObject({ state: "settled", turnId: "turn-message-b" });
    pending.get("message-a")?.(settled("message-a"));
    await expect(first).resolves.toMatchObject({ state: "settled", turnId: "turn-message-a" });
  });
});

class RecordingPort implements DiscordTextIngressPort {
  public readonly turns: DiscordPresenceChannelTurnRequest[] = [];
  public readonly writes: DiscordPresenceWrite[] = [];
  private readonly turn: (request: DiscordPresenceChannelTurnRequest) => Promise<CaptainChannelTurnResult>;

  public constructor(
    turn: (request: DiscordPresenceChannelTurnRequest) => Promise<CaptainChannelTurnResult> = (request) =>
      Promise.resolve(settled(request.deliveryId)),
  ) {
    this.turn = turn;
  }

  public getHealth(): Promise<{ profileHash: string }> {
    return Promise.resolve({ profileHash: "profile-1" });
  }

  public submitDiscordCaptainChannelTurn(
    request: DiscordPresenceChannelTurnRequest,
  ): Promise<CaptainChannelTurnResult> {
    this.turns.push(request);
    return this.turn(request);
  }

  public executeDiscordPresenceAction(write: DiscordPresenceWrite): Promise<DiscordPresenceWriteResult> {
    this.writes.push(write);
    return Promise.resolve({
      id: write.idempotencyKey,
      action: write.action,
      transportKind: "bot",
      channelId: "channelId" in write.payload ? write.payload.channelId : undefined,
      messageId: `reply-${String(this.writes.length)}`,
    });
  }
}

function config(): DiscordTextIngressConfig {
  return {
    characterId: "clankie",
    credentialRef: "discord_bot",
    guildIds: new Set(["guild-1"]),
    channelIds: new Set(["channel-1"]),
    dmPolicy: "owner_only",
    ownerUserId: "james",
    dmUserIds: new Set(),
    contextMessageLimit: 2,
    authenticatedSurfaceUrl: "http://127.0.0.1:4311/approvals",
  };
}

function guildMessage(id: string) {
  return {
    id,
    guildId: "guild-1",
    channelId: "channel-1",
    authorId: "friend",
    authorIsBot: false,
    mentionsBot: true,
    body: `hello ${id}`,
  } as const;
}

function settled(deliveryId: string): CaptainChannelTurnResult {
  return {
    state: "settled",
    captainSessionId: `session-${deliveryId}`,
    turnId: `turn-${deliveryId}`,
    response: `reply to ${deliveryId}`,
  };
}
