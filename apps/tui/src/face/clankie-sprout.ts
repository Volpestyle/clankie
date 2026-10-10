/**
 * Clankie's lead looks as terminal pixel art. Each sprite is a pixel grid
 * drawn two pixels per cell with half blocks, so pixels stay square.
 *
 * `pack` is his default leaf sprout, copied from the first idle frame of the
 * desktop pet (`branding/pet/src/pet/idle.txt`, palette in
 * `branding/pet/src/palette.txt`), trimmed to the figure. Redraw it there and
 * copy it here; never edit the figure here alone.
 */
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

export function spriteColumns(sprite: ClankieSprite): number {
  return sprite.grid[0]?.length ?? 0;
}

/**
 * Two pixel rows per terminal row. Color uses foreground/background half
 * blocks; without color the figure keeps its silhouette.
 */
export function renderSprite(
  sprite: ClankieSprite,
  caps: { readonly color: boolean; readonly trueColor: boolean },
): string[] {
  const lines: string[] = [];
  for (let y = 0; y < sprite.grid.length; y += 2) {
    const top = sprite.grid[y] ?? "";
    const bottom = sprite.grid[y + 1] ?? "";
    let line = "";
    for (let x = 0; x < top.length; x++) {
      const upper = sprite.palette[top[x] ?? "."];
      const lower = sprite.palette[bottom[x] ?? "."];
      if (upper === undefined && lower === undefined) line += " ";
      else if (!caps.color) line += upper === undefined ? "▄" : lower === undefined ? "▀" : "█";
      else if (upper === undefined) line += `\x1b[${color(lower!, "38", caps)}m▄\x1b[0m`;
      else if (lower === undefined) line += `\x1b[${color(upper, "38", caps)}m▀\x1b[0m`;
      else line += `\x1b[${color(upper, "38", caps)};${color(lower, "48", caps)}m▀\x1b[0m`;
    }
    lines.push(line.replace(/ +$/u, ""));
  }
  return lines;
}

function color(rgb: Rgb, layer: "38" | "48", caps: { readonly trueColor: boolean }): string {
  if (caps.trueColor) return `${layer};2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  // The xterm 6×6×6 cube.
  const level = (value: number) => (value < 48 ? 0 : value < 115 ? 1 : Math.floor((value - 35) / 40));
  return `${layer};5;${16 + 36 * level(rgb[0]) + 6 * level(rgb[1]) + level(rgb[2])}`;
}
