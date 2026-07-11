import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { MissionDashboard, type DashboardState } from "../src/components/mission-dashboard.ts";

const state: DashboardState = {
  mission: "A deliberately long mission name that must be clipped",
  doctrine: "self-build-lab",
  score: 1,
  agents: [
    {
      id: "codex-builder-with-a-long-name",
      harness: "codex",
      state: "working",
      task: "implement a change with a description longer than the viewport",
      location: "Build Grove",
    },
  ],
  attention: ["Human merge approval is required."],
  timeline: ["mission.created", "worker.started"],
};

describe("MissionDashboard", () => {
  it("renders every ANSI-aware line within the Pi TUI width contract", () => {
    const dashboard = new MissionDashboard(() => state);
    const lines = dashboard.render(24);

    expect(lines.join("\n")).toContain("CLANKIE");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(() => dashboard.invalidate()).not.toThrow();
  });
});
