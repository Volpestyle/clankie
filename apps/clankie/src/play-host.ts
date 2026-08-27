/**
 * Asked embodiment (ADR 0063): the executing half of the seam. The host claims
 * play intents from the embodiment seam, owns the free-play session end to
 * end, and reports every lifecycle transition back. The host never blocks the
 * claim loop: a session runs detached while polling continues, so a stop ask
 * lands while he is mid-playthrough.
 *
 * The execution itself is one injected function, so every lifecycle path is
 * testable offline with the deterministic core double and a fake execution.
 */
import { setTimeout as delay } from "node:timers/promises";
import type {
  EmbodimentEnvironmentId,
  EmbodimentRefusalReason,
  EmbodimentSession,
  EmbodimentSessionOutcome,
  EmbodimentSessionReceipt,
} from "@clankie/protocol";
import type { EmbodimentAssignment, EmbodimentLifecycleUpdate } from "./embodiment.ts";

export type { EmbodimentAssignment, EmbodimentLifecycleUpdate } from "./embodiment.ts";

type EmbodimentLifecycleTransition =
  | { state: "running"; resumedFromCheckpointId?: string }
  | { state: "stopping" }
  | { state: "refused"; refusalReason: EmbodimentRefusalReason }
  | { state: "stopped" | "failed"; receipt: EmbodimentSessionReceipt };

export interface EmbodimentClientPort {
  claimEmbodiment(
    environmentIds: readonly EmbodimentEnvironmentId[],
  ): Promise<EmbodimentAssignment | undefined>;
  reportEmbodiment(report: EmbodimentLifecycleUpdate): Promise<unknown>;
  getLiveEmbodimentSession(): Promise<EmbodimentSession | undefined>;
}

interface PlayControl {
  /** True once a stop ask (or shutdown) wants the playthrough to end. */
  stopRequested(): boolean;
}

/** What one executed playthrough reports back, content-free by construction. */
export interface PlayRunResult {
  outcome: EmbodimentSessionOutcome;
  turnsTaken: number;
  durationMs: number;
  framesPublished: number;
  framesDropped: number;
  checkpointId?: string;
  resumedFromCheckpointId?: string;
}

type PlayExecutionResult =
  | { kind: "refused"; reason: EmbodimentRefusalReason }
  | { kind: "ran"; result: PlayRunResult };

/**
 * One playthrough. Must call `onRunning` exactly once, after boot succeeds and
 * before the first turn — that is the moment "he is playing" becomes true, and
 * the lineage names the checkpoint he resumed from.
 */
export type PlayExecution = (
  session: EmbodimentSession,
  control: PlayControl,
  onRunning: (resumedFromCheckpointId?: string) => Promise<void>,
) => Promise<PlayExecutionResult>;

interface PlayHostLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

type ActivePlay = {
  session: Pick<EmbodimentSession, "sessionId" | "environmentId">;
  stop: boolean;
  stoppingReported: boolean;
  runningReported: boolean;
  deadlineExpired: boolean;
  startedAt: number;
  done: Promise<void>;
};

export type PlayShutdownResult =
  | { status: "idle" }
  | { status: "settled"; sessionId: string }
  | { status: "deadline_expired"; sessionId: string };

export interface PlayHostOptions {
  client: EmbodimentClientPort;
  environmentIds: readonly EmbodimentEnvironmentId[];
  execute: PlayExecution;
  logger: PlayHostLogger;
  clock?: () => Date;
  /** Best-effort grace for the forced terminal report after a shutdown deadline. */
  forcedReportGraceMs?: number;
}

export class PlayHost {
  private readonly options: PlayHostOptions;
  private readonly clock: () => Date;
  private readonly forcedReportGraceMs: number;
  private active: ActivePlay | undefined;
  /** Last logged claim-failure signature; undefined while the poll is healthy. */
  private claimFailure: string | undefined;

  public constructor(options: PlayHostOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.forcedReportGraceMs = options.forcedReportGraceMs ?? 1_000;
  }

  /**
   * A live session this process does not hold is a previous service process's
   * corpse. Report it failed so the next ask is not blocked by a ghost.
   */
  public async reconcile(): Promise<void> {
    let live: EmbodimentSession | undefined;
    try {
      live = await this.options.client.getLiveEmbodimentSession();
    } catch {
      return;
    }
    if (live === undefined) return;
    if (this.active?.session.sessionId === live.sessionId) return;
    if (live.state !== "claimed" && live.state !== "running" && live.state !== "stopping") return;
    this.options.logger.warn(
      { sessionId: live.sessionId, state: live.state },
      "embodiment session from a previous process reported failed",
    );
    if (live.state === "claimed") {
      // A claim that never ran refuses rather than failing: nothing started.
      await this.report(live.sessionId, { state: "refused", refusalReason: "environment_unavailable" });
      return;
    }
    await this.report(live.sessionId, {
      state: "failed",
      receipt: this.receipt(live, {
        outcome: "lease_lapsed",
        turnsTaken: 0,
        durationMs: 0,
        framesPublished: 0,
        framesDropped: 0,
      }),
    });
  }

