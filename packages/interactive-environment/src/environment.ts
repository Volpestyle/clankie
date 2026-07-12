import {
  ActionIdSchema,
  CharacterIdSchema,
  CommandAuthoritySchema,
  EnvironmentSessionIdSchema,
  IntentContextSchema,
  MissionIdSchema,
  TaskIdSchema,
  WorldIdSchema,
} from "@clankie/protocol";
import { z } from "zod";

export const INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION = 1 as const;

export const EnvironmentSessionPhaseSchema = z.enum([
  "off",
  "starting",
  "active",
  "paused",
  "stopping",
  "failed",
]);
export type EnvironmentSessionPhase = z.infer<typeof EnvironmentSessionPhaseSchema>;

export const EnvironmentResourceBoundsSchema = z
  .object({
    serverId: z.string().min(1),
    worldId: WorldIdSchema,
    characterId: CharacterIdSchema,
    allowedDimensions: z.array(z.string().min(1)).min(1),
    maxDistanceFromOrigin: z.number().positive(),
    maxActionDurationMs: z.number().int().positive(),
    maxBlockChangesPerAction: z.number().int().nonnegative(),
    capabilities: z.array(z.string().min(1)),
  })
  .strict();
export type EnvironmentResourceBounds = z.infer<typeof EnvironmentResourceBoundsSchema>;

export const EnvironmentSessionSpecSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    sessionId: EnvironmentSessionIdSchema,
    environmentKind: z.string().min(1),
    characterId: CharacterIdSchema,
    worldId: WorldIdSchema,
    requestedBy: CommandAuthoritySchema,
    initialGoalVersion: z.number().int().nonnegative(),
    resourceBounds: EnvironmentResourceBoundsSchema,
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
export type EnvironmentSessionSpec = z.infer<typeof EnvironmentSessionSpecSchema>;

export const EnvironmentLeaseSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    leaseId: z.string().min(1),
    sessionId: EnvironmentSessionIdSchema,
    holderId: z.string().min(1),
    missionId: MissionIdSchema.optional(),
    taskId: TaskIdSchema.optional(),
    issuedAt: z.string().datetime(),
    heartbeatAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    resourceBounds: EnvironmentResourceBoundsSchema,
  })
  .strict()
  .superRefine((lease, context) => {
    const issuedAt = Date.parse(lease.issuedAt);
    const heartbeatAt = Date.parse(lease.heartbeatAt);
    const expiresAt = Date.parse(lease.expiresAt);
    if (heartbeatAt < issuedAt || expiresAt <= heartbeatAt) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "lease timestamps are out of order" });
    }
  });
export type EnvironmentLease = z.infer<typeof EnvironmentLeaseSchema>;

export const EnvironmentActionStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "cancelled",
  "failed",
  "denied",
  "stale",
]);
export type EnvironmentActionStatus = z.infer<typeof EnvironmentActionStatusSchema>;

const EnvironmentActionResultBaseSchema = z.object({
  schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
  actionId: ActionIdSchema,
  sessionId: EnvironmentSessionIdSchema,
  updatedAt: z.string().datetime(),
});

export const EnvironmentActionHandleSchema = EnvironmentActionResultBaseSchema.extend({
  status: z.enum(["queued", "running"]),
  acceptedGoalVersion: z.number().int().nonnegative(),
});
export type EnvironmentActionHandle = z.infer<typeof EnvironmentActionHandleSchema>;

