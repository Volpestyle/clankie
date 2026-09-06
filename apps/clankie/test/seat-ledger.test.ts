import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeatLedger, runResultForSeatStatus, seatLedgerPath } from "../src/captain/seat-ledger.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function ledgerPath(): string {
  return seatLedgerPath(mkdtempSync(join(tmpdir(), "seat-ledger-")));
}

describe("runResultForSeatStatus", () => {
  it("settles a run only when a working pane stopped, and only into what it stopped at", () => {
    expect(runResultForSeatStatus("working", "idle")).toBe("passed");
    expect(runResultForSeatStatus("working", "done")).toBe("passed");
    expect(runResultForSeatStatus("working", "blocked")).toBe("failed");
    // A pane that vanished mid-run has no outcome the host watched.
    expect(runResultForSeatStatus("working", "offline")).toBeUndefined();
    expect(runResultForSeatStatus("idle", "working")).toBeUndefined();
    expect(runResultForSeatStatus(undefined, "idle")).toBeUndefined();
  });
});

describe("createSeatLedger", () => {
  it("counts what a seat earned today and remembers how its last run came out", () => {
    const now = 1_700_000_000_000;
    const ledger = createSeatLedger(ledgerPath(), () => now);

    ledger.promptSent("seat-a");
    ledger.runSettled("seat-a", "passed");
    ledger.promptSent("seat-a");
    ledger.runSettled("seat-a", "failed");
    ledger.shipped("seat-a");

    expect(ledger.lastOutcome("seat-a")).toEqual({ result: "failed", at: new Date(now).toISOString() });
    expect(ledger.tallies(["seat-a"])).toEqual([
      {
        seatId: "seat-a",
        day: ledger.tallies(["seat-a"])[0]?.day,
        runs: 2,
        greenRuns: 1,
        ships: 1,
        promptsSent: 2,
      },
    ]);
  });

  it("answers only for the seats asked about, and says nothing for a seat with nothing", () => {
    const ledger = createSeatLedger(ledgerPath());
    ledger.shipped("seat-a");

    expect(ledger.tallies(["seat-b"])).toEqual([]);
    expect(ledger.tallies(["seat-a", "seat-b"]).map((tally) => tally.seatId)).toEqual(["seat-a"]);
    expect(ledger.lastOutcome("seat-b")).toBeUndefined();
  });

  it("rebuilds today's counts after a restart rather than starting the day again", () => {
    const path = ledgerPath();
    const now = 1_700_000_000_000;
    const first = createSeatLedger(path, () => now);
    first.runSettled("seat-a", "passed");
    first.promptSent("seat-a");

    const restarted = createSeatLedger(path, () => now + 60_000);
    expect(restarted.tallies(["seat-a"])[0]).toMatchObject({ runs: 1, greenRuns: 1, promptsSent: 1 });
    expect(restarted.lastOutcome("seat-a")).toMatchObject({ result: "passed" });
  });

  it("keeps yesterday's outcome without letting it count as today", () => {
    const path = ledgerPath();
    const yesterday = 1_700_000_000_000;
    createSeatLedger(path, () => yesterday).runSettled("seat-a", "passed");

    const today = createSeatLedger(path, () => yesterday + DAY_MS);
    expect(today.lastOutcome("seat-a")).toMatchObject({ result: "passed" });
    expect(today.tallies(["seat-a"])).toEqual([]);

    // And the new day starts from zero rather than from what yesterday held.
    today.runSettled("seat-a", "failed");
    expect(today.tallies(["seat-a"])[0]).toMatchObject({ runs: 1, greenRuns: 0 });
  });

  it("writes one durable line per event", () => {
    const path = ledgerPath();
    const ledger = createSeatLedger(path);
    ledger.shipped("seat-a");
    ledger.promptSent("seat-a");

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: "captain.seat.ledger",
      seatId: "seat-a",
      kind: "ship",
    });
  });
});
