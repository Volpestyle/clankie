import {
  GbaEmulatorSessionSpecSchema,
  type EnvironmentEvent,
  type GbaEmulatorAction,
  type GbaEmulatorStartActionCommand,
} from "@clankie/interactive-environment";
import { EnvironmentLeaseExpiredError, EnvironmentRuntime } from "@clankie/environment-runtime";
import { GbaEmulatorAdapter } from "./adapter.ts";
import { acquireBodyLock, type BodyLock } from "./body-lock.ts";
import type { GbaAdapterScenario, GbaCoreFactory } from "./core-seam.ts";
import type { GbaDriverIo } from "./driver.ts";

/**
 * Compose a free-play session: adapter behind the durable environment runtime,
 * with a lease, exactly like the deterministic scenarios.
 *
 * Free play changes who decides, not how actions are dispatched. Routing them
 * through the runtime keeps register-before-dispatch idempotency, the lease,
 * pause/cancel, and emergency-stop fencing — so a model that asks for something
 * illegal is refused by the same machinery that refuses a script.
 */
/**
 * Exported so tool surfaces can advertise the real budget: a schema that
 * promises more than the lease allows teaches a driver to distrust both.
 */
export const FREE_PLAY_ACTION_LIMITS = { maxInputs: 8, maxFrames: 600, timeoutMs: 5_000 } as const;

const ALL_EMULATOR_CAPABILITIES = [
  "emulator.gba.observe",
  "emulator.gba.input",
  "emulator.gba.frame_advance",
  "emulator.gba.wait",
] as const;

export interface FreePlaySessionInput {
  rootDir: string;
  /** A frozen double scenario, or a real ROM-gated route scenario. */
  scenario: GbaAdapterScenario;
  fixtureSha256: string;
  /**
   * Supply the real pinned mGBA core to play an actual ROM. Omitted, the
   * adapter falls back to its clearly-labeled deterministic double, so the loop
   * is runnable without copyrighted bytes.
   */
  coreFactory?: GbaCoreFactory;
  clock?: () => Date;
  /**
   * Names the process in a contended-body error. Defaults to the scenario, but
   * an entrypoint should say what it is ("gba-mcp", "free-play-live") so the
   * refusal tells you which process to stop.
   */
  holderId?: string;
  /**
   * Take the exclusive body lock at construction. True for a loop that starts
   * driving immediately; **false** for a server that only observes until
   * someone possesses it.
   *
   * An MCP server must pass false. Clients start stdio servers freely — `claude
   * mcp list`, every session, every retry — so a lock taken at process start
   * means the first server wins and every later one dies with `BodyBusyError`.
   * That is not contention over the body, it is contention over *existing*, and
   * observation is not driving (ADR 0053).
   */
  acquireBody?: boolean;
}

export interface FreePlaySession {
  io: GbaDriverIo;
  /** Releases the cross-process body lock. Always call it. */
  close: () => void;
  sessionId: string;
  events: EnvironmentEvent[];
}

