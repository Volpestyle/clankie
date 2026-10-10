/**
 * Clankie's welcome screen, the first thing in every transcript: his lead look
 * drawn in terminal pixels beside his name and how to start.
 *
 * Degrades on capability: truecolor -> 256-color -> no color, and a Unicode
 * support check. Narrow or short terminals get one condensed line instead,
 * so the header never wraps into noise.
 */
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { paintClankieFaceText, type ClankieFaceColor } from "./clankie-face-theme.ts";
import { ASCII_SPROUT, leadSprite, renderSprite, spriteColumns } from "./clankie-sprout.ts";

export type BannerCapabilities = {
  /** Emit ANSI color (false for NO_COLOR / non-TTY / dumb terminals). */
  color: boolean;
  /** Use Unicode block art (false falls back to ASCII). */
  unicode: boolean;
  /** Truecolor (24-bit) support; when false but color is true, use 256-color. */
  trueColor: boolean;
  /** Terminal width in columns. */
  columns: number;
};

export type BannerFields = {
  title: string;
  /** `appearance.leadSkin`; ids the console does not bundle draw the default sprout. */
  leadSkin?: string | undefined;
};

/** The full welcome needs this many terminal rows; fewer gets the condensed line. */
const WELCOME_MIN_ROWS = 26;
const WELCOME_MIN_COLUMNS = 44;

export class ClankieBannerComponent implements Component {
  private readonly caps: BannerCapabilities;
  private fields: BannerFields;
  private readonly terminalRows: () => number;
  private visible: boolean;
  private topPaddingRows = 1;
  private bottomPaddingRows = 1;

  constructor(
    fields: BannerFields,
    caps: BannerCapabilities,
    visible = true,
    terminalRows: () => number = () => Number.POSITIVE_INFINITY,
  ) {
    this.fields = fields;
    this.caps = caps;
    this.visible = visible;
    this.terminalRows = terminalRows;
  }

  setLeadSkin(leadSkin: string | undefined): void {
    this.fields = { ...this.fields, leadSkin };
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  setVerticalPadding(options: { readonly bottom?: number; readonly top?: number }): void {
    this.topPaddingRows = Math.max(0, Math.floor(options.top ?? this.topPaddingRows));
    this.bottomPaddingRows = Math.max(0, Math.floor(options.bottom ?? this.bottomPaddingRows));
  }

  isVisible(): boolean {
    return this.visible;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.visible) return [];
    const renderWidth = Math.max(1, width);
    const lines = renderClankieBanner(
      this.fields,
      { ...this.caps, columns: renderWidth },
      this.terminalRows(),
    );
    return [
      ...Array.from({ length: this.topPaddingRows }, () => ""),
      ...lines.map((line) => truncateToWidth(line, renderWidth, "", true)),
      ...Array.from({ length: this.bottomPaddingRows }, () => ""),
    ];
  }
}

export function renderClankieBanner(
  fields: BannerFields,
  caps: BannerCapabilities,
  terminalRows = Number.POSITIVE_INFINITY,
): string[] {
  if (caps.columns < WELCOME_MIN_COLUMNS || terminalRows < WELCOME_MIN_ROWS) {
    return renderCondensed(fields, caps);
  }
  const sprite = leadSprite(fields.leadSkin);
  const art = caps.unicode ? renderSprite(sprite, caps) : [...ASCII_SPROUT];
  const artWidth = caps.unicode
    ? spriteColumns(sprite)
    : Math.max(...ASCII_SPROUT.map((line) => line.length));
  const dim = (text: string) => paint(text, { fg: "dim" }, caps);
  const text = [
    paint(fields.title.toLowerCase(), { fg: "accent", bold: true }, caps),
    "",
    dim("Ask for anything, or type / for commands."),
    dim(`Click a tool row to open it ${caps.unicode ? "·" : "-"} ctrl+o opens them all.`),
  ];
  // The words sit beside his face, not his sprout.
  const textTop = Math.max(0, Math.floor((art.length - text.length) / 2) + (caps.unicode ? 1 : 0));
  return art.map((line, row) => {
    const words = text[row - textTop];
    if (words === undefined || words === "") return ` ${line}`;
    const gap = " ".repeat(Math.max(0, artWidth - visibleColumns(line)) + 4);
    return ` ${line}${gap}${words}`;
  });
}

function visibleColumns(line: string): number {
  // oxlint-disable-next-line no-control-regex -- strips the sprite's SGR colors
  return [...line.replace(/\x1b\[[0-9;]*m/gu, "")].length;
}

/** A full-width colored rule that underlines the header block. */
function renderRule(caps: BannerCapabilities): string {
  const width = Math.max(1, caps.columns - 2);
  const glyph = caps.unicode ? "─" : "-";
  return ` ${paint(glyph.repeat(width), { fg: "accent" }, caps)}`;
}

function renderCondensed(fields: BannerFields, caps: BannerCapabilities): string[] {
  const mascot = paint(clankieMascot(caps), { fg: "accent", bold: true }, caps);
  const head = paint(fields.title.toLowerCase(), { fg: "accent", bold: true }, caps);
  return [` ${mascot} ${head}`, renderRule(caps)];
}

function paint(
  text: string,
  style: {
    fg?: ClankieFaceColor;
    bold?: boolean;
  },
  caps: BannerCapabilities,
): string {
  return paintClankieFaceText(text, style, caps);
}

/**
 * Clankie's inline mascot: a little robot face that rides alongside the name.
 * The brackets read as a head/screen, `◉` eyes, `‿` a contented mouth. Falls
 * back to plain ASCII when the terminal can't render the unicode glyphs.
 */
function clankieMascot(caps: BannerCapabilities): string {
  return caps.unicode ? "[◉‿◉]" : "[o_o]";
}

/** Detect banner capabilities from the environment and an output stream. */
export function detectBannerCapabilities(
  output: { isTTY?: boolean; columns?: number },
  env: NodeJS.ProcessEnv = process.env,
): BannerCapabilities {
  const isTTY = output.isTTY === true;
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const color = isTTY && !noColor && env.TERM !== "dumb";
  const colorTerm = env.COLORTERM ?? "";
  const trueColor = color && (colorTerm.includes("truecolor") || colorTerm.includes("24bit"));
  const unicode = detectUnicode(env);
  const columns = typeof output.columns === "number" && output.columns > 0 ? output.columns : 80;
  return { color, unicode, trueColor, columns };
}

function detectUnicode(env: NodeJS.ProcessEnv): boolean {
  const flag = env.CLANKIE_TUI_UNICODE;
  if (flag === "0" || flag === "false") return false;
  if (flag === "1" || flag === "true") return true;
  if (env.TERM === "dumb") return false;
  if (process.platform === "win32") return env.WT_SESSION !== undefined || env.TERM_PROGRAM === "vscode";
  return true;
}
