import { z } from "zod";

/**
 * What an agent is for on the team (ADR 0208). Semantic, unlike the cosmetic
 * `appearance.accessory`: a surface places the agent at its role's station and
 * reads that role's backlog. Absent means unassigned.
 *
 * The built-ins are suggestions; any role is 1–24 letters, digits, spaces and
 * hyphens. Parsing trims, collapses inner whitespace and folds a built-in to
 * its lowercase name; a custom role keeps the owner's casing for display and
 * compares case-insensitively (`operatorAgentRoleKey`).
 */
export const OPERATOR_AGENT_ROLES = [
  "planner",
  "designer",
  "builder",
  "tester",
  "reviewer",
  "researcher",
] as const;
export type OperatorBuiltInAgentRole = (typeof OPERATOR_AGENT_ROLES)[number];
export const OPERATOR_AGENT_ROLE_MAX = 24;
export const OPERATOR_AGENT_ROLE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u;
/** Trim, collapse inner whitespace, and fold a built-in to its canonical name. */
export function normalizeOperatorAgentRole(value: string): string {
  const role = value.trim().replace(/\s+/gu, " ");
  return OPERATOR_AGENT_ROLES.find((builtIn) => builtIn === role.toLowerCase()) ?? role;
}
/** The comparison key: two roles are the same role when their keys are equal. */
export function operatorAgentRoleKey(role: string): string {
  return normalizeOperatorAgentRole(role).toLowerCase();
}
export const OperatorAgentRoleSchema = z
  .string()
  .overwrite(normalizeOperatorAgentRole)
  .min(1)
  .max(OPERATOR_AGENT_ROLE_MAX)
  .regex(OPERATOR_AGENT_ROLE_PATTERN, "Roles are letters, digits, spaces and hyphens");
export type OperatorAgentRole = z.infer<typeof OperatorAgentRoleSchema>;
/** One role in use or on offer; `count` is personas holding it, live or not. */
export const OperatorAgentRoleSummarySchema = z
  .object({
    role: OperatorAgentRoleSchema,
    builtIn: z.boolean(),
    count: z.number().int().min(0),
  })
  .strict();
export type OperatorAgentRoleSummary = z.infer<typeof OperatorAgentRoleSummarySchema>;
