import { z } from "zod";
import { OperatorConversationIdSchema } from "./operator-conversations.ts";

export const OPERATOR_SEAT_MIGRATIONS_PATH = "/v1/captain/seat-migrations";
export const OperatorSeatMigrationSchema = z
  .object({
    id: z.uuid(),
    conversationId: OperatorConversationIdSchema,
    sessionId: z.uuid(),
    cwd: z.string().min(1),
    profile: z.string().min(1),
    processes: z
      .array(z.object({ pid: z.number().int().positive(), startTime: z.string().min(1) }).strict())
      .min(1)
      .max(1024),
    state: z.enum(["held", "resuming", "ready"]),
  })
  .strict();
export const OperatorSeatMigrationRequestSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("prepare"), id: z.uuid(), conversationId: OperatorConversationIdSchema })
    .strict(),
  z.object({ action: z.literal("status"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("complete"), id: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("claim"),
      id: z.uuid(),
      sessionId: z.uuid(),
      conversationId: OperatorConversationIdSchema,
      cwd: z.string().min(1),
      profile: z.string().min(1),
    })
    .strict(),
]);
export const OperatorSeatMigrationResultSchema = z.object({
  migration: OperatorSeatMigrationSchema,
  pendingReceiptIds: z.array(z.string()),
});
