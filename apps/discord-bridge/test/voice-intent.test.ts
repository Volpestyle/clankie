import { describe, expect, it } from "vitest";
import { DiscordTextIngress, type DiscordTextIngressPort } from "@clankie/discord-presence-core";
import type {
  CaptainChannelTurnResult,
  DiscordPresenceChannelTurnRequest,
  DiscordPresenceWrite,
  DiscordPresenceWriteResult,
} from "@clankie/protocol";
import {
  createVoicePresenceIntentDecider,
  executeVoicePresenceIntent,
  handleVoicePresenceAsk,
  voicePresenceGateOpen,
  VOICE_PRESENCE_INTENT_SYSTEM_PROMPT,
  VOICE_PRESENCE_TOKEN_PATTERN,
  type VoicePresenceAskOptions,
  type VoicePresenceExecutionConfig,
  type VoicePresenceGateConfig,
  type VoicePresenceMember,
  type VoicePresenceSessionPort,
} from "../src/voice-intent.ts";

const ADAPTER = (() => ({
  sendPayload: () => true,
  destroy: () => undefined,
})) as unknown as VoicePresenceMember["adapterCreator"];

class FakeVoiceSession implements VoicePresenceSessionPort {
  /** Raw join inputs, kept whole to prove no auto-opt-in ever flows through. */
  public readonly joinInputs: Record<string, unknown>[] = [];
  public leaves = 0;
  public failJoin = false;
  public state: { active: boolean; guildId?: string; channelId?: string } = { active: false };

  public status(): { active: boolean; guildId?: string; channelId?: string } {
    return this.state;
  }

  public join(input: {
    readonly guildId: string;
    readonly channelId: string;
    readonly adapterCreator: VoicePresenceMember["adapterCreator"];
  }): Promise<unknown> {
    if (this.failJoin) return Promise.reject(new Error("voice join failed"));
    this.joinInputs.push({ ...input });
    this.state = { active: true, guildId: input.guildId, channelId: input.channelId };
    return Promise.resolve(undefined);
  }

  public leave(): Promise<void> {
    this.leaves += 1;
    this.state = { active: false };
    return Promise.resolve();
  }
}

function gateConfig(overrides: Partial<VoicePresenceGateConfig> = {}): VoicePresenceGateConfig {
  return {
    ingressGuildIds: new Set(["guild-1"]),
    ingressChannelIds: new Set(),
    characterNames: ["clankie"],
    ...overrides,
  };
}

function executionConfig(
  voiceSession: VoicePresenceSessionPort | undefined,
  overrides: Partial<VoicePresenceExecutionConfig> = {},
): VoicePresenceExecutionConfig {
  return {
    bindings: {
      ambientRoleIds: new Set(["ambient-role"]),
      ambientUserIds: new Set(),
      approvalRoleIds: new Set(),
    },
    joinPolicy: "ambient",
    voiceGuildIds: new Set(["guild-1"]),
    voiceChannelIds: new Set(),
    voiceSession,
    ...overrides,
  };
}

function member(overrides: Partial<VoicePresenceMember> = {}): VoicePresenceMember {
  return {
    roleIds: new Set(["ambient-role"]),
    voiceChannelId: "voice-1",
    adapterCreator: ADAPTER,
    ...overrides,
  };
}

function inbound(overrides: Record<string, unknown> = {}) {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    authorId: "asker",
    authorIsBot: false,
    mentionsBot: false,
    body: "clankie hop in vc",
    ...overrides,
  };
}

function principal(roleIds: readonly string[] = ["ambient-role"]) {
  return { userId: "asker", roleIds: new Set(roleIds) };
}

