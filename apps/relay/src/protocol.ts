import { z } from "zod";

export const RelayHelloSchema = z.object({
  type: z.literal("hello"),
  role: z.enum(["runner", "client"]),
  workspaceId: z.string().min(1),
  deviceId: z.string().min(1),
  token: z.string().min(16),
});

export const RelayEnvelopeSchema = z.object({
  type: z.literal("relay"),
  plane: z.enum(["control", "terminal"]),
  workspaceId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  payload: z.unknown(),
});

export type RelayHello = z.infer<typeof RelayHelloSchema>;
export type RelayEnvelope = z.infer<typeof RelayEnvelopeSchema>;

/**
 * The legacy development control tunnel is opaque, so it must deny approval
 * completion by semantic marker before routing. Approval reads/requests may
 * pass; approve/reject/record/complete actions never do.
 */
export function isApprovalCompletionPayload(payload: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (payload === null || typeof payload !== "object") return false;
  if (Array.isArray(payload)) {
    return payload.some((item) => isApprovalCompletionPayload(item, depth + 1));
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.approvalId === "string" &&
    ((typeof record.decision === "string" && /^(?:approved|rejected)$/iu.test(record.decision)) ||
      typeof record.approved === "boolean")
  ) {
    return true;
  }
  for (const [key, value] of Object.entries(payload)) {
    if (
      typeof value === "string" &&
      /^(?:type|op|action|path|route|kind)$/iu.test(key) &&
      /approvals?/iu.test(value) &&
      /(?:complete|approve|reject|record)/iu.test(value)
    ) {
      return true;
    }
    if (isApprovalCompletionPayload(value, depth + 1)) return true;
  }
  return false;
}
