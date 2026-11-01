import { z } from "zod";
import { FLEET_REVIEW_BUDGET } from "./worker-accounts.ts";

/**
 * What a connected lead can read before it hires (ADR 0313). Every number is
 * one Clankie already recorded. A figure he does not have is the string
 * "unknown", never a filled-in estimate. Homes, emails, account keys and
 * credentials are not in this shape.
 */
const unknown = z.literal("unknown");
const knownNumber = z.union([z.number().finite(), unknown]);
const knownCount = z.union([z.number().int().nonnegative(), unknown]);
const knownInstant = z.union([z.iso.datetime(), unknown]);

const UsageWindowSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(96),
    usedPercent: z.number().min(0).max(100),
    resetsAt: knownInstant,
  })
  .strict();

export const FleetCapacityAccountSchema = z
  .object({
    machine: z.string().min(1).max(64),
    harness: z.string().min(1).max(32),
    /** The profile label a hire pins, never an email or a home path. */
    account: z.string().min(1).max(128),
    plan: z.union([z.string().min(1).max(64), unknown]),
    tier: z.union([z.string().min(1).max(64), unknown]),
    signedIn: z.union([z.boolean(), unknown]),
    usable: z.boolean(),
    held: z.boolean(),
    /** Fraction left of the tightest all-model window. */
    remaining: z.union([z.number().min(0).max(1), unknown]),
    resetsAt: knownInstant,
    sparePerDay: knownNumber,
    usage: z.union([
      z
        .object({
          source: z.enum(["claude-usage", "codex-rate-limits"]),
          observedAt: z.iso.datetime(),
          windows: z.array(UsageWindowSchema).max(16),
        })
        .strict(),
      unknown,
    ]),
    /** Prime's own transcript spend. Other harnesses have none. */
    spend: z.union([
      z
        .object({
          todayCostUsd: z.number().min(0),
          todayTokens: z.number().int().min(0),
          weekCostUsd: z.number().min(0),
          weekTokens: z.number().int().min(0),
        })
        .strict(),
      unknown,
    ]),
    sharesLimitsWith: z
      .object({ harness: z.enum(["claude", "codex"]), label: z.string().min(1).max(128) })
      .strict()
      .optional(),
  })
  .strict();
export type FleetCapacityAccount = z.infer<typeof FleetCapacityAccountSchema>;

const BudgetClassSchema = z
  .object({
    requests: z.number().int().nonnegative(),
    requestLimit: z.number().int().positive(),
    writes: z.number().int().nonnegative(),
    writeLimit: z.number().int().positive(),
    /** True while this class is refusing. `retryAt` is set only then. */
    refusing: z.boolean(),
    retryAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const FleetCapacityPaneSchema = z
  .object({
    /** The same id `list_agents` returns. */
    agent: z.string().min(1).max(256),
    machine: z.union([z.string().min(1).max(200), unknown]),
    harness: z.string().min(1).max(80),
    account: z.union([z.string().min(1).max(64), unknown]),
    title: z.string().max(200),
    /** Latest main-thread context occupancy. Not lifetime usage. */
    contextTokens: knownCount,
    /** Share of the window the harness itself reported. Absent window stays unknown. */
    contextPercentOfWindow: z.union([z.number().min(0).max(100), unknown]),
    /**
     * Clankie's review budget for this pane's known role: the lead constant or
     * the hired-worker constant. An unattributed pane stays unknown. This is
     * not the model's context window.
     */
    reviewBudgetTokens: z.union([
      z.literal(FLEET_REVIEW_BUDGET.lead),
      z.literal(FLEET_REVIEW_BUDGET.worker),
      unknown,
    ]),
  })
  .strict();
export type FleetCapacityPane = z.infer<typeof FleetCapacityPaneSchema>;

const knownRate = z.union([z.number().finite().min(0), unknown]);
const TokenCountsSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
  })
  .strict();

/**
 * How fast one usage window is being spent (ADR 0324). `recent` is the change
 * between two of Clankie's own readings at least half an hour apart, within
 * the last three hours of the same window; `windowAverage` is the window's own
 * average since it began. `toUseAllByReset` is the even pace that spends what
 * is left exactly at reset. Projections use `recent` when known, otherwise
 * `windowAverage`.
 */
export const FleetCapacityBurnWindowSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(96),
    usedPercent: z.number().min(0).max(100),
    resetsAt: knownInstant,
    hoursToReset: knownNumber,
    percentPerHour: z
      .object({
        recent: knownRate,
        recentOverMinutes: knownCount,
        windowAverage: knownRate,
        toUseAllByReset: knownRate,
      })
      .strict(),
    /** Percent used at reset at the projected pace. Above 100 means it runs out first. */
    projectedUsedAtReset: z.union([z.number().finite().min(0), unknown]),
    runsOutAt: z.union([z.iso.datetime(), z.literal("not before reset"), unknown]),
  })
  .strict();
export type FleetCapacityBurnWindow = z.infer<typeof FleetCapacityBurnWindowSchema>;

/**
 * One local Claude session's tokens in the last hour, from its own transcript.
 * `agent` is the `list_agents` id when the session is a seat Clankie knows;
 * otherwise the session is counted but not named.
 */
export const FleetCapacityBurnSessionSchema = z
  .object({
    agent: z.union([z.string().min(1).max(256), unknown]),
    title: z.string().max(200).optional(),
    lastActiveAt: z.iso.datetime(),
    tokens: TokenCountsSchema,
  })
  .strict();
export type FleetCapacityBurnSession = z.infer<typeof FleetCapacityBurnSessionSchema>;

/** One metered account's spending pace, once per account however many machines use it. */
export const FleetCapacityBurnSchema = z
  .object({
    harness: z.enum(["claude", "codex"]),
    account: z.string().min(1).max(128),
    plan: z.union([z.string().min(1).max(64), unknown]),
    machines: z.array(z.string().min(1).max(64)).max(16),
    observedAt: z.iso.datetime(),
    windows: z.array(FleetCapacityBurnWindowSchema).max(16),
    /**
     * Tokens this account's Claude sessions on this Mac spent in the last hour,
     * from their transcripts. Linked machines are not read; Codex is not read.
     * `since` is later than an hour ago when a long transcript's readable tail
     * did not reach back that far.
     */
    lastHour: z.union([
      z
        .object({
          since: z.iso.datetime(),
          sessions: z.number().int().nonnegative(),
          tokens: TokenCountsSchema,
          bySession: z.array(FleetCapacityBurnSessionSchema).max(32),
        })
        .strict(),
      unknown,
    ]),
  })
  .strict();
export type FleetCapacityBurn = z.infer<typeof FleetCapacityBurnSchema>;

export const FleetCapacitySchema = z
  .object({
    observedAt: z.iso.datetime(),
    reviewBudgets: z
      .object({
        leadTokens: z.literal(FLEET_REVIEW_BUDGET.lead),
        workerTokens: z.literal(FLEET_REVIEW_BUDGET.worker),
      })
      .strict(),
    accounts: z.array(FleetCapacityAccountSchema).max(256),
    /** Absent on a service older than ADR 0324. */
    burn: z.array(FleetCapacityBurnSchema).max(64).optional(),
    panes: z.array(FleetCapacityPaneSchema).max(768),
    heavy: z.union([
      z
        .object({
          slots: z.number().int().min(1).max(64),
          used: z.number().int().nonnegative(),
          /** `slots - used`. Negative means more leases than slots. */
          remaining: z.number().int(),
          queued: z.number().int().nonnegative(),
          lightSlots: knownCount,
          lightUsed: knownCount,
          healthy: z.boolean(),
          loadRatio: z.number().finite().nonnegative(),
          availableMemoryMb: z.number().finite().nonnegative(),
          pressureReason: z.union([z.enum(["load", "memory", "disk", "probe-unavailable"]), unknown]),
        })
        .strict(),
      unknown,
    ]),
    tracker: z.union([
      z
        .object({
          requestWindowMs: z.literal(3_600_000),
          writeWindowMs: z.literal(60_000),
          actors: z
            .array(
              z
                .object({
                  actor: z.string().min(1).max(256),
                  role: z.union([z.enum(["worker", "reviewer"]), unknown]),
                  interactive: BudgetClassSchema,
                  background: BudgetClassSchema,
                })
                .strict(),
            )
            .max(256),
        })
        .strict(),
      unknown,
    ]),
    notices: z.array(z.string().min(1).max(400)).max(32),
  })
  .strict();
export type FleetCapacity = z.infer<typeof FleetCapacitySchema>;
