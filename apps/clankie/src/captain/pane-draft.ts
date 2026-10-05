/** Cell styling is required: identical placeholder words can be an owner's draft. */
export type PaneDraftState = "empty" | "draft" | "unknown";
type Cell = { text: string; faint: boolean; italic: boolean };

function styledLines(ansi: string): Cell[][] | undefined {
  // oxlint-disable-next-line no-control-regex -- native SGR styling is the input evidence
  if (!/\x1b\[[0-9;]*m/u.test(ansi)) return undefined;
  let faint = false,
    italic = false;
  const rows: Cell[][] = [[]];
  // oxlint-disable-next-line no-control-regex -- tokenize native ANSI cell attributes
  const tokens = ansi.match(/\x1b\[[0-9;]*m|[^\x1b]/gu);
  if (!tokens) return undefined;
  for (const token of tokens) {
    if (token.startsWith("\x1b")) {
      const values = token.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        // Colour payloads contain numbers such as 2 and 3; these are not attributes.
        if (value === 38 || value === 48 || value === 58) {
          i += values[i + 1] === 2 ? 4 : values[i + 1] === 5 ? 2 : 0;
        } else if (value === 0) {
          faint = false;
          italic = false;
        } else if (value === 2) faint = true;
        else if (value === 3) italic = true;
        else if (value === 22) faint = false;
        else if (value === 23) italic = false;
      }
    } else if (token === "\n") rows.push([]);
    else if (token !== "\r") rows.at(-1)!.push({ text: token, faint, italic });
  }
  return rows;
}

export function paneDraftState(harness: string, ansi: string): PaneDraftState {
  // Do not interpret cursor controls, malformed escapes, or unstyled output as an empty input.
  // oxlint-disable-next-line no-control-regex -- reject non-SGR terminal controls
  if (/\x1b(?!\[[0-9;]*m)/u.test(ansi)) return "unknown";
  const rows = styledLines(ansi);
  if (!rows || !["codex", "claude"].includes(harness)) return "unknown";
  const marker = harness === "codex" ? "›" : "❯";
  const start = rows.findLastIndex((row) =>
    row
      .map((cell) => cell.text)
      .join("")
      .trimStart()
      .startsWith(marker),
  );
  if (start < 0 || start < rows.length - 16) return "unknown";
  const row = rows[start]!;
  const at = row.findIndex((cell) => cell.text === marker);
  if (
    harness === "claude" &&
    !/^[─━]{8,}$/u.test(
      rows[start - 1]
        ?.map((cell) => cell.text)
        .join("")
        .trim() ?? "",
    )
  )
    return "unknown";
  const input: Cell[] = row.slice(at + 1);
  let bounded = harness === "codex";
  for (const next of rows.slice(start + 1)) {
    const plain = next
      .map((cell) => cell.text)
      .join("")
      .trim();
    if (harness === "claude" && /^[─━]{8,}$/u.test(plain)) {
      bounded = true;
      break;
    }
    if (harness === "codex" && plain.length === 0) break;
    if (harness === "codex" && /^\?\s+for shortcuts/u.test(plain)) break;
    input.push(...next);
  }
  if (!bounded) return "unknown";
  const content = input.filter((cell) => cell.text.trim().length > 0);
  if (content.length === 0) return "empty";
  const text = input
    .map((cell) => cell.text)
    .join("")
    .trim();
  if (content.some((cell) => !cell.faint && !cell.italic)) return "draft";
  // Live Claude 2.1.289: variable suggestions are faint; typed input is ordinary.
  // Accept a ghost only inside the native two-rule composer, with uniformly faint cells.
  if (harness === "claude") return content.every((cell) => cell.faint) ? "empty" : "unknown";
  if (text === "Ask Codex to do anything" && content.every((cell) => cell.faint)) return "empty";
  return "unknown";
}
