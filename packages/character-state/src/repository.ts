import { createHash } from "node:crypto";
import {
  OptimisticConcurrencyError,
  type ProjectionEventStore,
  type StoredEvent,
} from "@clankie/event-store";
import type { DomainEvent } from "@clankie/protocol";
import { compareSourcePriority, decideIntent, sourcePriority, type IntentArbiterOptions } from "./arbiter.ts";
import { characterStreamId, projectCharacterState } from "./projection.ts";
import {
  ArbiterDecisionSchema,
  BoundedIntentCommandSchema,
  MinecraftPresenceSchema,
  SharedFactSchema,
  SharedReferenceSchema,
  type ArbiterDecision,
  type CharacterState,
  type MinecraftPresence,
  type SharedFact,
  type SharedReference,
} from "./schema.ts";

const PROFILE_HASH = createHash("sha256").update("character-state:v1").digest("hex");

export interface CharacterWriteResult {
  readonly state: CharacterState;
  readonly stored: StoredEvent;
}

export interface IntentWriteResult extends CharacterWriteResult {
  readonly decision: ArbiterDecision;
}

export interface CharacterStateRepositoryOptions extends IntentArbiterOptions {
  readonly maxConcurrencyRetries?: number;
}

function eventId(characterId: string, kind: string, idempotencyKey: string): string {
  return createHash("sha256").update([characterId, kind, idempotencyKey].join("\0")).digest("hex");
}

export class CharacterStateRepository {
  private readonly store: ProjectionEventStore;
  private readonly options: CharacterStateRepositoryOptions;

  public constructor(store: ProjectionEventStore, options: CharacterStateRepositoryOptions = {}) {
    this.store = store;
    this.options = options;
  }

  public async load(characterId: string): Promise<CharacterState> {
    const entries = await this.store.readStream(characterStreamId(characterId));
    return projectCharacterState(
      entries.map((entry) => entry.event),
      characterId,
    );
  }

  public async submitIntent(input: unknown, expectedRevision: number): Promise<IntentWriteResult> {
    const command = BoundedIntentCommandSchema.parse(input);
    const payloadHash = fingerprint(command);
    let revision = expectedRevision;
    const maxRetries = this.options.maxConcurrencyRetries ?? 8;
    for (let attempt = 0; ; attempt += 1) {
      const existing = await this.findExisting(command.characterId, "intent", command.intentId, payloadHash);
      if (existing !== undefined) {
        return {
          decision: arbiterDecisionFromEvent(existing.event),
          stored: existing,
          state: await this.load(command.characterId),
        };
      }
      const current = await this.load(command.characterId);
      const decision = decideIntent(current, command, this.options);
      try {
        const stored = await this.append(
          command.characterId,
          revision,
          "intent",
          command.intentId,
          command.createdAt,
          command.context.correlationId,
          command.context.causationId,
          "character.intent.decided",
          payloadHash,
          { decision },
        );
        return {
          decision: arbiterDecisionFromEvent(stored.event),
          stored,
          state: await this.load(command.characterId),
        };
      } catch (error) {
        if (!(error instanceof OptimisticConcurrencyError)) {
          throw error;
        }
        const existingAfterConflict = await this.findExisting(
          command.characterId,
          "intent",
          command.intentId,
          payloadHash,
        );
        if (existingAfterConflict !== undefined) {
          return {
            decision: arbiterDecisionFromEvent(existingAfterConflict.event),
            stored: existingAfterConflict,
            state: await this.load(command.characterId),
          };
        }
        const latest = await this.load(command.characterId);
        if (attempt >= maxRetries || !shouldRetryIntent(command, latest)) throw error;
        revision = error.actualRevision;
      }
    }
  }

