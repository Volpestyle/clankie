import { describe, expect, it } from "vitest";
import { classifyVoiceAddress, phoneticKey, voiceAddressesCharacter } from "../src/voice-address.ts";

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

describe("classifyVoiceAddress", () => {
  it("treats a clean hail as addressed", () => {
    expect(classifyVoiceAddress("hey clanky what are you up to", displayNameOnly)).toBe("addressed");
    expect(classifyVoiceAddress("clankee are you there", displayNameOnly)).toBe("addressed");
    expect(classifyVoiceAddress("thanks klankie", displayNameOnly)).toBe("addressed");
    expect(classifyVoiceAddress("clanki hold on a second", displayNameOnly)).toBe("addressed");
    expect(classifyVoiceAddress("clankie run the tests", displayNameOnly)).toBe("addressed");
    expect(classifyVoiceAddress("what do you think clanky", characterNamesList)).toBe("addressed");
  });

  it("offers on a name hit that a word list would have dropped", () => {
    expect(classifyVoiceAddress("clankie is that thing on", displayNameOnly)).toBe("mentioned");
    expect(classifyVoiceAddress("clankie does that work", displayNameOnly)).toBe("mentioned");
    expect(classifyVoiceAddress("clankie was that a shiny", displayNameOnly)).toBe("mentioned");
    expect(classifyVoiceAddress("clankie just tell me the score", displayNameOnly)).toBe("mentioned");
    expect(classifyVoiceAddress("alright clankie go ahead", displayNameOnly)).toBe("mentioned");
    expect(classifyVoiceAddress("clankie did you see that", displayNameOnly)).toBe("mentioned");
    expect(classifyVoiceAddress("i think klankie broke the build", displayNameOnly)).toBe("mentioned");
  });

  it("ignores talk that is clearly about him or aimed at someone else", () => {
    expect(classifyVoiceAddress("ask clanki about it", displayNameOnly)).toBe("none");
    expect(classifyVoiceAddress("that is clankie's job", displayNameOnly)).toBe("none");
    expect(classifyVoiceAddress("bob can you ask clankie about it", displayNameOnly)).toBe("none");
    expect(classifyVoiceAddress("hey bob what did clankie say to you", displayNameOnly)).toBe("none");
    expect(classifyVoiceAddress("bob you should show clankie your build", displayNameOnly)).toBe("none");
    expect(classifyVoiceAddress("bob did you finish that thing", displayNameOnly)).toBe("none");
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
    expect(classifyVoiceAddress("clanky has opinions i bet", characterNamesList)).toBe("mentioned");
    expect(voiceAddressesCharacter("what do you think clanky", characterNamesList)).toBe(true);
  });
});
