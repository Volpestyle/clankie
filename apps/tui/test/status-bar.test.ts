import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  ClankieStatusBarComponent,
  formatCaptainPresenceStatus,
  STATUS_BAR_MAX_ROWS,
} from "../src/shell/status-bar.ts";
import type { PresenceSnapshot } from "../src/observation/presence.ts";

describe("captain status bar", () => {
  it("renders every presence phase with an explicit label", () => {
    const phases = ["present", "voice_active", "go_live_active", "off", "no presence session"];
    for (const phase of phases) {
      const presence: PresenceSnapshot = { phase };
      expect(formatCaptainPresenceStatus(presence)).toBe(`clankie: ${phase}`);
    }
    expect(formatCaptainPresenceStatus(undefined)).toBe("clankie: unknown");
  });

  it("keeps ANSI-styled and wrapped status rows within the supplied width", () => {
    const component = new ClankieStatusBarComponent();
    component.setText(`\u001B[35mclankie: waiting_dependency\u001B[0m · ${"long status ".repeat(20)}`);

    const rows = component.render(18);

    expect(rows.length).toBeLessThanOrEqual(STATUS_BAR_MAX_ROWS);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => visibleWidth(row) <= 18)).toBe(true);
  });
});
