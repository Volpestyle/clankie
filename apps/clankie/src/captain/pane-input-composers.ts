import type { PaneInputCell, PaneInputLine } from "./pane-draft.ts";

type Row = readonly PaneInputCell[];
const plain = (row: Row) => row.map((cell) => cell.text).join("");
const unknown = (): PaneInputLine => ({ state: "unknown" });
const content = (rows: readonly Row[]): PaneInputLine => {
  const text = rows.map(plain).join("\n").trim();
  return text ? { state: "draft", text, typed: true } : { state: "empty" };
};

/** Only a coloured native frame can delimit input; a rule typed in the editor cannot. */
function rule(row: Row, pattern: RegExp, foreground?: string): boolean {
  const cells = row.filter((cell) => cell.text.trim());
  return (
    cells.length > 0 &&
    pattern.test(plain(row).trim()) &&
    cells[0]!.foreground !== undefined &&
    cells.every((cell) => cell.foreground === (foreground ?? cells[0]!.foreground))
  );
}

function pi(rows: readonly Row[]): PaneInputLine {
  // Pi 1.3.0: editor, cwd, context/model footer. Menus and scrolled editors are unknown.
  const end = rows.length - 3;
  const footer = rows.at(-1);
  const cwd = rows.at(-2);
  if (
    !footer ||
    !cwd ||
    !/^\d+(?:\.\d+)?%\/\S+.*\([^)]+\) .+/u.test(plain(footer).trim()) ||
    !plain(cwd).trim().startsWith("/") ||
    ![...footer, ...cwd].filter((cell) => cell.text.trim()).every((cell) => cell.faint) ||
    !rows[end] ||
    !rule(rows[end]!, /^─{8,}$/u)
  )
    return unknown();
  const border = rows[end]!.find((cell) => cell.text === "─")!.foreground;
  const starts = rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row, index }) => index >= Math.max(0, end - 14) && index <= end - 2 && rule(row, /^─{8,}$/u, border),
    );
  if (starts.length !== 1) return unknown();
  const start = starts[0]!.index;
  const input = rows.slice(start + 1, end);
  // A coloured rule or scroll indicator inside the slice makes the boundary ambiguous.
  if (input.some((row) => row.some((cell) => cell.text.trim() && cell.foreground === border)))
    return unknown();
  if (plain(rows[start]!).length !== plain(rows[end]!).length) return unknown();
  return content(input);
}

function grok(rows: readonly Row[]): PaneInputLine {
  // Grok Build 1.0.70 fullscreen: a framed ❯ editor with its model on the bottom rule.
  const end = rows.findLastIndex((row) => /^\s*╰─{8,} Grok [^╯]+ ─╯\s*$/u.test(plain(row)));
  if (
    end < 2 ||
    end < rows.length - 5 ||
    rows.slice(end + 1).some((row) => !/^(?:Logged in with API key)?$/u.test(plain(row).trim()))
  )
    return unknown();
  const bottom = rows[end]!;
  const left = bottom.findIndex((cell) => cell.text === "╰");
  const right = bottom.findIndex((cell) => cell.text === "╯");
  const border = bottom[left]?.foreground;
  if (border === undefined) return unknown();
  for (let start = end - 2; start >= Math.max(0, end - 14); start--) {
    const top = rows[start]!;
    if (!rule(top, /^╭─{8,}╮$/u, border)) continue;
    if (
      top.findIndex((cell) => cell.text === "╭") !== left ||
      top.findIndex((cell) => cell.text === "╮") !== right
    )
      return unknown();
    const input: Row[] = [];
    for (let i = start + 1; i < end; i++) {
      const row = rows[i]!;
      if (
        row[left]?.text !== "│" ||
        row[right]?.text !== "│" ||
        row[left]?.foreground !== border ||
        row[right]?.foreground !== border ||
        plain(row.slice(0, left)).trim() ||
        plain(row.slice(right + 1)).trim()
      )
        return unknown();
      if (i === start + 1 && plain(row.slice(left + 1, left + 4)) !== " ❯ ") return unknown();
      input.push(row.slice(left + (i === start + 1 ? 4 : 1), right));
    }
    return content(input);
  }
  return unknown();
}

function opencode(rows: readonly Row[]): PaneInputLine {
  // OpenCode 1.18.35: rail, padded textarea, blank rail, agent/model metadata, bottom.
  const end = rows.findLastIndex((row) => /^\s*╹▀{8,}\s*$/u.test(plain(row)));
  if (end < rows.length - 22 || end < 4) return unknown();
  const left = rows[end]!.findIndex((cell) => cell.text === "╹");
  const border = rows[end]![left]!.foreground;
  if (border === undefined) return unknown();
  const metadata = rows[end - 1]!;
  const dot = metadata.findIndex((cell) => cell.text === "·");
  if (dot <= left || metadata[left]?.text !== "┃" || metadata[left]?.foreground !== border) return unknown();
  const model = metadata.slice(dot + 1).find((cell) => cell.text.trim());
  if (!model?.foreground || model.foreground === metadata[dot]?.foreground) return unknown();
  const rail = (row: Row) =>
    row[left]?.text === "┃" && row[left]?.foreground === border && !plain(row.slice(0, left)).trim();
  if (!rail(rows[end - 2]!) || plain(rows[end - 2]!.slice(left + 1)).trim()) return unknown();
  let start = end - 3;
  while (start > 0 && rail(rows[start - 1]!)) start--;
  if (start < end - 16 || !rail(rows[start]!) || plain(rows[start]!.slice(left + 1)).trim()) return unknown();
  const input = rows.slice(start + 1, end - 2).map((row) => row.slice(left + 1));
  if (input.length === 0) return unknown();
  const result = content(input);
  if (result.state === "empty") return result;
  // Never erase a leader-key draft: OpenCode dims BOTH its textarea and model then.
  // Ghost recognition needs the native, distinct model/placeholder colours as well as words.
  const text = result.text;
  if (text === undefined) return unknown();
  const cells = input.flat().filter((cell) => cell.text.trim());
  const ghostColour = cells[0]?.foreground;
  if (
    /^Ask anything… "[^"\n]+"$/u.test(text) &&
    ghostColour !== undefined &&
    ghostColour !== model.foreground &&
    ghostColour === metadata[dot]?.foreground &&
    cells.every((cell) => cell.foreground === ghostColour)
  )
    return { state: "empty", text, typed: false };
  if (cells.every((cell) => cell.foreground === model.foreground && !cell.faint && !cell.italic))
    return result;
  return { state: "unknown", text };
}

export function additionalPaneInputLine(harness: string, rows: readonly Row[]): PaneInputLine {
  if (harness === "pi") return pi(rows);
  if (harness === "grok") return grok(rows);
  if (harness === "opencode") return opencode(rows);
  return unknown();
}
