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
export const OperatorPresenceFaceSchema = z.enum(["working", "new_message", "needs_you", "error", "voice"]);
export type OperatorPresenceFace = z.infer<typeof OperatorPresenceFaceSchema>;
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
/** A bounded visual cue from an actual hire or delivered worker report; no content. */
export const OperatorPresenceBeatSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["hire", "worker_report"]),
    at: z.string().datetime(),
  })
  .strict();
export type OperatorPresenceBeat = z.infer<typeof OperatorPresenceBeatSchema>;
/** Public activity facts only; never prompts, tool arguments or credentials. */
export const OperatorPresenceActivitySchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    kind: z.enum(["working", "leading", "voice", "playing", "attention"]),
    /** Null when the live source does not expose its start. */
    since: z.string().datetime().nullable(),
  })
  .strict();
export type OperatorPresenceActivity = z.infer<typeof OperatorPresenceActivitySchema>;
export const OperatorPresenceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    cursor: z.string().trim().min(1).max(512),
    mood: OperatorPresenceMoodSchema,
    /** Optional desktop face; absence is neutral and compatible with older services. */
    face: OperatorPresenceFaceSchema.optional(),
    detail: z.string().max(200),
    /** Source timestamp; null when that source does not expose its start. */
    since: z.string().datetime().nullable(),
    /** Live registered seats, including seats waiting between turns. */
    activeSeats: z.number().int().nonnegative(),
    /** Running native children of the local Clankie captain; absent when unknown. */
    nativeSubagents: z.number().int().nonnegative().optional(),
    pendingOwnerItem: OperatorPresenceOwnerItemSchema.optional(),
    expression: DesktopExpressionSchema.optional(),
    beats: z.array(OperatorPresenceBeatSchema).max(2).optional(),
    activities: z.array(OperatorPresenceActivitySchema).max(3).optional(),
  })
  .strict();
export type OperatorPresenceSnapshot = z.infer<typeof OperatorPresenceSnapshotSchema>;
export const OperatorPresenceRequestSchema = z
  .object({
    op: z.literal("presence"),
    schemaVersion: z.literal(1),
    cursor: z.string().trim().min(1).max(512).optional(),
    /** Opt in to additive desktop face fields; strict legacy clients keep the old snapshot. */
    includeFace: z.boolean().optional(),
    /** Opt in to brief fleet-event cues; legacy strict clients never receive them. */
    includeBeats: z.boolean().optional(),
    /** Opt in to bounded activity labels; strict legacy readers receive no new field. */
    includeActivities: z.boolean().optional(),
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
