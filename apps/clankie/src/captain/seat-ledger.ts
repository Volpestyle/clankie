/**
 * What each seat has earned (ADR 0162).
 *
 * The commons renders rewards and keeps no score of its own, so the host has to
 * be the one that can say what a seat's last run came to and what it has done
 * today. Three facts feed it, and all three are ones the host already sees: a
 * pane that was working and has stopped, a prompt the host put into a pane, and
 * an agent striking a `celebrate` stance.
 *
 * Counts are a fold, and a fold held only in memory is the failure the app's
 * ADR 0022 is about — it silently under-reports after a restart while still
 * calling itself "today". So the rows are the record and the counters are
 * derived: every event appends a line, and the day's counts are rebuilt from
 * those lines when the captain starts. Nothing is ever recomputed from a feed
 * that can stop.
 *
 * This is not the captain's turn ledger. `turn-settled.jsonl` records the turns
 * Clankie himself ran, keyed by conversation and lane; a seat run happens in
 * another agent's pane and is observed through Herdr, so it has no conversation,
 * no run id, and no tool counts to put in that row.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OperatorSeatDayTally, OperatorSeatLastOutcome, OperatorSeatRunResult } from "@clankie/protocol";
import { z } from "zod";

const SEAT_LEDGER_LOG_NAME = "seat-ledger.jsonl";
const SEAT_LEDGER_TYPE = "captain.seat.ledger" as const;

/**
 * One line per thing that happened to a seat. A run is written as how it came
 * out rather than as a run with a nullable result, so there is no row that can
 * say a run settled without saying into what.
 */
const SeatLedgerRowSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal(SEAT_LEDGER_TYPE),
    seatId: z.string().trim().min(1).max(512),
    kind: z.enum(["passed", "failed", "ship", "prompt"]),
    at: z.string().datetime(),
  })
  .strict();
type SeatLedgerRow = z.infer<typeof SeatLedgerRowSchema>;

export function seatLedgerPath(stateDir: string): string {
  return join(stateDir, SEAT_LEDGER_LOG_NAME);
}

/**
 * A run is a pane that was working and has stopped. Herdr's own agent status
 * says how: `idle` and `done` are a pane ready for the next thing, `blocked` is
 * one that stopped on this one. Anything else settles nothing — a pane going
 * offline mid-run has no outcome, and inventing one would be the host guessing
 * about work it did not watch.
 */
export function runResultForSeatStatus(
  previous: string | undefined,
  next: string,
): OperatorSeatRunResult | undefined {
  if (previous !== "working") return undefined;
  if (next === "idle" || next === "done") return "passed";
  return next === "blocked" ? "failed" : undefined;
}

export interface SeatLedger {
  /** A watched pane stopped working, and its status said how it came out. */
  runSettled(seatId: string, result: OperatorSeatRunResult): void;
  /** The agent said it just landed something. */
  shipped(seatId: string): void;
  /** One prompt reached this seat's pane, from whichever surface sent it. */
  promptSent(seatId: string): void;
  /** The seat's last settled run whenever it happened, or nothing when it has none. */
  lastOutcome(seatId: string): OperatorSeatLastOutcome | undefined;
  /** Today's counts for whichever of these seats have earned any. */
  tallies(seatIds: readonly string[]): readonly OperatorSeatDayTally[];
}

interface DayCount {
  day: string;
  runs: number;
  greenRuns: number;
  ships: number;
  promptsSent: number;
}

/** The host's local calendar day, which is the day its operator is having. */
function dayOf(at: number): string {
  return new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/**
 * ponytail: the whole log is read once at startup and folded, like TurnSettledLog
 * reads whole. Rotate it by day if a machine ever runs enough seats that the
 * read shows up in captain start.
 */
export function createSeatLedger(path: string, now: () => number = Date.now): SeatLedger {
  const counts = new Map<string, DayCount>();
  const outcomes = new Map<string, OperatorSeatLastOutcome>();

  const bucket = (seatId: string, day: string): DayCount => {
    const held = counts.get(seatId);
    if (held !== undefined && held.day === day) return held;
    // A new day for one seat is a new day for all of them, so yesterday goes
    // rather than accumulating a seat per day the machine has been up.
    for (const [key, entry] of counts) {
      if (entry.day !== day) counts.delete(key);
    }
    const fresh: DayCount = { day, runs: 0, greenRuns: 0, ships: 0, promptsSent: 0 };
    counts.set(seatId, fresh);
    return fresh;
  };

  const apply = (row: SeatLedgerRow): void => {
    const at = Date.parse(row.at);
    if (row.kind === "passed" || row.kind === "failed") {
      const held = outcomes.get(row.seatId);
      // Newest wins by time rather than by arrival, so a re-read of the log in
      // any order lands on the same last outcome.
      if (held === undefined || Date.parse(held.at) <= at) {
        outcomes.set(row.seatId, { result: row.kind, at: row.at });
      }
    }
    // An older row still carries a last outcome; it never carries today's counts.
    if (dayOf(at) !== dayOf(now())) return;
    const count = bucket(row.seatId, dayOf(at));
    if (row.kind === "passed") {
      count.runs += 1;
      count.greenRuns += 1;
      return;
    }
    if (row.kind === "failed") {
      count.runs += 1;
      return;
    }
    if (row.kind === "ship") {
      count.ships += 1;
      return;
    }
    count.promptsSent += 1;
  };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    raw = "";
  }
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = SeatLedgerRowSchema.safeParse(parsed);
    if (row.success) apply(row.data);
  }

  const record = (seatId: string, kind: SeatLedgerRow["kind"]): void => {
    const row = SeatLedgerRowSchema.parse({
      schemaVersion: 1,
      type: SEAT_LEDGER_TYPE,
      seatId,
      kind,
      at: new Date(now()).toISOString(),
    });
    apply(row);
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
    } catch {
      // A ledger write must not fail the run it measured. The counters still
      // stand for this process; only a restart loses what could not be written.
    }
  };

  return {
    runSettled(seatId, result) {
      record(seatId, result);
    },
    shipped(seatId) {
      record(seatId, "ship");
    },
    promptSent(seatId) {
      record(seatId, "prompt");
    },
    lastOutcome(seatId) {
      return outcomes.get(seatId);
    },
    tallies(seatIds) {
      const today = dayOf(now());
      return seatIds.flatMap((seatId) => {
        const held = counts.get(seatId);
        if (held === undefined || held.day !== today) return [];
        return [
          {
            seatId,
            day: held.day,
            runs: held.runs,
            greenRuns: held.greenRuns,
            ships: held.ships,
            promptsSent: held.promptsSent,
          },
        ];
      });
    },
  };
}
