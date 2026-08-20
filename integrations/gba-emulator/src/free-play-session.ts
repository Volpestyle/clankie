import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  GBA_EMULATOR_LOCAL_CAPABILITIES,
  GbaEmulatorSessionSpecSchema,
  type EnvironmentEvent,
  type GbaEmulatorAction,
  type GbaEmulatorStartActionCommand,
} from "@clankie/interactive-environment";
import { EnvironmentLeaseExpiredError, EnvironmentRuntime } from "@clankie/environment-runtime";
import { GbaEmulatorAdapter } from "./adapter.ts";
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
 *
 * Sized for the composite actions, not the single press: the action schema
 * allows `repeat` up to 16, `walk_to` spends an input per step, and
 * `advance_dialog` spends one per box — a whole rival monologue or a
 * lab-length walk should fit in one decision. 8 was small enough that a
 * legal-looking `repeat: 14` was rejected whole, and the driver was left
 * inventing wrong explanations for a budget it was never told about.
 *
 * `timeoutMs` stays tight so a stalled core is bounded by the runtime.
 */
export const FREE_PLAY_ACTION_LIMITS = { maxInputs: 64, maxFrames: 1_800, timeoutMs: 5_000 } as const;

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
   * Names this run inside the session id. Defaults to a start-stamped unique
   * id so two playthroughs of the same scenario are two records, not one file
   * the newer run overwrites. Supply it to make tests deterministic.
   */
  runId?: string;
  /** Runtime identity; defaults to the scenario's player without altering scenario digests. */
  characterId?: string;
  /** Lease holder label for this invocation. */
  holderId?: string;
}

export interface FreePlaySession {
  io: GbaDriverIo;
  /** Revokes the runtime and removes this invocation's operational state. */
  close: () => Promise<void>;
  sessionId: string;
  events: EnvironmentEvent[];
  /** Clear adapter facts inferred from the timeline after an external state restore. */
  resetAfterStateLoad: () => void;
}

export async function createFreePlaySession(input: FreePlaySessionInput): Promise<FreePlaySession> {
  const characterId = input.characterId ?? input.scenario.player.characterId;
  // Free play is open-ended, so evidence rolls: a marathon session must never
  // die at a receipt-sized cap. The deterministic scenario drivers keep the
  // frozen policy, where exceeding the budget is invalid evidence.
  const adapter =
    input.coreFactory === undefined
      ? new GbaEmulatorAdapter(input.scenario as never, input.fixtureSha256, undefined, {
          evidencePolicy: "rolling",
          characterId,
        })
      : new GbaEmulatorAdapter(input.scenario, input.fixtureSha256, input.coreFactory, {
          evidencePolicy: "rolling",
          characterId,
        });
  const clock = input.clock ?? (() => new Date());
  // Per-run identity: the scenario names the world, the run stamp names the
  // playthrough. A stable id meant every new run reused one record file and
  // silently destroyed the previous run's action history.
  const runId = input.runId ?? `${clock().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const sessionId = `gba-free-play:${input.scenario.scenarioId}:v${String(input.scenario.scenarioVersion)}:${runId}`;
  const spec = GbaEmulatorSessionSpecSchema.parse({
    schemaVersion: 2,
    sessionId,
    environmentKind: "gba_emulator",
    characterId,
    worldId: input.scenario.worldId,
    requestedBy: {
      principal: { kind: "captain", id: characterId },
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
      characterId,
      maxInputsPerAction: FREE_PLAY_ACTION_LIMITS.maxInputs,
      maxFramesPerAction: FREE_PLAY_ACTION_LIMITS.maxFrames,
      maxActionDurationMs: FREE_PLAY_ACTION_LIMITS.timeoutMs,
      capabilities: GBA_EMULATOR_LOCAL_CAPABILITIES,
    },
  });

  const events: EnvironmentEvent[] = [];
  await mkdir(input.rootDir, { recursive: true });
  const runtimeRoot = await mkdtemp(path.join(input.rootDir, "runtime-"));
  const runtime = new EnvironmentRuntime({
    rootDir: runtimeRoot,
    adapter,
    events: {
      append: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    },
    clock,
    // Open-ended play needs bounded operational state: the record is rewritten
    // whole on every persist, so an uncapped marathon pays O(n²) writes, and
    // per-run ids would otherwise grow the records directory forever. The full
    // history lives in the play journal, not here.
    retention: { maxActionRecords: 128, maxEndedSessionRecords: 16 },
  });
  let grant;
  try {
    grant = await runtime.start({
      spec,
      holderId: input.holderId ?? "gba-free-play",
      correlationId: `free-play:${input.scenario.scenarioId}`,
      // Five minutes is the runtime's cap, and every dispatched action renews
      // it — the lease bounds how long an *idle* holder keeps the claim, never
      // playthrough length. A lapse pauses the body and `withLease` below
      // re-acquires it, so thinking between moves is survivable.
      leaseDurationMs: 300_000,
    });
  } catch (error) {
    await rm(runtimeRoot, { recursive: true, force: true });
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
  let closePromise: Promise<void> | undefined;
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
            principal: { kind: "captain", id: characterId },
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
    resetAfterStateLoad: () => session.resetAfterStateLoad(),
    close: () =>
      (closePromise ??= (async () => {
        try {
          await runtime.emergencyStop(sessionId, "free-play session closed");
        } finally {
          await rm(runtimeRoot, { recursive: true, force: true });
        }
      })()),
  };
}
