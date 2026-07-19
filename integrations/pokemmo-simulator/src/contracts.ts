import { InteractiveEnvironmentBindingSchema } from "@clankie/protocol";
import {
  EnvironmentSemanticEventSchema,
  PokeMMOMapPositionSchema,
  type EnvironmentSemanticEvent,
} from "@clankie/interactive-environment";
import { z } from "zod";

export const POKEMMO_SIMULATOR_SCHEMA_VERSION = 1 as const;
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const GridPositionSchema = z
  .object({ x: z.number().int().nonnegative().max(65_535), y: z.number().int().nonnegative().max(65_535) })
  .strict();

const MoveFixtureSchema = z
  .object({ moveId: z.string().min(1).max(128), power: z.number().int().positive().max(999) })
  .strict();

const PartyFixtureSchema = z
  .object({
    slot: z.number().int().min(0).max(5),
    creatureId: z.string().min(1).max(128),
    speciesId: z.string().min(1).max(128),
    level: z.number().int().positive().max(100),
    maxHp: z.number().int().positive().max(9_999),
    moves: z.array(MoveFixtureSchema).min(1).max(4),
  })
  .strict();

const InventoryFixtureSchema = z
  .object({
    itemId: z.string().min(1).max(128),
    count: z.number().int().nonnegative().max(999),
    healAmount: z.number().int().positive().max(9_999),
  })
  .strict();

export const FrozenPokeMMOScenarioSchema = z
  .object({
    schemaVersion: z.literal(POKEMMO_SIMULATOR_SCHEMA_VERSION),
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    simulatorId: z.string().min(1).max(128),
    worldId: z.string().min(1).max(256),
    maxEvidenceEvents: z.number().int().positive().max(256),
    map: z
      .object({
        mapId: z.string().min(1).max(128),
        width: z.number().int().positive().max(1_024),
        height: z.number().int().positive().max(1_024),
        blocked: z.array(GridPositionSchema).max(256),
      })
      .strict(),
    player: z
      .object({
        characterId: z.string().min(1).max(256),
        start: PokeMMOMapPositionSchema,
        party: z.array(PartyFixtureSchema).min(1).max(6),
        inventory: z.array(InventoryFixtureSchema).max(128),
      })
      .strict(),
    trainer: z
      .object({
        trainerId: z.string().min(1).max(128),
        position: PokeMMOMapPositionSchema,
        interactionDistance: z.number().int().nonnegative().max(16),
        dialog: z.array(z.string().min(1).max(512)).max(8),
        opponent: z
          .object({
            creatureId: z.string().min(1).max(128),
            speciesId: z.string().min(1).max(128),
            level: z.number().int().positive().max(100),
            maxHp: z.number().int().positive().max(9_999),
            retaliationDamage: z.number().int().nonnegative().max(9_999),
          })
          .strict(),
      })
      .strict(),
    targetLocation: PokeMMOMapPositionSchema,
    expected: z
      .object({
        trainerId: z.string().min(1).max(128),
        battleResult: z.literal("won"),
        minimumLegalMoveSelections: z.number().int().positive().max(64),
      })
      .strict(),
  })
  .strict()
  .superRefine((scenario, context) => {
    const positions = [scenario.player.start, scenario.trainer.position, scenario.targetLocation];
    for (const [index, position] of positions.entries()) {
      if (
        position.mapId !== scenario.map.mapId ||
        position.x >= scenario.map.width ||
        position.y >= scenario.map.height
      ) {
        context.addIssue({
          code: "custom",
          path: ["map", "position", index],
          message: "scenario position is outside the frozen map",
        });
      }
    }
    if (scenario.expected.trainerId !== scenario.trainer.trainerId) {
      context.addIssue({
        code: "custom",
        path: ["expected", "trainerId"],
        message: "expected trainer does not match fixture trainer",
      });
    }
    if (new Set(scenario.player.party.map((member) => member.slot)).size !== scenario.player.party.length) {
      context.addIssue({ code: "custom", path: ["player", "party"], message: "party slots must be unique" });
    }
  });
export type FrozenPokeMMOScenario = z.infer<typeof FrozenPokeMMOScenarioSchema>;

export const PokeMMOScenarioBindingSchema = z
  .object({
    schemaVersion: z.literal(POKEMMO_SIMULATOR_SCHEMA_VERSION),
    environment: InteractiveEnvironmentBindingSchema,
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    fixtureSha256: Sha256Schema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.environment.environmentKind !== "pokemmo_simulator") {
      context.addIssue({
        code: "custom",
        path: ["environment", "environmentKind"],
        message: "binding must target the PokeMMO simulator",
      });
    }
  });
export type PokeMMOScenarioBinding = z.infer<typeof PokeMMOScenarioBindingSchema>;

