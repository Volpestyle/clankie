import { describe, expect, it } from "vitest";
import {
  parseVoiceRealtimeEnv,
  voiceEvidenceReceiptData,
  voiceEvidenceReceiptType,
} from "@clankie/discord-presence-core";
import {
  describeVoiceResponse,
  renderVoiceConsentReply,
  renderVoiceJoinDisclosure,
  renderVoiceStatusReply,
} from "../src/voice-composition.ts";

describe("realtime voice environment", () => {
  it("applies the documented defaults, with truncation always configured", () => {
    const config = parseVoiceRealtimeEnv({});
    expect(config).toEqual({
      realtimeProvider: "openai",
      realtimeModel: "gpt-realtime-2.1",
      transcribeModel: "gpt-realtime-whisper",
      voice: "marin",
      ttsProvider: "openai",
      truncationRetentionRatio: 0.7,
      postInstructionsTokenLimit: 12_000,
      decayWindowMs: 60_000,
    });
  });

  it("selects Grok Voice with its pinned model, native STT, voice, and reasoning", () => {
    const config = parseVoiceRealtimeEnv({ CLANKIE_VOICE_REALTIME_PROVIDER: "xai" });
    expect(config).toMatchObject({
      realtimeProvider: "xai",
      realtimeModel: "grok-voice-think-fast-2.0",
      voice: "eve",
      xaiReasoningEffort: "high",
      ttsProvider: "openai",
    });
    expect(() =>
      parseVoiceRealtimeEnv({
        CLANKIE_VOICE_REALTIME_PROVIDER: "xai",
        CLANKIE_VOICE_TRANSCRIBE_MODEL: "made-up-selector",
      }),
    ).toThrow(/has no model selector/u);
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
  });

  it("retires the idle leave timer: leaving is his own voice_leave decision (ADR 0057)", () => {
    // The timer counted only speech, so a quiet music session lost him mid-song.
    expect(() => parseVoiceRealtimeEnv({ CLANKIE_VOICE_IDLE_LEAVE_MS: "300000" })).toThrow(
      /CLANKIE_VOICE_IDLE_LEAVE_MS.*voice_leave/u,
    );
    expect(parseVoiceRealtimeEnv({})).not.toHaveProperty("idleLeaveMs");
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
        type: "play_narration_suppressed",
        ...scope,
        deliveryId: "play-turn-2",
        reason: "rate_limited",
      }),
    ).toBe("discord.voice.play_narration_suppressed");
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
    ).toBe(
      "voice turn (waking, narration, fast path): 803ms from response request to first audio, then 39022ms speaking",
    );
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
        "the call lasts. I listen continuously and decide for myself when to speak. My spoken " +
        "replies use an AI-generated voice. Nothing said in voice " +
        "can ever approve privileged actions. Use **/clankie voice-consent opt-in** to let me " +
        "hear you and **/clankie voice-consent opt-out** to revoke immediately.",
    );
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

  it("discloses full local transcript retention when the owner enables it", () => {
    const disclosure = renderVoiceJoinDisclosure(1, "openai", "explicit", "openai", true);
    expect(disclosure).toContain("Exact consented speech and speaker attribution are retained");
    expect(disclosure).toContain("private local development transcript log");

    const optIn = renderVoiceConsentReply(true, 2, "openai", "explicit", "openai", true);
    expect(optIn).toContain("Exact consented speech and speaker attribution are retained");

    const status = renderVoiceStatusReply(undefined, true, "explicit", "openai", true);
    expect(status).toContain("Full local transcript logging is enabled");
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

  it("names xAI and its audio handling when Grok Voice is selected", () => {
    const disclosure = renderVoiceJoinDisclosure(1, "openai", "explicit", "xai");
    expect(disclosure).toContain("live xAI Voice sessions");
    expect(disclosure).toContain("processed in real time and is not stored");
    expect(disclosure).not.toContain("OpenAI");

    const status = renderVoiceStatusReply(undefined, true, "explicit", "xai");
    expect(status).toBe("Voice is enabled but not connected.");
  });

  it("discloses the three separate Anthropic voice data paths at join and consent", () => {
    for (const disclosure of [
      renderVoiceJoinDisclosure(1, "elevenlabs", "explicit", "anthropic"),
      renderVoiceConsentReply(true, 2, "elevenlabs", "explicit", "anthropic"),
    ]) {
      expect(disclosure).toContain("audio is transcribed by OpenAI");
      expect(disclosure).toContain(
        "transcript text and this call's conversation context are sent to Anthropic",
      );
      expect(disclosure).toContain("audio is never sent to Anthropic");
      expect(disclosure).toContain("synthesized by ElevenLabs");
      expect(disclosure).toContain("audio is never sent to ElevenLabs");
      expect(disclosure).toContain("privileged actions");
      expect(disclosure).not.toContain("live OpenAI realtime session");
    }
  });

  it("describes bounded local and server-side retention in voice-status", () => {
    const active = renderVoiceStatusReply(
      {
        active: true,
        outputMuted: false,
        activity: "idle",
        handoffCount: 0,
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
          outputMuted: false,
          activity: "idle",
          handoffCount: 0,
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
        outputMuted: false,
        activity: "idle",
        handoffCount: 0,
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
