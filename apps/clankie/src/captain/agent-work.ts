import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readCodexGoal } from "@clankie/agent-transcript";
import {
  OperatorWorkAssignmentSchema,
  type OperatorFleetSeat,
  type StateOperatorAgentWork,
} from "@clankie/protocol";
import type { ObservedFleetSeat } from "./herdr-census.ts";

const RecordSchema = z.record(z.string(), OperatorWorkAssignmentSchema);

/** Session-scoped pointers to existing work. No task status or acceptance state. */
export function createAgentWorkStore(directory: string, now = Date.now) {
  const path = join(directory, "agent-work.json");
  let records: z.infer<typeof RecordSchema> = {};
  if (existsSync(path)) {
    try {
      records = RecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      /* Display metadata cannot prevent the service from starting. */
    }
  }
  return {
    read: (occupantId: string) => (Object.hasOwn(records, occupantId) ? records[occupantId] : undefined),
    state(occupantId: string, assignment: StateOperatorAgentWork["assignment"]) {
      const next = { ...records };
      if (assignment === null) delete next[occupantId];
      else
        next[occupantId] = OperatorWorkAssignmentSchema.parse({
          ...assignment,
          updatedAt: new Date(now()).toISOString(),
        });
      // Keep recent assignments bounded even as native sessions turn over.
      const entries = Object.entries(next).sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt));
      for (const [key] of entries.slice(0, Math.max(0, entries.length - 1_000))) delete next[key];
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(next), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      for (const key of Object.keys(records)) delete records[key];
      Object.assign(records, next);
      return records[occupantId];
    },
  };
}

/** Attach native metadata only to known local session addresses. */
export function withSeatWork(
  seats: readonly OperatorFleetSeat[],
  observed: readonly ObservedFleetSeat[],
  store: ReturnType<typeof createAgentWorkStore>,
  readGoal = readCodexGoal,
): readonly OperatorFleetSeat[] {
  const sessions = new Map(observed.map((seat) => [seat.seatId, seat.session]));
  return seats.map((seat) => {
    const assignment = store.read(seat.occupantId);
    const session = sessions.get(seat.seatId);
    let goal: OperatorFleetSeat["goal"];
    if (seat.harness === "codex" && seat.fleet === undefined && session !== undefined) {
      try {
        goal = readGoal(session, seat.account === undefined ? undefined : [seat.account.home]);
      } catch {
        /* An unreadable native store is unknown work, never a failed roster. */
      }
    }
    return {
      ...seat,
      ...(assignment === undefined ? {} : { assignment }),
      ...(goal === undefined ? {} : { goal }),
    };
  });
}
