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
      "discord.presence.tool_progress",
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

describe("Discord presence voice rooms", () => {
  it("parses a record whose named rooms mirror voiceGuildIds and keeps them optional", () => {
    const base = session("voice_active", "bot");
    const named = DiscordPresenceSessionRecordSchema.parse({
      ...base,
      voiceRooms: [
        {
          guildId: "guild-1",
          guildName: "Vuhlp",
          channelId: "chan-7",
          channelName: "General",
          occupants: [{ userId: "u1", displayName: "James" }],
        },
      ],
    });
    expect(named.voiceRooms?.[0]?.guildName).toBe("Vuhlp");
    // Records published before the field existed still parse.
    expect(base.voiceRooms).toBeUndefined();
  });

  it("rejects rooms that diverge from voiceGuildIds in membership or order", () => {
    const base = session("voice_active", "bot");
    expect(
      DiscordPresenceSessionRecordSchema.safeParse({
        ...base,
        voiceRooms: [{ guildId: "guild-9", occupants: [] }],
      }).success,
    ).toBe(false);
    expect(
      DiscordPresenceSessionRecordSchema.safeParse({
        ...base,
        voiceGuildIds: ["guild-1", "guild-2"],
        voiceRooms: [
          { guildId: "guild-2", occupants: [] },
          { guildId: "guild-1", occupants: [] },
        ],
      }).success,
    ).toBe(false);
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
