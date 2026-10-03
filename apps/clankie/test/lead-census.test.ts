import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { HerdrWatchStore, createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { readHerdrSessionCensus } from "../src/captain/herdr-census.ts";
const reads = vi.hoisted(() => ({ summaries: vi.fn(), subagents: vi.fn(), work: vi.fn(), goal: vi.fn() }));
vi.mock("../src/captain/herdr-summaries.ts", async (original) => ({
  ...(await original<object>()),
  readHerdrSummariesFile: (path?: string) => {
    reads.summaries(path);
    if (!path?.includes("lead-census-fixture-")) throw Error("Owner summaries forbidden");
    return { schemaVersion: 1, agents: {} };
  },
}));
vi.mock("../src/captain/seat-subagents.ts", () => ({
  withSeatSubagents: (...args: unknown[]) => {
    reads.subagents(...args);
    throw Error("Owner subagents forbidden");
  },
}));
vi.mock("../src/captain/agent-work.ts", async (original) => ({
  ...(await original<object>()),
  withSeatWork: (...args: unknown[]) => {
    reads.work(...args);
    throw Error("Owner work transcript forbidden");
  },
}));
vi.mock("@clankie/agent-transcript", async (original) => ({
  ...(await original<object>()),
  readCodexGoal: (...args: unknown[]) => {
    reads.goal(...args);
    throw Error("Owner native goal forbidden");
  },
}));

test("isolated Captain constructor, refresh and census never enrich from owner native files", async () => {
  const root = mkdtempSync(join(tmpdir(), "lead-census-fixture-"));
  const nativeCensusRunner = vi.fn(async (_command: string, args: readonly string[]) => ({
    stdout: JSON.stringify({
      result:
        args[0] === "agent"
          ? {
              agents: [
                {
                  pane_id: "w1:p1",
                  terminal_id: "fixture-seat",
                  name: "clankie",
                  agent: "codex",
                  agent_session: { source: "codex", kind: "id", value: "never-read-owner" },
                },
              ],
            }
          : { workspaces: [] },
    }),
    stderr: "",
  }));
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const captain = createCaptain({ herdrAvailable: () => true } as CaptainDeps, {
    repoRoot: root,
    workingDirectory: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
    nativeHerdrRunner: {
      ...createHerdrWatchRunner(
        () => true,
        async (args) => (await nativeCensusRunner("herdr", args)).stdout,
      ),
      transcript: async () => undefined,
    },
    nativeCensusRunner,
    nativeSummariesPath: join(root, "summaries.json"),
  });
  try {
    await captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
    await captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
    await readHerdrSessionCensus("w1:p1", { runCommand: nativeCensusRunner, summaries: {} });
    expect(nativeCensusRunner).toHaveBeenCalled();
    expect(reads.subagents).not.toHaveBeenCalled();
    expect(reads.work).not.toHaveBeenCalled();
    expect(reads.goal).not.toHaveBeenCalled();
    expect(
      reads.summaries.mock.calls.every(([path]) => typeof path === "string" && path.startsWith(root)),
    ).toBe(true);
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

const ambientProcess = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Ambient process access forbidden in isolated Captain fixture");
  }),
);
afterEach(() => {
  expect(ambientProcess).not.toHaveBeenCalled();
  ambientProcess.mockClear();
});
// Test-local tripwire: an omitted native runner cannot reach live owner processes.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: ambientProcess,
  spawn: ambientProcess,
}));
