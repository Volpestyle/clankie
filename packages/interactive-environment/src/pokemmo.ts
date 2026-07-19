import {
  ActionIdSchema,
  CaptainLaneSchema,
  CharacterIdSchema,
  CommandAuthoritySchema,
  EnvironmentSessionIdSchema,
  IntentContextSchema,
  WorldIdSchema,
  type CaptainLaneV1,
} from "@clankie/protocol";
import { z } from "zod";
import {
  ENVIRONMENT_SESSION_SCHEMA_VERSION,
  EnvironmentActionStatusSchema,
  EnvironmentSessionPhaseSchema,
  PokeMMOSimulatorResourceBoundsSchema,
  type EnvironmentSessionPhase,
} from "./environment.ts";

export const POKEMMO_CONTRACT_SCHEMA_VERSION = 1 as const;

export const PokeMMOMapPositionSchema = z
  .object({
    mapId: z.string().min(1).max(128),
    x: z.number().int().nonnegative().max(65_535),
    y: z.number().int().nonnegative().max(65_535),
  })
  .strict();
export type PokeMMOMapPosition = z.infer<typeof PokeMMOMapPositionSchema>;

export const PokeMMOSimulatorActionLimitsSchema = z
  .object({
    maxSteps: z.number().int().positive().max(1_024),
    maxMenuChoices: z.number().int().positive().max(64),
    maxBattleTurns: z.number().int().positive().max(64),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type PokeMMOSimulatorActionLimits = z.infer<typeof PokeMMOSimulatorActionLimitsSchema>;

const BattleTurnSchema = z.number().int().positive().max(10_000);

export const PokeMMOSimulatorActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), target: PokeMMOMapPositionSchema }).strict(),
  z.object({ kind: z.literal("interact"), targetId: z.string().min(1).max(128) }).strict(),
  z
    .object({
      kind: z.literal("menu_choice"),
      menuId: z.string().min(1).max(128),
      choiceId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("battle_move"),
      battleId: z.string().min(1).max(128),
      moveId: z.string().min(1).max(128),
      expectedTurn: BattleTurnSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("party_switch"),
      battleId: z.string().min(1).max(128),
      partySlot: z.number().int().min(0).max(5),
      expectedTurn: BattleTurnSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("item_use"),
      itemId: z.string().min(1).max(128),
      targetPartySlot: z.number().int().min(0).max(5),
      battleId: z.string().min(1).max(128).optional(),
      expectedTurn: BattleTurnSchema.optional(),
    })
    .strict()
    .superRefine((action, context) => {
      if ((action.battleId === undefined) !== (action.expectedTurn === undefined)) {
        context.addIssue({
          code: "custom",
          path: ["expectedTurn"],
          message: "battle item use requires both battleId and expectedTurn",
        });
      }
    }),
  z.object({ kind: z.literal("wait"), durationMs: z.number().int().positive().max(30_000) }).strict(),
]);
export type PokeMMOSimulatorAction = z.infer<typeof PokeMMOSimulatorActionSchema>;

export const PokeMMOSimulatorActionRequestSchema = z
  .object({
    kind: z.literal("pokemmo_simulator_action"),
    action: PokeMMOSimulatorActionSchema,
    limits: PokeMMOSimulatorActionLimitsSchema,
  })
  .strict();
export type PokeMMOSimulatorActionRequest = z.infer<typeof PokeMMOSimulatorActionRequestSchema>;

export const PokeMMOSimulatorSessionSpecSchema = z
  .object({
    schemaVersion: z.literal(ENVIRONMENT_SESSION_SCHEMA_VERSION),
    sessionId: EnvironmentSessionIdSchema,
    environmentKind: z.literal("pokemmo_simulator"),
    characterId: CharacterIdSchema,
    worldId: WorldIdSchema,
    requestedBy: CommandAuthoritySchema,
    initialGoalVersion: z.number().int().nonnegative(),
    resourceBounds: PokeMMOSimulatorResourceBoundsSchema,
  })
  .strict()
  .superRefine((session, context) => {
    if (session.worldId !== session.resourceBounds.worldId) {
      context.addIssue({
        code: "custom",
        path: ["resourceBounds", "worldId"],
        message: "world binding mismatch",
      });
    }
    if (session.characterId !== session.resourceBounds.characterId) {
      context.addIssue({
        code: "custom",
        path: ["resourceBounds", "characterId"],
        message: "character binding mismatch",
      });
    }
  });
export type PokeMMOSimulatorSessionSpec = z.infer<typeof PokeMMOSimulatorSessionSpecSchema>;

