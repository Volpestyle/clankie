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
  GbaEmulatorResourceBoundsSchema,
  type EnvironmentSessionPhase,
} from "./environment.ts";

export const GBA_EMULATOR_CONTRACT_SCHEMA_VERSION = 1 as const;

export const GbaButtonSchema = z.enum(["a", "b", "start", "select", "up", "down", "left", "right", "l", "r"]);
export type GbaButton = z.infer<typeof GbaButtonSchema>;

export const GbaMapPositionSchema = z
  .object({
    mapId: z.string().min(1).max(128),
    x: z.number().int().nonnegative().max(65_535),
    y: z.number().int().nonnegative().max(65_535),
  })
  .strict();
export type GbaMapPosition = z.infer<typeof GbaMapPositionSchema>;

const HoldFramesSchema = z.number().int().positive().max(240);
const FrameCountSchema = z.number().int().positive().max(3_600);
const EmulatorFrameSchema = z.number().int().nonnegative().max(100_000_000);

/**
 * Repeats of a single press within one action.
 *
 * A corridor should cost one decision, not one per tile — and in FireRed a
 * short tap turns the character without stepping, so even a single step often
 * needs two presses. Repeats are bounded and each one counts against the
 * session's `maxInputs`, so this is coarser granularity, not a wider budget.
 */
const RepeatSchema = z.number().int().positive().max(16);

export const GbaEmulatorActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("button_press"),
      button: GbaButtonSchema,
      holdFrames: HoldFramesSchema,
      /**
       * Omitted means a single press. Optional rather than defaulted so the
       * action type stays backward compatible and the deterministic drivers
       * need no edit at all.
       */
      repeat: RepeatSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("frame_advance"), frames: FrameCountSchema }).strict(),
  z.object({ kind: z.literal("wait"), durationMs: z.number().int().positive().max(30_000) }).strict(),
  /**
   * Walk to a tile on the current map, routing around walls.
   *
   * A catalogued action rather than a caller-side loop, because the route must
   * be planned against the core's own collision and re-checked every step: tile
   * collision does not include NPCs, so a plan can stop being true while it is
   * being walked. It is still bounded by the same input and frame budget a
   * burst of presses draws from.
   */
  z
    .object({
      kind: z.literal("walk_to"),
      x: z.number().int().nonnegative().max(1_023),
      y: z.number().int().nonnegative().max(1_023),
    })
    .strict(),
]);
export type GbaEmulatorAction = z.infer<typeof GbaEmulatorActionSchema>;

