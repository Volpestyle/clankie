import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type KeyId,
} from "@earendil-works/pi-tui";
import { parseClankieSgrMouse } from "./clankie-sgr-mouse.ts";

export type ClankieTranscriptViewportTheme = {
  readonly dim: (text: string) => string;
  readonly selected: (text: string) => string;
  // Right-gutter scrollbar styling: the track is the full extent, the thumb is
  // the proportional handle painted brighter so it stands out against the track.
  readonly scrollbarTrack: (text: string) => string;
  readonly scrollbarThumb: (text: string) => string;
};

export type ClankieTranscriptViewportOptions = {
  // Blank rows inserted before each block after the first, so turns read as
  // separated paragraphs rather than one wall of text.
  readonly blockSpacing?: number;
  readonly underfilledAlignment?: TranscriptUnderfilledAlignment;
  // Reserve a one-column right gutter and paint a proportional scrollbar there
  // whenever content overflows the viewport. Opt-in so non-face consumers (and
  // exact-line tests) keep the edge-to-edge layout.
  readonly scrollbar?: boolean;
  // Block-drawing thumb glyphs when the terminal renders unicode; ASCII fallback
  // otherwise.
  readonly unicode?: boolean;
};

export type ClankieTranscriptBlockHandle = {
  remove(): void;
  setCollapsed(collapsed: boolean): void;
  toggleCollapsed(): void;
  scrollIntoView(): void;
};

export type ClankieTranscriptBlockOptions = {
  readonly clickToggle?: boolean;
  readonly collapsed?: boolean;
  readonly collapsible?: boolean;
  readonly id?: string;
  readonly pin?: "bottom";
};

type TranscriptBlock = {
  bottomPinned: boolean;
  clickToggle: boolean;
  readonly component: Component;
  readonly id: string;
  collapsed: boolean;
  collapsible: boolean;
};

type RenderedBlock = {
  readonly block: TranscriptBlock;
  readonly lines: readonly string[];
  readonly start: number;
  readonly end: number;
};

type ScrollDirection = "down" | "up";
export type TranscriptUnderfilledAlignment = "bottom" | "top";

type SelectionPoint = {
  readonly line: number;
  readonly col: number;
};

type Selection = {
  readonly anchor: SelectionPoint;
  readonly head: SelectionPoint;
};

const SELECTION_INVERSE = "\x1b[7m";
const SELECTION_RESET = "\x1b[0m";

const DEFAULT_THEME: ClankieTranscriptViewportTheme = {
  dim: (text) => `\x1b[2m${text}\x1b[22m`,
  scrollbarThumb: (text) => `\x1b[97m${text}\x1b[39m`,
  scrollbarTrack: (text) => `\x1b[2m${text}\x1b[22m`,
  selected: (text) => `\x1b[36m${text}\x1b[39m`,
};
const WHEEL_SCROLL_ROWS = 3;
// Below this width the gutter is dropped: a scrollbar is useless on a sliver of a
// terminal and reserving the column would eat scarce content space.
const SCROLLBAR_MIN_WIDTH = 8;

export type ClankieScrollbarGlyphs = {
  readonly track: string;
  readonly full: string;
  readonly topHalf: string;
  readonly bottomHalf: string;
};

export const UNICODE_SCROLLBAR_GLYPHS: ClankieScrollbarGlyphs = {
  bottomHalf: "▄",
  full: "█",
  topHalf: "▀",
  track: "│",
};

export const ASCII_SCROLLBAR_GLYPHS: ClankieScrollbarGlyphs = {
  bottomHalf: "#",
  full: "#",
  topHalf: "#",
  track: "|",
};

export class ClankieTranscriptViewport implements Component, Focusable {
  private readonly blocks: TranscriptBlock[] = [];
  private readonly maxRows: (width: number) => number;
  private readonly theme: ClankieTranscriptViewportTheme;
  private readonly blockSpacing: number;
  private underfilledAlignment: TranscriptUnderfilledAlignment;
  private nextBlockId = 1;
  private scrollbackRows = 0;
  private selectedIndex = 0;
  private lastWidth = 80;
  private selection: Selection | null = null;
  private prefixWidth = 0;
  private lastFlattened: readonly string[] = [];
  private lastWindowStart = 0;
  private lastTopPad = 0;
  private readonly scrollbarEnabled: boolean;
  private readonly scrollbarGlyphs: ClankieScrollbarGlyphs;
  private lastContentWidth = 80;
  private lastScrollbarVisible = false;
  focused = false;

