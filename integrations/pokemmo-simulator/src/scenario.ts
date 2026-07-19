import {
  PokeMMOSimulatorSessionSpecSchema,
  type EnvironmentEvent,
  type PokeMMOSimulatorAction,
  type PokeMMOStartActionCommand,
} from "@clankie/interactive-environment";
import { EnvironmentRuntime } from "@clankie/environment-runtime";
import {
  FrozenPokeMMOScenarioSchema,
  PokeMMOScenarioBindingSchema,
  PokeMMOScenarioReportSchema,
  pokemmoSimulatorGoalEvent,
  type PokeMMOScenarioBinding,
  type PokeMMOScenarioReport,
  type PokeMMOSimulatorTrace,
} from "./contracts.ts";
import { PokeMMOSimulatorAdapter, canonicalJson, sha256 } from "./simulator.ts";

const ALL_SIMULATOR_CAPABILITIES = [
  "pokemmo.simulator.observe",
  "pokemmo.simulator.navigate",
  "pokemmo.simulator.interact",
  "pokemmo.simulator.menu",
  "pokemmo.simulator.battle",
  "pokemmo.simulator.party",
  "pokemmo.simulator.inventory",
  "pokemmo.simulator.wait",
] as const;

export interface RunFrozenPokeMMOScenarioInput {
  rootDir: string;
  scenario: unknown;
  binding: unknown;
  fixtureSha256: string;
}

export interface RunFrozenPokeMMOScenarioResult {
  report: PokeMMOScenarioReport;
  trace: PokeMMOSimulatorTrace;
  semanticEvents: EnvironmentEvent[];
  goalEvent: EnvironmentEvent;
}

