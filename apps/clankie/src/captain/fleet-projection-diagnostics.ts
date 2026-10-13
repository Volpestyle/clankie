import { logger } from "../app/log.ts";

export type FleetProjectionPhase =
  | "settings_binding"
  | "census"
  | "local_census"
  | "pc_fleet"
  | "other_fleet"
  | "goal_status"
  | "subagents"
  | "remote_goals"
  | "native_status"
  | "capability"
  | "waiting_notice"
  | "activity"
  | "routing_catalog"
  | "git_enrichment"
  | "issue_enrichment"
  | "issue_attribution"
  | "issue_keeper";

type Outcome = "ok" | "error";
type Interval = { start: number; end: number; outcome: Outcome };

/** One content-free log per projection, including overlapping native observations. */
export function fleetProjectionDiagnostics(log: Pick<typeof logger, "info"> = logger) {
  const started = performance.now();
  const phases = new Map<FleetProjectionPhase, Interval[]>();
  const active = new Set<(outcome?: Outcome) => void>();
  const census = new Map<string, (outcome?: Outcome) => void>();
  function start(phase: FleetProjectionPhase) {
    const before = performance.now();
    let ended = false;
    const stop = (outcome: Outcome = "ok") => {
      if (ended) return;
      ended = true;
      active.delete(stop);
      const intervals = phases.get(phase) ?? [];
      intervals.push({ start: before, end: performance.now(), outcome });
      phases.set(phase, intervals);
    };
    active.add(stop);
    return stop;
  }
  return {
    start,
    async measure<T>(phase: FleetProjectionPhase, read: () => Promise<T>): Promise<T> {
      const stop = start(phase);
      try {
        const value = await read();
        stop();
        return value;
      } catch (error) {
        stop("error");
        throw error;
      }
    },
    census(source: string, pending: boolean, outcome: Outcome = "ok") {
      if (pending) {
        const phase =
          source === "herdr:default" ? "local_census" : source === "herdr:pc" ? "pc_fleet" : "other_fleet";
        census.set(source, start(phase));
      } else {
        census.get(source)?.(outcome);
        census.delete(source);
      }
    },
    complete(outcome: Outcome) {
      for (const stop of active) stop(outcome);
      const round = (value: number) => Math.round(value * 1000) / 1000;
      const spans = [...phases].map(([phase, intervals]) => {
        // Union wall time, rather than summing parallel seats/fleets. Max call
        // duration identifies one slow await without logging its subject.
        let end = 0;
        let duration = 0;
        let maximum = 0;
        for (const interval of intervals.sort((a, b) => a.start - b.start)) {
          duration += Math.max(0, interval.end - Math.max(end, interval.start));
          end = Math.max(end, interval.end);
          maximum = Math.max(maximum, interval.end - interval.start);
        }
        return {
          phase,
          durationMs: round(duration),
          maxCallMs: round(maximum),
          outcome: intervals.some((interval) => interval.outcome === "error") ? "error" : "ok",
        };
      });
      try {
        log.info(
          {
            event: "fleet.projection.timings",
            durationMs: round(performance.now() - started),
            outcome,
            phases: spans,
          },
          "Native fleet projection timings",
        );
      } catch {
        // Diagnostic output cannot change a projection's result or authority.
      }
    },
  };
}

export type FleetProjectionDiagnostics = ReturnType<typeof fleetProjectionDiagnostics>;
