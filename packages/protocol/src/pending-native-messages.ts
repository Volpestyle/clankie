import { z } from "zod";

export const PendingNativeMessageSchema = z.strictObject({
  messageId: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(128),
  text: z.string().max(16384),
  version: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  state: z.enum(["queued", "dispatching", "picked_up", "removed", "uncertain", "unavailable"]),
  detail: z.string().max(512).optional(),
});
export type PendingNativeMessage = z.infer<typeof PendingNativeMessageSchema>;
export const PendingNativeMessageActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({
    action: z.literal("remove"),
    messageId: z.string().min(1).max(128),
    expectedVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("send_now"),
    messageId: z.string().min(1).max(128),
    expectedVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("edit"),
    messageId: z.string().min(1).max(128),
    expectedVersion: z.number().int().nonnegative(),
    text: z.string().trim().min(1).max(16384),
  }),
]);
export type PendingNativeMessageAction = z.infer<typeof PendingNativeMessageActionSchema>;
export const PendingNativeMessagesResultSchema = z.strictObject({
  outcome: z.enum([
    "listed",
    "edited",
    "removed",
    "picked_up",
    "uncertain",
    "unavailable",
    "conflict",
    "unsupported",
  ]),
  messages: z.array(PendingNativeMessageSchema).max(100),
  detail: z.string().max(512).optional(),
});
export type PendingNativeMessagesResult = z.infer<typeof PendingNativeMessagesResultSchema>;
export const StopNativeTaskResultSchema = z.strictObject({
  outcome: z.enum(["stopped", "already_finished", "unsupported", "uncertain", "unavailable"]),
  taskId: z.string().min(1).max(512).optional(),
  detail: z.string().max(512).optional(),
});
export type StopNativeTaskResult = z.infer<typeof StopNativeTaskResultSchema>;
