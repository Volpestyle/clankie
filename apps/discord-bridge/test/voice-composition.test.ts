import { describe, expect, it } from "vitest";
import type { DiscordVoiceEvidence } from "@clankie/protocol";
import type { RealtimeTimers } from "@clankie/discord-presence-core";
import {
  describeVoiceResponse,
  parseVoiceRealtimeEnv,
  renderVoiceConsentReply,
  renderVoiceJoinDisclosure,
  renderVoiceStatusReply,
  VoiceIdleAutoLeave,
  voiceEvidenceReceiptData,
  voiceEvidenceReceiptType,
} from "../src/voice-composition.ts";

class TestTimers implements RealtimeTimers {
  public readonly scheduled: { handle: number; delayMs: number; handler: () => void; cleared: boolean }[] =
    [];
  private nextHandle = 1;

  public setTimeout(handler: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.scheduled.push({ handle, delayMs, handler, cleared: false });
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    const entry = this.scheduled.find((candidate) => candidate.handle === handle);
    if (entry !== undefined) entry.cleared = true;
  }

  public armed(): { delayMs: number; handler: () => void }[] {
    return this.scheduled.filter((candidate) => !candidate.cleared);
  }
}

describe("realtime voice environment", () => {
  it("applies the documented defaults, with truncation always configured", () => {
    const config = parseVoiceRealtimeEnv({});
    expect(config).toEqual({
      realtimeModel: "gpt-realtime-2.1",
      transcribeModel: "gpt-realtime-whisper",
      voice: "marin",
      ttsProvider: "openai",
      truncationRetentionRatio: 0.7,
      postInstructionsTokenLimit: 12_000,
      decayWindowMs: 60_000,
      idleLeaveMs: 900_000,
    });
  });

  it("parses the ElevenLabs TTS provider and demands a voice id for it", () => {
    const config = parseVoiceRealtimeEnv({
      CLANKIE_VOICE_TTS_PROVIDER: "elevenlabs",
      CLANKIE_VOICE_ELEVENLABS_VOICE_ID: "voice_abc123",
      CLANKIE_VOICE_ELEVENLABS_MODEL_ID: "eleven_flash_v2_5",
    });
    expect(config.ttsProvider).toBe("elevenlabs");
    expect(config.elevenLabsVoiceId).toBe("voice_abc123");
    expect(config.elevenLabsModelId).toBe("eleven_flash_v2_5");

    expect(() => parseVoiceRealtimeEnv({ CLANKIE_VOICE_TTS_PROVIDER: "elevenlabs" })).toThrow(
      /CLANKIE_VOICE_ELEVENLABS_VOICE_ID/u,
    );
    expect(() => parseVoiceRealtimeEnv({ CLANKIE_VOICE_TTS_PROVIDER: "espeak" })).toThrow(
      /CLANKIE_VOICE_TTS_PROVIDER/u,
    );
    // Set-but-ignored identifiers are drift, exactly like the retired knobs.
    expect(() => parseVoiceRealtimeEnv({ CLANKIE_VOICE_ELEVENLABS_VOICE_ID: "voice_abc123" })).toThrow(
      /CLANKIE_VOICE_TTS_PROVIDER=elevenlabs/u,
    );
  });

  it("honors overrides, including the owner-tunable decay window", () => {
    const config = parseVoiceRealtimeEnv({
      CLANKIE_VOICE_REALTIME_MODEL: "gpt-realtime-2.1-mini",
      CLANKIE_VOICE_TRANSCRIBE_MODEL: "gpt-realtime-whisper-2",
      CLANKIE_VOICE_REALTIME_VOICE: "cedar",
      CLANKIE_VOICE_STT_LANGUAGE: "",
      CLANKIE_VOICE_TRUNCATION_RETENTION: "0.5",
      CLANKIE_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT: "20000",
      CLANKIE_VOICE_SESSION_LIFETIME_MS: "600000",
      CLANKIE_VOICE_DECAY_WINDOW_MS: "45000",
      CLANKIE_VOICE_IDLE_LEAVE_MS: "300000",
    });
    expect(config.realtimeModel).toBe("gpt-realtime-2.1-mini");
    expect(config.transcribeModel).toBe("gpt-realtime-whisper-2");
    expect(config.voice).toBe("cedar");
    // Empty is meaningful: it restores per-utterance language auto-detection.
    expect(config.language).toBe("");
    expect(config.truncationRetentionRatio).toBe(0.5);
    expect(config.postInstructionsTokenLimit).toBe(20_000);
    expect(config.sessionLifetimeMs).toBe(600_000);
    expect(config.decayWindowMs).toBe(45_000);
    expect(config.idleLeaveMs).toBe(300_000);
  });

  it("rejects unbounded or disabled idle auto-leave", () => {
    expect(() => parseVoiceRealtimeEnv({ CLANKIE_VOICE_IDLE_LEAVE_MS: "0" })).toThrow(
      /CLANKIE_VOICE_IDLE_LEAVE_MS/u,
    );
    expect(() => parseVoiceRealtimeEnv({ CLANKIE_VOICE_IDLE_LEAVE_MS: "-1" })).toThrow(
      /CLANKIE_VOICE_IDLE_LEAVE_MS/u,
    );
    expect(() => parseVoiceRealtimeEnv({ CLANKIE_VOICE_IDLE_LEAVE_MS: "999999999999" })).toThrow(
      /CLANKIE_VOICE_IDLE_LEAVE_MS/u,
    );
  });

  it("rejects out-of-range truncation so the session is never unbounded", () => {
    expect(() => parseVoiceRealtimeEnv({ CLANKIE_VOICE_TRUNCATION_RETENTION: "0" })).toThrow(/ratio/u);
    expect(() => parseVoiceRealtimeEnv({ CLANKIE_VOICE_TRUNCATION_RETENTION: "1.5" })).toThrow(/ratio/u);
    expect(() => parseVoiceRealtimeEnv({ CLANKIE_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT: "10" })).toThrow(
      /CLANKIE_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT/u,
    );
  });

  it("fails loudly on retired knobs instead of silently ignoring them", () => {
    const retired = [
      "CLANKIE_VOICE_STT_MODEL",
      "CLANKIE_VOICE_TTS_MODEL",
      "CLANKIE_VOICE_TTS_VOICE",
      // There is no separate volition model any more: his own realtime session
      // decides whether to speak up, so a set model name would be ignored.
      "CLANKIE_VOICE_VOLITION_MODEL",
    ];
    for (const name of retired) {
      expect(() => parseVoiceRealtimeEnv({ [name]: "anything" })).toThrow(new RegExp(name, "u"));
    }
  });
});

