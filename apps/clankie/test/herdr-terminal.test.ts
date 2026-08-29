import { describe, expect, it } from "vitest";
import {
  HerdrTerminalStore,
  type HerdrTerminalObserver,
  type StartHerdrTerminalObserver,
} from "../src/captain/herdr-terminal.ts";

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
    const store = new HerdrTerminalStore({ startObserver, waitMs: 10 });

    const first = await store.tail(request);
    expect(first).toMatchObject({
      status: "page",
      frames: [{ terminalId: "term-worker", sequence: 1, full: true, data: "G1sySg==" }],
    });
    if (first.status !== "page") throw new Error("terminal page expected");
    const second = await store.tail({ ...request, cursor: first.cursor });
    expect(second).toMatchObject({
      status: "page",
      cursor: { streamId: first.cursor.streamId, sequence: 2 },
      frames: [{ sequence: 2, full: false, data: "aGVsbG8=" }],
    });
    await expect(
      store.tail({ ...request, cursor: { streamId: first.cursor.streamId, sequence: 99 } }),
    ).resolves.toMatchObject({ status: "reset", reason: "stream_lost" });
    expect(starts).toEqual([{ terminalId: "term-worker", columns: 120, rows: 40 }]);
    store.close();
  });

  it("requires a fresh full baseline when a surface's observer stream is gone", async () => {
    const store = new HerdrTerminalStore({ startObserver: () => observer([]), waitMs: 1 });
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
      startObserver: () => {
        throw new Error("spawn herdr ENOENT");
      },
    });
    await expect(unavailable.tail(request)).resolves.toMatchObject({
      status: "unavailable",
      reason: "herdr_unavailable",
    });

    const invalid = new HerdrTerminalStore({
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
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    })(),
    done,
    close: () => controller.abort(),
  };
}
