import { InteractiveEnvironmentBindingSchema } from "@clankie/protocol";
import {
  EnvironmentSemanticEventSchema,
  GbaEmulatorActionSchema,
  GbaMapPositionSchema,
  type EnvironmentSemanticEvent,
} from "@clankie/interactive-environment";
import { z } from "zod";

export const GBA_EMULATOR_INTEGRATION_SCHEMA_VERSION = 1 as const;
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
    speciesId: z.string().min(1).max(128),
    level: z.number().int().positive().max(100),
    maxHp: z.number().int().positive().max(9_999),
    moves: z.array(MoveFixtureSchema).min(1).max(4),
  })
  .strict();

export const FrozenGbaScenarioSchema = z
  .object({
    schemaVersion: z.literal(GBA_EMULATOR_INTEGRATION_SCHEMA_VERSION),
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    coreId: z.string().min(1).max(128),
    /** Identity of the pinned savestate the deterministic core starts from. Never savestate bytes. */
    savestateId: z.string().min(1).max(128),
    savestateSha256: Sha256Schema,
    rngSeed: z.number().int().nonnegative().max(4_294_967_295),
    worldId: z.string().min(1).max(256),
    maxEvidenceEvents: z.number().int().positive().max(256),
    maxDecisions: z.number().int().positive().max(256),
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
        start: GbaMapPositionSchema,
        party: z.array(PartyFixtureSchema).min(1).max(6),
      })
      .strict(),
    trainer: z
      .object({
        trainerId: z.string().min(1).max(128),
        position: GbaMapPositionSchema,
        interactionDistance: z.number().int().positive().max(16),
        dialog: z.array(z.string().min(1).max(512)).min(1).max(8),
        opponent: z
          .object({
            speciesId: z.string().min(1).max(128),
            level: z.number().int().positive().max(100),
            maxHp: z.number().int().positive().max(9_999),
            retaliationDamage: z.number().int().nonnegative().max(9_999),
          })
          .strict(),
      })
      .strict(),
    targetLocation: GbaMapPositionSchema,
    expected: z
      .object({
        battleResult: z.literal("won"),
        minimumDecisions: z.number().int().positive().max(256),
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
    if (new Set(scenario.player.party.map((member) => member.slot)).size !== scenario.player.party.length) {
      context.addIssue({ code: "custom", path: ["player", "party"], message: "party slots must be unique" });
    }
    const engageDistance =
      Math.abs(scenario.targetLocation.x - scenario.trainer.position.x) +
      Math.abs(scenario.targetLocation.y - scenario.trainer.position.y);
    if (engageDistance > scenario.trainer.interactionDistance) {
      context.addIssue({
        code: "custom",
        path: ["targetLocation"],
        message: "target location cannot reach the trainer interaction",
      });
    }
  });
export type FrozenGbaScenario = z.infer<typeof FrozenGbaScenarioSchema>;

export const GbaScenarioBindingSchema = z
  .object({
    schemaVersion: z.literal(GBA_EMULATOR_INTEGRATION_SCHEMA_VERSION),
    environment: InteractiveEnvironmentBindingSchema,
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    fixtureSha256: Sha256Schema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.environment.environmentKind !== "gba_emulator") {
      context.addIssue({
        code: "custom",
        path: ["environment", "environmentKind"],
        message: "binding must target the GBA emulator profile",
      });
    }
  });
export type GbaScenarioBinding = z.infer<typeof GbaScenarioBindingSchema>;

export const GbaEmulatorEvidenceEventSchema = z
  .object({
    schemaVersion: z.literal(GBA_EMULATOR_INTEGRATION_SCHEMA_VERSION),
    sequence: z.number().int().positive().max(256),
    actionId: z.string().min(1).max(128),
    actionKind: z.enum(["button_press", "frame_advance", "wait", "cancel_action"]),
    summary: z.string().min(1).max(512),
    frame: z.number().int().nonnegative().max(100_000_000),
    ramStateSha256: Sha256Schema,
    previousEventSha256: Sha256Schema,
    eventSha256: Sha256Schema,
  })
  .strict();
export type GbaEmulatorEvidenceEvent = z.infer<typeof GbaEmulatorEvidenceEventSchema>;

export const GbaEmulatorTraceSchema = z
  .object({
    schemaVersion: z.literal(GBA_EMULATOR_INTEGRATION_SCHEMA_VERSION),
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    fixtureSha256: Sha256Schema,
    coreId: z.string().min(1).max(128),
    savestateSha256: Sha256Schema,
    rngSeed: z.number().int().nonnegative().max(4_294_967_295),
    eventChainHeadSha256: Sha256Schema,
    events: z.array(GbaEmulatorEvidenceEventSchema).max(256),
  })
  .strict();
export type GbaEmulatorTrace = z.infer<typeof GbaEmulatorTraceSchema>;

export const GbaDriverReasonCodeSchema = z.enum([
  "route_step_toward_target",
  "engage_trainer",
  "advance_dialog",
  "move_cursor_to_best_move",
  "select_best_move",
  "halt_battle_won",
  "halt_uncertain_state",
  "halt_action_failed",
  "halt_decision_budget_exhausted",
]);
export type GbaDriverReasonCode = z.infer<typeof GbaDriverReasonCodeSchema>;

