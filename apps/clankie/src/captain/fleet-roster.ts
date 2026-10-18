import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { OperatorFleetSnapshot } from "@clankie/protocol";
import {
  FleetRosterSnapshotSchema,
  type FleetRosterAgent,
  type FleetRosterCounts,
  type FleetRosterSnapshot,
} from "@clankie/protocol/fleet-roster";

const State = z.record(z.string(), z.object({ inactiveSince: z.string().datetime() }).strict());
const emptyCounts = (): FleetRosterCounts => ({
  total: 0,
  working: 0,
  waiting: 0,
  idle: 0,
  finished: 0,
  unknown: 0,
  stale: 0,
});
function counts(agents: readonly FleetRosterAgent[]): FleetRosterCounts {
  const result = emptyCounts();
  for (const agent of agents) {
    result.total++;
    result[agent.status]++;
    if (agent.stale) result.stale++;
  }
  return result;
}

/** Host observations only. Restart and native occupant changes cannot inherit another agent's idle age. */
export class FleetRoster {
  private state: z.infer<typeof State> = {};
  private closed = false;
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    try {
      this.state = State.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      /* Unknown age starts at first observation. */
    }
  }
  close(): void {
    this.closed = true;
  }
  project(
    snapshot: OperatorFleetSnapshot,
    waitingOnOwner: ReadonlySet<string>,
    now = Date.now(),
  ): FleetRosterSnapshot {
    const before = JSON.stringify(this.state);
    const seen = new Set<string>();
    const names = new Map(snapshot.personas.map((persona) => [persona.personaId, persona.name]));
    const seatNames = new Map(
      snapshot.seats.map((seat) => [seat.seatId, names.get(seat.personaId) ?? seat.title]),
    );
    const agents = snapshot.seats.map((seat): FleetRosterAgent => {
      const key = JSON.stringify([seat.fleet ?? "local", seat.seatId, seat.occupantId]);
      seen.add(key);
      const status =
        waitingOnOwner.has(seat.seatId) || seat.status === "waiting"
          ? "waiting"
          : seat.status === "working"
            ? "working"
            : seat.status === "idle"
              ? "idle"
              : seat.status === "done"
                ? "finished"
                : "unknown";
      const pending =
        status === "waiting" ||
        waitingOnOwner.has(seat.seatId) ||
        (seat.waitingMessages?.stored ?? 0) > 0 ||
        (seat.waitingMessages?.unconfirmed ?? 0) > 0 ||
        (seat.subagents?.running ?? 0) > 0 ||
        (seat.workerReports ?? []).some((report) => report.state !== "read") ||
        (seat.workerReportBridge !== undefined && seat.workerReportBridge.outcome !== "stored");
      const inactive = status === "idle" || status === "finished";
      if (!this.closed && !snapshot.readWarnings?.length) {
        if (inactive) {
          const known = seat.efficiency?.inactiveSince;
          const since = known && Date.parse(known) <= now ? known : new Date(now).toISOString();
          this.state[key] ??= { inactiveSince: since };
          if (
            known &&
            Date.parse(known) > Date.parse(this.state[key]!.inactiveSince) &&
            Date.parse(known) <= now
          )
            this.state[key] = { inactiveSince: known };
        } else delete this.state[key];
      }
      const inactiveSince = this.state[key]?.inactiveSince;
      const stale =
        inactive && !pending && inactiveSince !== undefined && now - Date.parse(inactiveSince) > 60 * 60_000;
      const leadId = seat.owner?.conversationId ?? seat.parentSeatId;
      const leadSeat = snapshot.seats.find((other) => other.conversationId === leadId);
      return {
        seatId: seat.seatId,
        occupantId: seat.occupantId,
        personaId: seat.personaId,
        name: names.get(seat.personaId) ?? seat.title,
        status,
        nativeStatus: seat.status,
        machineId: seat.fleet ?? "local",
        machine: seat.machine ?? seat.fleet ?? "This machine",
        ...(leadId
          ? {
              leadId,
              lead:
                (leadSeat && names.get(leadSeat.personaId)) ??
                (seat.parentSeatId && seatNames.get(seat.parentSeatId)) ??
                "Lead",
            }
          : {}),
        ...((seat.assignment?.issue?.itemId ?? seat.efficiency?.currentIssue)
          ? { issue: seat.assignment?.issue?.itemId ?? seat.efficiency?.currentIssue }
          : {}),
        ...(seat.summary ? { summary: seat.summary } : {}),
        ...(seat.efficiency?.lastProgressAt ? { lastProgressAt: seat.efficiency.lastProgressAt } : {}),
        ...(inactiveSince ? { inactiveSince } : {}),
        pending,
        stale,
        retireEligible:
          !snapshot.readWarnings?.length &&
          seat.owner?.hired === true &&
          !pending &&
          (status === "finished" || stale),
      };
    });
    // Missing sources do not erase the age of their retained observations.
    if (!this.closed && !snapshot.readWarnings?.length)
      for (const key of Object.keys(this.state)) if (!seen.has(key)) delete this.state[key];
    if (!this.closed && JSON.stringify(this.state) !== before) {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(temp, this.path);
    }
    const groups = (field: "machineId" | "leadId", label: "machine" | "lead") => {
      const entries = new Map<string, FleetRosterAgent[]>();
      for (const agent of agents) {
        const id = agent[field] ?? "unowned";
        const rows = entries.get(id) ?? [];
        rows.push(agent);
        entries.set(id, rows);
      }
      return [...entries].map(([id, rows]) => ({
        id,
        name: rows[0]?.[label] ?? "No lead",
        counts: counts(rows),
      }));
    };
    return FleetRosterSnapshotSchema.parse({
      schemaVersion: 1,
      observedAt: new Date(now).toISOString(),
      complete: !snapshot.readWarnings?.length,
      ...(snapshot.readWarnings?.length ? { readWarnings: snapshot.readWarnings } : {}),
      counts: counts(agents),
      machines: groups("machineId", "machine"),
      leads: groups("leadId", "lead"),
      agents,
    });
  }
}
