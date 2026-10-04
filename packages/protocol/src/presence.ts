import { z } from "zod";

export const OPERATOR_PRESENCE_WAIT_MS_MAX = 30_000;
export const OperatorPresenceMoodSchema = z.enum([
  "thinking",
  "in_voice",
  "playing",
  "leading",
  "needs_you",
  "idle",
]);
export type OperatorPresenceMood = z.infer<typeof OperatorPresenceMoodSchema>;
export const OperatorPresenceOwnerItemSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(512),
    questionId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    since: z.string().datetime(),
  })
  .strict();
export const DesktopAnimationSchema = z.enum([
  "idle",
  "blink",
  "look_left",
  "look_right",
  "walk_left",
  "walk_right",
  "hop",
  "fall_asleep",
  "sleep",
  "wake",
  "think",
  "talk",
  "play",
  "alert",
  "happy",
  "catch",
  "offline",
]);
const expressionIdentity = { id: z.string().uuid(), expiresAt: z.string().datetime() };
export const DesktopExpressionSchema = z.discriminatedUnion("kind", [
  z.object({ ...expressionIdentity, kind: z.literal("emote"), animation: DesktopAnimationSchema }).strict(),
  z
    .object({ ...expressionIdentity, kind: z.literal("say"), text: z.string().trim().min(1).max(200) })
    .strict(),
  z
    .object({
      ...expressionIdentity,
      kind: z.literal("move"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .strict(),
]);
export type DesktopExpression = z.infer<typeof DesktopExpressionSchema>;
export const OperatorPresenceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    cursor: z.string().trim().min(1).max(512),
    mood: OperatorPresenceMoodSchema,
    detail: z.string().max(200),
    /** Source timestamp; null when that source does not expose its start. */
    since: z.string().datetime().nullable(),
    /** Live registered seats, including seats waiting between turns. */
    activeSeats: z.number().int().nonnegative(),
    pendingOwnerItem: OperatorPresenceOwnerItemSchema.optional(),
    expression: DesktopExpressionSchema.optional(),
  })
  .strict();
export type OperatorPresenceSnapshot = z.infer<typeof OperatorPresenceSnapshotSchema>;
export const OperatorPresenceRequestSchema = z
  .object({
    op: z.literal("presence"),
    schemaVersion: z.literal(1),
    cursor: z.string().trim().min(1).max(512).optional(),
    waitMs: z.number().int().min(0).max(OPERATOR_PRESENCE_WAIT_MS_MAX).optional(),
  })
  .strict();
export const OperatorPresenceResultSchema = z
  .object({
    op: z.literal("presence"),
    schemaVersion: z.literal(1),
    snapshot: OperatorPresenceSnapshotSchema,
  })
  .strict();
