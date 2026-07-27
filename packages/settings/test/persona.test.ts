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
  it("stays quiet and addressed-only until an owner says otherwise", () => {
    const parsed = PersonaSettingsSchema.parse({});
    expect(parsed.replyPolicy).toBe("addressed");
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
