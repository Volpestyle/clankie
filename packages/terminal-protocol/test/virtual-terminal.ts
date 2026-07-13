import { z } from "zod";
import {
  TerminalBytesSchema,
  TerminalGeometrySchema,
  TerminalSequenceBoundarySchema,
  type TerminalGeometry,
} from "../src/index.ts";

const ColorSchema = z.enum(["default", "red", "green", "blue"]);

const ReplayEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("output"),
      sequence: z.number().int().positive(),
      data: TerminalBytesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("geometry"),
      sequence: z.number().int().positive(),
      geometry: TerminalGeometrySchema,
    })
    .strict(),
]);

export const ReplayFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    initialGeometry: TerminalGeometrySchema,
    events: z.array(ReplayEventSchema).min(1),
    snapshot: z
      .object({
        boundary: TerminalSequenceBoundarySchema,
        geometry: TerminalGeometrySchema,
        restore: TerminalBytesSchema,
      })
      .strict(),
    expected: z
      .object({
        activeBuffer: z.enum(["primary", "alternate"]),
        geometry: TerminalGeometrySchema,
        cursor: z
          .object({
            row: z.number().int().positive(),
            column: z.number().int().positive(),
            color: ColorSchema,
          })
          .strict(),
        lines: z.array(z.string()),
        coloredCells: z.array(
          z
            .object({
              row: z.number().int().positive(),
              column: z.number().int().positive(),
              text: z.string().min(1),
              color: ColorSchema,
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict()
  .superRefine((fixture, context) => {
    fixture.events.forEach((event, index) => {
      if (event.sequence !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "sequence"],
          message: "fixture events must have contiguous sequences beginning at 1",
        });
      }
    });
    if (fixture.snapshot.boundary.afterSequence > fixture.events.length) {
      context.addIssue({
        code: "custom",
        path: ["snapshot", "boundary"],
        message: "snapshot boundary must reference an event in the fixture",
      });
    }
  });

export type ReplayFixture = z.infer<typeof ReplayFixtureSchema>;
type Color = z.infer<typeof ColorSchema>;
type BufferName = "primary" | "alternate";
type Cell = { char: string; color: Color };

function blankCell(): Cell {
  return { char: " ", color: "default" };
}

function blankGrid(geometry: TerminalGeometry): Cell[][] {
  return Array.from({ length: geometry.rows }, () => Array.from({ length: geometry.columns }, blankCell));
}

function splitCompleteUtf8(bytes: Uint8Array): { complete: Uint8Array; carry: Uint8Array } {
  let index = bytes.length - 1;
  while (index >= 0 && (bytes[index]! & 0xc0) === 0x80) index -= 1;
  if (index < 0) return { complete: new Uint8Array(), carry: bytes };
  const lead = bytes[index]!;
  const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 1;
  const available = bytes.length - index;
  if (expected > available) {
    return { complete: bytes.slice(0, index), carry: bytes.slice(index) };
  }
  return { complete: bytes, carry: new Uint8Array() };
}

export class FixtureTerminal {
  private geometry: TerminalGeometry;
  private primary: Cell[][];
  private alternate: Cell[][];
  private activeBuffer: BufferName = "primary";
  private cursorRow = 0;
  private cursorColumn = 0;
  private color: Color = "default";
  private utf8Carry = new Uint8Array();
  private parserCarry = "";

  public constructor(geometry: TerminalGeometry) {
    this.geometry = { ...geometry };
    this.primary = blankGrid(geometry);
    this.alternate = blankGrid(geometry);
  }

  public get isQuiescent(): boolean {
    return this.utf8Carry.length === 0 && this.parserCarry.length === 0;
  }

  public writeBase64(data: string): void {
    const incoming = Buffer.from(data, "base64");
    const joined = new Uint8Array(this.utf8Carry.length + incoming.length);
    joined.set(this.utf8Carry);
    joined.set(incoming, this.utf8Carry.length);
    const split = splitCompleteUtf8(joined);
    this.utf8Carry = new Uint8Array(split.carry);
    this.parse(this.parserCarry + new TextDecoder().decode(split.complete));
  }

  public resize(geometry: TerminalGeometry): void {
    this.primary = this.resizeGrid(this.primary, geometry);
    this.alternate = this.resizeGrid(this.alternate, geometry);
    this.geometry = { ...geometry };
    this.cursorRow = Math.min(this.cursorRow, geometry.rows - 1);
    this.cursorColumn = Math.min(this.cursorColumn, geometry.columns - 1);
  }

  public view(): ReplayFixture["expected"] {
    const grid = this.grid();
    return {
      activeBuffer: this.activeBuffer,
      geometry: { ...this.geometry },
      cursor: {
        row: this.cursorRow + 1,
        column: this.cursorColumn + 1,
        color: this.color,
      },
      lines: grid.map((row) =>
        row
          .map((cell) => cell.char)
          .join("")
          .trimEnd(),
      ),
      coloredCells: this.coloredRuns(grid),
    };
  }

  private grid(): Cell[][] {
    return this.activeBuffer === "primary" ? this.primary : this.alternate;
  }

  private resizeGrid(grid: Cell[][], geometry: TerminalGeometry): Cell[][] {
    const resized = blankGrid(geometry);
    for (let row = 0; row < Math.min(grid.length, geometry.rows); row += 1) {
      for (let column = 0; column < Math.min(grid[row]!.length, geometry.columns); column += 1) {
        resized[row]![column] = { ...grid[row]![column]! };
      }
    }
    return resized;
  }

  private parse(input: string): void {
    this.parserCarry = "";
    for (let index = 0; index < input.length;) {
      const character = input[index]!;
      if (character === "\u001b") {
        if (input[index + 1] !== "[") {
          if (index + 1 >= input.length) this.parserCarry = input.slice(index);
          index += 2;
          continue;
        }
        let finalIndex = index + 2;
        while (finalIndex < input.length && !/[@-~]/.test(input[finalIndex]!)) finalIndex += 1;
        if (finalIndex >= input.length) {
          this.parserCarry = input.slice(index);
          return;
        }
        this.applyCsi(input.slice(index + 2, finalIndex), input[finalIndex]!);
        index = finalIndex + 1;
        continue;
      }
      if (character === "\r") {
        this.cursorColumn = 0;
        index += 1;
        continue;
      }
      if (character === "\n") {
        this.cursorRow = Math.min(this.cursorRow + 1, this.geometry.rows - 1);
        index += 1;
        continue;
      }
      const codePoint = input.codePointAt(index)!;
      const rendered = String.fromCodePoint(codePoint);
      this.grid()[this.cursorRow]![this.cursorColumn] = { char: rendered, color: this.color };
      this.cursorColumn = Math.min(this.cursorColumn + 1, this.geometry.columns - 1);
      index += rendered.length;
    }
  }

  private applyCsi(parameters: string, final: string): void {
    if ((final === "h" || final === "l") && parameters === "?1049") {
      this.activeBuffer = final === "h" ? "alternate" : "primary";
      if (final === "h") {
        this.alternate = blankGrid(this.geometry);
        this.cursorRow = 0;
        this.cursorColumn = 0;
      }
      return;
    }
    const numbers = parameters.length === 0 ? [] : parameters.split(";").map(Number);
    if (final === "H" || final === "f") {
      this.cursorRow = Math.max(0, Math.min((numbers[0] ?? 1) - 1, this.geometry.rows - 1));
      this.cursorColumn = Math.max(0, Math.min((numbers[1] ?? 1) - 1, this.geometry.columns - 1));
      return;
    }
    if (final === "J" && (numbers[0] ?? 0) === 2) {
      if (this.activeBuffer === "primary") this.primary = blankGrid(this.geometry);
      else this.alternate = blankGrid(this.geometry);
      return;
    }
    if (final === "m") {
      for (const code of numbers.length === 0 ? [0] : numbers) {
        if (code === 0 || code === 39) this.color = "default";
        else if (code === 31) this.color = "red";
        else if (code === 32) this.color = "green";
        else if (code === 34) this.color = "blue";
      }
    }
  }

  private coloredRuns(grid: Cell[][]): ReplayFixture["expected"]["coloredCells"] {
    const runs: ReplayFixture["expected"]["coloredCells"] = [];
    for (let row = 0; row < grid.length; row += 1) {
      let column = 0;
      while (column < grid[row]!.length) {
        const cell = grid[row]![column]!;
        if (cell.color === "default" || cell.char === " ") {
          column += 1;
          continue;
        }
        const start = column;
        let text = "";
        while (
          column < grid[row]!.length &&
          grid[row]![column]!.color === cell.color &&
          grid[row]![column]!.char !== " "
        ) {
          text += grid[row]![column]!.char;
          column += 1;
        }
        runs.push({ row: row + 1, column: start + 1, text, color: cell.color });
      }
    }
    return runs;
  }
}

export function applyReplayEvent(terminal: FixtureTerminal, event: ReplayFixture["events"][number]): void {
  if (event.type === "output") terminal.writeBase64(event.data);
  else terminal.resize(event.geometry);
}
