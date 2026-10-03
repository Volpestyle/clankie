import { expect, it } from "vitest";
import type { DiscordVoiceEvidence } from "@clankie/protocol";
import { voiceRoomEvidence } from "../src/voice-room-evidence.ts";
const source = { presenceSessionId: "original-body", transportKind: "bot" as const };
const scope = {
  stayId: "stay",
  guildId: "guild",
  channelId: "room",
  userId: "speaker",
  deliveryId: "utterance",
};
it("counts confirmed audible room drain but never model audio completion or unbound/ambient output", () => {
  const response: Extract<DiscordVoiceEvidence, { type: "response" }> = {
    ...scope,
    type: "response",
    playbackId: "played",
    state: "settled",
    fastPath: true,
    trigger: "room",
    wake: "continuing",
    toFirstAudioMs: 1,
    handoffMs: 0,
    playbackMs: 20,
  };
  expect(voiceRoomEvidence(response, source)).toEqual([
    {
      ...source,
      voiceStayId: "stay",
      guildId: "guild",
      channelId: "room",
      actorId: "speaker",
      deliveryId: "utterance",
      id: "utterance:settled",
      outcome: "settled",
    },
  ]);
  expect(
    voiceRoomEvidence({ ...scope, type: "model_response", phase: "completed", outcome: "audio" }, source),
  ).toEqual([]);
  expect(voiceRoomEvidence({ ...response, trigger: "narration" }, source)).toEqual([]);
  const { stayId: _stayId, ...unbound } = response;
  expect(voiceRoomEvidence(unbound, source)).toEqual([]);
  const { userId: _userId, ...unattributed } = response;
  expect(voiceRoomEvidence(unattributed, source)).toEqual([]);
  expect(
    voiceRoomEvidence({ ...response, state: "waiting_user" }, source).map((entry) => entry.outcome),
  ).toEqual(["settled", "escalated"]);
});
it("records accepted input and explicit silence/failure without carrying words", () => {
  expect(
    voiceRoomEvidence({ ...scope, type: "text_input", characters: 99, addressed: true }, source)[0]?.outcome,
  ).toBe("accepted");
  expect(
    voiceRoomEvidence({ ...scope, type: "model_response", phase: "completed", outcome: "silent" }, source),
  ).toEqual([]);
  expect(
    voiceRoomEvidence(
      { ...scope, type: "failed", stage: "playback", code: "voice_playback_timeout" },
      source,
    )[0],
  ).toMatchObject({ outcome: "failed", reason: "voice_playback_timeout" });
  expect(voiceRoomEvidence({ ...scope, type: "utterance", durationMs: 10, filtered: true }, source)).toEqual(
    [],
  );
});
