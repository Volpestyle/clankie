import {
  FleetNativeDiagnosticReasonSchema,
  FleetProofRefusalReasonSchema,
  FleetTransportDiagnosticReasonSchema,
  WorkerReportBridgeReasonSchema,
  type FleetHealthMetricsSnapshot,
  type FleetHealthMetricsWindow,
  type WorkerReportBridgeStatus,
} from "@clankie/protocol";
import type { LocalFleetProofDiagnostic } from "./local-fleet-proof.ts";
import type { FleetHealthAlertDelivery } from "./captain/port.ts";

export type ProofAlertCallers = readonly { claimedPane: string; window: FleetHealthMetricsWindow }[];

/** Alert text is capped by the native delivery boundary; full labels remain in metrics. */
export function proofAlertCallerSummary(callers: ProofAlertCallers): string {
  const panes = callers
    .filter((caller) => caller.window.proof.refusals > 0)
    .map((caller) => caller.claimedPane);
  const shown: string[] = [];
  for (const pane of panes) {
    if ([...shown, pane].join(", ").length > 1200) break;
    shown.push(pane);
  }
  return (
    (shown.join(", ") || "none attributed") +
    (shown.length < panes.length ? `; ${panes.length - shown.length} more in clankie metrics --fleet` : "")
  );
}

type ProofAlertResult = boolean | FleetHealthAlertDelivery;

type Counters = FleetHealthMetricsSnapshot["totals"];
type AlertState = {
  buckets: Map<number, Counters>;
  lastSeen: number;
  alertAt?: number;
  attemptAt?: number;
  alertPending?: boolean;
  acknowledged?: () => boolean;
  elevatedSince?: number;
};
const MINUTE = 60_000;
function empty(): Counters {
  return {
    proof: { attempts: 0, refusals: 0, byReason: {} },
    reports: { attempts: 0, failures: 0, byReason: {} },
    nativeDiagnostics: {},
    transportDiagnostics: {},
  };
}
function increment(counts: Partial<Record<string, number>>, reason: string) {
  counts[reason] = (counts[reason] ?? 0) + 1;
}
function addReasons(target: Partial<Record<string, number>>, source: Partial<Record<string, number>>) {
  for (const [reason, count] of Object.entries(source))
    if (count !== undefined) target[reason] = (target[reason] ?? 0) + count;
}
function merge(target: Counters, source: Counters) {
  target.proof.attempts += source.proof.attempts;
  target.proof.refusals += source.proof.refusals;
  target.reports.attempts += source.reports.attempts;
  target.reports.failures += source.reports.failures;
  for (const [to, from] of [
    [target.proof.byReason, source.proof.byReason],
    [target.reports.byReason, source.reports.byReason],
    [target.nativeDiagnostics, source.nativeDiagnostics],
    [target.transportDiagnostics, source.transportDiagnostics],
  ] as const) {
    addReasons(to, from);
  }
}
function window(
  minutes: 5 | 60,
  buckets: ReadonlyMap<number, Counters>,
  minute: number,
): FleetHealthMetricsWindow {
  const counts = empty();
  for (const [at, bucket] of buckets) if (at > minute - minutes && at <= minute) merge(counts, bucket);
  return {
    minutes,
    ...counts,
    proofRefusalRate: counts.proof.attempts === 0 ? 0 : counts.proof.refusals / counts.proof.attempts,
    proofRefusalsPerMinute: counts.proof.refusals / minutes,
    reportFailureRate: counts.reports.attempts === 0 ? 0 : counts.reports.failures / counts.reports.attempts,
    reportFailuresPerMinute: counts.reports.failures / minutes,
  };
}

