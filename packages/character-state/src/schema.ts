import {
  EnvironmentSemanticEventSchema,
  EnvironmentSessionPhaseSchema,
  MinecraftPositionSchema,
  type EnvironmentSemanticEvent,
} from "@clankie/interactive-environment";
import {
  ActionIdSchema,
  CaptainLaneSchema,
  CharacterIdSchema,
  CharacterSnapshotSchema,
  CommandAuthoritySchema,
  EnvironmentSessionIdSchema,
  IntentCommandSchema,
  WorldIdSchema,
  type CharacterSnapshot,
} from "@clankie/protocol";
import { z } from "zod";

export const CHARACTER_STATE_SCHEMA_VERSION = 1 as const;
export const MAX_SHARED_FACTS = 64;
export const MAX_SHARED_REFERENCES = 64;
export const MAX_ACTIVE_INTENTS = 64;

export const CharacterSourcePrioritySchema = z.enum([
  "gameplay_autonomy",
  "ambient_voice",
  "authenticated_tui",
  "safety",
]);
export type CharacterSourcePriority = z.infer<typeof CharacterSourcePrioritySchema>;

export const CharacterGoalSchema = z
  .object({
    kind: z.string().min(1).max(128),
    summary: z.string().min(1).max(512),
  })
  .strict();
export type CharacterGoal = z.infer<typeof CharacterGoalSchema>;

const StrictIntentEnvelopeSchema = z
  .object({
    schemaVersion: z.unknown(),
    intentId: z.unknown(),
    characterId: z.unknown(),
    context: z.unknown(),
    type: z.unknown(),
    goal: CharacterGoalSchema.optional(),
    createdAt: z.unknown(),
  })
  .strict();

export const BoundedIntentCommandSchema = StrictIntentEnvelopeSchema.pipe(IntentCommandSchema).superRefine(
  (command, context) => {
    if (command.type !== "set_goal" && command.goal !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["goal"],
        message: "only set_goal may carry a goal",
      });
    }
  },
);
export type BoundedIntentCommand = z.infer<typeof BoundedIntentCommandSchema>;

const PRIVATE_CONTENT_MARKER =
  /(?:^|[^a-z0-9])(?:transcript|reasoning|chain[\s_-]*of[\s_-]*thought|continuation[\s_-]*token)(?:$|[^a-z0-9])/iu;
const PRIVATE_URI_SCHEME =
  /^(?:continuation[-_]?token|session[-_]?token|access[-_]?token|refresh[-_]?token|api[-_]?key|authorization|bearer|secret):/iu;

function rejectPrivateContent(
  entries: ReadonlyArray<readonly [string, string]>,
  context: z.RefinementCtx,
): void {
  for (const [field, value] of entries) {
    if (!PRIVATE_CONTENT_MARKER.test(value) && !PRIVATE_URI_SCHEME.test(value)) {
      continue;
    }
    context.addIssue({
      code: "custom",
      path: [field],
      message:
        `Shared memory rejects private transcript, reasoning, and token-scheme content in ${field}; ` +
        "store only a bounded factual summary or non-secret reference.",
    });
  }
}

export const SharedFactSchema = z
  .object({
    factId: z.string().min(1).max(128),
    key: z.string().min(1).max(128),
    value: z.string().min(1).max(512),
    observedAt: z.string().datetime(),
    sourceEventId: z.string().min(1),
  })
  .strict()
  .superRefine((fact, context) => {
    rejectPrivateContent(
      [
        ["factId", fact.factId],
        ["key", fact.key],
        ["value", fact.value],
        ["sourceEventId", fact.sourceEventId],
      ],
      context,
    );
  });
export type SharedFact = z.infer<typeof SharedFactSchema>;

export const SharedReferenceSchema = z
  .object({
    referenceId: z.string().min(1).max(128),
    kind: z.enum(["artifact", "mission", "task", "world", "attention"]),
    uri: z.string().min(1).max(1_024),
    summary: z.string().min(1).max(512),
    observedAt: z.string().datetime(),
    sourceEventId: z.string().min(1),
  })
  .strict()
  .superRefine((reference, context) => {
    rejectPrivateContent(
      [
        ["referenceId", reference.referenceId],
        ["uri", reference.uri],
        ["summary", reference.summary],
        ["sourceEventId", reference.sourceEventId],
      ],
      context,
    );
  });
export type SharedReference = z.infer<typeof SharedReferenceSchema>;

export const MinecraftPresenceSchema = z
  .object({
    schemaVersion: z.literal(CHARACTER_STATE_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    characterId: CharacterIdSchema,
    phase: EnvironmentSessionPhaseSchema,
    goalVersion: z.number().int().nonnegative(),
    observedAt: z.string().datetime(),
    sessionId: EnvironmentSessionIdSchema.optional(),
    worldId: WorldIdSchema.optional(),
    position: MinecraftPositionSchema.optional(),
    activeActionId: ActionIdSchema.optional(),
  })
  .strict()
  .superRefine((presence, context) => {
    if (presence.phase === "active" && (presence.sessionId === undefined || presence.worldId === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["sessionId"],
        message: "active Minecraft presence requires session and world identity",
      });
    }
    if (presence.activeActionId !== undefined && presence.phase !== "active") {
      context.addIssue({
        code: "custom",
        path: ["activeActionId"],
        message: "only active Minecraft presence may own an action",
      });
    }
  });
export type MinecraftPresence = z.infer<typeof MinecraftPresenceSchema>;

