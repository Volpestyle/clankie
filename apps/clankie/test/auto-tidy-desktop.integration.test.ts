// #584/#607: auto-tidy listed only this machine's Herdr, so with hires placed in the desktop
// app's terminals (ADR 0319) no finished hire ever closed on its own, and an ended terminal
// stayed in the window. Each fleet is listed on its own: one that doesn't answer never holds
// back another's closes. Pane observation and the guarded close are supplied at the runner seam.
import { expect, it } from "vitest";
import { createAutoTidy } from "../src/captain/auto-tidy.ts";
import type { HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";

const agent = (paneId: string): HerdrAgentSnapshot => ({
  paneId,
  terminalId: paneId,
  agent: "claude",
  status: "done",
  title: "Clankie captain brief",
  session: { source: "herdr:claude", kind: "id", value: `session-${paneId}` },
});

it("closes finished hires in the desktop app's terminals as in Herdr's, past a fleet that doesn't answer", async () => {
  const local = agent("w1:p1");
  const desktop = agent("herdr-core/t6p");
  const listed: (string | undefined)[] = [];
  const closed: string[] = [];
  const removals: number[] = [];
  let clock = Date.parse("2026-11-03T12:00:00Z");
  const auto = createAutoTidy({
    setting: async () => "1h",
    runner: {
      list: async (fleet?: string) => {
        listed.push(fleet);
        if (fleet === "gone") throw new Error("Machine connection gone changed or disconnected");
        return fleet === undefined ? [local] : fleet === "herdr-core" ? [desktop] : [];
      },
    },
    fleets: async () => [undefined, "gone", "herdr-core"],
    removeFinished: async (ageMs) => {
      removals.push(ageMs);
      return [];
    },
    tidy: {
      close: async (input) => {
        closed.push(input.pane);
        return { outcome: "failed", reason: "provenance_unknown" };
      },
      keptPane: () => undefined,
      keepVersion: () => 0,
      hasKeptReport: () => true,
    },
    provenance: () => ({ conversationId: "lead" }),
    unreadReports: () => 0,
    ownerValid: async () => true,
    closed: async () => {},
    checkouts: async () => [],
    prune: async () => {
      throw new Error("No prune in a listing proof");
    },
    stopped: () => false,
    now: () => clock,
  });
  await auto.panes();
  clock += 61 * 60_000;
  await auto.panes();

  expect(listed).toEqual([undefined, "gone", "herdr-core", undefined, "gone", "herdr-core"]);
  expect(closed).toEqual([local.paneId, desktop.paneId]);
  // Ended terminals go after the same window a settled hire waits.
  expect(removals).toEqual([60 * 60_000, 60 * 60_000]);
});