export const GbaDriverDecisionSchema = z
  .object({
    schemaVersion: z.literal(GBA_EMULATOR_INTEGRATION_SCHEMA_VERSION),
    sequence: z.number().int().positive().max(256),
    observedKind: z.enum(["overworld", "dialog", "battle", "danger"]),
    observedFrame: z.number().int().nonnegative().max(100_000_000),
    observedRamStateSha256: Sha256Schema,
    reasonCode: GbaDriverReasonCodeSchema,
    action: GbaEmulatorActionSchema.optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    const halts = decision.reasonCode.startsWith("halt_");
    if (halts === (decision.action !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "halt decisions carry no action and acting decisions must carry one",
      });
    }
  });
export type GbaDriverDecision = z.infer<typeof GbaDriverDecisionSchema>;

export const GbaDecisionTraceSchema = z
  .object({
    schemaVersion: z.literal(GBA_EMULATOR_INTEGRATION_SCHEMA_VERSION),
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    fixtureSha256: Sha256Schema,
    decisions: z.array(GbaDriverDecisionSchema).min(1).max(256),
  })
  .strict()
  .superRefine((trace, context) => {
    let previousFrame = -1;
    for (const [index, decision] of trace.decisions.entries()) {
      if (decision.sequence !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["decisions", index, "sequence"],
          message: "decision sequence is not contiguous",
        });
      }
      if (decision.observedFrame < previousFrame) {
        context.addIssue({
          code: "custom",
          path: ["decisions", index, "observedFrame"],
          message: "decision observed a frame older than its predecessor",
        });
      }
      previousFrame = decision.observedFrame;
    }
  });
export type GbaDecisionTrace = z.infer<typeof GbaDecisionTraceSchema>;

const ScenarioArtifactReferenceSchema = z
  .object({
    kind: z.enum(["event_trace", "decision_trace", "frame"]),
    artifactId: z.string().min(1).max(256),
    uri: z.string().regex(/^artifact:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u),
    sha256: Sha256Schema,
    summary: z.string().min(1).max(512),
  })
  .strict();

export const GbaScenarioReportSchema = z
  .object({
    schemaVersion: z.literal(GBA_EMULATOR_INTEGRATION_SCHEMA_VERSION),
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    fixtureSha256: Sha256Schema,
    runId: z.string().min(1).max(128),
    result: z.enum(["passed", "failed"]),
    halt: z.enum(["battle_won", "uncertain_state", "action_failed", "decision_budget_exhausted"]),
    checks: z
      .object({
        targetLocationReached: z.boolean(),
        trainerBattleEntered: z.boolean(),
        trainerBattleWon: z.boolean(),
        decisionsStateDerived: z.boolean(),
        authoritativeStateCertain: z.boolean(),
        evidenceBounded: z.boolean(),
        inputsWithinBounds: z.boolean(),
      })
      .strict(),
    finalState: z
      .object({
        position: GbaMapPositionSchema,
        battleId: z.string().min(1).max(128).nullable(),
        battleResult: z.enum(["not_started", "active", "won", "lost"]),
        turn: z.number().int().nonnegative().max(10_000),
        activePartySlot: z.number().int().min(0).max(5),
        activePartyHp: z.number().int().nonnegative().max(9_999),
        opponentHp: z.number().int().nonnegative().max(9_999),
        frame: z.number().int().nonnegative().max(100_000_000),
        inputCount: z.number().int().nonnegative().max(16_384),
      })
      .strict(),
    evidence: z
      .object({
        eventCount: z.number().int().nonnegative().max(256),
        decisionCount: z.number().int().nonnegative().max(256),
        eventChainHeadSha256: Sha256Schema,
        decisionTraceSha256: Sha256Schema,
        finalRamStateSha256: Sha256Schema,
      })
      .strict(),
    artifacts: z.array(ScenarioArtifactReferenceSchema).max(6),
  })
  .strict()
  .superRefine((report, context) => {
    const allChecksPass = Object.values(report.checks).every(Boolean);
    if ((report.result === "passed") !== allChecksPass) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "result disagrees with emulator-authoritative checks",
      });
    }
    if (report.result === "passed" && report.halt !== "battle_won") {
      context.addIssue({
        code: "custom",
        path: ["halt"],
        message: "a passing run must halt on the won battle",
      });
    }
  });
export type GbaScenarioReport = z.infer<typeof GbaScenarioReportSchema>;

export function gbaEmulatorGoalEvent(
  reportInput: unknown,
  bindingInput: unknown,
  occurredAt = new Date().toISOString(),
): EnvironmentSemanticEvent {
  const report = GbaScenarioReportSchema.parse(reportInput);
  const binding = GbaScenarioBindingSchema.parse(bindingInput);
  if (
    report.scenarioId !== binding.scenarioId ||
    report.scenarioVersion !== binding.scenarioVersion ||
    report.fixtureSha256 !== binding.fixtureSha256
  ) {
    throw new Error("Emulator report does not match the frozen scenario binding");
  }
  return EnvironmentSemanticEventSchema.parse({
    schemaVersion: 1,
    plane: "semantic",
    id: `gba-emulator:${report.runId}`,
    type: report.result === "passed" ? "environment.goal.verified" : "environment.goal.failed",
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
