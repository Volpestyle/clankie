import type { ActivityObservationRead } from "@clankie/api-client";
import { describe, expect, it, vi } from "vitest";
import { formatActivityObservation } from "../src/activity-command.ts";
import { buildConsoleCommands } from "../src/commands.ts";
import { createInitialConsoleState } from "../src/session/state.ts";
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
      state: createInitialConsoleState(),
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