const PokeMMOCommandBaseSchema = z
  .object({
    schemaVersion: z.literal(POKEMMO_CONTRACT_SCHEMA_VERSION),
    commandId: z.string().min(1).max(128),
    context: IntentContextSchema,
    requestedAt: z.string().datetime(),
  })
  .strict();

export const PokeMMOJoinCommandSchema = PokeMMOCommandBaseSchema.extend({
  type: z.literal("join"),
  session: PokeMMOSimulatorSessionSpecSchema,
})
  .strict()
  .superRefine((command, context) => {
    const commandAuthority = command.context.authority;
    const sessionAuthority = command.session.requestedBy;
    if (
      commandAuthority.tier !== sessionAuthority.tier ||
      commandAuthority.principal.kind !== sessionAuthority.principal.kind ||
      commandAuthority.principal.id !== sessionAuthority.principal.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["session", "requestedBy"],
        message: "join authority mismatch",
      });
    }
  });
export const PokeMMOStatusCommandSchema = PokeMMOCommandBaseSchema.extend({
  type: z.literal("status"),
  sessionId: EnvironmentSessionIdSchema.optional(),
}).strict();
export const PokeMMOCancelJoinCommandSchema = PokeMMOCommandBaseSchema.extend({
  type: z.literal("cancel_join"),
  sessionId: EnvironmentSessionIdSchema,
}).strict();
export const PokeMMOStartActionCommandSchema = PokeMMOCommandBaseSchema.extend({
  type: z.literal("start_action"),
  sessionId: EnvironmentSessionIdSchema,
  actionId: ActionIdSchema,
  action: PokeMMOSimulatorActionRequestSchema,
}).strict();
export type PokeMMOStartActionCommand = z.infer<typeof PokeMMOStartActionCommandSchema>;
export const PokeMMOActionStatusCommandSchema = PokeMMOCommandBaseSchema.extend({
  type: z.literal("action_status"),
  sessionId: EnvironmentSessionIdSchema,
  actionId: ActionIdSchema,
}).strict();
export const PokeMMOCancelActionCommandSchema = PokeMMOCommandBaseSchema.extend({
  type: z.literal("cancel_action"),
  sessionId: EnvironmentSessionIdSchema,
  actionId: ActionIdSchema,
  reason: z.string().min(1).max(512),
}).strict();
export const PokeMMOSteerCommandSchema = PokeMMOCommandBaseSchema.extend({
  type: z.literal("steer"),
  sessionId: EnvironmentSessionIdSchema,
  intent: z.string().min(1).max(512),
}).strict();
export const PokeMMOPauseCommandSchema = PokeMMOCommandBaseSchema.extend({
  type: z.literal("pause"),
  sessionId: EnvironmentSessionIdSchema,
  reason: z.string().min(1).max(512),
}).strict();
export const PokeMMOResumeCommandSchema = PokeMMOCommandBaseSchema.extend({
  type: z.literal("resume"),
  sessionId: EnvironmentSessionIdSchema,
}).strict();
export const PokeMMODisconnectCommandSchema = PokeMMOCommandBaseSchema.extend({
  type: z.literal("disconnect"),
  sessionId: EnvironmentSessionIdSchema,
  reason: z.string().min(1).max(512),
}).strict();

export const PokeMMOCommandSchema = z.union([
  PokeMMOJoinCommandSchema,
  PokeMMOStatusCommandSchema,
  PokeMMOCancelJoinCommandSchema,
  PokeMMOStartActionCommandSchema,
  PokeMMOActionStatusCommandSchema,
  PokeMMOCancelActionCommandSchema,
  PokeMMOSteerCommandSchema,
  PokeMMOPauseCommandSchema,
  PokeMMOResumeCommandSchema,
  PokeMMODisconnectCommandSchema,
]);
export type PokeMMOCommand = z.infer<typeof PokeMMOCommandSchema>;

const ObservationSummarySchema = z.string().min(1).max(1_024);
const PokeMMOObservationBaseSchema = z
  .object({
    schemaVersion: z.literal(POKEMMO_CONTRACT_SCHEMA_VERSION),
    observationId: z.string().min(1).max(128),
    sessionId: EnvironmentSessionIdSchema,
    characterId: CharacterIdSchema,
    worldId: WorldIdSchema,
    goalVersion: z.number().int().nonnegative(),
    capturedAt: z.string().datetime(),
  })
  .strict();

const PartyMemberSchema = z
  .object({
    slot: z.number().int().min(0).max(5),
    creatureId: z.string().min(1).max(128),
    speciesId: z.string().min(1).max(128),
    level: z.number().int().positive().max(100),
    currentHp: z.number().int().nonnegative().max(9_999),
    maxHp: z.number().int().positive().max(9_999),
    status: z.enum(["healthy", "poisoned", "burned", "paralyzed", "asleep", "frozen", "fainted"]),
  })
  .strict()
  .refine((member) => member.currentHp <= member.maxHp, { path: ["currentHp"], message: "HP exceeds max" });

