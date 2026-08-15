import type {
  CaptainChannelTurnResult,
  DiscordPresenceChannelTurnRequest,
  DiscordPresenceWrite,
  DiscordPresenceWriteResult,
} from "@clankie/protocol";
import {
  DISCORD_PRESENCE_ATTACHMENT_BYTES_MAX,
  DISCORD_PRESENCE_TRIGGER_ATTACHMENTS_MAX,
} from "@clankie/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  DiscordTextIngress,
  selectInboundImageAttachments,
  TYPING_REFRESH_MS,
  TYPING_MAX_DURATION_MS,
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
    expect(port.replies[0]).toMatchObject({
      action: "discord.presence.reply",
      identity: { presenceSessionId: "discord:dm:dm-1" },
      payload: { kind: "reply", channelId: "dm-1", messageId: "message-1" },
    });
    expect(port.replies[0]?.identity.missionId).toBeUndefined();
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
    expect(port.replies).toHaveLength(1);
    // The deduplicated retry and the refused conflict never re-signal typing.
    expect(port.typing).toHaveLength(1);
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
  /** When set, typing posts reject; the cosmetic indicator path is down. */
  public failTyping = false;
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
    if (write.payload.kind === "typing_start" && this.failTyping) {
      return Promise.reject(new Error("typing_unavailable"));
    }
    return Promise.resolve({
      id: write.idempotencyKey,
      action: write.action,
      transportKind: "bot",
      channelId: "channelId" in write.payload ? write.payload.channelId : undefined,
      // Only a posted message has an id; typing does not, matching the runtime.
      messageId: isReply(write) ? `reply-${String(this.replies.length)}` : undefined,
    });
  }

  public get replies(): DiscordPresenceWrite[] {
    return this.writes.filter(isReply);
  }

  public get typing(): DiscordPresenceWrite[] {
    return this.writes.filter((write) => write.payload.kind === "typing_start");
  }
}

/** A reply is one message whether or not it carries a picture (ADR 0085). */
function isReply(write: DiscordPresenceWrite): boolean {
  return write.payload.kind === "reply" || write.payload.kind === "reply_with_media";
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

describe("a picture he made on the turn (ADR 0085)", () => {
  const media = { artifactRef: `sha256:${"a".repeat(64)}:generated/made.png`, filename: "made.png" };

  it("carries it on the same reply rather than a second message", async () => {
    const port = new RecordingPort((request) => Promise.resolve({ ...settled(request.deliveryId), media }));
    const ingress = new DiscordTextIngress(port, config(), () => undefined);

    await expect(
      ingress.handle({
        id: "message-1",
        channelId: "dm-1",
        authorId: "james",
        authorIsBot: false,
        mentionsBot: false,
        body: "draw me a robot",
      }),
    ).resolves.toMatchObject({ state: "settled" });

    expect(port.replies).toHaveLength(1);
    expect(port.replies[0]).toMatchObject({
      action: "discord.presence.reply_with_media",
      payload: {
        kind: "reply_with_media",
        channelId: "dm-1",
        messageId: "message-1",
        content: "reply to message-1",
        artifactRef: media.artifactRef,
        filename: "made.png",
      },
    });
  });

  it("stays an ordinary reply when he made nothing", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, config(), () => undefined);

    await ingress.handle({
      id: "message-1",
      channelId: "dm-1",
      authorId: "james",
      authorIsBot: false,
      mentionsBot: false,
      body: "just talking",
    });

    expect(port.replies[0]).toMatchObject({ action: "discord.presence.reply", payload: { kind: "reply" } });
  });

  it("posts a screenshot the browser host minted", async () => {
    // Same provenance argument as a generated picture (ADR 0088): only the
    // runner's browser host writes `browser/`, so the ref cannot be forged.
    const artifactRef = `sha256:${"a".repeat(64)}:browser/${"a".repeat(64)}.png`;
    const port = new RecordingPort((request) =>
      Promise.resolve({
        ...settled(request.deliveryId),
        media: { artifactRef, filename: "screenshot-aaaaaaaa.png" },
      } as CaptainChannelTurnResult),
    );
    const ingress = new DiscordTextIngress(port, config(), () => undefined);

    await ingress.handle({
      id: "message-1",
      channelId: "dm-1",
      authorId: "james",
      authorIsBot: false,
      mentionsBot: false,
      body: "post that screenshot",
    });

    expect(port.replies[0]).toMatchObject({
      action: "discord.presence.reply_with_media",
      payload: { kind: "reply_with_media", artifactRef },
    });
  });

  it("refuses to post an artifact neither governed host minted", async () => {
    const port = new RecordingPort((request) =>
      Promise.resolve({
        ...settled(request.deliveryId),
        // Under the same attachment root, but written by neither the generator
        // nor the browser host: still `send_attachment`, still approval-gated.
        media: { artifactRef: `sha256:${"a".repeat(64)}:evidence/support-bundle.png`, filename: "x.png" },
      } as CaptainChannelTurnResult),
    );
    const ingress = new DiscordTextIngress(port, config(), () => undefined);

    await expect(
      ingress.handle({
        id: "message-1",
        channelId: "dm-1",
        authorId: "james",
        authorIsBot: false,
        mentionsBot: false,
        body: "post that file",
      }),
    ).resolves.toMatchObject({ state: "failed" });
    expect(port.replies).toHaveLength(0);
  });
});

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

  it("exposes engagement so ingress-boundary seams share the same notion of spoken to", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, room({ liveMessageWindow: 2 }), () => undefined);

    // A channel he has never spoken in is not one he is engaged with.
    expect(ingress.engagedInChannel("channel-1")).toBe(false);
    await ingress.handle(say("m1", "clankie how did the run go?"));
    expect(ingress.engagedInChannel("channel-1")).toBe(true);
    expect(ingress.engagedInChannel("channel-9")).toBe(false);

    // Staying quiet while the room moves on closes engagement, exactly as it
    // ends live reading — the two must never drift apart.
    port.silent = true;
    await ingress.handle(say("m2", "one"));
    await ingress.handle(say("m3", "two"));
    expect(ingress.engagedInChannel("channel-1")).toBe(false);
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

