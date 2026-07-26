import { describe, expect, it } from "vitest";
import { addressesCharacter, parseDiscordReplyPolicy } from "../src/text-ingress.ts";

const names = ["clankie", "clanky", "clank"];

describe("addressesCharacter", () => {
  it("recognizes the name however humans actually type it", () => {
    expect(addressesCharacter("hey clankie", names)).toBe(true);
    expect(addressesCharacter("Hey Clanky", names)).toBe(true);
    expect(addressesCharacter("clankie?", names)).toBe(true);
    expect(addressesCharacter("yo, clank!", names)).toBe(true);
    expect(addressesCharacter("what do you reckon @Clankie", names)).toBe(true);
  });

  it("does not fire on a name buried inside a longer word", () => {
    // Otherwise "clankiest" or a stray url summons him.
    expect(addressesCharacter("that was the clankiest thing ive seen", names)).toBe(false);
    expect(addressesCharacter("check github.com/clankieproject/x", names)).toBe(false);
  });

  it("stays quiet for ordinary conversation", () => {
    expect(addressesCharacter("anyway dinner was great", names)).toBe(false);
    expect(addressesCharacter("", names)).toBe(false);
  });

  it("never matches when no names are configured", () => {
    expect(addressesCharacter("clankie", [])).toBe(false);
  });
});

describe("reply policy parsing", () => {
  it("falls back to the quiet policy for absent or unknown values", () => {
    expect(parseDiscordReplyPolicy(undefined)).toBe("addressed");
    expect(parseDiscordReplyPolicy("")).toBe("addressed");
    expect(parseDiscordReplyPolicy("everything")).toBe("addressed");
    expect(parseDiscordReplyPolicy("ALL")).toBe("addressed");
    expect(parseDiscordReplyPolicy("all")).toBe("all");
  });
});
