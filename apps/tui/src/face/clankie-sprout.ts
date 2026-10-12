/**
 * `pack` is the first idle frame in `branding/pet/src/pet/idle.txt`, trimmed
 * to the figure; its palette is in `branding/pet/src/palette.txt`. Redraw
 * there and copy here, never edit this figure alone. The renderer reduces
 * those pixels to a compact silhouette instead of keeping a second drawing.
 */
import { paintClankieFaceText, type ClankieFaceThemeCapabilities } from "./clankie-face-theme.ts";

type Rgb = readonly [number, number, number];

export interface ClankieSprite {
  /** Rows of palette keys; `.` is transparent. Even row count. */
  readonly grid: readonly string[];
  readonly palette: Readonly<Record<string, Rgb>>;
}

const SPROUT: ClankieSprite = {
  grid: [
    ".............LLLLLLL..",
    ".LLLLLL....lLLLLLLLLl.",
    "LLLLLLLl..slLLLLLLLLLl",
    "lLLLLLlllfsllllllll...",
    ".lll.....fssll........",
    ".........fss..........",
    ".........fss..........",
    "........sffs..........",
    "....oooooossoooooo....",
    "...occcccccccccccco...",
    "..occcccccccccccccco..",
    "..ocffffffffffffffco..",
    "..ocfccccccccccccfco..",
    "..ocfccccccccccccfco..",
    "..ocfcceecccceeccfco..",
    "..ocfcceecccceeccfco..",
    "..ocfcppccccccppcfco..",
    "..ocffffffffffffffco..",
    "...occddddddddddcco...",
    "....oooooooooooooo....",
    ".......oooooooo.......",
    "......obbbLLbbbo......",
    "....obobbLllLbbobo....",
    "....obobbbLLbbbobo....",
    "....ooBBBBBBBBBBoo....",
    "......obbo..obbo......",
    "......oBBo..oBBo......",
    "......oooo..oooo......",
  ],
  palette: {
    L: [0xc6, 0xd6, 0x68], // leaf light
    l: [0x7d, 0x8f, 0x41], // leaf dark
    s: [0x9e, 0x8b, 0x57], // stem
    f: [0x80, 0x64, 0x40], // frame
    o: [0x50, 0x3b, 0x2c], // outline
    c: [0xf2, 0xe5, 0xc8], // face
    e: [0x26, 0x2f, 0x3a], // eyes
    p: [0xf3, 0xb2, 0xa4], // cheeks
    d: [0xe3, 0xd3, 0xae], // face shade
    b: [0xdf, 0xdd, 0xb6], // body
    B: [0xb2, 0xae, 0x7e], // body shade
  },
};

/**
 * Lead skins the console can draw, by `appearance.leadSkin` id. Skins are
 * client data (ADR 0248): an id the console does not bundle falls back to
 * `pack`, his default sprout.
 */
const LEAD_SPRITES: Readonly<Record<string, ClankieSprite>> = { pack: SPROUT };

export function leadSprite(leadSkin: string | undefined): ClankieSprite {
  return (leadSkin === undefined ? undefined : LEAD_SPRITES[leadSkin]) ?? SPROUT;
}

/** Drawn when the terminal cannot show Unicode blocks. */
export const ASCII_SPROUT: readonly string[] = [" \\\\ //", "  \\|/", " .----.", " |o  o|", " '----'"];

/** Two pet pixels across become one terminal column. */
export function spriteColumns(sprite: ClankieSprite): number {
  return Math.ceil((sprite.grid[0]?.length ?? 0) / 2);
}

/**
 * Reduce the pet's pixels while preserving its screen frame and eyes. Leaves
 * use the theme green; the frame, eyes, stem and body inherit the terminal
 * foreground. Screen pixels are holes, never a painted background.
 */
export function renderSprite(sprite: ClankieSprite, caps: ClankieFaceThemeCapabilities): string[] {
  const pixels: { filled: boolean; leaf: boolean }[][] = [];
  const headTop = sprite.grid.findIndex((row) => row.includes("o"));
  const bodyTop = sprite.grid.findIndex((row) => row.includes("b") || row.includes("B"));
  for (let y = 0; y < sprite.grid.length; y += 2) {
    const row: { filled: boolean; leaf: boolean }[] = [];
    const screenMiddle = [0, 1].every((dy) => {
      const sourceRow = [...(sprite.grid[y + dy] ?? "")];
      const framePixels = sourceRow.filter((key) => key === "f").length;
      return framePixels <= 2 && sourceRow.filter((key) => key === "c").length > framePixels + 2;
    });
    for (let x = 0; x < (sprite.grid[0]?.length ?? 0); x += 2) {
      const keys = [0, 1].flatMap((dy) => [0, 1].map((dx) => sprite.grid[y + dy]?.[x + dx] ?? "."));
      const leaves = keys.filter((key) => key === "L" || key === "l").length;
      const frame = keys.filter((key) => key === "o" || (!screenMiddle && key === "f")).length;
      // An eye straddling a reduction cell still becomes one eye, at the
      // start of its run, rather than widening into two adjacent blocks.
      const eye = [0, 1].some((dy) =>
        [0, 1].some(
          (dx) => sprite.grid[y + dy]?.[x + dx] === "e" && sprite.grid[y + dy]?.[x + dx - 1] !== "e",
        ),
      );
      // Above the head, don't merge the stem into the two leaf blobs. A
      // majority keeps the thin stem one column wide after reduction.
      const aboveHead = headTop >= 0 && y < headTop;
      const filled = aboveHead
        ? leaves >= 2 || keys.filter((key) => key === "s" || key === "f").length >= 3
        : eye ||
          frame >= 2 ||
          (bodyTop >= 0 &&
            y >= bodyTop - 1 &&
            keys.filter((key) => sprite.palette[key] !== undefined).length >= 2);
      row.push({ filled, leaf: aboveHead && leaves >= 2 });
    }
    pixels.push(row);
  }
  const lines: string[] = [];
  for (let y = 0; y < pixels.length; y += 2) {
    lines.push(
      (pixels[y] ?? [])
        .map((upper, x) => {
          const lower = pixels[y + 1]?.[x];
          const glyph = upper.filled ? (lower?.filled ? "█" : "▀") : lower?.filled ? "▄" : " ";
          return upper.leaf || lower?.leaf ? paintClankieFaceText(glyph, { fg: "success" }, caps) : glyph;
        })
        .join("")
        .trimEnd(),
    );
  }
  return lines;
}
