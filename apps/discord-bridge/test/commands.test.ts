import { describe, expect, it } from "vitest";
import { commands, DISCORD_COMMAND_NAME, DISCORD_SUBCOMMANDS } from "../src/commands.ts";

/**
 * Everything lives under one `/clankie` namespace. Bare names would put
 * `/join`, `/leave`, and `/status` in direct collision with essentially every
 * music and utility bot in a shared server.
 */
const clankie = commands.find((command) => command.name === DISCORD_COMMAND_NAME);

function subcommand(name: string) {
  return clankie?.options?.find((option) => option.name === name);
}

function options(name: string) {
  const found = subcommand(name);
  return found && "options" in found ? found.options : undefined;
}

function choiceValues(subcommandName: string, optionName: string) {
  const option = options(subcommandName)?.find((candidate) => candidate.name === optionName);
  const choices = option && "choices" in option ? option.choices : undefined;
  return choices?.map((choice) => choice.value);
}

describe("Discord commands", () => {
  it("registers exactly one top-level namespace", () => {
    expect(commands).toHaveLength(1);
    expect(clankie?.name).toBe("clankie");
  });

  it("exposes every subcommand and nothing else", () => {
    expect(clankie?.options?.map((option) => option.name)).toEqual([...DISCORD_SUBCOMMANDS]);
    expect(DISCORD_SUBCOMMANDS).not.toContain("listen-always");
  });

  it("requires explicit join and leave subcommands", () => {
    expect(subcommand("join")).toBeDefined();
    expect(subcommand("leave")).toBeDefined();
    expect(subcommand("voice-consent")).toBeDefined();
    expect(choiceValues("voice-consent", "action")).toEqual(["opt-in", "opt-out"]);
  });

  it("exposes person-memory controls", () => {
    expect(subcommand("person-memory")).toBeDefined();
  });

  it("keeps person-memory mutation proposal-only and excludes ambient export/delete", () => {
    const values = choiceValues("person-memory", "action");
    expect(values).toEqual(["propose", "recall"]);
    expect(values).not.toContain("delete");
    expect(values).not.toContain("export");
  });

  it("stays under Discord's per-command subcommand cap", () => {
    expect(DISCORD_SUBCOMMANDS.length).toBeLessThanOrEqual(25);
  });
});
