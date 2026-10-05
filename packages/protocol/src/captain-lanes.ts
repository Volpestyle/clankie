import { z } from "zod";

/** Frozen event-log partition key. Still serialized as `missionId`. */
export const MissionIdSchema = z.string().min(1);
/** Frozen optional attribution on the event envelope. */
export const TaskIdSchema = z.string().min(1);
/** Frozen optional attribution on the event envelope. */
export const WorkerRunIdSchema = z.string().min(1);
export const EnvironmentSessionIdSchema = z.string().min(1);
export const WorldIdSchema = z.string().min(1);
export const CharacterIdSchema = z.string().min(1);
export const ActionIdSchema = z.string().min(1);

export type EnvironmentSessionId = z.infer<typeof EnvironmentSessionIdSchema>;
export type WorldId = z.infer<typeof WorldIdSchema>;
export type CharacterId = z.infer<typeof CharacterIdSchema>;
export type ActionId = z.infer<typeof ActionIdSchema>;

/** Frozen ADR 0016 v1 wire lanes. New lanes belong to a versioned successor. */
export const CaptainLaneSchema = z.enum(["tui", "discord_voice", "gameplay"]);
export type CaptainLaneV1 = z.infer<typeof CaptainLaneSchema>;

/**
 * Durable captain execution lanes v2. CaptainLaneSchema is the frozen v1 wire
 * enum and remains available for legacy dual-read migration only.
 */
export const CaptainSessionLaneV2Schema = z.enum([
  "operator",
  "discord_voice",
  "discord_presence",
  "gameplay",
]);
export type CaptainSessionLaneV2 = z.infer<typeof CaptainSessionLaneV2Schema>;

/**
 * Transitional dual-read lane boundary. Legacy TUI remains readable while the
 * post-v1 discord_presence lane migrates to CaptainSessionLaneV2Schema.
 * Versioned records must use CaptainLaneSchema (v1) or CaptainSessionLaneV2Schema (v2), never this union.
 */
export const CaptainLaneCompatibilitySchema = z.union([CaptainLaneSchema, z.literal("discord_presence")]);
export type CaptainLane = z.infer<typeof CaptainLaneCompatibilitySchema>;

// ---------------------------------------------------------------------------
// Captain lane observation (ADR 0083).
//
// The bounded room history an operator surface reads to watch a lane it is not
// talking in. This is heard/said conversation only: no reasoning, tool, private
// pi session state, or continuation-token field appears here.
// ---------------------------------------------------------------------------

/** The authenticated captain route that lists observable lanes. */
export const CAPTAIN_LANE_OBSERVATION_PATH = "/captain/v1/lanes";

export const CAPTAIN_LANE_ENTRIES_MAX = 40;
export const CAPTAIN_LANE_TEXT_MAX = 16_384;

export const CaptainLaneObservationEntrySchema = z
  .object({
    at: z.string().datetime(),
    kind: z.enum(["heard", "said"]),
    text: z.string().max(CAPTAIN_LANE_TEXT_MAX),
  })
  .strict();
export type CaptainLaneObservationEntry = z.infer<typeof CaptainLaneObservationEntrySchema>;

export const ObservableCaptainLaneSchema = z
  .object({
    lane: CaptainSessionLaneV2Schema,
    /** The room address: `guildId:channelId` for Discord, conversation-shaped elsewhere. */
    targetId: z.string().trim().min(1).max(512),
    entries: z.array(CaptainLaneObservationEntrySchema).max(CAPTAIN_LANE_ENTRIES_MAX),
  })
  .strict();
export type ObservableCaptainLane = z.infer<typeof ObservableCaptainLaneSchema>;

export const CAPTAIN_LANE_LISTING_MAX = 256;

export const CaptainLaneListingSchema = z
  .object({
    schemaVersion: z.literal(1),
    lanes: z.array(ObservableCaptainLaneSchema).max(CAPTAIN_LANE_LISTING_MAX),
  })
  .strict();
export type CaptainLaneListing = z.infer<typeof CaptainLaneListingSchema>;