describe("the mechanical gate", () => {
  const open = (input: Record<string, unknown>, config = gateConfig()) =>
    voicePresenceGateOpen(
      {
        guildId: "guild-1",
        channelId: "channel-1",
        authorIsBot: false,
        mentionsBot: false,
        body: "clankie hop in vc",
        authorVoiceChannelId: "voice-1",
        ...input,
      },
      config,
    );

  it("opens only for an addressed, admitted guild message from someone sitting in voice", () => {
    expect(open({})).toBe(true);
    // Addressing is the same test text ingress runs: mention or a name.
    expect(open({ body: "hop in vc please" })).toBe(false);
    expect(open({ body: "hop in vc please", mentionsBot: true })).toBe(true);
    // "clankiest" must not summon him — word-boundary matching is reused.
    expect(open({ body: "the clankiest vc ever" })).toBe(false);
  });

  it("stays closed for bot authors, DMs, and non-admitted guilds or channels", () => {
    expect(open({ authorIsBot: true })).toBe(false);
    expect(open({ guildId: undefined })).toBe(false);
    expect(open({ guildId: "guild-elsewhere" })).toBe(false);
    expect(open({}, gateConfig({ ingressChannelIds: new Set(["channel-9"]) }))).toBe(false);
    expect(open({ channelId: "channel-9" }, gateConfig({ ingressChannelIds: new Set(["channel-9"]) }))).toBe(
      true,
    );
  });

  it("stays closed when the author is not in a voice channel or the body has no voice token", () => {
    expect(open({ authorVoiceChannelId: undefined })).toBe(false);
    expect(open({ body: "clankie what's the weather" })).toBe(false);
    // The token list is deliberately loose; the decider does the real reading.
    for (const body of ["clankie hop in", "clankie join us", "clankie you can leave", "clankie dip"]) {
      expect(VOICE_PRESENCE_TOKEN_PATTERN.test(body)).toBe(true);
    }
  });

  it("a closed gate never runs the decider; an open gate runs it exactly once", async () => {
    let deciderCalls = 0;
    const options: VoicePresenceAskOptions = {
      gate: gateConfig(),
      decider: () => {
        deciderCalls += 1;
        return Promise.resolve("none");
      },
      execution: executionConfig(new FakeVoiceSession()),
    };

    await expect(
      handleVoicePresenceAsk(options, inbound({ body: "clankie what's up" }), () => member()),
    ).resolves.toBeUndefined();
    expect(deciderCalls).toBe(0);
    await expect(
      handleVoicePresenceAsk(options, inbound(), () => member({ voiceChannelId: undefined })),
    ).resolves.toBeUndefined();
    expect(deciderCalls).toBe(0);

    await expect(handleVoicePresenceAsk(options, inbound(), () => member())).resolves.toBeUndefined();
    expect(deciderCalls).toBe(1);
  });
});

describe("the intent decider", () => {
  const openAiAnswer = (content: unknown): Response =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const decider = (fetchImpl: typeof fetch) =>
    createVoicePresenceIntentDecider({ apiKey: "intent-key", model: "gpt-4o-mini", fetchImpl });

  it("sends the bounded body with temperature 0 and the brokered key", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const decide = decider(((url: URL | RequestInfo, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Promise.resolve(openAiAnswer("join"));
    }) as typeof fetch);
    await expect(decide("clankie hop in vc")).resolves.toBe("join");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(String(requests[0]?.init?.body)) as {
      model: string;
      temperature: number;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.temperature).toBe(0);
    expect(body.messages[0]?.content).toBe(VOICE_PRESENCE_INTENT_SYSTEM_PROMPT);
    expect(body.messages[1]?.content).toBe("clankie hop in vc");
    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer intent-key");
  });

  it("parses strictly: only a clear join or leave acts; everything else is none", async () => {
    await expect(decider(() => Promise.resolve(openAiAnswer("Join.")))("m")).resolves.toBe("join");
    await expect(decider(() => Promise.resolve(openAiAnswer("LEAVE")))("m")).resolves.toBe("leave");
    await expect(decider(() => Promise.resolve(openAiAnswer("none")))("m")).resolves.toBe("none");
    await expect(decider(() => Promise.resolve(openAiAnswer("maybe join")))("m")).resolves.toBe("none");
    await expect(decider(() => Promise.resolve(openAiAnswer("join the call")))("m")).resolves.toBe("none");
    await expect(decider(() => Promise.resolve(openAiAnswer(42)))("m")).resolves.toBe("none");
  });

  it("fails closed on transport errors, bad statuses, and garbage, without echoing the body", async () => {
    // The rejection deliberately carries the request text: nothing of it may
    // surface — the decider swallows the error rather than rethrowing it.
    await expect(
      decider(() => Promise.reject(new Error("boom: secret ask body")))("secret ask body"),
    ).resolves.toBe("none");
    await expect(decider(() => Promise.resolve(new Response("nope", { status: 500 })))("m")).resolves.toBe(
      "none",
    );
    await expect(
      decider(() => Promise.resolve(new Response("not json", { status: 200 })))("m"),
    ).resolves.toBe("none");
  });

  it("refuses a non-HTTPS non-loopback endpoint at construction", () => {
    expect(() =>
      createVoicePresenceIntentDecider({ apiKey: "k", model: "m", baseUrl: "http://example.com" }),
    ).toThrow(/HTTPS/u);
  });
});