describe("voice evidence receipts and the response line", () => {
  const scope = { guildId: "12345", channelId: "67890" } as const;

  it("maps floor and volition evidence onto their receipt types", () => {
    expect(voiceEvidenceReceiptType({ type: "floor", ...scope, state: "engaged", reason: "addressed" })).toBe(
      "discord.voice.floor",
    );
    expect(
      voiceEvidenceReceiptType({ type: "volition", ...scope, offered: 3, taken: 1, suppressed: 2 }),
    ).toBe("discord.voice.volition");
    expect(voiceEvidenceReceiptType({ type: "left", ...scope })).toBe("discord.voice.left");
    expect(
      voiceEvidenceReceiptType({
        type: "possessor_narration_suppressed",
        ...scope,
        deliveryId: "play-turn-2",
        reason: "rate_limited",
      }),
    ).toBe("discord.voice.possessor_narration_suppressed");
  });

  it("flattens evidence into scalar receipt data without undefined slots", () => {
    const data = voiceEvidenceReceiptData({
      type: "response",
      ...scope,
      deliveryId: "d-1",
      state: "settled",
      fastPath: true,
      wake: "waking",
      toFirstAudioMs: 420,
      handoffMs: 0,
      playbackMs: 900,
    });
    expect(data).toEqual({
      type: "response",
      guildId: "12345",
      channelId: "67890",
      deliveryId: "d-1",
      state: "settled",
      fastPath: true,
      wake: "waking",
      toFirstAudioMs: 420,
      handoffMs: 0,
      playbackMs: 900,
    });
    expect(Object.keys(data)).not.toContain("turnId");
  });

  it("prints the ADR 0057 stage split: wake class, trigger, path, first audio, handoff, playback", () => {
    expect(
      describeVoiceResponse({
        type: "response",
        ...scope,
        deliveryId: "d-1",
        state: "settled",
        fastPath: true,
        trigger: "room",
        wake: "waking",
        toFirstAudioMs: 420.4,
        handoffMs: 0,
        playbackMs: 900,
      }),
    ).toBe("voice turn (waking, room, fast path): 420ms to first audio, then 900ms speaking");
    expect(
      describeVoiceResponse({
        type: "response",
        ...scope,
        deliveryId: "d-2",
        turnId: "turn-9",
        state: "waiting_user",
        fastPath: false,
        trigger: "room",
        wake: "continuing",
        toFirstAudioMs: 1500,
        handoffMs: 1100,
        playbackMs: 2000,
      }),
    ).toBe(
      "voice turn (continuing, room, clankie handoff 1100ms): 1500ms to first audio, then 2000ms speaking",
    );
  });

  it("names a play narration, so it is never mistaken for a reply to the room", () => {
    // Both fast-path triggers report a zero handoff. Before the trigger was
    // recorded these two lines were byte-identical, and telling a 39-second
    // narration from a 39-second answer meant correlating the play journal.
    expect(
      describeVoiceResponse({
        type: "response",
        ...scope,
        deliveryId: "d-3",
        state: "settled",
        fastPath: true,
        trigger: "narration",
        wake: "waking",
        toFirstAudioMs: 803,
        handoffMs: 0,
        playbackMs: 39022,
      }),
    ).toBe("voice turn (waking, narration, fast path): 803ms to first audio, then 39022ms speaking");
  });

  it("reads a record written before the trigger existed as a room turn", () => {
    expect(
      describeVoiceResponse({
        type: "response",
        ...scope,
        deliveryId: "d-4",
        state: "settled",
        fastPath: true,
        wake: "continuing",
        toFirstAudioMs: 500,
        handoffMs: 0,
        playbackMs: 1000,
      }),
    ).toBe("voice turn (continuing, room, fast path): 500ms to first audio, then 1000ms speaking");
  });
});