export const ActiveCharacterGoalSchema = z
  .object({
    goalVersion: z.number().int().positive(),
    intentId: z.string().min(1),
    goal: CharacterGoalSchema,
    sourceLane: CaptainLaneSchema,
    authority: CommandAuthoritySchema,
    sourcePriority: CharacterSourcePrioritySchema,
    acceptedAt: z.string().datetime(),
  })
  .strict();
export type ActiveCharacterGoal = z.infer<typeof ActiveCharacterGoalSchema>;

export const ActiveCharacterIntentSchema = z
  .object({
    intentId: z.string().min(1),
    baseGoalVersion: z.number().int().nonnegative(),
    commandType: z.enum(["steer", "pause", "resume", "stop", "disconnect"]),
    sourceLane: CaptainLaneSchema,
    authority: CommandAuthoritySchema,
    sourcePriority: CharacterSourcePrioritySchema,
    acceptedAt: z.string().datetime(),
  })
  .strict();
export type ActiveCharacterIntent = z.infer<typeof ActiveCharacterIntentSchema>;

export const CancellationIntentSchema = z
  .object({
    type: z.literal("cancel_action"),
    actionId: ActionIdSchema,
    acceptedGoalVersion: z.number().int().nonnegative(),
    replacementGoalVersion: z.number().int().nonnegative(),
    reason: z.string().min(1).max(512),
  })
  .strict();
export type CancellationIntent = z.infer<typeof CancellationIntentSchema>;

const DecisionBaseSchema = z.object({
  schemaVersion: z.literal(CHARACTER_STATE_SCHEMA_VERSION),
  intentId: z.string().min(1),
  characterId: CharacterIdSchema,
  commandType: z.enum(["set_goal", "steer", "pause", "resume", "stop", "disconnect"]),
  sourceLane: CaptainLaneSchema,
  authority: CommandAuthoritySchema,
  sourcePriority: CharacterSourcePrioritySchema,
  decidedAt: z.string().datetime(),
  semanticEvents: z.array(EnvironmentSemanticEventSchema).min(1),
});

export const ArbiterDecisionSchema = z.discriminatedUnion("status", [
  DecisionBaseSchema.extend({
    status: z.literal("accepted"),
    previousGoalVersion: z.number().int().nonnegative(),
    nextGoalVersion: z.number().int().nonnegative(),
    goal: CharacterGoalSchema.optional(),
    supersededIntentId: z.string().min(1).optional(),
    cancellationIntent: CancellationIntentSchema.optional(),
    invalidatedIntentIds: z.array(z.string().min(1)).max(MAX_ACTIVE_INTENTS).optional(),
  }).strict(),
  DecisionBaseSchema.extend({
    status: z.literal("rejected_stale"),
    expectedGoalVersion: z.number().int().nonnegative(),
    currentGoalVersion: z.number().int().nonnegative(),
  }).strict(),
  DecisionBaseSchema.extend({
    status: z.literal("rejected_policy"),
    currentGoalVersion: z.number().int().nonnegative(),
    currentSourcePriority: CharacterSourcePrioritySchema,
    reason: z.string().min(1).max(512),
  }).strict(),
]);
export type ArbiterDecision = z.infer<typeof ArbiterDecisionSchema>;

export const CharacterStateSchema = z
  .object({
    schemaVersion: z.literal(CHARACTER_STATE_SCHEMA_VERSION),
    characterId: CharacterIdSchema,
    revision: z.number().int().nonnegative(),
    goalVersion: z.number().int().nonnegative(),
    activeGoal: ActiveCharacterGoalSchema.optional(),
    activeIntents: z.array(ActiveCharacterIntentSchema).max(MAX_ACTIVE_INTENTS).default([]),
    minecraft: MinecraftPresenceSchema,
    sharedFacts: z.array(SharedFactSchema).max(MAX_SHARED_FACTS),
    sharedReferences: z.array(SharedReferenceSchema).max(MAX_SHARED_REFERENCES),
    lastDecision: ArbiterDecisionSchema.optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CharacterState = z.infer<typeof CharacterStateSchema>;

export function emptyCharacterState(characterId: string): CharacterState {
  return CharacterStateSchema.parse({
    schemaVersion: CHARACTER_STATE_SCHEMA_VERSION,
    characterId,
    revision: 0,
    goalVersion: 0,
    minecraft: {
      schemaVersion: CHARACTER_STATE_SCHEMA_VERSION,
      revision: 0,
      characterId,
      phase: "off",
      goalVersion: 0,
      observedAt: "1970-01-01T00:00:00.000Z",
    },
    sharedFacts: [],
    sharedReferences: [],
    activeIntents: [],
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
}

export function toCharacterSnapshot(state: CharacterState): CharacterSnapshot {
  const presence = state.minecraft;
  return CharacterSnapshotSchema.parse({
    schemaVersion: CHARACTER_STATE_SCHEMA_VERSION,
    characterId: state.characterId,
    goalVersion: state.goalVersion,
    ...(presence.worldId === undefined ? {} : { activeWorldId: presence.worldId }),
    ...(presence.sessionId === undefined ? {} : { activeEnvironmentSessionId: presence.sessionId }),
    ...(state.activeGoal === undefined ? {} : { goal: state.activeGoal.goal }),
    ...(presence.activeActionId === undefined ? {} : { activeActionId: presence.activeActionId }),
    sharedMemoryRefs: [
      ...state.sharedFacts.map((fact) => `fact:${fact.factId}`),
      ...state.sharedReferences.map((reference) => reference.uri),
    ],
    updatedAt: state.updatedAt,
  });
}

export type { EnvironmentSemanticEvent };