// ---------------------------------------------------------------------------
// Captain turn metrics (VUH-1022, extended by VUH-1115).
//
// One record per settled operator or Discord captain turn: counters, names and
// reported totals only — never Pi trees, tool arguments, tool outputs, message
// text or credentials. This is both the durable JSONL row the service appends
// and the item its read surfaces return, so writer and reader cannot drift.
// `execution` and `usage` are nullish on purpose: a row written before VUH-1115
// omits them, a read surface answers them as explicit `null`, and neither ever
// stands for zero.
// ---------------------------------------------------------------------------

/** The operator route that lists recent settled turns. */
export const CAPTAIN_TURN_METRICS_PATH = "/v1/captain/turn-metrics";
export const CAPTAIN_TURN_METRICS_LIMIT_DEFAULT = 20;
export const CAPTAIN_TURN_METRICS_LIMIT_MAX = 100;

export const CaptainTurnSettledOutcomeSchema = z.enum(["completed", "failed", "interrupted"]);
export type CaptainTurnSettledOutcome = z.infer<typeof CaptainTurnSettledOutcomeSchema>;

/**
 * What actually ran the turn, captured as the turn executes rather than read
 * back from configuration at settle time: a `/model` or `/effort` switch under a
 * live conversation belongs to the next executing turn, not to this one.
 */
export const CaptainTurnExecutionSchema = z
  .object({
    /** Pi model id, e.g. `gpt-6-astra`. */
    model: z.string().min(1).max(256),
    /** Pi provider id, e.g. `openai-codex`. */
    provider: z.string().min(1).max(256),
    /** The thinking level Pi sent, e.g. `high`. */
    effort: z.string().min(1).max(64),
  })
  .strict();
export type CaptainTurnExecution = z.infer<typeof CaptainTurnExecutionSchema>;

/**
 * Provider-reported usage summed across the turn's assistant messages, with the
 * number of reports that contributed. Absent or null means nothing was reported
 * — never zero, and never inferred from context occupancy or a dollar figure.
 */
export const CaptainTurnReportedUsageSchema = z
  .object({
    totalTokens: z.number().int().nonnegative(),
    reports: z.number().int().positive(),
  })
  .strict();
export type CaptainTurnReportedUsage = z.infer<typeof CaptainTurnReportedUsageSchema>;

export const CaptainTurnSettledMetricsSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("captain.turn.settled"),
    conversationId: z.string().min(1),
    lane: CaptainSessionLaneV2Schema,
    runId: z.string().min(1),
    acceptedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    failedAt: z.string().datetime().optional(),
    outcome: CaptainTurnSettledOutcomeSchema,
    toolCount: z.record(z.string(), z.number().int().nonnegative()),
    firstMutatingAt: z.string().datetime().optional(),
    firstMutatingTool: z.string().min(1).optional(),
    mutatingCount: z.number().int().nonnegative(),
    surveyToolCountBeforeFirstMutation: z.number().int().nonnegative().optional(),
    /** Context occupancy. Neither usage nor a charge; never read as either. */
    contextTokensStart: z.number().int().nonnegative().optional(),
    contextTokensEnd: z.number().int().nonnegative().optional(),
    execution: CaptainTurnExecutionSchema.nullish(),
    usage: CaptainTurnReportedUsageSchema.nullish(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === "completed") {
      if (value.completedAt === undefined) {
        context.addIssue({ code: "custom", message: "completed turns need completedAt" });
      }
      if (value.failedAt !== undefined) {
        context.addIssue({ code: "custom", message: "completed turns must not set failedAt" });
      }
    } else {
      if (value.failedAt === undefined) {
        context.addIssue({ code: "custom", message: "failed and interrupted turns need failedAt" });
      }
      if (value.completedAt !== undefined) {
        context.addIssue({
          code: "custom",
          message: "failed and interrupted turns must not set completedAt",
        });
      }
    }
  });
export type CaptainTurnSettledMetrics = z.infer<typeof CaptainTurnSettledMetricsSchema>;

export const CaptainTurnMetricsPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(CaptainTurnSettledMetricsSchema).max(CAPTAIN_TURN_METRICS_LIMIT_MAX),
  })
  .strict();
export type CaptainTurnMetricsPage = z.infer<typeof CaptainTurnMetricsPageSchema>;