  /** One poll. Returns true when it claimed new work. */
  public async poll(): Promise<boolean> {
    let assignment: EmbodimentAssignment | undefined;
    try {
      assignment = await this.options.client.claimEmbodiment(this.options.environmentIds);
    } catch (error) {
      // Deduplicated by signature, not swallowed: on a 1s cadence a per-poll
      // line is spam, but a fully silent catch spent a live evening looking
      // exactly like "no work" while every claim was failing.
      const signature = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (this.claimFailure !== signature) {
        this.claimFailure = signature;
        this.options.logger.error({ err: signature }, "embodiment claim poll failing");
      }
      return false;
    }
    if (this.claimFailure !== undefined) {
      this.claimFailure = undefined;
      this.options.logger.info({}, "embodiment claim poll recovered");
    }
    if (assignment === undefined) return false;
    if (assignment.kind === "stop") {
      if (!(await this.requestStop(assignment.sessionId, "claim"))) {
        // A stop for a session this process does not hold: the embodiment seam
        // still believes a dead process is playing. Same truth as reconcile.
        await this.reconcile();
      }
      return false;
    }
    if (this.active !== undefined) {
      // One body, one driver — the embodiment seam should never double-assign,
      // but a second start must not silently run beside the first.
      await this.report(assignment.session.sessionId, {
        state: "refused",
        refusalReason: "play_session_active",
      });
      return false;
    }
    // The whole lifecycle narrates into this log (ADR 0068): before these
    // lines existed, a session that claimed, ran, and settled cleanly left the
    // service log silent — the successful path was the invisible one.
    this.options.logger.info(
      {
        sessionId: assignment.session.sessionId,
        environmentId: assignment.session.environmentId,
        originLane: assignment.session.originLane,
        requestedBy: assignment.session.requestedBy,
      },
      "embodiment session claimed",
    );
    const active: ActivePlay = {
      session: {
        sessionId: assignment.session.sessionId,
        environmentId: assignment.session.environmentId,
      },
      stop: false,
      stoppingReported: false,
      runningReported: false,
      deadlineExpired: false,
      startedAt: this.clock().getTime(),
      done: Promise.resolve(),
    };
    this.active = active;
    active.done = this.runSession(active, assignment.session);
    return true;
  }

  /** Poll until aborted; an active session keeps polling so stops can land. */
  public async runForever(signal: AbortSignal, pollIntervalMs = 1_000): Promise<void> {
    await this.reconcile();
    while (!signal.aborted) {
      const claimed = await this.poll();
      if (!claimed) await abortableDelay(pollIntervalMs, signal);
    }
    if (this.active !== undefined) await this.stopAndWait({ reason: "shutdown" });
  }

  /**
   * Ask the active playthrough to stop at the next turn boundary. Once it has
   * reached `running`, also publish `stopping` so operator state reflects that
   * the process is draining rather than still freely playing.
   */
  public async requestStop(sessionId?: string, reason = "operator"): Promise<boolean> {
    const active = this.active;
    if (active === undefined) return false;
    if (sessionId !== undefined && active.session.sessionId !== sessionId) return false;
    this.markStop(active, reason);
    await this.reportStopping(active);
    return true;
  }

  private markStop(active: ActivePlay, reason: string): void {
    const wasAlreadyStopping = active.stop;
    active.stop = true;
    if (!wasAlreadyStopping) {
      this.options.logger.info(
        { sessionId: active.session.sessionId, reason },
        "embodiment stop received; ends at the next turn boundary",
      );
    }
  }

  /**
   * Request stop and wait for settlement, optionally bounded. If the deadline
   * expires, publish an explicit failed terminal state; a late clean settlement
   * is ignored so it cannot overwrite the truth that shutdown forced exit.
   */
  public async stopAndWait(
    options: { deadlineMs?: number; reason?: string } = {},
  ): Promise<PlayShutdownResult> {
    const active = this.active;
    if (active === undefined) return { status: "idle" };
    const reason = options.reason ?? "shutdown";
    this.markStop(active, reason);
    if (options.deadlineMs === undefined) {
      await this.reportStopping(active);
      await active.done;
      return { status: "settled", sessionId: active.session.sessionId };
    }

    // The stopping report is inside the deadline. A wedged report
    // request must not defeat the process-level shutdown bound.
    const deadlineAt = Date.now() + options.deadlineMs;
    const stoppingReported = await settlesWithin(
      this.reportStopping(active),
      remainingMilliseconds(deadlineAt),
    );
    if (stoppingReported && (await settlesWithin(active.done, remainingMilliseconds(deadlineAt)))) {
      return { status: "settled", sessionId: active.session.sessionId };
    }
    active.deadlineExpired = true;
    this.options.logger.error(
      {
        sessionId: active.session.sessionId,
        deadlineMs: options.deadlineMs,
        reason,
      },
      "embodiment shutdown deadline expired",
    );
    const forcedReportSettled = await settlesWithin(
      this.report(active.session.sessionId, {
        state: "failed",
        receipt: this.receipt(active.session, {
          outcome: "failed",
          turnsTaken: 0,
          durationMs: this.clock().getTime() - active.startedAt,
          framesPublished: 0,
          framesDropped: 0,
        }),
      }),
      this.forcedReportGraceMs,
    );
    if (!forcedReportSettled) {
      this.options.logger.warn(
        { sessionId: active.session.sessionId, graceMs: this.forcedReportGraceMs },
        "forced embodiment failure report exceeded shutdown grace",
      );
    }
    return { status: "deadline_expired", sessionId: active.session.sessionId };
  }