describe("typing while he composes", () => {
  it("shows him typing while an addressed turn is in flight and stops once it settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = new Map<string, (result: CaptainChannelTurnResult) => void>();
      const port = new RecordingPort(
        (request) =>
          new Promise((resolve) => {
            pending.set(request.deliveryId, resolve);
          }),
      );
      const ingress = new DiscordTextIngress(port, config());

      const outcome = ingress.handle(guildMessage("message-typing"));
      await vi.advanceTimersByTimeAsync(0);
      expect(port.typing).toHaveLength(1);
      expect(port.typing[0]).toMatchObject({
        action: "discord.presence.typing_start",
        idempotencyKey: "message-typing:typing:0",
        identity: {
          presenceSessionId: "discord:guild-1:channel-1",
          correlationId: "discord-message:message-typing",
        },
        payload: { kind: "typing_start", channelId: "channel-1" },
      });

      // Discord's indicator outlives one post by ~10s; a longer turn re-posts.
      await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);
      expect(port.typing).toHaveLength(2);

      pending.get("message-typing")?.(settled("message-typing"));
      await expect(outcome).resolves.toMatchObject({ state: "settled" });
      await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 4);
      expect(port.typing).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows him typing on a live follow-up that never repeats his name", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, {
      ...config(),
      channelIds: new Set(),
      replyPolicy: "addressed",
      characterNames: ["clankie"],
    });
    await ingress.handle({
      ...guildMessage("message-asked"),
      channelId: "channel-live",
      mentionsBot: false,
      body: "clankie how did the run go?",
    });
    expect(port.typing).toHaveLength(1);

    // The back-and-forth is where the indicator matters most: he is composing
    // an answer to someone already waiting on one, and having to re-say his
    // name to see it is not how a conversation works.
    await ingress.handle({
      ...guildMessage("message-followup"),
      channelId: "channel-live",
      mentionsBot: false,
      body: "did it though?",
    });
    expect(port.typing).toHaveLength(2);
    expect(port.typing[1]).toMatchObject({
      idempotencyKey: "message-followup:typing:0",
      payload: { kind: "typing_start", channelId: "channel-live" },
    });
  });

  it("stays invisible while he catches up on a backlog nobody is waiting on", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, {
      ...config(),
      channelIds: new Set(),
      replyPolicy: "addressed",
      characterNames: ["clankie"],
      liveMessageWindow: 0,
    });
    await ingress.handle({
      ...guildMessage("message-asked"),
      channelId: "channel-live",
      mentionsBot: false,
      body: "clankie how did the run go?",
    });
    expect(port.typing).toHaveLength(1);

    await expect(
      ingress.handle({
        ...guildMessage("message-later"),
        channelId: "channel-live",
        mentionsBot: false,
        body: "any update?",
      }),
    ).resolves.toEqual({ state: "buffered" });

    // Checking in on a channel minutes later is him reading, not the room
    // waiting on him; a timer must never light the channel up.
    await expect(ingress.catchUp()).resolves.toMatchObject([{ state: "settled" }]);
    expect(port.typing).toHaveLength(1);
  });

  it("stops refreshing after a failed typing post without failing the turn", async () => {
    vi.useFakeTimers();
    try {
      const pending = new Map<string, (result: CaptainChannelTurnResult) => void>();
      const port = new RecordingPort(
        (request) =>
          new Promise((resolve) => {
            pending.set(request.deliveryId, resolve);
          }),
      );
      port.failTyping = true;
      const ingress = new DiscordTextIngress(port, config());

      const outcome = ingress.handle(guildMessage("message-typing-down"));
      await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 3);
      // The first failed post stops the refresh; the indicator is cosmetic.
      expect(port.typing).toHaveLength(1);

      pending.get("message-typing-down")?.(settled("message-typing-down"));
      await expect(outcome).resolves.toMatchObject({ state: "settled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops refreshing after the cosmetic deadline even when the captain never settles", async () => {
    vi.useFakeTimers();
    try {
      const port = new RecordingPort(() => new Promise<CaptainChannelTurnResult>(() => undefined));
      const ingress = new DiscordTextIngress(port, config());

      void ingress.handle(guildMessage("message-typing-wedged"));
      await vi.advanceTimersByTimeAsync(TYPING_MAX_DURATION_MS);
      const writesAtDeadline = port.typing.length;

      await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 4);
      expect(port.typing).toHaveLength(writesAtDeadline);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("images are part of what was said", () => {
  it("selects only images he can be shown, and counts what it leaves out", () => {
    const selection = selectInboundImageAttachments([
      { id: "a", url: "https://cdn.discordapp.com/a.png", contentType: "image/png", size: 1_024 },
      // Discord really does serve a charset parameter on image types.
      {
        id: "b",
        url: "https://cdn.discordapp.com/b.jpg",
        contentType: "image/jpeg; charset=binary",
        filename: "b.jpg",
        size: 2_048,
      },
      { id: "pdf", url: "https://cdn.discordapp.com/c.pdf", contentType: "application/pdf", size: 10 },
      {
        id: "huge",
        url: "https://cdn.discordapp.com/d.png",
        contentType: "image/png",
        size: DISCORD_PRESENCE_ATTACHMENT_BYTES_MAX + 1,
      },
      { id: "insecure", url: "http://cdn.discordapp.com/e.png", contentType: "image/png", size: 10 },
      { id: "typeless", url: "https://cdn.discordapp.com/f.png", size: 10 },
    ]);

    expect(selection.attachments).toEqual([
      { id: "a", url: "https://cdn.discordapp.com/a.png", mediaType: "image/png", byteSize: 1_024 },
      {
        id: "b",
        url: "https://cdn.discordapp.com/b.jpg",
        mediaType: "image/jpeg",
        filename: "b.jpg",
        byteSize: 2_048,
      },
    ]);
    expect(selection.omitted).toBe(4);
  });

  it("turns a Discord GIF-picker embed into a proxied image", () => {
    const selection = selectInboundImageAttachments([], [
      {
        type: "gifv",
        url: "https://klipy.com/gifs/greetings-PSr",
        thumbnailUrl: "https://static.klipy.com/greeting.webp",
        thumbnailProxyUrl: "https://images-ext-1.discordapp.net/external/greeting.webp",
      },
    ]);

    expect(selection.attachments).toEqual([
      {
        id: expect.stringMatching(/^embed-[0-9a-f]{24}$/u),
        url: "https://images-ext-1.discordapp.net/external/greeting.webp",
        mediaType: "image/webp",
      },
    ]);
    expect(selection.omitted).toBe(0);
  });

  it("carries only the newest visual from bounded context", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, config());
    const image = (id: string) => ({
      id,
      url: `https://cdn.discordapp.com/${id}.png`,
      mediaType: "image/png" as const,
      byteSize: 1_024,
    });

    await ingress.handle({
      id: "message-context-image",
      channelId: "dm-1",
      authorId: "james",
      authorIsBot: false,
      mentionsBot: false,
      body: "what screenshot is that?",
      contextMessages: [
        {
          id: "outside-bound",
          authorId: "james",
          body: "old",
          createdAt: "2026-07-12T19:00:00.000Z",
          attachments: [image("old")],
        },
        {
          id: "recent-text",
          authorId: "friend",
          body: "recent",
          createdAt: "2026-07-12T19:01:00.000Z",
        },
        {
          id: "latest-visual",
          authorId: "clankie",
          body: "here",
          createdAt: "2026-07-12T19:02:00.000Z",
          attachments: [image("shown"), image("bounded-away")],
        },
      ],
    });

    expect(port.turns[0]?.contextMessages.map((message) => message.id)).toEqual([
      "recent-text",
      "latest-visual",
    ]);
    expect(port.turns[0]?.contextVisual).toEqual({
      sourceMessageId: "latest-visual",
      attachment: image("shown"),
      attachmentsOmitted: 1,
    });
  });

  it("caps how many images one message may carry and counts the overflow", () => {
    const raw = Array.from({ length: DISCORD_PRESENCE_TRIGGER_ATTACHMENTS_MAX + 3 }, (_unused, index) => ({
      id: `image-${String(index)}`,
      url: `https://cdn.discordapp.com/${String(index)}.png`,
      contentType: "image/png",
      size: 512,
    }));

    const selection = selectInboundImageAttachments(raw);

    expect(selection.attachments).toHaveLength(DISCORD_PRESENCE_TRIGGER_ATTACHMENTS_MAX);
    expect(selection.omitted).toBe(3);
  });

  it("runs a turn for a caption-less image instead of dropping it as empty", async () => {
    const port = new RecordingPort();
    const evidence: DiscordTextIngressEvidence[] = [];
    const ingress = new DiscordTextIngress(port, config(), (event) => evidence.push(event));

    await expect(
      ingress.handle({
        id: "message-image",
        channelId: "dm-1",
        authorId: "james",
        authorIsBot: false,
        mentionsBot: false,
        body: "",
        attachments: [
          {
            id: "att-1",
            url: "https://cdn.discordapp.com/att-1.png",
            mediaType: "image/png",
            byteSize: 4_096,
          },
        ],
        attachmentsOmitted: 1,
      }),
    ).resolves.toMatchObject({ state: "settled" });

    expect(evidence.map((event) => event.outcome)).toEqual(["accepted", "settled"]);
    const trigger = port.turns[0]?.trigger;
    // No body at all rather than an empty one: they did not say nothing.
    expect(trigger?.body).toBeUndefined();
    expect(trigger?.attachments).toEqual([
      {
        id: "att-1",
        url: "https://cdn.discordapp.com/att-1.png",
        mediaType: "image/png",
        byteSize: 4_096,
      },
    ]);
    expect(trigger?.attachmentsOmitted).toBe(1);
    // No URL, filename, or byte count reaches the receipts.
    expect(JSON.stringify(evidence)).not.toContain("cdn.discordapp.com");
  });

  it("still drops a message carrying neither text nor an image he can see", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, config());

    await expect(
      ingress.handle({
        id: "message-nothing",
        channelId: "dm-1",
        authorId: "james",
        authorIsBot: false,
        mentionsBot: false,
        body: "   ",
        attachments: [],
        // A PDF was posted; the policy left it out, so there is nothing to see.
        attachmentsOmitted: 1,
      }),
    ).resolves.toEqual({ state: "dropped", reason: "empty_message" });
    expect(port.turns).toHaveLength(0);
  });

  it("treats a swapped image on the same message id as a new delivery, not a duplicate", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, config());
    const message = (attachmentId: string) => ({
      id: "message-edited",
      channelId: "dm-1",
      authorId: "james",
      authorIsBot: false,
      mentionsBot: false,
      body: "look",
      attachments: [
        {
          id: attachmentId,
          url: `https://cdn.discordapp.com/${attachmentId}.png`,
          mediaType: "image/png" as const,
          byteSize: 1_000,
        },
      ],
    });

    await expect(ingress.handle(message("att-first"))).resolves.toMatchObject({ state: "settled" });
    await expect(ingress.handle(message("att-second"))).resolves.toEqual({
      state: "dropped",
      reason: "delivery_id_conflict",
    });
  });

  it("keeps the images on a message that waits for a catch-up", async () => {
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, { ...config(), liveMessageWindow: 1 });
    const guild = { guildId: "guild-1", channelId: "channel-1" };
    const attachments = [
      {
        id: "att-buffered",
        url: "https://cdn.discordapp.com/att-buffered.png",
        mediaType: "image/png" as const,
        byteSize: 900,
      },
    ];

    // He speaks here first, so the channel is one he is in.
    await ingress.handle({
      id: "message-open",
      ...guild,
      authorId: "james",
      authorIsBot: false,
      mentionsBot: true,
      body: "clankie hi",
    });
    // He reads the next one and stays quiet, which does not refresh the
    // exchange — so by the third he has drifted off the channel.
    port.silent = true;
    await ingress.handle({
      id: "message-drift",
      ...guild,
      authorId: "friend",
      authorIsBot: false,
      mentionsBot: false,
      body: "chatter",
    });
    await expect(
      ingress.handle({
        id: "message-buffered-image",
        ...guild,
        authorId: "friend",
        authorIsBot: false,
        mentionsBot: false,
        body: "",
        attachments,
      }),
    ).resolves.toEqual({ state: "buffered" });

    const outcomes = await ingress.catchUp();

    expect(outcomes).toHaveLength(1);
    expect(port.turns.at(-1)?.trigger.attachments).toEqual(attachments);
  });
});
