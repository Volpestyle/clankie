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
  renderVoicePresenceAskText,
  voicePresenceGateOpen,
  VoicePresenceRetryWindow,
  VOICE_PRESENCE_INTENT_SYSTEM_PROMPT,
  VOICE_PRESENCE_RETRY_SYSTEM_PROMPT,
  VOICE_PRESENCE_RETRY_WINDOW_MS,
  VOICE_PRESENCE_TOKEN_PATTERN,
  type VoicePresenceAsk,
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
    id: "message-1",
    guildId: "guild-1",
    channelId: "channel-1",
    authorId: "asker",
    authorIsBot: false,
    mentionsBot: false,
    body: "clankie hop in vc",
    engagedInChannel: false,
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
        engagedInChannel: false,
        askerInVoice: false,
        ...input,
      },
      config,
    );

  it("opens for an admitted guild message that speaks to him: mention, name, or live conversation", () => {
    expect(open({})).toBe(true);
    // Addressing reuses the exact tests text ingress reads with. A message
    // that speaks to nobody he answers stays closed…
    expect(open({ body: "hop in vc please" })).toBe(false);
    expect(open({ body: "hop in vc please", mentionsBot: true })).toBe(true);
    // …but a follow-up inside a conversation he is actively answering is
    // addressed to him without his name — the exact live miss this fixed.
    expect(open({ body: "hop in vc and play pokemon", engagedInChannel: true })).toBe(true);
    // "clankiest" must not summon him — word-boundary matching is reused.
    expect(open({ body: "the clankiest vc ever" })).toBe(false);
  });

  it("stays closed for bot authors, DMs, and non-admitted guilds or channels", () => {
    expect(open({ authorIsBot: true })).toBe(false);
    expect(open({ authorIsBot: true, engagedInChannel: true })).toBe(false);
    expect(open({ guildId: undefined })).toBe(false);
    expect(open({ guildId: "guild-elsewhere" })).toBe(false);
    expect(open({}, gateConfig({ ingressChannelIds: new Set(["channel-9"]) }))).toBe(false);
    expect(open({ channelId: "channel-9" }, gateConfig({ ingressChannelIds: new Set(["channel-9"]) }))).toBe(
      true,
    );
  });

  it("without a voice token, only an explicit name from an asker inside voice opens", () => {
    expect(open({ body: "clankie what's the weather" })).toBe(false);
    expect(open({ body: "what's the weather", engagedInChannel: true })).toBe(false);
    // The second door — the live miss this widened for: named explicitly by an
    // asker already standing in a voice channel, no voice-ish word needed.
    expect(open({ body: "clankie i wanna talk to you", askerInVoice: true })).toBe(true);
    expect(open({ body: "i wanna talk to you", mentionsBot: true, askerInVoice: true })).toBe(true);
    // Engaged-but-unnamed keeps the word requirement even from inside voice —
    // an engaged channel chats freely, and a read per message is the cost the
    // word-gate exists to avoid.
    expect(open({ body: "i wanna talk to you", engagedInChannel: true, askerInVoice: true })).toBe(false);
    // The token list is deliberately loose; the decider does the real reading.
    for (const body of ["clankie hop in", "clankie join us", "clankie you can leave", "clankie dip"]) {
      expect(VOICE_PRESENCE_TOKEN_PATTERN.test(body)).toBe(true);
    }
  });

  it("a pending join retry opens the gate wordlessly, but only with the asker in voice", () => {
    // The third door — the live miss this widened for: "try now" and "im in
    // general" carry no voice-ish word and no name, yet follow a refusal that
    // explicitly invited them.
    expect(open({ body: "try now", pendingJoinRetry: true, askerInVoice: true })).toBe(true);
    expect(open({ body: "im in general", pendingJoinRetry: true, askerInVoice: true })).toBe(true);
    // Still out of voice: nothing to retry against, the gate stays closed.
    expect(open({ body: "try now", pendingJoinRetry: true, askerInVoice: false })).toBe(false);
    // No pending retry: a wordless unaddressed message stays closed, as ever.
    expect(open({ body: "try now", askerInVoice: true })).toBe(false);
    // The admission checks are never bypassed by a pending retry.
    expect(open({ body: "try now", pendingJoinRetry: true, askerInVoice: true, authorIsBot: true })).toBe(
      false,
    );
    expect(
      open({ body: "try now", pendingJoinRetry: true, askerInVoice: true, guildId: "guild-elsewhere" }),
    ).toBe(false);
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

    // Wordless and the asker not in voice: neither door opens.
    await expect(
      handleVoicePresenceAsk(options, inbound({ body: "clankie what's up" }), () =>
        member({ voiceChannelId: undefined }),
      ),
    ).resolves.toBeUndefined();
    expect(deciderCalls).toBe(0);
    // Wordless and engaged-only: the second door needs his explicit name.
    await expect(
      handleVoicePresenceAsk(options, inbound({ body: "what's up", engagedInChannel: true }), () => member()),
    ).resolves.toBeUndefined();
    expect(deciderCalls).toBe(0);
    await expect(
      handleVoicePresenceAsk(options, inbound({ body: "someone hop in vc" }), () => member()),
    ).resolves.toBeUndefined();
    expect(deciderCalls).toBe(0);
    // The restart-shaped blind spot: no member means no principal to execute
    // under, so the read would be wasted.
    await expect(handleVoicePresenceAsk(options, inbound(), () => undefined)).resolves.toBeUndefined();
    expect(deciderCalls).toBe(0);

    await expect(handleVoicePresenceAsk(options, inbound(), () => member())).resolves.toBeUndefined();
    expect(deciderCalls).toBe(1);
    // An asker outside voice still gets a read: execution answers with the
    // honest note instead of the gate shrugging silently.
    await expect(
      handleVoicePresenceAsk(options, inbound(), () => member({ voiceChannelId: undefined })),
    ).resolves.toBeUndefined();
    expect(deciderCalls).toBe(2);
    // The second door: a wordless message that names him, from an asker
    // standing in voice, is worth the read.
    await expect(
      handleVoicePresenceAsk(options, inbound({ body: "clankie i wanna talk to you" }), () => member()),
    ).resolves.toBeUndefined();
    expect(deciderCalls).toBe(3);
  });

  it("an asked join from outside voice earns the honest not_in_voice note, never silence", async () => {
    const session = new FakeVoiceSession();
    const options: VoicePresenceAskOptions = {
      gate: gateConfig(),
      decider: () => Promise.resolve("join"),
      execution: executionConfig(session),
    };
    await expect(
      handleVoicePresenceAsk(options, inbound(), () => member({ voiceChannelId: undefined })),
    ).resolves.toEqual({ action: "join_refused", reason: "not_in_voice" });
    expect(session.joinInputs).toHaveLength(0);
  });

  it("traces every evaluation of a message that speaks to him content-free, and nothing else", async () => {
    const traces: unknown[] = [];
    const session = new FakeVoiceSession();
    const options: VoicePresenceAskOptions = {
      gate: gateConfig(),
      decider: ({ body }) => Promise.resolve(body.includes("hop") ? "join" : "none"),
      execution: executionConfig(session),
      onTrace: (trace) => traces.push(trace),
    };

    // Speaking to nobody he answers: the common case must not log at all.
    await handleVoicePresenceAsk(options, inbound({ body: "someone hop in vc" }), () => member());
    expect(traces).toHaveLength(0);

    // Addressed with no resolvable member — the restart-shaped blind spot.
    await handleVoicePresenceAsk(options, inbound(), () => undefined);
    expect(traces).toEqual([
      {
        deliveryId: "message-1",
        addressed: true,
        engaged: false,
        memberResolved: false,
        inVoice: false,
        voiceToken: true,
      },
    ]);

    // Decider read no ask; the engaged door is visible in the trace.
    traces.length = 0;
    await handleVoicePresenceAsk(options, inbound({ body: "the vc was fun", engagedInChannel: true }), () =>
      member(),
    );
    expect(traces).toEqual([
      {
        deliveryId: "message-1",
        addressed: false,
        engaged: true,
        memberResolved: true,
        inVoice: true,
        voiceToken: true,
        intent: "none",
      },
    ]);

    // An asked join from outside voice: the refusal and its reason are visible.
    traces.length = 0;
    await handleVoicePresenceAsk(options, inbound(), () => member({ voiceChannelId: undefined }));
    expect(traces).toEqual([
      {
        deliveryId: "message-1",
        addressed: true,
        engaged: false,
        memberResolved: true,
        inVoice: false,
        voiceToken: true,
        intent: "join",
        action: "join_refused",
        reason: "not_in_voice",
      },
    ]);

    // Executed: intent and outcome land in the trace; the body never does.
    traces.length = 0;
    await handleVoicePresenceAsk(options, inbound(), () => member());
    expect(traces).toEqual([
      {
        deliveryId: "message-1",
        addressed: true,
        engaged: false,
        memberResolved: true,
        inVoice: true,
        voiceToken: true,
        intent: "join",
        action: "joined",
      },
    ]);
    for (const trace of traces) {
      expect(JSON.stringify(trace)).not.toContain("hop in vc");
    }
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

  const bodyOnly = (body: string) => ({ body, context: [] });

  it("sends the bounded body with temperature 0 and the brokered key", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const decide = decider(((url: URL | RequestInfo, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Promise.resolve(openAiAnswer("join"));
    }) as typeof fetch);
    await expect(decide(bodyOnly("clankie hop in vc"))).resolves.toBe("join");
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
    // No context: the read is exactly the body, nothing wrapped around it.
    expect(body.messages[1]?.content).toBe("clankie hop in vc");
    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer intent-key");
  });

  it("renders context attributed by role only, bounded, with the judged message last and never cut", () => {
    const rendered = renderVoicePresenceAskText({
      body: "hop in vc and play pokemon",
      context: [
        { speaker: "asker", body: "clankie wanna play some pokemon?" },
        { speaker: "clankie", body: "always. what did you have in mind?" },
        { speaker: "other", body: "x".repeat(1_000) },
      ],
    });
    expect(rendered).toBe(
      "Earlier channel messages, oldest first:\n" +
        "[the sender] clankie wanna play some pokemon?\n" +
        "[Clankie] always. what did you have in mind?\n" +
        `[another member] ${"x".repeat(400)}\n\n` +
        "The message to judge, from the sender:\nhop in vc and play pokemon",
    );
    // Only the newest lines survive the cap, so the judged message cannot be
    // squeezed out by a busy channel.
    const flooded = renderVoicePresenceAskText({
      body: "come play",
      context: Array.from({ length: 20 }, (_, index) => ({
        speaker: "other" as const,
        body: `line-${String(index)}`,
      })),
    });
    expect(flooded).not.toContain("line-13");
    expect(flooded).toContain("line-14");
    expect(flooded.endsWith("come play")).toBe(true);
  });

  it("parses strictly: only a clear join or leave acts; everything else is none", async () => {
    const m = bodyOnly("m");
    await expect(decider(() => Promise.resolve(openAiAnswer("Join.")))(m)).resolves.toBe("join");
    await expect(decider(() => Promise.resolve(openAiAnswer("LEAVE")))(m)).resolves.toBe("leave");
    await expect(decider(() => Promise.resolve(openAiAnswer("none")))(m)).resolves.toBe("none");
    await expect(decider(() => Promise.resolve(openAiAnswer("maybe join")))(m)).resolves.toBe("none");
    await expect(decider(() => Promise.resolve(openAiAnswer("join the call")))(m)).resolves.toBe("none");
    await expect(decider(() => Promise.resolve(openAiAnswer(42)))(m)).resolves.toBe("none");
  });

  it("fails closed on transport errors, bad statuses, and garbage, without echoing the body", async () => {
    // The rejection deliberately carries the request text: nothing of it may
    // surface — the decider swallows the error rather than rethrowing it.
    await expect(
      decider(() => Promise.reject(new Error("boom: secret ask body")))(bodyOnly("secret ask body")),
    ).resolves.toBe("none");
    await expect(
      decider(() => Promise.resolve(new Response("nope", { status: 500 })))(bodyOnly("m")),
    ).resolves.toBe("none");
    await expect(
      decider(() => Promise.resolve(new Response("not json", { status: 200 })))(bodyOnly("m")),
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

  it("end to end: a follow-up he was already answering joins without his name — the live miss, replayed", async () => {
    const session = new FakeVoiceSession();
    const options: VoicePresenceAskOptions = {
      gate: gateConfig(),
      decider: ({ body }) => Promise.resolve(body.includes("hop") ? "join" : "none"),
      execution: executionConfig(session),
    };
    const ingress = new DiscordTextIngress(new RecordingPort(), {
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

    // "clankie wanna play some pokemon?" — addressed from inside voice, so the
    // second door earns it a read; the decider reads no voice ask, and he
    // answers in text, which opens the conversation.
    const opener = { ...inbound({ body: "clankie wanna play some pokemon?" }), id: "message-opener" };
    expect(await handleVoicePresenceAsk(options, opener, () => member())).toBeUndefined();
    await ingress.handle(opener);

    // "hop in vc and play pokemon" — names nobody. Before engagement fed the
    // gate, this exact message missed while he cheerfully replied in text.
    const followUp = {
      ...inbound({
        body: "hop in vc and play pokemon",
        engagedInChannel: ingress.engagedInChannel("channel-1"),
      }),
      id: "message-follow-up",
    };
    const note = await handleVoicePresenceAsk(options, followUp, () => member());
    expect(note).toEqual({ action: "joined", channelId: "voice-1" });
    expect(session.joinInputs).toEqual([
      { guildId: "guild-1", channelId: "voice-1", adapterCreator: ADAPTER },
    ]);
  });

  it("carries the not_in_voice refusal into the turn so his reply can say what to do", async () => {
    const options: VoicePresenceAskOptions = {
      gate: gateConfig(),
      decider: () => Promise.resolve("join"),
      execution: executionConfig(new FakeVoiceSession()),
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

    // Asked before joining any voice channel — the ask that used to vanish.
    const message = { ...inbound(), id: "message-early-ask" };
    const note = await handleVoicePresenceAsk(options, message, () => member({ voiceChannelId: undefined }));
    expect(note).toEqual({ action: "join_refused", reason: "not_in_voice" });
    await ingress.handle({
      ...message,
      ...(note === undefined ? {} : { voicePresenceNote: note }),
      loadContextMessages: () => Promise.resolve([]),
    });
    expect(port.turns[0]?.trigger.voicePresenceNote).toEqual({
      action: "join_refused",
      reason: "not_in_voice",
    });
  });
});

describe("the pending join retry", () => {
  /** Options wired the way index.ts wires them, with a scripted decider. */
  function retryOptions(input: {
    session: FakeVoiceSession;
    retry: VoicePresenceRetryWindow;
    decide: (ask: VoicePresenceAsk) => "join" | "leave" | "none";
    asks?: VoicePresenceAsk[];
    traces?: unknown[];
  }): VoicePresenceAskOptions {
    return {
      gate: gateConfig(),
      decider: (ask) => {
        input.asks?.push(ask);
        return Promise.resolve(input.decide(ask));
      },
      execution: executionConfig(input.session),
      retry: input.retry,
      ...(input.traces === undefined ? {} : { onTrace: (trace: unknown) => input.traces?.push(trace) }),
    };
  }

  /** The refusal that opens the window: a worded ask from outside voice. */
  async function refuseJoin(options: VoicePresenceAskOptions): Promise<void> {
    await expect(
      handleVoicePresenceAsk(options, inbound({ id: "message-ask", body: "clankie hop in vc" }), () =>
        member({ voiceChannelId: undefined }),
      ),
    ).resolves.toEqual({ action: "join_refused", reason: "not_in_voice" });
  }

  it("the live miss, replayed: 'try now' from inside voice retries the refused join", async () => {
    const session = new FakeVoiceSession();
    const retry = new VoicePresenceRetryWindow();
    const asks: VoicePresenceAsk[] = [];
    const traces: unknown[] = [];
    const options = retryOptions({ session, retry, decide: () => "join", asks, traces });

    await refuseJoin(options);
    // "try now": no voice-ish word, no name, mid-conversation — exactly the
    // live follow-up that exited unread. The asker is in General now.
    const note = await handleVoicePresenceAsk(
      options,
      inbound({ id: "message-try-now", body: "try now", engagedInChannel: true }),
      () => member({ voiceChannelId: "voice-general" }),
    );
    expect(note).toEqual({ action: "joined", channelId: "voice-general" });
    // The target came from the fresh gateway read, never text or the model.
    expect(session.joinInputs).toEqual([
      { guildId: "guild-1", channelId: "voice-general", adapterCreator: ADAPTER },
    ]);
    // The follow-up read carried the retry framing, not the fresh-ask one.
    expect(asks.map((ask) => ask.pendingJoinRetry === true)).toEqual([false, true]);
    // The trace says a pending retry was open and what happened — enough to
    // diagnose a missed follow-up without a single body.
    expect(traces.at(-1)).toEqual({
      deliveryId: "message-try-now",
      addressed: false,
      engaged: true,
      memberResolved: true,
      inVoice: true,
      voiceToken: false,
      pendingRetry: true,
      intent: "join",
      action: "joined",
    });

    // The join consumed the window: the asker's next wordless message earns
    // no further read.
    await expect(
      handleVoicePresenceAsk(options, inbound({ id: "message-later", body: "nice" }), () =>
        member({ voiceChannelId: "voice-general" }),
      ),
    ).resolves.toBeUndefined();
    expect(asks).toHaveLength(2);
  });

  it("unrelated chatter inside the window cannot join: the read fails closed and the window survives", async () => {
    const session = new FakeVoiceSession();
    const retry = new VoicePresenceRetryWindow();
    const asks: VoicePresenceAsk[] = [];
    const options = retryOptions({
      session,
      retry,
      // The fresh ask reads "join"; inside the window only the actual
      // follow-up does — chatter reads "none", as the live decider would.
      decide: (ask) =>
        ask.pendingJoinRetry === true ? (ask.body === "ok try now" ? "join" : "none") : "join",
      asks,
    });

    await refuseJoin(options);
    // The asker walks into voice and just… talks. One bounded read says
    // "none"; nothing joins, and the door he held open stays open.
    await expect(
      handleVoicePresenceAsk(options, inbound({ id: "message-chatter", body: "that boss was wild" }), () =>
        member({ voiceChannelId: "voice-general" }),
      ),
    ).resolves.toBeUndefined();
    expect(session.joinInputs).toHaveLength(0);
    // The actual follow-up still works after the chatter.
    await expect(
      handleVoicePresenceAsk(options, inbound({ id: "message-affirm", body: "ok try now" }), () =>
        member({ voiceChannelId: "voice-general" }),
      ),
    ).resolves.toEqual({ action: "joined", channelId: "voice-general" });
    expect(asks.map((ask) => ask.pendingJoinRetry === true)).toEqual([false, true, true]);
  });

  it("the window binds one asker in one channel and expires: nobody else, nowhere else, never late", async () => {
    const session = new FakeVoiceSession();
    let now = 0;
    const retry = new VoicePresenceRetryWindow(VOICE_PRESENCE_RETRY_WINDOW_MS, () => now);
    const asks: VoicePresenceAsk[] = [];
    const options = retryOptions({ session, retry, decide: () => "join", asks });

    await refuseJoin(options);
    // Another member's wordless message in the same channel: no read.
    await expect(
      handleVoicePresenceAsk(
        options,
        inbound({ id: "message-other-user", body: "try now", authorId: "someone-else" }),
        () => member({ voiceChannelId: "voice-general" }),
      ),
    ).resolves.toBeUndefined();
    // The same asker in another text channel: no read.
    await expect(
      handleVoicePresenceAsk(
        options,
        inbound({ id: "message-other-channel", body: "try now", channelId: "channel-2" }),
        () => member({ voiceChannelId: "voice-general" }),
      ),
    ).resolves.toBeUndefined();
    // The same asker, same channel, but past the window: no read.
    now += VOICE_PRESENCE_RETRY_WINDOW_MS + 1;
    await expect(
      handleVoicePresenceAsk(options, inbound({ id: "message-late", body: "try now" }), () =>
        member({ voiceChannelId: "voice-general" }),
      ),
    ).resolves.toBeUndefined();
    expect(asks).toHaveLength(1);
    expect(session.joinInputs).toHaveLength(0);
  });

  it("a follow-up from still outside voice earns no read, but the trace shows the open window", async () => {
    const session = new FakeVoiceSession();
    const retry = new VoicePresenceRetryWindow();
    const traces: unknown[] = [];
    const asks: VoicePresenceAsk[] = [];
    const options = retryOptions({ session, retry, decide: () => "join", asks, traces });

    await refuseJoin(options);
    traces.length = 0;
    await expect(
      handleVoicePresenceAsk(options, inbound({ id: "message-still-out", body: "try now" }), () =>
        member({ voiceChannelId: undefined }),
      ),
    ).resolves.toBeUndefined();
    expect(asks).toHaveLength(1);
    expect(traces).toEqual([
      {
        deliveryId: "message-still-out",
        addressed: false,
        engaged: false,
        memberResolved: true,
        inVoice: false,
        voiceToken: false,
        pendingRetry: true,
      },
    ]);
  });

  it("only not_in_voice opens the window; other refusals leave nothing pending", async () => {
    const session = new FakeVoiceSession();
    const retry = new VoicePresenceRetryWindow();
    const asks: VoicePresenceAsk[] = [];
    const options: VoicePresenceAskOptions = {
      gate: gateConfig(),
      decider: (ask) => {
        asks.push(ask);
        return Promise.resolve("join");
      },
      execution: executionConfig(session, { voiceGuildIds: new Set(["guild-9"]) }),
      retry,
    };

    await expect(
      handleVoicePresenceAsk(options, inbound({ id: "message-ask", body: "clankie hop in vc" }), () =>
        member(),
      ),
    ).resolves.toEqual({ action: "join_refused", reason: "allowlist" });
    await expect(
      handleVoicePresenceAsk(options, inbound({ id: "message-try", body: "try now" }), () => member()),
    ).resolves.toBeUndefined();
    expect(asks).toHaveLength(1);
  });

  it("a retry that finds the asker gone again reopens the window instead of eating the follow-up", async () => {
    const session = new FakeVoiceSession();
    const retry = new VoicePresenceRetryWindow();
    const options = retryOptions({ session, retry, decide: () => "join" });

    await refuseJoin(options);
    // Gate time says in voice; execution's fresh read says gone — the asker
    // hopped out while the decider ran. The honest refusal re-arms the window.
    let reads = 0;
    await expect(
      handleVoicePresenceAsk(options, inbound({ id: "message-flicker", body: "try now" }), () => {
        reads += 1;
        return member({ voiceChannelId: reads === 1 ? "voice-general" : undefined });
      }),
    ).resolves.toEqual({ action: "join_refused", reason: "not_in_voice" });
    // Back in voice, the next follow-up still lands.
    await expect(
      handleVoicePresenceAsk(options, inbound({ id: "message-back", body: "ok now" }), () =>
        member({ voiceChannelId: "voice-general" }),
      ),
    ).resolves.toEqual({ action: "joined", channelId: "voice-general" });
  });

  it("retains at most 64 pending retries and evicts the oldest first", () => {
    // The documented capacity contract: 64 retained entries, oldest evicted on
    // overflow, so a refusal flood can never grow the state unboundedly. The
    // window's whole write surface is this call — ids plus the typed note —
    // so there is no parameter through which a message body could enter the
    // retained state.
    const retry = new VoicePresenceRetryWindow(VOICE_PRESENCE_RETRY_WINDOW_MS, () => 0);
    const refusal = { action: "join_refused", reason: "not_in_voice" } as const;
    const key = (index: number) => ({
      guildId: "guild-1",
      channelId: `channel-${String(index)}`,
      actorId: "asker",
    });
    for (let index = 0; index <= 64; index += 1) retry.settle(key(index), refusal);
    // The 65th entry displaced only the oldest; the next-oldest and the
    // newest both survive.
    expect(retry.pending(key(0))).toBe(false);
    expect(retry.pending(key(1))).toBe(true);
    expect(retry.pending(key(64))).toBe(true);
  });

  it("the retry read sends the retry framing; a fresh ask keeps the standing prompt", async () => {
    const prompts: string[] = [];
    const decide = createVoicePresenceIntentDecider({
      apiKey: "intent-key",
      model: "gpt-4o-mini",
      fetchImpl: ((_url: URL | RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        prompts.push(body.messages[0]?.content ?? "");
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: "join" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) as typeof fetch,
    });
    await decide({ body: "clankie hop in vc", context: [] });
    await decide({ body: "try now", context: [], pendingJoinRetry: true });
    expect(prompts).toEqual([VOICE_PRESENCE_INTENT_SYSTEM_PROMPT, VOICE_PRESENCE_RETRY_SYSTEM_PROMPT]);
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
