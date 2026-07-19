import {
  ActionIdSchema,
  CaptainLaneSchema,
  CharacterIdSchema,
  EnvironmentSessionIdSchema,
  WorldIdSchema,
} from "@clankie/protocol";
import { z } from "zod";
import {
  EnvironmentActionStatusSchema,
  EnvironmentActionStatusCommandSchema,
  EnvironmentCancelActionCommandSchema,
  EnvironmentCancelJoinCommandSchema,
  EnvironmentDisconnectCommandSchema,
  EnvironmentJoinCommandSchema,
  EnvironmentPauseCommandSchema,
  EnvironmentResumeCommandSchema,
  EnvironmentSessionPhaseSchema,
  EnvironmentStartActionCommandSchema,
  EnvironmentStatusCommandSchema,
  EnvironmentSteerCommandSchema,
  INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION,
  normalizeEnvironmentSessionSpec,
  type EnvironmentSessionPhase,
} from "./environment.ts";
import type { CaptainLane } from "@clankie/protocol";

export const MinecraftPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  dimension: z.string().min(1),
});
export type MinecraftPosition = z.infer<typeof MinecraftPositionSchema>;

export const MinecraftActionLimitsSchema = z.object({
  radius: z.number().positive(),
  timeoutMs: z.number().int().positive(),
  blockChangeQuota: z.number().int().nonnegative(),
  combatPolicy: z.enum(["none", "hostile_mobs", "players"]),
});
export type MinecraftActionLimits = z.infer<typeof MinecraftActionLimitsSchema>;

export const MinecraftActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), target: MinecraftPositionSchema }),
  z.object({
    kind: z.literal("follow"),
    entityId: z.string().min(1),
    distance: z.number().nonnegative(),
  }),
  z.object({ kind: z.literal("collect"), block: z.string().min(1), count: z.number().int().positive() }),
  z.object({ kind: z.literal("craft"), item: z.string().min(1), count: z.number().int().positive() }),
  z.object({ kind: z.literal("smelt"), item: z.string().min(1), count: z.number().int().positive() }),
  z.object({
    kind: z.literal("equip"),
    item: z.string().min(1),
    slot: z.enum(["hand", "off_hand", "head", "torso", "legs", "feet"]),
  }),
  z.object({ kind: z.literal("place"), block: z.string().min(1), position: MinecraftPositionSchema }),
  z.object({ kind: z.literal("interact"), targetId: z.string().min(1) }),
  z.object({
    kind: z.literal("attack"),
    entityId: z.string().min(1),
    targetKind: z.enum(["hostile_mob", "player"]),
  }),
  z.object({ kind: z.literal("eat"), item: z.string().min(1).optional() }),
  z.object({ kind: z.literal("sleep"), bedPosition: MinecraftPositionSchema.optional() }),
  z.object({ kind: z.literal("wait"), durationMs: z.number().int().positive() }),
]);
export type MinecraftAction = z.infer<typeof MinecraftActionSchema>;

export const MinecraftActionRequestSchema = z.object({
  kind: z.literal("minecraft_action"),
  action: MinecraftActionSchema,
  limits: MinecraftActionLimitsSchema,
});
export type MinecraftActionRequest = z.infer<typeof MinecraftActionRequestSchema>;

export const MinecraftStartActionCommandSchema = EnvironmentStartActionCommandSchema.extend({
  action: MinecraftActionRequestSchema,
});
export type MinecraftStartActionCommand = z.infer<typeof MinecraftStartActionCommandSchema>;

export const MinecraftJoinCommandSchema = EnvironmentJoinCommandSchema.superRefine((command, context) => {
  const session = normalizeEnvironmentSessionSpec(command.session);
  if (session.environmentKind !== "minecraft_java" || session.resourceBounds.profile !== "minecraft_java") {
    context.addIssue({
      code: "custom",
      path: ["session", "environmentKind"],
      message: "Minecraft join requires the minecraft_java resource profile",
    });
  }
});

export const MinecraftCommandSchema = z.discriminatedUnion("type", [
  MinecraftJoinCommandSchema,
  EnvironmentStatusCommandSchema,
  EnvironmentCancelJoinCommandSchema,
  MinecraftStartActionCommandSchema,
  EnvironmentActionStatusCommandSchema,
  EnvironmentCancelActionCommandSchema,
  EnvironmentSteerCommandSchema,
  EnvironmentPauseCommandSchema,
  EnvironmentResumeCommandSchema,
  EnvironmentDisconnectCommandSchema,
]);
export type MinecraftCommand = z.infer<typeof MinecraftCommandSchema>;