  constructor(
    maxRows: (width: number) => number,
    theme: Partial<ClankieTranscriptViewportTheme> = {},
    options: ClankieTranscriptViewportOptions = {},
  ) {
    this.maxRows = maxRows;
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.blockSpacing = Math.max(0, Math.floor(options.blockSpacing ?? 0));
    this.underfilledAlignment = options.underfilledAlignment ?? "bottom";
    this.scrollbarEnabled = options.scrollbar === true;
    this.scrollbarGlyphs = (options.unicode ?? true) ? UNICODE_SCROLLBAR_GLYPHS : ASCII_SCROLLBAR_GLYPHS;
  }

  setUnderfilledAlignment(alignment: TranscriptUnderfilledAlignment): void {
    this.underfilledAlignment = alignment;
  }

  addChild(component: Component, options: ClankieTranscriptBlockOptions = {}): ClankieTranscriptBlockHandle {
    const wasAtBottom = this.scrollbackRows === 0;
    const wasEmpty = this.blocks.length === 0;
    const block: TranscriptBlock = {
      bottomPinned: options.pin === "bottom",
      clickToggle: options.clickToggle === true,
      collapsed: options.collapsed === true,
      collapsible: options.collapsible !== false,
      component,
      id: options.id ?? `block-${this.nextBlockId++}`,
    };
    const bottomPinnedIndex = this.blocks.findIndex((entry) => entry.bottomPinned);
    const insertIndex = block.bottomPinned || bottomPinnedIndex < 0 ? this.blocks.length : bottomPinnedIndex;
    this.blocks.splice(insertIndex, 0, block);
    if (wasAtBottom || wasEmpty) {
      this.selectedIndex = insertIndex;
      this.scrollToBottom();
    } else if (this.selectedIndex >= insertIndex) {
      this.selectedIndex += 1;
    }
    return this.handleFor(block);
  }

