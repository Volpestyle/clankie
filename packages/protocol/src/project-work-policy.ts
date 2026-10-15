import { z } from "zod";
import { HireProfileSchema, withoutNoPreference } from "./hire-profile.ts";

/** Started tracker issues, independent of the number of workers. Unset means no cap. */
export const ProjectWipCapSchema = z.number().int().min(1).max(1000);
export const ProjectOwnerLoopSchema = z.enum(["silent", "milestones", "landings"]);
export type ProjectOwnerLoop = z.infer<typeof ProjectOwnerLoopSchema>;
export const DEFAULT_PROJECT_OWNER_LOOP = "milestones" satisfies ProjectOwnerLoop;

/** Provider and observed subscription tier, for example claude:max_20x or codex:pro. */
export const HirePlanKeySchema = z.string().regex(/^(claude|codex):[a-z][a-z0-9_]{0,63}$/u);
const unique = <T extends z.ZodType<string>>(schema: T, max: number) =>
  z
    .array(schema)
    .max(max)
    .refine((values) => new Set(values).size === values.length, "Use unique entries");
/** Owner preferences constrain eligible hires; they never switch credentials or grant authority. */
export const ProjectHiringPolicySchema = z
  .object({
    lead: z.preprocess(withoutNoPreference, HireProfileSchema).optional(),
    worker: z.preprocess(withoutNoPreference, HireProfileSchema).optional(),
    /** A singleton pins a plan. Unset permits every otherwise eligible plan. */
    allowedPlans: unique(HirePlanKeySchema, 32).min(1).optional(),
    excludedPlans: unique(HirePlanKeySchema, 32).optional(),
    /** Canonical model ids from the model registry. Explicit profile model fields pin a model. */
    excludedModels: unique(z.string().trim().min(1).max(200), 64).optional(),
  })
  .strict();
export type ProjectHiringPolicy = z.infer<typeof ProjectHiringPolicySchema>;

/** Read-only receipt preserves exact saved values of controls retired by VUH-2256. */
export const RetiredWorkingPreferenceValuesSchema = z
  .object({
    size: z.enum(["max", "large", "small", "solo"]).optional(),
    models: z.enum(["optimal", "efficient"]).optional(),
    verification: z.enum(["review_and_seal", "change_run_read"]).optional(),
    reportingStyle: z.string().optional(),
    fleetEffort: z.string().optional(),
  })
  .strict();
export const RetiredWorkingPreferencesSchema = z
  .object({
    schemaVersion: z.literal(1),
    fleet: RetiredWorkingPreferenceValuesSchema,
    projects: z.record(z.string(), RetiredWorkingPreferenceValuesSchema),
  })
  .strict();
export type RetiredWorkingPreferences = z.infer<typeof RetiredWorkingPreferencesSchema>;
