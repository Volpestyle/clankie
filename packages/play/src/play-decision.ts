import { z } from "zod";

/** Shared decision envelope; a game's action vocabulary and text limits stay local. */
interface DecisionBounds {
  monologue: number;
  intent: number;
  notes: number;
  objective: number;
}
type CommonFields = { monologue: z.ZodString; intent: z.ZodString };
export function playDecisionFields(
  bounds: DecisionBounds,
  requiredMemory: true,
): CommonFields & { notes: z.ZodNullable<z.ZodString>; objective: z.ZodNullable<z.ZodString> };
export function playDecisionFields(
  bounds: DecisionBounds,
  requiredMemory?: false,
): CommonFields & {
  notes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  objective: z.ZodOptional<z.ZodNullable<z.ZodString>>;
};
export function playDecisionFields(bounds: DecisionBounds, requiredMemory = false) {
  const notes = z.string().max(bounds.notes);
  const objective = z.string().max(bounds.objective);
  return {
    monologue: z.string().min(1).max(bounds.monologue),
    intent: z.string().min(1).max(bounds.intent),
    notes: requiredMemory ? notes.nullable() : notes.nullish(),
    objective: requiredMemory ? objective.nullable() : objective.nullish(),
  };
}
