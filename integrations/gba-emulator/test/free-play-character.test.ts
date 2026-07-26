import { describe, expect, it } from "vitest";
import { FREE_PLAY_SYSTEM_PROMPT, renderView } from "../src/free-play-mind.ts";
import type { FreePlayView } from "../src/free-play.ts";

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

describe("volition cold start", () => {
  it("tells him he has not spoken yet", () => {
    // The signal that prompts a first remark must exist before the first
    // remark. Rendering it only once turnsSinceSpoke was non-null made it
    // unreachable, and the measured rate was 0 of 12 turns.
    const prompt = renderView(viewWith({ turn: 7, turnsSinceSpoke: null }));
    expect(prompt).toContain("not said anything out loud yet");
    expect(prompt).toContain("7 turns in");
  });

  it("reports the gap once he has spoken", () => {
    const prompt = renderView(viewWith({ turn: 9, turnsSinceSpoke: 3 }));
    expect(prompt).toContain("last said something 3 turns ago");
  });
});

function viewWith(overrides: Partial<FreePlayView>): FreePlayView {
  return {
    turn: 1,
    observations: [],
    framePng: null,
    refusedHere: [],
    notes: null,
    objective: null,
    interjection: null,
    turnsSinceSpoke: null,
    audience: null,
    history: [],
    ...overrides,
  } as FreePlayView;
}