/** Bounded caller labels and counters; unresolved alerts retain their seat slots. */
export class FleetHealthMetrics {
  private readonly now: () => number;
  private readonly startedAt: string;
  private readonly totals = empty();
  private readonly buckets = new Map<number, Counters>();
  private readonly seats = new Map<string, AlertState>();
  private readonly aggregate: AlertState = { buckets: this.buckets, lastSeen: 0 };
  private readonly proofCauses = new Map<string, { seat: AlertState; attemptAt: number }>();
  private readonly reports = new Map<string, { signature: string; lastSeen: number }>();
  private readonly options: {
    now?: () => number;
    onAggregateProofAlert?(
      window: FleetHealthMetricsWindow,
      callers: ProofAlertCallers,
    ): ProofAlertResult | Promise<ProofAlertResult>;
    onProofAlert?(
      pane: string,
      window: FleetHealthMetricsWindow,
      callers: ProofAlertCallers,
    ): ProofAlertResult | Promise<ProofAlertResult>;
  };
  constructor(
    options: {
      now?: () => number;
      onAggregateProofAlert?(
        window: FleetHealthMetricsWindow,
        callers: ProofAlertCallers,
      ): ProofAlertResult | Promise<ProofAlertResult>;
      onProofAlert?(
        pane: string,
        window: FleetHealthMetricsWindow,
        callers: ProofAlertCallers,
      ): ProofAlertResult | Promise<ProofAlertResult>;
    } = {},
  ) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.startedAt = new Date(this.now()).toISOString();
  }
  private prune(minute: number) {
    for (const at of this.buckets.keys()) if (at <= minute - 60 || at > minute) this.buckets.delete(at);
    for (const [pane, seat] of this.seats) {
      // Inactivity is not receipt settlement. Retain an in-flight/unconfirmed
      // original even when its rate buckets expire, or a new observation could
      // dispatch a distinct alert into the same unresolved recipient. The 512
      // slot admission cap refuses new seats instead of evicting held originals.
      if (!seat.alertPending && seat.lastSeen <= minute - 5) this.seats.delete(pane);
      else for (const at of seat.buckets.keys()) if (at <= minute - 5 || at > minute) seat.buckets.delete(at);
    }
    for (const [key, report] of this.reports) if (report.lastSeen <= minute - 60) this.reports.delete(key);
  }
  private record(update: (counters: Counters) => void) {
    const minute = Math.floor(this.now() / MINUTE);
    this.prune(minute);
    let bucket = this.buckets.get(minute);
    if (!bucket) this.buckets.set(minute, (bucket = empty()));
    update(this.totals);
    update(bucket);
    return minute;
  }
  observeProof(_operation: "fleet" | "project", event: LocalFleetProofDiagnostic, pane?: string): void {
    if (event.source === "native") {
      if (FleetNativeDiagnosticReasonSchema.safeParse(event.event.reason).success) {
        const update = (counts: Counters) => increment(counts.nativeDiagnostics, event.event.reason);
        this.recordCaller(pane, this.record(update), update);
      }
      return;
    }
    if (event.source === "transport") {
      if (FleetTransportDiagnosticReasonSchema.safeParse(event.reason).success) {
        const update = (counts: Counters) => increment(counts.transportDiagnostics, event.reason);
        this.recordCaller(pane, this.record(update), update);
      }
      return;
    }
    if (event.source !== "proof" && event.source !== "proof_success") return;
    if (event.source === "proof" && !FleetProofRefusalReasonSchema.safeParse(event.reason).success) return;
    const update = (counts: Counters) => {
      counts.proof.attempts++;
      if (event.source === "proof") {
        counts.proof.refusals++;
        increment(counts.proof.byReason, event.reason);
      }
    };
    const minute = this.record(update);
    const seat = this.recordCaller(pane, minute, update);
    const fleet = window(5, this.buckets, minute);
    if (this.options.onAggregateProofAlert)
      this.observeAlert(event, minute, this.aggregate, (rates) =>
        this.options.onAggregateProofAlert!(rates, this.snapshot().callers ?? []),
      );
    if (seat && pane && this.options.onProofAlert) {
      const aggregateActive =
        !!this.options.onAggregateProofAlert && this.alertActive(this.aggregate, minute);
      const cause = this.workerCause(window(5, seat.buckets, minute), aggregateActive ? fleet : undefined);
      const previous = cause === undefined ? undefined : this.proofCauses.get(cause);
      if (previous) this.reconcileAlert(previous.seat, minute);
      const allowed =
        cause !== undefined &&
        (!previous ||
          previous.seat === seat ||
          previous.attemptAt !== previous.seat.attemptAt ||
          !this.alertActive(previous.seat, minute));
      this.observeAlert(
        event,
        minute,
        seat,
        (rates) => {
          if (cause !== undefined) this.proofCauses.set(cause, { seat, attemptAt: seat.attemptAt! });
          return this.options.onProofAlert?.(
            pane,
            rates,
            (this.snapshot().callers ?? []).filter(
              (caller) => this.workerCause(caller.window, aggregateActive ? fleet : undefined) === cause,
            ),
          );
        },
        pane,
        allowed,
      );
      for (const [key, original] of this.proofCauses)
        if (original.attemptAt !== original.seat.attemptAt || !this.alertActive(original.seat, minute))
          this.proofCauses.delete(key);
    }
  }
  private alertActive(state: AlertState, minute: number): boolean {
    return !!state.alertPending || (state.alertAt !== undefined && minute - state.alertAt < 5);
  }
  private workerCause(rates: FleetHealthMetricsWindow, fleet?: FleetHealthMetricsWindow): string | undefined {
    if (rates.proof.attempts < 100 || rates.proof.refusals < 5 || rates.proofRefusalRate <= 0.01) return;
    const causes = (counts: FleetHealthMetricsWindow["proof"]["byReason"]) => {
      const result: Record<string, number> = {};
      for (const [reason, count] of Object.entries(counts)) {
        // Initial/final are two observations of the same native proof outage.
        const cause = ["native_initial_unavailable", "native_final_unavailable"].includes(reason)
          ? "native_unavailable"
          : reason;
        result[cause] = (result[cause] ?? 0) + (count ?? 0);
      }
      return result;
    };
    const reasons = Object.entries(causes(rates.proof.byReason)).filter(([, count]) => count > 0);
    const fleetCauses = fleet ? causes(fleet.proof.byReason) : {};
    if (!fleet)
      return reasons
        .map(([reason]) => reason)
        .sort()
        .join(",");
    const distinct = reasons.filter(([reason, count]) => {
      const workerShare = (count ?? 0) / rates.proof.refusals;
      const fleetShare = (fleetCauses[reason] ?? 0) / fleet.proof.refusals;
      return fleetShare < 0.5 && workerShare >= 0.2 && (fleetShare < 0.1 || workerShare - fleetShare >= 0.25);
    });
    if (distinct.length)
      return `reasons:${distinct
        .map(([reason]) => reason)
        .sort()
        .join(",")}`;
    // Small samples above 1% are not outliers merely because their rate is
    // slightly higher. Require both twice the fleet rate and five extra points.
    if (
      rates.proofRefusalRate >= fleet.proofRefusalRate * 2 &&
      rates.proofRefusalRate - fleet.proofRefusalRate >= 0.05
    )
      return `rate:${reasons
        .map(([reason]) => reason)
        .sort()
        .join(",")}`;
    return;
  }

  private recordCaller(
    pane: string | undefined,
    minute: number,
    update: (counts: Counters) => void,
  ): AlertState | undefined {
    if (!pane || !/^w\w{1,64}:p\w{1,64}$/u.test(pane)) return;
    let seat = this.seats.get(pane);
    if (!seat) {
      // Unknown caller panes cannot grow this internal alert map without bound.
      if (this.seats.size >= 512) return;
      this.seats.set(pane, (seat = { buckets: new Map(), lastSeen: minute }));
    }
    seat.lastSeen = minute;
    let bucket = seat.buckets.get(minute);
    if (!bucket) seat.buckets.set(minute, (bucket = empty()));
    update(bucket);
    return seat;
  }
  private reconcileAlert(seat: AlertState, minute: number): void {
    if (seat.alertPending && seat.acknowledged) {
      try {
        // Read only the original acknowledgment. Never redispatch a held alert.
        if (seat.acknowledged()) {
          seat.alertPending = false;
          delete seat.acknowledged;
          seat.alertAt = minute;
        }
      } catch {
        // Missing/conflicting original evidence remains held.
      }
    }
  }
  private observeAlert(
    event: Extract<LocalFleetProofDiagnostic, { source: "proof" | "proof_success" }>,
    minute: number,
    seat: AlertState,
    deliver: (rates: FleetHealthMetricsWindow) => ProofAlertResult | Promise<ProofAlertResult> | undefined,
    pane?: string,
    allowed = true,
  ): void {
    const rates = window(5, seat.buckets, minute);
    // Count every refusal, including cold startup and overload. Page only on
    // a meaningful sample that stays elevated for a minute; caller claims and
    // machine load never change telemetry or aggregate outage eligibility.
    const elevated =
      rates.proof.attempts >= 100 && rates.proof.refusals >= 5 && rates.proofRefusalRate > 0.01;
    if (!elevated) delete seat.elevatedSince;
    else seat.elevatedSince ??= this.now();
    this.reconcileAlert(seat, minute);
    if (
      allowed &&
      event.source === "proof" &&
      elevated &&
      this.now() - seat.elevatedSince! >= MINUTE &&
      !seat.alertPending &&
      (seat.attemptAt === undefined || minute - seat.attemptAt >= 1) &&
      (seat.alertAt === undefined || minute - seat.alertAt >= 5)
    ) {
      seat.attemptAt = minute;
      seat.alertPending = true;
      const original = seat;
      const settled = (delivery: ProofAlertResult | undefined) => {
        // A replaced/expired seat observation cannot acquire an old cooldown.
        if (original !== this.aggregate && (pane === undefined || this.seats.get(pane) !== original)) return;
        if (typeof delivery === "object" && delivery.outcome === "unconfirmed") {
          if (delivery.acknowledged) original.acknowledged = delivery.acknowledged;
          return;
        }
        original.alertPending = false;
        if (delivery === true || (typeof delivery === "object" && delivery.outcome === "accepted"))
          original.alertAt = Math.floor(this.now() / MINUTE);
      };
      try {
        void Promise.resolve(deliver(rates))
          .then(settled)
          .catch(() => settled(false));
      } catch {
        settled(false);
      }
    }
  }
  observeReport(fleet: string, pane: string, report: WorkerReportBridgeStatus): void {
    if (!WorkerReportBridgeReasonSchema.safeParse(report.reason).success) return;
    const minute = Math.floor(this.now() / MINUTE);
    this.prune(minute);
    const key = JSON.stringify([fleet, pane]);
    const signature = JSON.stringify([report.observedAt, report.outcome, report.reason]);
    if (this.reports.get(key)?.signature === signature) return;
    if (this.reports.size >= 512 && !this.reports.has(key))
      this.reports.delete(this.reports.keys().next().value!);
    this.reports.delete(key);
    this.reports.set(key, { signature, lastSeen: minute });
    this.record((counts) => {
      counts.reports.attempts++;
      if (report.outcome !== "stored") {
        counts.reports.failures++;
        increment(counts.reports.byReason, report.reason === "stored" ? "receipt_invalid" : report.reason);
      }
    });
  }
  snapshot(): FleetHealthMetricsSnapshot {
    const now = this.now();
    const minute = Math.floor(now / MINUTE);
    this.prune(minute);
    return {
      schemaVersion: 1,
      startedAt: this.startedAt,
      observedAt: new Date(now).toISOString(),
      totals: structuredClone(this.totals),
      callers: [...this.seats]
        .map(([claimedPane, seat]) => ({
          claimedPane,
          window: window(5, seat.buckets, minute),
        }))
        .sort(
          (left, right) =>
            right.window.proof.refusals - left.window.proof.refusals ||
            left.claimedPane.localeCompare(right.claimedPane),
        ),
      windows: [window(5, this.buckets, minute), window(60, this.buckets, minute)],
    };
  }
}
