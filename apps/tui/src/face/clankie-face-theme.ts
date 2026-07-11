import type { MarkdownTheme } from "@earendil-works/pi-tui";

export type ClankieFaceThemeCapabilities = {
  readonly color: boolean;
  readonly trueColor: boolean;
};

export type ClankieFaceColor =
  | "accent"
  | "code"
  | "danger"
  | "dim"
  | "label"
  | "link"
  | "selectedDescription"
  | "success"
  | "warning";

export type ClankieFaceAnsiTheme = {
  readonly accent: (text: string) => string;
  readonly blue: (text: string) => string;
  readonly bold: (text: string) => string;
  readonly code: (text: string) => string;
  readonly cyan: (text: string) => string;
  readonly danger: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly green: (text: string) => string;
  readonly italic: (text: string) => string;
  readonly label: (text: string) => string;
  readonly link: (text: string) => string;
  readonly red: (text: string) => string;
  readonly selectedDescription: (text: string) => string;
  readonly success: (text: string) => string;
  readonly underline: (text: string) => string;
  readonly warning: (text: string) => string;
  readonly yellow: (text: string) => string;
};

type Rgb = readonly [number, number, number];

// Shared Clankie face palette: warm accent, dusty neutrals, muted semantic colors.
const PALETTE: Record<ClankieFaceColor, Rgb> = {
  accent: [255, 196, 112],
  code: [206, 166, 118],
  danger: [220, 116, 108],
  dim: [128, 116, 112],
  label: [150, 132, 126],
  link: [126, 170, 190],
  selectedDescription: [198, 190, 186],
  success: [128, 168, 128],
  warning: [255, 196, 112],
};

const PALETTE_256: Record<ClankieFaceColor, number> = {
  accent: 215,
  code: 180,
  danger: 174,
  dim: 244,
  label: 245,
  link: 109,
  selectedDescription: 251,
  success: 108,
  warning: 215,
};

export function createClankieFaceAnsiTheme(caps: ClankieFaceThemeCapabilities): ClankieFaceAnsiTheme {
  const paint = (fg: ClankieFaceColor) => (text: string) => paintClankieFaceText(text, { fg }, caps);
  const attribute = (code: string, reset: string) => (text: string) =>
    caps.color ? `\x1b[${code}m${text}\x1b[${reset}m` : text;
  const accent = paint("accent");
  const code = paint("code");
  const danger = paint("danger");
  const label = paint("label");
  const link = paint("link");
  const selectedDescription = paint("selectedDescription");
  const success = paint("success");
  const warning = paint("warning");
  return {
    accent,
    blue: link,
    bold: attribute("1", "22"),
    code,
    cyan: accent,
    danger,
    dim: paint("dim"),
    green: success,
    italic: attribute("3", "23"),
    label,
    link,
    red: danger,
    selectedDescription,
    success,
    underline: attribute("4", "24"),
    warning,
    yellow: warning,
  };
}

/** Shared markdown palette for the face transcript and the read-only session mirror. */
export function createClankieFaceMarkdownTheme(ansi: ClankieFaceAnsiTheme): MarkdownTheme {
  return {
    bold: ansi.bold,
    code: ansi.yellow,
    codeBlock: ansi.green,
    codeBlockBorder: ansi.dim,
    heading: ansi.cyan,
    hr: ansi.dim,
    italic: ansi.italic,
    link: ansi.blue,
    linkUrl: ansi.dim,
    listBullet: ansi.cyan,
    quote: ansi.italic,
    quoteBorder: ansi.dim,
    strikethrough: ansi.dim,
    underline: ansi.underline,
  };
}

export function paintClankieFaceText(
  text: string,
  style: {
    readonly fg?: ClankieFaceColor;
    readonly bold?: boolean;
  },
  caps: ClankieFaceThemeCapabilities,
): string {
  if (!caps.color) return text;
  const codes: string[] = [];
  if (style.bold === true) codes.push("1");
  if (style.fg !== undefined) codes.push(colorCode(style.fg, false, caps));
  if (codes.length === 0) return text;
  return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
}

function colorCode(color: ClankieFaceColor, background: boolean, caps: ClankieFaceThemeCapabilities): string {
  const layer = background ? "48" : "38";
  if (caps.trueColor) {
    const [r, g, b] = PALETTE[color];
    return `${layer};2;${r};${g};${b}`;
  }
  return `${layer};5;${PALETTE_256[color]}`;
}
