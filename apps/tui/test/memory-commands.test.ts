import { describe, expect, it, vi } from "vitest";
import type { OperatorMemoryCatalog } from "@clankie/protocol";
import {
  buildMemoryCommands,
  formatMemoryCatalog,
  type MemoryCommandClient,
} from "../src/memory-commands.ts";
import type { SetupFlow } from "../src/shell/setup-flow.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

const catalog: OperatorMemoryCatalog = {
  schemaVersion: 1,
  captainEpisodes: [
    {
      schemaVersion: 1,
      episodeId: "episode-1",
      lane: "operator",
      targetId: "self",
      summary: "Remembered the old thing",
      visibility: "operator_private",
      provenance: {
        characterId: "clankie",
        sessionId: "session-1",
        selfAuthored: true,
        rawTranscript: false,
      },
      occurredAt: "2026-08-15T12:00:00.000Z",
    },
  ],
  discordPeople: [
    {
      subject: { guildId: "guild-1", userId: "user-1" },
      facts: [
        {
          schemaVersion: 1,
          factId: "fact-1",
          subject: { guildId: "guild-1", userId: "user-1" },
          kind: "preference",
          body: "Likes Bulbasaur",
          visibility: { scope: "guild" },
          provenance: {
            correlationId: "correlation-1",
            sourceEventId: "message-1",
            sourceSurface: "discord_text",
            rawTranscript: false,
          },
          confidence: 1,
          createdAt: "2026-08-15T12:00:00.000Z",
          updatedAt: "2026-08-15T12:00:00.000Z",
        },
      ],
    },
  ],
};

function shellFixture(selections: string[][], texts: string[] = []) {
  const lines: string[] = [];
  const results: string[] = [];
  const flow: SetupFlow = {
    begin: () => {},
    end: () => {},
    renderOutput: () => {},
    renderLine: (text) => lines.push(text),
    setStatus: () => {},
    readText: async () => texts.shift(),
    readSecret: async () => undefined,
    readSelect: async () => selections.shift(),
    waitForInterrupt: () => ({ promise: new Promise<void>(() => {}), dispose: () => {} }),
  };
  return {
    lines,
    results,
    shell: {
      setupFlow: flow,
      insertCommandResult: (_command: string, text: string) => results.push(text),
    } as unknown as ClankieFaceShell,
  };
}

function client(): MemoryCommandClient {
  return {
    inspectMemory: vi.fn().mockResolvedValue(catalog),
    updateCaptainEpisode: vi.fn().mockResolvedValue(catalog.captainEpisodes[0]),
    deleteCaptainEpisode: vi.fn().mockResolvedValue(undefined),
    updateDiscordPersonMemoryFact: vi.fn().mockResolvedValue(catalog.discordPeople[0]!.facts[0]),
    deleteDiscordPersonMemoryFact: vi.fn().mockResolvedValue(undefined),
  };
}

describe("/memory", () => {
  it("renders the complete operator catalog", async () => {
    const view = shellFixture([]);
    const command = buildMemoryCommands({ client: client() })[0]!;
    await command.run("status", view.shell);
    expect(view.results[0]).toContain("Remembered the old thing");
    expect(view.results[0]).toContain("Likes Bulbasaur");
    expect(formatMemoryCatalog(catalog)).toContain("guild-1/user-1");
  });

  it("edits an episode and confirms before forgetting a person fact", async () => {
    const api = client();
    const command = buildMemoryCommands({ client: api })[0]!;
    const episode = shellFixture(
      [["episodes"], ["0"], ["edit"], ["shareable"]],
      ["Remember the corrected thing"],
    );
    await command.run("", episode.shell);
    expect(api.updateCaptainEpisode).toHaveBeenCalledWith("operator", "episode-1", {
      summary: "Remember the corrected thing",
      visibility: "shareable",
    });
    expect(episode.lines).toContain("Saved episode.");

    const fact = shellFixture([["people"], ["0"], ["forget"], ["forget"]]);
    await command.run("", fact.shell);
    expect(api.deleteDiscordPersonMemoryFact).toHaveBeenCalledWith(
      { guildId: "guild-1", userId: "user-1" },
      "fact-1",
    );
    expect(fact.lines).toContain("Forgot person fact.");
  });
});