describe("idle auto-leave", () => {
  function build(overrides: { isActive?: () => boolean } = {}) {
    const timers = new TestTimers();
    const leaves: number[] = [];
    let leaveLogged: number | undefined;
    const autoLeave = new VoiceIdleAutoLeave({
      idleLeaveMs: 900_000,
      isActive: overrides.isActive ?? (() => true),
      leave: () => {
        leaves.push(1);
        return Promise.resolve();
      },
      onLeave: (idleMs) => {
        leaveLogged = idleMs;
      },
      timers,
    });
    return { timers, leaves, autoLeave, leaveLogged: () => leaveLogged };
  }

  const evidence = (type: "joined" | "utterance" | "response" | "floor" | "left" | "volition") =>
    ({
      joined: { type: "joined", guildId: "1", channelId: "2", daveProtocolVersion: 1 },
      utterance: {
        type: "utterance",
        guildId: "1",
        channelId: "2",
        userId: "3",
        deliveryId: "d",
        durationMs: 500,
      },
      response: {
        type: "response",
        guildId: "1",
        channelId: "2",
        deliveryId: "d",
        state: "settled",
        fastPath: true,
        wake: "continuing",
        toFirstAudioMs: 1,
        handoffMs: 0,
        playbackMs: 1,
      },
      floor: { type: "floor", guildId: "1", channelId: "2", state: "engaged", reason: "addressed" },
      left: { type: "left", guildId: "1", channelId: "2" },
      volition: { type: "volition", guildId: "1", channelId: "2", offered: 1, taken: 0, suppressed: 1 },
    })[type] as DiscordVoiceEvidence;

  it("arms on join, re-arms on activity, and leaves after the idle window", () => {
    const { timers, leaves, autoLeave, leaveLogged } = build();
    autoLeave.observe(evidence("joined"));
    expect(timers.armed()).toHaveLength(1);
    // Activity resets the timer rather than stacking a second one.
    autoLeave.observe(evidence("utterance"));
    autoLeave.observe(evidence("floor"));
    autoLeave.observe(evidence("response"));
    expect(timers.armed()).toHaveLength(1);
    timers.armed()[0]?.handler();
    expect(leaves).toHaveLength(1);
    expect(leaveLogged()).toBe(900_000);
  });

  it("does not leave when the session is already inactive", () => {
    const { timers, leaves, autoLeave } = build({ isActive: () => false });
    autoLeave.observe(evidence("joined"));
    timers.armed()[0]?.handler();
    expect(leaves).toHaveLength(0);
  });

  it("disarms on left evidence and on stop, and ignores non-activity evidence", () => {
    const { timers, autoLeave } = build();
    autoLeave.observe(evidence("volition"));
    expect(timers.armed()).toHaveLength(0);
    autoLeave.observe(evidence("joined"));
    autoLeave.observe(evidence("left"));
    expect(timers.armed()).toHaveLength(0);
    autoLeave.observe(evidence("joined"));
    autoLeave.stop();
    expect(timers.armed()).toHaveLength(0);
  });

  it("rejects a non-positive idle threshold", () => {
    expect(
      () =>
        new VoiceIdleAutoLeave({
          idleLeaveMs: 0,
          isActive: () => true,
          leave: () => Promise.resolve(),
        }),
    ).toThrow(/positive/u);
  });
});

