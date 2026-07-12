import { describe, expect, it } from "vitest";
import { applyTerminalReplay, type ConsoleTerminalSnapshot } from "../src/recovery-probe.ts";

const prior: ConsoleTerminalSnapshot = {
  terminalId: "terminal-1",
  workerRunId: "worker-1",
  lastSequence: 2,
  bytes: Buffer.from("before\n").toString("base64"),
  receivedSequences: [0, 1, 2],
};

describe("TUI recovery probe", () => {
  it("resumes a terminal cursor and preserves the byte stream", () => {
    const recovered = applyTerminalReplay(
      {
        terminalId: "terminal-1",
        workerRunId: "worker-1",
        throughSequence: 4,
        frames: [
          {
            type: "output",
            terminalId: "terminal-1",
            sequence: 3,
            data: Buffer.from("during\n").toString("base64"),
          },
          {
            type: "output",
            terminalId: "terminal-1",
            sequence: 4,
            data: Buffer.from("after\n").toString("base64"),
          },
        ],
      },
      prior,
    );

    expect(recovered.resumedFromSequence).toBe(2);
    expect(recovered.receivedSequences).toEqual([3, 4]);
    expect(Buffer.from(recovered.bytes, "base64").toString("utf8")).toBe("before\nduring\nafter\n");
  });

  it("rejects a replay gap instead of silently corrupting the console", () => {
    expect(() =>
      applyTerminalReplay(
        {
          terminalId: "terminal-1",
          workerRunId: "worker-1",
          throughSequence: 4,
          frames: [
            {
              type: "output",
              terminalId: "terminal-1",
              sequence: 4,
              data: Buffer.from("gap\n").toString("base64"),
            },
          ],
        },
        prior,
      ),
    ).toThrow(/sequence gap/);
  });
});