  removeChild(component: Component): void {
    const index = this.blocks.findIndex((block) => block.component === component);
    if (index < 0) return;
    this.blocks.splice(index, 1);
    this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, this.blocks.length - 1));
    this.selection = null;
    this.clampScrollback(this.lastWidth);
  }

  clear(): void {
    this.blocks.length = 0;
    this.scrollbackRows = 0;
    this.selectedIndex = 0;
    this.selection = null;
  }

  scroll(delta: number, width = this.lastWidth): void {
    this.lastWidth = width;
    this.scrollbackRows += delta;
    this.clampScrollback(width);
  }

  scrollPage(direction: "down" | "up", width = this.lastWidth): void {
    const delta = this.visibleRowCount(width) - 1;
    this.scroll(direction === "up" ? delta : -delta, width);
  }

  scrollWheel(direction: ScrollDirection, width = this.lastWidth): void {
    this.scroll(direction === "up" ? WHEEL_SCROLL_ROWS : -WHEEL_SCROLL_ROWS, width);
  }

  scrollToBottom(): void {
    this.scrollbackRows = 0;
  }

  invalidate(): void {
    for (const block of this.blocks) block.component.invalidate();
  }

  handleGlobalInput(data: string): boolean {
    if (this.blocks.length === 0) return false;
    const wheelDirection = clankieTranscriptMouseScrollDirection(data);
    if (wheelDirection !== undefined) {
      this.scrollWheel(wheelDirection);
      return true;
    }
    if (isClankieTranscriptPageScrollInput(data, "up")) {
      this.scrollPage("up");
      return true;
    }
    if (isClankieTranscriptPageScrollInput(data, "down")) {
      this.scrollPage("down");
      return true;
    }
    if (matchesAny(data, Key.alt("up"), Key.ctrl("up"))) {
      this.moveSelection(-1);
      return true;
    }
    if (matchesAny(data, Key.alt("down"), Key.ctrl("down"))) {
      this.moveSelection(1);
      return true;
    }
    if (matchesAny(data, Key.alt("home"), Key.ctrl("home"))) {
      this.selectedIndex = 0;
      this.ensureSelectedVisible();
      return true;
    }
    if (matchesAny(data, Key.alt("end"), Key.ctrl("end"))) {
      this.selectedIndex = Math.max(0, this.blocks.length - 1);
      this.scrollToBottom();
      return true;
    }
    if (matchesAny(data, Key.alt("enter"), Key.alt("space"))) {
      this.toggleSelectedCollapsed();
      return true;
    }
    return false;
  }

  handleInput(data: string): void {
    const wheelDirection = clankieTranscriptMouseScrollDirection(data);
    if (wheelDirection !== undefined) {
      this.scrollWheel(wheelDirection);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollPage("up");
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollPage("down");
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.selectedIndex = 0;
      this.ensureSelectedVisible();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.selectedIndex = Math.max(0, this.blocks.length - 1);
      this.scrollToBottom();
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === "\r" || data === " ") {
      this.toggleSelectedCollapsed();
    }
  }

  render(width: number): string[] {
    this.lastWidth = width;
    this.prefixWidth = this.focused ? 2 : 0;
    const rendered = this.renderBlocks(width);
    const lines = rendered.flatMap((block) => block.lines);
    this.lastFlattened = lines;
    const maxRows = this.visibleRowCount(width);
    this.clampScrollback(width, lines.length, maxRows);
    let visible: string[];
    if (lines.length <= maxRows) {
      this.lastWindowStart = 0;
      const padding = Array.from({ length: maxRows - lines.length }, () => "");
      if (this.underfilledAlignment === "top") {
        this.lastTopPad = 0;
        visible = [...lines, ...padding];
      } else {
        this.lastTopPad = padding.length;
        visible = [...padding, ...lines];
      }
    } else {
      const end = Math.max(maxRows, lines.length - this.scrollbackRows);
      this.lastWindowStart = Math.max(0, end - maxRows);
      this.lastTopPad = 0;
      visible = lines.slice(this.lastWindowStart, end);
    }
    const highlighted =
      this.selection === null
        ? visible
        : visible.map((line, index) =>
            this.applyHighlight(line, this.lastWindowStart + index - this.lastTopPad),
          );
    return this.applyScrollbar(highlighted, width, lines.length, maxRows);
  }

  // Returns the 0-based terminal column the scrollbar currently occupies, or
  // undefined when no bar is drawn (gutter disabled, terminal too narrow, or
  // content fits). Callers use it to route gutter clicks to a thumb drag.
  scrollbarHitColumn(): number | undefined {
    return this.lastScrollbarVisible ? this.lastContentWidth : undefined;
  }

  // Map a click/drag on track row `row` to a scroll position, inverting the same
  // geometry the rendered thumb uses so the thumb tracks the pointer.
  scrollToTrackRow(row: number, width = this.lastWidth): void {
    this.lastWidth = width;
    const totalRows = this.lastFlattened.length;
    const visibleRows = this.visibleRowCount(width);
    if (totalRows <= visibleRows) return;
    const windowStart = clankieScrollbarWindowStartForRow(row, totalRows, visibleRows);
    this.scrollbackRows = totalRows - visibleRows - windowStart;
    this.clampScrollback(width, totalRows, visibleRows);
  }

  private applyScrollbar(rows: string[], width: number, totalRows: number, visibleRows: number): string[] {
    if (this.gutterWidth(width) === 0) {
      this.lastScrollbarVisible = false;
      this.lastContentWidth = width;
      return rows;
    }
    const contentWidth = Math.max(1, width - 1);
    this.lastContentWidth = contentWidth;
    this.lastScrollbarVisible = totalRows > visibleRows;
    const column = computeClankieScrollbarColumn(
      totalRows,
      visibleRows,
      this.lastWindowStart,
      this.scrollbarGlyphs,
      {
        thumb: this.theme.scrollbarThumb,
        track: this.theme.scrollbarTrack,
      },
    );
    return rows.map((line, index) => {
      const pad = Math.max(0, contentWidth - visibleWidth(line));
      return `${line}${" ".repeat(pad)}${column[index] ?? " "}`;
    });
  }

  private gutterWidth(width: number): number {
    return this.scrollbarEnabled && width >= SCROLLBAR_MIN_WIDTH ? 1 : 0;
  }

  selectionPress(row: number, col: number): void {
    const point = this.pointAt(row, col);
    this.selection = { anchor: point, head: point };
  }

  selectionDrag(row: number, col: number): void {
    if (this.selection === null) return;
    this.selection = { anchor: this.selection.anchor, head: this.pointAt(row, col) };
  }

  hasSelection(): boolean {
    if (this.selection === null) return false;
    const { anchor, head } = this.selection;
    return anchor.line !== head.line || anchor.col !== head.col;
  }

  clearSelection(): void {
    this.selection = null;
  }

  toggleCollapsedAt(row: number): boolean {
    const hit = this.blockAt(row);
    if (hit === undefined || !hit.block.collapsible || !hit.block.clickToggle) return false;
    this.selectedIndex = hit.index;
    hit.block.collapsed = !hit.block.collapsed;
    this.selection = null;
    this.ensureSelectedVisible();
    return true;
  }

  getSelectedText(): string {
    if (this.selection === null) return "";
    const [first, last] = orderSelectionPoints(this.selection.anchor, this.selection.head);
    const out: string[] = [];
    for (let line = first.line; line <= last.line; line++) {
      const text = this.lastFlattened[line];
      if (text === undefined) continue;
      const range = this.selectionColumns(first, last, line, text);
      out.push(
        range === null
          ? ""
          : stripAnsi(sliceByColumn(text, range[0], range[1] - range[0])).replace(/\s+$/u, ""),
      );
    }
    return out.join("\n");
  }

  private pointAt(row: number, col: number): SelectionPoint {
    const line = clamp(
      this.lastWindowStart + row - this.lastTopPad,
      0,
      Math.max(0, this.lastFlattened.length - 1),
    );
    return { col: Math.max(0, col), line };
  }

  private blockAt(row: number): { readonly block: TranscriptBlock; readonly index: number } | undefined {
    const flatIndex = this.lastWindowStart + row - this.lastTopPad;
    if (flatIndex < 0) return undefined;
    const rendered = this.renderBlocks(this.lastWidth);
    const index = rendered.findIndex((block) => flatIndex >= block.start && flatIndex < block.end);
    const renderedBlock = index < 0 ? undefined : rendered[index];
    return renderedBlock === undefined ? undefined : { block: renderedBlock.block, index };
  }

  private applyHighlight(line: string, flatIndex: number): string {
    if (this.selection === null || flatIndex < 0) return line;
    const [first, last] = orderSelectionPoints(this.selection.anchor, this.selection.head);
    const range = this.selectionColumns(first, last, flatIndex, line);
    if (range === null) return line;
    const before = sliceByColumn(line, 0, range[0]);
    const middle = stripAnsi(sliceByColumn(line, range[0], range[1] - range[0]));
    const after = sliceByColumn(line, range[1], Number.MAX_SAFE_INTEGER);
    return `${before}${SELECTION_RESET}${SELECTION_INVERSE}${middle}${SELECTION_RESET}${after}`;
  }

  private selectionColumns(
    first: SelectionPoint,
    last: SelectionPoint,
    line: number,
    text: string,
  ): [number, number] | null {
    if (line < first.line || line > last.line) return null;
    const width = visibleWidth(text);
    const lo = Math.max(line === first.line ? first.col : 0, this.prefixWidth);
    const hi = Math.min(line === last.line ? last.col : width, width);
    return hi > lo ? [lo, hi] : null;
  }

  private handleFor(block: TranscriptBlock): ClankieTranscriptBlockHandle {
    return {
      remove: () => this.removeChild(block.component),
      scrollIntoView: () => {
        const index = this.blocks.indexOf(block);
        if (index < 0) return;
        this.selectedIndex = index;
        this.ensureSelectedVisible();
      },
      setCollapsed: (collapsed) => {
        if (!block.collapsible) return;
        block.collapsed = collapsed;
        this.ensureSelectedVisible();
      },
      toggleCollapsed: () => {
        if (!block.collapsible) return;
        block.collapsed = !block.collapsed;
        this.ensureSelectedVisible();
      },
    };
  }

  private moveSelection(delta: number): void {
    if (this.blocks.length === 0) return;
    this.selectedIndex = clamp(this.selectedIndex + delta, 0, this.blocks.length - 1);
    this.ensureSelectedVisible();
  }

  private toggleSelectedCollapsed(): void {
    const block = this.blocks[this.selectedIndex];
    if (block === undefined || !block.collapsible) return;
    block.collapsed = !block.collapsed;
    this.ensureSelectedVisible();
  }

  private ensureSelectedVisible(width = this.lastWidth): void {
    const rendered = this.renderBlocks(width);
    const selected = rendered[this.selectedIndex];
    if (selected === undefined) {
      this.clampScrollback(width);
      return;
    }
    const maxRows = this.visibleRowCount(width);
    const totalRows = rendered.length === 0 ? 0 : (rendered[rendered.length - 1]?.end ?? 0);
    const currentEnd = Math.max(maxRows, totalRows - this.scrollbackRows);
    const currentStart = Math.max(0, currentEnd - maxRows);
    if (selected.start < currentStart) {
      this.scrollbackRows = totalRows - Math.min(totalRows, selected.start + maxRows);
    } else if (selected.end > currentEnd) {
      this.scrollbackRows = totalRows - selected.end;
    }
    this.clampScrollback(width, totalRows, maxRows);
  }

  private renderBlocks(width: number): RenderedBlock[] {
    const contentWidth = Math.max(1, width - this.gutterWidth(width));
    const childWidth = Math.max(1, this.focused ? contentWidth - 2 : contentWidth);
    let cursor = 0;
    return this.blocks.map((block, index) => {
      const selected = index === this.selectedIndex;
      const rawLines = block.component.render(childWidth);
      const blockLines = block.collapsed ? collapsedLines(rawLines, childWidth, this.theme) : rawLines;
      const bodyLines = blockLines.map((line, lineIndex) => {
        if (!this.focused) return truncateToWidth(line, contentWidth, "", true);
        const marker = selected && lineIndex === 0 ? ">" : " ";
        const cursorMarker = selected && this.focused && lineIndex === 0 ? CURSOR_MARKER : "";
        const prefix = selected ? this.theme.selected(`${marker} `) : `${marker} `;
        return `${prefix}${cursorMarker}${truncateToWidth(line, childWidth, "", true)}`;
      });
      const spacer = index === 0 ? [] : Array.from({ length: this.blockSpacing }, () => "");
      const lines = [...spacer, ...bodyLines];
      const rendered = { block, end: cursor + lines.length, lines, start: cursor };
      cursor = rendered.end;
      return rendered;
    });
  }

  private visibleRowCount(width: number): number {
    return Math.max(1, Math.floor(this.maxRows(width)));
  }

  private clampScrollback(width: number, renderedRows?: number, maxRows?: number): void {
    const totalRows =
      renderedRows ?? this.renderBlocks(width).reduce((sum, block) => sum + block.lines.length, 0);
    const visibleRows = maxRows ?? this.visibleRowCount(width);
    const maxScrollback = Math.max(0, totalRows - visibleRows);
    this.scrollbackRows = clamp(this.scrollbackRows, 0, maxScrollback);
  }
}

