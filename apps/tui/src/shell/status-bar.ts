/**
 * Status bar band of the face shell: a single component whose text the shell
 * recomputes on every state change. Wraps long transient messages (e.g. a
 * modal's result surfaced via flow.renderOutput) across rows instead of
 * clipping, capped so a pathological message can't eat the screen. Ported from
 * v1 (clankie snapshot 04734df9, scripts/clankie.ts).
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export const STATUS_BAR_MAX_ROWS = 6;

export class ClankieStatusBarComponent implements Component {
  private text = "";

  setText(text: string): void {
    this.text = text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.text.trim().length === 0) return [];
    const topSpacer = this.text.startsWith("\n");
    const bottomSpacer = this.text.endsWith("\n");
    const content = this.text.replace(/^\n/u, "").replace(/\n$/u, "");
    const blank = " ".repeat(Math.max(1, width));
    return [
      ...(topSpacer ? [blank] : []),
      ...formatStatusRows(content, width),
      ...(bottomSpacer ? [blank] : []),
    ];
  }
}

function formatSingleStatusRow(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const paddingX = safeWidth > 2 ? 1 : 0;
  const contentWidth = Math.max(1, safeWidth - paddingX * 2);
  const content = truncateToWidth(text, contentWidth, "", true);
  const row = `${" ".repeat(paddingX)}${content}${" ".repeat(paddingX)}`;
  return `${row}${" ".repeat(Math.max(0, safeWidth - visibleWidth(row)))}`;
}

export function formatStatusRows(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const paddingX = safeWidth > 2 ? 1 : 0;
  const contentWidth = Math.max(1, safeWidth - paddingX * 2);
  const rows: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      rows.push("");
      continue;
    }
    rows.push(...wrapTextWithAnsi(line, contentWidth));
  }
  if (rows.length === 0) rows.push("");
  const limited =
    rows.length > STATUS_BAR_MAX_ROWS
      ? [
          ...rows.slice(0, STATUS_BAR_MAX_ROWS - 1),
          `${truncateToWidth(rows[STATUS_BAR_MAX_ROWS - 1] ?? "", Math.max(1, contentWidth - 1), "", true)}…`,
        ]
      : rows;
  return limited.map((row) => formatSingleStatusRow(row, width));
}
