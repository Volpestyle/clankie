import {
  GbaEmulatorSessionSpecSchema,
  type EnvironmentEvent,
  type GbaEmulatorAction,
  type GbaEmulatorStartActionCommand,
} from "@clankie/interactive-environment";
import { EnvironmentRuntime } from "@clankie/environment-runtime";
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
const ACTION_LIMITS = { maxInputs: 8, maxFrames: 600, timeoutMs: 5_000 } as const;

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
}

export interface FreePlaySession {
  io: GbaDriverIo;
  sessionId: string;
  events: EnvironmentEvent[];
}

export async function createFreePlaySession(input: FreePlaySessionInput): Promise<FreePlaySession> {
  const adapter =
    input.coreFactory === undefined
      ? new GbaEmulatorAdapter(input.scenario as never, input.fixtureSha256)
      : new GbaEmulatorAdapter(input.scenario, input.fixtureSha256, input.coreFactory);
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
      maxInputsPerAction: ACTION_LIMITS.maxInputs,
      maxFramesPerAction: ACTION_LIMITS.maxFrames,
      maxActionDurationMs: ACTION_LIMITS.timeoutMs,
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
  const grant = await runtime.start({
    spec,
    holderId: "gba-free-play",
    correlationId: `free-play:${input.scenario.scenarioId}`,
    // The runtime caps a lease at 5 minutes. A long playthrough outliving it is
    // a real constraint for M2/M4, not something to paper over here.
    leaseDurationMs: 300_000,
  });

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
        action: { kind: "gba_emulator_action", action, limits: ACTION_LIMITS },
      };
      return runtime.startAction(grant.token, command);
    },
    pause: async (reason: string) => {
      await runtime.pause(grant.token, sessionId, reason);
    },
  };

  return { io, sessionId, events };
}