export async function runFrozenPokeMMOScenario(
  input: RunFrozenPokeMMOScenarioInput,
): Promise<RunFrozenPokeMMOScenarioResult> {
  const scenario = FrozenPokeMMOScenarioSchema.parse(input.scenario);
  const binding = PokeMMOScenarioBindingSchema.parse(input.binding);
  validateFrozenIdentity(scenario, binding, input.fixtureSha256);
  const sessionId = `pokemmo-sim:${scenario.scenarioId}:v${String(scenario.scenarioVersion)}`;
  const spec = PokeMMOSimulatorSessionSpecSchema.parse({
    schemaVersion: 2,
    sessionId,
    environmentKind: "pokemmo_simulator",
    characterId: scenario.player.characterId,
    worldId: scenario.worldId,
    requestedBy: {
      principal: { kind: "captain", id: scenario.player.characterId },
      tier: "autonomous",
    },
    initialGoalVersion: 1,
    resourceBounds: {
      profile: "pokemmo_simulator",
      simulatorId: scenario.simulatorId,
      worldId: scenario.worldId,
      characterId: scenario.player.characterId,
      allowedMapIds: [scenario.map.mapId],
      maxNavigationStepsPerAction: 64,
      maxMenuChoicesPerAction: 8,
      maxBattleTurnsPerAction: 16,
      maxActionDurationMs: 5_000,
      capabilities: ALL_SIMULATOR_CAPABILITIES,
    },
  });
  const adapter = new PokeMMOSimulatorAdapter(scenario, input.fixtureSha256);
  const semanticEvents: EnvironmentEvent[] = [];
  const runtime = new EnvironmentRuntime({
    rootDir: input.rootDir,
    adapter,
    events: { append: (event) => (semanticEvents.push(event), Promise.resolve()) },
    clock: () => new Date("2026-07-19T00:00:00.000Z"),
    randomToken: () => "runner-private-simulator-grant",
  });
  const grant = await runtime.start({
    spec,
    holderId: "pokemmo-simulator-runner",
    correlationId: `scenario:${scenario.scenarioId}`,
    leaseDurationMs: 60_000,
  });

  let actionSequence = 0;
  const act = async (action: PokeMMOSimulatorAction) => {
    actionSequence += 1;
    const actionId = `scenario-action-${String(actionSequence)}`;
    const command: PokeMMOStartActionCommand = {
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
      action: {
        kind: "pokemmo_simulator_action",
        action,
        limits: { maxSteps: 64, maxMenuChoices: 8, maxBattleTurns: 16, timeoutMs: 5_000 },
      },
    };
    const result = await runtime.startAction(grant.token, command);
    if (result.status !== "completed") {
      throw new Error(`Frozen scenario action ${actionId} did not complete: ${result.status}`);
    }
    return result;
  };

  await act({ kind: "navigate", target: scenario.targetLocation });
  await act({ kind: "interact", targetId: scenario.trainer.trainerId });
  const simulator = adapter.session(sessionId);
  while (simulator.snapshot().battleResult === "active") {
    const battle = simulator.observe("battle");
    if (battle.kind !== "battle") throw new Error("Simulator returned the wrong observation kind");
    const moveId = battle.data.legalMoveIds[0];
    if (!moveId) throw new Error("Frozen scenario has no legal battle move");
    await act({
      kind: "battle_move",
      battleId: battle.data.battleId,
      moveId,
      expectedTurn: battle.data.turn,
    });
  }

  const trace = simulator.trace();
  const traceBytes = `${JSON.stringify(trace, null, 2)}\n`;
  const runId = `pokemmo-sim-${input.fixtureSha256.slice(0, 16)}`;
  const final = simulator.snapshot();
  const checks = {
    targetLocationReached:
      final.position.mapId === scenario.targetLocation.mapId &&
      final.position.x === scenario.targetLocation.x &&
      final.position.y === scenario.targetLocation.y,
    trainerBattleEntered: trace.events.some((event) => event.actionKind === "interact"),
    legalMovesSelected:
      final.legalMoveSelections >= scenario.expected.minimumLegalMoveSelections &&
      trace.events.filter((event) => event.actionKind === "battle_move").length === final.legalMoveSelections,
    trainerBattleWon: final.battleResult === scenario.expected.battleResult,
    authoritativeStateCertain: final.stateCertain,
    evidenceBounded:
      trace.events.length <= scenario.maxEvidenceEvents &&
      trace.events.length === new Set(trace.events.map((event) => event.sequence)).size,
  };
  const report = PokeMMOScenarioReportSchema.parse({
    schemaVersion: 1,
    scenarioId: scenario.scenarioId,
    scenarioVersion: scenario.scenarioVersion,
    fixtureSha256: input.fixtureSha256,
    runId,
    result: Object.values(checks).every(Boolean) ? "passed" : "failed",
    checks,
    finalState: {
      position: final.position,
      battleId: final.battleId,
      battleResult: final.battleResult,
      turn: final.turn,
      legalMoveSelections: final.legalMoveSelections,
      activePartySlot: final.activePartySlot,
      activePartyHp: final.activePartyHp,
      opponentHp: final.opponentHp,
    },
    evidence: {
      eventCount: trace.events.length,
      eventChainHeadSha256: trace.eventChainHeadSha256,
      finalStateSha256: final.stateSha256,
    },
    artifacts: [
      {
        kind: "event_trace",
        artifactId: `${runId}:event-trace`,
        uri: `artifact://pokemmo-simulator/${runId}/events.json`,
        sha256: sha256(traceBytes),
        summary: "Bounded simulator-authoritative action trace",
      },
    ],
  });
  const goalEvent = pokemmoSimulatorGoalEvent(
    report,
    {
      ...binding,
      environment: { ...binding.environment, environmentSessionId: sessionId },
    },
    "2026-07-19T00:01:00.000Z",
  );
  semanticEvents.push(goalEvent);
  if (JSON.stringify({ report, trace, semanticEvents }).includes("runner-private-simulator-grant")) {
    throw new Error("Runner-private grant escaped into scenario evidence");
  }
  return { report, trace, semanticEvents, goalEvent };
}

function validateFrozenIdentity(
  scenario: ReturnType<typeof FrozenPokeMMOScenarioSchema.parse>,
  binding: PokeMMOScenarioBinding,
  fixtureSha256: string,
): void {
  if (
    binding.scenarioId !== scenario.scenarioId ||
    binding.scenarioVersion !== scenario.scenarioVersion ||
    binding.fixtureSha256 !== fixtureSha256 ||
    binding.environment.worldId !== scenario.worldId ||
    binding.environment.characterId !== scenario.player.characterId
  ) {
    throw new Error("Frozen PokeMMO scenario identity does not match its binding");
  }
  if (sha256(canonicalJson(scenario)).length !== 64) throw new Error("Scenario canonical hash failed");
}
