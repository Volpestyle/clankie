import { z } from "zod";
import { BodyLeaseResultSchema } from "./body-leases.ts";
import { CaptainSessionLaneV2Schema, EnvironmentSessionIdSchema } from "./captain-lanes.ts";

// ---------------------------------------------------------------------------
// Asked embodiment (ADR 0063): the captain asks for play, the embodiment
// authority holds the intent, and the in-process play host runs the session.
//
// Every schema is a STRICT, content-free wire boundary: ids, enums, counters,
// and timestamps only. No field may carry free text, model output, frame
// bytes, or anything a message body could smuggle through.
// ---------------------------------------------------------------------------

/** Environments the play seam serves. */
export const EmbodimentEnvironmentIdSchema = z.enum(["pokemon-firered", "pokemon-emerald"]);
export type EmbodimentEnvironmentId = z.infer<typeof EmbodimentEnvironmentIdSchema>;

/**
 * Which body a recorded playthrough ran on. He has one body now — a seat in a
 * hosted world — but play journals on disk predate that, so the reader keeps
 * both values ([ADR 0145](../../../docs/adr/0145-the-world-is-the-only-body.md)).
 */
export const EmbodimentVenueSchema = z.enum(["local", "world"]);
export type EmbodimentVenue = z.infer<typeof EmbodimentVenueSchema>;

/**
 * Why a world join did not happen, said out loud. `play_session_active` is the
 * shared play host's refusal; the remaining reasons come from the hosted world.
 */
export const WorldJoinRefusalReasonSchema = z.enum([
  "play_session_active",
  "no_credential",
  "world_unreachable",
  "world_refused",
  "region_not_hosted",
  "world_full",
]);
export type WorldJoinRefusalReason = z.infer<typeof WorldJoinRefusalReasonSchema>;

export const EmbodimentIntentIdSchema = z.string().min(1).max(200);
export type EmbodimentIntentId = z.infer<typeof EmbodimentIntentIdSchema>;

/**
 * An absent field is "no cap" — the owner's chosen default (2026-07-26): he
 * plays until asked to stop. The stop ask and lease mechanics are the standing
 * controls; a present field is a caller's deliberate bound and must still be a
 * positive integer.
 */
export const EmbodimentBudgetSchema = z
  .object({
    maxTurns: z.number().int().positive().optional(),
    maxDurationMs: z.number().int().positive().optional(),
  })
  .strict();
export type EmbodimentBudget = z.infer<typeof EmbodimentBudgetSchema>;

const embodimentIntentBase = {
  schemaVersion: z.literal(1),
  intentId: EmbodimentIntentIdSchema,
  originLane: CaptainSessionLaneV2Schema,
  /** Content-free principal id, as the origin lane authenticated it. */
  requestedBy: z.string().min(1).max(200),
  requestedAt: z.string().datetime(),
  /** Selected conversation; the host separately authenticates ownership and grants. */
  conversationId: z.string().min(1).max(256).optional(),
} as const;

/**
 * A stop intent targets the live session, never an environment: stopping "the
 * game" when a different session than the asker imagines is running must stop
 * nothing and refuse `not_playing`-adjacent, not guess.
 */
export const EmbodimentIntentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("start"),
      ...embodimentIntentBase,
      environmentId: EmbodimentEnvironmentIdSchema,
      budget: EmbodimentBudgetSchema,
      /**
       * Absent means local. A hosted world is `world` — not a new
       * environmentId, because FireRed alone and FireRed in the world are
       * both valid.
       */
    })
    .strict(),
  z
    .object({
      kind: z.literal("stop"),
      ...embodimentIntentBase,
      sessionId: EnvironmentSessionIdSchema,
    })
    .strict(),
]);
export type EmbodimentIntent = z.infer<typeof EmbodimentIntentSchema>;

export const EmbodimentSessionStateSchema = z.enum([
  "requested",
  "claimed",
  "running",
  "stopping",
  "stopped",
  "refused",
  "failed",
]);
export type EmbodimentSessionState = z.infer<typeof EmbodimentSessionStateSchema>;

/** A different service-local play session is active or winding down. */
export const EmbodimentRefusalReasonSchema = z.enum([
  "play_session_active",
  "environment_unavailable",
  "budget",
  "policy",
  "not_playing",
  "no_credential",
  "world_unreachable",
  "world_refused",
  "region_not_hosted",
  "world_full",
]);
export type EmbodimentRefusalReason = z.infer<typeof EmbodimentRefusalReasonSchema>;