type ScrollbarColumnTheme = {
  readonly track: (text: string) => string;
  readonly thumb: (text: string) => string;
};

type ScrollbarGeometry = {
  readonly trackCells: number;
  // Thumb size and start expressed in half-cell "virtual" units (2 per row), so the
  // thumb can land on half-cell boundaries via the half-block glyphs.
  readonly thumb2: number;
  readonly start2: number;
  readonly range: number;
};

function clankieScrollbarGeometry(
  totalRows: number,
  visibleRows: number,
  windowStart: number,
): ScrollbarGeometry | null {
  const trackCells = Math.max(0, Math.floor(visibleRows));
  if (trackCells === 0 || totalRows <= 0 || totalRows <= visibleRows) return null;
  const track2 = trackCells * 2;
  const range = totalRows - visibleRows;
  const thumb2 = clamp(Math.floor(track2 * (visibleRows / totalRows)), 1, track2);
  const valueRatio = range === 0 ? 0 : clamp(windowStart, 0, range) / range;
  const start2 = Math.round(valueRatio * (track2 - thumb2));
  return { range, start2, thumb2, trackCells };
}

// Build the per-row scrollbar gutter for the visible window. Ports opentui's
// 2x-virtual thumb: each cell spans two virtual slots, so a half-covered end cell
// renders as a half block (▀/▄) for sub-cell-smooth thumb travel. Returns a blank
// column (one space per row) when content fits.
export function computeClankieScrollbarColumn(
  totalRows: number,
  visibleRows: number,
  windowStart: number,
  glyphs: ClankieScrollbarGlyphs,
  theme: ScrollbarColumnTheme,
): string[] {
  const geometry = clankieScrollbarGeometry(totalRows, visibleRows, windowStart);
  if (geometry === null) return Array.from({ length: Math.max(0, Math.floor(visibleRows)) }, () => " ");
  const thumbEnd2 = geometry.start2 + geometry.thumb2;
  const column: string[] = [];
  for (let cell = 0; cell < geometry.trackCells; cell++) {
    const cellStart2 = cell * 2;
    const coverStart = Math.max(geometry.start2, cellStart2);
    const coverage = Math.min(thumbEnd2, cellStart2 + 2) - coverStart;
    if (coverage <= 0) {
      column.push(theme.track(glyphs.track));
    } else if (coverage >= 2) {
      column.push(theme.thumb(glyphs.full));
    } else {
      column.push(theme.thumb(coverStart - cellStart2 === 0 ? glyphs.topHalf : glyphs.bottomHalf));
    }
  }
  return column;
}

