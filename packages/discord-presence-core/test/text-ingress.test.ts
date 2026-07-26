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

  it("passes the bridge's voice presence note through into the turn trigger unchanged", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, config(), () => {});

    await ingress.handle({
      id: "message-noted",
      guildId: "guild-1",
      channelId: "channel-1",
      authorId: "friend",
      authorIsBot: false,
      mentionsBot: true,
      body: "clankie hop in vc",
      voicePresenceNote: { action: "joined", channelId: "voice-9" },
      loadContextMessages: () => Promise.resolve([]),
    });
    await ingress.handle({
      id: "message-plain",
      guildId: "guild-1",
      channelId: "channel-1",
      authorId: "friend",
      authorIsBot: false,
      mentionsBot: true,
      body: "hello again",
      loadContextMessages: () => Promise.resolve([]),
    });

    expect(port.turns[0]?.trigger.voicePresenceNote).toEqual({ action: "joined", channelId: "voice-9" });
    expect(port.turns[1]?.trigger.voicePresenceNote).toBeUndefined();
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
    if (this.silent && request.trigger.unprompted === true) {
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

describe("reading live, then checking in", () => {
  function room(overrides: Partial<DiscordTextIngressConfig> = {}): DiscordTextIngressConfig {
    return { ...config(), replyPolicy: "addressed", characterNames: ["clankie"], ...overrides };
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

  it("keeps answering follow-ups that do not repeat his name", async () => {
    const ingress = new DiscordTextIngress(new RecordingPort(), room(), () => undefined);

    await expect(ingress.handle(say("m1", "clankie how did the run go?"))).resolves.toMatchObject({
      state: "settled",
    });
    await expect(ingress.handle(say("m2", "did it pass?"))).resolves.toMatchObject({ state: "settled" });
  });

  it("stops reading live once the conversation has moved on without him", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, room({ liveMessageWindow: 2 }), () => undefined);
    await ingress.handle(say("m1", "clankie how did the run go?"));

    // Answering resets the window, so drifting off requires him to actually
    // stop answering — which is exactly what declining is.
    port.silent = true;
    await expect(ingress.handle(say("m2", "one"))).resolves.toMatchObject({ state: "declined" });
    await expect(ingress.handle(say("m3", "two"))).resolves.toMatchObject({ state: "declined" });
    await expect(ingress.handle(say("m4", "three"))).resolves.toEqual({ state: "buffered" });
  });

  it("does nothing at all when no channel has anything waiting", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, room(), () => undefined);
    await ingress.handle(say("m1", "clankie how did the run go?"));
    const turnsAfterReply = port.turns.length;

    // An idle server must not bill for silence: a person does not open an empty
    // channel on a timer.
    await expect(ingress.catchUp()).resolves.toEqual([]);
    expect(port.turns).toHaveLength(turnsAfterReply);
  });

  it("reads the whole backlog in one turn when he checks in", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, room({ liveMessageWindow: 0 }), () => undefined);
    await ingress.handle(say("m1", "clankie how did the run go?"));
    const turnsAfterReply = port.turns.length;

    await ingress.handle(say("m2", "one"));
    await ingress.handle(say("m3", "two"));
    await ingress.handle(say("m4", "three"));

    const outcomes = await ingress.catchUp();
    expect(outcomes).toHaveLength(1);
    // One turn for the channel, not one per message.
    expect(port.turns).toHaveLength(turnsAfterReply + 1);
    const caught = port.turns.at(-1);
    expect(caught?.trigger.id).toBe("m4");
    expect(caught?.trigger.unprompted).toBe(true);
    expect(caught?.contextMessages.map((message) => message.id)).toEqual(
      expect.arrayContaining(["m2", "m3"]),
    );
  });

  it("clears the backlog even when he decides to say nothing", async () => {
    const port = new RecordingPort();
    port.silent = true;
    const ingress = new DiscordTextIngress(port, room({ liveMessageWindow: 0 }), () => undefined);
    await ingress.handle(say("m1", "clankie how did the run go?"));
    port.silent = true;
    await ingress.handle(say("m2", "never mind"));

    await expect(ingress.catchUp()).resolves.toMatchObject([{ state: "declined" }]);
    // He looked. Deciding there was nothing to say must not queue it up again.
    await expect(ingress.catchUp()).resolves.toEqual([]);
  });

  it("never checks a channel he has not spoken in", async () => {
    const ingress = new DiscordTextIngress(new RecordingPort(), room(), () => undefined);

    await expect(ingress.handle(say("m1", "morning all"))).resolves.toEqual({
      state: "dropped",
      reason: "not_addressed",
    });
    await expect(ingress.catchUp()).resolves.toEqual([]);
  });

  it("keeps the backlog to the recent room rather than an archive", async () => {
    const ingress = new DiscordTextIngress(
      new RecordingPort(),
      room({ liveMessageWindow: 0, maxPendingPerChannel: 3 }),
      () => undefined,
    );
    await ingress.handle(say("m1", "clankie how did the run go?"));
    for (const index of [2, 3, 4, 5, 6])
      await ingress.handle(say(`m${String(index)}`, `line ${String(index)}`));

    const [outcome] = await ingress.catchUp();
    expect(outcome).toMatchObject({ state: "settled" });
  });

  it("still answers a direct mention in a channel he had drifted from", async () => {
    const ingress = new DiscordTextIngress(
      new RecordingPort(),
      room({ liveMessageWindow: 0 }),
      () => undefined,
    );
    await ingress.handle(say("m1", "clankie how did the run go?"));

    await expect(ingress.handle(say("m2", "clankie you there?"))).resolves.toMatchObject({
      state: "settled",
    });
  });
});
