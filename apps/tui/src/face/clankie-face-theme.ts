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

// Shared Clankie face palette, unified with pi's dark theme so the chrome
// (banner, typeahead, workbench, footer) matches the pi-rendered chat surface:
// accent #8abeb7, error #cc6666, dim #666666, muted #808080, mdLink #81a2be,
// text #d4d4d4, success #b5bd68, and pi's heading gold #f0c674 for warnings
// (pi's literal warning #ffff00 is too harsh for chrome text).
const PALETTE: Record<ClankieFaceColor, Rgb> = {
  accent: [138, 190, 183],
  code: [138, 190, 183],
  danger: [204, 102, 102],
  dim: [102, 102, 102],
  label: [128, 128, 128],
  link: [129, 162, 190],
  selectedDescription: [212, 212, 212],
  success: [181, 189, 104],
  warning: [240, 198, 116],
};

const PALETTE_256: Record<ClankieFaceColor, number> = {
  accent: 109,
  code: 109,
  danger: 167,
  dim: 241,
  label: 244,
  link: 110,
  selectedDescription: 252,
  success: 143,
  warning: 222,
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
