import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { PresenceSnapshot } from "../src/observation/presence.ts";
import {
  ClankieFooterComponent,
  formatCaptainContextUsage,
  formatCaptainPresenceStatus,
  formatFooterContext,
  formatFooterTokens,
  type ClankieFooterState,
} from "../src/shell/footer.ts";
import { createClankieFaceAnsiTheme } from "../src/face/clankie-face-theme.ts";

const ansi = createClankieFaceAnsiTheme({ color: false, trueColor: false });

function footer(state: Partial<ClankieFooterState>): ClankieFooterComponent {
  return new ClankieFooterComponent(ansi, () => ({ cwd: "/tmp", extras: [], ...state }));
}

describe("presence status", () => {
  it("formats every phase and the unavailable fallback", () => {
    for (const phase of ["online", "voice_connected", "starting"]) {
      const presence = { phase } as unknown as PresenceSnapshot;
      expect(formatCaptainPresenceStatus(presence)).toBe(`discord ${phase.replaceAll("_", " ")}`);
    }
    expect(formatCaptainPresenceStatus(undefined)).toBe("discord unavailable");
  });
});

describe("context usage", () => {
  it("formats the /status readout with compact token counts", () => {
    expect(formatCaptainContextUsage({ tokens: 72_400, contextWindow: 200_000 })).toBe("72.4k / 200k");
    expect(formatCaptainContextUsage({ tokens: null, contextWindow: 1_000_000 })).toBe("? / 1m");
    expect(formatCaptainContextUsage(undefined)).toBe("unavailable");
  });

  it("formats the pi footer readout with escalating levels", () => {
    expect(formatFooterContext({ tokens: 24_600, contextWindow: 200_000 })).toEqual({
      level: "ok",
      text: "12.3%/200k",
    });
    expect(formatFooterContext({ tokens: 150_000, contextWindow: 200_000 }).level).toBe("warning");
    expect(formatFooterContext({ tokens: 190_000, contextWindow: 200_000 }).level).toBe("error");
    expect(formatFooterContext({ tokens: null, contextWindow: 200_000 })).toEqual({
      level: "ok",
      text: "?/200k",
    });
    expect(formatFooterContext(undefined).text).toBe("context ?");
  });

  it("uses pi's compact token formatting", () => {
    expect(formatFooterTokens(999)).toBe("999");
    expect(formatFooterTokens(1_200)).toBe("1.2k");
    expect(formatFooterTokens(200_000)).toBe("200k");
    expect(formatFooterTokens(1_200_000)).toBe("1.2M");
  });
});

describe("footer component", () => {
  it("renders cwd · title, then stats with the model right-aligned", () => {
    const lines = footer({
      contextUsage: { tokens: 24_600, contextWindow: 200_000 },
      cwd: "/Users/x/dev/clankie",
      model: "claude-opus",
      title: "dev room",
    }).render(60);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("/Users/x/dev/clankie • dev room");
    expect(lines[1]).toContain("12.3%/200k");
    expect(lines[1]?.endsWith("claude-opus")).toBe(true);
    expect(visibleWidth(lines[1] ?? "")).toBe(60);
  });

  it("adds an extras line only when segments exist", () => {
    expect(footer({}).render(60)).toHaveLength(2);
    const lines = footer({ extras: ["discord online", "", "shell"] }).render(60);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("discord online · shell");
  });

  it("never exceeds the terminal width", () => {
    const lines = footer({
      cwd: `/deep${"/segment".repeat(20)}`,
      extras: ["x".repeat(120)],
      model: "a-very-long-model-name-that-should-truncate",
      contextUsage: { tokens: 190_000, contextWindow: 200_000 },
    }).render(40);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });
});
