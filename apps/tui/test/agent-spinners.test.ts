import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  AGENT_SPINNER_CYCLE_INTERVAL_MS,
  AGENT_SPINNER_CYCLE_NAMES,
  AGENT_SPINNER_CYCLE_PRESETS,
  AGENT_SPINNER_NAMES,
  AGENT_SPINNER_PRESET_NAMES,
  AGENT_SPINNER_PRESETS,
  AGENT_SPINNER_WIDTH_PRESETS,
  AGENT_SPINNERS,
  DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS,
  normalizeAgentSpinnerCycleDwellMs,
  normalizeAgentSpinnerSelection,
  resolveAgentSpinner,
  type AgentSpinnerName,
} from "../src/face/agent-spinners.ts";

function maxSpinnerWidth(name: AgentSpinnerName): number {
  return Math.max(...AGENT_SPINNERS[name].frames.map((frame) => visibleWidth(frame)));
}

describe("agent spinner catalog", () => {
  it("keeps 49 non-emoji copied Expo spinners", () => {
    expect(AGENT_SPINNER_NAMES.length).toBe(49);
  });

  it("keeps the preset list stable and sorted", () => {
    expect(AGENT_SPINNER_PRESET_NAMES.join(",")).toBe(
      "micro,needle,pulse-3,ribbon-4,sweep-2,terminal,width-1,width-2,width-3,width-4",
    );
  });

  it("does not expose emoji spinners in the catalog or any preset", () => {
    for (const name of ["hearts", "clock", "earth", "moon", "speaker", "weather"]) {
      expect((AGENT_SPINNER_NAMES as readonly string[]).includes(name)).toBe(false);
      for (const presetName of AGENT_SPINNER_PRESET_NAMES) {
        expect((AGENT_SPINNER_PRESETS[presetName] as readonly string[]).includes(name)).toBe(false);
      }
    }
  });

  it("gives every spinner non-empty frames and a positive interval", () => {
    for (const name of AGENT_SPINNER_NAMES) {
      const spinner = AGENT_SPINNERS[name];
      expect(spinner.frames.length).toBeGreaterThan(0);
      expect(spinner.frames.every((frame) => frame.length > 0)).toBe(true);
      expect(Number.isSafeInteger(spinner.intervalMs) && spinner.intervalMs > 0).toBe(true);
    }
  });
});

describe("cycle spinner", () => {
  const cycle = resolveAgentSpinner(undefined, { unicode: true });

  it("cycles through spinner styles by default on unicode terminals", () => {
    expect(cycle.name).toBe("cycle");
    expect(cycle.intervalMs).toBe(100);
  });

  it("includes every spinner exactly once in the cycle order", () => {
    expect(AGENT_SPINNER_CYCLE_NAMES.length).toBe(AGENT_SPINNER_NAMES.length);
    expect(new Set(AGENT_SPINNER_CYCLE_NAMES).size).toBe(AGENT_SPINNER_NAMES.length);
  });

  it("interleaves visual families immediately", () => {
    expect(AGENT_SPINNER_CYCLE_NAMES.slice(0, 4).join(",")).toBe("arc,dots,arrow,circle-quarters");
  });

  it("briefly dwells on each copied Expo spinner", () => {
    expect(cycle.frames.length).toBe(
      AGENT_SPINNER_CYCLE_NAMES.length *
        (DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS / AGENT_SPINNER_CYCLE_INTERVAL_MS),
    );
  });

  it("mixes arc, braille, and arrow frames", () => {
    expect(cycle.frames.some((frame) => frame.includes("◜"))).toBe(true);
    expect(cycle.frames.some((frame) => frame.includes("⠋"))).toBe(true);
    expect(cycle.frames.some((frame) => frame.includes("←"))).toBe(true);
  });

  it("normalizes cycle dwell rates", () => {
    expect(normalizeAgentSpinnerCycleDwellMs(400)).toBe(400);
    expect(normalizeAgentSpinnerCycleDwellMs(1)).toBe(1);
    expect(normalizeAgentSpinnerCycleDwellMs(0)).toBe(DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS);
  });

  it("falls back to rolling-line on ascii terminals", () => {
    expect(resolveAgentSpinner(undefined, { unicode: false }).name).toBe("rolling-line");
  });

  it("resolves copied Expo frames for a named spinner", () => {
    expect(resolveAgentSpinner("sparkle").frames[0]).toBe("⡡⠊⢔⠡");
  });
});

describe("spinner selection normalization", () => {
  it("aliases all to cycle mode and keeps exact names", () => {
    expect(normalizeAgentSpinnerSelection("all")).toBe("cycle");
    expect(normalizeAgentSpinnerSelection("dots")).toBe("dots");
    expect(normalizeAgentSpinnerSelection("width-1")).toBe("width-1");
  });

  it("selects curated presets through preset: and -only spellings", () => {
    expect(normalizeAgentSpinnerSelection("preset:micro")).toBe("micro");
    expect(normalizeAgentSpinnerSelection("micro-only")).toBe("micro");
  });

  it("validates custom cycles", () => {
    expect(normalizeAgentSpinnerSelection("custom:dots,dots2,dots9")).toBe("custom:dots,dots2,dots9");
    expect(normalizeAgentSpinnerSelection("custom:dots,dots,dots2")).toBe("custom:dots,dots2");
    expect(normalizeAgentSpinnerSelection("custom:dots,missing")).toBeUndefined();
    expect(normalizeAgentSpinnerSelection("custom:dots")).toBeUndefined();
  });

  it("normalizes underscores to kebab-case and rejects unknown spinners", () => {
    expect(normalizeAgentSpinnerSelection("simple_dots_scrolling")).toBe("simple-dots-scrolling");
    expect(normalizeAgentSpinnerSelection("missing")).toBeUndefined();
  });
});

describe("custom cycles", () => {
  it("dwells on each selected spinner and preserves the selection name", () => {
    const customCycle = resolveAgentSpinner("custom:dots,dots2,dots9");
    expect(customCycle.name).toBe("custom:dots,dots2,dots9");
    expect(customCycle.frames.length).toBe(24);
    expect(customCycle.frames.some((frame) => frame.includes("⢹"))).toBe(true);
  });

  it("shortens dwell per selected spinner at a faster cycle rate", () => {
    const fastCustomCycle = resolveAgentSpinner("custom:dots,dots2,dots9", { cycleDwellMs: 400 });
    expect(fastCustomCycle.frames.length).toBe(12);
  });
});

describe("width presets", () => {
  it("groups spinners by exact terminal width and resolves at that width", () => {
    for (const [presetName, members] of Object.entries(AGENT_SPINNER_WIDTH_PRESETS)) {
      const width = Number(presetName.replace("width-", ""));
      expect(members.length).toBeGreaterThan(0);
      for (const name of members) expect(maxSpinnerWidth(name)).toBe(width);
      const resolved = resolveAgentSpinner(presetName);
      expect(resolved.name).toBe(presetName);
      expect(resolved.frames.every((frame) => visibleWidth(frame) === width)).toBe(true);
    }
  });
});

describe("cycle presets", () => {
  it("keeps each curated preset at one terminal width with a dwell per member", () => {
    for (const [presetName, members] of Object.entries(AGENT_SPINNER_CYCLE_PRESETS)) {
      const widths = new Set(members.map((name) => maxSpinnerWidth(name)));
      expect(widths.size).toBe(1);
      const resolved = resolveAgentSpinner(presetName);
      expect(resolved.name).toBe(presetName);
      expect(resolved.frames.length).toBe(
        members.length * (DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS / AGENT_SPINNER_CYCLE_INTERVAL_MS),
      );
    }
  });
});
