import {
  EnvironmentSemanticEventSchema,
  type EnvironmentSemanticEvent,
} from "@clankie/interactive-environment";
import type { CommandAuthority, IntentContext } from "@clankie/protocol";
import {
  ArbiterDecisionSchema,
  BoundedIntentCommandSchema,
  CharacterGoalSchema,
  activeEnvironmentPresence,
  type ArbiterDecision,
  type CharacterSourcePriority,
  type CharacterState,
} from "./schema.ts";

export interface IntentArbiterOptions {
  readonly isTrustedSystemPrincipal?: (principal: CommandAuthority["principal"]) => boolean;
}

const PRIORITY: Readonly<Record<CharacterSourcePriority, number>> = {
  gameplay_autonomy: 100,
  ambient_voice: 200,
  authenticated_tui: 300,
  safety: 400,
};

export function sourcePriority(context: IntentContext): CharacterSourcePriority {
  if (context.authority.principal.kind === "system" && context.authority.tier === "system") {
    return "safety";
  }
  if (context.sourceLane === "tui" && context.authority.tier === "authenticated") {
    return "authenticated_tui";
  }
  if (
    (context.sourceLane === "discord_voice" || context.sourceLane === "discord_presence") &&
    context.authority.tier === "ambient"
  ) {
    return "ambient_voice";
  }
  return "gameplay_autonomy";
}

export function compareSourcePriority(left: CharacterSourcePriority, right: CharacterSourcePriority): number {
  return PRIORITY[left] - PRIORITY[right];
}

