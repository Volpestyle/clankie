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
  "discord.presence.session.phase_changed",
  "captain.lane.started",
  "captain.lane.parked",
  "captain.lane.preempted",
  "captain.intent.accepted",
  "captain.intent.rejected_stale",
  "captain.intent.rejected_policy",
]);
export type EnvironmentSemanticEventType = z.infer<typeof EnvironmentSemanticEventTypeSchema>;

const SemanticReferenceSchema = z.string().min(1).max(1_024);
const SemanticSummarySchema = z.string().min(1).max(1_024);
const SemanticGoalVersionSchema = z.number().int().nonnegative();
const SemanticSourcePrioritySchema = z.enum([
  "gameplay_autonomy",
  "ambient_voice",
  "authenticated_tui",
  "safety",
]);
const SemanticGoalSchema = z
  .object({ kind: z.string().min(1).max(128), summary: z.string().min(1).max(512) })
  .strict();
const SemanticCancellationIntentSchema = z
  .object({
    type: z.literal("cancel_action"),
    actionId: ActionIdSchema,
    acceptedGoalVersion: SemanticGoalVersionSchema,
    replacementGoalVersion: SemanticGoalVersionSchema,
    reason: z.string().min(1).max(512),
  })
  .strict();
const SemanticPositionSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    dimension: z.string().min(1).max(256),
  })
  .strict();
const DiscordPresenceSemanticPhaseSchema = z.enum([
  "off",
  "connecting",
  "present",
  "voice_active",
  "go_live_active",
  "degraded",
  "failed",
]);
const DiscordPresenceSemanticSessionSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    sessionId: EnvironmentSessionIdSchema,
    characterId: CharacterIdSchema,
    credentialRef: SemanticReferenceSchema,
    transportKind: z.enum(["bot", "user_session"]),
    phase: DiscordPresenceSemanticPhaseSchema,
    gatewayConnected: z.boolean(),
    voiceGuildIds: z.array(SemanticReferenceSchema).max(64),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/**
 * Closed, bounded semantic payload inventory. Raw ticks, chunks, packets,
 * audio, and video have no shape here and must use EnvironmentTelemetryReferenceSchema.
 */
export const EnvironmentSemanticEventDataSchema = z.union([
  z.object({}).strict(),
  z.object({ characterId: CharacterIdSchema, worldId: WorldIdSchema }).strict(),
  z.object({ reason: SemanticSummarySchema }).strict(),
  z.object({ actionId: ActionIdSchema }).strict(),
  z.object({ actionId: ActionIdSchema, kind: z.string().min(1).max(128) }).strict(),
  z.object({ actionId: ActionIdSchema, errorCode: z.string().min(1).max(128) }).strict(),
  z.object({ actionId: ActionIdSchema, reason: SemanticSummarySchema }).strict(),
  z
    .object({
      actionId: ActionIdSchema,
      progress: z.number().min(0).max(1),
      summary: SemanticSummarySchema.optional(),
    })
    .strict(),
  z.object({ goalVersion: SemanticGoalVersionSchema, goal: SemanticGoalSchema }).strict(),
  z
    .object({
      previousGoalVersion: SemanticGoalVersionSchema,
      nextGoalVersion: SemanticGoalVersionSchema,
      supersededIntentId: SemanticReferenceSchema,
      cancellationIntent: SemanticCancellationIntentSchema.optional(),
    })
    .strict(),
  z
    .object({
      scenarioId: SemanticReferenceSchema,
      scenarioVersion: z.number().int().positive(),
      fixtureSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      reportSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
    })
    .strict(),
  z
    .object({
      commandType: z.enum(["set_goal", "steer", "pause", "resume", "stop", "disconnect"]),
      previousGoalVersion: SemanticGoalVersionSchema,
      nextGoalVersion: SemanticGoalVersionSchema,
      sourcePriority: SemanticSourcePrioritySchema,
    })
    .strict(),
  z
    .object({
      expectedGoalVersion: SemanticGoalVersionSchema,
      currentGoalVersion: SemanticGoalVersionSchema,
    })
    .strict(),
  z
    .object({
      currentGoalVersion: SemanticGoalVersionSchema,
      currentSourcePriority: SemanticSourcePrioritySchema.optional(),
      requestedSourcePriority: SemanticSourcePrioritySchema.optional(),
      reason: z.string().min(1).max(128).optional(),
    })
    .strict(),
  z
    .object({
      invalidatedIntentId: SemanticReferenceSchema,
      invalidatedByIntentId: SemanticReferenceSchema,
      baseGoalVersion: SemanticGoalVersionSchema,
      sourcePriority: SemanticSourcePrioritySchema,
    })
    .strict(),
  z
    .object({
      previousPhase: DiscordPresenceSemanticPhaseSchema,
      phase: DiscordPresenceSemanticPhaseSchema,
      reason: z.enum([
        "process_start",
        "gateway_ready",
        "gateway_resumed",
        "gateway_disconnected",
        "gateway_reconnecting",
        "voice_joined",
        "voice_left",
        "lease_lost",
        "gateway_failed",
        "publication_failed",
        "process_stopped",
      ]),
      session: DiscordPresenceSemanticSessionSchema,
    })
    .strict(),
  z
    .object({
      phase: EnvironmentSessionPhaseSchema,
      characterId: CharacterIdSchema,
      worldId: WorldIdSchema.optional(),
      position: SemanticPositionSchema.optional(),
    })
    .strict(),
  z
    .object({
      itemId: z.string().min(1).max(256),
      count: z.number().int().nonnegative(),
      delta: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      amount: z.number().positive(),
      health: z.number().nonnegative(),
      source: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({ reason: SemanticSummarySchema.optional(), position: SemanticPositionSchema.optional() })
    .strict(),
  z
    .object({
      severity: z.enum(["low", "medium", "high", "critical"]),
      summary: SemanticSummarySchema,
      artifactId: SemanticReferenceSchema.optional(),
    })
    .strict(),
  z
    .object({
      lane: z.enum(["tui", "operator", "discord_voice", "discord_presence", "gameplay"]),
      reason: SemanticSummarySchema.optional(),
    })
    .strict(),
]);
export type EnvironmentSemanticEventData = z.infer<typeof EnvironmentSemanticEventDataSchema>;

export const EnvironmentSemanticEventSchema = z
  .object({
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
    data: EnvironmentSemanticEventDataSchema,
  })
  .strict();
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
