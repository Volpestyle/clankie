import { expect, it } from "vitest";
import { runDiscordCommand } from "../src/command/discord.ts";

it("reads retained speech through the authenticated API with validated paging", async () => {
  const response = {
    schemaVersion: 1,
    enabled: true,
    entries: [
      {
        schemaVersion: 1,
        body: "bot",
        occurredAt: "2026-09-29T05:00:00.000Z",
        guildId: "12345",
        channelId: "67890",
        deliveryId: "d1",
        role: "assistant",
        speakerId: "clankie",
        itemId: "i1",
        text: "Here.",
        textSource: "tts_text",
        textComplete: true,
        outcome: "played",
        audioStarted: true,
        playbackMs: 500,
      },
    ],
    nextCursor: "000000000002",
    hasMore: false,
  };
  const options = {
    env: { CLANKIE_CAPTAIN_TOKEN: "test-captain" },
    fetchImpl: async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toContain("/v1/discord/voice-transcripts?limit=10&cursor=000000000001");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-captain");
      return Response.json(response);
    },
  };
  expect(
    await runDiscordCommand(["transcripts", "--limit", "10", "--cursor", "000000000001"], options),
  ).toEqual(response);
  await expect(runDiscordCommand(["transcripts", "--limit", "201"], options)).rejects.toThrow("Usage");
  await expect(runDiscordCommand(["transcripts", "--cursor", "invalid"], options)).rejects.toThrow("Usage");
});
