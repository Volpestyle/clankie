import { z } from "zod";
import { AppNoteSchema } from "./fleet-room.ts";

export const LEAD_CHANGES_PAGE_MAX = 100;
export const LEAD_CHANGES_PAGE_BYTES = 64 * 1024;
const id = z.string().min(1).max(512);
const text = z.string().max(2000);
export const LeadChangeSourceSchema = z.enum([
  "worker_report",
  "inbox",
  "pane",
  "pull_request",
  "owner_ask",
  "board_note",
]);
export type LeadChangeSource = z.infer<typeof LeadChangeSourceSchema>;
export const LeadChangeItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("worker_report"),
      deliveryId: id,
      conversationId: id,
      receipt: id,
      reportKind: z.enum(["done", "blocked", "update"]).optional(),
      preview: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("inbox"),
      sequence: z.number().int().nonnegative(),
      conversationId: id,
      origin: id,
      preview: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pane"),
      agentId: id,
      occupantId: id,
      status: id,
      harness: id,
      machine: id,
      title: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pull_request"),
      repoId: id,
      url: z.string().url().max(2048),
      number: z.number().int().positive(),
      title: text,
      status: z.enum(["open", "merged", "closed"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("owner_ask"),
      conversationId: id,
      requestId: id,
      status: z.enum(["pending", "answered", "cancelled"]),
      preview: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("board_note"),
      sequence: z.number().int().positive(),
      author: text,
      text,
      to: AppNoteSchema.shape.to,
      wakes: AppNoteSchema.shape.wakes,
    })
    .strict(),
]);
export type LeadChangeItem = z.infer<typeof LeadChangeItemSchema>;
export const LeadChangeRecordSchema = z
  .object({
    id,
    revision: id,
    at: z.string().datetime({ offset: true }),
    state: z.enum(["active", "resolved", "superseded", "unknown"]),
    item: LeadChangeItemSchema,
  })
  .strict();
export type LeadChangeRecord = z.infer<typeof LeadChangeRecordSchema>;
export const LeadChangeEntrySchema = LeadChangeRecordSchema.extend({
  sequence: z.number().int().positive(),
  /** The source no longer retains this id; this does not assert the work was completed. */
  removed: z.literal(true).optional(),
}).strict();
export type LeadChangeEntry = z.infer<typeof LeadChangeEntrySchema>;
export const LeadChangeAvailabilitySchema = z
  .object({
    source: LeadChangeSourceSchema,
    status: z.enum(["ready", "unavailable"]),
    reason: z.string().max(256).optional(),
  })
  .strict();
export const LeadChangesReadSchema = z
  .object({
    since: z.string().min(1).max(1024).optional(),
    limit: z.number().int().min(1).max(LEAD_CHANGES_PAGE_MAX).optional(),
  })
  .strict();
export type LeadChangesRead = z.infer<typeof LeadChangesReadSchema>;
export const LeadChangesResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ready"),
      bootstrap: z.boolean(),
      entries: z.array(LeadChangeEntrySchema).max(LEAD_CHANGES_PAGE_MAX),
      next: z.string().min(1).max(1024),
      more: z.boolean(),
      sources: z.array(LeadChangeAvailabilitySchema).max(6),
    })
    .strict(),
  z.object({ outcome: z.literal("reset_required"), reason: z.literal("retained_history_gap") }).strict(),
]);
export type LeadChangesResult = z.infer<typeof LeadChangesResultSchema>;

/** Safe refusal codes; the relay never forwards arbitrary upstream error bodies. */
export const LeadChangesRefusalCodeSchema = z.enum([
  "invalid_cursor",
  "not_authorized",
  "lead_changes_forbidden",
  "state_unavailable",
  "lead_changes_unavailable",
]);
