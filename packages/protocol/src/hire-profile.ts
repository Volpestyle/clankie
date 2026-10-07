import { z } from "zod";
import { OPERATOR_SEAT_HARNESSES } from "./seat-harnesses.ts";

const Model = z.string().trim().min(1).max(200);
export const HireEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
/** Launch preferences only; neither roles nor profiles confer native/tool authority. */
export const HireProfileSchema = z
  .object({
    harness: z.enum(OPERATOR_SEAT_HARNESSES).optional(),
    model: Model.optional(),
    effort: z.string().trim().min(1).max(64).optional(),
    subagents: z
      .object({ model: Model.optional(), effort: HireEffortSchema.optional() })
      .strict()
      .nullable()
      .optional(),
    delegation: z.enum(["native-first", "panes"]).optional(),
    account: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
      .optional(),
    placement: z.enum(["new-tab", "split"]).optional(),
  })
  .strict();
export type HireProfile = z.infer<typeof HireProfileSchema>;
/**
 * The owner's "no preference" spelling for a launch field. It is never stored:
 * the field stays unset, so the next layer or Clankie decides per hire.
 */
export const HIRE_NO_PREFERENCE = "auto";
/** Drops `auto` harness, model, effort and subagent model/effort from a profile-shaped value. */
export function withoutNoPreference(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const profile: Record<string, unknown> = { ...value };
  for (const key of ["harness", "model", "effort"])
    if (profile[key] === HIRE_NO_PREFERENCE) delete profile[key];
  const subagents = profile.subagents;
  if (typeof subagents === "object" && subagents !== null && !Array.isArray(subagents)) {
    const child: Record<string, unknown> = { ...subagents };
    for (const key of ["model", "effort"]) if (child[key] === HIRE_NO_PREFERENCE) delete child[key];
    if (Object.keys(child).length) profile.subagents = child;
    else delete profile.subagents;
  }
  return profile;
}
export type EffectiveHireProfile = HireProfile & { harness: (typeof OPERATOR_SEAT_HARNESSES)[number] };

/** Explicit hire fields win, then role fields, then fleet defaults. Nested fields inherit independently. */
export function effectiveHireProfile(
  request: HireProfile,
  role: HireProfile = {},
  fleet: HireProfile = {},
): EffectiveHireProfile {
  const defined = (value: HireProfile) =>
    Object.fromEntries(
      Object.entries(value).filter(([k, v]) => k in HireProfileSchema.shape && v !== undefined),
    );
  const result: Record<string, unknown> = {
    harness: "codex",
    ...defined(fleet),
    ...defined(role),
    ...defined(request),
  };
  const inherited = role.subagents === null ? {} : { ...fleet.subagents, ...role.subagents };
  const subagents = request.subagents === null ? {} : { ...inherited, ...request.subagents };
  delete result.subagents;
  if (Object.keys(subagents).length) result.subagents = subagents;
  return HireProfileSchema.parse(result) as EffectiveHireProfile;
}
