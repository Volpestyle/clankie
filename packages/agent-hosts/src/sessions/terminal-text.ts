import type { OperatorTerminalFrame } from "@clankie/protocol";

// Plain text for a Herdr pane, for the Herdr session source's `read` (ADR 0301).
// Herdr sends a full ANSI redraw and then diffs; this applies them to a grid
// the way a terminal would, closely enough to read: cursor moves, erases,
// inserts and scrolls. Colour and modes are dropped.

/** History rows first, then the visible screen, trailing blanks trimmed. */
export function renderTerminalText(frames: readonly OperatorTerminalFrame[]): string {
  const first = frames.find((frame) => frame.full);
  if (first === undefined) return "";
  const screen = new Screen(first.columns, first.rows);
  const history: string[] = [];
  for (const frame of frames.slice(frames.indexOf(first))) {
    if (frame.scrollback !== undefined) history.push(...plainLines(decode(frame.scrollback.data)));
    if (frame.full) screen.reset(frame.columns, frame.rows);
    // The service seeds a pane's existing history ahead of the first redraw, so
    // rows that scroll off the top there are history; later rows arrive as scrollback.
    if (frame === first) history.push(...screen.write(decode(frame.data), true));
    else screen.write(decode(frame.data));
  }
  const lines = [...history, ...screen.lines()];
  while (lines.length > 0 && lines.at(-1)!.length === 0) lines.pop();
  return lines.join("\n");
}

function decode(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}

/** History arrives as styled rows; drop the styling and keep the text. */
function plainLines(text: string): string[] {
  return (
    text
      // oxlint-disable-next-line no-control-regex -- strips terminal escape sequences
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
      // oxlint-disable-next-line no-control-regex -- strips terminal escape sequences
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
      // oxlint-disable-next-line no-control-regex -- strips terminal escape sequences
      .replace(/\u001b[@-_]/gu, "")
      .split(/\r?\n/u)
      .map((line) => line.replace(/\r/gu, "").trimEnd())
  );
}

class Screen {
  private grid: string[][] = [];
  private row = 0;
  private column = 0;
  private saved = { row: 0, column: 0 };
  private pendingWrap = false;
  private scrolledOff: string[] | undefined;
  private top = 0;
  private bottom = 0;

  private columns: number;
  private rows: number;

