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
export const ENVIRONMENT_SESSION_SCHEMA_VERSION = 2 as const;

export const EnvironmentSessionPhaseSchema = z.enum([
  "off",
  "starting",
  "active",
  "paused",
  "stopping",
  "failed",
]);
export type EnvironmentSessionPhase = z.infer<typeof EnvironmentSessionPhaseSchema>;

/** Frozen v1 shape. It is Minecraft-shaped and remains readable only through the v2 migration seam. */
export const EnvironmentResourceBoundsV1Schema = z
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
export type EnvironmentResourceBoundsV1 = z.infer<typeof EnvironmentResourceBoundsV1Schema>;

export const MinecraftResourceBoundsSchema = EnvironmentResourceBoundsV1Schema.extend({
  profile: z.literal("minecraft_java"),
}).strict();
export type MinecraftResourceBounds = z.infer<typeof MinecraftResourceBoundsSchema>;

export const LegacyEnvironmentResourceBoundsSchema = EnvironmentResourceBoundsV1Schema.extend({
  profile: z.literal("legacy_v1"),
  legacyEnvironmentKind: z.string().min(1),
}).strict();
export type LegacyEnvironmentResourceBounds = z.infer<typeof LegacyEnvironmentResourceBoundsSchema>;

export const PokeMMOSimulatorCapabilitySchema = z.enum([
  "pokemmo.simulator.observe",
  "pokemmo.simulator.navigate",
  "pokemmo.simulator.interact",
  "pokemmo.simulator.menu",
  "pokemmo.simulator.battle",
  "pokemmo.simulator.party",
  "pokemmo.simulator.inventory",
  "pokemmo.simulator.wait",
]);
export type PokeMMOSimulatorCapability = z.infer<typeof PokeMMOSimulatorCapabilitySchema>;

export const PokeMMOSimulatorResourceBoundsSchema = z
  .object({
    profile: z.literal("pokemmo_simulator"),
    simulatorId: z.string().min(1).max(128),
    worldId: WorldIdSchema,
    characterId: CharacterIdSchema,
    allowedMapIds: z.array(z.string().min(1).max(128)).min(1).max(64),
    maxNavigationStepsPerAction: z.number().int().positive().max(1_024),
    maxMenuChoicesPerAction: z.number().int().positive().max(64),
    maxBattleTurnsPerAction: z.number().int().positive().max(64),
    maxActionDurationMs: z.number().int().positive(),
    capabilities: z.array(PokeMMOSimulatorCapabilitySchema).min(1).max(8),
  })
  .strict();
export type PokeMMOSimulatorResourceBounds = z.infer<typeof PokeMMOSimulatorResourceBoundsSchema>;

export const EnvironmentResourceBoundsV2Schema = z.discriminatedUnion("profile", [
  MinecraftResourceBoundsSchema,
  LegacyEnvironmentResourceBoundsSchema,
  PokeMMOSimulatorResourceBoundsSchema,
]);
export type EnvironmentResourceBoundsV2 = z.infer<typeof EnvironmentResourceBoundsV2Schema>;

/** @deprecated Use EnvironmentResourceBoundsV2Schema for new sessions. */
export const EnvironmentResourceBoundsSchema = EnvironmentResourceBoundsV1Schema;
/** @deprecated Frozen v1 type retained for source compatibility. */
export type EnvironmentResourceBounds = EnvironmentResourceBoundsV1;

export const EnvironmentSessionSpecV1Schema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    sessionId: EnvironmentSessionIdSchema,
    environmentKind: z.string().min(1),
    characterId: CharacterIdSchema,
    worldId: WorldIdSchema,
    requestedBy: CommandAuthoritySchema,
    initialGoalVersion: z.number().int().nonnegative(),
    resourceBounds: EnvironmentResourceBoundsV1Schema,
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
export type EnvironmentSessionSpecV1 = z.infer<typeof EnvironmentSessionSpecV1Schema>;

