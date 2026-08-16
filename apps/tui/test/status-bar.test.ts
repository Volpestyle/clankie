import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  ClankieStatusBarComponent,
  formatCaptainContextStatus,
  formatCaptainContextUsage,
  formatCaptainPresenceStatus,
  STATUS_BAR_MAX_ROWS,
} from "../src/shell/status-bar.ts";
import type { PresenceSnapshot } from "../src/observation/presence.ts";
import { PresencePoller } from "../src/observation/presence.ts";

describe("captain status bar", () => {
  it("renders every presence phase compactly", () => {
    const phases = ["present", "voice_active", "go_live_active", "off", "no presence session"];
    for (const phase of phases) {
      const presence: PresenceSnapshot = { phase };
      expect(formatCaptainPresenceStatus(presence)).toBe(`discord ${phase.replaceAll("_", " ")}`);
    }
    expect(formatCaptainPresenceStatus(undefined)).toBe("discord unavailable");
  });

  it("names presence authentication failures instead of calling them unknown", async () => {
    const presence = new PresencePoller({
      baseUrl: "http://127.0.0.1:4310",
      operatorToken: "stale",
      fetchImpl: (() => Promise.resolve(Response.json({}, { status: 401 }))) as unknown as typeof fetch,
    });

    expect(presence.snapshot).toEqual({ phase: "checking" });
    await presence.poll();
    expect(presence.snapshot).toEqual({ phase: "authentication failed" });
  });

  it("shows current context tokens out of the model window", () => {
    expect(formatCaptainContextStatus({ tokens: 72_400, contextWindow: 200_000 })).toBe("context 72.4k/200k");
    expect(formatCaptainContextUsage({ tokens: null, contextWindow: 1_000_000 })).toBe("? / 1m");
    expect(formatCaptainContextStatus(undefined)).toBe("context unavailable");
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
