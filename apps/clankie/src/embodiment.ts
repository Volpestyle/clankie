/**
 * Asked embodiment (ADR 0063): the authority half of the seam. It holds
 * intent, authority, and the durable lifecycle record; it never touches the
 * emulator. The in-process play host takes work from here and applies transitions;
 * the captain tool submits intents and polls the session it was handed.
 *
 * Every state change is an emitted event applied back through `applyEvent`,
 * so restart replay rebuilds exactly the state a live process held. The
 * verdict is an injected function, never bypassed.
 */
import {
  canTransitionEmbodimentSession,
  EmbodimentBudgetSchema,
  EmbodimentEnvironmentIdSchema,
  EmbodimentRefusalReasonSchema,
  EmbodimentSessionSchema,
  EmbodimentVenueSchema,
  embodimentVenue,
  type EmbodimentEnvironmentId,
  type EmbodimentIntent,
  type EmbodimentRefusalReason,
  type EmbodimentSession,
  type EmbodimentSessionReceipt,
  type EmbodimentSessionState,
  type EmbodimentSubmitResult,
} from "@clankie/protocol";
import { z } from "zod";

/** Event scope id: embodiment sessions live outside any mission. */
export function embodimentEventScope(sessionId: string): string {
  return `embodiment:${sessionId}`;
}

const EMBODIMENT_EVENT_TYPES = [
  "embodiment.intent.submitted",
  "embodiment.session.claimed",
  "embodiment.session.running",
  "embodiment.session.stop_requested",
  "embodiment.session.stopping",
  "embodiment.session.refused",
  "embodiment.session.stopped",
  "embodiment.session.failed",
] as const;
export type EmbodimentEventType = (typeof EMBODIMENT_EVENT_TYPES)[number];

export function isEmbodimentEventType(type: string): type is EmbodimentEventType {
  return (EMBODIMENT_EVENT_TYPES as readonly string[]).includes(type);
}

/** The slice of a stored DomainEvent replay needs; the full envelope is not. */
export interface EmbodimentEventInput {
  readonly type: string;
  readonly occurredAt: string;
  readonly data: Record<string, unknown>;
}

const SubmittedDataSchema = z.object({
  sessionId: z.string().min(1),
  intentId: z.string().min(1),
  environmentId: EmbodimentEnvironmentIdSchema,
  originLane: z.string().min(1),
  requestedBy: z.string().min(1),
  budget: EmbodimentBudgetSchema,
  venue: EmbodimentVenueSchema.optional(),
});

const SessionRefStreamSchema = z.object({ sessionId: z.string().min(1) });
const ClaimedDataSchema = z.object({ sessionId: z.string().min(1) });
const RunningDataSchema = z.object({
  sessionId: z.string().min(1),
  resumedFromCheckpointId: z.string().min(1).optional(),
});
const RefusedDataSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.union([EmbodimentRefusalReasonSchema, z.enum(["body_held", "no_runner"])]),
});
const StopRequestedDataSchema = z.object({
  sessionId: z.string().min(1),
  intentId: z.string().min(1),
});
const TerminalDataSchema = z.object({
  sessionId: z.string().min(1),
  outcome: z.enum(["stopped", "budget_exhausted", "failed", "lease_lapsed"]).optional(),
  turnsTaken: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  framesPublished: z.number().int().nonnegative().optional(),
  framesDropped: z.number().int().nonnegative().optional(),
  checkpointId: z.string().min(1).optional(),
  resumedFromCheckpointId: z.string().min(1).optional(),
});

export type EmbodimentReportResult =
  | { readonly outcome: "applied"; readonly session: EmbodimentSession }
  | {
      readonly outcome: "rejected";
      readonly error: "unknown_session" | "illegal_transition";
    };

export type EmbodimentAssignment =
  | { readonly kind: "start"; readonly session: EmbodimentSession }
  | { readonly kind: "stop"; readonly sessionId: string };

