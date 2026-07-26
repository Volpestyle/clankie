/**
 * Asked embodiment (ADR 0063): the runner's half of the seam. The host claims
 * play intents from the control plane, owns the free-play session end to end,
 * and reports every lifecycle transition back. It shares a process with the
 * mission worker because they share the trust boundary — the runner is what
 * holds the body and the activity producer credential — but the host never
 * blocks the claim loop: a session runs detached while polling continues, so
 * a stop ask lands while he is mid-playthrough.
 *
 * The execution itself is one injected function, so every lifecycle path is
 * testable offline with the deterministic core double and a fake execution.
 */
import { randomUUID } from "node:crypto";
import type {
  EmbodimentAssignment,
  EmbodimentClaim,
  EmbodimentEnvironmentId,
  EmbodimentLifecycleReport,
  EmbodimentRefusalReason,
  EmbodimentSession,
  EmbodimentSessionOutcome,
  EmbodimentSessionReceipt,
} from "@clankie/protocol";

export interface EmbodimentClientPort {
  claimEmbodiment(claim: EmbodimentClaim): Promise<EmbodimentAssignment | undefined>;
  reportEmbodiment(report: EmbodimentLifecycleReport): Promise<unknown>;
  getLiveEmbodimentSession(): Promise<EmbodimentSession | undefined>;
}

export interface PlayControl {
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

export type PlayExecutionResult =
  | { kind: "refused"; reason: EmbodimentRefusalReason }
  | { kind: "ran"; result: PlayRunResult };

/**
 * One playthrough. Must call `onRunning` exactly once, after the body lock and
 * boot succeed and before the first turn — that is the moment "he is playing"
 * becomes true, and the lineage names the checkpoint he resumed from.
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

export interface PlayHostOptions {
  client: EmbodimentClientPort;
  runnerId: string;
  environmentIds: readonly EmbodimentEnvironmentId[];
  execute: PlayExecution;
  logger: PlayHostLogger;
  clock?: () => Date;
  claimIdFactory?: () => string;
}

export class PlayHost {
  private readonly options: PlayHostOptions;
  private readonly clock: () => Date;
  private readonly claimIdFactory: () => string;
  private active: { sessionId: string; stop: boolean; done: Promise<void> } | undefined;

  public constructor(options: PlayHostOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.claimIdFactory = options.claimIdFactory ?? randomUUID;
  }

  /**
   * A live session attributed to this runner that this process does not hold
   * is a previous process's corpse: the body lock has already self-healed
   * (ADR 0059), and only the runner can say so. Reported as failed with a
   * `lease_lapsed` receipt so the next ask is not blocked by a ghost.
   */
  public async reconcile(): Promise<void> {
    let live: EmbodimentSession | undefined;
    try {
      live = await this.options.client.getLiveEmbodimentSession();
    } catch {
      return;
    }
    if (live === undefined || live.runnerId !== this.options.runnerId) return;
    if (this.active?.sessionId === live.sessionId) return;
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
      assignment = await this.options.client.claimEmbodiment({
        schemaVersion: 1,
        claimId: this.claimIdFactory(),
        runnerId: this.options.runnerId,
        environmentIds: [...this.options.environmentIds],
      });
    } catch {
      return false;
    }
    if (assignment === undefined) return false;
    if (assignment.kind === "stop") {
      if (this.active?.sessionId === assignment.sessionId) {
        this.active.stop = true;
      } else {
        // A stop for a session this process does not hold: the control plane
        // still believes a dead process is playing. Same truth as reconcile.
        await this.reconcile();
      }
      return false;
    }
    if (this.active !== undefined) {
      // One body, one driver — the control plane should never double-assign,
      // but a second start must not silently run beside the first.
      await this.report(assignment.session.sessionId, {
        state: "refused",
        refusalReason: "body_held",
      });
      return false;
    }
    const done = this.runSession(assignment.session);
    this.active = { sessionId: assignment.session.sessionId, stop: false, done };
    return true;
  }

  /** Poll until aborted; an active session keeps polling so stops can land. */
  public async runForever(signal: AbortSignal, pollIntervalMs = 1_000): Promise<void> {
    await this.reconcile();
    while (!signal.aborted) {
      const claimed = await this.poll();
      if (!claimed) await abortableDelay(pollIntervalMs, signal);
    }
    if (this.active !== undefined) {
      this.active.stop = true;
      await this.active.done;
    }
  }

  /** Resolves when the current session (if any) fully settles. Test seam. */
  public async settled(): Promise<void> {
    await this.active?.done;
  }

  private async runSession(session: EmbodimentSession): Promise<void> {
    const startedAt = this.clock().getTime();
    try {
      const result = await this.options.execute(
        session,
        { stopRequested: () => this.active?.stop === true },
        async (resumedFromCheckpointId) => {
          await this.report(session.sessionId, {
            state: "running",
            ...(resumedFromCheckpointId === undefined ? {} : { resumedFromCheckpointId }),
          });
        },
      );
      if (result.kind === "refused") {
        await this.report(session.sessionId, { state: "refused", refusalReason: result.reason });
        return;
      }
      await this.report(session.sessionId, {
        state: result.result.outcome === "failed" ? "failed" : "stopped",
        receipt: this.receipt(session, result.result),
      });
    } catch (error) {
      this.options.logger.error(
        { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
        "embodiment session failed",
      );
      await this.report(session.sessionId, {
        state: "failed",
        receipt: this.receipt(session, {
          outcome: "failed",
          turnsTaken: 0,
          durationMs: this.clock().getTime() - startedAt,
          framesPublished: 0,
          framesDropped: 0,
        }),
      });
    } finally {
      this.active = undefined;
    }
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

  private async report(
    sessionId: string,
    partial:
      | { state: "running"; resumedFromCheckpointId?: string }
      | { state: "refused"; refusalReason: EmbodimentRefusalReason }
      | { state: "stopped" | "failed"; receipt: EmbodimentSessionReceipt },
  ): Promise<void> {
    try {
      await this.options.client.reportEmbodiment({
        schemaVersion: 1,
        sessionId,
        runnerId: this.options.runnerId,
        reportedAt: this.clock().toISOString(),
        ...partial,
      });
    } catch (error) {
      // A lost report must not crash the host; the control plane's stale-claim
      // expiry and the next reconcile are the safety net.
      this.options.logger.warn(
        { sessionId, state: partial.state, errorName: error instanceof Error ? error.name : "Error" },
        "embodiment report failed",
      );
    }
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveDelay();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
