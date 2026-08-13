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
  presence: [
    { sessionId: "discord:bot:1530657471402737826:f35a58d0-6f03-45cc-a00b-57617c263573", phase: "present" },
    { sessionId: "discord:bot:1530657471402737826:628d9942-4fc4-4c2a-b901-2ac3d8ff1446", phase: "off" },
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

  it("stamps presence rows with their last transition time", () => {
    const dashboard = new MissionDashboard(() => ({
      ...state,
      presence: [{ sessionId: "discord:bot:app", phase: "present", updatedAt: "2026-08-09T23:36:00Z" }],
    }));
    expect(dashboard.render(120).join("\n")).toMatch(/discord:bot:app \[present\] · since /u);
  });

  it("renders observed Herdr pane agents and never claims an empty roster is truth", () => {
    const dashboard = new MissionDashboard(() => ({
      ...state,
      agents: [],
      herdr: {
        agents: [
          { paneId: "w12:p3C", agent: "claude", status: "working" as const, title: "Evaluate gameplay" },
        ],
      },
    }));
    const rendered = dashboard.render(120).join("\n");
    expect(rendered).toContain("No mission workers reported.");
    expect(rendered).toContain("w12:p3C");
    expect(rendered).toContain("[claude · herdr] · Evaluate gameplay");

    const outsideHerdr = new MissionDashboard(() => ({ ...state, agents: [] }));
    expect(outsideHerdr.render(120).join("\n")).toContain("No workers observed.");
  });
});