/** Private in-process lifecycle update from PlayHost to EmbodimentManager. */
export interface EmbodimentLifecycleUpdate {
  readonly sessionId: string;
  readonly state: "running" | "stopping" | "refused" | "stopped" | "failed";
  readonly resumedFromCheckpointId?: string;
  readonly refusalReason?: EmbodimentRefusalReason;
  readonly receipt?: EmbodimentSessionReceipt;
}

export interface EmbodimentManagerOptions {
  readonly clock: () => Date;
  /**
   * Policy for one intent (`environment.play.start` /
   * `environment.play.stop`). Anything but "allow" refuses `policy`: ambient
   * surfaces cannot carry an approval ceremony, so approval-shaped means no.
   */
  readonly decide: (intent: EmbodimentIntent) => "allow" | "deny" | "require_approval";
  /** Durable append; the manager applies the same event locally after it resolves. */
  readonly emit: (
    type: EmbodimentEventType,
    sessionId: string,
    data: Record<string, unknown>,
  ) => Promise<void>;
  readonly idFactory: () => string;
  /** Starts that never reach the local play host past this window are refused. */
  readonly startWindowMs?: number;
}

const DEFAULT_START_WINDOW_MS = 60_000;

function submittedEventData(
  sessionId: string,
  intent: EmbodimentIntent & { kind: "start" },
): Record<string, unknown> {
  return {
    sessionId,
    intentId: intent.intentId,
    environmentId: intent.environmentId,
    originLane: intent.originLane,
    requestedBy: intent.requestedBy,
    budget: intent.budget,
    ...(intent.venue === undefined ? {} : { venue: intent.venue }),
  };
}

const TERMINAL_STATES: readonly EmbodimentSessionState[] = ["stopped", "refused", "failed"];

export class EmbodimentManager {
  private readonly sessions = new Map<string, EmbodimentSession>();
  private readonly stopRequests = new Map<string, string>();
  private readonly options: Required<Pick<EmbodimentManagerOptions, "startWindowMs">> &
    EmbodimentManagerOptions;
  /** Serializes every mutating entry point; interleaved submits must not double-book the body. */
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(options: EmbodimentManagerOptions) {
    this.options = { startWindowMs: DEFAULT_START_WINDOW_MS, ...options };
  }

  /** Replay hook for startup; also the single live-state application path. */
  public applyEvent(event: EmbodimentEventInput): void {
    switch (event.type) {
      case "embodiment.intent.submitted": {
        const data = SubmittedDataSchema.safeParse(event.data);
        if (!data.success) return;
        const session = EmbodimentSessionSchema.safeParse({
          schemaVersion: 1,
          sessionId: data.data.sessionId,
          environmentId: data.data.environmentId,
          state: "requested",
          intentId: data.data.intentId,
          originLane: data.data.originLane,
          requestedBy: data.data.requestedBy,
          budget: data.data.budget,
          requestedAt: event.occurredAt,
          updatedAt: event.occurredAt,
          ...(data.data.venue === undefined ? {} : { venue: data.data.venue }),
        });
        if (session.success) this.sessions.set(data.data.sessionId, session.data);
        return;
      }
      case "embodiment.session.claimed": {
        const data = ClaimedDataSchema.safeParse(event.data);
        if (!data.success) return;
        this.transition(data.data.sessionId, "claimed", event.occurredAt, {});
        return;
      }
      case "embodiment.session.running": {
        const data = RunningDataSchema.safeParse(event.data);
        if (!data.success) return;
        this.transition(
          data.data.sessionId,
          "running",
          event.occurredAt,
          data.data.resumedFromCheckpointId === undefined
            ? {}
            : { resumedFromCheckpointId: data.data.resumedFromCheckpointId },
        );
        return;
      }
      case "embodiment.session.stop_requested": {
        const data = StopRequestedDataSchema.safeParse(event.data);
        if (!data.success) return;
        const session = this.sessions.get(data.data.sessionId);
        if (session !== undefined && !TERMINAL_STATES.includes(session.state)) {
          this.stopRequests.set(data.data.sessionId, data.data.intentId);
        }
        return;
      }
      case "embodiment.session.stopping": {
        const data = SessionRefStreamSchema.safeParse(event.data);
        if (!data.success) return;
        this.transition(data.data.sessionId, "stopping", event.occurredAt, {});
        return;
      }
      case "embodiment.session.refused": {
        const data = RefusedDataSchema.safeParse(event.data);
        if (!data.success) return;
        // Durable pre-merge events retain their terminal meaning without
        // keeping obsolete refusal names in the public protocol.
        const reason =
          data.data.reason === "body_held"
            ? "play_session_active"
            : data.data.reason === "no_runner"
              ? "environment_unavailable"
              : data.data.reason;
        this.transition(data.data.sessionId, "refused", event.occurredAt, {
          refusalReason: reason,
        });
        this.stopRequests.delete(data.data.sessionId);
        return;
      }
      case "embodiment.session.stopped":
      case "embodiment.session.failed": {
        const data = TerminalDataSchema.safeParse(event.data);
        if (!data.success) return;
        this.transition(
          data.data.sessionId,
          event.type === "embodiment.session.stopped" ? "stopped" : "failed",
          event.occurredAt,
          data.data.checkpointId === undefined ? {} : { checkpointId: data.data.checkpointId },
        );
        this.stopRequests.delete(data.data.sessionId);
        return;
      }
      default:
        return;
    }
  }