describe("deterministic execution", () => {
  it("refuses without the voice presence tier and never touches the session", async () => {
    const session = new FakeVoiceSession();
    await expect(
      executeVoicePresenceIntent(executionConfig(session), {
        intent: "join",
        guildId: "guild-1",
        principal: principal([]),
        memberVoiceChannelId: "voice-1",
        adapterCreator: ADAPTER,
      }),
    ).resolves.toEqual({ action: "join_refused", reason: "authority" });
    await expect(
      executeVoicePresenceIntent(executionConfig(session), {
        intent: "leave",
        guildId: "guild-1",
        principal: principal([]),
        memberVoiceChannelId: "voice-1",
        adapterCreator: ADAPTER,
      }),
    ).resolves.toEqual({ action: "leave_refused", reason: "authority" });
    expect(session.joinInputs).toHaveLength(0);
    expect(session.leaves).toBe(0);
  });

  it("honors the guild_members policy exactly as slash join does", async () => {
    const session = new FakeVoiceSession();
    await expect(
      executeVoicePresenceIntent(executionConfig(session, { joinPolicy: "guild_members" }), {
        intent: "join",
        guildId: "guild-1",
        principal: principal([]),
        memberVoiceChannelId: "voice-1",
        adapterCreator: ADAPTER,
      }),
    ).resolves.toEqual({ action: "joined", channelId: "voice-1" });
  });

  it("refuses outside the voice allowlists, and the guild check is never skipped", async () => {
    const session = new FakeVoiceSession();
    await expect(
      executeVoicePresenceIntent(executionConfig(session, { voiceGuildIds: new Set(["guild-9"]) }), {
        intent: "join",
        guildId: "guild-1",
        principal: principal(),
        memberVoiceChannelId: "voice-1",
        adapterCreator: ADAPTER,
      }),
    ).resolves.toEqual({ action: "join_refused", reason: "allowlist" });
    await expect(
      executeVoicePresenceIntent(executionConfig(session, { voiceChannelIds: new Set(["voice-9"]) }), {
        intent: "join",
        guildId: "guild-1",
        principal: principal(),
        memberVoiceChannelId: "voice-1",
        adapterCreator: ADAPTER,
      }),
    ).resolves.toEqual({ action: "join_refused", reason: "allowlist" });
    expect(session.joinInputs).toHaveLength(0);
  });

  it("notes voice_disabled when there is no session, and not_in_voice when the asker left voice", async () => {
    await expect(
      executeVoicePresenceIntent(executionConfig(undefined), {
        intent: "join",
        guildId: "guild-1",
        principal: principal(),
        memberVoiceChannelId: "voice-1",
        adapterCreator: ADAPTER,
      }),
    ).resolves.toEqual({ action: "join_refused", reason: "voice_disabled" });
    await expect(
      executeVoicePresenceIntent(executionConfig(new FakeVoiceSession()), {
        intent: "join",
        guildId: "guild-1",
        principal: principal(),
        memberVoiceChannelId: undefined,
        adapterCreator: ADAPTER,
      }),
    ).resolves.toEqual({ action: "join_refused", reason: "not_in_voice" });
  });

  it("joins the asker's channel with no auto-opt-in, and reports a failed join truthfully", async () => {
    const session = new FakeVoiceSession();
    await expect(
      executeVoicePresenceIntent(executionConfig(session), {
        intent: "join",
        guildId: "guild-1",
        principal: principal(),
        memberVoiceChannelId: "voice-1",
        adapterCreator: ADAPTER,
      }),
    ).resolves.toEqual({ action: "joined", channelId: "voice-1" });
    expect(session.joinInputs).toHaveLength(1);
    expect(session.joinInputs[0]).toMatchObject({ guildId: "guild-1", channelId: "voice-1" });
    // The consent boundary: an asked join opts in NOBODY, the asker included.
    expect(session.joinInputs[0]).not.toHaveProperty("invokingUserId");

    const failing = new FakeVoiceSession();
    failing.failJoin = true;
    await expect(
      executeVoicePresenceIntent(executionConfig(failing), {
        intent: "join",
        guildId: "guild-1",
        principal: principal(),
        memberVoiceChannelId: "voice-1",
        adapterCreator: ADAPTER,
      }),
    ).resolves.toEqual({ action: "join_refused", reason: "failed" });
  });

  it("never rejoins the channel he is already in — a rejoin would reset consent", async () => {
    const session = new FakeVoiceSession();
    session.state = { active: true, guildId: "guild-1", channelId: "voice-1" };
    await expect(
      executeVoicePresenceIntent(executionConfig(session), {
        intent: "join",
        guildId: "guild-1",
        principal: principal(),
        memberVoiceChannelId: "voice-1",
        adapterCreator: ADAPTER,
      }),
    ).resolves.toEqual({ action: "joined", channelId: "voice-1" });
    expect(session.joinInputs).toHaveLength(0);
  });

  it("refuses a join while active in another guild, matching the slash cross-guild bound", async () => {
    const session = new FakeVoiceSession();
    session.state = { active: true, guildId: "guild-2", channelId: "voice-2" };
    await expect(
      executeVoicePresenceIntent(
        executionConfig(session, { voiceGuildIds: new Set(["guild-1", "guild-2"]) }),
        {
          intent: "join",
          guildId: "guild-1",
          principal: principal(),
          memberVoiceChannelId: "voice-1",
          adapterCreator: ADAPTER,
        },
      ),
    ).resolves.toEqual({ action: "join_refused", reason: "other_guild" });
    expect(session.joinInputs).toHaveLength(0);
  });

  it("leaves under the same tier, and refuses to hang up a call in another guild", async () => {
    const session = new FakeVoiceSession();
    session.state = { active: true, guildId: "guild-1", channelId: "voice-1" };
    await expect(
      executeVoicePresenceIntent(executionConfig(session), {
        intent: "leave",
        guildId: "guild-1",
        principal: principal(),
        memberVoiceChannelId: "voice-1",
        adapterCreator: ADAPTER,
      }),
    ).resolves.toEqual({ action: "left", channelId: "voice-1" });
    expect(session.leaves).toBe(1);

    const elsewhere = new FakeVoiceSession();
    elsewhere.state = { active: true, guildId: "guild-2", channelId: "voice-2" };
    await expect(
      executeVoicePresenceIntent(executionConfig(elsewhere), {
        intent: "leave",
        guildId: "guild-1",
        principal: principal(),
        memberVoiceChannelId: undefined,
        adapterCreator: ADAPTER,
      }),
    ).resolves.toEqual({ action: "leave_refused", reason: "other_guild" });
    expect(elsewhere.leaves).toBe(0);
  });
});