  public async recordPresence(
    presenceInput: unknown,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<CharacterWriteResult> {
    const presence = MinecraftPresenceSchema.parse(presenceInput);
    const payloadHash = fingerprint(presence);
    const existing = await this.findExisting(presence.characterId, "presence", idempotencyKey, payloadHash);
    if (existing !== undefined) {
      return { stored: existing, state: await this.load(presence.characterId) };
    }
    const current = await this.load(presence.characterId);
    if (presence.revision !== current.minecraft.revision + 1) {
      throw new Error("Minecraft presence revision is not the next version");
    }
    if (presence.goalVersion !== current.goalVersion) {
      throw new Error("Minecraft presence uses a stale goal version");
    }
    const stored = await this.append(
      presence.characterId,
      expectedRevision,
      "presence",
      idempotencyKey,
      presence.observedAt,
      idempotencyKey,
      undefined,
      "character.presence.recorded",
      payloadHash,
      { presence },
    );
    return { stored, state: await this.load(presence.characterId) };
  }

  public recordFact(
    characterId: string,
    factInput: unknown,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<CharacterWriteResult> {
    const fact = SharedFactSchema.parse(factInput);
    return this.appendMemory(
      characterId,
      expectedRevision,
      "fact",
      idempotencyKey,
      fact.observedAt,
      "character.fact.recorded",
      fingerprint(fact),
      { fact },
    );
  }

  public recordReference(
    characterId: string,
    referenceInput: unknown,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<CharacterWriteResult> {
    const reference = SharedReferenceSchema.parse(referenceInput);
    return this.appendMemory(
      characterId,
      expectedRevision,
      "reference",
      idempotencyKey,
      reference.observedAt,
      "character.reference.recorded",
      fingerprint(reference),
      { reference },
    );
  }

  private async appendMemory(
    characterId: string,
    expectedRevision: number,
    kind: string,
    idempotencyKey: string,
    occurredAt: string,
    type: DomainEvent["type"],
    payloadHash: string,
    data: Record<string, unknown>,
  ): Promise<CharacterWriteResult> {
    const existing = await this.findExisting(characterId, kind, idempotencyKey, payloadHash);
    if (existing !== undefined) {
      return { stored: existing, state: await this.load(characterId) };
    }
    const stored = await this.append(
      characterId,
      expectedRevision,
      kind,
      idempotencyKey,
      occurredAt,
      idempotencyKey,
      undefined,
      type,
      payloadHash,
      data,
    );
    return { stored, state: await this.load(characterId) };
  }

  private append(
    characterId: string,
    expectedRevision: number,
    kind: string,
    idempotencyKey: string,
    occurredAt: string,
    correlationId: string,
    causationId: string | undefined,
    type: DomainEvent["type"],
    payloadHash: string,
    data: Record<string, unknown>,
  ): Promise<StoredEvent> {
    const streamId = characterStreamId(characterId);
    return this.store.appendExpected(
      {
        id: eventId(characterId, kind, idempotencyKey),
        occurredAt,
        missionId: streamId,
        correlationId,
        ...(causationId === undefined ? {} : { causationId }),
        profileHash: PROFILE_HASH,
        type,
        data: { schemaVersion: 1, characterId, payloadHash, ...data },
      },
      { streamId, expectedRevision },
    );
  }

  private async findExisting(
    characterId: string,
    kind: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<StoredEvent | undefined> {
    const id = eventId(characterId, kind, idempotencyKey);
    const existing = (await this.store.readStream(characterStreamId(characterId))).find(
      (entry) => entry.event.id === id,
    );
    if (existing === undefined) return undefined;
    if (existing.event.data.payloadHash !== payloadHash) {
      throw new Error(`Idempotency key ${idempotencyKey} was reused with a different payload`);
    }
    return existing;
  }
}

function shouldRetryIntent(
  command: ReturnType<typeof BoundedIntentCommandSchema.parse>,
  state: CharacterState,
): boolean {
  const requested = sourcePriority(command.context);
  const active = [
    ...(state.activeGoal === undefined ? [] : [state.activeGoal.sourcePriority]),
    ...state.activeIntents.map((intent) => intent.sourcePriority),
  ];
  return active.some((priority) => compareSourcePriority(requested, priority) !== 0);
}

function arbiterDecisionFromEvent(event: DomainEvent): ArbiterDecision {
  if (event.type !== "character.intent.decided") throw new Error("Stored event is not an intent decision");
  return ArbiterDecisionSchema.parse(event.data.decision);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type { MinecraftPresence, SharedFact, SharedReference };
