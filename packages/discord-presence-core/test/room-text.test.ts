import { describe, expect, it } from "vitest";
import {
  admittedDiscordRoomText,
  DISCORD_ROOM_TEXT_MAX_CHARS,
  routeDiscordRoomText,
  type DiscordRoomTextMessage,
  type DiscordVoiceRoomTextInput,
} from "../src/room-text.ts";

const gate = {
  guildIds: new Set(["guild-1"]),
  channelIds: new Set(["channel-1"]),
};

function message(overrides: Partial<DiscordRoomTextMessage> = {}): DiscordRoomTextMessage {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    authorIsBot: false,
    body: "the center is south, not northeast",
    ...overrides,
  };
}

describe("admittedDiscordRoomText", () => {
  it("carries addressed and ambient lines from an admitted room", () => {
    expect(admittedDiscordRoomText(gate, message())).toBe("the center is south, not northeast");
    expect(admittedDiscordRoomText(gate, message({ body: "go south" }))).toBe("go south");
  });

  it("admits every channel of an allowlisted guild when no channel list is set", () => {
    const open = { guildIds: new Set(["guild-1"]), channelIds: new Set<string>() };
    expect(admittedDiscordRoomText(open, message({ channelId: "channel-9" }))).toBe(
      "the center is south, not northeast",
    );
  });

  it("refuses bots, DMs, and rooms outside the ingress allowlist", () => {
    expect(admittedDiscordRoomText(gate, message({ authorIsBot: true }))).toBeNull();
    expect(
      admittedDiscordRoomText(gate, {
        channelId: "channel-1",
        authorIsBot: false,
        body: "private message",
      }),
    ).toBeNull();
    expect(admittedDiscordRoomText(gate, message({ guildId: "guild-2" }))).toBeNull();
    expect(admittedDiscordRoomText(gate, message({ channelId: "channel-2" }))).toBeNull();
  });

  it("refuses empty input and bounds a long line", () => {
    expect(admittedDiscordRoomText(gate, message({ body: "   " }))).toBeNull();
    expect(
      admittedDiscordRoomText(gate, message({ body: "x".repeat(DISCORD_ROOM_TEXT_MAX_CHARS + 500) })),
    ).toHaveLength(DISCORD_ROOM_TEXT_MAX_CHARS);
  });
});

describe("routeDiscordRoomText", () => {
  it("offers an admitted text-only message to voice with gateway attribution", () => {
    const received: DiscordVoiceRoomTextInput[] = [];
    const route = routeDiscordRoomText(
      gate,
      {
        ...message(),
        userId: "user-1",
        displayName: "James",
        deliveryId: "message-1",
        hasAttachments: false,
      },
      {
        receiveRoomText(input) {
          received.push(input);
          return true;
        },
      },
    );

    expect(route).toEqual({ text: "the center is south, not northeast", voiceOwned: true });
    expect(received).toEqual([
      {
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        displayName: "James",
        deliveryId: "message-1",
        text: "the center is south, not northeast",
      },
    ]);
  });

  it("keeps attachments on text ingress and never offers refused input to voice", () => {
    let calls = 0;
    const voice = {
      receiveRoomText() {
        calls += 1;
        return true;
      },
    };
    expect(
      routeDiscordRoomText(
        gate,
        { ...message(), userId: "user-1", deliveryId: "message-1", hasAttachments: true },
        voice,
      ),
    ).toEqual({ text: "the center is south, not northeast", voiceOwned: false });
    expect(
      routeDiscordRoomText(
        gate,
        {
          ...message({ channelId: "elsewhere" }),
          userId: "user-1",
          deliveryId: "message-2",
          hasAttachments: false,
        },
        voice,
      ),
    ).toEqual({ text: null, voiceOwned: false });
    expect(calls).toBe(0);
  });
});
