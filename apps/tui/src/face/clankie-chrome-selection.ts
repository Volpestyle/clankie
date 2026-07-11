/**
 * Mouse text selection for the face's static chrome and modal overlays. The
 * transcript band owns its own selection (it has scrollback the chrome lacks);
 * this covers everything around it so the whole window is selectable while SGR
 * mouse tracking suppresses the terminal's native drag-select.
 *
 * Selection is scoped to a single band per drag: pressing in the banner and
 * dragging into the status row keeps the selection within the banner. Each
 * wrapped chrome component renders normally, then this controller paints the
 * inverse highlight over the selected columns of its own lines.
 */
import { sliceByColumn, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";

export type ClankieChromeBand = "banner" | "modal" | "status" | "typeahead";

type Point = {
  readonly row: number;
  readonly col: number;
};

type Selection = {
  readonly band: ClankieChromeBand;
  readonly anchor: Point;
  readonly head: Point;
};

const SELECTION_INVERSE = "\x1b[7m";
const SELECTION_RESET = "\x1b[0m";

export class ClankieChromeSelection {
  private selection: Selection | null = null;
  private readonly bandLines = new Map<ClankieChromeBand, readonly string[]>();

  press(band: ClankieChromeBand, row: number, col: number): void {
    const point: Point = { col: Math.max(0, col), row: Math.max(0, row) };
    this.selection = { anchor: point, band, head: point };
  }

  drag(band: ClankieChromeBand, row: number, col: number): void {
    if (this.selection === null || this.selection.band !== band) return;
    this.selection = {
      anchor: this.selection.anchor,
      band,
      head: { col: Math.max(0, col), row: Math.max(0, row) },
    };
  }

  clear(): void {
    this.selection = null;
  }

  clearBand(band: ClankieChromeBand): void {
    this.bandLines.delete(band);
    if (this.selection?.band === band) this.selection = null;
  }

  isActive(): boolean {
    return this.selection !== null;
  }

  hasSelection(): boolean {
    if (this.selection === null) return false;
    const { anchor, head } = this.selection;
    return anchor.row !== head.row || anchor.col !== head.col;
  }

  /** Capture a band's rendered lines and return them with the highlight applied. */
  applyBand(band: ClankieChromeBand, lines: string[]): string[] {
    this.bandLines.set(band, lines.map(stripAnsi));
    if (this.selection === null || this.selection.band !== band) return lines;
    return lines.map((line, index) => this.highlightLine(line, index));
  }

  getSelectedText(): string {
    if (this.selection === null) return "";
    const lines = this.bandLines.get(this.selection.band);
    if (lines === undefined) return "";
    const [first, last] = orderPoints(this.selection.anchor, this.selection.head);
    const out: string[] = [];
    for (let row = first.row; row <= last.row; row++) {
      const text = lines[row];
      if (text === undefined) continue;
      const range = selectionColumns(first, last, row, text);
      out.push(range === null ? "" : sliceByColumn(text, range[0], range[1] - range[0]).replace(/\s+$/u, ""));
    }
    return out.join("\n");
  }

  private highlightLine(line: string, row: number): string {
    if (this.selection === null) return line;
    const [first, last] = orderPoints(this.selection.anchor, this.selection.head);
    const range = selectionColumns(first, last, row, line);
    if (range === null) return line;
    const before = sliceByColumn(line, 0, range[0]);
    const middle = stripAnsi(sliceByColumn(line, range[0], range[1] - range[0]));
    const after = sliceByColumn(line, range[1], Number.MAX_SAFE_INTEGER);
    return `${before}${SELECTION_RESET}${SELECTION_INVERSE}${middle}${SELECTION_RESET}${after}`;
  }
}

/**
 * A chrome component wrapped so the face can drag-select and copy its text. The
 * inner component keeps full ownership of its rendering; the wrapper only
 * threads the rendered lines through the shared selection controller.
 */
export class ClankieChromeSelectableComponent implements Component, Focusable {
  private readonly inner: Component;
  private readonly band: ClankieChromeBand;
  private readonly selection: ClankieChromeSelection;
  private ownFocused = false;

  constructor(inner: Component, band: ClankieChromeBand, selection: ClankieChromeSelection) {
    this.inner = inner;
    this.band = band;
    this.selection = selection;
  }

  render(width: number): string[] {
    return this.selection.applyBand(this.band, this.inner.render(width));
  }

  get focused(): boolean {
    return isFocusableComponent(this.inner) ? this.inner.focused : this.ownFocused;
  }

  set focused(value: boolean) {
    this.ownFocused = value;
    if (isFocusableComponent(this.inner)) this.inner.focused = value;
  }

  get wantsKeyRelease(): boolean {
    return this.inner.wantsKeyRelease ?? false;
  }

  handleInput(data: string): void {
    this.inner.handleInput?.(data);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}

function isFocusableComponent(component: Component): component is Component & Focusable {
  return "focused" in component;
}

function selectionColumns(first: Point, last: Point, row: number, text: string): [number, number] | null {
  if (row < first.row || row > last.row) return null;
  const width = visibleWidth(text);
  const lo = row === first.row ? first.col : 0;
  const hi = Math.min(row === last.row ? last.col : width, width);
  return hi > lo ? [lo, hi] : null;
}

function orderPoints(a: Point, b: Point): [Point, Point] {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) return [a, b];
  return [b, a];
}

function stripAnsi(text: string): string {
  // oxlint-disable no-control-regex -- intentionally matches ANSI escape sequences
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b[_P^][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/gu, "")
    .replace(/\x1b./gu, "");
  // oxlint-enable no-control-regex
}