  public getSession(sessionId: string): EmbodimentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** The single non-terminal session, if one exists: one body, one driver. */
  public liveSession(): EmbodimentSession | undefined {
    for (const session of this.sessions.values()) {
      if (!TERMINAL_STATES.includes(session.state)) return session;
    }
    return undefined;
  }

  public async submit(intent: EmbodimentIntent): Promise<EmbodimentSubmitResult> {
    return this.serialized(async () => {
      await this.expireStale();
      if (this.options.decide(intent) !== "allow") {
        if (intent.kind === "start") {
          return this.refuseStart(intent, "policy");
        }
        return { outcome: "refused" as const, reason: "policy" as const, sessionId: intent.sessionId };
      }
      if (intent.kind === "stop") {
        const session = this.sessions.get(intent.sessionId);
        if (session === undefined || TERMINAL_STATES.includes(session.state)) {
          return { outcome: "refused" as const, reason: "not_playing" as const, sessionId: intent.sessionId };
        }
        await this.record("embodiment.session.stop_requested", session.sessionId, {
          sessionId: session.sessionId,
          intentId: intent.intentId,
        });
        return { outcome: "stop_requested" as const, session: this.mustGet(session.sessionId) };
      }
      const live = this.liveSession();
      if (live !== undefined) {
        // He is already at these controls: a repeat ask to play the same
        // environment is satisfied, not blocked — the embodiment mirror of
        // ADR 0062's never-rejoin. A different environment, or a session
        // already winding down, stays an honest play_session_active.
        if (
          live.environmentId === intent.environmentId &&
          embodimentVenue(live) === embodimentVenue(intent) &&
          live.state !== "stopping"
        ) {
          return { outcome: "accepted" as const, session: this.mustGet(live.sessionId) };
        }
        return this.refuseStart(intent, "play_session_active");
      }
      const sessionId = this.options.idFactory();
      await this.record("embodiment.intent.submitted", sessionId, submittedEventData(sessionId, intent));
      return { outcome: "accepted" as const, session: this.mustGet(sessionId) };
    });
  }

  public async claim(
    environmentIds: readonly EmbodimentEnvironmentId[],
  ): Promise<EmbodimentAssignment | undefined> {
    return this.serialized(async () => {
      await this.expireStale();
      const live = this.liveSession();
      if (live === undefined) return undefined;
      if (live.state === "requested" && environmentIds.includes(live.environmentId)) {
        await this.record("embodiment.session.claimed", live.sessionId, {
          sessionId: live.sessionId,
        });
        return { kind: "start" as const, session: this.mustGet(live.sessionId) };
      }
      // A pending stop is re-delivered on every local poll until a terminal
      // update lands; stopping twice is idempotent.
      if (this.stopRequests.has(live.sessionId)) {
        return { kind: "stop" as const, sessionId: live.sessionId };
      }
      return undefined;
    });
  }

