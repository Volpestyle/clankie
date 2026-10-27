import type {
  TrackerRequestBudgetActor,
  TrackerRequestBudgetReport,
} from "@clankie/protocol/tracker-request-budget";
import type { TrackerRole } from "@clankie/work-items";
import type { LinearRequestPriority } from "./linear-request-budget.ts";

const REQUEST_WINDOW_MS = 3_600_000;
const WRITE_WINDOW_MS = 60_000;
/** Well above the observed fleet-wide peaks (111 events/hour, 17 creates in 45 s). */
const TRACKER_REQUEST_LIMIT = 600;
const TRACKER_WRITE_LIMIT = 60;

type RefusalReason = keyof TrackerRequestBudgetActor["refusals"];
interface ClassState {
  requests: number[];
  writes: number[];
}
interface ActorState {
  name?: string;
  role?: "worker" | "reviewer";
  interactive: ClassState;
  background: ClassState;
  refusals: { at: number; reason: RefusalReason }[];
}

export class TrackerRequestBudgetRefused extends Error {
  readonly code = "tracker_request_budget";
  readonly reason: "requests_exhausted" | "writes_exhausted";
  readonly retryAt: number;
  constructor(reason: "requests_exhausted" | "writes_exhausted", retryAt: number, priority: string) {
    super(
      `Tracker ${priority} ${reason === "requests_exhausted" ? `request budget (${TRACKER_REQUEST_LIMIT}/hour)` : `write budget (${TRACKER_WRITE_LIMIT}/minute)`} is spent; retry after ${new Date(retryAt).toISOString()}`,
    );
    this.reason = reason;
    this.retryAt = retryAt;
  }
}

/**
 * One service-owned budget per hired worker on Clankie's own trackers (LOCAL-VUH-45).
 * Interactive and background calls are separate classes, so a runaway poll never
 * starves the same worker's turn. Refused calls are not counted: they had no effect.
 */
export class TrackerRequestBudget {
  private readonly actors = new Map<string, ActorState>();
  private readonly clock: () => number;
  private readonly limits: { readonly requests: number; readonly writes: number };
  constructor(options: { clock?: () => number; requests?: number; writes?: number } = {}) {
    this.clock = options.clock ?? Date.now;
    this.limits = {
      requests: options.requests ?? TRACKER_REQUEST_LIMIT,
      writes: options.writes ?? TRACKER_WRITE_LIMIT,
    };
  }

  /** Counts the call, or throws without counting it. */
  admit(
    actor: { id: string; name?: string; role: Exclude<TrackerRole, "lead" | "owner"> },
    priority: LinearRequestPriority,
    write: boolean,
  ): void {
    const now = this.clock();
    const state = this.state(actor);
    this.prune(state, now);
    const bucket = state[priority];
    if (bucket.requests.length >= this.limits.requests)
      throw this.refuse(
        state,
        now,
        new TrackerRequestBudgetRefused(
          "requests_exhausted",
          bucket.requests[0]! + REQUEST_WINDOW_MS,
          priority,
        ),
      );
    if (write && bucket.writes.length >= this.limits.writes)
      throw this.refuse(
        state,
        now,
        new TrackerRequestBudgetRefused("writes_exhausted", bucket.writes[0]! + WRITE_WINDOW_MS, priority),
      );
    bucket.requests.push(now);
    if (write) bucket.writes.push(now);
  }

  /** A role refusal is recorded here, never as a tracker write. */
  refused(actor: { id: string; name?: string; role: "worker" | "reviewer" }): void {
    this.state(actor).refusals.push({ at: this.clock(), reason: "role_not_allowed" });
  }

  report(): TrackerRequestBudgetReport {
    const now = this.clock();
    const actors: TrackerRequestBudgetActor[] = [];
    for (const [actorId, state] of this.actors) {
      this.prune(state, now);
      if (!state.refusals.length && !state.interactive.requests.length && !state.background.requests.length) {
        this.actors.delete(actorId);
        continue;
      }
      const bucket = (entry: ClassState) => {
        const retryAt = Math.max(
          entry.requests.length >= this.limits.requests ? entry.requests[0]! + REQUEST_WINDOW_MS : 0,
          entry.writes.length >= this.limits.writes ? entry.writes[0]! + WRITE_WINDOW_MS : 0,
        );
        return {
          requests: entry.requests.length,
          requestLimit: this.limits.requests,
          writes: entry.writes.length,
          writeLimit: this.limits.writes,
          ...(retryAt > 0 ? { retryAt } : {}),
        };
      };
      actors.push({
        actorId,
        ...(state.name === undefined ? {} : { name: state.name }),
        ...(state.role === undefined ? {} : { role: state.role }),
        interactive: bucket(state.interactive),
        background: bucket(state.background),
        refusals: {
          role_not_allowed: state.refusals.filter((entry) => entry.reason === "role_not_allowed").length,
          tracker_request_budget: state.refusals.filter((entry) => entry.reason === "tracker_request_budget")
            .length,
        },
      });
    }
    return {
      schemaVersion: 1,
      requestWindowMs: REQUEST_WINDOW_MS,
      writeWindowMs: WRITE_WINDOW_MS,
      observedAt: now,
      actors,
    };
  }

  private refuse(state: ActorState, now: number, error: TrackerRequestBudgetRefused) {
    state.refusals.push({ at: now, reason: "tracker_request_budget" });
    return error;
  }

  private state(actor: { id: string; name?: string; role: "worker" | "reviewer" }): ActorState {
    let state = this.actors.get(actor.id);
    if (!state) {
      state = {
        interactive: { requests: [], writes: [] },
        background: { requests: [], writes: [] },
        refusals: [],
      };
      this.actors.set(actor.id, state);
    }
    if (actor.name !== undefined) state.name = actor.name;
    state.role = actor.role;
    return state;
  }

  private prune(state: ActorState, now: number): void {
    const drop = <T>(entries: T[], at: (entry: T) => number, windowMs: number) => {
      const first = entries.findIndex((entry) => at(entry) > now - windowMs);
      entries.splice(0, first === -1 ? entries.length : first);
    };
    for (const bucket of [state.interactive, state.background]) {
      drop(bucket.requests, (at) => at, REQUEST_WINDOW_MS);
      drop(bucket.writes, (at) => at, WRITE_WINDOW_MS);
    }
    drop(state.refusals, (entry) => entry.at, REQUEST_WINDOW_MS);
  }
}
