import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  ClankieBannerComponent,
  detectBannerCapabilities,
  renderClankieBanner,
  type BannerCapabilities,
  type BannerFields,
} from "../src/face/clankie-banner.ts";
import { createClankieFaceAnsiTheme } from "../src/face/clankie-face-theme.ts";

const FIELDS: BannerFields = {
  title: "Clankie",
  tagline: "eve conductor · herdr stage",
  model: "claude-opus-4-8 (high effort)",
  cwd: "~/dev/clankie",
  hint: "/help for commands · ctrl+c to exit",
};

// oxlint-disable-next-line no-control-regex -- intentionally strips ANSI escape sequences
const ANSI = /\x1b\[[0-9;]*m/gu;
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const wide = (overrides: Partial<BannerCapabilities>): BannerCapabilities => ({
  color: true,
  unicode: true,
  trueColor: true,
  columns: 100,
  ...overrides,
});

describe("truecolor unicode banner", () => {
  const full = renderClankieBanner(FIELDS, wide({}));
  const fullText = stripAnsi(full.join("\n"));

  it("renders the inline robot mascot beside the name", () => {
    expect(fullText).toContain("[◉‿◉]");
    expect(fullText).toContain("clankie");
    expect(fullText).not.toContain("C L A N K Y");
    expect(/\[◉‿◉\]\s+clankie/u.test(fullText)).toBe(true);
  });

  it("shows the model and cwd in the feed", () => {
    expect(fullText).toContain("claude-opus-4-8 (high effort)");
    expect(fullText).toContain("~/dev/clankie");
  });

  it("emits 24-bit color codes", () => {
    expect(full.join("\n")).toContain("\x1b[38;2;");
  });

  it("shares the truecolor accent with the face theme", () => {
    const fullTheme = createClankieFaceAnsiTheme(wide({}));
    expect(fullTheme.cyan("system")).toContain("\x1b[38;2;255;196;112m");
  });

  it("keeps a one-column left gutter on non-empty rows", () => {
    const gutterRows = full.map(stripAnsi).filter((line) => line.length > 0);
    expect(gutterRows.every((line) => line.startsWith(" "))).toBe(true);
  });
});

describe("no-color banner", () => {
  it("emits zero ANSI escapes and keeps the simplified title", () => {
    const mono = renderClankieBanner(FIELDS, wide({ color: false, trueColor: false }));
    expect(mono.join("").indexOf("\x1b")).toBe(-1);
    expect(mono.join("\n")).toContain("clankie");
  });

  it("keeps the system accent escape-free", () => {
    expect(createClankieFaceAnsiTheme(wide({ color: false, trueColor: false })).cyan("system")).toBe(
      "system",
    );
  });
});

describe("ascii fallback banner", () => {
  it("degrades the mascot to plain ASCII", () => {
    const ascii = stripAnsi(renderClankieBanner(FIELDS, wide({ unicode: false })).join("\n"));
    expect(ascii.includes("◉")).toBe(false);
    expect(ascii.includes("‿")).toBe(false);
    expect(ascii).toContain("[o_o]");
    expect(ascii).toContain("clankie");
  });
});

describe("condensed banner", () => {
  it("collapses to a short header on narrow terminals", () => {
    const condensed = renderClankieBanner(FIELDS, wide({ columns: 36 }));
    expect(condensed.length).toBeLessThanOrEqual(3);
    expect(stripAnsi(condensed[0] ?? "")).toContain("clankie");
    for (const line of condensed) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(64);
    }
  });
});

describe("banner component", () => {
  it("condenses to the render width, not just the startup terminal width", () => {
    const component = new ClankieBannerComponent(FIELDS, wide({ columns: 100 }));
    const narrowComponent = component.render(32);
    expect(narrowComponent.length).toBeLessThanOrEqual(5);
    for (const line of narrowComponent) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(32);
    }
    expect(stripAnsi(narrowComponent.join("\n"))).toContain("clankie");
  });

  it("refreshes fields without recreating the component", () => {
    const component = new ClankieBannerComponent(FIELDS, wide({ columns: 100 }));
    component.setFields({ ...FIELDS, model: "qwen3.6:27b-mlx-bf16 (high effort)" });
    expect(stripAnsi(component.render(100).join("\n"))).toContain("qwen3.6:27b-mlx-bf16");
  });

  it("supports removing bottom padding for compact top chrome", () => {
    const component = new ClankieBannerComponent(FIELDS, wide({ columns: 100 }));
    component.setVerticalPadding({ bottom: 0 });
    const compactComponent = component.render(100);
    expect(
      stripAnsi(compactComponent[compactComponent.length - 1] ?? "")
        .trimEnd()
        .endsWith("─"),
    ).toBe(true);
  });
});

describe("capability detection", () => {
  it("disables color on non-TTY output", () => {
    const noTty = detectBannerCapabilities({ isTTY: false, columns: 80 }, {});
    expect(noTty.color).toBe(false);
  });

  it("disables color and truecolor under NO_COLOR", () => {
    const noColorEnv = detectBannerCapabilities(
      { isTTY: true, columns: 80 },
      { NO_COLOR: "1", COLORTERM: "truecolor" },
    );
    expect(noColorEnv.color).toBe(false);
    expect(noColorEnv.trueColor).toBe(false);
  });

  it("enables truecolor with COLORTERM=truecolor on a TTY", () => {
    const trueColorEnv = detectBannerCapabilities({ isTTY: true, columns: 120 }, { COLORTERM: "truecolor" });
    expect(trueColorEnv.color).toBe(true);
    expect(trueColorEnv.trueColor).toBe(true);
  });
});