export const PokeMMOObservationSchema = z.discriminatedUnion("kind", [
  PokeMMOObservationBaseSchema.extend({
    kind: z.literal("overworld"),
    data: z
      .object({
        position: PokeMMOMapPositionSchema,
        facing: z.enum(["north", "east", "south", "west"]),
        nearbyInteractables: z
          .array(
            z
              .object({
                id: z.string().min(1).max(128),
                kind: z.enum(["trainer", "npc", "object", "map_exit"]),
                distance: z.number().int().nonnegative().max(1_024),
              })
              .strict(),
          )
          .max(32),
      })
      .strict(),
  }).strict(),
  PokeMMOObservationBaseSchema.extend({
    kind: z.literal("menu"),
    data: z
      .object({
        menuId: z.string().min(1).max(128),
        title: z.string().min(1).max(256),
        choices: z
          .array(
            z
              .object({
                id: z.string().min(1).max(128),
                label: z.string().min(1).max(256),
                enabled: z.boolean(),
              })
              .strict(),
          )
          .max(32),
        cursor: z.number().int().nonnegative().max(31),
        untrusted: z.literal(true),
      })
      .strict(),
  }).strict(),
  PokeMMOObservationBaseSchema.extend({
    kind: z.literal("party"),
    data: z
      .object({ activeSlot: z.number().int().min(0).max(5), members: z.array(PartyMemberSchema).max(6) })
      .strict(),
  }).strict(),
  PokeMMOObservationBaseSchema.extend({
    kind: z.literal("inventory"),
    data: z
      .object({
        items: z
          .array(
            z
              .object({ itemId: z.string().min(1).max(128), count: z.number().int().nonnegative().max(999) })
              .strict(),
          )
          .max(128),
      })
      .strict(),
  }).strict(),
  PokeMMOObservationBaseSchema.extend({
    kind: z.literal("battle"),
    data: z
      .object({
        battleId: z.string().min(1).max(128),
        turn: BattleTurnSchema,
        phase: z.enum(["awaiting_action", "resolving", "won", "lost"]),
        opponent: z
          .object({
            trainerId: z.string().min(1).max(128),
            creatureId: z.string().min(1).max(128),
            speciesId: z.string().min(1).max(128),
            currentHp: z.number().int().nonnegative().max(9_999),
            maxHp: z.number().int().positive().max(9_999),
          })
          .strict(),
        activePartySlot: z.number().int().min(0).max(5),
        legalMoveIds: z.array(z.string().min(1).max(128)).max(4),
        canSwitch: z.boolean(),
        canUseItems: z.boolean(),
        untrusted: z.literal(true),
      })
      .strict(),
  }).strict(),
  PokeMMOObservationBaseSchema.extend({
    kind: z.literal("dialog"),
    data: z
      .object({
        speaker: z.string().min(1).max(128),
        lines: z.array(z.string().max(512)).max(8),
        choiceIds: z.array(z.string().min(1).max(128)).max(16),
        untrusted: z.literal(true),
      })
      .strict(),
  }).strict(),
  PokeMMOObservationBaseSchema.extend({
    kind: z.literal("danger"),
    data: z
      .object({
        severity: z.enum(["low", "medium", "high", "critical"]),
        code: z.enum(["uncertain_state", "low_health", "invalid_transition", "policy_boundary"]),
        summary: ObservationSummarySchema,
        stateCertain: z.boolean(),
      })
      .strict(),
  }).strict(),
  PokeMMOObservationBaseSchema.extend({
    kind: z.literal("action"),
    data: z
      .object({
        actionId: ActionIdSchema,
        status: EnvironmentActionStatusSchema,
        summary: ObservationSummarySchema,
      })
      .strict(),
  }).strict(),
]);
export type PokeMMOObservation = z.infer<typeof PokeMMOObservationSchema>;
export type PokeMMOObservationKind = PokeMMOObservation["kind"];

export const PokeMMOSimulatorToolNameSchema = z.enum([
  "pokemmo_join",
  "pokemmo_status",
  "pokemmo_cancel_join",
  "pokemmo_steer",
  "pokemmo_pause",
  "pokemmo_resume",
  "pokemmo_disconnect",
  "pokemmo_observe",
  "pokemmo_start_action",
  "pokemmo_action_status",
  "pokemmo_cancel_action",
]);
export type PokeMMOSimulatorToolName = z.infer<typeof PokeMMOSimulatorToolNameSchema>;

