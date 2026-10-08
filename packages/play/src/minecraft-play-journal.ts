/** Native Minecraft evidence projected for the existing journal audiences. */
import { z } from "zod";
import {
  MinecraftActionSchema,
  MinecraftActionStatusSchema,
  MinecraftObservationSchema,
  MinecraftSessionRefSchema,
} from "@clankie/protocol";
import { FreePlayUsageSchema } from "./free-play-usage.ts";
import { playDecisionFields } from "./play-decision.ts";

const usage = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().finite(),
  known: z.boolean(),
});
const decision = z.strictObject({
  ...playDecisionFields({ monologue: 1000, intent: 400, notes: 4000, objective: 1000 }, true),
  speakWanted: z.boolean(),
  action: MinecraftActionSchema.nullable(),
});
const memory = z.strictObject({
  notes: z.string().max(4000).nullable(),
  objective: z.string().max(1000).nullable(),
});
const outcome = z.enum([
  "settled",
  "waited",
  "mind_failed",
  "stale_decision",
  "action_failed",
  "budget_exhausted",
]);
const at = z.string().datetime();
const common = { schemaVersion: z.literal(2), at, connectionGeneration: z.number().int().nonnegative() };
const turn = z.strictObject({
  turn: z.number().int().nonnegative(),
  decision: decision.nullable(),
  outcome,
  effect: z.string().max(2000),
  action: MinecraftActionStatusSchema.nullable(),
  preemptions: z.number().int().nonnegative(),
  usage: z.array(usage).max(3),
});
export const MinecraftJournalPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("turn"),
    turn,
    before: MinecraftObservationSchema,
    after: MinecraftObservationSchema.optional(),
    memory,
    interjection: z.string().max(2000).nullable(),
    speakSuppressed: z.boolean(),
    narrationEvent: z.string().min(1).max(512).optional(),
    speechDeliveryId: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({ ...common, kind: z.literal("usage"), turn: z.number().int().nonnegative(), usage }),
  z.strictObject({
    ...common,
    kind: z.literal("decision"),
    turn: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    mode: z.string().max(2000),
    interjection: z.string().max(2000).nullable(),
    observation: MinecraftObservationSchema,
    decision,
  }),
  z.strictObject({
    ...common,
    kind: z.literal("notable"),
    event: z.strictObject({
      kind: z.enum(["stuck", "objective_retired_twice", "mind_unavailable", "world_ended"]),
      session: MinecraftSessionRefSchema,
      turn: z.number().int().nonnegative(),
      objective: z.string().max(1000).nullable(),
    }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("summary"),
    outcome: z.enum(["stopped", "budget_exhausted", "idle", "mind_unavailable", "world_ended"]),
    turnsTaken: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().finite(),
    unknownUsageCalls: z.number().int().nonnegative(),
    journalPath: z.string(),
    notes: memory.shape.notes,
    objective: memory.shape.objective,
    durationMs: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    usage: FreePlayUsageSchema,
  }),
]);
const projectedTurn = z.strictObject({
  kind: z.literal("turn"),
  schemaVersion: z.literal(2),
  game: z.literal("minecraft"),
  at,
  turn: z.strictObject({
    turn: z.number().int().nonnegative(),
    monologue: z.string().max(1000).nullable(),
    intent: z.string().max(400).nullable(),
    notes: memory.shape.notes,
    objective: memory.shape.objective,
    objectiveRetired: z.null(),
    interjection: z.string().max(2000).nullable(),
    speakWanted: z.boolean(),
    speakSuppressed: z.boolean(),
    action: MinecraftActionSchema.nullable(),
    outcome,
    effect: z.string().max(2000),
    effectAdvice: z.null(),
  }),
  evidence: z.null(),
  gameEvidence: z.strictObject({
    before: MinecraftObservationSchema,
    after: MinecraftObservationSchema.optional(),
    action: MinecraftActionStatusSchema.nullable(),
    preemptions: z.number().int().nonnegative(),
    usage: z.array(usage).max(3),
  }),
  screenshot: z.never().optional(),
  narrationEvent: z.string().optional(),
  speechDeliveryId: z.string().optional(),
});
const projectedSummary = z.strictObject({
  kind: z.literal("summary"),
  schemaVersion: z.literal(2),
  game: z.literal("minecraft"),
  at,
  outcome: z.string(),
  turnsTaken: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  usage: FreePlayUsageSchema,
  progress: z.strictObject({ maps: z.array(z.string()) }),
  screenshot: z.never().optional(),
});
export type MinecraftJournalLine = z.infer<typeof projectedTurn> | z.infer<typeof projectedSummary>;
export function projectMinecraftJournalPayload(raw: Record<string, unknown>): MinecraftJournalLine | null {
  const line = MinecraftJournalPayloadSchema.parse(raw);
  if (line.kind === "turn") {
    if (line.speechDeliveryId !== undefined && line.narrationEvent === undefined)
      throw new Error("play_journal_narration_missing");
    return projectedTurn.parse({
      kind: "turn",
      schemaVersion: 2,
      game: "minecraft",
      at: line.at,
      turn: {
        turn: line.turn.turn,
        monologue: line.turn.decision?.monologue ?? null,
        intent: line.turn.decision?.intent ?? null,
        notes: line.memory.notes,
        objective: line.memory.objective,
        objectiveRetired: null,
        interjection: line.interjection,
        speakWanted: line.turn.decision?.speakWanted ?? false,
        speakSuppressed: line.speakSuppressed,
        action: line.turn.decision?.action ?? null,
        outcome: line.turn.outcome,
        effect: line.turn.effect,
        effectAdvice: null,
      },
      evidence: null,
      gameEvidence: {
        before: line.before,
        ...(line.after ? { after: line.after } : {}),
        action: line.turn.action,
        preemptions: line.turn.preemptions,
        usage: line.turn.usage,
      },
      ...(line.narrationEvent ? { narrationEvent: line.narrationEvent } : {}),
      ...(line.speechDeliveryId ? { speechDeliveryId: line.speechDeliveryId } : {}),
    });
  }
  if (line.kind === "summary")
    return projectedSummary.parse({
      kind: "summary",
      schemaVersion: 2,
      game: "minecraft",
      at: line.at,
      outcome: line.outcome,
      turnsTaken: line.turnsTaken,
      accepted: line.accepted,
      durationMs: line.durationMs,
      usage: line.usage,
      progress: { maps: [] },
    });
  return null; // Valid diagnostic records remain in the canonical journal, not the story projection.
}
export const MinecraftJournalHeaderExtrasSchema = z.strictObject({
  at,
  connectionGeneration: z.number().int().nonnegative(),
  budget: z.strictObject({
    maxTokens: z.number().positive().finite(),
    maxCostUsd: z.number().positive().finite(),
    maxTurns: z.number().int().positive().optional(),
    maxDurationMs: z.number().nonnegative().finite().optional(),
  }),
});