const MinecraftObservationBaseSchema = z.object({
  schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
  observationId: z.string().min(1),
  sessionId: EnvironmentSessionIdSchema,
  characterId: CharacterIdSchema,
  worldId: WorldIdSchema,
  goalVersion: z.number().int().nonnegative(),
  capturedAt: z.string().datetime(),
});

export const MinecraftObservationSchema = z.discriminatedUnion("kind", [
  MinecraftObservationBaseSchema.extend({
    kind: z.literal("presence"),
    data: z.object({
      position: MinecraftPositionSchema,
      health: z.number().min(0),
      food: z.number().min(0),
      gameMode: z.string().min(1),
    }),
  }),
  MinecraftObservationBaseSchema.extend({
    kind: z.literal("inventory"),
    data: z.object({
      slots: z
        .array(
          z.object({
            slot: z.number().int().nonnegative(),
            item: z.string().min(1),
            count: z.number().int().positive(),
          }),
        )
        .max(64),
    }),
  }),
  MinecraftObservationBaseSchema.extend({
    kind: z.literal("entities"),
    data: z.object({
      entities: z
        .array(
          z.object({ id: z.string().min(1), kind: z.string().min(1), distance: z.number().nonnegative() }),
        )
        .max(256),
    }),
  }),
  MinecraftObservationBaseSchema.extend({
    kind: z.literal("action"),
    data: z.object({
      actionId: ActionIdSchema,
      status: EnvironmentActionStatusSchema,
      summary: z.string().min(1).max(1_024),
    }),
  }),
  MinecraftObservationBaseSchema.extend({
    kind: z.literal("danger"),
    data: z.object({
      severity: z.enum(["low", "medium", "high", "critical"]),
      summary: z.string().min(1).max(1_024),
    }),
  }),
  MinecraftObservationBaseSchema.extend({
    kind: z.literal("chat"),
    data: z.object({ source: z.string().min(1), content: z.string().max(4_096), untrusted: z.literal(true) }),
  }),
]);
export type MinecraftObservation = z.infer<typeof MinecraftObservationSchema>;

export const MinecraftToolNameSchema = z.enum([
  "minecraft_join",
  "minecraft_status",
  "minecraft_cancel_join",
  "minecraft_steer",
  "minecraft_pause",
  "minecraft_resume",
  "minecraft_disconnect",
  "minecraft_observe",
  "minecraft_start_action",
  "minecraft_action_status",
  "minecraft_cancel_action",
]);
export type MinecraftToolName = z.infer<typeof MinecraftToolNameSchema>;

const toolSetsFor = (
  phase: EnvironmentSessionPhase,
  lane: CaptainLane,
): { lifecycleTools: MinecraftToolName[]; gameplayTools: MinecraftToolName[] } => {
  if (phase === "off" || phase === "failed") {
    return { lifecycleTools: ["minecraft_join", "minecraft_status"], gameplayTools: [] };
  }
  if (phase === "starting") {
    return { lifecycleTools: ["minecraft_status", "minecraft_cancel_join"], gameplayTools: [] };
  }
  if (phase === "paused") {
    return {
      lifecycleTools: ["minecraft_status", "minecraft_resume", "minecraft_disconnect"],
      gameplayTools: [],
    };
  }
  if (phase === "stopping") {
    return { lifecycleTools: ["minecraft_status"], gameplayTools: [] };
  }
  if (lane === "gameplay") {
    return {
      lifecycleTools: ["minecraft_status", "minecraft_pause", "minecraft_disconnect"],
      gameplayTools: [
        "minecraft_observe",
        "minecraft_start_action",
        "minecraft_action_status",
        "minecraft_cancel_action",
      ],
    };
  }
  return {
    lifecycleTools: ["minecraft_status", "minecraft_steer", "minecraft_pause", "minecraft_disconnect"],
    gameplayTools: [],
  };
};

export const MinecraftToolExposureSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    phase: EnvironmentSessionPhaseSchema,
    lane: CaptainLaneSchema,
    lifecycleTools: z.array(MinecraftToolNameSchema),
    gameplayTools: z.array(MinecraftToolNameSchema),
  })
  .superRefine((value, context) => {
    const expected = toolSetsFor(value.phase, value.lane);
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
export type MinecraftToolExposure = z.infer<typeof MinecraftToolExposureSchema>;

export function resolveMinecraftToolExposure(
  phase: EnvironmentSessionPhase,
  lane: CaptainLane,
): MinecraftToolExposure {
  return MinecraftToolExposureSchema.parse({
    schemaVersion: INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION,
    phase,
    lane,
    ...toolSetsFor(phase, lane),
  });
}
