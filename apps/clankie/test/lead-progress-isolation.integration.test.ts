import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { HerdrWatchStore, createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { FleetProgressObserver } from "../src/fleet-progress.ts";

// VUH-2903: the head pane is never a fleet seat, and one unresolvable lead
// must not blank progress for every other lead.
test("resolves the default lead from its head pane and names an unresolvable lead without blanking the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-progress-isolation-"));
  const head = {
    pane_id: "w1:p1",
    terminal_id: "head-seat",
    name: "clankie",
    agent: "claude",
    agent_status: "idle",
    agent_session: {
      source: "herdr:claude",
      kind: "id",
      value: "fixture-head",
    },
  };
  let agents: unknown[] = [head];
  const nativeCensusRunner = vi.fn(async (_command: string, args: readonly string[]) => ({
    stdout: JSON.stringify({
      result: args[0] === "agent" ? { agents } : { workspaces: [] },
    }),
    stderr: "",
  }));
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const lead = "global-default";
  const seeded = new AutonomyStore(join(root, "autonomy.json"));
  seeded.reportContinuation(lead, { mode: "active" });
  seeded.close();
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
    const created = await captain.serveOperatorConversation({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "workspace", workspaceId: root },
      title: "Second lead",
    });
    if (created.op !== "create") throw Error("Expected a created conversation");
    const other = created.conversation.conversationId;
    await captain.serveOperatorConversation({
      op: "autonomy",
      schemaVersion: 1,
      conversationId: other,
      command: {
        action: "report_continuation",
        continuation: { mode: "active" },
      },
    });
    // The census observes the head, which makes the default lead native.
    await captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
    const resolved = await captain.leadProgress();
    expect(resolved.map((o) => o.id.split(":").slice(0, 2).join(":")).sort()).toEqual(
      [`lead:${lead}`, `lead:${other}`].sort(),
    );
    expect(resolved.every((o) => !o.unavailable && !o.stalled)).toBe(true);

    // The head pane closes: the default lead stays native and its idle state is unknown.
    agents = [];
    await delay(1_100);
    const unresolved = await captain.leadProgress();
    expect(unresolved).toContainEqual({
      id: `lead:${lead}`,
      stalled: false,
      unavailable: true,
      message: `Lead ${lead} native idle state unavailable`,
    });
    expect(unresolved.some((o) => o.id.startsWith(`lead:${other}:`) && !o.unavailable)).toBe(true);

    // Unknown neither resolves the unresolvable lead's open incident nor fails the source.
    const path = join(root, "progress-incidents.json");
    const open = {
      id: `lead:${lead}:fixture`,
      message: "Lead continuation stalled",
      openedAt: new Date().toISOString(),
      alert: "submitted",
    };
    await writeFile(path, JSON.stringify([open]));
    const errors: Error[] = [];
    const observer = new FleetProgressObserver({
      path,
      sources: [{ prefix: "lead", read: () => captain.leadProgress() }],
      notify: async () => true,
      onError: (error) => errors.push(error as Error),
    });
    await observer.observe();
    observer.stop();
    expect(errors.map((error) => error.message)).toEqual([`Fleet progress lead:${lead} unavailable`]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual([open]);
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

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
