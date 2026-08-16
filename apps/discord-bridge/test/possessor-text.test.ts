import { describe, expect, it } from "vitest";
import { POSSESSOR_UTTERANCE_MAX_CHARS } from "@clankie/possessor-voice";
import { possessorRoomText, type PossessorRoomTextMessage } from "../src/possessor-text.ts";

const gate = {
  ingressGuildIds: new Set(["guild-1"]),
  ingressChannelIds: new Set(["channel-1"]),
};

function message(overrides: Partial<PossessorRoomTextMessage> = {}): PossessorRoomTextMessage {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    authorIsBot: false,
    body: "the center is south, not northeast",
    ...overrides,
  };
}

describe("possessorRoomText", () => {
  it("carries a line from an admitted channel", () => {
    expect(possessorRoomText(gate, message())).toBe("the center is south, not northeast");
  });

  it("carries a line nobody addressed to him", () => {
    // The voice seam pushes every line the room says; requiring his name here
    // would strand the shortest, most useful steer someone types.
    expect(possessorRoomText(gate, message({ body: "go south" }))).toBe("go south");
  });

  it("admits every channel of an allowlisted guild when no channel list is set", () => {
    const open = { ingressGuildIds: new Set(["guild-1"]), ingressChannelIds: new Set<string>() };
    expect(possessorRoomText(open, message({ channelId: "channel-9" }))).toBe(
      "the center is south, not northeast",
    );
  });

  it("refuses everything the ingress allowlist refuses", () => {
    expect(possessorRoomText(gate, message({ authorIsBot: true }))).toBeNull();
    expect(possessorRoomText(gate, message({ guildId: "guild-2" }))).toBeNull();
    expect(possessorRoomText(gate, message({ channelId: "channel-2" }))).toBeNull();
    // A DM is a conversation with him, not the room he plays in front of.
    expect(possessorRoomText(gate, message({ guildId: null }))).toBeNull();
  });

  it("refuses a message with no words in it", () => {
    // An image post carries no steer, and an empty utterance fails the seam's
    // own `min(1)` on the far side.
    expect(possessorRoomText(gate, message({ body: "   " }))).toBeNull();
  });

  it("truncates rather than letting the far side drop an over-long line", () => {
    const line = possessorRoomText(gate, message({ body: "x".repeat(POSSESSOR_UTTERANCE_MAX_CHARS + 500) }));
    expect(line).toHaveLength(POSSESSOR_UTTERANCE_MAX_CHARS);
  });
});
