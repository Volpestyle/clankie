import { describe, expect, it } from "vitest";
import { PersonaSettingsSchema } from "../src/schema.ts";
import { characterNames, personaInstructions } from "../src/persona.ts";

const persona = (overrides: Partial<ReturnType<typeof PersonaSettingsSchema.parse>> = {}) =>
  PersonaSettingsSchema.parse({
    displayName: "Clankie",
    aliases: ["Clanky"],
    characterNotes: "Chaotic neutral. Roasts people, then helps them anyway.",
    ...overrides,
  });

describe("persona defaults", () => {
  it("lets the agent decide when to speak until an owner chooses addressed-only", () => {
    const parsed = PersonaSettingsSchema.parse({});
    expect(parsed.replyPolicy).toBe("all");
    expect(parsed.chattiness).toBe("balanced");
    expect(parsed.characterNotes).toBe("");
  });
});

describe("character names", () => {
  it("lowercases the display name and every alias", () => {
    expect(characterNames(persona())).toEqual(["clankie", "clanky"]);
  });
});

describe("persona instructions", () => {
  it("carries the owner-authored character verbatim", () => {
    const rendered = personaInstructions(persona(), "social");
    expect(rendered).toContain("Chaotic neutral. Roasts people, then helps them anyway.");
    expect(rendered).toContain("You also answer to: clanky.");
  });

  it("tells him he is a participant in social rooms, not an assistant", () => {
    const social = personaInstructions(persona(), "social");
    expect(social).toContain("participant in this room");
    expect(social).toMatch(/No status reports/);
    // The exact failure mode being designed out: mission-control vocabulary
    // leaking into a group chat.
    expect(social).toMatch(/Never mention missions, tasks, evidence, doctrine/);
  });

  it("keeps the working register for the operator lane", () => {
    const operator = personaInstructions(persona(), "operator");
    expect(operator).toContain("evidence-first");
    expect(operator).not.toContain("participant in this room");
    // Evidence-first is scoped to work: a casual "were you just in discord?"
    // must get a person's answer, not a telemetry readout.
    expect(operator).toMatch(/not like a status report/u);
  });

  it("describes each register instead of quoting a line he could say", () => {
    // A style example is a sentence in his voice, and a sentence in his voice
    // gets said. The casual example was "Yeah, I was just in the voice channel"
    // and he answered a Discord question with "I'm in Discord voice right now"
    // while his presence card said text. Naming no room only moved the problem,
    // so no register quotes speech at all — the owner's notes are the one place
    // a quote belongs, and those are authored, not demonstrated.
    for (const register of ["social", "operator", "gameplay"] as const) {
      const rendered = personaInstructions(persona({ characterNotes: "" }), register);
      expect(rendered).not.toMatch(/"[^"]{8,}"/u);
    }
    const operator = personaInstructions(persona(), "operator");
    expect(operator).not.toMatch(/voice channel/iu);
    expect(operator).not.toMatch(/discord/iu);
    expect(operator).toMatch(/casual register is about phrasing, never about the facts/u);
  });

  it("states in every register that voice changes and authority does not", () => {
    // This is the load-bearing invariant: an agreeable persona must never be a
    // route to privileged action.
    for (const register of ["social", "operator", "gameplay"] as const) {
      const rendered = personaInstructions(persona(), register);
      expect(rendered).toContain("Authority is not a register");
      expect(rendered).toMatch(/being asked warmly is not an approval/);
    }
  });

  it("renders without character notes rather than inventing a personality", () => {
    const rendered = personaInstructions(persona({ characterNotes: "" }), "social");
    expect(rendered).toContain("You are Clankie.");
    expect(rendered).toContain("Authority is not a register");
  });
});