const simulatorToolSetsFor = (
  phase: EnvironmentSessionPhase,
  lane: CaptainLaneV1,
): { lifecycleTools: PokeMMOSimulatorToolName[]; gameplayTools: PokeMMOSimulatorToolName[] } => {
  if (phase === "off" || phase === "failed") {
    return { lifecycleTools: ["pokemmo_join", "pokemmo_status"], gameplayTools: [] };
  }
  if (phase === "starting") {
    return { lifecycleTools: ["pokemmo_status", "pokemmo_cancel_join"], gameplayTools: [] };
  }
  if (phase === "paused") {
    return {
      lifecycleTools: ["pokemmo_status", "pokemmo_resume", "pokemmo_disconnect"],
      gameplayTools: [],
    };
  }
  if (phase === "stopping") return { lifecycleTools: ["pokemmo_status"], gameplayTools: [] };
  if (lane === "gameplay") {
    return {
      lifecycleTools: ["pokemmo_status", "pokemmo_pause", "pokemmo_disconnect"],
      gameplayTools: [
        "pokemmo_observe",
        "pokemmo_start_action",
        "pokemmo_action_status",
        "pokemmo_cancel_action",
      ],
    };
  }
  return {
    lifecycleTools: ["pokemmo_status", "pokemmo_steer", "pokemmo_pause", "pokemmo_disconnect"],
    gameplayTools: [],
  };
};

export const PokeMMOSimulatorToolExposureSchema = z
  .object({
    schemaVersion: z.literal(POKEMMO_CONTRACT_SCHEMA_VERSION),
    environmentKind: z.literal("pokemmo_simulator"),
    phase: EnvironmentSessionPhaseSchema,
    lane: CaptainLaneSchema,
    lifecycleTools: z.array(PokeMMOSimulatorToolNameSchema).max(8),
    gameplayTools: z.array(PokeMMOSimulatorToolNameSchema).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = simulatorToolSetsFor(value.phase, value.lane);
    if (JSON.stringify(value.lifecycleTools) !== JSON.stringify(expected.lifecycleTools)) {
      context.addIssue({
        code: "custom",
        path: ["lifecycleTools"],
        message: "invalid lifecycle tool exposure",
      });
    }
    if (JSON.stringify(value.gameplayTools) !== JSON.stringify(expected.gameplayTools)) {
      context.addIssue({
        code: "custom",
        path: ["gameplayTools"],
        message: "invalid gameplay tool exposure",
      });
    }
  });
export type PokeMMOSimulatorToolExposure = z.infer<typeof PokeMMOSimulatorToolExposureSchema>;

export function resolvePokeMMOSimulatorToolExposure(
  phase: EnvironmentSessionPhase,
  lane: CaptainLaneV1,
): PokeMMOSimulatorToolExposure {
  return PokeMMOSimulatorToolExposureSchema.parse({
    schemaVersion: POKEMMO_CONTRACT_SCHEMA_VERSION,
    environmentKind: "pokemmo_simulator",
    phase,
    lane,
    ...simulatorToolSetsFor(phase, lane),
  });
}

export const POKEMMO_LIVE_READ_ONLY_CAPABILITIES = ["pokemmo.live.observe", "pokemmo.live.coach"] as const;
export const PokeMMOLiveReadOnlyCapabilitySchema = z.enum(POKEMMO_LIVE_READ_ONLY_CAPABILITIES);
export type PokeMMOLiveReadOnlyCapability = z.infer<typeof PokeMMOLiveReadOnlyCapabilitySchema>;

export const PokeMMOLiveCapabilityBoundarySchema = z
  .object({
    schemaVersion: z.literal(POKEMMO_CONTRACT_SCHEMA_VERSION),
    environmentKind: z.literal("pokemmo_live_read_only"),
    capabilities: z.tuple([
      z.literal(POKEMMO_LIVE_READ_ONLY_CAPABILITIES[0]),
      z.literal(POKEMMO_LIVE_READ_ONLY_CAPABILITIES[1]),
    ]),
    actionCapabilities: z.array(z.never()).max(0),
  })
  .strict();

export const POKEMMO_LIVE_CAPABILITY_BOUNDARY = PokeMMOLiveCapabilityBoundarySchema.parse({
  schemaVersion: POKEMMO_CONTRACT_SCHEMA_VERSION,
  environmentKind: "pokemmo_live_read_only",
  capabilities: POKEMMO_LIVE_READ_ONLY_CAPABILITIES,
  actionCapabilities: [],
});

export function isPokeMMOLiveCapabilityAllowed(
  capability: string,
): capability is PokeMMOLiveReadOnlyCapability {
  return PokeMMOLiveReadOnlyCapabilitySchema.safeParse(capability).success;
}
