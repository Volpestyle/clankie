import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readVoiceSpeechSnapshot } from "../src/voice-receipt-activity.ts";

const room = { guildId: "guild-1", channelId: "channel-1" } as const;

function receipt(type: string, occurredAt: string, data: Record<string, string | number | boolean>): string {
  return JSON.stringify({ schemaVersion: 1, id: occurredAt, occurredAt, type, data });
}

describe("readVoiceSpeechSnapshot", () => {
  it("returns an empty snapshot when the receipt file does not exist", async () => {
    expect(await readVoiceSpeechSnapshot(join(tmpdir(), "missing-voice-receipts.jsonl"), 8)).toEqual({
      recent: [],
    });
  });

  it("summarizes spoken and suppressed receipts for the open stay", async () => {
    const root = await mkdtemp(join(tmpdir(), "voice-receipt-activity-"));
    const path = join(root, "receipts.jsonl");
    await writeFile(
      path,
      [
        receipt("discord.voice.joined", "2026-08-15T20:45:00.000Z", {
          ...room,
          stayId: "stay-1",
          daveProtocolVersion: 1,
        }),
        receipt("discord.voice.response", "2026-08-15T20:45:10.000Z", {
          ...room,
          stayId: "stay-1",
          deliveryId: "play-turn-1",
          trigger: "narration",
          wake: "waking",
          playbackMs: 8000,
          toFirstAudioMs: 400,
          inputTokens: 100,
          outputTokens: 20,
        }),
        receipt("discord.voice.possessor_narration_suppressed", "2026-08-15T20:45:12.000Z", {
          ...room,
          stayId: "stay-1",
          deliveryId: "play-turn-2",
          reason: "rate_limited",
        }),
        receipt("discord.voice.utterance", "2026-08-15T20:45:13.000Z", {
          ...room,
          userId: "user-1",
          durationMs: 900,
        }),
      ].join("\n"),
      "utf8",
    );

    const snapshot = await readVoiceSpeechSnapshot(path, 12, room);
    expect(snapshot.currentStay).toEqual({
      stayId: "stay-1",
      spoken: 1,
      suppressed: 1,
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(snapshot.recent).toMatchObject([
      { kind: "spoken", deliveryId: "play-turn-1", trigger: "narration", playbackMs: 8000 },
      { kind: "suppressed", deliveryId: "play-turn-2", reason: "rate_limited" },
    ]);
  });

  it("does not treat a closed stay as current", async () => {
    const root = await mkdtemp(join(tmpdir(), "voice-receipt-activity-closed-"));
    const path = join(root, "receipts.jsonl");
    await writeFile(
      path,
      [
        receipt("discord.voice.joined", "2026-08-15T20:00:00.000Z", { ...room, stayId: "stay-old" }),
        receipt("discord.voice.response", "2026-08-15T20:01:00.000Z", {
          ...room,
          stayId: "stay-old",
          deliveryId: "old-1",
        }),
        receipt("discord.voice.left", "2026-08-15T20:02:00.000Z", { ...room, stayId: "stay-old" }),
      ].join("\n"),
      "utf8",
    );

    const snapshot = await readVoiceSpeechSnapshot(path, 12, room);
    expect(snapshot.currentStay).toBeUndefined();
    expect(snapshot.recent).toHaveLength(1);
  });
});
