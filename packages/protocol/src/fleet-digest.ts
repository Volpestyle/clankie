import { z } from "zod";

export const FLEET_DIGEST_PATH = "/v1/fleet/digest";
const count = z.union([z.number().int().nonnegative(), z.literal("unknown")]);
const status = z.enum(["ready", "partial", "unavailable"]);

/** Aggregate observations only: no source text, identities, paths or account labels. */
export const FleetDigestSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  dayUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  coverage: z.literal("retained_observations"),
  attention: z
    .array(
      z.strictObject({
        kind: z.enum(["owner_questions", "blocked_workers", "incomplete_sources"]),
        count,
      }),
    )
    .max(3),
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
  burn: z.strictObject({
    accountsObserved: count,
    accountsRunningOut: count,
    accountsWithUnknownPace: count,
    lastHourKnownTokens: count,
    accountsMissingTokens: count,
  }),
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
