import { describe, expect, it } from "vitest";
import { DiscordVoiceEvidenceSchema } from "../src/index.ts";

const scope = { guildId: "guild-1", channelId: "channel-1" } as const;

const fastPathResponse = {
  type: "response",
  ...scope,
  deliveryId: "delivery-1",
  state: "settled",
  fastPath: true,
  wake: "waking",
  toFirstAudioMs: 640,
  handoffMs: 0,
  playbackMs: 2_400,
} as const;

const abilityResponse = {
  type: "response",
  ...scope,
  deliveryId: "delivery-2",
  turnId: "turn-1",
  state: "waiting_user",
  fastPath: false,
  wake: "continuing",
  toFirstAudioMs: 180,
  handoffMs: 4_100,
  playbackMs: 3_050,
} as const;

describe("Discord voice evidence (ADR 0057)", () => {
  it("parses every evidence variant", () => {
    const variants = [
      { type: "joined", ...scope, daveProtocolVersion: 1 },
      { type: "consent", ...scope, userId: "user-1", consented: true, participantCount: 3 },
      { type: "utterance", ...scope, userId: "user-1", deliveryId: "delivery-1", durationMs: 1_150 },
      {
        type: "transcription",
        ...scope,
        userId: "user-1",
        deliveryId: "delivery-1",
        outcome: "accepted",
        characters: 18,
        latencyMs: 240,
        addressed: true,
      },
      {
        type: "floor_decision",
        ...scope,
        userId: "user-1",
        deliveryId: "delivery-1",
        action: "wake",
        reason: "addressed",
        state: "engaged",
      },
      { type: "floor", ...scope, state: "engaged", reason: "addressed" },
      { type: "floor", ...scope, state: "dormant", reason: "decay" },
      {
        type: "model_response",
        ...scope,
        deliveryId: "delivery-1",
        userId: "user-1",
        phase: "completed",
        outcome: "tool",
        responseId: "response-1",
        audioBytes: 0,
        textCharacters: 0,
      },
      {
        type: "realtime_tool",
        ...scope,
        deliveryId: "delivery-1",
        userId: "user-1",
        callId: "call-1",
        name: "music_play",
        phase: "completed",
      },
      {
        type: "music",
        ...scope,
        deliveryId: "delivery-1",
        callId: "call-1",
        source: "realtime",
        operation: "play",
        component: "player",
        outcome: "playing",
        current: true,
        queuedCount: 0,
        paused: false,
      },
      fastPathResponse,
      abilityResponse,
      { type: "volition", ...scope, offered: 4, taken: 1, suppressed: 3 },
      { type: "overlap", ...scope, userId: "user-2", activeCaptureCount: 2 },
      { type: "interrupted", ...scope, userId: "user-1", phase: "playing" },
      { type: "failed", ...scope, stage: "captain_handoff", code: "voice_captain_turn_failed" },
      {
        type: "left",
        ...scope,
        stayId: "stay-1",
        inputTokens: 120,
        outputTokens: 40,
        spokenCount: 2,
        narrationSuppressed: 5,
      },
      { type: "possessor_connection", phase: "attached", attachedCount: 1 },
      { type: "possessor_room", listening: true, attachedCount: 1, deliveredCount: 1 },
      {
        type: "possessor_transcript_delivery",
        deliveryId: "possessor-delivery-1",
        attachedCount: 1,
        deliveredCount: 1,
      },
      { type: "possessor_narration_submission", deliveryId: "possessor-delivery-2", attachedCount: 1 },
      {
        type: "possessor_narration_suppressed",
        ...scope,
        stayId: "stay-1",
        deliveryId: "possessor-delivery-4",
        reason: "rate_limited",
      },
      {
        type: "possessor_refusal",
        deliveryId: "possessor-delivery-3",
        attachedCount: 1,
        reason: "voice_narration_not_in_channel",
      },
    ] as const;
    for (const variant of variants) {
      expect(DiscordVoiceEvidenceSchema.parse(variant)).toEqual(variant);
    }
  });

  it("keeps waking and continuing first-audio latency separately reportable", () => {
    expect(DiscordVoiceEvidenceSchema.parse(fastPathResponse)).toMatchObject({
      wake: "waking",
      toFirstAudioMs: 640,
    });
    expect(DiscordVoiceEvidenceSchema.parse(abilityResponse)).toMatchObject({
      wake: "continuing",
      toFirstAudioMs: 180,
    });
    expect(() => DiscordVoiceEvidenceSchema.parse({ ...fastPathResponse, wake: "warm" })).toThrow();
  });

  it("ties the captain turn id and the handoff cost to the ask_clankie path", () => {
    expect(() => DiscordVoiceEvidenceSchema.parse({ ...fastPathResponse, turnId: "turn-1" })).toThrow(
      "no captain turn",
    );
    expect(() => DiscordVoiceEvidenceSchema.parse({ ...fastPathResponse, handoffMs: 12 })).toThrow(
      "no captain handoff",
    );
    expect(() => DiscordVoiceEvidenceSchema.parse({ ...abilityResponse, turnId: undefined })).toThrow(
      "carry the captain turn id",
    );
  });

  it("makes free text unrepresentable", () => {
    expect(() =>
      DiscordVoiceEvidenceSchema.parse({ ...abilityResponse, transcript: "private words" }),
    ).toThrow();
    expect(() =>
      DiscordVoiceEvidenceSchema.parse({ ...fastPathResponse, note: "he sounded happy" }),
    ).toThrow();
    expect(() =>
      DiscordVoiceEvidenceSchema.parse({
        type: "music",
        ...scope,
        callId: "call-1",
        source: "realtime",
        operation: "play",
        component: "queue",
        outcome: "started",
        url: "https://youtu.be/private-choice",
      }),
    ).toThrow();
    expect(() =>
      DiscordVoiceEvidenceSchema.parse({
        type: "utterance",
        ...scope,
        userId: "user-1",
        deliveryId: "not an id at all",
        durationMs: 10,
      }),
    ).toThrow();
    expect(() =>
      DiscordVoiceEvidenceSchema.parse({ type: "left", guildId: "guild one", channelId: "channel-1" }),
    ).toThrow();
    expect(() =>
      DiscordVoiceEvidenceSchema.parse({
        type: "possessor_transcript_delivery",
        deliveryId: "possessor-delivery-1",
        attachedCount: 1,
        deliveredCount: 1,
        text: "speaker: private words",
      }),
    ).toThrow();
    expect(() =>
      DiscordVoiceEvidenceSchema.parse({
        type: "possessor_narration_submission",
        deliveryId: "possessor-delivery-2",
        attachedCount: 1,
        narration: "walked into a wall",
      }),
    ).toThrow();
  });

  it("leaves the cascade timings unrepresentable", () => {
    for (const legacy of ["silenceHoldMs", "transcribeMs", "captainMs", "synthesizeMs"]) {
      expect(() => DiscordVoiceEvidenceSchema.parse({ ...abilityResponse, [legacy]: 100 })).toThrow();
    }
  });

  it("rejects failure codes that are not machine tokens", () => {
    const failed = { type: "failed", ...scope, stage: "playback", code: "playback_timeout" } as const;
    expect(DiscordVoiceEvidenceSchema.parse(failed)).toEqual(failed);
    for (const code of ["Playback Timeout", "playback-timeout", "PLAYBACK", "x".repeat(65), ""]) {
      expect(() => DiscordVoiceEvidenceSchema.parse({ ...failed, code })).toThrow();
    }
  });

  it("keeps stay ids and token counts optional on responses", () => {
    expect(
      DiscordVoiceEvidenceSchema.parse({
        ...fastPathResponse,
        stayId: "stay-1",
        inputTokens: 800,
        outputTokens: 120,
      }),
    ).toMatchObject({ stayId: "stay-1", inputTokens: 800, outputTokens: 120 });
  });

  it("rejects numbers a receipt cannot carry", () => {
    expect(() => DiscordVoiceEvidenceSchema.parse({ ...fastPathResponse, toFirstAudioMs: -5 })).toThrow();
    expect(() =>
      DiscordVoiceEvidenceSchema.parse({ ...fastPathResponse, playbackMs: Number.POSITIVE_INFINITY }),
    ).toThrow();
    expect(() =>
      DiscordVoiceEvidenceSchema.parse({ type: "volition", ...scope, offered: 1.5, taken: 0, suppressed: 0 }),
    ).toThrow();
  });
});
