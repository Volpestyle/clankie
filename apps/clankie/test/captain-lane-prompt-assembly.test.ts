import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClankieSettingsSchema } from "@clankie/settings";
import { describe, expect, it } from "vitest";
import { assembleLanePrompt, instructionsForHarness } from "../src/captain/captain.ts";

const settings = ClankieSettingsSchema.parse({
  schemaVersion: 1,
  persona: { displayName: "Clankie" },
  email: { fromAddress: "clankie@example.test" },
});
const identity = readFileSync(join(import.meta.dirname, "..", "src", "captain", "instructions.md"), "utf8");

/**
 * One assembly serves the pi session and the headless `clankie prompt` read
 * (VUH-1086): the session prompt is the default section set, and a seat that
 * carries the identity another way asks for the rest by name.
 */
describe("lane prompt assembly", () => {
  it("builds the operator session prompt: identity, persona, machine access, address", () => {
    const prompt = assembleLanePrompt("operator", true, settings);
    expect(prompt.startsWith(identity.trim())).toBe(true);
    expect(prompt).toContain("# Character");
    expect(prompt).toContain("# Machine access");
    expect(prompt).not.toContain("# This room");
    expect(prompt).toContain("Your own mailbox is clankie@example.test");
    // Sections are separated by exactly one blank line, in order.
    expect(prompt.indexOf("# Character")).toBeLessThan(prompt.indexOf("# Machine access"));
    expect(prompt.indexOf("# Machine access")).toBeLessThan(prompt.indexOf("# Your address"));
    expect(prompt).not.toMatch(/\n\n\n/u);
  });

  it("tells him long code and documents belong in files, not inline (VUH-1391)", () => {
    const prompt = assembleLanePrompt("operator", true, settings);
    expect(prompt).toContain("Long code and long documents go in files");
  });

  it("tells a social lane it holds no shell and leaves the address out when no mailbox is connected", () => {
    const bare = ClankieSettingsSchema.parse({ schemaVersion: 1 });
    const prompt = assembleLanePrompt("discord_presence", false, bare);
    expect(prompt).toContain("# This room");
    expect(prompt).not.toContain("# Machine access");
    expect(prompt).not.toContain("# Your address");
  });

  it("tells only Discord rooms how a reply carries media (VUH-1456)", () => {
    for (const lane of ["discord_presence", "discord_voice"] as const) {
      for (const systemTools of [false, true]) {
        const prompt = assembleLanePrompt(lane, systemTools, settings);
        expect(prompt).toContain("# In Discord");
        expect(prompt).toContain("only the last one of a turn rides");
      }
    }
    expect(assembleLanePrompt("operator", true, settings)).not.toContain("# In Discord");
    expect(assembleLanePrompt("gameplay", false, settings)).not.toContain("# In Discord");
  });

  it("carries the owner's routing preference only where a fleet can actually be reached", () => {
    const withFleet = ClankieSettingsSchema.parse({
      schemaVersion: 1,
      fleet: { notes: "codex is the workhorse. never codex on Swift." },
      email: { fromAddress: "clankie@example.test" },
    });
    const operator = assembleLanePrompt("operator", true, withFleet);
    expect(operator).toContain("# Your fleet");
    expect(operator).toContain("never codex on Swift.");
    // Preference, not a router: he is told he still decides.
    expect(operator).toContain("not a rule you execute");
    expect(operator.indexOf("# Machine access")).toBeLessThan(operator.indexOf("# Your fleet"));
    expect(operator.indexOf("# Your fleet")).toBeLessThan(operator.indexOf("# Your address"));
    expect(operator).not.toMatch(/\n\n\n/u);
    // A room with no shell cannot dispatch, so the section is dead weight there.
    expect(assembleLanePrompt("discord_presence", false, withFleet)).not.toContain("# Your fleet");
    // Unset renders nothing rather than an empty heading.
    expect(assembleLanePrompt("operator", true, settings)).not.toContain("# Your fleet");
  });

  it("states the owner's budget as a target, and a non-default budget alone renders the section", () => {
    const efficient = ClankieSettingsSchema.parse({
      schemaVersion: 1,
      fleet: { size: "small", models: "efficient" },
    });
    const operator = assembleLanePrompt("operator", true, efficient);
    expect(operator).toContain("# Your fleet");
    expect(operator).toContain("Swarm size: small.");
    expect(operator).toContain("Models: efficient.");
    // A target the lead sizes toward, never a cap he is held to.
    expect(operator).toContain("not a cap");
    expect(operator).not.toMatch(/\n\n\n/u);
    expect(assembleLanePrompt("discord_presence", false, efficient)).not.toContain("# Your fleet");
    // With notes, the default budget still rides along so he knows it is unlimited.
    const notesOnly = ClankieSettingsSchema.parse({
      schemaVersion: 1,
      fleet: { notes: "codex is the workhorse." },
    });
    const withNotes = assembleLanePrompt("operator", true, notesOnly);
    expect(withNotes).toContain("Swarm size: max.");
    expect(withNotes).toContain("No ceiling");
    expect(withNotes.indexOf("Models: optimal.")).toBeLessThan(withNotes.indexOf("codex is the workhorse."));
  });

  it("renders only the named sections, so a seat can skip the identity its output style already carries", () => {
    const prompt = assembleLanePrompt("operator", true, settings, ["persona", "reach", "address", "model"], {
      model: "## The model you are running on\nstub",
    });
    expect(prompt.startsWith("# Character")).toBe(true);
    expect(prompt).not.toContain("# Identity");
    expect(prompt.endsWith("## The model you are running on\nstub")).toBe(true);
    // A section that was asked for but has nothing to say leaves no gap.
    expect(assembleLanePrompt("operator", true, settings, ["persona", "model"])).not.toMatch(/\n\n$/u);
  });
});

describe("project instructions for a harness", () => {
  const files = [{ path: "/home/AGENTS.md" }, { path: "/home/CLAUDE.md" }, { path: "/home/repo/AGENTS.md" }];
  const exists = (path: string) => path === "/home/CLAUDE.md";

  it("passes every file when no harness is named", () => {
    expect(instructionsForHarness(files, undefined, exists)).toEqual(files);
  });

  it("leaves Claude the AGENTS.md it cannot read and drops what it already loads", () => {
    expect(instructionsForHarness(files, "claude", exists)).toEqual([{ path: "/home/repo/AGENTS.md" }]);
  });
});
