import {
  GbaEmulatorSessionSpecSchema,
  type EnvironmentEvent,
  type GbaEmulatorAction,
  type GbaEmulatorStartActionCommand,
} from "@clankie/interactive-environment";
import { EnvironmentRuntime } from "@clankie/environment-runtime";
import {
  FrozenGbaScenarioSchema,
  GbaScenarioBindingSchema,
  GbaScenarioReportSchema,
  gbaEmulatorGoalEvent,
  type GbaDecisionTrace,
  type GbaEmulatorTrace,
  type GbaScenarioBinding,
  type GbaScenarioReport,
} from "./contracts.ts";
import { GbaEmulatorAdapter } from "./adapter.ts";
import { canonicalJson, sha256 } from "./core-double.ts";
import { driveGbaScenario, type GbaDriverIo } from "./driver.ts";

const ALL_EMULATOR_CAPABILITIES = [
  "emulator.gba.observe",
  "emulator.gba.input",
  "emulator.gba.frame_advance",
  "emulator.gba.wait",
] as const;

const ACTION_LIMITS = { maxInputs: 8, maxFrames: 600, timeoutMs: 5_000 } as const;

export interface RunFrozenGbaScenarioInput {
  rootDir: string;
  scenario: unknown;
  binding: unknown;
  fixtureSha256: string;
  /** Test-only observation tap: wraps the adapter observation stream. */
  wrapIo?: (io: GbaDriverIo) => GbaDriverIo;
}

export interface RunFrozenGbaScenarioResult {
  report: GbaScenarioReport;
  trace: GbaEmulatorTrace;
  decisionTrace: GbaDecisionTrace;
  semanticEvents: EnvironmentEvent[];
  goalEvent: EnvironmentEvent;
}

