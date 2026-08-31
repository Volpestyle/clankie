import { describe, expect, it } from "vitest";
import {
  HerdrTerminalStore,
  type HerdrTerminalObserver,
  type StartHerdrTerminalObserver,
} from "../src/captain/herdr-terminal.ts";
import { readTerminalGrid } from "../src/captain/herdr-census.ts";

const request = {
  schemaVersion: 1 as const,
  terminalId: "term-worker",
  surfaceClientId: "native-ios",
  columns: 120,
  rows: 40,
  limit: 1,
};

describe("herdr terminal observation", () => {
  it("tails one native surface from Herdr's full ANSI baseline through sequenced diffs", async () => {
    const starts: unknown[] = [];
    const startObserver: StartHerdrTerminalObserver = (terminalId, columns, rows) => {
      starts.push({ terminalId, columns, rows });
      return observer([frame(1, true, "G1sySg=="), frame(2, false, "aGVsbG8=")]);
    };
    const store = new HerdrTerminalStore({
      readGrid: async () => undefined,
      startObserver,
      waitMs: 10,
    });

    const first = await store.tail(request);
    expect(first).toMatchObject({
      status: "page",
      frames: [
        {
          terminalId: "term-worker",
          sequence: 1,
          full: true,
          data: "G1sySg==",
        },
      ],
    });
    if (first.status !== "page") throw new Error("terminal page expected");
    const second = await store.tail({ ...request, cursor: first.cursor });
    expect(second).toMatchObject({
      status: "page",
      cursor: { streamId: first.cursor.streamId, sequence: 2 },
      frames: [{ sequence: 2, full: false, data: "aGVsbG8=" }],
    });
    await expect(
      store.tail({
        ...request,
        cursor: { streamId: first.cursor.streamId, sequence: 99 },
      }),
    ).resolves.toMatchObject({ status: "reset", reason: "stream_lost" });
    expect(starts).toEqual([{ terminalId: "term-worker", columns: 120, rows: 40 }]);
    store.close();
  });

  it("observes at the pane's own grid so wide output is fitted, never cropped", async () => {
    const starts: unknown[] = [];
    const store = new HerdrTerminalStore({
      readGrid: async () => ({ columns: 126, rows: 50 }),
      startObserver: (terminalId, columns, rows) => {
        starts.push({ terminalId, columns, rows });
        return observer([frame(1, true, "G1sySg==")]);
      },
      waitMs: 10,
    });

    // The surface asked for its own 49-column viewport; the pane runs at 126.
    await store.tail({ ...request, columns: 49, rows: 30 });
    expect(starts).toEqual([{ terminalId: "term-worker", columns: 126, rows: 50 }]);
    store.close();
  });

  it("observes at the holder's resized grid after an explicit device reflow", async () => {
    const starts: unknown[] = [];
    const store = new HerdrTerminalStore({
      readGrid: async () => ({ columns: 126, rows: 50 }),
      readControlledGrid: (_terminalId, surfaceClientId) =>
        surfaceClientId === "native-ios" ? { columns: 48, rows: 24 } : undefined,
      startObserver: (terminalId, columns, rows) => {
        starts.push({ terminalId, columns, rows });
        return observer([frame(1, true, "G1sySg==")]);
      },
      waitMs: 10,
    });

    await store.tail({ ...request, columns: 48, rows: 24 });
    expect(starts).toEqual([{ terminalId: "term-worker", columns: 48, rows: 24 }]);
    store.close();
  });

  it("seeds SwiftTerm's native scrollback from vanilla Herdr ANSI history", async () => {
    const reads: string[] = [];
    const store = new HerdrTerminalStore({
      readGrid: async () => ({ paneId: "w1:p4", columns: 126, rows: 50 }),
      readHistory: async (paneId) => {
        reads.push(paneId);
        return "\u001b[31mold\u001b[0m\r\ncurrent\r\n";
      },
      startObserver: () => observer([frame(1, true, "G1sySg==")]),
      waitMs: 10,
    });

    const first = await store.tail(request);
    if (first.status !== "page") throw new Error("terminal page expected");
    expect(Buffer.from(first.frames[0]!.data, "base64").toString()).toBe(
      "\u001b[31mold\u001b[0m\r\ncurrent\r\n\u001b[2J",
    );
    expect(reads).toEqual(["w1:p4"]);
    store.close();
  });

  it("streams later styled rows into native scrollback without repainting the viewport", async () => {
    const initialHistory = Array.from({ length: 45 }, (_, index) => `row ${index + 1}`).join("\r\n");
    const laterHistory = [
      ...Array.from({ length: 7 }, (_, index) => `row ${index + 1}`),
      ...Array.from({ length: 40 }, (_, index) => `viewport ${index + 1}`),
    ].join("\r\n");
    let reads = 0;
    const store = new HerdrTerminalStore({
      readGrid: async () => ({ paneId: "w1:p4", columns: 120, rows: 40 }),
      readHistory: async () => {
        reads += 1;
        return reads === 1 ? initialHistory : laterHistory;
      },
      startObserver: () => observer([frame(1, true, "G1sySg=="), frame(2, false, "aGVsbG8=")]),
      scrollbackQuietMs: 1,
      scrollbackMaxLatencyMs: 5,
      waitMs: 100,
    });

    const first = await store.tail(request);
    if (first.status !== "page") throw new Error("terminal page expected");
    let cursor = first.cursor;
    let found = first.frames.find((candidate) => candidate.scrollback !== undefined);
    for (let attempt = 0; attempt < 3 && found === undefined; attempt += 1) {
      const page = await store.tail({ ...request, cursor });
      if (page.status !== "page") throw new Error("terminal scrollback page expected");
      cursor = page.cursor;
      found = page.frames.find((candidate) => candidate.scrollback !== undefined);
    }
    expect(found).toEqual(
      expect.objectContaining({
        data: "",
        full: false,
        scrollback: {
          encoding: "base64",
          data: Buffer.from("row 6\r\nrow 7\r\n").toString("base64"),
          rows: 2,
        },
      }),
    );
    expect(reads).toBeGreaterThanOrEqual(2);
    store.close();
  });

  it("requires a fresh full baseline when a surface's observer stream is gone", async () => {
    const store = new HerdrTerminalStore({
      readGrid: async () => undefined,
      startObserver: () => observer([]),
      waitMs: 1,
    });
    await expect(
      store.tail({
        ...request,
        cursor: { streamId: "lost-stream", sequence: 9 },
      }),
    ).resolves.toMatchObject({ status: "reset", reason: "stream_lost" });
    store.close();
  });

  it("fails soft when Herdr is unavailable or emits an unsafe frame", async () => {
    const unavailable = new HerdrTerminalStore({
      readGrid: async () => undefined,
      startObserver: () => {
        throw new Error("spawn herdr ENOENT");
      },
    });
    await expect(unavailable.tail(request)).resolves.toMatchObject({
      status: "unavailable",
      reason: "herdr_unavailable",
    });

    const invalid = new HerdrTerminalStore({
      readGrid: async () => undefined,
      startObserver: () => observer([frame(1, false, "aGVsbG8=")]),
      waitMs: 10,
    });
    await expect(invalid.tail(request)).resolves.toMatchObject({
      status: "unavailable",
      reason: "invalid_frame",
    });
    invalid.close();
  });
});

