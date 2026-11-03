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

it("removes a finished hire's terminal only on the hard lines a settled hire closes on", async () => {
  const hire = (name: string) => ({ seatId: `herdr-core/t${name}`, agent: "claude", session: `s-${name}` });
  // Each case breaks exactly one line; `plain` breaks none.
  const kept = new Set(["s-kept"]);
  const noReport = new Set(["s-noreport"]);
  const unread = new Set(["s-unread"]);
  let verdicts: Record<string, boolean> = {};
  const auto = createAutoTidy({
    setting: async () => "1h",
    runner: { list: async () => [] },
    removeFinished: async (_ageMs, eligible) => {
      verdicts = Object.fromEntries(
        ["plain", "kept", "reviewer", "pane", "noreport", "unread"].map((name) => [
          name,
          eligible(hire(name)),
        ]),
      );
      return [];
    },
    tidy: {
      close: async () => {
        throw new Error("No live hire in a removal proof");
      },
      keptPane: (agent) =>
        kept.has(agent.session?.value ?? "")
          ? {
              sessionKey: "k",
              paneId: agent.paneId,
              title: "",
              reason: "kept by the owner",
              by: "lead",
              at: "2026-11-03T12:00:00.000Z",
            }
          : undefined,
      keepVersion: () => 0,
      hasKeptReport: (agent) => !noReport.has(agent.session?.value ?? ""),
    },
    // A reviewer may be named by its seat id or by its bare terminal address.
    reviewerSeats: async () => new Set(["herdr-core/treviewer", "tpane"]),
    provenance: () => ({ conversationId: "lead" }),
    unreadReports: (agent) => (unread.has(agent.session?.value ?? "") ? 1 : 0),
    ownerValid: async () => true,
    closed: async () => {},
    checkouts: async () => [],
    prune: async () => {
      throw new Error("No prune in a removal proof");
    },
    stopped: () => false,
  });
  await auto.panes();
  expect(verdicts).toEqual({
    plain: true,
    kept: false,
    reviewer: false,
    pane: false,
    noreport: false,
    unread: false,
  });
});
