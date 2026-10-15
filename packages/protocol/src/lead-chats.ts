import { z } from "zod";
import { OperatorConversationSessionStateSchema } from "./operator-conversations.ts";
import { OperatorSeatBridgeStatusSchema } from "./fleet-messages.ts";

/** Private owner context; no transcripts, task content or credentials. */
export const LeadChatSchema = z
  .object({
    conversationId: z.string().min(1),
    title: z.string(),
    projects: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
    workspace: z.string(),
    machine: z.string(),
    holder: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("native"), seatId: z.string(), harness: z.string() }).strict(),
      z.object({ kind: z.literal("service"), lane: z.literal("operator") }).strict(),
    ]),
    state: z.union([OperatorSeatBridgeStatusSchema.shape.state, z.literal("service")]),
    activity: OperatorConversationSessionStateSchema,
    lastActiveAt: z.string(),
    lastBridgeSeenAt: z.string().optional(),
    messageSeat: z.string(),
    messageAvailable: z.boolean(),
    /** The native seat is usage-limited; until then this chat runs on the service lane (VUH-2273). */
    usageLimit: OperatorSeatBridgeStatusSchema.shape.usageLimit,
  })
  .strict();
export type LeadChat = z.infer<typeof LeadChatSchema>;
export const LeadChatsResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ready"), chats: z.array(LeadChatSchema) }).strict(),
  z.object({ outcome: z.literal("unavailable"), message: z.string() }).strict(),
]);
export type LeadChatsResult = z.infer<typeof LeadChatsResultSchema>;
