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

type Counters = FleetHealthMetricsSnapshot["totals"];
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

/** Only fixed reason counters leave this collector; internal seat keys expire in five minutes. */
export class FleetHealthMetrics {
  private readonly now: () => number;
  private readonly startedAt: string;
  private readonly totals = empty();
  private readonly buckets = new Map<number, Counters>();
  private readonly seats = new Map<
    string,
    {
      buckets: Map<number, Counters>;
      lastSeen: number;
      alertAt?: number;
      attemptAt?: number;
      alertPending?: boolean;
    }
  >();
  private readonly reports = new Map<string, { signature: string; lastSeen: number }>();
  private readonly options: {
    now?: () => number;
    onProofAlert?(pane: string, window: FleetHealthMetricsWindow): boolean | Promise<boolean>;
  };
  constructor(
    options: {
      now?: () => number;
      onProofAlert?(pane: string, window: FleetHealthMetricsWindow): boolean | Promise<boolean>;
    } = {},
  ) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.startedAt = new Date(this.now()).toISOString();
  }
  private prune(minute: number) {
    for (const at of this.buckets.keys()) if (at <= minute - 60 || at > minute) this.buckets.delete(at);
    for (const [pane, seat] of this.seats) {
      if (seat.lastSeen <= minute - 5) this.seats.delete(pane);
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
      if (FleetNativeDiagnosticReasonSchema.safeParse(event.event.reason).success)
        this.record((counts) => increment(counts.nativeDiagnostics, event.event.reason));
      return;
    }
    if (event.source === "transport") {
      if (FleetTransportDiagnosticReasonSchema.safeParse(event.reason).success)
        this.record((counts) => increment(counts.transportDiagnostics, event.reason));
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
    if (!pane || !/^w[\w]+:p[\w]+$/u.test(pane)) return;
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
    const rates = window(5, seat.buckets, minute);
    if (
      event.source === "proof" &&
      rates.proofRefusalRate > 0.01 &&
      !seat.alertPending &&
      (seat.attemptAt === undefined || minute - seat.attemptAt >= 1) &&
      (seat.alertAt === undefined || minute - seat.alertAt >= 5)
    ) {
      seat.attemptAt = minute;
      seat.alertPending = true;
      const original = seat;
      const settled = (accepted: boolean) => {
        // A replaced/expired seat observation cannot acquire an old cooldown.
        if (this.seats.get(pane) !== original) return;
        original.alertPending = false;
        if (accepted) original.alertAt = Math.floor(this.now() / MINUTE);
      };
      try {
        void Promise.resolve(this.options.onProofAlert?.(pane, rates))
          .then((accepted) => settled(accepted === true))
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
      windows: [window(5, this.buckets, minute), window(60, this.buckets, minute)],
    };
  }
}