export async function runFrozenGbaScenario(
  input: RunFrozenGbaScenarioInput,
): Promise<RunFrozenGbaScenarioResult> {
  const scenario = FrozenGbaScenarioSchema.parse(input.scenario);
  const binding = GbaScenarioBindingSchema.parse(input.binding);
  validateFrozenIdentity(scenario, binding, input.fixtureSha256);
  const sessionId = `gba-emulator:${scenario.scenarioId}:v${String(scenario.scenarioVersion)}`;
  const spec = GbaEmulatorSessionSpecSchema.parse({
    schemaVersion: 2,
    sessionId,
    environmentKind: "gba_emulator",
    characterId: scenario.player.characterId,
    worldId: scenario.worldId,
    requestedBy: {
      principal: { kind: "captain", id: scenario.player.characterId },
      tier: "autonomous",
    },
    initialGoalVersion: 1,
    resourceBounds: {
      profile: "gba_emulator",
      coreId: scenario.coreId,
      savestateId: scenario.savestateId,
      savestateSha256: scenario.savestateSha256,
      rngSeed: scenario.rngSeed,
      worldId: scenario.worldId,
      characterId: scenario.player.characterId,
      maxInputsPerAction: ACTION_LIMITS.maxInputs,
      maxFramesPerAction: ACTION_LIMITS.maxFrames,
      maxActionDurationMs: ACTION_LIMITS.timeoutMs,
      capabilities: ALL_EMULATOR_CAPABILITIES,
    },
  });
  const adapter = new GbaEmulatorAdapter(scenario, input.fixtureSha256);
  const semanticEvents: EnvironmentEvent[] = [];
  const runtime = new EnvironmentRuntime({
    rootDir: input.rootDir,
    adapter,
    events: { append: (event) => (semanticEvents.push(event), Promise.resolve()) },
    clock: () => new Date("2026-07-19T00:00:00.000Z"),
    randomToken: () => "runner-private-emulator-grant",
  });
  const grant = await runtime.start({
    spec,
    holderId: "gba-emulator-runner",
    correlationId: `scenario:${scenario.scenarioId}`,
    leaseDurationMs: 60_000,
  });

  let actionSequence = 0;
  const session = adapter.session(sessionId);
  const baseIo: GbaDriverIo = {
    observe: (kind) => session.observe(kind),
    act: async (action: GbaEmulatorAction) => {
      actionSequence += 1;
      const actionId = `scenario-action-${String(actionSequence)}`;
      const command: GbaEmulatorStartActionCommand = {
        schemaVersion: 1,
        commandId: `scenario-command-${String(actionSequence)}`,
        type: "start_action",
        requestedAt: "2026-07-19T00:00:00.000Z",
        context: {
          sourceLane: "gameplay",
          authority: {
            principal: { kind: "captain", id: scenario.player.characterId },
            tier: "autonomous",
          },
          correlationId: `scenario:${scenario.scenarioId}:${String(actionSequence)}`,
          expectedGoalVersion: spec.initialGoalVersion,
        },
        sessionId,
        actionId,
        action: { kind: "gba_emulator_action", action, limits: ACTION_LIMITS },
      };
      return runtime.startAction(grant.token, command);
    },
    pause: async (reason: string) => {
      await runtime.pause(grant.token, sessionId, reason);
    },
  };
  const io = input.wrapIo ? input.wrapIo(baseIo) : baseIo;
  const { halt, decisionTrace } = await driveGbaScenario(io, scenario, input.fixtureSha256);

  const trace = session.trace();
  const traceBytes = `${JSON.stringify(trace, null, 2)}\n`;
  const decisionBytes = `${JSON.stringify(decisionTrace, null, 2)}\n`;
  const runId = `gba-emulator-${input.fixtureSha256.slice(0, 16)}`;
  const final = session.snapshot();
  const finalFrame = session.observe("frame_reference");
  if (finalFrame.kind !== "frame_reference") throw new Error("Expected a frame reference observation");
  const decisions = decisionTrace.decisions;
  const framesStrictlyIncrease = decisions.every(
    (decision, index) => index === 0 || decision.observedFrame > decisions[index - 1]!.observedFrame,
  );
  const stateChangedBetweenDecisions = decisions.every(
    (decision, index) =>
      index === 0 || decision.observedRamStateSha256 !== decisions[index - 1]!.observedRamStateSha256,
  );
  const checks = {
    targetLocationReached:
      final.position.mapId === scenario.targetLocation.mapId &&
      final.position.x === scenario.targetLocation.x &&
      final.position.y === scenario.targetLocation.y,
    trainerBattleEntered: final.battleResult !== "not_started",
    trainerBattleWon: final.battleResult === "won" && halt === "battle_won",
    decisionsStateDerived:
      decisions.length >= scenario.expected.minimumDecisions &&
      framesStrictlyIncrease &&
      stateChangedBetweenDecisions &&
      new Set(decisions.map((decision) => decision.reasonCode)).size >= 3,
    authoritativeStateCertain: final.stateCertain,
    evidenceBounded:
      trace.events.length <= scenario.maxEvidenceEvents && decisions.length <= scenario.maxDecisions,
    inputsWithinBounds:
      final.inputCount === trace.events.filter((event) => event.actionKind === "button_press").length &&
      final.inputCount <= scenario.maxDecisions * ACTION_LIMITS.maxInputs,
  };
  const report = GbaScenarioReportSchema.parse({
    schemaVersion: 1,
    scenarioId: scenario.scenarioId,
    scenarioVersion: scenario.scenarioVersion,
    fixtureSha256: input.fixtureSha256,
    runId,
    result: Object.values(checks).every(Boolean) ? "passed" : "failed",
    halt,
    checks,
    finalState: {
      position: final.position,
      battleId: final.battleId,
      battleResult: final.battleResult,
      turn: final.turn,
      activePartySlot: final.activePartySlot,
      activePartyHp: final.activePartyHp,
      opponentHp: final.opponentHp,
      frame: final.frame,
      inputCount: final.inputCount,
    },
    evidence: {
      eventCount: trace.events.length,
      decisionCount: decisions.length,
      eventChainHeadSha256: trace.eventChainHeadSha256,
      decisionTraceSha256: sha256(decisionBytes),
      finalRamStateSha256: final.ramStateSha256,
    },
    artifacts: [
      {
        kind: "event_trace",
        artifactId: `${runId}:event-trace`,
        uri: `artifact://gba-emulator/${runId}/events.json`,
        sha256: sha256(traceBytes),
        summary: "Bounded emulator-authoritative action trace",
      },
      {
        kind: "decision_trace",
        artifactId: `${runId}:decision-trace`,
        uri: `artifact://gba-emulator/${runId}/decisions.json`,
        sha256: sha256(decisionBytes),
        summary: "State-derived driver decision trace",
      },
      {
        kind: "frame",
        artifactId: finalFrame.data.artifactId,
        uri: finalFrame.data.uri,
        sha256: finalFrame.data.framebufferSha256,
        summary: "Bounded final framebuffer reference",
      },
    ],
  });
  const goalEvent = gbaEmulatorGoalEvent(
    report,
    {
      ...binding,
      environment: { ...binding.environment, environmentSessionId: sessionId },
    },
    "2026-07-19T00:01:00.000Z",
  );
  semanticEvents.push(goalEvent);
  if (
    JSON.stringify({ report, trace, decisionTrace, semanticEvents }).includes("runner-private-emulator-grant")
  ) {
    throw new Error("Runner-private grant escaped into scenario evidence");
  }
  return { report, trace, decisionTrace, semanticEvents, goalEvent };
}

function validateFrozenIdentity(
  scenario: ReturnType<typeof FrozenGbaScenarioSchema.parse>,
  binding: GbaScenarioBinding,
  fixtureSha256: string,
): void {
  if (
    binding.scenarioId !== scenario.scenarioId ||
    binding.scenarioVersion !== scenario.scenarioVersion ||
    binding.fixtureSha256 !== fixtureSha256 ||
    binding.environment.worldId !== scenario.worldId ||
    binding.environment.characterId !== scenario.player.characterId
  ) {
    throw new Error("Frozen GBA scenario identity does not match its binding");
  }
  if (sha256(canonicalJson(scenario)).length !== 64) throw new Error("Scenario canonical hash failed");
}