/** The one authority for service-local session-state transitions. */
export const EMBODIMENT_SESSION_TRANSITIONS: Readonly<
  Record<EmbodimentSessionState, readonly EmbodimentSessionState[]>
> = {
  requested: ["claimed", "refused"],
  claimed: ["running", "refused", "failed"],
  running: ["stopping", "stopped", "failed"],
  stopping: ["stopped", "failed"],
  stopped: [],
  refused: [],
  failed: [],
};

export function canTransitionEmbodimentSession(
  from: EmbodimentSessionState,
  to: EmbodimentSessionState,
): boolean {
  return EMBODIMENT_SESSION_TRANSITIONS[from].includes(to);
}

/** Durable service record of one asked session, replayed from events. */
export const EmbodimentSessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: EnvironmentSessionIdSchema,
    environmentId: EmbodimentEnvironmentIdSchema,
    state: EmbodimentSessionStateSchema,
    intentId: EmbodimentIntentIdSchema,
    originLane: CaptainSessionLaneV2Schema,
    requestedBy: z.string().min(1).max(200),
    budget: EmbodimentBudgetSchema,
    requestedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    refusalReason: EmbodimentRefusalReasonSchema.optional(),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.state === "refused" && session.refusalReason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["refusalReason"],
        message: "Refused sessions carry the typed reason his reply renders",
      });
    }
    if (session.state !== "refused" && session.refusalReason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["refusalReason"],
        message: "Only refused sessions carry a refusal reason",
      });
    }
  });
export type EmbodimentSession = z.infer<typeof EmbodimentSessionSchema>;

/**
 * The service's answer to a submitted intent. A refused start still
 * carries the minted session id when one was recorded, so the refusal stays
 * queryable rather than dropped.
 */
export const EmbodimentSubmitResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted"), session: EmbodimentSessionSchema }).strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reason: EmbodimentRefusalReasonSchema,
      sessionId: EnvironmentSessionIdSchema.optional(),
      bodyLease: BodyLeaseResultSchema.optional(),
    })
    .strict(),
  z.object({ outcome: z.literal("stop_requested"), session: EmbodimentSessionSchema }).strict(),
]);
export type EmbodimentSubmitResult = z.infer<typeof EmbodimentSubmitResultSchema>;

export const EmbodimentSessionOutcomeSchema = z.enum([
  "stopped",
  "budget_exhausted",
  "failed",
  "lease_lapsed",
]);
export type EmbodimentSessionOutcome = z.infer<typeof EmbodimentSessionOutcomeSchema>;

/** Terminal accounting for one session: counters and checkpoint lineage only. */
export const EmbodimentSessionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: EnvironmentSessionIdSchema,
    environmentId: EmbodimentEnvironmentIdSchema,
    outcome: EmbodimentSessionOutcomeSchema,
    turnsTaken: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    framesPublished: z.number().int().nonnegative(),
    /** Sink-degraded frames; play continues without a producer, counted not hidden. */
    framesDropped: z.number().int().nonnegative(),
  })
  .strict();
export type EmbodimentSessionReceipt = z.infer<typeof EmbodimentSessionReceiptSchema>;

/**
 * The captain tool's typed outcome, like DiscordVoicePresenceResult: the
 * reply reflects what actually happened, and a refusal names a reason he can
 * say out loud. `pending` means the bounded wait elapsed before the local play
 * host started — the request stands, and he must not claim to be playing yet.
 */
export const EmbodimentPlayNoteSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("joined"),
      sessionId: EnvironmentSessionIdSchema,
      environmentId: EmbodimentEnvironmentIdSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("join_refused"),
      environmentId: EmbodimentEnvironmentIdSchema,
      reason: EmbodimentRefusalReasonSchema,
      bodyLease: BodyLeaseResultSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("stopped"),
      sessionId: EnvironmentSessionIdSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("stop_refused"),
      sessionId: EnvironmentSessionIdSchema.optional(),
      reason: EmbodimentRefusalReasonSchema,
      bodyLease: BodyLeaseResultSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("pending"),
      intentId: EmbodimentIntentIdSchema,
    })
    .strict(),
]);
export type EmbodimentPlayNote = z.infer<typeof EmbodimentPlayNoteSchema>;
