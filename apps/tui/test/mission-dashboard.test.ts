import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { MissionDashboard, type DashboardState } from "../src/components/mission-dashboard.ts";

const state: DashboardState = {
  connection: "live at sequence 42",
  cursor: 42,
  mission: "A deliberately long mission name that must be clipped",
  doctrine: "self-build-lab",
  score: 1,
  missions: [
    {
      id: "mission-with-a-long-name",
      goal: "A deliberately long mission goal",
      state: "running",
      selected: true,
    },
  ],
  tasks: [
    {
      id: "implementation-with-a-long-name",
      title: "Implement a description longer than the viewport",
      state: "running",
      dependsOn: [],
    },
  ],
  agents: [
    {
      id: "codex-builder-with-a-long-name",
      harness: "codex",
      state: "working",
      task: "implement a change with a description longer than the viewport",
    },
  ],
  attention: ["Human merge approval is required."],
  timeline: ["mission.created", "worker.started"],
};

describe("MissionDashboard", () => {
  it("renders every ANSI-aware line within the Pi TUI width contract", () => {
    const dashboard = new MissionDashboard(() => state);
    expect(dashboard.render(24).join("\n")).toContain("CLANKIE");
    for (const width of [1, 12, 24, 80]) {
      expect(dashboard.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(() => dashboard.invalidate()).not.toThrow();
  });
});