// Inverse of the thumb geometry: given a clicked track row, return the window-top
// line index that puts the thumb under the pointer.
export function clankieScrollbarWindowStartForRow(
  row: number,
  totalRows: number,
  visibleRows: number,
): number {
  const geometry = clankieScrollbarGeometry(totalRows, visibleRows, 0);
  if (geometry === null) return 0;
  const thumbCells = Math.max(1, Math.ceil(geometry.thumb2 / 2));
  const denominator = Math.max(1, geometry.trackCells - thumbCells);
  return Math.round(clamp(row / denominator, 0, 1) * geometry.range);
}

export function isClankieTranscriptPageScrollInput(data: string, direction?: ScrollDirection): boolean {
  if (direction === "up") return matchesKey(data, Key.pageUp);
  if (direction === "down") return matchesKey(data, Key.pageDown);
  return matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown);
}

export function isClankieTranscriptMouseScrollInput(data: string, direction?: ScrollDirection): boolean {
  const actual = clankieTranscriptMouseScrollDirection(data);
  if (direction === undefined) return actual !== undefined;
  return actual === direction;
}

export function isClankieSgrMouseInput(data: string): boolean {
  return parseClankieSgrMouse(data) !== undefined;
}

export function clankieTranscriptMouseScrollDirection(data: string): ScrollDirection | undefined {
  const event = parseClankieSgrMouse(data);
  return event?.kind === "wheel" ? event.wheelDirection : undefined;
}

