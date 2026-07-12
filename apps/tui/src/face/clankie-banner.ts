/**
 * Clankie's welcome banner.
 *
 * A compact text header with identity + model/harness/cwd + a hint line.
 *
 * Degrades on capability: truecolor -> 256-color -> no color, and a Unicode
 * support check. On narrow terminals it collapses to a single condensed line
 * so the header never wraps into noise.
 */
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { paintClankieFaceText, type ClankieFaceColor } from "./clankie-face-theme.ts";

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
  tagline: string;
  model?: string;
  harness?: string;
  cwd?: string;
  server?: string;
  /** Where this face sits inside the detected terminal multiplexer, or "none". */
  stage?: string;
  /** The row label for `stage` — the detected multiplexer ("herdr"/"tmux"). */
  stageLabel?: string;
  /** Non-default approval posture (e.g. armed yolo mode); omitted when gated. */
  approvals?: string;
  hint?: string;
};

export class ClankieBannerComponent implements Component {
  private readonly caps: BannerCapabilities;
  private fields: BannerFields;
  private visible: boolean;
  private topPaddingRows = 1;
  private bottomPaddingRows = 1;

  constructor(fields: BannerFields, caps: BannerCapabilities, visible = true) {
    this.fields = fields;
    this.caps = caps;
    this.visible = visible;
  }

  setFields(fields: BannerFields): void {
    this.fields = fields;
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
    const lines = renderClankieBanner(this.fields, { ...this.caps, columns: renderWidth });
    return [
      ...Array.from({ length: this.topPaddingRows }, () => ""),
      ...lines.map((line) => truncateToWidth(line, renderWidth, "", true)),
      ...Array.from({ length: this.bottomPaddingRows }, () => ""),
    ];
  }
}

export function renderClankieBanner(fields: BannerFields, caps: BannerCapabilities): string[] {
  if (caps.columns < 44) {
    return renderCondensed(fields, caps);
  }

  const lines = buildFeedLines(fields, caps).map((line) => (line.length === 0 ? "" : ` ${line}`));
  if (fields.hint !== undefined && fields.hint.length > 0) {
    lines.push("");
    lines.push(` ${paint(fields.hint, { fg: "dim" }, caps)}`);
  }
  lines.push(renderRule(caps));
  return lines;
}

/** A full-width colored rule that underlines the header block. */
function renderRule(caps: BannerCapabilities): string {
  const width = Math.max(1, caps.columns - 2);
  const glyph = caps.unicode ? "─" : "-";
  return ` ${paint(glyph.repeat(width), { fg: "accent" }, caps)}`;
}

function buildFeedLines(fields: BannerFields, caps: BannerCapabilities): string[] {
  const lines: string[] = [];
  const mascot = paint(clankieMascot(caps), { fg: "accent", bold: true }, caps);
  const name = paint(fields.title.toLowerCase(), { fg: "accent", bold: true }, caps);
  lines.push(`${mascot}  ${name}`);
  lines.push(paint(fields.tagline, { fg: "dim" }, caps));
  lines.push("");
  const rows = (
    [
      ["model", fields.model],
      ["harness", fields.harness],
      ["cwd", fields.cwd],
      ["server", fields.server],
      [fields.stageLabel ?? "stage", fields.stage],
      ["approvals", fields.approvals],
    ] as const
  ).filter(([, value]) => value !== undefined && value.length > 0);
  const labelWidth = Math.max(8, ...rows.map(([label]) => label.length + 1));
  for (const [label, value] of rows) {
    lines.push(`${paint(label.padEnd(labelWidth), { fg: "label" }, caps)}${paint(value ?? "", {}, caps)}`);
  }
  return lines;
}

function renderCondensed(fields: BannerFields, caps: BannerCapabilities): string[] {
  const mascot = paint(clankieMascot(caps), { fg: "accent", bold: true }, caps);
  const head = paint(fields.title.toLowerCase(), { fg: "accent", bold: true }, caps);
  const detail = fields.model !== undefined ? paint(` — ${fields.model}`, { fg: "dim" }, caps) : "";
  const lines = [` ${mascot} ${head}${detail}`];
  if (fields.hint !== undefined && fields.hint.length > 0) {
    lines.push(` ${paint(fields.hint, { fg: "dim" }, caps)}`);
  }
  lines.push(renderRule(caps));
  return lines;
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
  const flag = env.EVE_TUI_UNICODE ?? env.CLANKIE_TUI_UNICODE;
  if (flag === "0" || flag === "false") return false;
  if (flag === "1" || flag === "true") return true;
  if (env.TERM === "dumb") return false;
  if (process.platform === "win32") return env.WT_SESSION !== undefined || env.TERM_PROGRAM === "vscode";
  return true;
}
