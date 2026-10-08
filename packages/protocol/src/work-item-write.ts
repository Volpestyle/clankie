import { FreeAgentIntentSchema } from "./free-agent.ts";
import { z } from "zod";
import { WORK_ITEM_LABEL_MAX, WorkItemSchema, WorkRepoSchema } from "./work-items.ts";

const SingleLineSchema = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !/[\r\n]/u.test(value), "single line");

/** Owner-authorized changes to an existing item; no creation, deletion, or arbitrary field patch. */
export const WorkItemWriteCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), owner: SingleLineSchema(128).nullable() }).strict(),
  z.object({ action: z.literal("add_label"), label: SingleLineSchema(WORK_ITEM_LABEL_MAX) }).strict(),
  z.object({ action: z.literal("remove_label"), label: SingleLineSchema(WORK_ITEM_LABEL_MAX) }).strict(),
  z.object({ action: z.literal("add_dependency"), id: SingleLineSchema(64) }).strict(),
]);
export type WorkItemWriteCommand = z.infer<typeof WorkItemWriteCommandSchema>;

export const WorkItemWriteReceiptRequestSchema = z
  .object({
    repoId: WorkRepoSchema.shape.id,
    itemId: SingleLineSchema(64),
    /** The original intent's ID, also used for read-only reconciliation after transport loss. */
    requestId: z.string().uuid(),
  })
  .strict();
export type WorkItemWriteReceiptRequest = z.infer<typeof WorkItemWriteReceiptRequestSchema>;

export const WorkItemWriteRequestSchema = WorkItemWriteReceiptRequestSchema.extend({
  command: WorkItemWriteCommandSchema,
  freeAgent: FreeAgentIntentSchema.optional(),
}).strict();
export type WorkItemWriteRequest = z.infer<typeof WorkItemWriteRequestSchema>;

export const WorkItemWriteReceiptSchema = z
  .object({
    requestId: z.string().uuid(),
    outcome: z.enum(["applied", "refused", "uncertain"]),
    message: z.string().min(1).max(1000),
    item: WorkItemSchema.optional(),
  })
  .strict();
export type WorkItemWriteReceipt = z.infer<typeof WorkItemWriteReceiptSchema>;

/** Uncertainty retains the original intent ID; callers may read its receipt, never replay it. */
export function uncertainWorkItemWrite(requestId: string, message: string): WorkItemWriteReceipt {
  return { requestId, outcome: "uncertain", message };
}
