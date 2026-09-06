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
      fleet: { notes: "codex is the workhorse." },
    });
    const prompts: Parameters<SetupFlow["readText"]>[0][] = [];
    const flow = {
      begin: () => undefined,
      end: () => undefined,
      readText: async (options: Parameters<SetupFlow["readText"]>[0]) => {
        prompts.push(options);
        return "  claude when it needs skills.  ";
      },
      renderLine: () => undefined,
    } as unknown as SetupFlow;

    await buildFleetCommands({ settings })[0]!.run("", { setupFlow: flow } as unknown as ClankieFaceShell);

    expect(prompts).toMatchObject([{ defaultValue: "codex is the workhorse.", multiline: true }]);
    expect(read().fleet.notes).toBe("claude when it needs skills.");
  });
});
