import { z } from "zod";

export const SAFETY_PATH = "/v1/operator/safety";
export const SAFETY_APPROVALS_PATH = "/v1/operator/safety/approvals";
export const SafetyDecisionSchema = z.enum(["allow", "ask", "deny"]);
const BaseSafetySettingsSchema = z
  .object({
    codeExecution: z.enum(["direct", "delegate"]).default("direct"),
    defaultDecision: SafetyDecisionSchema.default("allow"),
    rules: z
      .array(z.object({ tool: z.string().trim().min(1).max(256), decision: SafetyDecisionSchema }).strict())
      .max(128)
      .default([]),
    instructions: z.string().max(8000).default(""),
  })
  .strict();
export const SafetySettingsSchema = BaseSafetySettingsSchema.superRefine((value, context) => {
  if (new Set(value.rules.map((rule) => rule.tool)).size !== value.rules.length)
    context.addIssue({ code: "custom", message: "Safety rule tool patterns must be unique" });
});
export type SafetySettings = z.infer<typeof SafetySettingsSchema>;
export const SafetyUpdateSchema = z
  .object({
    codeExecution: BaseSafetySettingsSchema.shape.codeExecution.removeDefault().optional(),
    defaultDecision: BaseSafetySettingsSchema.shape.defaultDecision.removeDefault().optional(),
    rules: BaseSafetySettingsSchema.shape.rules.removeDefault().optional(),
    instructions: BaseSafetySettingsSchema.shape.instructions.removeDefault().optional(),
  })
  .strict();
export const SafetyApprovalSchema = z
  .object({
    id: z.string().uuid(),
    scope: z.string().min(1).max(4096),
    tool: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.json()),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    expiresAt: z.string().datetime(),
    status: z.enum(["pending", "approved", "rejected", "consumed"]),
  })
  .strict();
export type SafetyApproval = z.infer<typeof SafetyApprovalSchema>;
export const SafetyApprovalAnswerSchema = z
  .object({ id: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), approve: z.boolean() })
  .strict();
export const SafetyStatusSchema = z.object({ safety: SafetySettingsSchema }).passthrough();
export const SafetyApprovalsSchema = z.object({ approvals: z.array(SafetyApprovalSchema) }).passthrough();
