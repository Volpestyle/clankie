import { describe, expect, it } from "vitest";
import { phoneticKey, voiceAddressesCharacter } from "../src/voice-address.ts";

// The tolerance must come from the phonetics, not from a padded alias list, so
// most cases run against the display name alone.
const displayNameOnly = ["clankie"];

// What characterNames(persona) actually produces: displayName + owner aliases.
const characterNamesList = ["clankie", "clanky", "clank"];

describe("phoneticKey", () => {
  it("collapses transcription variants of the name onto one skeleton", () => {
    const key = phoneticKey("clankie");
    for (const heard of ["clanky", "clankee", "klankie", "clanki"]) {
      expect(phoneticKey(heard)).toBe(key);
    }
  });

  it("keeps consonant differences distinct", () => {
    expect(phoneticKey("blankie")).not.toBe(phoneticKey("clankie"));
    expect(phoneticKey("clankiest")).not.toBe(phoneticKey("clankie"));
  });
});

describe("voiceAddressesCharacter", () => {
  it("wakes on the ways a transcriber actually garbles the name", () => {
    expect(voiceAddressesCharacter("hey clanky what are you up to", displayNameOnly)).toBe(true);
    expect(voiceAddressesCharacter("clankee are you there", displayNameOnly)).toBe(true);
    expect(voiceAddressesCharacter("i think klankie broke the build", displayNameOnly)).toBe(true);
    expect(voiceAddressesCharacter("ask clanki about it", displayNameOnly)).toBe(true);
    expect(voiceAddressesCharacter("that is clankie's job", displayNameOnly)).toBe(true);
  });

  it("survives capitalization and punctuation", () => {
    expect(voiceAddressesCharacter("Clanky?!", displayNameOnly)).toBe(true);
    expect(voiceAddressesCharacter("...Klankie, hello?", displayNameOnly)).toBe(true);
  });

  it("does not fire on the name buried in a longer word", () => {
    expect(voiceAddressesCharacter("that was the clankiest thing i have seen", displayNameOnly)).toBe(false);
  });

  it("does not fire on a different leading consonant", () => {
    expect(voiceAddressesCharacter("where is my blankie", displayNameOnly)).toBe(false);
    expect(voiceAddressesCharacter("tell flankie i said hi", displayNameOnly)).toBe(false);
  });

  it("stays quiet for ordinary conversation and empty input", () => {
    expect(voiceAddressesCharacter("anyway the deploy finished", displayNameOnly)).toBe(false);
    expect(voiceAddressesCharacter("", displayNameOnly)).toBe(false);
  });

  it("never matches when no names are configured", () => {
    expect(voiceAddressesCharacter("clankie", [])).toBe(false);
  });

  it("answers to any name in a characterNames-style list", () => {
    expect(voiceAddressesCharacter("yo clank you hear that", characterNamesList)).toBe(true);
    expect(voiceAddressesCharacter("clanky has opinions i bet", characterNamesList)).toBe(true);
  });
});