function semanticEvent(
  command: ReturnType<typeof BoundedIntentCommandSchema.parse>,
  type: EnvironmentSemanticEvent["type"],
  suffix: string,
  data: Record<string, unknown>,
  sessionId: string | undefined,
): EnvironmentSemanticEvent {
  return EnvironmentSemanticEventSchema.parse({
    schemaVersion: 1,
    plane: "semantic",
    id: `${command.intentId}:${suffix}`,
    type,
    occurredAt: command.createdAt,
    correlationId: command.context.correlationId,
    ...(command.context.causationId === undefined ? {} : { causationId: command.context.causationId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    data,
  });
}

export function decideIntent(
  state: CharacterState,
  input: unknown,
  options: IntentArbiterOptions = {},
): ArbiterDecision {
  const command = BoundedIntentCommandSchema.parse(input);
  if (command.characterId !== state.characterId) {
    throw new Error("Intent character does not match the projected character");
  }
  const priority = sourcePriority(command.context);
  const environmentPresence = activeEnvironmentPresence(state);
  const sessionId = environmentPresence?.sessionId ?? state.minecraft.sessionId;
  const base = {
    schemaVersion: 1 as const,
    intentId: command.intentId,
    characterId: command.characterId,
    commandType: command.type,
    sourceLane: command.context.sourceLane,
    authority: command.context.authority,
    sourcePriority: priority,
    decidedAt: command.createdAt,
  };

  if (
    priority === "safety" &&
    options.isTrustedSystemPrincipal?.(command.context.authority.principal) !== true
  ) {
    return ArbiterDecisionSchema.parse({
      ...base,
      status: "rejected_policy",
      currentGoalVersion: state.goalVersion,
      currentSourcePriority: highestActivePriority(state) ?? "gameplay_autonomy",
      reason: "Safety authority requires an explicitly trusted system principal",
      semanticEvents: [
        semanticEvent(
          command,
          "captain.intent.rejected_policy",
          "rejected-untrusted-system",
          {
            currentGoalVersion: state.goalVersion,
            requestedSourcePriority: priority,
            reason: "untrusted_system_principal",
          },
          sessionId,
        ),
      ],
    });
  }

  if (command.context.expectedGoalVersion !== state.goalVersion) {
    return ArbiterDecisionSchema.parse({
      ...base,
      status: "rejected_stale",
      expectedGoalVersion: command.context.expectedGoalVersion,
      currentGoalVersion: state.goalVersion,
      semanticEvents: [
        semanticEvent(
          command,
          "captain.intent.rejected_stale",
          "rejected-stale",
          {
            expectedGoalVersion: command.context.expectedGoalVersion,
            currentGoalVersion: state.goalVersion,
          },
          sessionId,
        ),
      ],
    });
  }

  const active = state.activeGoal;
  const currentSourcePriority = highestActivePriority(state);
  if (currentSourcePriority !== undefined && compareSourcePriority(priority, currentSourcePriority) < 0) {
    return ArbiterDecisionSchema.parse({
      ...base,
      status: "rejected_policy",
      currentGoalVersion: state.goalVersion,
      currentSourcePriority,
      reason: `${priority} cannot supersede ${currentSourcePriority}`,
      semanticEvents: [
        semanticEvent(
          command,
          "captain.intent.rejected_policy",
          "rejected-policy",
          {
            currentGoalVersion: state.goalVersion,
            currentSourcePriority,
            requestedSourcePriority: priority,
          },
          sessionId,
        ),
      ],
    });
  }

  const goal = command.type === "set_goal" ? CharacterGoalSchema.parse(command.goal) : undefined;
  const invalidatedIntentIds = state.activeIntents
    .filter((intent) =>
      goal === undefined
        ? compareSourcePriority(priority, intent.sourcePriority) > 0
        : compareSourcePriority(priority, intent.sourcePriority) >= 0,
    )
    .map((intent) => intent.intentId);
  const nextGoalVersion = goal === undefined ? state.goalVersion : state.goalVersion + 1;
  const activeActionId = environmentPresence?.activeActionId ?? state.minecraft.activeActionId;
  const cancellationIntent =
    activeActionId === undefined || goal === undefined
      ? undefined
      : {
          type: "cancel_action" as const,
          actionId: activeActionId,
          acceptedGoalVersion: state.goalVersion,
          replacementGoalVersion: nextGoalVersion,
          reason: `superseded by ${priority} intent ${command.intentId}`,
        };
  const events: EnvironmentSemanticEvent[] = [
    semanticEvent(
      command,
      "captain.intent.accepted",
      "accepted",
      {
        commandType: command.type,
        previousGoalVersion: state.goalVersion,
        nextGoalVersion,
        sourcePriority: priority,
      },
      sessionId,
    ),
  ];
  if (goal !== undefined) {
    events.push(
      semanticEvent(
        command,
        goalEventType(environmentPresence?.environmentKind, "changed"),
        "goal-changed",
        { goalVersion: nextGoalVersion, goal },
        sessionId,
      ),
    );
    if (active !== undefined) {
      events.push(
        semanticEvent(
          command,
          goalEventType(environmentPresence?.environmentKind, "superseded"),
          "goal-superseded",
          {
            previousGoalVersion: state.goalVersion,
            nextGoalVersion,
            supersededIntentId: active.intentId,
            ...(cancellationIntent === undefined ? {} : { cancellationIntent }),
          },
          sessionId,
        ),
      );
    }
  }
  for (const invalidatedIntentId of invalidatedIntentIds) {
    events.push(
      semanticEvent(
        command,
        "captain.lane.preempted",
        `preempted-${invalidatedIntentId}`,
        {
          invalidatedIntentId,
          invalidatedByIntentId: command.intentId,
          baseGoalVersion: state.goalVersion,
          sourcePriority: priority,
        },
        sessionId,
      ),
    );
  }

  return ArbiterDecisionSchema.parse({
    ...base,
    status: "accepted",
    previousGoalVersion: state.goalVersion,
    nextGoalVersion,
    ...(goal === undefined ? {} : { goal }),
    ...(active === undefined || goal === undefined ? {} : { supersededIntentId: active.intentId }),
    ...(cancellationIntent === undefined ? {} : { cancellationIntent }),
    ...(invalidatedIntentIds.length === 0 ? {} : { invalidatedIntentIds }),
    semanticEvents: events,
  });
}

function goalEventType(
  environmentKind: "minecraft_java" | "pokemmo_simulator" | undefined,
  transition: "changed" | "superseded",
): EnvironmentSemanticEvent["type"] {
  if (environmentKind === "pokemmo_simulator") return `pokemmo.goal.${transition}`;
  if (environmentKind === "minecraft_java" || environmentKind === undefined) {
    return `minecraft.goal.${transition}`;
  }
  return `environment.goal.${transition}`;
}

function highestActivePriority(state: CharacterState): CharacterSourcePriority | undefined {
  const priorities = [
    ...(state.activeGoal === undefined ? [] : [state.activeGoal.sourcePriority]),
    ...state.activeIntents.map((intent) => intent.sourcePriority),
  ];
  return priorities.reduce<CharacterSourcePriority | undefined>(
    (highest, priority) =>
      highest === undefined || compareSourcePriority(priority, highest) > 0 ? priority : highest,
    undefined,
  );
}
