import type { DriftDetection, ProjectVelocity } from "@clankie/protocol/auto-rounds";

type VelocityDay = ProjectVelocity["days"][number];

/** The local calendar date of an instant in the measurement's zone. */
function localDate(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/**
 * Drift in one measurement (ADR 0270). Only completed working days count: today is partial,
 * idle days neither count nor break a streak, and days whose sources were unreadable are
 * skipped, so nothing fires on missing data.
 */
function detectDrift(velocity: ProjectVelocity): DriftDetection[] {
  const today = localDate(velocity.measuredAt, velocity.timeZone);
  const working = velocity.days.filter((day) => day.date < today && day.working === true);
  const detections: DriftDetection[] = [];

  const lastTwo = working.slice(-2);
  const nonProduct = (day: VelocityDay) => day.lines!.tooling + day.lines!.docs;
  if (
    lastTwo.length === 2 &&
    lastTwo.every((day) => day.lines !== null && nonProduct(day) > day.lines.product)
  ) {
    const [before, latest] = lastTwo as [VelocityDay, VelocityDay];
    detections.push({
      signal: "tooling_lead",
      day: latest.date,
      numbers: {
        product: latest.lines!.product,
        tooling: latest.lines!.tooling,
        docs: latest.lines!.docs,
        previousProduct: before.lines!.product,
        previousTooling: before.lines!.tooling,
        previousDocs: before.lines!.docs,
      },
    });
  }

  const latest = working.at(-1);
  if (latest?.closed && latest.closed.ownerFacing + latest.closed.unlinked === 0)
    detections.push({
      signal: "nothing_closed",
      day: latest.date,
      numbers: { tooling: latest.closed.tooling, stateChanges: latest.stateChanges ?? 0 },
    });

  if (
    velocity.started.state === "known" &&
    velocity.started.cap !== null &&
    velocity.started.total > velocity.started.cap
  )
    detections.push({
      signal: "over_wip",
      day: today,
      numbers: { started: velocity.started.total, cap: velocity.started.cap },
    });
  return detections;
}

const lines = (product: number, tooling: number, docs: number) =>
  `product ${String(product)}, tooling ${String(tooling)}, docs ${String(docs)}`;

/** The expectation each signal carries; which feature or which issues is the lead's call. */
function driftLine(name: string, detection: DriftDetection): string {
  const n = detection.numbers;
  const carried = detection.carried ? " (carried from an undelivered round)" : "";
  switch (detection.signal) {
    case "tooling_lead":
      return `${name}: tooling_lead${carried}. Tooling and docs churn outran product on the last two working days (${String(detection.day)}: ${lines(n.product!, n.tooling!, n.docs!)}; the working day before: ${lines(n.previousProduct!, n.previousTooling!, n.previousDocs!)}). Stop starting tooling work on this project, then pick the next milestone feature and staff it.`;
    case "nothing_closed":
      return `${name}: nothing_closed${carried}. ${detection.day} was a working day with no owner-facing closure (${String(n.tooling)} tooling closures, ${String(n.stateChanges)} state changes). Stop starting tooling work on this project, then pick the next milestone feature and staff it.`;
    case "over_wip":
      return `${name}: over_wip${carried}. ${String(n.started)} started issues against a WIP cap of ${String(n.cap)}. Return the excess ${String(n.started! - n.cap!)} to Backlog, each with one line on where it stopped.`;
  }
}

/** The round's drift section; empty when nothing drifts. */
export function driftSection(velocities: readonly ProjectVelocity[]): string[] {
  const rows = velocities.flatMap((velocity) =>
    (velocity.drift ?? []).map((detection) => `- ${driftLine(velocity.name, detection)}`),
  );
  return rows.length
    ? [
        "",
        "Drift the service detected (ADR 0270). Correct course in this round; the choice of feature and of issues to park is yours:",
        ...rows,
      ]
    : [];
}

/** The signal set a round fingerprint carries: names per project, not numbers or days. */
export function driftSignals(velocity: ProjectVelocity | undefined): string[] {
  return [...new Set((velocity?.drift ?? []).map((detection) => detection.signal))].sort();
}

/** The round's drift for a measurement: what is detected now, plus undelivered detections carried. */
export function withDrift(velocity: ProjectVelocity, pending: readonly DriftDetection[]): ProjectVelocity {
  const drift = detectDrift(velocity);
  return {
    ...velocity,
    drift: [
      ...drift,
      ...pending
        .filter(
          (entry) =>
            !drift.some((detection) => detection.signal === entry.signal && detection.day === entry.day),
        )
        .map((entry) => ({ ...entry, carried: true })),
    ],
  };
}