describe("voice disclosure and status wording (ADR 0057 audio residency)", () => {
  it("states live-session residency and never promises per-turn discard", () => {
    const disclosure = renderVoiceJoinDisclosure(1);
    // Pinned as the mission's rendered-disclosure evidence.
    expect(disclosure).toBe(
      "Joined with DAVE protocol 1. Only you are opted in — audio from anyone who has not " +
        "explicitly consented is never streamed anywhere. Consented audio feeds a live OpenAI " +
        "realtime session that keeps this call's conversation on OpenAI's servers for as long as " +
        "the call lasts. I listen continuously but speak only when addressed, or briefly on my " +
        "own initiative. My spoken replies use an AI-generated voice. Nothing said in voice " +
        "can ever approve privileged actions. Use **/clankie voice-consent opt-in** to let me " +
        "hear you and **/clankie voice-consent opt-out** to revoke immediately.",
    );
    // The residency sentence and every required disclosure element.
    expect(disclosure).toContain("DAVE protocol 1");
    expect(disclosure).toContain("explicitly consented");
    expect(disclosure).toContain("live OpenAI realtime session");
    expect(disclosure).toContain("for as long as the call lasts");
    expect(disclosure).toContain("listen continuously");
    expect(disclosure).toContain("AI-generated voice");
    expect(disclosure).toContain("privileged actions");
    expect(disclosure).toContain("/clankie voice-consent opt-in");
    expect(disclosure).toContain("/clankie voice-consent opt-out");
    // The promise this architecture cannot honor must be gone.
    expect(disclosure.toLowerCase()).not.toContain("discard");
    expect(disclosure.toLowerCase()).not.toContain("after each turn");
    expect(disclosure.toLowerCase()).not.toContain("not retained");
  });

  it("carries the residency terms in the opt-in reply, where consent is actually granted", () => {
    // The join disclosure is ephemeral to the invoker only, so this private
    // reply is the one every other participant consents through.
    const optIn = renderVoiceConsentReply(true, 3);
    expect(optIn).toContain("3 participant(s) are now opted in");
    expect(optIn).toContain("live OpenAI realtime session");
    expect(optIn).toContain("for as long as the call lasts");
    expect(optIn).toContain("AI-generated voice");
    expect(optIn).toContain("privileged actions");
    expect(optIn).toContain("/clankie voice-consent opt-out");
    expect(optIn.toLowerCase()).not.toContain("after each turn");
    expect(optIn.toLowerCase()).not.toContain("not retained");

    const optOut = renderVoiceConsentReply(false, 2);
    expect(optOut).toBe("Your voice consent is revoked and any active capture for you was discarded.");
  });

  it("discloses the second vendor when an external voice is configured (ADR 0070)", () => {
    const disclosure = renderVoiceJoinDisclosure(1, "elevenlabs");
    expect(disclosure).toContain("synthesized by ElevenLabs from the words I choose");
    // The boundary that keeps consent posture unchanged: only his own words
    // transit the second vendor, never anyone's audio.
    expect(disclosure).toContain("your audio is never sent to ElevenLabs");
    expect(disclosure).toContain("live OpenAI realtime session");

    const optIn = renderVoiceConsentReply(true, 3, "elevenlabs");
    expect(optIn).toContain("synthesized by ElevenLabs");
    expect(optIn).toContain("your audio is never sent to ElevenLabs");

    // The default stays vendor-silent: no ElevenLabs mention without the
    // provider actually configured.
    expect(renderVoiceJoinDisclosure(1)).not.toContain("ElevenLabs");
    expect(renderVoiceConsentReply(true, 3)).not.toContain("ElevenLabs");
  });

  it("describes bounded local and server-side retention in voice-status", () => {
    const active = renderVoiceStatusReply(
      {
        active: true,
        guildId: "1",
        channelId: "2",
        daveProtocolVersion: 1,
        consentedParticipantCount: 3,
        activeCaptureCount: 1,
        floorState: "engaged",
        engaged: true,
      },
      true,
    );
    expect(active).toContain("DAVE protocol 1");
    expect(active).toContain("3 participant(s) opted in");
    expect(active).toContain("engaged in conversation");
    expect(active).toContain("bounded transcript window in memory");
    expect(active).toContain("server-side for the duration of the call");
    // The cascade's false claim is gone.
    expect(active.toLowerCase()).not.toContain("are not retained");
    expect(
      renderVoiceStatusReply(
        {
          active: true,
          daveProtocolVersion: 1,
          consentedParticipantCount: 1,
          activeCaptureCount: 0,
          floorState: "dormant",
          engaged: false,
        },
        true,
      ),
    ).toContain("listening dormant");
    expect(renderVoiceStatusReply(undefined, true)).toBe("Voice is enabled but not connected.");
    expect(renderVoiceStatusReply(undefined, false)).toBe("Voice is disabled.");
  });

  it("does not demand per-session opt-in when the owner chose presence consent", () => {
    const disclosure = renderVoiceJoinDisclosure(1, "openai", "presence");
    expect(disclosure).toContain("Anyone in this voice channel can talk to me");
    expect(disclosure).toContain("being here is consent");
    expect(disclosure).toContain("/clankie voice-consent opt-out");
    expect(disclosure).not.toContain("/clankie voice-consent opt-in");
    expect(disclosure).not.toContain("Only you are opted in");

    const optIn = renderVoiceConsentReply(true, 1, "elevenlabs", "presence");
    expect(optIn).toContain("you do not need to opt in each session");
    expect(optIn).toContain("Anyone in this voice channel can talk");
    expect(optIn).toContain("your audio is never sent to ElevenLabs");
    expect(optIn).not.toContain("You are opted in for this voice session");

    const status = renderVoiceStatusReply(
      {
        active: true,
        guildId: "1",
        channelId: "2",
        daveProtocolVersion: 1,
        consentedParticipantCount: 1,
        activeCaptureCount: 0,
        floorState: "dormant",
        engaged: false,
      },
      true,
      "presence",
    );
    expect(status).toContain("anyone in this channel can talk");
    expect(status).not.toContain("opted in");
  });
});