function frame(sequence: number, full: boolean, bytes: string): string {
  return JSON.stringify({
    type: "terminal.frame",
    seq: sequence,
    encoding: "ansi",
    width: 120,
    height: 40,
    full,
    bytes,
  });
}

function observer(initialLines: readonly string[]): HerdrTerminalObserver {
  const controller = new AbortController();
  const done = new Promise<"observer_closed">((resolve) => {
    controller.signal.addEventListener("abort", () => resolve("observer_closed"), { once: true });
  });
  return {
    lines: (async function* () {
      for (const line of initialLines) yield line;
      if (!controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
    })(),
    done,
    close: () => controller.abort(),
  };
}

describe("herdr pane grids", () => {
  it("reads the real grid from vanilla Herdr's pane layout", async () => {
    const calls: string[][] = [];
    const grid = await readTerminalGrid("term-wide", {
      runCommand: async (_command, args) => {
        calls.push([...args]);
        return args[1] === "list"
          ? {
              stdout: JSON.stringify({
                result: {
                  panes: [
                    { pane_id: "w1:p4", terminal_id: "term-wide" },
                    { pane_id: "w1:p5", terminal_id: "term-other" },
                  ],
                },
              }),
              stderr: "",
            }
          : {
              stdout: JSON.stringify({
                result: {
                  layout: {
                    panes: [{ pane_id: "w1:p4", rect: { width: 126, height: 50, x: 0, y: 0 } }],
                  },
                },
              }),
              stderr: "",
            };
      },
    });
    expect(grid).toEqual({ paneId: "w1:p4", columns: 126, rows: 50 });
    expect(calls).toEqual([
      ["pane", "list"],
      ["pane", "layout", "--pane", "w1:p4"],
    ]);
  });
});
