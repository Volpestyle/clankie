import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DISCORD_SUBCOMMANDS } from "../src/commands.ts";

/**
 * Authority is called inline inside each `case` of the dispatch switch rather
 * than driven by a table, because several subcommands gate *after* a
 * precondition. A blanket pre-switch gate would change those behaviours.
 *
 * That inline shape is exactly where a mechanical rewrite of the cases can
 * silently drop one authority call, and the failure is invisible: the
 * subcommand keeps working, it just stops being gated. The ADR 0050 tier split
 * would be quietly undone.
 *
 * So the tier is asserted against the source of each case block rather than
 * trusted to a diff. `handleCommand` cannot be imported directly — its module
 * logs into Discord at top level — which is why this reads the file.
 */
const source = readFileSync(resolve(import.meta.dirname, "../src/index.ts"), "utf8");

const AMBIENT = "authorizeAmbientCommand(";
const VOICE_PRESENCE = "authorizeVoicePresenceCommand(";

function caseBody(subcommand: string): string {
  const start = source.indexOf(`    case "${subcommand}": {`);
  expect(start, `dispatch has no case for /clankie ${subcommand}`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const nextCase = rest.search(/\n {4}(case "|default:)/u);
  return nextCase < 0 ? rest : rest.slice(0, nextCase);
}

describe("subcommand authority tiers", () => {
  it("gates person-memory on the ambient binding only", () => {
    const body = caseBody("person-memory");
    expect(body, "/clankie person-memory lost its ambient authority check").toContain(AMBIENT);
    // Opening voice to a room must never widen ambient authority (ADR 0050).
    expect(body, "/clankie person-memory must not use the voice presence tier").not.toContain(
      VOICE_PRESENCE,
    );
  });

  it("gates join, leave, and watch on the voice presence tier", () => {
    // Watch shares the tier deliberately: who may put him on a stage is who
    // may point a camera at him (ADR 0047's launch surface, ADR 0050's tier).
    for (const subcommand of ["join", "leave", "watch"]) {
      const body = caseBody(subcommand);
      expect(body, `/clankie ${subcommand} lost its voice presence check`).toContain(VOICE_PRESENCE);
      expect(body, `/clankie ${subcommand} must not fall back to the ambient tier`).not.toContain(AMBIENT);
    }
  });

  it("leaves status and the voice read/consent surfaces ungated by design", () => {
    // These are deliberately open: status is harmless, and consent must always
    // be revocable by the person whose voice is being captured.
    for (const subcommand of ["status", "voice-consent", "voice-status"]) {
      const body = caseBody(subcommand);
      expect(body).not.toContain(AMBIENT);
      expect(body).not.toContain(VOICE_PRESENCE);
    }
  });

  it("dispatches on the subcommand under a single guarded namespace", () => {
    expect(source).toContain("interaction.commandName !== DISCORD_COMMAND_NAME");
    expect(source).toContain("switch (interaction.options.getSubcommand())");
  });

  it("has a dispatch case for every registered subcommand", () => {
    // Catches a subcommand added to the builder with no handler behind it.
    for (const subcommand of DISCORD_SUBCOMMANDS) {
      expect(source, `no dispatch case for /clankie ${subcommand}`).toContain(`    case "${subcommand}": {`);
    }
  });
});
