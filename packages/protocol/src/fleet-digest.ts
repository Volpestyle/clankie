import { z } from "zod";

export const FLEET_DIGEST_PATH = "/v1/fleet/digest";
export const FLEET_DAILY_DIGEST_PATH = "/v1/fleet/digest/daily";
const count = z.union([z.number().int().nonnegative(), z.literal("unknown")]);
const status = z.enum(["ready", "partial", "unavailable"]);

const attention = z
  .array(
    z.strictObject({
      kind: z.enum(["owner_questions", "blocked_workers", "incomplete_sources"]),
      count,
    }),
  )
  .max(3);
const burn = z.strictObject({
  accountsObserved: count,
  accountsRunningOut: count,
  accountsWithUnknownPace: count,
  lastHourKnownTokens: count,
  accountsMissingTokens: count,
});

/** Aggregate observations only: no source text, identities, paths or account labels. */
export const FleetDigestSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  dayUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  coverage: z.literal("retained_observations"),
  attention,
  workers: z.strictObject({
    hired: count,
    working: count,
    waiting: count,
    blocked: count,
    idle: count,
    finished: count,
    unclassified: count,
  }),
  activity: z.strictObject({
    doneReportsToday: count,
    blockedReportsToday: count,
    confirmedClosesToday: count,
  }),
  pullRequests: z.strictObject({
    open: count,
    merged: count,
    retainedSince: z.union([z.iso.datetime(), z.literal("unknown")]),
  }),
  burn,
  resources: z.strictObject({
    heavy: z.union([z.strictObject({ slots: count, used: count, queued: count }), z.literal("unknown")]),
    machines: z.union([z.strictObject({ available: count, unavailable: count }), z.literal("unknown")]),
  }),
  sources: z.strictObject({
    reports: status,
    workers: status,
    ownerQuestions: status,
    pullRequests: status,
    capacity: status,
    closeHistory: status,
  }),
});
export type FleetDigestSnapshot = z.infer<typeof FleetDigestSnapshotSchema>;

/**
 * What the fleet did between two scheduled generations. It holds no waits: an owner ask or
 * blocked worker can resolve after generation, so the daily read observes those live.
 */
export const FleetDailyDigestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  slot: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  timeZone: z.string().min(1).max(100),
  since: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
  coverage: z.literal("retained_observations"),
  pullRequests: z.strictObject({ opened: count, merged: count }),
  issues: z.strictObject({ opened: count, closed: count }),
  ciFindings: z.strictObject({ opened: count, open: count }),
  workers: z.strictObject({ hired: count, closed: count }),
  reports: z.strictObject({ done: count, blocked: count }),
  burn,
  sources: z.strictObject({
    github: status,
    reports: status,
    hires: status,
    closeHistory: status,
    capacity: status,
  }),
});
export type FleetDailyDigest = z.infer<typeof FleetDailyDigestSchema>;

export const FleetDailyDigestReadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  schedule: z.strictObject({
    time: z.string().min(1).max(5),
    timeZone: z.string().min(1).max(100),
  }),
  /** Observed for this read, never copied from the stored digest. */
  waits: z.strictObject({ observedAt: z.iso.datetime(), attention }),
  digest: FleetDailyDigestSchema.nullable(),
});
export type FleetDailyDigestRead = z.infer<typeof FleetDailyDigestReadSchema>;
