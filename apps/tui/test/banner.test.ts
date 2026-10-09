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
};

const wide = (overrides: Partial<BannerCapabilities>): BannerCapabilities => ({
  color: true,
  unicode: true,
  trueColor: true,
  columns: 100,
  ...overrides,
});

describe("no-color banner", () => {
  it("emits zero ANSI escapes", () => {
    const mono = renderClankieBanner(FIELDS, wide({ color: false, trueColor: false }));
    expect(mono.join("").indexOf("\x1b")).toBe(-1);
  });

  it("keeps the system accent escape-free", () => {
    expect(createClankieFaceAnsiTheme(wide({ color: false, trueColor: false })).cyan("system")).toBe(
      "system",
    );
  });
});

describe("banner component", () => {
  it("condenses to the render width, not just the startup terminal width", () => {
    const component = new ClankieBannerComponent(FIELDS, wide({ columns: 100 }));
    const narrowComponent = component.render(32);
    for (const line of narrowComponent) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(32);
    }
  });

  it("renders nothing when hidden", () => {
    const component = new ClankieBannerComponent(FIELDS, wide({ columns: 100 }));
    component.setVisible(false);
    expect(component.render(100)).toHaveLength(0);
  });
});

describe("ascii fallback banner", () => {
  it("degrades to plain ASCII when unicode is disabled", () => {
    const ascii = renderClankieBanner(FIELDS, wide({ unicode: false })).join("\n");
    expect(ascii).toMatch(/^\p{ASCII}*$/u);
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
