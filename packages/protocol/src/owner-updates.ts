import { z } from "zod";
import { OperatorConversationIdSchema } from "./operator-conversations.ts";
import { MailIssueReferenceSchema, MailUrlSchema } from "./mail-reference.ts";

export const OWNER_UPDATE_LIST_MAX = 1000;
export const OWNER_UPDATE_CONVERSATION_MAX = 256;
export const OWNER_UPDATE_STATE_BYTES_MAX = 512_000;
export const OwnerUpdateStateSchema = z.enum(["unread", "read", "dismissed"]);
export const OwnerUpdateListFilterSchema = z
  .object({
    conversationId: OperatorConversationIdSchema.optional(),
    state: z.enum(["unread", "read", "dismissed", "all"]).optional(),
  })
  .strict();
export type OwnerUpdateListFilter = z.infer<typeof OwnerUpdateListFilterSchema>;

const content = {
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2000),
  issue: MailIssueReferenceSchema.optional(),
  links: z
    .array(
      z
        .object({
          label: z.string().trim().min(1).max(200),
          url: MailUrlSchema,
        })
        .strict(),
    )
    .max(8)
    .optional(),
  media: z
    .array(
      z
        .object({
          url: MailUrlSchema,
          mimeType: z.string().trim().min(1).max(100),
          alt: z.string().max(500).optional(),
        })
        .strict(),
    )
    .max(8)
    .optional(),
};
/** Deliberately mailed news; no answer, continuation or waiting state. */
export const OwnerUpdateDraftSchema = z
  .object({
    ...content,
    seatId: z.string().min(1).max(512).optional(),
  })
  .strict();
export type OwnerUpdateDraft = z.infer<typeof OwnerUpdateDraftSchema>;
export const OwnerUpdateSchema = z
  .object({
    ...content,
    id: z.string().uuid(),
    conversationId: OperatorConversationIdSchema,
    at: z.string().datetime(),
    source: z
      .object({
        conversationId: OperatorConversationIdSchema,
        seatId: z.string().min(1).max(512).optional(),
      })
      .strict(),
    state: OwnerUpdateStateSchema,
    readAt: z.string().datetime().optional(),
    dismissedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((update, context) => {
    if (update.source.conversationId !== update.conversationId) {
      context.addIssue({
        code: "custom",
        path: ["source", "conversationId"],
        message: "Source must match the update conversation",
      });
    }
    const validState =
      update.state === "unread"
        ? update.readAt === undefined && update.dismissedAt === undefined
        : update.state === "read"
          ? update.readAt !== undefined && update.dismissedAt === undefined
          : update.readAt !== undefined && update.dismissedAt !== undefined;
    if (!validState) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "Read and dismissal timestamps must match the update state",
      });
    }
  });
export type OwnerUpdate = z.infer<typeof OwnerUpdateSchema>;
export const OwnerUpdateListSchema = z
  .object({
    updates: z.array(OwnerUpdateSchema).max(OWNER_UPDATE_LIST_MAX),
  })
  .strict();
export type OwnerUpdateList = z.infer<typeof OwnerUpdateListSchema>;
export const OwnerUpdateResultSchema = z
  .object({
    status: z.enum(["ready", "resolved", "refused"]),
    update: OwnerUpdateSchema.optional(),
    reason: z.string().max(100).optional(),
  })
  .strict();
export type OwnerUpdateResult = z.infer<typeof OwnerUpdateResultSchema>;
