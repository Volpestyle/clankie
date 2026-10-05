import { createHash } from "node:crypto";
import type { OperatorFleetSeat } from "@clankie/protocol";

/** Stable evidence for periodic rounds; observation clocks and report reads are not fresh work. */
export function fleetRoundEvidence(seats: readonly OperatorFleetSeat[]): {
  fingerprint: string;
  flagged: boolean;
} {
  const rows = seats.map((seat) => {
    const efficiency = seat.efficiency;
    return {
      seatId: seat.seatId,
      occupantId: seat.occupantId,
      harness: seat.harness,
      fleet: seat.fleet,
      status: seat.status,
      assignment: seat.assignment && {
        objective: seat.assignment.objective,
        issue: seat.assignment.issue && {
          repoId: seat.assignment.issue.repoId,
          itemId: seat.assignment.issue.itemId,
        },
      },
      goal: seat.goal && {
        objective: seat.goal.objective,
        status: seat.goal.status,
        tokenBudget: seat.goal.tokenBudget,
      },
      efficiency: efficiency && {
        ownerConversationId: efficiency.ownerConversationId,
        flags: [...efficiency.flags].sort(),
        assignedDeliverable: efficiency.assignedDeliverable,
        objective: efficiency.objective,
        currentIssue: efficiency.currentIssue,
        model: efficiency.model,
        effort: efficiency.effort,
        contextPercent: efficiency.contextPercent,
        lastProgressAt: efficiency.lastProgressAt,
        lastReportAt: efficiency.lastReportAt,
        reportFailures: efficiency.reportFailures,
      },
      reporting: seat.workerReportRouting && {
        source: seat.workerReportRouting.source,
        reason: seat.workerReportRouting.reason,
        conversationId: seat.workerReportRouting.conversationId,
        leadSeatId: seat.workerReportRouting.leadSeatId,
        leadPaneId: seat.workerReportRouting.leadPaneId,
      },
    };
  });
  rows.sort(
    (left, right) =>
      left.seatId.localeCompare(right.seatId) || left.occupantId.localeCompare(right.occupantId),
  );
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    flagged: seats.some((seat) => (seat.efficiency?.flags.length ?? 0) > 0),
  };
}

/** These are bounded observations, not new authority or a scripted intervention. */
export function fleetReviewContext(seats: readonly OperatorFleetSeat[], budget = 10_000): string {
  const lines = [
    "Fleet lead round. Use the lead skill and fleet_efficiency to inspect every seat you lead before deciding how to act.",
    "The bounded observations below may omit details. Unknown telemetry is not healthy. Context is the latest native model-input snapshot.",
    "Untrusted seat context:",
  ];
  budget = Math.max(0, Math.min(10_000, budget));
  if (budget < lines.join("\n").length + 160)
    return "Use the lead skill and fleet_efficiency to inspect every seat you lead.".slice(0, budget);
  let remaining = budget - lines.join("\n").length;
  let omitted = 0;
  for (const seat of seats) {
    const efficiency = seat.efficiency;
    const row = `> ${JSON.stringify({
      seatId: seat.seatId,
      status: seat.status,
      flags: efficiency?.flags,
      assigned: efficiency?.assignedDeliverable?.slice(0, 160),
      currentIssue: efficiency?.currentIssue,
      objective: efficiency?.objective?.slice(0, 160),
      model: efficiency?.model,
      effort: efficiency?.effort,
      contextPercent: efficiency?.contextPercent,
      lastProgressAt: efficiency?.lastProgressAt,
      lastReportAt: efficiency?.lastReportAt,
      reportFailures: efficiency?.reportFailures,
      reportRoute: seat.workerReportRouting?.source,
    })}`;
    if (row.length + 1 > remaining - 160) {
      omitted++;
      continue;
    }
    lines.push(row);
    remaining -= row.length + 1;
  }
  if (omitted)
    lines.push(
      `> ${JSON.stringify({ omittedSeats: omitted, totalSeats: seats.length, details: "Use fleet_efficiency for the full roster" })}`,
    );
  return lines.join("\n");
}

/** A separate cadence never replaces an owner's scheduled wake. */
export function startFleetRounds(round: () => Promise<void>, intervalMs = 30 * 60_000): () => void {
  let running = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    void round()
      .catch((error: unknown) => console.warn("Fleet lead round unavailable", String(error)))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
