import { FleetAutonomySchema, autonomyDrift, formatAutonomyDrift } from "@clankie/protocol";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ClankieFooterComponent, type ClankieFooterState } from "../src/shell/footer.ts";
import { createClankieFaceAnsiTheme } from "../src/face/clankie-face-theme.ts";

const ansi = createClankieFaceAnsiTheme({ color: false, trueColor: false });

function footer(state: Partial<ClankieFooterState>): ClankieFooterComponent {
  return new ClankieFooterComponent(ansi, () => ({ cwd: "/tmp", extras: [], ...state }));
}

describe("footer component", () => {
  it("fits the terminal width when footer stats wrap", () => {
    const lines = footer({
      contextUsage: { tokens: 24_600, contextWindow: 200_000 },
      cwd: "/Users/x/dev/clankie",
      model: "claude-opus",
      title: "dev room",
    }).render(60);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  });

  it("never exceeds the terminal width", () => {
    const lines = footer({
      cwd: `/deep${"/segment".repeat(20)}`,
      extras: ["x".repeat(120)],
      model: "a-very-long-model-name-that-should-truncate",
      contextUsage: { tokens: 190_000, contextWindow: 200_000 },
    }).render(1);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(1);
    }
  });
});

it("keeps every differing autonomy leaf visible in a narrow console", () => {
  const fleet = FleetAutonomySchema.parse({
    hardToUndo: "owner",
    release: { mode: "time_rule", rule: "Weekly" },
  });
  const drift = autonomyDrift(fleet)!;
  const lines = footer({ extras: ["This Mac"], autonomy: formatAutonomyDrift(drift) }).render(40);
  const rendered = lines.join(" ");
  expect(rendered).toContain("Autonomy custom");
  expect(rendered).toContain("hardToUndo: owner");
  expect(rendered).toContain("release: time_rule");
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
});