function orderSelectionPoints(a: SelectionPoint, b: SelectionPoint): [SelectionPoint, SelectionPoint] {
  if (a.line < b.line || (a.line === b.line && a.col <= b.col)) return [a, b];
  return [b, a];
}

// oxlint-disable no-control-regex -- intentionally matches ANSI escape sequences
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b[_P^][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/gu, "")
    .replace(/\x1b./gu, "");
}
// oxlint-enable no-control-regex

function collapsedLines(
  lines: readonly string[],
  width: number,
  theme: ClankieTranscriptViewportTheme,
): string[] {
  if (lines.length <= 1) return [...lines];
  const first = lines[0] ?? "";
  if (lines.length === 2) {
    return [
      truncateToWidth(first, width, "", true),
      theme.dim(truncateToWidth("... 1 hidden lines", width, "", true)),
    ];
  }
  const preview = lines.slice(1).find((line) => stripAnsi(line).trim().length > 0);
  const visible = preview === undefined ? [first] : [first, preview];
  const hidden = lines.length - visible.length;
  return [
    ...visible.map((line) => truncateToWidth(line, width, "", true)),
    theme.dim(truncateToWidth(`... ${hidden} hidden lines`, width, "", true)),
  ];
}

function matchesAny(data: string, ...keys: KeyId[]): boolean {
  return keys.some((key) => matchesKey(data, key));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