  public constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.reset(columns, rows);
  }

  public reset(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => this.blank());
    this.row = 0;
    this.column = 0;
    this.pendingWrap = false;
    this.top = 0;
    this.bottom = rows - 1;
  }

  public lines(): string[] {
    return this.grid.map((cells) => cells.join("").trimEnd());
  }

  /** Writes `input`; with `keepScrolled`, returns the rows it scrolled off the top. */
  public write(input: string, keepScrolled = false): string[] {
    const scrolledOff: string[] = [];
    this.scrolledOff = keepScrolled ? scrolledOff : undefined;
    const chars = [...input];
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index]!;
      if (char === "\u001b") {
        index = this.escape(chars, index);
        continue;
      }
      if (char === "\r") {
        this.column = 0;
        this.pendingWrap = false;
      } else if (char === "\n" || char === "\u000b" || char === "\u000c") this.lineFeed();
      else if (char === "\b") {
        this.column = Math.max(0, this.column - 1);
        this.pendingWrap = false;
      } else if (char === "\t")
        this.column = Math.min(this.columns - 1, (Math.floor(this.column / 8) + 1) * 8);
      else if (char.codePointAt(0)! >= 0x20 && char !== "\u007f") this.print(char);
    }
    this.scrolledOff = undefined;
    return scrolledOff;
  }

  private print(char: string): void {
    if (this.pendingWrap) {
      this.column = 0;
      this.lineFeed();
    }
    this.grid[this.row]![this.column] = char;
    if (this.column === this.columns - 1) this.pendingWrap = true;
    else this.column += 1;
  }

  private lineFeed(): void {
    this.pendingWrap = false;
    if (this.row === this.bottom) this.scrollUp(1);
    else this.row = Math.min(this.rows - 1, this.row + 1);
  }

  private scrollUp(count: number): void {
    for (let step = 0; step < count; step += 1) {
      const [removed] = this.grid.splice(this.top, 1);
      if (this.top === 0 && removed !== undefined) this.scrolledOff?.push(removed.join("").trimEnd());
      this.grid.splice(this.bottom, 0, this.blank());
    }
  }

  private scrollDown(count: number): void {
    for (let step = 0; step < count; step += 1) {
      this.grid.splice(this.bottom, 1);
      this.grid.splice(this.top, 0, this.blank());
    }
  }

  /** Returns the index of the last character the escape consumed. */
  private escape(chars: readonly string[], start: number): number {
    const next = chars[start + 1];
    if (next === undefined) return start;
    if (next === "[") return this.csi(chars, start + 2);
    if (next === "]" || next === "P" || next === "_" || next === "^") {
      // OSC, DCS, APC and PM run to BEL or ST; none of them draw text.
      for (let index = start + 2; index < chars.length; index += 1) {
        if (chars[index] === "\u0007") return index;
        if (chars[index] === "\u001b" && chars[index + 1] === "\\") return index + 1;
      }
      return chars.length - 1;
    }
    if (next === "(" || next === ")" || next === "*" || next === "+" || next === "#") return start + 2;
    if (next === "7") this.saved = { row: this.row, column: this.column };
    else if (next === "8") this.move(this.saved.row, this.saved.column);
    else if (next === "D") this.lineFeed();
    else if (next === "E") {
      this.column = 0;
      this.lineFeed();
    } else if (next === "M") {
      if (this.row === this.top) this.scrollDown(1);
      else this.row = Math.max(0, this.row - 1);
    } else if (next === "c") this.reset(this.columns, this.rows);
    return start + 1;
  }

  private csi(chars: readonly string[], start: number): number {
    let index = start;
    let body = "";
    while (index < chars.length && !/[@-~]/u.test(chars[index]!)) body += chars[index++];
    const final = chars[index];
    if (final === undefined) return chars.length - 1;
    if (/^[<=>?]/u.test(body)) return index; // private modes: no text effect
    const params = body
      .replace(/[ -/]+$/u, "")
      .split(";")
      .map((value) => (value === "" ? undefined : Number(value)));
    const n = (position: number, fallback = 1) => {
      const value = params[position];
      return value === undefined || Number.isNaN(value) || value === 0 ? fallback : value;
    };
    const line = this.grid[this.row]!;
    switch (final) {
      case "H":
      case "f":
        this.move(n(0) - 1, n(1) - 1);
        break;
      case "A":
        this.move(Math.max(this.top, this.row - n(0)), this.column);
        break;
      case "B":
        this.move(Math.min(this.bottom, this.row + n(0)), this.column);
        break;
      case "C":
        this.move(this.row, this.column + n(0));
        break;
      case "D":
        this.move(this.row, this.column - n(0));
        break;
      case "E":
        this.move(this.row + n(0), 0);
        break;
      case "F":
        this.move(this.row - n(0), 0);
        break;
      case "G":
      case "`":
        this.move(this.row, n(0) - 1);
        break;
      case "d":
        this.move(n(0) - 1, this.column);
        break;
      case "J": {
        const mode = params[0] ?? 0;
        if (mode === 0) {
          line.fill(" ", this.column);
          for (let row = this.row + 1; row < this.rows; row += 1) this.grid[row] = this.blank();
        } else if (mode === 1) {
          line.fill(" ", 0, this.column + 1);
          for (let row = 0; row < this.row; row += 1) this.grid[row] = this.blank();
        } else this.grid = Array.from({ length: this.rows }, () => this.blank());
        break;
      }
      case "K": {
        const mode = params[0] ?? 0;
        if (mode === 0) line.fill(" ", this.column);
        else if (mode === 1) line.fill(" ", 0, this.column + 1);
        else line.fill(" ");
        break;
      }
      case "X":
        line.fill(" ", this.column, Math.min(this.columns, this.column + n(0)));
        break;
      case "P":
        line.splice(this.column, n(0));
        while (line.length < this.columns) line.push(" ");
        break;
      case "@":
        line.splice(this.column, 0, ...Array.from({ length: n(0) }, () => " "));
        line.length = this.columns;
        break;
      case "L":
        if (this.row >= this.top && this.row <= this.bottom)
          for (let step = 0; step < n(0); step += 1) {
            this.grid.splice(this.bottom, 1);
            this.grid.splice(this.row, 0, this.blank());
          }
        break;
      case "M":
        if (this.row >= this.top && this.row <= this.bottom)
          for (let step = 0; step < n(0); step += 1) {
            this.grid.splice(this.row, 1);
            this.grid.splice(this.bottom, 0, this.blank());
          }
        break;
      case "S":
        this.scrollUp(n(0));
        break;
      case "T":
        this.scrollDown(n(0));
        break;
      case "r":
        this.top = Math.min(this.rows - 1, n(0) - 1);
        this.bottom = Math.max(this.top, Math.min(this.rows - 1, n(1, this.rows) - 1));
        this.move(0, 0);
        break;
      case "s":
        this.saved = { row: this.row, column: this.column };
        break;
      case "u":
        this.move(this.saved.row, this.saved.column);
        break;
      default:
        break; // SGR and the rest change how text looks, not what it says
    }
    return index;
  }

  private move(row: number, column: number): void {
    this.row = Math.max(0, Math.min(this.rows - 1, row));
    this.column = Math.max(0, Math.min(this.columns - 1, column));
    this.pendingWrap = false;
  }

  private blank(): string[] {
    return Array.from({ length: this.columns }, () => " ");
  }
}
