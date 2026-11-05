import type { FleetCapacity, OperatorFleetSnapshot } from "@clankie/protocol";
import { FleetDigestSnapshotSchema, type FleetDigestSnapshot } from "@clankie/protocol/fleet-digest";
import type { LeadChangeSnapshot } from "./lead-changes.ts";

/** The digest reads existing projections; it never offers/acknowledges a report or answers an ask. */
export function projectFleetDigest(input: {
  now: Date;
  changes: readonly LeadChangeSnapshot[];
  capacity?: FleetCapacity | undefined;
  fleet?: OperatorFleetSnapshot | undefined;
}): FleetDigestSnapshot {
  const today = input.now.toISOString().slice(0, 10);
  const start = Date.parse(`${today}T00:00:00.000Z`);
  const inDay = (at: string) => Date.parse(at) >= start && Date.parse(at) <= input.now.getTime();
  const source = (kind: LeadChangeSnapshot["source"]) => input.changes.find((s) => s.source === kind);
  const records = (kind: LeadChangeSnapshot["source"]) => {
    const found = source(kind);
    return !found || found.unavailable
      ? undefined
      : [...new Map(found.records.map((r) => [r.id, r])).values()];
  };
  const reports = records("worker_report");
  const asks = records("owner_ask");
  const pulls = records("pull_request");
  const paneReady =
    records("pane") !== undefined && input.fleet !== undefined && !input.fleet.readWarnings?.length;
  const seats = paneReady ? input.fleet!.seats : undefined;
  const seatCount = (states: readonly string[]): number | "unknown" =>
    seats?.filter((s) => states.includes(s.status)).length ?? "unknown";
  const workers = {
    hired: seats?.filter((s) => s.owner?.hired === true).length ?? "unknown",
    working: seatCount(["working"]),
    waiting: seatCount(["waiting"]),
    blocked: seatCount(["blocked"]),
    idle: seatCount(["idle"]),
    finished: seatCount(["done", "finished"]),
    unclassified:
      seats?.filter((s) => !["working", "waiting", "blocked", "idle", "done", "finished"].includes(s.status))
        .length ?? "unknown",
  } as const;
  const pending =
    asks?.filter((r) => r.item.kind === "owner_ask" && r.item.status === "pending" && r.state === "active")
      .length ?? "unknown";
  const closed = paneReady ? input.fleet?.closedPanes : undefined;
  const closeCount =
    closed === undefined
      ? "unknown"
      : [...new Map(closed.map((c) => [c.id, c])).values()].filter(
          (c) => c.state === "closed" && inDay(c.closedAt),
        ).length;
  const burn = input.capacity?.burn;
  const tokens = burn?.flatMap((a) => (a.lastHour === "unknown" ? [] : [a.lastHour.tokens]));
  const machines = input.capacity?.machineResources;
  const sources: FleetDigestSnapshot["sources"] = {
    reports: reports === undefined ? "unavailable" : "ready",
    workers: paneReady ? "ready" : "unavailable",
    ownerQuestions: asks === undefined ? "unavailable" : "ready",
    pullRequests: pulls === undefined ? "unavailable" : "ready",
    capacity:
      input.capacity === undefined ? "unavailable" : input.capacity.notices.length ? "partial" : "ready",
    closeHistory: closed === undefined ? "unavailable" : "ready",
  };
  const attention: FleetDigestSnapshot["attention"] = [];
  if (pending !== 0) attention.push({ kind: "owner_questions", count: pending });
  if (workers.blocked !== 0) attention.push({ kind: "blocked_workers", count: workers.blocked });
  const incomplete = Object.values(sources).filter((s) => s !== "ready").length;
  if (incomplete) attention.push({ kind: "incomplete_sources", count: incomplete });
  const heavy = input.capacity?.heavy;
  return FleetDigestSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: input.now.toISOString(),
    dayUtc: today,
    coverage: "retained_observations",
    attention,
    workers,
    activity: {
      doneReportsToday:
        reports?.filter((r) => r.item.kind === "worker_report" && r.item.reportKind === "done" && inDay(r.at))
          .length ?? "unknown",
      blockedReportsToday:
        reports?.filter(
          (r) => r.item.kind === "worker_report" && r.item.reportKind === "blocked" && inDay(r.at),
        ).length ?? "unknown",
      confirmedClosesToday: closeCount,
    },
    pullRequests: {
      open:
        pulls?.filter((r) => r.item.kind === "pull_request" && r.item.status === "open").length ?? "unknown",
      merged:
        pulls?.filter((r) => r.item.kind === "pull_request" && r.item.status === "merged").length ??
        "unknown",
      retainedSince: source("pull_request")?.retainedSince ?? "unknown",
    },
    burn: {
      accountsObserved: burn?.length ?? "unknown",
      accountsRunningOut:
        burn?.filter((a) => a.windows.some((w) => !["unknown", "not before reset"].includes(w.runsOutAt)))
          .length ?? "unknown",
      accountsWithUnknownPace:
        burn?.filter(
          (a) =>
            !a.windows.length ||
            a.windows.every(
              (w) => w.percentPerHour.recent === "unknown" && w.percentPerHour.windowAverage === "unknown",
            ),
        ).length ?? "unknown",
      lastHourKnownTokens:
        tokens === undefined || (burn?.length && !tokens.length)
          ? "unknown"
          : tokens.reduce((n, t) => n + t.input + t.output + t.cacheRead + t.cacheWrite, 0),
      accountsMissingTokens: burn?.filter((a) => a.lastHour === "unknown").length ?? "unknown",
    },
    resources: {
      heavy:
        heavy === undefined || heavy === "unknown"
          ? "unknown"
          : { slots: heavy.slots, used: heavy.used, queued: heavy.queued },
      machines:
        machines === undefined
          ? "unknown"
          : {
              available: Object.values(machines).filter((m) => m.status === "available").length,
              unavailable: Object.values(machines).filter((m) => m.status === "unavailable").length,
            },
    },
    sources,
  });
}
