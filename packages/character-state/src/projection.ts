import { DomainEventSchema, type DomainEvent } from "@clankie/protocol";
import { z } from "zod";
import {
  ArbiterDecisionSchema,
  CharacterStateSchema,
  EnvironmentPresenceSchema,
  MinecraftPresenceSchema,
  SharedFactSchema,
  SharedReferenceSchema,
  emptyCharacterState,
  MAX_ACTIVE_INTENTS,
  MAX_ENVIRONMENT_PRESENCES,
  MAX_SHARED_FACTS,
  MAX_SHARED_REFERENCES,
  type CharacterState,
} from "./schema.ts";

export const CharacterEventTypeSchema = z.enum([
  "character.intent.decided",
  "character.presence.recorded",
  "character.environment_presence.recorded",
  "character.fact.recorded",
  "character.reference.recorded",
]);
export type CharacterEventType = z.infer<typeof CharacterEventTypeSchema>;

function replaceBounded<T extends { readonly [key: string]: unknown }>(
  entries: readonly T[],
  next: T,
  key: keyof T,
  maximum: number,
): T[] {
  return [...entries.filter((entry) => entry[key] !== next[key]), next].slice(-maximum);
}

export function applyCharacterEvent(state: CharacterState, input: DomainEvent): CharacterState {
  const event = DomainEventSchema.parse(input);
  const type = CharacterEventTypeSchema.parse(event.type);
  if (event.missionId !== characterStreamId(state.characterId)) {
    throw new Error("Character event belongs to a different stream");
  }
  const common = {
    ...state,
    revision: state.revision + 1,
    updatedAt: event.occurredAt,
  };
  if (type === "character.intent.decided") {
    const decision = ArbiterDecisionSchema.parse(event.data.decision);
    if (decision.characterId !== state.characterId) throw new Error("Decision character mismatch");
    if (decision.status !== "accepted") {
      return CharacterStateSchema.parse({ ...common, lastDecision: decision });
    }
    if (decision.goal === undefined) {
      const invalidated = new Set(decision.invalidatedIntentIds ?? []);
      return CharacterStateSchema.parse({
        ...common,
        activeIntents: [
          ...state.activeIntents.filter((intent) => !invalidated.has(intent.intentId)),
          {
            intentId: decision.intentId,
            baseGoalVersion: state.goalVersion,
            commandType: decision.commandType,
            sourceLane: decision.sourceLane,
            authority: decision.authority,
            sourcePriority: decision.sourcePriority,
            acceptedAt: decision.decidedAt,
          },
        ].slice(-MAX_ACTIVE_INTENTS),
        lastDecision: decision,
      });
    }
    if (
      decision.previousGoalVersion !== state.goalVersion ||
      decision.nextGoalVersion !== state.goalVersion + 1
    ) {
      throw new Error("Accepted goal decision is not the next monotonic version");
    }
    return CharacterStateSchema.parse({
      ...common,
      goalVersion: decision.nextGoalVersion,
      activeGoal: {
        goalVersion: decision.nextGoalVersion,
        intentId: decision.intentId,
        goal: decision.goal,
        sourceLane: decision.sourceLane,
        authority: decision.authority,
        sourcePriority: decision.sourcePriority,
        acceptedAt: decision.decidedAt,
      },
      activeIntents: [],
      lastDecision: decision,
    });
  }
  if (type === "character.presence.recorded") {
    const presence = MinecraftPresenceSchema.parse(event.data.presence);
    if (presence.characterId !== state.characterId) throw new Error("Presence character mismatch");
    if (presence.revision !== state.minecraft.revision + 1) {
      throw new Error("Minecraft presence revision is not monotonic");
    }
    if (presence.goalVersion !== state.goalVersion) {
      throw new Error("Minecraft presence uses a stale goal version");
    }
    return CharacterStateSchema.parse({ ...common, minecraft: presence });
  }
  if (type === "character.environment_presence.recorded") {
    const presence = EnvironmentPresenceSchema.parse(event.data.presence);
    if (presence.characterId !== state.characterId) throw new Error("Presence character mismatch");
    const current = state.environments.find(
      (candidate) => candidate.environmentKind === presence.environmentKind,
    );
    if (presence.revision !== (current?.revision ?? 0) + 1) {
      throw new Error("Environment presence revision is not monotonic");
    }
    if (presence.goalVersion !== state.goalVersion) {
      throw new Error("Environment presence uses a stale goal version");
    }
    return CharacterStateSchema.parse({
      ...common,
      environments: replaceBounded(
        state.environments,
        presence,
        "environmentKind",
        MAX_ENVIRONMENT_PRESENCES,
      ),
    });
  }
  if (type === "character.fact.recorded") {
    const fact = SharedFactSchema.parse(event.data.fact);
    return CharacterStateSchema.parse({
      ...common,
      sharedFacts: replaceBounded(state.sharedFacts, fact, "factId", MAX_SHARED_FACTS),
    });
  }
  const reference = SharedReferenceSchema.parse(event.data.reference);
  return CharacterStateSchema.parse({
    ...common,
    sharedReferences: replaceBounded(state.sharedReferences, reference, "referenceId", MAX_SHARED_REFERENCES),
  });
}

export function projectCharacterState(events: readonly DomainEvent[], characterId: string): CharacterState {
  return events.reduce(applyCharacterEvent, emptyCharacterState(characterId));
}

export function characterStreamId(characterId: string): string {
  if (characterId.length === 0) throw new Error("Character id must not be empty");
  return `character:${characterId}`;
}
