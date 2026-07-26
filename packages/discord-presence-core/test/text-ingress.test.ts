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

  it("admits every channel in an allowlisted guild when no channel list is configured", async () => {
    const port = new RecordingPort();
    // `replyPolicy: "all"` isolates channel admission from the addressed gate.
    const ingress = new DiscordTextIngress(
      port,
      { ...config(), channelIds: new Set(), replyPolicy: "all" },
      () => {},
    );

    await expect(
      ingress.handle({
        id: "message-open",
        guildId: "guild-1",
        channelId: "some-channel-never-listed",
        authorId: "friend",
        authorIsBot: false,
        mentionsBot: false,
        body: "hey clankie",
        loadContextMessages: () => Promise.resolve([]),
      }),
    ).resolves.toMatchObject({ state: "settled" });
  });

  it("never lets an empty channel list widen ingress past the guild allowlist", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, { ...config(), channelIds: new Set() }, () => {});

    await expect(
      ingress.handle({
        id: "message-foreign",
        guildId: "guild-not-allowlisted",
        channelId: "any-channel",
        authorId: "friend",
        authorIsBot: false,
        mentionsBot: false,
        body: "hey clankie",
        loadContextMessages: () => Promise.resolve([]),
      }),
    ).resolves.toEqual({ state: "dropped", reason: "guild_not_allowlisted" });
    expect(port.turns).toHaveLength(0);
  });

  it("stays quiet in an admitted channel until it is actually addressed", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(
      port,
      { ...config(), channelIds: new Set(), replyPolicy: "addressed", characterNames: ["clankie"] },
      () => {},
    );

    await expect(
      ingress.handle({
        ...guildMessage("message-chatter"),
        channelId: "any-channel",
        body: "anyway that dinner looked incredible",
        mentionsBot: false,
      }),
    ).resolves.toEqual({ state: "dropped", reason: "not_addressed" });
    // The point of gating before the turn: staying quiet must be free.
    expect(port.turns).toHaveLength(0);

    await expect(
      ingress.handle({
        ...guildMessage("message-hey"),
        channelId: "any-channel",
        body: "hey clankie what do you think",
        mentionsBot: false,
      }),
    ).resolves.toMatchObject({ state: "settled" });
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
  /** When set, any turn the ingress allowed to decline comes back silent. */
  public silent = false;
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
    if (this.silent && request.trigger.mayDecline === true) {
      return Promise.resolve({
        state: "silent",
        captainSessionId: "session-1",
        turnId: `turn-${request.deliveryId}`,
      });
    }
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
    transportKind: "bot",
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

describe("conversation window", () => {
  function conversational(windowMs?: number): DiscordTextIngressConfig {
    return {
      ...config(),
      replyPolicy: "addressed",
      characterNames: ["clankie"],
      ...(windowMs === undefined ? {} : { conversationWindowMs: windowMs }),
    };
  }

  function say(id: string, body: string, authorId = "james") {
    return {
      id,
      guildId: "guild-1",
      channelId: "channel-1",
      authorId,
      authorIsBot: false,
      mentionsBot: false,
      body,
    };
  }

  it("keeps answering a follow-up that does not repeat his name", async () => {
    const ingress = new DiscordTextIngress(new RecordingPort(), conversational(), () => undefined);

    await expect(ingress.handle(say("m1", "clankie how did the run go?"))).resolves.toMatchObject({
      state: "settled",
    });
    // Nobody says a name every sentence once a conversation is running.
    await expect(ingress.handle(say("m2", "did it pass?"))).resolves.toMatchObject({ state: "settled" });
  });

  it("stays out of a conversation he was never part of", async () => {
    const ingress = new DiscordTextIngress(new RecordingPort(), conversational(), () => undefined);

    await expect(ingress.handle(say("m1", "did it pass?"))).resolves.toEqual({
      state: "dropped",
      reason: "not_addressed",
    });
  });

  it("gives the grace only to the person he answered", async () => {
    const ingress = new DiscordTextIngress(new RecordingPort(), conversational(), () => undefined);
    await ingress.handle(say("m1", "clankie how did the run go?"));

    // Two people in a channel: answering James must not pull him into whatever
    // someone else is saying.
    await expect(ingress.handle(say("m2", "did it pass?", "friend"))).resolves.toEqual({
      state: "dropped",
      reason: "not_addressed",
    });
  });

  it("shows him a late reply instead of dropping it, and lets him answer", async () => {
    // Someone goes quiet for an hour and then answers your question. No cutoff
    // can tell that from noise, so he is shown it and decides.
    let now = 1_000;
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(
      port,
      { ...conversational(60_000), conversationRecallMs: 6 * 60 * 60 * 1_000 },
      () => undefined,
      () => now,
    );
    await ingress.handle(say("m1", "clankie how did the run go?"));

    now += 60 * 60 * 1_000;
    await expect(ingress.handle(say("m2", "sorry — was in a meeting. did it pass?"))).resolves.toMatchObject(
      { state: "settled" },
    );
    expect(port.turns.at(-1)?.trigger.mayDecline).toBe(true);
  });

  it("does not mark a message that actually addressed him as declinable", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, conversational(), () => undefined);

    await ingress.handle(say("m1", "clankie how did the run go?"));
    expect(port.turns.at(-1)?.trigger.mayDecline).toBeUndefined();
  });

  it("writes nothing when he reads a late message and chooses silence", async () => {
    let now = 1_000;
    const port = new RecordingPort();
    port.silent = true;
    const evidence: DiscordTextIngressEvidence[] = [];
    const ingress = new DiscordTextIngress(
      port,
      { ...conversational(60_000), conversationRecallMs: 6 * 60 * 60 * 1_000 },
      (event) => evidence.push(event),
      () => now,
    );
    await ingress.handle(say("m1", "clankie how did the run go?"));
    const writesAfterReply = port.writes.length;

    now += 60 * 60 * 1_000;
    await expect(ingress.handle(say("m2", "never mind, found it"))).resolves.toMatchObject({
      state: "declined",
    });
    expect(port.writes).toHaveLength(writesAfterReply);
    expect(evidence.at(-1)?.outcome).toBe("declined");
  });

  it("goes quiet for good once even the recall horizon passes", async () => {
    let now = 1_000;
    const ingress = new DiscordTextIngress(
      new RecordingPort(),
      { ...conversational(60_000), conversationRecallMs: 60 * 60 * 1_000 },
      () => undefined,
      () => now,
    );
    await ingress.handle(say("m1", "clankie how did the run go?"));

    now += 2 * 60 * 60 * 1_000;
    await expect(ingress.handle(say("m2", "did it pass?"))).resolves.toEqual({
      state: "dropped",
      reason: "not_addressed",
    });
  });

  it("extends the window on each reply, so a long exchange stays live", async () => {
    let now = 1_000;
    const ingress = new DiscordTextIngress(
      new RecordingPort(),
      conversational(60_000),
      () => undefined,
      () => now,
    );
    await ingress.handle(say("m1", "clankie how did the run go?"));

    now += 40_000;
    await expect(ingress.handle(say("m2", "did it pass?"))).resolves.toMatchObject({ state: "settled" });
    now += 40_000; // past the original expiry, inside the extended one
    await expect(ingress.handle(say("m3", "and the flaky one?"))).resolves.toMatchObject({
      state: "settled",
    });
  });

  it("can be switched off entirely", async () => {
    const ingress = new DiscordTextIngress(
      new RecordingPort(),
      { ...conversational(0), conversationRecallMs: 0 },
      () => undefined,
    );
    await ingress.handle(say("m1", "clankie how did the run go?"));

    await expect(ingress.handle(say("m2", "did it pass?"))).resolves.toEqual({
      state: "dropped",
      reason: "not_addressed",
    });
  });
});