export const PokeMMOSimulatorEvidenceEventSchema = z
  .object({
    schemaVersion: z.literal(POKEMMO_SIMULATOR_SCHEMA_VERSION),
    sequence: z.number().int().positive().max(256),
    actionId: z.string().min(1).max(128),
    actionKind: z.enum([
      "navigate",
      "interact",
      "menu_choice",
      "battle_move",
      "party_switch",
      "item_use",
      "wait",
      "cancel_action",
    ]),
    summary: z.string().min(1).max(512),
    stateSha256: Sha256Schema,
    previousEventSha256: Sha256Schema,
    eventSha256: Sha256Schema,
  })
  .strict();
export type PokeMMOSimulatorEvidenceEvent = z.infer<typeof PokeMMOSimulatorEvidenceEventSchema>;

export const PokeMMOSimulatorTraceSchema = z
  .object({
    schemaVersion: z.literal(POKEMMO_SIMULATOR_SCHEMA_VERSION),
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    fixtureSha256: Sha256Schema,
    eventChainHeadSha256: Sha256Schema,
    events: z.array(PokeMMOSimulatorEvidenceEventSchema).max(256),
  })
  .strict();
export type PokeMMOSimulatorTrace = z.infer<typeof PokeMMOSimulatorTraceSchema>;

const ScenarioArtifactReferenceSchema = z
  .object({
    kind: z.enum(["event_trace", "frame"]),
    artifactId: z.string().min(1).max(256),
    uri: z.string().regex(/^artifact:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u),
    sha256: Sha256Schema,
    summary: z.string().min(1).max(512),
  })
  .strict();

export const PokeMMOScenarioReportSchema = z
  .object({
    schemaVersion: z.literal(POKEMMO_SIMULATOR_SCHEMA_VERSION),
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    fixtureSha256: Sha256Schema,
    runId: z.string().min(1).max(128),
    result: z.enum(["passed", "failed"]),
    checks: z
      .object({
        targetLocationReached: z.boolean(),
        trainerBattleEntered: z.boolean(),
        legalMovesSelected: z.boolean(),
        trainerBattleWon: z.boolean(),
        authoritativeStateCertain: z.boolean(),
        evidenceBounded: z.boolean(),
      })
      .strict(),
    finalState: z
      .object({
        position: PokeMMOMapPositionSchema,
        battleId: z.string().min(1).max(128).nullable(),
        battleResult: z.enum(["not_started", "active", "won", "lost"]),
        turn: z.number().int().nonnegative().max(10_000),
        legalMoveSelections: z.number().int().nonnegative().max(64),
        activePartySlot: z.number().int().min(0).max(5),
        activePartyHp: z.number().int().nonnegative().max(9_999),
        opponentHp: z.number().int().nonnegative().max(9_999),
      })
      .strict(),
    evidence: z
      .object({
        eventCount: z.number().int().nonnegative().max(256),
        eventChainHeadSha256: Sha256Schema,
        finalStateSha256: Sha256Schema,
      })
      .strict(),
    artifacts: z.array(ScenarioArtifactReferenceSchema).max(4),
  })
  .strict()
  .superRefine((report, context) => {
    const allChecksPass = Object.values(report.checks).every(Boolean);
    if ((report.result === "passed") !== allChecksPass) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "result disagrees with simulator-authoritative checks",
      });
    }
    if (report.evidence.eventCount > 256) {
      context.addIssue({ code: "custom", path: ["evidence"], message: "evidence exceeds protocol bound" });
    }
  });
export type PokeMMOScenarioReport = z.infer<typeof PokeMMOScenarioReportSchema>;

export function pokemmoSimulatorGoalEvent(
  reportInput: unknown,
  bindingInput: unknown,
  occurredAt = new Date().toISOString(),
): EnvironmentSemanticEvent {
  const report = PokeMMOScenarioReportSchema.parse(reportInput);
  const binding = PokeMMOScenarioBindingSchema.parse(bindingInput);
  if (
    report.scenarioId !== binding.scenarioId ||
    report.scenarioVersion !== binding.scenarioVersion ||
    report.fixtureSha256 !== binding.fixtureSha256
  ) {
    throw new Error("Simulator report does not match the frozen scenario binding");
  }
  return EnvironmentSemanticEventSchema.parse({
    schemaVersion: 1,
    plane: "semantic",
    id: `pokemmo-simulator:${report.runId}`,
    type: report.result === "passed" ? "pokemmo.goal.verified" : "pokemmo.goal.failed",
    occurredAt,
    correlationId: report.runId,
    ...(binding.environment.environmentSessionId === undefined
      ? {}
      : { sessionId: binding.environment.environmentSessionId }),
    data: {
      scenarioId: report.scenarioId,
      scenarioVersion: report.scenarioVersion,
      fixtureSha256: report.fixtureSha256,
    },
  });
}
