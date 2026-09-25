import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { Evaluator } from "../src/captain/evaluator.ts";
import * as census from "../src/captain/herdr-census.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";

it("evaluates only Clankie's native head replies while enabled, never other fleet agents", async () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-evaluator-scope-"));
  let project!: NonNullable<Parameters<HerdrWatchStore["start"]>[1]>;
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation((_wake, callback) => {
    project = callback!;
  });
  vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  vi.spyOn(Evaluator.prototype, "tick").mockResolvedValue();
  vi.spyOn(census, "readFleet").mockResolvedValue({
    seats: [],
    head: {
      seatId: "clankie-head",
      paneId: "w1:p1",
      occupantId: "clankie-session",
      harness: "claude",
      status: "idle",
      workingDirectory: root,
    },
  });
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
  });
  const reply = (seatId: string, id: string) =>
    project(seatId, {
      kind: "transcript",
      transcript: {
        sessionKey: `herdr:${seatId}`,
        entries: [
          { type: "message", id, role: "agent", text: "Done.", occurredAt: new Date().toISOString() },
        ],
      },
    });
  try {
    await Promise.resolve(); // Let the initial census bind the native head.
    reply("clankie-head", "disabled");
    expect(captain.evaluatorStatus().jobs).toHaveLength(0);
    await captain.evaluatorCommand({ action: "enable" });
    reply("unrelated-agent", "other");
    expect(captain.evaluatorStatus().jobs).toHaveLength(0);
    reply("clankie-head", "enabled");
    expect(captain.evaluatorStatus().jobs).toMatchObject([
      { conversationId: "seat:clankie-head", runIds: ["herdr:clankie-head:enabled"] },
    ]);
    await captain.evaluatorCommand({ action: "disable" });
    reply("clankie-head", "disabled-again");
    expect(captain.evaluatorStatus().jobs[0]?.runIds).toEqual(["herdr:clankie-head:enabled"]);
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
