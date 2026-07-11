import { CURSOR_MARKER, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  ClankieTranscriptViewport,
  clankieScrollbarWindowStartForRow,
  clankieTranscriptMouseScrollDirection,
  computeClankieScrollbarColumn,
  isClankieSgrMouseInput,
  isClankieTranscriptMouseScrollInput,
  isClankieTranscriptPageScrollInput,
  UNICODE_SCROLLBAR_GLYPHS,
} from "../src/face/clankie-transcript-viewport.ts";

class LineComponent implements Component {
  private lines: readonly string[];

  constructor(lines: readonly string[]) {
    this.lines = lines;
  }

  setLines(lines: readonly string[]): void {
    this.lines = lines;
  }

  invalidate(): void {}

  render(): string[] {
    return [...this.lines];
  }
}

const identityTheme = {
  dim: (text: string) => text,
  selected: (text: string) => text,
};

const scrollbarTheme = {
  dim: (text: string) => text,
  scrollbarThumb: (text: string) => text,
  scrollbarTrack: (text: string) => text,
  selected: (text: string) => text,
};

function expectFits(lines: readonly string[], width: number): void {
  for (const line of lines) {
    expect(visibleWidth(line), `line exceeded ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
  }
}

function plain(lines: readonly string[]): string[] {
  return lines.map((line) =>
    line
      .replace(CURSOR_MARKER, "")
      // oxlint-disable-next-line no-control-regex -- intentionally strips ANSI escape sequences
      .replace(/\x1b\[[0-9;]*m/gu, "")
      .trimEnd(),
  );
}

// Like plain(), but also drops the trailing scrollbar gutter glyph so content can
// be compared independently of the bar.
function plainContent(lines: readonly string[]): string[] {
  return lines.map((line) =>
    line
      .replace(CURSOR_MARKER, "")
      // oxlint-disable-next-line no-control-regex -- intentionally strips ANSI escape sequences
      .replace(/\x1b\[[0-9;]*m/gu, "")
      .replace(/[█▀▄│ ]+$/u, ""),
  );
}

describe("transcript viewport block lifecycle", () => {
  it("scrolls, collapses, updates, focuses, and removes blocks through stable handles", () => {
    let maxRows = 5;
    const viewport = new ClankieTranscriptViewport(() => maxRows, identityTheme);
    const first = new LineComponent(["one", "two"]);
    const second = new LineComponent(["three", "four", "five", "six"]);

    viewport.addChild(first);
    const secondHandle = viewport.addChild(second);

    expect(plain(viewport.render(80)).join("|"), "viewport should show newest rows by default").toBe(
      "two|three|four|five|six",
    );
    expectFits(viewport.render(80), 80);

    viewport.scroll(99, 80);
    expect(plain(viewport.render(80)).join("|"), "viewport should scroll back through older rows").toBe(
      "one|two|three|four|five",
    );

    const third = new LineComponent(["seven"]);
    viewport.addChild(third);
    expect(
      plain(viewport.render(80)).join("|").includes("seven"),
      "new blocks should not force-follow while user is scrolled back",
    ).toBe(false);

    secondHandle.scrollIntoView();
    secondHandle.toggleCollapsed();
    const collapsedRows = plain(viewport.render(80));
    expect(collapsedRows.some((line) => line.includes("three"))).toBe(true);
    expect(collapsedRows.some((line) => line.includes("hidden lines"))).toBe(true);

    second.setLines(["updated", "body"]);
    secondHandle.setCollapsed(false);
    secondHandle.scrollIntoView();
    expect(
      plain(viewport.render(80)).some((line) => line.includes("updated")),
      "updated child components should re-render through stable handles",
    ).toBe(true);

    viewport.focused = true;
    expect(
      viewport.render(80).some((line) => line.includes(CURSOR_MARKER)),
      "focused viewport should render a cursor marker on the selected block",
    ).toBe(true);

    viewport.handleInput("\x1b[B");
    expect(
      plain(viewport.render(80)).some((line) => line.startsWith("> seven")),
      "down should move block focus",
    ).toBe(true);
    viewport.handleInput("\r");
    expect(
      plain(viewport.render(80)).some((line) => line.startsWith("> seven")),
      "enter should keep single-line selected blocks stable",
    ).toBe(true);

    viewport.scrollToBottom();
    secondHandle.remove();
    expect(
      plain(viewport.render(80)).join("|").includes("updated"),
      "removing a transient component should remove its rows",
    ).toBe(false);

    maxRows = 1;
    viewport.addChild(new LineComponent(["eight", "nine"]));
    expect(plain(viewport.render(80)).join("|"), "viewport should respect a smaller dynamic row budget").toBe(
      "  nine",
    );
  });
});

describe("transcript viewport global shortcuts", () => {
  it("handles page, alt, and home shortcuts against the newest blocks", () => {
    const globalViewport = new ClankieTranscriptViewport(() => 3, identityTheme);
    globalViewport.addChild(new LineComponent(["a1", "a2"]));
    globalViewport.addChild(new LineComponent(["b1", "b2"]));
    globalViewport.addChild(new LineComponent(["c1", "c2"]));
    expect(globalViewport.handleGlobalInput("\x1b[5~"), "global page-up should be handled").toBe(true);
    expect(plain(globalViewport.render(80)).join("|")).toBe("a2|b1|b2");
    expect(globalViewport.handleGlobalInput("\x1b[6~"), "global page-down should be handled").toBe(true);
    expect(plain(globalViewport.render(80)).join("|")).toBe("b2|c1|c2");
    expect(globalViewport.handleGlobalInput("\x1b[1;3A"), "global alt-up should be handled").toBe(true);
    globalViewport.focused = true;
    expect(
      plain(globalViewport.render(80)).some((line) => line.startsWith("> b1")),
      "global alt-up should select the previous block",
    ).toBe(true);
    expect(globalViewport.handleGlobalInput("\x1b\r"), "global alt-enter should be handled").toBe(true);
    expect(
      plain(globalViewport.render(80)).some((line) => line.includes("hidden lines")),
      "global alt-enter should collapse the selected block",
    ).toBe(true);
    expect(globalViewport.handleGlobalInput("\x1b[1;3F"), "global alt-end should be handled").toBe(true);
    expect(
      plain(globalViewport.render(80)).some((line) => line.startsWith("> c1")),
      "global alt-end should select the newest block",
    ).toBe(true);
    expect(globalViewport.handleGlobalInput("\x1b[1;5H"), "global ctrl-home fallback should be handled").toBe(
      true,
    );
    expect(
      plain(globalViewport.render(80)).some((line) => line.startsWith("> a1")),
      "global ctrl-home should select the first block",
    ).toBe(true);
  });

  it("scrolls with mouse wheel input", () => {
    const wheelViewport = new ClankieTranscriptViewport(() => 3, identityTheme);
    wheelViewport.addChild(new LineComponent(["w1", "w2"]));
    wheelViewport.addChild(new LineComponent(["x1", "x2"]));
    wheelViewport.addChild(new LineComponent(["y1", "y2"]));
    expect(wheelViewport.handleGlobalInput("\x1b[<64;10;5M"), "global wheel-up should be handled").toBe(true);
    expect(plain(wheelViewport.render(80)).join("|")).toBe("w1|w2|x1");
    expect(wheelViewport.handleGlobalInput("\x1b[<65;10;5M"), "global wheel-down should be handled").toBe(
      true,
    );
    expect(plain(wheelViewport.render(80)).join("|")).toBe("x2|y1|y2");
  });

  it("passes shortcuts through when no blocks exist", () => {
    const emptyGlobalViewport = new ClankieTranscriptViewport(() => 3);
    expect(emptyGlobalViewport.handleGlobalInput("\x1b[5~")).toBe(false);
    expect(emptyGlobalViewport.handleGlobalInput("\x1b[<64;10;5M")).toBe(false);
  });

  it("classifies page-scroll, wheel, and SGR mouse inputs", () => {
    expect(isClankieTranscriptPageScrollInput("\x1b[5~")).toBe(true);
    expect(isClankieTranscriptPageScrollInput("\x1b[6~")).toBe(true);
    expect(isClankieTranscriptPageScrollInput("\x1b[5~", "up")).toBe(true);
    expect(isClankieTranscriptPageScrollInput("\x1b[5~", "down")).toBe(false);
    expect(isClankieTranscriptPageScrollInput("\x1b[1;3A"), "alt-up is not a draft-safe page scroll").toBe(
      false,
    );
    expect(isClankieTranscriptMouseScrollInput("\x1b[<64;10;5M")).toBe(true);
    expect(isClankieTranscriptMouseScrollInput("\x1b[<65;10;5M")).toBe(true);
    expect(clankieTranscriptMouseScrollDirection("\x1b[<64;10;5M")).toBe("up");
    expect(clankieTranscriptMouseScrollDirection("\x1b[<65;10;5M")).toBe("down");
    expect(clankieTranscriptMouseScrollDirection("\x1b[<68;10;5M"), "modified wheel-up parses as up").toBe(
      "up",
    );
    expect(isClankieSgrMouseInput("\x1b[<0;10;5M")).toBe(true);
    expect(isClankieTranscriptMouseScrollInput("\x1b[<64;10;5m"), "mouse release is not a wheel scroll").toBe(
      false,
    );
  });
});

describe("transcript viewport selection", () => {
  it("selects dragged columns, joins rows, normalizes reversed drags, and clears", () => {
    const selectionViewport = new ClankieTranscriptViewport(() => 3, identityTheme);
    selectionViewport.addChild(new LineComponent(["hello world", "second line", "third"]));
    selectionViewport.render(80);
    expect(selectionViewport.hasSelection(), "a fresh viewport should have no selection").toBe(false);

    selectionViewport.selectionPress(0, 0);
    selectionViewport.selectionDrag(0, 5);
    expect(selectionViewport.hasSelection()).toBe(true);
    expect(selectionViewport.getSelectedText()).toBe("hello");
    expect(
      selectionViewport.render(80)[0]?.includes("\x1b[7m"),
      "selected columns should render with inverse styling",
    ).toBe(true);

    selectionViewport.selectionPress(0, 6);
    selectionViewport.selectionDrag(1, 6);
    expect(selectionViewport.getSelectedText(), "multi-line selection joins rows with newlines").toBe(
      "world\nsecond",
    );

    selectionViewport.selectionPress(1, 6);
    selectionViewport.selectionDrag(0, 6);
    expect(selectionViewport.getSelectedText(), "reversed drag direction normalizes the selection").toBe(
      "world\nsecond",
    );

    selectionViewport.selectionPress(0, 3);
    expect(selectionViewport.hasSelection(), "a press without a drag should not select anything").toBe(false);
    expect(selectionViewport.getSelectedText()).toBe("");

    selectionViewport.selectionPress(0, 0);
    selectionViewport.selectionDrag(0, 5);
    selectionViewport.clearSelection();
    expect(selectionViewport.hasSelection()).toBe(false);
    expect(selectionViewport.render(80)[0]?.includes("\x1b[7m")).toBe(false);
  });

  it("excludes the block prefix gutter from focused selections", () => {
    const focusedSelection = new ClankieTranscriptViewport(() => 1, identityTheme);
    focusedSelection.addChild(new LineComponent(["hello"]));
    focusedSelection.focused = true;
    focusedSelection.render(80);
    focusedSelection.selectionPress(0, 0);
    focusedSelection.selectionDrag(0, 7);
    expect(focusedSelection.getSelectedText()).toBe("hello");
  });
});

describe("transcript viewport spacing and pinning", () => {
  it("inserts a blank row between blocks with blockSpacing", () => {
    const spacedViewport = new ClankieTranscriptViewport(() => 6, identityTheme, { blockSpacing: 1 });
    spacedViewport.addChild(new LineComponent(["You", "hi"]));
    spacedViewport.addChild(new LineComponent(["Clankie", "hello"]));
    expect(plain(spacedViewport.render(80)).join("|")).toBe("|You|hi||Clankie|hello");
  });

  it("keeps blocks adjacent by default", () => {
    const unspacedViewport = new ClankieTranscriptViewport(() => 6, identityTheme);
    unspacedViewport.addChild(new LineComponent(["You", "hi"]));
    unspacedViewport.addChild(new LineComponent(["Clankie", "hello"]));
    expect(plain(unspacedViewport.render(80)).join("|")).toBe("||You|hi|Clankie|hello");
  });

  it("keeps a bottom-pinned loader below later transcript blocks", () => {
    const pinnedLoaderViewport = new ClankieTranscriptViewport(() => 9, identityTheme, { blockSpacing: 1 });
    pinnedLoaderViewport.addChild(new LineComponent(["You"]));
    pinnedLoaderViewport.addChild(new LineComponent(["Step 1 running..."]), {
      collapsible: false,
      pin: "bottom",
    });
    pinnedLoaderViewport.addChild(new LineComponent(["Clankie", "hello"]));
    pinnedLoaderViewport.addChild(new LineComponent(["Tool", "done"]));
    expect(plain(pinnedLoaderViewport.render(80)).join("|")).toBe(
      "You||Clankie|hello||Tool|done||Step 1 running...",
    );
  });

  it("supports switchable underfilled alignment", () => {
    const topAlignedViewport = new ClankieTranscriptViewport(() => 4, identityTheme, {
      underfilledAlignment: "top",
    });
    topAlignedViewport.addChild(new LineComponent(["near input", "second"]));
    expect(plain(topAlignedViewport.render(80)).join("|")).toBe("near input|second||");
    topAlignedViewport.setUnderfilledAlignment("bottom");
    expect(plain(topAlignedViewport.render(80)).join("|")).toBe("||near input|second");
  });
});

describe("transcript viewport click toggles", () => {
  it("expands and collapses click-toggle blocks by row", () => {
    const clickToggleViewport = new ClankieTranscriptViewport(() => 4, identityTheme, {
      underfilledAlignment: "top",
    });
    clickToggleViewport.addChild(new LineComponent(["tool", "summary", "detail"]), {
      clickToggle: true,
      collapsed: true,
    });
    expect(plain(clickToggleViewport.render(80)).some((line) => line.includes("hidden lines"))).toBe(true);
    expect(clickToggleViewport.toggleCollapsedAt(0), "clicking a click-toggle block row expands it").toBe(
      true,
    );
    expect(plain(clickToggleViewport.render(80)).includes("detail")).toBe(true);
    expect(
      clickToggleViewport.toggleCollapsedAt(1),
      "clicking another visible row in the block collapses it",
    ).toBe(true);
    expect(plain(clickToggleViewport.render(80)).some((line) => line.includes("hidden lines"))).toBe(true);
  });

  it("ignores mouse toggles on plain collapsed blocks", () => {
    const inertClickViewport = new ClankieTranscriptViewport(() => 3, identityTheme, {
      underfilledAlignment: "top",
    });
    inertClickViewport.addChild(new LineComponent(["plain", "body"]), { collapsed: true });
    inertClickViewport.render(80);
    expect(inertClickViewport.toggleCollapsedAt(0)).toBe(false);
  });
});

describe("scrollbar geometry", () => {
  const identityBar = { thumb: (text: string) => text, track: (text: string) => text };

  it("pins the thumb to the track ends and blanks a fitting transcript", () => {
    expect(computeClankieScrollbarColumn(10, 5, 5, UNICODE_SCROLLBAR_GLYPHS, identityBar).join("")).toBe(
      "││▄██",
    );
    expect(computeClankieScrollbarColumn(10, 5, 0, UNICODE_SCROLLBAR_GLYPHS, identityBar).join("")).toBe(
      "██▀││",
    );
    expect(computeClankieScrollbarColumn(3, 5, 0, UNICODE_SCROLLBAR_GLYPHS, identityBar).join("")).toBe(
      "     ",
    );
  });

  it("renders at least one thumb cell for tiny thumbs", () => {
    const thumbCells = computeClankieScrollbarColumn(100, 5, 0, UNICODE_SCROLLBAR_GLYPHS, identityBar).filter(
      (cell) => cell !== "│",
    ).length;
    expect(thumbCells).toBeGreaterThanOrEqual(1);
  });

  it("maps track rows back to window starts", () => {
    expect(clankieScrollbarWindowStartForRow(0, 10, 5)).toBe(0);
    expect(clankieScrollbarWindowStartForRow(4, 10, 5)).toBe(5);
    expect(clankieScrollbarWindowStartForRow(0, 3, 5)).toBe(0);
  });
});

describe("scrollbar integration", () => {
  it("paints a thumb in the gutter and jumps on track clicks", () => {
    const barViewport = new ClankieTranscriptViewport(() => 5, scrollbarTheme, { scrollbar: true });
    barViewport.addChild(new LineComponent(["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"]));
    const barRows = barViewport.render(20);
    expectFits(barRows, 20);
    for (const row of barRows) {
      expect(visibleWidth(row), "scrollbar rows fill the full width including the gutter").toBe(20);
    }
    expect(barRows.map((row) => row.at(-1)).join("")).toBe("││▄██");
    expect(barViewport.scrollbarHitColumn()).toBe(19);
    barViewport.scroll(99, 20);
    const scrolledRows = barViewport.render(20);
    expect(scrolledRows.map((row) => row.at(-1)).join(""), "scrolling back moves the thumb to the top").toBe(
      "██▀││",
    );
    expect(plainContent(scrolledRows).join("|"), "the gutter must not eat transcript content columns").toBe(
      "l1|l2|l3|l4|l5",
    );
    barViewport.scrollToTrackRow(4, 20);
    expect(plainContent(barViewport.render(20)).join("|")).toBe("l6|l7|l8|l9|l10");
    barViewport.scrollToTrackRow(0, 20);
    expect(plainContent(barViewport.render(20)).join("|")).toBe("l1|l2|l3|l4|l5");
  });

  it("leaves the gutter blank when the transcript fits", () => {
    const fitsBarViewport = new ClankieTranscriptViewport(() => 5, scrollbarTheme, { scrollbar: true });
    fitsBarViewport.addChild(new LineComponent(["only", "two"]));
    const fitsRows = fitsBarViewport.render(20);
    expect(fitsRows.every((row) => row.at(-1) === " ")).toBe(true);
    expect(fitsBarViewport.scrollbarHitColumn()).toBeUndefined();
    expect(plain(fitsRows).join("|")).toBe("|||only|two");
  });

  it("keeps the selection cursor alongside the scrollbar when focused", () => {
    const focusedBarViewport = new ClankieTranscriptViewport(() => 3, scrollbarTheme, { scrollbar: true });
    focusedBarViewport.addChild(new LineComponent(["f1", "f2", "f3", "f4", "f5", "f6"]));
    focusedBarViewport.focused = true;
    const focusedBarRows = focusedBarViewport.render(20);
    for (const row of focusedBarRows) {
      expect(visibleWidth(row), "focused scrollbar rows fill the full width with both gutters").toBe(20);
    }
    expect("█▀▄│".includes(focusedBarRows[0]?.at(-1) ?? "")).toBe(true);
    focusedBarViewport.scroll(99, 20);
    const focusedTopRows = focusedBarViewport.render(20);
    expect(focusedTopRows.some((row) => row.includes(CURSOR_MARKER))).toBe(true);
    for (const row of focusedTopRows) {
      expect(visibleWidth(row), "focused cursor row accounts for both the prefix and the gutter").toBe(20);
    }
  });

  it("drops the gutter on very narrow terminals rather than overflowing", () => {
    const narrowBarViewport = new ClankieTranscriptViewport(() => 3, identityTheme, { scrollbar: true });
    narrowBarViewport.addChild(new LineComponent(["a", "b", "c", "d", "e"]));
    const narrowRows = narrowBarViewport.render(6);
    expect(narrowRows.every((row) => visibleWidth(row) <= 6)).toBe(true);
    expect(narrowBarViewport.scrollbarHitColumn()).toBeUndefined();
  });
});