export const EnvironmentSessionSpecV2Schema = z
  .object({
    schemaVersion: z.literal(ENVIRONMENT_SESSION_SCHEMA_VERSION),
    sessionId: EnvironmentSessionIdSchema,
    environmentKind: z.string().min(1),
    characterId: CharacterIdSchema,
    worldId: WorldIdSchema,
    requestedBy: CommandAuthoritySchema,
    initialGoalVersion: z.number().int().nonnegative(),
    resourceBounds: EnvironmentResourceBoundsV2Schema,
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
    const profile = session.resourceBounds.profile;
    if (profile !== "legacy_v1" && session.environmentKind !== profile) {
      context.addIssue({
        code: "custom",
        path: ["environmentKind"],
        message: "environment kind does not match the resource profile",
      });
    }
    if (profile === "legacy_v1" && session.environmentKind !== session.resourceBounds.legacyEnvironmentKind) {
      context.addIssue({
        code: "custom",
        path: ["environmentKind"],
        message: "environment kind does not match the legacy v1 binding",
      });
    }
  });
export type EnvironmentSessionSpecV2 = z.infer<typeof EnvironmentSessionSpecV2Schema>;

export const EnvironmentSessionSpecSchema = z.union([
  EnvironmentSessionSpecV2Schema,
  EnvironmentSessionSpecV1Schema,
]);
export type EnvironmentSessionSpec = z.infer<typeof EnvironmentSessionSpecSchema>;

export function normalizeEnvironmentSessionSpec(input: unknown): EnvironmentSessionSpecV2 {
  const parsed = EnvironmentSessionSpecSchema.parse(input);
  if (parsed.schemaVersion === ENVIRONMENT_SESSION_SCHEMA_VERSION) return parsed;
  const profile = parsed.environmentKind === "minecraft_java" ? "minecraft_java" : "legacy_v1";
  return EnvironmentSessionSpecV2Schema.parse({
    ...parsed,
    schemaVersion: ENVIRONMENT_SESSION_SCHEMA_VERSION,
    resourceBounds:
      profile === "minecraft_java"
        ? { profile, ...parsed.resourceBounds }
        : {
            profile,
            legacyEnvironmentKind: parsed.environmentKind,
            ...parsed.resourceBounds,
          },
  });
}

export const EnvironmentLeaseV1Schema = z
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
    resourceBounds: EnvironmentResourceBoundsV1Schema,
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
export type EnvironmentLeaseV1 = z.infer<typeof EnvironmentLeaseV1Schema>;

export const EnvironmentLeaseV2Schema = z
  .object({
    schemaVersion: z.literal(ENVIRONMENT_SESSION_SCHEMA_VERSION),
    leaseId: z.string().min(1),
    sessionId: EnvironmentSessionIdSchema,
    holderId: z.string().min(1),
    missionId: MissionIdSchema.optional(),
    taskId: TaskIdSchema.optional(),
    issuedAt: z.string().datetime(),
    heartbeatAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    resourceBounds: EnvironmentResourceBoundsV2Schema,
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
export type EnvironmentLeaseV2 = z.infer<typeof EnvironmentLeaseV2Schema>;

export const EnvironmentLeaseSchema = z.union([EnvironmentLeaseV2Schema, EnvironmentLeaseV1Schema]);
export type EnvironmentLease = z.infer<typeof EnvironmentLeaseSchema>;

export function normalizeEnvironmentLease(
  input: unknown,
  session: EnvironmentSessionSpecV2,
): EnvironmentLeaseV2 {
  const parsed = EnvironmentLeaseSchema.parse(input);
  if (parsed.sessionId !== session.sessionId) throw new Error("lease session binding mismatch");
  if (parsed.schemaVersion === ENVIRONMENT_SESSION_SCHEMA_VERSION) {
    if (JSON.stringify(parsed.resourceBounds) !== JSON.stringify(session.resourceBounds)) {
      throw new Error("lease resource profile mismatch");
    }
    return parsed;
  }
  return EnvironmentLeaseV2Schema.parse({
    ...parsed,
    schemaVersion: ENVIRONMENT_SESSION_SCHEMA_VERSION,
    resourceBounds: session.resourceBounds,
  });
}

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
  "pokemmo.session.started",
  "pokemmo.session.stopped",
  "pokemmo.session.disconnected",
  "pokemmo.goal.changed",
  "pokemmo.goal.superseded",
  "pokemmo.goal.verified",
  "pokemmo.goal.failed",
  "pokemmo.action.requested",
  "pokemmo.action.started",
  "pokemmo.action.completed",
  "pokemmo.action.cancelled",
  "pokemmo.action.failed",
  "pokemmo.attention.raised",
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
  telemetryKind: z.enum(["ticks", "chunks", "packets", "audio", "video", "frame"]),
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
