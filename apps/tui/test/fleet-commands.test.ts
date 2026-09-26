import { describe, expect, it } from "vitest";
import { emptySettings, type ClankieSettings, type SettingsStore } from "@clankie/settings";
import { fleetStatus, formatFleetLines, runFleetCommand } from "../src/command/fleet.ts";
import { buildFleetCommands } from "../src/fleet-commands.ts";
import type { SetupFlow } from "../src/shell/setup-flow.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

function stubStore(initial: ClankieSettings = emptySettings()): {
  settings: SettingsStore;
  read: () => ClankieSettings;
} {
  let current = initial;
  return {
    read: () => current,
    settings: {
      path: "/tmp/settings.json",
      load: async () => current,
      update: async (mutate: (settings: ClankieSettings) => ClankieSettings) => {
        current = mutate(current);
        return current;
      },
    } as unknown as SettingsStore,
  };
}

/**
 * Routing preference is free text on purpose (no role enum), so the contract to
 * hold is only that what the owner typed round-trips and that clearing empties
 * it rather than leaving a stale preference in the prompt.
 */
describe("clankie fleet", () => {
  it("defaults to empty, so an owner who says nothing leaves the choice to him", async () => {
    const { settings } = stubStore();
    expect((await runFleetCommand([], { settings })).fleet.notes).toBe("");
    expect(formatFleetLines((await fleetStatus({ settings })).fleet).join("\n")).toContain(
      "he picks a harness per job on his own",
    );
  });

  it("round-trips the owner's notes and clears them back to empty", async () => {
    const { settings, read } = stubStore();

    const set = await runFleetCommand(["set", "--notes", "grok attacks what codex builds."], {
      settings,
    });
    expect(set.fleet.notes).toBe("grok attacks what codex builds.");
    expect(read().fleet.notes).toBe("grok attacks what codex builds.");
    expect(set.restart).toBe("clankie restart captain");

    expect((await runFleetCommand(["clear"], { settings })).fleet.notes).toBe("");
  });

  it("refuses a shape it cannot store rather than silently truncating", async () => {
    const { settings } = stubStore();
    await expect(runFleetCommand(["set", "--notes", "x".repeat(4_001)], { settings })).rejects.toThrow(
      /under 4000/u,
    );
    await expect(runFleetCommand(["nope"], { settings })).rejects.toThrow(/Usage/u);
  });

  it("opens the editor on what is already configured and saves what comes back", async () => {
    const { settings, read } = stubStore({
      ...emptySettings(),
      fleet: { notes: "codex is the workhorse.", size: "large", models: "optimal" },
    });
    const prompts: Parameters<SetupFlow["readText"]>[0][] = [];
    const selects: Parameters<SetupFlow["readSelect"]>[0][] = [];
    const picks = ["small", "efficient"];
    const flow = {
      begin: () => undefined,
      end: () => undefined,
      readSelect: async (options: Parameters<SetupFlow["readSelect"]>[0]) => {
        selects.push(options);
        return picks.shift();
      },
      readText: async (options: Parameters<SetupFlow["readText"]>[0]) => {
        prompts.push(options);
        return "  claude when it needs skills.  ";
      },
      renderLine: () => undefined,
    } as unknown as SetupFlow;

    await buildFleetCommands({ settings })[0]!.run("", { setupFlow: flow } as unknown as ClankieFaceShell);

    expect(selects).toMatchObject([{ currentValue: "large" }, { currentValue: "optimal" }]);
    expect(prompts).toMatchObject([{ defaultValue: "codex is the workhorse.", multiline: true }]);
    expect(read().fleet).toEqual({
      notes: "claude when it needs skills.",
      size: "small",
      models: "efficient",
    });
  });
});

/**
 * The budget is two targets the lead sizes toward, never a cap: the contract is
 * that each flag round-trips alone, leaves the others as they were, refuses a
 * value it cannot store, and that `clear` puts the no-limit default back.
 */
describe("clankie fleet budget", () => {
  it("defaults to maximum bandwidth with the strongest models", async () => {
    const { settings } = stubStore();
    const status = await runFleetCommand(["status"], { settings });
    expect(status.fleet).toMatchObject({ size: "max", models: "optimal" });
    const lines = formatFleetLines(status.fleet).join("\n");
    expect(lines).toContain("swarm size: max");
    expect(lines).toContain("No ceiling");
    expect(lines).toContain("models: optimal");
  });

  it("sets size and models independently of the notes, and clear restores every default", async () => {
    const { settings, read } = stubStore();
    await runFleetCommand(["set", "--notes", "codex is the workhorse."], { settings });
    const set = await runFleetCommand(["set", "--size", "solo", "--models", "efficient"], { settings });
    expect(set.fleet).toEqual({ notes: "codex is the workhorse.", size: "solo", models: "efficient" });
    await runFleetCommand(["set", "--models", "optimal"], { settings });
    expect(read().fleet).toEqual({ notes: "codex is the workhorse.", size: "solo", models: "optimal" });
    expect((await runFleetCommand(["clear"], { settings })).fleet).toEqual({
      notes: "",
      size: "max",
      models: "optimal",
    });
  });

  it("refuses unknown values, repeated flags and a flag without a value", async () => {
    const { settings, read } = stubStore();
    await expect(runFleetCommand(["set", "--size", "huge"], { settings })).rejects.toThrow(
      /--size must be one of/u,
    );
    await expect(runFleetCommand(["set", "--models", "cheap"], { settings })).rejects.toThrow(
      /--models must be one of/u,
    );
    await expect(runFleetCommand(["set", "--size", "max", "--size", "solo"], { settings })).rejects.toThrow(
      /Usage/u,
    );
    await expect(runFleetCommand(["set", "--size"], { settings })).rejects.toThrow(/Usage/u);
    await expect(runFleetCommand(["set"], { settings })).rejects.toThrow(/Usage/u);
    expect(read().fleet).toEqual({ notes: "", size: "max", models: "optimal" });
  });
});