  public async report(report: EmbodimentLifecycleUpdate): Promise<EmbodimentReportResult> {
    return this.serialized(async () => {
      const session = this.sessions.get(report.sessionId);
      if (session === undefined) return { outcome: "rejected" as const, error: "unknown_session" as const };
      if (!canTransitionEmbodimentSession(session.state, report.state)) {
        return { outcome: "rejected" as const, error: "illegal_transition" as const };
      }
      switch (report.state) {
        case "running":
          await this.record("embodiment.session.running", session.sessionId, {
            sessionId: session.sessionId,
            ...(report.resumedFromCheckpointId === undefined
              ? {}
              : { resumedFromCheckpointId: report.resumedFromCheckpointId }),
          });
          break;
        case "stopping":
          await this.record("embodiment.session.stopping", session.sessionId, {
            sessionId: session.sessionId,
          });
          break;
        case "refused":
          await this.record("embodiment.session.refused", session.sessionId, {
            sessionId: session.sessionId,
            reason: report.refusalReason ?? "environment_unavailable",
          });
          break;
        case "stopped":
        case "failed":
          await this.record(
            report.state === "stopped" ? "embodiment.session.stopped" : "embodiment.session.failed",
            session.sessionId,
            {
              sessionId: session.sessionId,
              ...(report.receipt === undefined
                ? {}
                : {
                    outcome: report.receipt.outcome,
                    turnsTaken: report.receipt.turnsTaken,
                    durationMs: report.receipt.durationMs,
                    framesPublished: report.receipt.framesPublished,
                    framesDropped: report.receipt.framesDropped,
                    ...(report.receipt.checkpointId === undefined
                      ? {}
                      : { checkpointId: report.receipt.checkpointId }),
                    ...(report.receipt.resumedFromCheckpointId === undefined
                      ? {}
                      : { resumedFromCheckpointId: report.receipt.resumedFromCheckpointId }),
                  }),
            },
          );
          break;
      }
      return { outcome: "applied" as const, session: this.mustGet(session.sessionId) };
    });
  }

  private async refuseStart(
    intent: EmbodimentIntent & { kind: "start" },
    reason: EmbodimentRefusalReason,
  ): Promise<EmbodimentSubmitResult> {
    // A refused start still mints a session record: the refusal is queryable
    // product behavior ("another local session is active"), not a dropped request.
    const sessionId = this.options.idFactory();
    await this.record("embodiment.intent.submitted", sessionId, submittedEventData(sessionId, intent));
    await this.record("embodiment.session.refused", sessionId, { sessionId, reason });
    return { outcome: "refused", reason, sessionId };
  }

  /**
   * A requested or claimed start that misses the start window means the local
   * play host could not begin it. Refuse it so a later ask is not blocked by a
   * ghost; PlayHost reconciles already-running sessions after restart.
   */
  private async expireStale(): Promise<void> {
    const now = this.options.clock().getTime();
    for (const session of this.sessions.values()) {
      if (session.state !== "requested" && session.state !== "claimed") continue;
      const since = session.state === "requested" ? session.requestedAt : session.updatedAt;
      if (now - new Date(since).getTime() < this.options.startWindowMs) continue;
      await this.record("embodiment.session.refused", session.sessionId, {
        sessionId: session.sessionId,
        reason: "environment_unavailable",
      });
    }
  }

  private async record(
    type: EmbodimentEventType,
    sessionId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.options.emit(type, sessionId, data);
    this.applyEvent({ type, occurredAt: this.options.clock().toISOString(), data });
  }

  private transition(
    sessionId: string,
    to: EmbodimentSessionState,
    occurredAt: string,
    patch: Partial<EmbodimentSession>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (!canTransitionEmbodimentSession(session.state, to)) return;
    const next = EmbodimentSessionSchema.safeParse({
      ...session,
      ...patch,
      state: to,
      updatedAt: occurredAt,
    });
    if (next.success) this.sessions.set(sessionId, next.data);
  }

  private mustGet(sessionId: string): EmbodimentSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`Embodiment session ${sessionId} vanished mid-update`);
    return session;
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
