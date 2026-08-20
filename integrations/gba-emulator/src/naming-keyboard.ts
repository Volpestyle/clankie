import type { GbaButton } from "@clankie/interactive-environment";
import type { GbaCoreNamingState } from "./core-double.ts";

/**
 * The FireRed naming-screen keyboard, as empirically verified against the
 * pinned core (2026-07-26 naming probe): key grids per page, ring sizes, and
 * the button strip. Pure data and single-step planning — the adapter presses
 * and verifies every step against live state, so an inferred cell that turns
 * out wrong is caught by the typed-byte check rather than trusted.
 *
 * Deliberately conservative where the probe flagged gaps: vertical movement
 * never wraps (the up-wrap on letter columns was not exercised), the symbols
 * page's button strip is never used (its row roles are unverified — a submit
 * from the symbols page first cycles back to the upper page), and the
 * quote/gender keys are outside the action's character set entirely.
 */

export type NamingPage = GbaCoreNamingState["page"];

/** SELECT cycles upper → lower → symbols → upper. */
const PAGE_CYCLE: readonly NamingPage[] = ["upper-case", "lower-case", "symbols"];

/** Column occupied by the page/BACK/OK strip; the ring size is one more. */
export const BUTTON_COLUMN: Readonly<Record<NamingPage, number>> = {
  "upper-case": 8,
  "lower-case": 8,
  symbols: 6,
};

/** OK is the strip's third row. START jumps here from anywhere on the page. */
export const OK_ROW = 2;

/**
 * Key grids. Row-major, empty string marks a cell this module must not
 * target (untyped blanks and the transcribed-only inner space keys).
 */
const PAGE_KEYS: Readonly<Record<NamingPage, readonly (readonly string[])[]>> = {
  "upper-case": [
    ["A", "B", "C", "D", "E", "F", " ", "."],
    ["G", "H", "I", "J", "K", "L", "", ","],
    ["M", "N", "O", "P", "Q", "R", "S"],
    ["T", "U", "V", "W", "X", "Y", "Z"],
  ],
  "lower-case": [
    ["a", "b", "c", "d", "e", "f", " ", "."],
    ["g", "h", "i", "j", "k", "l", "", ","],
    ["m", "n", "o", "p", "q", "r", "s"],
    ["t", "u", "v", "w", "x", "y", "z"],
  ],
  symbols: [
    ["0", "1", "2", "3", "4", ""],
    ["5", "6", "7", "8", "9", ""],
    ["!", "?", "", "", "/", "-"],
  ],
};

export interface NamingKeyPosition {
  page: NamingPage;
  row: number;
  column: number;
}

/**
 * Where `character` lives, preferring the current page (space and punctuation
 * exist on both letter pages) and otherwise the fewest SELECT presses away.
 */
export function findNamingKey(character: string, currentPage: NamingPage): NamingKeyPosition | null {
  const order = [...Array(PAGE_CYCLE.length).keys()].map(
    (offset) => PAGE_CYCLE[(PAGE_CYCLE.indexOf(currentPage) + offset) % PAGE_CYCLE.length],
  );
  for (const page of order) {
    if (page === undefined) continue;
    const rows = PAGE_KEYS[page];
    for (const [row, keys] of rows.entries()) {
      const column = keys.indexOf(character);
      if (column >= 0) return { page, row, column };
    }
  }
  return null;
}

/**
 * The next d-pad press toward a key, or null when the cursor is on it.
 *
 * Columns move first (getting off the button strip before any vertical move,
 * whose behaviour there is only verified for rows 0–2) and may wrap in either
 * direction — both horizontal wraps are verified. Rows then move directly,
 * never wrapping.
 */
export function stepTowardNamingKey(
  page: NamingPage,
  from: { row: number; column: number },
  to: { row: number; column: number },
): GbaButton | null {
  if (from.column !== to.column) {
    const ring = BUTTON_COLUMN[page] + 1;
    const rightward = (to.column - from.column + ring) % ring;
    return rightward <= ring - rightward ? "right" : "left";
  }
  if (from.row !== to.row) return to.row > from.row ? "down" : "up";
  return null;
}
