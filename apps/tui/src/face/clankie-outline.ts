import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function renderClankieOutline(
  lines: readonly string[],
  width: number,
  border: (text: string) => string,
): string[] {
  const renderWidth = Math.max(4, width);
  const innerWidth = Math.max(1, renderWidth - 4);
  const horizontal = "─".repeat(Math.max(0, renderWidth - 2));
  return [
    border(`┌${horizontal}┐`),
    ...lines.map((line) => {
      const fitted = truncateToWidth(line, innerWidth, "", true);
      return `${border("│")} ${padVisible(fitted, innerWidth)} ${border("│")}`;
    }),
    border(`└${horizontal}┘`),
  ];
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
