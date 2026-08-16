import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityObservationRead } from "@clankie/api-client";
import { SettingsStore } from "@clankie/settings";
import { describe, expect, it, vi } from "vitest";
import { formatActivityObservation } from "../src/activity-command.ts";
import { buildConsoleCommands } from "../src/commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

const snapshot: ActivityObservationRead = {
  schemaVersion: 1,
  outcome: "snapshot",
  snapshot: {
    schemaVersion: 1,
    surface: "gba_emulator",
    sessionId: "session-1",
    environmentId: "pokemon-firered",
    sequence: 12,
    observedAt: "2026-08-02T20:00:00.000Z",
    selfAuthored: {
      objective: "Explore Pallet Town",
      intent: "Go south\u001b]52;c;bad\u0007",
      commentary: "The lab is behind me.",
    },
    runnerObserved: {
      outcome: "accepted",
      effect: "Moved south",
      progress: {
        distinctTiles: 18,
        maps: ["Pallet Town"],
        turnsSinceNewTile: 0,
        actionsPerNewTile: 1.25,
      },
      framebufferSha256: "b".repeat(64),
    },
  },
};

describe("activity console command", () => {
  it("renders authored intent separately from observed results and strips terminal controls", () => {
    const output = formatActivityObservation(snapshot, { watchUrl: "http://127.0.0.1:4320" });
    expect(output).toContain("goal (Clankie-authored): Explore Pallet Town");
    expect(output).toContain("last result (runner-observed): accepted");
    expect(output).toContain("watch: http://127.0.0.1:4320");
    expect(output).not.toContain("\u001b");
  });

  it("names Emerald from the runner-owned environment id", () => {
    const emerald: ActivityObservationRead = {
      ...snapshot,
      snapshot: { ...snapshot.snapshot, environmentId: "pokemon-emerald" },
    };
    expect(formatActivityObservation(emerald)).toContain("Pokémon Emerald · playing");
  });

  it("reads through the authenticated client when /activity runs", async () => {
    const results: Array<{ command: string; text: string; tone: string }> = [];
    const getCurrentActivityObservation = vi.fn(async () => snapshot);
    const commands = buildConsoleCommands({
      activityClient: { getCurrentActivityObservation },
      activityWatchUrl: "http://127.0.0.1:4320",
    });
    const command = commands.find((candidate) => candidate.name === "activity");
    if (command === undefined) throw new Error("activity command not found");
    const shell = {
      insertCommandResult(invocation: string, text: string, tone: string) {
        results.push({ command: invocation, text, tone });
      },
    } as ClankieFaceShell;

    await command.run("", shell);

    expect(getCurrentActivityObservation).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ command: "/activity", tone: "success" });
    expect(results[0]?.text).toContain("Pokémon FireRed · playing");
  });
});

describe("games console command", () => {
  it("opens a toggle dialog where Enter changes each game", async () => {
    const settings = new SettingsStore(
      join(await mkdtemp(join(tmpdir(), "clankie-games-")), "settings.json"),
    );
    const selections = [["solo"], ["mmo"], ["done"]];
    const menus: Array<{ options: readonly { label: string }[] }> = [];
    const command = buildConsoleCommands({ settings }).find((candidate) => candidate.name === "games");
    if (command === undefined) throw new Error("games command not found");
    const shell = {
      setupFlow: {
        begin() {},
        end() {},
        renderLine() {},
        readSelect(options: { options: readonly { label: string }[] }) {
          menus.push(options);
          return Promise.resolve(selections.shift());
        },
      },
    } as unknown as ClankieFaceShell;

    await command.run("", shell);

    expect((await settings.load()).gameplay).toEqual({
      pokemonEmulatorEnabled: false,
      pokeagentMmoEnabled: false,
    });
    expect(menus[0]?.options.map((option) => option.label)).toEqual([
      "✓ Pokémon emulator (solo)",
      "✓ PokeAgent MMO",
    ]);
    expect(menus[1]?.options[0]?.label).toBe("○ Pokémon emulator (solo)");
  });

  it("configures solo emulator and PokeAgent MMO independently", async () => {
    const settings = new SettingsStore(
      join(await mkdtemp(join(tmpdir(), "clankie-games-")), "settings.json"),
    );
    const results: string[] = [];
    const command = buildConsoleCommands({ settings }).find((candidate) => candidate.name === "games");
    if (command === undefined) throw new Error("games command not found");
    const shell = {
      insertCommandResult(_invocation: string, text: string, _tone: string) {
        results.push(text);
      },
    } as ClankieFaceShell;

    await command.run("solo off", shell);
    expect((await settings.load()).gameplay).toEqual({
      pokemonEmulatorEnabled: false,
      pokeagentMmoEnabled: true,
    });
    await command.run("mmo off", shell);
    expect((await settings.load()).gameplay).toEqual({
      pokemonEmulatorEnabled: false,
      pokeagentMmoEnabled: false,
    });
    expect(results[0]).toContain("Pokémon emulator (solo): disabled\nPokeAgent MMO: enabled");
    expect(results[1]).toContain("Restart Clankie to apply this change.");
  });
});
