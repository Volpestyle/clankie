import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  ClankieStatusBarComponent,
  formatCaptainPresenceStatus,
  STATUS_BAR_MAX_ROWS,
} from "../src/shell/status-bar.ts";
import type { CaptainPresenceSnapshot, CaptainPresenceState } from "../src/observation/mission-observer.ts";

describe("captain status bar", () => {
  it("renders every captain presence state with an explicit label", () => {
    const states: CaptainPresenceState[] = [
      "working",
      "waiting_user",
      "waiting_dependency",
      "idle",
      "offline",
    ];
    for (const state of states) {
      const presence: CaptainPresenceSnapshot = {
        state,
        summary: `Captain ${state}`,
        updatedAt: "2026-07-16T00:00:00.000Z",
      };
      expect(formatCaptainPresenceStatus(presence)).toBe(`captain: ${state}`);
    }
    expect(formatCaptainPresenceStatus(undefined)).toBe("captain: unknown");
  });

  it("keeps ANSI-styled and wrapped status rows within the supplied width", () => {
    const component = new ClankieStatusBarComponent();
    component.setText(`\u001B[35mcaptain: waiting_dependency\u001B[0m · ${"long status ".repeat(20)}`);

    const rows = component.render(18);

    expect(rows.length).toBeLessThanOrEqual(STATUS_BAR_MAX_ROWS);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => visibleWidth(row) <= 18)).toBe(true);
  });
});