export const EnvironmentActionResultSchema = z.discriminatedUnion("status", [
  EnvironmentActionHandleSchema,
  EnvironmentActionResultBaseSchema.extend({
    status: z.literal("completed"),
    acceptedGoalVersion: z.number().int().nonnegative(),
    outcome: z.record(z.string(), z.unknown()),
  }),
  EnvironmentActionResultBaseSchema.extend({
    status: z.literal("cancelled"),
    acceptedGoalVersion: z.number().int().nonnegative(),
    reason: z.string().min(1),
  }),
  EnvironmentActionResultBaseSchema.extend({
    status: z.literal("failed"),
    acceptedGoalVersion: z.number().int().nonnegative(),
    errorCode: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
  EnvironmentActionResultBaseSchema.extend({
    status: z.literal("denied"),
    requestedGoalVersion: z.number().int().nonnegative(),
    reason: z.string().min(1),
    policyDecisionId: z.string().min(1),
  }),
  EnvironmentActionResultBaseSchema.extend({
    status: z.literal("stale"),
    expectedGoalVersion: z.number().int().nonnegative(),
    currentGoalVersion: z.number().int().nonnegative(),
  }),
]);
export type EnvironmentActionResult = z.infer<typeof EnvironmentActionResultSchema>;

const EnvironmentCommandBaseSchema = z.object({
  schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
  commandId: z.string().min(1),
  context: IntentContextSchema,
  requestedAt: z.string().datetime(),
});

export const EnvironmentJoinCommandSchema = EnvironmentCommandBaseSchema.extend({
  type: z.literal("join"),
  session: EnvironmentSessionSpecSchema,
}).superRefine((command, context) => {
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
export const EnvironmentStatusCommandSchema = EnvironmentCommandBaseSchema.extend({
  type: z.literal("status"),
  sessionId: EnvironmentSessionIdSchema.optional(),
});
export const EnvironmentCancelJoinCommandSchema = EnvironmentCommandBaseSchema.extend({
  type: z.literal("cancel_join"),
  sessionId: EnvironmentSessionIdSchema,
});
export const EnvironmentStartActionCommandSchema = EnvironmentCommandBaseSchema.extend({
  type: z.literal("start_action"),
  sessionId: EnvironmentSessionIdSchema,
  actionId: ActionIdSchema,
  action: z.object({ kind: z.string().min(1) }).passthrough(),
});
export const EnvironmentActionStatusCommandSchema = EnvironmentCommandBaseSchema.extend({
  type: z.literal("action_status"),
  sessionId: EnvironmentSessionIdSchema,
  actionId: ActionIdSchema,
});
export const EnvironmentCancelActionCommandSchema = EnvironmentCommandBaseSchema.extend({
  type: z.literal("cancel_action"),
  sessionId: EnvironmentSessionIdSchema,
  actionId: ActionIdSchema,
  reason: z.string().min(1),
});
export const EnvironmentSteerCommandSchema = EnvironmentCommandBaseSchema.extend({
  type: z.literal("steer"),
  sessionId: EnvironmentSessionIdSchema,
  intent: z.string().min(1),
});
export const EnvironmentPauseCommandSchema = EnvironmentCommandBaseSchema.extend({
  type: z.literal("pause"),
  sessionId: EnvironmentSessionIdSchema,
  reason: z.string().min(1),
});
export const EnvironmentResumeCommandSchema = EnvironmentCommandBaseSchema.extend({
  type: z.literal("resume"),
  sessionId: EnvironmentSessionIdSchema,
});
export const EnvironmentDisconnectCommandSchema = EnvironmentCommandBaseSchema.extend({
  type: z.literal("disconnect"),
  sessionId: EnvironmentSessionIdSchema,
  reason: z.string().min(1),
});

export const EnvironmentCommandSchema = z.discriminatedUnion("type", [
  EnvironmentJoinCommandSchema,
  EnvironmentStatusCommandSchema,
  EnvironmentCancelJoinCommandSchema,
  EnvironmentStartActionCommandSchema,
  EnvironmentActionStatusCommandSchema,
  EnvironmentCancelActionCommandSchema,
  EnvironmentSteerCommandSchema,
  EnvironmentPauseCommandSchema,
  EnvironmentResumeCommandSchema,
  EnvironmentDisconnectCommandSchema,
]);
export type EnvironmentCommand = z.infer<typeof EnvironmentCommandSchema>;

export const EnvironmentObservationSchema = z.object({
  schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
  observationId: z.string().min(1),
  sessionId: EnvironmentSessionIdSchema,
  characterId: CharacterIdSchema,
  worldId: WorldIdSchema,
  goalVersion: z.number().int().nonnegative(),
  capturedAt: z.string().datetime(),
  kind: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});
export type EnvironmentObservation = z.infer<typeof EnvironmentObservationSchema>;

export const EnvironmentSemanticEventTypeSchema = z.enum([
  "environment.session.started",
  "environment.session.stopped",
  "environment.session.disconnected",
  "environment.goal.changed",
  "environment.goal.superseded",
  "environment.goal.verified",
  "environment.goal.failed",
  "environment.action.requested",
  "environment.action.started",
  "environment.action.progressed",
  "environment.action.completed",
  "environment.action.cancelled",
  "environment.action.failed",
  "environment.presence.changed",
  "environment.inventory.changed",
  "environment.damage.taken",
  "environment.player.died",
  "environment.attention.raised",
  "minecraft.session.started",
  "minecraft.session.stopped",
  "minecraft.session.disconnected",
  "minecraft.goal.changed",
  "minecraft.goal.superseded",
  "minecraft.goal.verified",
  "minecraft.goal.failed",
  "minecraft.action.requested",
  "minecraft.action.started",
  "minecraft.action.progressed",
  "minecraft.action.completed",
  "minecraft.action.cancelled",
  "minecraft.action.failed",
  "minecraft.presence.changed",
  "minecraft.inventory.changed",
  "minecraft.damage.taken",
  "minecraft.player.died",
  "minecraft.attention.raised",
  "captain.lane.started",
  "captain.lane.parked",
  "captain.lane.preempted",
  "captain.intent.accepted",
  "captain.intent.rejected_stale",
  "captain.intent.rejected_policy",
]);
export type EnvironmentSemanticEventType = z.infer<typeof EnvironmentSemanticEventTypeSchema>;

export const EnvironmentSemanticEventSchema = z.object({
  schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
  plane: z.literal("semantic"),
  id: z.string().min(1),
  type: EnvironmentSemanticEventTypeSchema,
  occurredAt: z.string().datetime(),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  sessionId: EnvironmentSessionIdSchema.optional(),
  missionId: MissionIdSchema.optional(),
  taskId: TaskIdSchema.optional(),
  data: z.record(z.string(), z.unknown()),
});
export type EnvironmentSemanticEvent = z.infer<typeof EnvironmentSemanticEventSchema>;

export const EnvironmentTelemetryReferenceSchema = z.object({
  schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
  plane: z.literal("artifact_reference"),
  id: z.string().min(1),
  telemetryKind: z.enum(["ticks", "chunks", "packets", "audio", "video"]),
  sessionId: EnvironmentSessionIdSchema,
  correlationId: z.string().min(1),
  artifactId: z.string().min(1),
  uri: z.string().min(1),
  summary: z.string().min(1),
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});
export type EnvironmentTelemetryReference = z.infer<typeof EnvironmentTelemetryReferenceSchema>;

export const EnvironmentEventSchema = z.discriminatedUnion("plane", [
  EnvironmentSemanticEventSchema,
  EnvironmentTelemetryReferenceSchema,
]);
export type EnvironmentEvent = z.infer<typeof EnvironmentEventSchema>;
