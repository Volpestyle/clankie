import { describe, expect, it } from "vitest";
import { FREE_PLAY_SYSTEM_PROMPT } from "../src/free-play-mind.ts";

describe("free-play system prompt", () => {
  it("describes the surface without declaring who is playing", () => {
    // The character layer owns identity (ADR 0051). A "You are <name>" here
    // would be a second definition of Clankie — and this is the one an audience
    // hears while he is on stream.
    expect(FREE_PLAY_SYSTEM_PROMPT).not.toMatch(/You are Clankie/u);
    expect(FREE_PLAY_SYSTEM_PROMPT).toContain("You are playing Pokémon FireRed yourself.");
  });

  it("still carries the rules of the surface", () => {
    expect(FREE_PLAY_SYSTEM_PROMPT).toContain("monologue");
    expect(FREE_PLAY_SYSTEM_PROMPT).toContain("objective");
    expect(FREE_PLAY_SYSTEM_PROMPT).toContain("button_press");
  });
});
