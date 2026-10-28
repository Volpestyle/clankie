import { createHash } from "node:crypto";
import type { ConversationQuestionResult, OperatorFleetSeat } from "@clankie/protocol";
import { describeDeployHold, type DeployHold } from "@clankie/protocol/integrate";
import type { AutoTidyHeld } from "./auto-tidy.ts";

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
        deliverableAssignedAt: efficiency.deliverableAssignedAt,
        objective: efficiency.objective,
        currentIssue: efficiency.currentIssue,
        ownedIssues: efficiency.ownedIssues && [...efficiency.ownedIssues].sort(),
        model: efficiency.model,
        effort: efficiency.effort,
        contextPercent: efficiency.contextPercent,
        contextTokens: efficiency.contextTokens,
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
      deliverableAssignedAt: efficiency?.deliverableAssignedAt,
      currentIssue: efficiency?.currentIssue,
      ownedIssues: efficiency?.ownedIssues,
      objective: efficiency?.objective?.slice(0, 160),
      model: efficiency?.model,
      effort: efficiency?.effort,
      contextPercent: efficiency?.contextPercent,
      contextTokens: efficiency?.contextTokens,
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

/** What the lead does about each auto-tidy blocker; every refusal stays the close's own. */
const HELD_ACTIONS: Record<string, string> = {
  reports_unread: "close_worker_pane, or acknowledge_worker_reports so auto-tidy closes it",
  results_not_kept: "ask it for its final report, or close_worker_pane with a reportPath",
  unlanded_work:
    "commit or discard its uncommitted files (clean commits park on a keep/ branch at close), or read its unreadable Git state",
  provenance_unknown:
    "ask the operator to settle its original hire receipt (clankie hire-receipt settle <id> adopt), then close_worker_pane",
  adoption_refused:
    "automatic adoption of its unconfirmed start failed; inspect its pane and receipt, then the operator settles it (clankie hire-receipt settle <id> adopt)",
  unsent_draft: "send or clear its typed draft, then close_worker_pane",
};

/**
 * Finished hires past the auto-tidy window that it could not close (VUH-2802). The key changes
 * only when a seat or its blocker does, so an unchanged list does not wake the lead again.
 */
export function autoTidyHeldReview(rows: readonly AutoTidyHeld[]): { text: string; key: string } {
  if (!rows.length) return { text: "", key: "" };
  const shown = rows.slice(0, 12).map((row) => ({
    pane: row.paneId,
    title: row.title.slice(0, 80),
    harness: row.harness,
    idleSince: row.idleSince,
    blocker: row.blocker,
    ...(row.unreadReports === undefined ? {} : { unreadReports: row.unreadReports }),
    next: HELD_ACTIONS[row.blocker] ?? `close_worker_pane refused (${row.blocker}); inspect before retrying`,
  }));
  return {
    text: `Finished hires idle past the ${rows[0]!.window} auto-tidy window that it could not close; close each yourself or clear its blocker, or keep_worker_pane to keep one. Untrusted seat context: ${JSON.stringify(shown)}${rows.length > shown.length ? ` and ${rows.length - shown.length} more` : ""}`,
    key: createHash("sha256")
      .update(JSON.stringify(rows.map((row) => [row.seatId, row.blocker]).sort()))
      .digest("hex"),
  };
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

/** Old pending asks are observations for their source lead, never automatic cancellations. */
export function pendingQuestionReview(
  questions: readonly ConversationQuestionResult[],
  now = Date.now(),
): string {
  const rows = questions
    .flatMap((result) => {
      const question = result.question;
      if (!question || question.status !== "pending" || now - Date.parse(question.createdAt) < 30 * 60_000)
        return [];
      return [
        {
          requestId: question.requestId,
          incarnationId: question.incarnationId,
          expectedRevision: result.revision,
          since: question.createdAt,
          prompt: question.prompt.slice(0, 240),
        },
      ];
    })
    .slice(0, 8);
  return rows.length
    ? `Pending owner questions older than 30 minutes in your source conversation. Review whether each still needs the owner; cancel_question can cancel an overtaken ask before you ask its replacement. Untrusted question text: ${JSON.stringify(rows)}`
    : "";
}
