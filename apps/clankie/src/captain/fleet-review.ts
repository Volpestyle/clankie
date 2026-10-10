import { createHash } from "node:crypto";
import type { OperatorFleetSeat } from "@clankie/protocol";
import { describeDeployHold, type DeployHold } from "@clankie/protocol/integrate";

/** Stable evidence for periodic rounds; observation clocks and report reads are not fresh work. */
export function fleetRoundEvidence(
  seats: readonly OperatorFleetSeat[],
  holds: readonly DeployHold[] = [],
): {
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
      reportBridge: seat.workerReportBridge && {
        outcome: seat.workerReportBridge.outcome,
        reason: seat.workerReportBridge.reason,
        lastStoredAt: seat.workerReportBridge.lastStoredAt,
      },
    };
  });
  rows.sort(
    (left, right) =>
      left.seatId.localeCompare(right.seatId) || left.occupantId.localeCompare(right.occupantId),
  );
  const deployHolds = holds.map((hold) => hold.id).sort();
  return {
    fingerprint: createHash("sha256")
      .update(JSON.stringify(deployHolds.length ? { rows, deployHolds } : rows))
      .digest("hex"),
    flagged: seats.some((seat) => (seat.efficiency?.flags.length ?? 0) > 0),
  };
}

/** These are bounded observations, not new authority or a scripted intervention. */
export function fleetReviewContext(
  seats: readonly OperatorFleetSeat[],
  budget = 10_000,
  holds: readonly DeployHold[] = [],
  now = Date.now(),
): string {
  const lines = [
    "Fleet lead round. Use the lead skill and fleet_efficiency to inspect every seat you lead before deciding how to act.",
    "The bounded observations below may omit details. Unknown telemetry is not healthy. Context is the latest native model-input snapshot.",
    "Untrusted seat context:",
  ];
  budget = Math.max(0, Math.min(10_000, budget));
  if (budget < lines.join("\n").length + 160)
    return "Use the lead skill and fleet_efficiency to inspect every seat you lead.".slice(0, budget);
  let remaining = budget - lines.join("\n").length;
  // Holder text is untrusted too; the lead or owner may release a hold with an audited reason.
  for (const hold of holds) {
    const row = `> ${JSON.stringify({
      deployHold: hold.id,
      summary: describeDeployHold(hold, now).slice(0, 400),
      release: `clankie integrate release ${hold.id} --actor NAME --reason TEXT`,
    })}`;
    if (row.length + 1 > remaining - 160) break;
    lines.push(row);
    remaining -= row.length + 1;
  }
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
      reportBridge: seat.workerReportBridge,
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

/** One alert per owning conversation while at least three current seats are failing. */
interface FleetReportFailureAlert {
  owner: string;
  seatId: string;
  text: string;
  kind: "incident" | "recovery";
}

interface FleetReportFailureAlertState {
  accepted: boolean;
  retryAt: number;
  pending?: FleetReportFailureAlert;
}

export class FleetReportFailureAlerts {
  private readonly owners = new Map<string, FleetReportFailureAlertState>();

  observe(seats: readonly OperatorFleetSeat[], now = Date.now()): FleetReportFailureAlert[] {
    const owners = new Map<string, OperatorFleetSeat[]>();
    for (const seat of seats) {
      const owner = seat.efficiency?.ownerConversationId;
      if (!owner) continue;
      const owned = owners.get(owner) ?? [];
      owned.push(seat);
      owners.set(owner, owned);
    }
    for (const owner of this.owners.keys()) if (!owners.has(owner)) this.owners.delete(owner);
    const alerts: FleetReportFailureAlert[] = [];
    for (const [owner, owned] of owners) {
      const state: FleetReportFailureAlertState = this.owners.get(owner) ?? { accepted: false, retryAt: 0 };
      this.owners.set(owner, state);
      if (state.pending || now < state.retryAt) continue;
      const failed = new Map(
        owned
          .filter((seat) => {
            const report = seat.workerReportBridge;
            if (!report || report.outcome === "stored") return false;
            const age = now - Date.parse(report.observedAt);
            return age >= 0 && age <= 10 * 60_000;
          })
          .map((seat) => [seat.seatId, seat]),
      );
      let alert: FleetReportFailureAlert | undefined;
      if (failed.size >= 3 && !state.accepted) {
        alert = {
          owner,
          kind: "incident",
          seatId: [...failed.values()][0]!.seatId,
          text: `Fleet report bridge alert at ${new Date(now).toISOString()}: ${failed.size} of your current seats reported receipt failures within 10 minutes. ${JSON.stringify([...failed.values()].slice(0, 8).map((seat) => ({ seatId: seat.seatId.slice(0, 128), outcome: seat.workerReportBridge!.outcome, reason: seat.workerReportBridge!.reason })))}. Inspect roster or doctor report health; unresolved originals must be reconciled without replay.`,
        };
      } else if (failed.size < 3 && state.accepted) {
        alert = {
          owner,
          kind: "recovery",
          seatId: owned[0]!.seatId,
          text: `Fleet report bridge recovery: ${failed.size} of your current seats have recent receipt failures; the three-seat alert cleared at ${new Date(now).toISOString()}.`,
        };
      }
      if (alert) {
        state.pending = alert;
        alerts.push(alert);
      }
    }
    return alerts;
  }

  settle(alert: FleetReportFailureAlert, accepted: boolean, now = Date.now()): void {
    const state = this.owners.get(alert.owner);
    if (state?.pending !== alert) return;
    delete state.pending;
    if (accepted) {
      state.accepted = alert.kind === "incident";
      state.retryAt = 0;
    } else state.retryAt = now + 60_000;
  }
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