export const GbaEmulatorActionLimitsSchema = z
  .object({
    maxInputs: z.number().int().positive().max(64),
    maxFrames: FrameCountSchema,
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type GbaEmulatorActionLimits = z.infer<typeof GbaEmulatorActionLimitsSchema>;

export const GbaEmulatorActionRequestSchema = z
  .object({
    kind: z.literal("gba_emulator_action"),
    action: GbaEmulatorActionSchema,
    limits: GbaEmulatorActionLimitsSchema,
  })
  .strict();
export type GbaEmulatorActionRequest = z.infer<typeof GbaEmulatorActionRequestSchema>;

export const GbaEmulatorSessionSpecSchema = z
  .object({
    schemaVersion: z.literal(ENVIRONMENT_SESSION_SCHEMA_VERSION),
    sessionId: EnvironmentSessionIdSchema,
    environmentKind: z.literal("gba_emulator"),
    characterId: CharacterIdSchema,
    worldId: WorldIdSchema,
    requestedBy: CommandAuthoritySchema,
    initialGoalVersion: z.number().int().nonnegative(),
    resourceBounds: GbaEmulatorResourceBoundsSchema,
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
export type GbaEmulatorSessionSpec = z.infer<typeof GbaEmulatorSessionSpecSchema>;

const GbaEmulatorCommandBaseSchema = z
  .object({
    schemaVersion: z.literal(GBA_EMULATOR_CONTRACT_SCHEMA_VERSION),
    commandId: z.string().min(1).max(128),
    context: IntentContextSchema,
    requestedAt: z.string().datetime(),
  })
  .strict();

export const GbaEmulatorJoinCommandSchema = GbaEmulatorCommandBaseSchema.extend({
  type: z.literal("join"),
  session: GbaEmulatorSessionSpecSchema,
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
export const GbaEmulatorStatusCommandSchema = GbaEmulatorCommandBaseSchema.extend({
  type: z.literal("status"),
  sessionId: EnvironmentSessionIdSchema.optional(),
}).strict();
export const GbaEmulatorCancelJoinCommandSchema = GbaEmulatorCommandBaseSchema.extend({
  type: z.literal("cancel_join"),
  sessionId: EnvironmentSessionIdSchema,
}).strict();
export const GbaEmulatorStartActionCommandSchema = GbaEmulatorCommandBaseSchema.extend({
  type: z.literal("start_action"),
  sessionId: EnvironmentSessionIdSchema,
  actionId: ActionIdSchema,
  action: GbaEmulatorActionRequestSchema,
}).strict();
export type GbaEmulatorStartActionCommand = z.infer<typeof GbaEmulatorStartActionCommandSchema>;
export const GbaEmulatorActionStatusCommandSchema = GbaEmulatorCommandBaseSchema.extend({
  type: z.literal("action_status"),
  sessionId: EnvironmentSessionIdSchema,
  actionId: ActionIdSchema,
}).strict();
export const GbaEmulatorCancelActionCommandSchema = GbaEmulatorCommandBaseSchema.extend({
  type: z.literal("cancel_action"),
  sessionId: EnvironmentSessionIdSchema,
  actionId: ActionIdSchema,
  reason: z.string().min(1).max(512),
}).strict();
export const GbaEmulatorSteerCommandSchema = GbaEmulatorCommandBaseSchema.extend({
  type: z.literal("steer"),
  sessionId: EnvironmentSessionIdSchema,
  intent: z.string().min(1).max(512),
}).strict();
export const GbaEmulatorPauseCommandSchema = GbaEmulatorCommandBaseSchema.extend({
  type: z.literal("pause"),
  sessionId: EnvironmentSessionIdSchema,
  reason: z.string().min(1).max(512),
}).strict();
export const GbaEmulatorResumeCommandSchema = GbaEmulatorCommandBaseSchema.extend({
  type: z.literal("resume"),
  sessionId: EnvironmentSessionIdSchema,
}).strict();
export const GbaEmulatorDisconnectCommandSchema = GbaEmulatorCommandBaseSchema.extend({
  type: z.literal("disconnect"),
  sessionId: EnvironmentSessionIdSchema,
  reason: z.string().min(1).max(512),
}).strict();

export const GbaEmulatorCommandSchema = z.union([
  GbaEmulatorJoinCommandSchema,
  GbaEmulatorStatusCommandSchema,
  GbaEmulatorCancelJoinCommandSchema,
  GbaEmulatorStartActionCommandSchema,
  GbaEmulatorActionStatusCommandSchema,
  GbaEmulatorCancelActionCommandSchema,
  GbaEmulatorSteerCommandSchema,
  GbaEmulatorPauseCommandSchema,
  GbaEmulatorResumeCommandSchema,
  GbaEmulatorDisconnectCommandSchema,
]);
export type GbaEmulatorCommand = z.infer<typeof GbaEmulatorCommandSchema>;

const ObservationSummarySchema = z.string().min(1).max(1_024);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const GbaEmulatorObservationBaseSchema = z
  .object({
    schemaVersion: z.literal(GBA_EMULATOR_CONTRACT_SCHEMA_VERSION),
    observationId: z.string().min(1).max(128),
    sessionId: EnvironmentSessionIdSchema,
    characterId: CharacterIdSchema,
    worldId: WorldIdSchema,
    goalVersion: z.number().int().nonnegative(),
    capturedAt: z.string().datetime(),
    /** Emulator frame counter the observation was captured at. */
    frame: EmulatorFrameSchema,
  })
  .strict();

const GbaPartyMemberSchema = z
  .object({
    slot: z.number().int().min(0).max(5),
    speciesId: z.string().min(1).max(128),
    level: z.number().int().positive().max(100),
    currentHp: z.number().int().nonnegative().max(9_999),
    maxHp: z.number().int().positive().max(9_999),
    status: z.enum(["healthy", "fainted"]),
  })
  .strict()
  .refine((member) => member.currentHp <= member.maxHp, { path: ["currentHp"], message: "HP exceeds max" });

const GbaMoveSchema = z
  .object({ moveId: z.string().min(1).max(128), power: z.number().int().nonnegative().max(999) })
  .strict();

/**
 * One tile's walkability. `passable` is the collision bit and nothing more: it
 * does not model ledges, water, or elevation changes, so an open tile means
 * "not a wall" rather than "reachable on foot".
 */
const GbaTileViewSchema = z
  .object({
    x: z.number().int().min(-1).max(1_024),
    y: z.number().int().min(-1).max(1_024),
    passable: z.boolean(),
    elevation: z.number().int().min(0).max(15).nullable(),
    metatileId: z.number().int().min(0).max(1_023).nullable(),
  })
  .strict();

const GbaSurroundingsSchema = z
  .object({
    north: GbaTileViewSchema,
    east: GbaTileViewSchema,
    south: GbaTileViewSchema,
    west: GbaTileViewSchema,
    /** The tile being faced — what an A press would interact with. */
    ahead: GbaTileViewSchema,
  })
  .strict();

export const GbaEmulatorObservationSchema = z.discriminatedUnion("kind", [
  GbaEmulatorObservationBaseSchema.extend({
    kind: z.literal("overworld"),
    data: z
      .object({
        position: GbaMapPositionSchema,
        facing: z.enum(["north", "east", "south", "west"]),
        /**
         * Collision around the player. Absent when no map grid is loaded, which
         * is a real state (battle, mid-warp) rather than a decode failure.
         */
        surroundings: GbaSurroundingsSchema.nullish(),
        mapSize: z
          .object({
            width: z.number().int().positive().max(1_024),
            height: z.number().int().positive().max(1_024),
          })
          .strict()
          .nullish(),
        ramStateSha256: Sha256Schema,
      })
      .strict(),
  }).strict(),
  GbaEmulatorObservationBaseSchema.extend({
    kind: z.literal("menu"),
    data: z
      .object({
        menuId: z.string().min(1).max(128),
        cursor: z.number().int().nonnegative().max(63),
        entries: z
          .array(z.object({ id: z.string().min(1).max(128), label: z.string().min(1).max(256) }).strict())
          .min(1)
          .max(16),
        untrusted: z.literal(true),
      })
      .strict(),
  }).strict(),
  GbaEmulatorObservationBaseSchema.extend({
    kind: z.literal("party"),
    data: z
      .object({ activeSlot: z.number().int().min(0).max(5), members: z.array(GbaPartyMemberSchema).max(6) })
      .strict(),
  }).strict(),
  GbaEmulatorObservationBaseSchema.extend({
    kind: z.literal("inventory"),
    data: z
      .object({
        items: z
          .array(
            z
              .object({
                pocket: z.enum(["items", "key-items", "poke-balls", "tm-hm", "berries"]),
                itemId: z.string().min(1).max(128),
                count: z.number().int().positive().max(999),
              })
              .strict(),
          )
          .max(186),
      })
      .strict(),
  }).strict(),
  GbaEmulatorObservationBaseSchema.extend({
    kind: z.literal("battle"),
    data: z
      .object({
        battleId: z.string().min(1).max(128),
        turn: z.number().int().positive().max(10_000),
        phase: z.enum(["awaiting_input", "resolving", "won", "lost"]),
        opponent: z
          .object({
            speciesId: z.string().min(1).max(128),
            level: z.number().int().positive().max(100),
            currentHp: z.number().int().nonnegative().max(9_999),
            maxHp: z.number().int().positive().max(9_999),
          })
          .strict(),
        activePartySlot: z.number().int().min(0).max(5),
        moveCursor: z.number().int().nonnegative().max(3),
        legalMoves: z.array(GbaMoveSchema).min(1).max(4),
        untrusted: z.literal(true),
      })
      .strict(),
  }).strict(),
  GbaEmulatorObservationBaseSchema.extend({
    kind: z.literal("dialog"),
    data: z
      .object({
        speaker: z.string().min(1).max(128),
        lines: z.array(z.string().max(512)).max(8),
        lineIndex: z.number().int().nonnegative().max(7),
        untrusted: z.literal(true),
      })
      .strict(),
  }).strict(),
  GbaEmulatorObservationBaseSchema.extend({
    kind: z.literal("frame_reference"),
    data: z
      .object({
        artifactId: z.string().min(1).max(256),
        uri: z.string().regex(/^artifact:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u),
        framebufferSha256: Sha256Schema,
        ramStateSha256: Sha256Schema,
        summary: ObservationSummarySchema,
      })
      .strict(),
  }).strict(),
  GbaEmulatorObservationBaseSchema.extend({
    kind: z.literal("danger"),
    data: z
      .object({
        severity: z.enum(["low", "medium", "high", "critical"]),
        code: z.enum(["uncertain_state", "desync_detected", "input_bound", "policy_boundary"]),
        summary: ObservationSummarySchema,
        stateCertain: z.boolean(),
      })
      .strict(),
  }).strict(),
  GbaEmulatorObservationBaseSchema.extend({
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
export type GbaEmulatorObservation = z.infer<typeof GbaEmulatorObservationSchema>;
export type GbaEmulatorObservationKind = GbaEmulatorObservation["kind"];

/**
 * The observation kinds as a runtime schema, so a consumer that must validate a
 * caller-supplied kind — an MCP tool argument, say — uses this one surface
 * rather than declaring its own list.
 */
export const GbaEmulatorObservationKindSchema = z.enum([
  "overworld",
  "menu",
  "party",
  "inventory",
  "battle",
  "dialog",
  "frame_reference",
  "danger",
  "action",
]);
// Compile-time guard: the enum and the union cannot drift apart silently.
const _observationKindsMatch: GbaEmulatorObservationKind = "overworld" as z.infer<
  typeof GbaEmulatorObservationKindSchema
>;
void _observationKindsMatch;

export const GbaEmulatorToolNameSchema = z.enum([
  "gba_emulator_join",
  "gba_emulator_status",
  "gba_emulator_cancel_join",
  "gba_emulator_steer",
  "gba_emulator_pause",
  "gba_emulator_resume",
  "gba_emulator_disconnect",
  "gba_emulator_observe",
  "gba_emulator_start_action",
  "gba_emulator_action_status",
  "gba_emulator_cancel_action",
]);
export type GbaEmulatorToolName = z.infer<typeof GbaEmulatorToolNameSchema>;

const emulatorToolSetsFor = (
  phase: EnvironmentSessionPhase,
  lane: CaptainLaneV1,
): { lifecycleTools: GbaEmulatorToolName[]; gameplayTools: GbaEmulatorToolName[] } => {
  if (phase === "off" || phase === "failed") {
    return { lifecycleTools: ["gba_emulator_join", "gba_emulator_status"], gameplayTools: [] };
  }
  if (phase === "starting") {
    return { lifecycleTools: ["gba_emulator_status", "gba_emulator_cancel_join"], gameplayTools: [] };
  }
  if (phase === "paused") {
    return {
      lifecycleTools: ["gba_emulator_status", "gba_emulator_resume", "gba_emulator_disconnect"],
      gameplayTools: [],
    };
  }
  if (phase === "stopping") return { lifecycleTools: ["gba_emulator_status"], gameplayTools: [] };
  if (lane === "gameplay") {
    return {
      lifecycleTools: ["gba_emulator_status", "gba_emulator_pause", "gba_emulator_disconnect"],
      gameplayTools: [
        "gba_emulator_observe",
        "gba_emulator_start_action",
        "gba_emulator_action_status",
        "gba_emulator_cancel_action",
      ],
    };
  }
  return {
    lifecycleTools: [
      "gba_emulator_status",
      "gba_emulator_steer",
      "gba_emulator_pause",
      "gba_emulator_disconnect",
    ],
    gameplayTools: [],
  };
};

export const GbaEmulatorToolExposureSchema = z
  .object({
    schemaVersion: z.literal(GBA_EMULATOR_CONTRACT_SCHEMA_VERSION),
    environmentKind: z.literal("gba_emulator"),
    phase: EnvironmentSessionPhaseSchema,
    lane: CaptainLaneSchema,
    lifecycleTools: z.array(GbaEmulatorToolNameSchema).max(8),
    gameplayTools: z.array(GbaEmulatorToolNameSchema).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = emulatorToolSetsFor(value.phase, value.lane);
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
export type GbaEmulatorToolExposure = z.infer<typeof GbaEmulatorToolExposureSchema>;

export function resolveGbaEmulatorToolExposure(
  phase: EnvironmentSessionPhase,
  lane: CaptainLaneV1,
): GbaEmulatorToolExposure {
  return GbaEmulatorToolExposureSchema.parse({
    schemaVersion: GBA_EMULATOR_CONTRACT_SCHEMA_VERSION,
    environmentKind: "gba_emulator",
    phase,
    lane,
    ...emulatorToolSetsFor(phase, lane),
  });
}

export const GBA_EMULATOR_LOCAL_CAPABILITIES = [
  "emulator.gba.observe",
  "emulator.gba.input",
  "emulator.gba.frame_advance",
  "emulator.gba.wait",
] as const;
export const GbaEmulatorLocalCapabilitySchema = z.enum(GBA_EMULATOR_LOCAL_CAPABILITIES);
export type GbaEmulatorLocalCapability = z.infer<typeof GbaEmulatorLocalCapabilitySchema>;

/**
 * The emulator embodiment is local-only: input injection and framebuffer/RAM
 * observation against a locally-run emulator core. It owns no network or
 * networked-service-tampering capabilities, and the schema cannot represent
 * one — both boundary arrays reject every element.
 */
export const GbaEmulatorCapabilityBoundarySchema = z
  .object({
    schemaVersion: z.literal(GBA_EMULATOR_CONTRACT_SCHEMA_VERSION),
    environmentKind: z.literal("gba_emulator"),
    localCapabilities: z.tuple([
      z.literal(GBA_EMULATOR_LOCAL_CAPABILITIES[0]),
      z.literal(GBA_EMULATOR_LOCAL_CAPABILITIES[1]),
      z.literal(GBA_EMULATOR_LOCAL_CAPABILITIES[2]),
      z.literal(GBA_EMULATOR_LOCAL_CAPABILITIES[3]),
    ]),
    networkCapabilities: z.array(z.never()).max(0),
    remoteTamperCapabilities: z.array(z.never()).max(0),
  })
  .strict();

export const GBA_EMULATOR_CAPABILITY_BOUNDARY = GbaEmulatorCapabilityBoundarySchema.parse({
  schemaVersion: GBA_EMULATOR_CONTRACT_SCHEMA_VERSION,
  environmentKind: "gba_emulator",
  localCapabilities: GBA_EMULATOR_LOCAL_CAPABILITIES,
  networkCapabilities: [],
  remoteTamperCapabilities: [],
});

export function isGbaEmulatorCapabilityLocal(capability: string): capability is GbaEmulatorLocalCapability {
  return GbaEmulatorLocalCapabilitySchema.safeParse(capability).success;
}