export async function createFreePlaySession(input: FreePlaySessionInput): Promise<FreePlaySession> {
  // Free play is open-ended, so evidence rolls: a marathon session must never
  // die at a receipt-sized cap. The deterministic scenario drivers keep the
  // frozen policy, where exceeding the budget is invalid evidence.
  const adapter =
    input.coreFactory === undefined
      ? new GbaEmulatorAdapter(input.scenario as never, input.fixtureSha256, undefined, {
          evidencePolicy: "rolling",
        })
      : new GbaEmulatorAdapter(input.scenario, input.fixtureSha256, input.coreFactory, {
          evidencePolicy: "rolling",
        });
  const sessionId = `gba-free-play:${input.scenario.scenarioId}:v${String(input.scenario.scenarioVersion)}`;
  const spec = GbaEmulatorSessionSpecSchema.parse({
    schemaVersion: 2,
    sessionId,
    environmentKind: "gba_emulator",
    characterId: input.scenario.player.characterId,
    worldId: input.scenario.worldId,
    requestedBy: {
      principal: { kind: "captain", id: input.scenario.player.characterId },
      tier: "autonomous",
    },
    initialGoalVersion: 1,
    resourceBounds: {
      profile: "gba_emulator",
      coreId: input.scenario.coreId,
      savestateId: input.scenario.savestateId,
      savestateSha256: input.scenario.savestateSha256,
      rngSeed: input.scenario.rngSeed,
      worldId: input.scenario.worldId,
      characterId: input.scenario.player.characterId,
      maxInputsPerAction: FREE_PLAY_ACTION_LIMITS.maxInputs,
      maxFramesPerAction: FREE_PLAY_ACTION_LIMITS.maxFrames,
      maxActionDurationMs: FREE_PLAY_ACTION_LIMITS.timeoutMs,
      capabilities: ALL_EMULATOR_CAPABILITIES,
    },
  });

  const events: EnvironmentEvent[] = [];
  const clock = input.clock ?? (() => new Date());
  const runtime = new EnvironmentRuntime({
    rootDir: input.rootDir,
    adapter,
    events: {
      append: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    },
    clock,
  });
  // Before anything drives the core: one writer per body, across processes.
  const lock: BodyLock | null =
    input.acquireBody === false
      ? null
      : acquireBodyLock({
          rootDir: input.rootDir,
          holderId: input.holderId ?? `gba-free-play:${input.scenario.scenarioId}`,
        });

  let grant;
  try {
    grant = await runtime.start({
      spec,
      holderId: "gba-free-play",
      correlationId: `free-play:${input.scenario.scenarioId}`,
      // Five minutes is the runtime's cap, and every dispatched action renews
      // it — the lease bounds how long an *idle* holder keeps the claim, never
      // playthrough length. A lapse pauses the body and `withLease` below
      // re-acquires it, so thinking between moves is survivable.
      leaseDurationMs: 300_000,
    });
  } catch (error) {
    lock?.release();
    throw error;
  }

  // A mind thinks between moves, and thinking can outlive the lease. A lapse
  // only paused the body, so re-acquire the claim and retry once. `renew` is
  // fail-closed where it matters: it refuses when the session was revoked or
  // another writer took the body, so this can never resurrect a fenced session.
  const withLease = async <T>(dispatch: () => Promise<T>): Promise<T> => {
    try {
      return await dispatch();
    } catch (error) {
      if (!(error instanceof EnvironmentLeaseExpiredError)) throw error;
      await runtime.renew(grant.token, sessionId);
      return dispatch();
    }
  };

  const session = adapter.session(sessionId);
  let sequence = 0;
  const io: GbaDriverIo = {
    observe: (kind) => session.observe(kind),
    act: async (action: GbaEmulatorAction) => {
      sequence += 1;
      const command: GbaEmulatorStartActionCommand = {
        schemaVersion: 1,
        commandId: `free-play-command-${String(sequence)}`,
        type: "start_action",
        requestedAt: clock().toISOString(),
        context: {
          sourceLane: "gameplay",
          authority: {
            principal: { kind: "captain", id: input.scenario.player.characterId },
            tier: "autonomous",
          },
          correlationId: `free-play:${input.scenario.scenarioId}:${String(sequence)}`,
          expectedGoalVersion: spec.initialGoalVersion,
        },
        sessionId,
        actionId: `free-play-action-${String(sequence)}`,
        action: { kind: "gba_emulator_action", action, limits: FREE_PLAY_ACTION_LIMITS },
      };
      return withLease(() => runtime.startAction(grant.token, command));
    },
    pause: async (reason: string) => {
      await withLease(() => runtime.pause(grant.token, sessionId, reason));
    },
    resume: async () => {
      await withLease(() => runtime.resume(grant.token, sessionId));
    },
  };

  return {
    io,
    sessionId,
    events,
    close: () => {
      lock?.release();
    },
  };
}