describe("the composed ask path", () => {
  it("reads the asker's channel at execution time, never from the model output", async () => {
    const session = new FakeVoiceSession();
    const options: VoicePresenceAskOptions = {
      gate: gateConfig(),
      // A hostile body cannot steer the target: the decider returns an intent
      // enum and nothing else, so even this "answer" only ever selects join.
      decider: () => Promise.resolve("join"),
      execution: executionConfig(session),
    };
    let reads = 0;
    const note = await handleVoicePresenceAsk(options, inbound({ body: "clankie join channel 666" }), () => {
      reads += 1;
      // The asker moved while the decider ran; the second read wins.
      return member({ voiceChannelId: reads === 1 ? "voice-1" : "voice-2" });
    });
    expect(note).toEqual({ action: "joined", channelId: "voice-2" });
    expect(reads).toBe(2);
    expect(session.joinInputs[0]).toMatchObject({ channelId: "voice-2" });
  });

  it("end to end: 'clankie hop in vc' joins and the captain turn carries the note", async () => {
    const session = new FakeVoiceSession();
    const options: VoicePresenceAskOptions = {
      gate: gateConfig(),
      decider: createVoicePresenceIntentDecider({
        apiKey: "intent-key",
        model: "gpt-4o-mini",
        fetchImpl: () =>
          Promise.resolve(
            new Response(JSON.stringify({ choices: [{ message: { content: "join" } }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
      }),
      execution: executionConfig(session),
    };
    const port = new RecordingPort();
    const ingress = new DiscordTextIngress(port, {
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      guildIds: new Set(["guild-1"]),
      channelIds: new Set(),
      dmPolicy: "deny",
      dmUserIds: new Set(),
      contextMessageLimit: 0,
      authenticatedSurfaceUrl: "http://127.0.0.1:4311/approvals",
      replyPolicy: "addressed",
      characterNames: ["clankie"],
    });

    // The same order index.ts runs: the ask settles before the turn starts.
    const message = { ...inbound(), id: "message-ask" };
    const note = await handleVoicePresenceAsk(options, message, () => member());
    const outcome = await ingress.handle({
      ...message,
      ...(note === undefined ? {} : { voicePresenceNote: note }),
      loadContextMessages: () => Promise.resolve([]),
    });

    expect(session.joinInputs).toEqual([
      { guildId: "guild-1", channelId: "voice-1", adapterCreator: ADAPTER },
    ]);
    expect(outcome).toMatchObject({ state: "settled" });
    expect(port.turns).toHaveLength(1);
    expect(port.turns[0]?.trigger.voicePresenceNote).toEqual({ action: "joined", channelId: "voice-1" });
  });
});

class RecordingPort implements DiscordTextIngressPort {
  public readonly turns: DiscordPresenceChannelTurnRequest[] = [];
  public readonly writes: DiscordPresenceWrite[] = [];

  public getHealth(): Promise<{ profileHash: string }> {
    return Promise.resolve({ profileHash: "profile-1" });
  }

  public submitDiscordCaptainChannelTurn(
    request: DiscordPresenceChannelTurnRequest,
  ): Promise<CaptainChannelTurnResult> {
    this.turns.push(request);
    return Promise.resolve({
      state: "settled",
      captainSessionId: "captain-session",
      turnId: `turn-${request.deliveryId}`,
      response: "On my way.",
    });
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
