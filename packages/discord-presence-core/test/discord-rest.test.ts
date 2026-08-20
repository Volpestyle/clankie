import { describe, expect, it } from "vitest";
import { encodeReactionEmoji } from "../src/discord-rest.ts";

describe("encodeReactionEmoji", () => {
  it("encodes supported reactions and rejects malformed custom emoji", () => {
    expect(encodeReactionEmoji("👍")).toBe(encodeURIComponent("👍"));
    expect(encodeReactionEmoji("clankie:123456789012345678")).toBe("clankie:123456789012345678");
    expect(encodeReactionEmoji("<:clankie:123456789012345678>")).toBe("clankie:123456789012345678");
    expect(encodeReactionEmoji("<a:wave:99>")).toBe("wave:99");
    expect(() => encodeReactionEmoji("<:bad>")).toThrow(/discord_presence_invalid_emoji/);
    expect(() => encodeReactionEmoji("not:a:valid:emoji")).toThrow(/discord_presence_invalid_emoji/);
  });
});
