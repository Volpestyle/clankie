import {
  DISCORD_PRESENCE_CATALOG,
  discordPresenceLaneAddress,
  isDiscordPresenceActionAvailable,
} from "../src/index.ts";
import { DiscordPresenceSessionRecordSchema, type DiscordPresenceSessionRecord } from "../src/index.ts";
import type { DiscordTransportKind } from "@clankie/protocol";
import { describe, expect, it } from "vitest";

describe("Discord transport bindings", () => {
  it("carries the ordinary social catalog on both bodies", () => {
    const shared = [
      "discord.presence.reply",
      "discord.presence.react",
      "discord.presence.send_message",
      "discord.presence.typing_start",
      "discord.presence.voice_join",
    ] as const;
    for (const action of shared) {
      expect(
        isDiscordPresenceActionAvailable({ action, session: session("present", "bot") }),
        `${action} on bot`,
      ).toBe(true);
      expect(
        isDiscordPresenceActionAvailable({ action, session: session("present", "user_session") }),
        `${action} on user session`,
      ).toBe(true);
    }
  });

  it("keeps embedded activities on the bot application and Go Live on the user session", () => {
    expect(
      isDiscordPresenceActionAvailable({
        action: "discord.presence.activity_start",
        session: session("voice_active", "bot"),
      }),
    ).toBe(true);
    expect(
      isDiscordPresenceActionAvailable({
        action: "discord.presence.activity_start",
        session: session("voice_active", "user_session"),
      }),
    ).toBe(false);
    expect(
      isDiscordPresenceActionAvailable({
        action: "discord.presence.go_live_start",
        session: session("voice_active", "user_session"),
      }),
    ).toBe(true);
    expect(
      isDiscordPresenceActionAvailable({
        action: "discord.presence.go_live_start",
        session: session("voice_active", "bot"),
      }),
    ).toBe(false);
  });

  it("declares exactly one transport list per catalogued action", () => {
    for (const entry of DISCORD_PRESENCE_CATALOG) {
      expect(entry.transports.length, entry.action).toBeGreaterThan(0);
      expect(new Set(entry.transports).size, entry.action).toBe(entry.transports.length);
    }
  });

  it("addresses one lane per channel so a body swap continues the same conversation", () => {
    // The load-bearing property for "same stream of consciousness": the address
    // is derived from where the conversation is, not from who observed it.
    const guild = discordPresenceLaneAddress({ guildId: "guild-1", channelId: "channel-1" });
    expect(guild).toBe("discord:guild-1:channel-1");
    expect(discordPresenceLaneAddress({ guildId: "guild-1", channelId: "channel-1" })).toBe(guild);
    expect(discordPresenceLaneAddress({ channelId: "dm-1" })).toBe("discord:dm:dm-1");
    expect(discordPresenceLaneAddress({ guildId: undefined, channelId: "dm-1" })).toBe("discord:dm:dm-1");
  });
});

function session(
  phase: "present" | "voice_active",
  transportKind: DiscordTransportKind,
): DiscordPresenceSessionRecord {
  return DiscordPresenceSessionRecordSchema.parse({
    schemaVersion: 1,
    sessionId: `discord:${transportKind}:fixture`,
    characterId: "clankie",
    credentialRef: transportKind === "bot" ? "discord_bot" : "discord_user_session",
    transportKind,
    phase,
    gatewayConnected: true,
    voiceGuildIds: phase === "voice_active" ? ["guild-1"] : [],
    revision: 1,
    updatedAt: "2026-07-25T18:00:00.000Z",
  });
}
