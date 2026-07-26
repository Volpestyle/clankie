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
      { type: "floor", ...scope, state: "engaged", reason: "addressed" },
      { type: "floor", ...scope, state: "dormant", reason: "decay" },
      fastPathResponse,
      abilityResponse,
      { type: "volition", ...scope, offered: 4, taken: 1, suppressed: 3 },
      { type: "overlap", ...scope, userId: "user-2", activeCaptureCount: 2 },
      { type: "interrupted", ...scope, userId: "user-1", phase: "playing" },
      { type: "failed", ...scope, stage: "captain_handoff", code: "voice_captain_turn_failed" },
      { type: "left", ...scope },
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