  /** Resolves when the current session (if any) fully settles. Test seam. */
  public async settled(): Promise<void> {
    await this.active?.done;
  }

  private async runSession(active: ActivePlay, session: EmbodimentSession): Promise<void> {
    try {
      const result = await this.options.execute(
        session,
        { stopRequested: () => active.stop },
        async (resumedFromCheckpointId) => {
          this.options.logger.info(
            {
              sessionId: session.sessionId,
              ...(resumedFromCheckpointId === undefined ? {} : { resumedFromCheckpointId }),
            },
            "embodiment session running",
          );
          await this.report(session.sessionId, {
            state: "running",
            ...(resumedFromCheckpointId === undefined ? {} : { resumedFromCheckpointId }),
          });
          active.runningReported = true;
          if (active.stop) await this.reportStopping(active);
        },
      );
      if (active.deadlineExpired) {
        this.options.logger.warn(
          { sessionId: session.sessionId },
          "embodiment session settled after shutdown deadline; forced failure already reported",
        );
        return;
      }
      if (result.kind === "refused") {
        this.options.logger.info(
          { sessionId: session.sessionId, refusalReason: result.reason },
          "embodiment session refused",
        );
        await this.report(session.sessionId, { state: "refused", refusalReason: result.reason });
        return;
      }
      this.options.logger.info(
        {
          sessionId: session.sessionId,
          outcome: result.result.outcome,
          turnsTaken: result.result.turnsTaken,
          durationMs: result.result.durationMs,
          framesPublished: result.result.framesPublished,
          framesDropped: result.result.framesDropped,
          ...(result.result.checkpointId === undefined ? {} : { checkpointId: result.result.checkpointId }),
        },
        "embodiment session settled",
      );
      await this.report(session.sessionId, {
        state: result.result.outcome === "failed" ? "failed" : "stopped",
        receipt: this.receipt(session, result.result),
      });
    } catch (error) {
      this.options.logger.error(
        { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
        "embodiment session failed",
      );
      if (active.deadlineExpired) return;
      await this.report(session.sessionId, {
        state: "failed",
        receipt: this.receipt(session, {
          outcome: "failed",
          turnsTaken: 0,
          durationMs: this.clock().getTime() - active.startedAt,
          framesPublished: 0,
          framesDropped: 0,
        }),
      });
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  private async reportStopping(active: ActivePlay): Promise<void> {
    if (!active.runningReported || active.stoppingReported) return;
    active.stoppingReported = true;
    await this.report(active.session.sessionId, { state: "stopping" });
  }

  private receipt(
    session: Pick<EmbodimentSession, "sessionId" | "environmentId">,
    result: PlayRunResult,
  ): EmbodimentSessionReceipt {
    return {
      schemaVersion: 1,
      sessionId: session.sessionId,
      environmentId: session.environmentId,
      outcome: result.outcome,
      turnsTaken: result.turnsTaken,
      durationMs: result.durationMs,
      framesPublished: result.framesPublished,
      framesDropped: result.framesDropped,
      ...(result.checkpointId === undefined ? {} : { checkpointId: result.checkpointId }),
      ...(result.resumedFromCheckpointId === undefined
        ? {}
        : { resumedFromCheckpointId: result.resumedFromCheckpointId }),
    };
  }

  private async report(sessionId: string, partial: EmbodimentLifecycleTransition): Promise<void> {
    try {
      await this.options.client.reportEmbodiment({
        sessionId,
        ...partial,
      });
    } catch (error) {
      // A lost report must not crash the host; the embodiment seam's
      // stale-claim expiry and the next reconcile are the safety net.
      this.options.logger.warn(
        { sessionId, state: partial.state, errorName: error instanceof Error ? error.name : "Error" },
        "embodiment report failed",
      );
    }
  }
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise.then(() => true),
      delay(milliseconds, false, { signal: controller.signal }),
    ]);
  } finally {
    controller.abort();
  }
}

function remainingMilliseconds(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  }
}
