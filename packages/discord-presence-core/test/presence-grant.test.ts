import { describe, expect, it } from "vitest";
import { presenceActGrantRequest } from "../src/presence-grant.ts";

describe("presence act grant request", () => {
  it("fills guild and channel from the payload and keeps the missionId fallback", () => {
    expect(
      presenceActGrantRequest({
        schemaVersion: 1,
        idempotencyKey: "write-1",
        action: "discord.presence.send_message",
        identity: {
          presenceSessionId: "discord:guild:channel",
          correlationId: "corr-1",
          profileHash: "profile-1",
          characterId: "clankie",
          credentialRef: "discord_bot",
          transportKind: "bot",
        },
        payload: { kind: "send_message", channelId: "channel-1", content: "hi" },
      }),
    ).toEqual({
      principalId: "clankie",
      missionId: "discord-presence:discord:guild:channel",
      profileHash: "profile-1",
      capability: "discord.presence.act",
      guildIds: [],
      channelIds: ["channel-1"],
    });
  });
});
