import { describe, expect, it } from "vitest";
import { evaluateStreamWatchLiveProof } from "../src/live-proof.ts";
import type { DiscordBridgeReceipt } from "@clankie/discord-presence-core";

function receipt(
  type: DiscordBridgeReceipt["type"],
  data: DiscordBridgeReceipt["data"],
): DiscordBridgeReceipt {
  return {
    schemaVersion: 1,
    id: `r-${type}`,
    occurredAt: "2026-08-15T00:00:00.000Z",
    type,
    data,
  };
}

describe("stream-watch live proof", () => {
  it("passes only when a real still was decoded through ClankVox", () => {
    const report = evaluateStreamWatchLiveProof([
      receipt("discord.user_session.ready", { userId: "self" }),
      receipt("discord.stream.watch_connected", { userId: "human", channelId: "voice", decoder: "ready" }),
      receipt("discord.stream.frame", { userId: "human", width: 1280, height: 720 }),
    ]);
    expect(report.passed).toBe(true);
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it("is incomplete without a decoded still, even if a share was listed", () => {
    const report = evaluateStreamWatchLiveProof([
      receipt("discord.user_session.ready", {}),
      receipt("discord.stream.watch_connected", { decoder: "missing" }),
    ]);
    expect(report.passed).toBe(false);
    expect(report.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      "ClankVox decoder present",
      "decoded still",
    ]);
  });

  it("rejects a still that predates the watch or belongs to a different user", () => {
    const stale = evaluateStreamWatchLiveProof([
      receipt("discord.user_session.ready", {}),
      {
        schemaVersion: 1,
        id: "old-frame",
        occurredAt: "2026-08-14T00:00:00.000Z",
        type: "discord.stream.frame",
        data: { userId: "human", width: 1280, height: 720 },
      },
      receipt("discord.stream.watch_connected", { userId: "human", decoder: "ready" }),
    ]);
    expect(stale.passed).toBe(false);

    const mismatched = evaluateStreamWatchLiveProof([
      receipt("discord.user_session.ready", {}),
      receipt("discord.stream.watch_connected", { userId: "human", decoder: "ready" }),
      receipt("discord.stream.frame", { userId: "someone-else", width: 1280, height: 720 }),
    ]);
    expect(mismatched.passed).toBe(false);
  });
});
