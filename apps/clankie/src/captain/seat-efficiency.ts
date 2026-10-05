import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  OperatorSeatEfficiencySchema,
  type OperatorSeatEfficiency,
  type OperatorWorkAssignment,
  type OperatorGoal,
  type WorkerReportSummary,
  type OperatorFleetSeat,
} from "@clankie/protocol";
import { z } from "zod";
import { ConversationOwnerSchema, type ConversationOwner } from "./conversation-owner.ts";
import { SeatCommitBaselineSchema, type SeatCommitBaseline, type SeatTelemetry } from "./seat-telemetry.ts";

const Timestamp = z.string().datetime();
const RecordSchema = z
  .object({
    owner: ConversationOwnerSchema,
    firstObservedAt: Timestamp,
    assignedAt: Timestamp.optional(),
    assignedDeliverable: z.string().min(1).max(16_384).optional(),
    objective: z.string().min(1).max(16_384).optional(),
    model: z.string().min(1).max(256).optional(),
    effort: z.string().min(1).max(64).optional(),
    commitBaseline: SeatCommitBaselineSchema.optional(),
    offScope: z.boolean().optional(),
    assignmentStatus: z.enum(["active", "paused", "canceled", "done"]).optional(),
    evidence: z.string().min(1).max(4000).optional(),
    lastProgressAt: Timestamp.optional(),
    progressEvidenceVersion: z.literal(1).optional(),
    reviewedProgressAt: Timestamp.optional(),
    attributedCommitAt: Timestamp.optional(),
    lastReportAt: Timestamp.optional(),
    reportFailedAt: Timestamp.optional(),
    reportFailures: z.number().int().nonnegative().optional(),
    reportFailureIds: z.array(z.string().min(1).max(256)).max(2000).optional(),
    observed: OperatorSeatEfficiencySchema.optional(),
  })
  .strict();
type Record = z.infer<typeof RecordSchema>;
const RecordsSchema = z.record(z.string().min(1).max(512), RecordSchema);
const LegacyRecordsSchema = z.record(
  z.string().min(1).max(512),
  RecordSchema.extend({
    progressAt: Timestamp.optional(),
    lastCommitAt: Timestamp.optional(),
    observed: OperatorSeatEfficiencySchema.extend({ lastCommitAt: Timestamp.optional() }).optional(),
  }),
);
const sameOwner = (left: ConversationOwner, right: ConversationOwner) =>
  JSON.stringify(ConversationOwnerSchema.parse(left)) ===
  JSON.stringify(ConversationOwnerSchema.parse(right));
const latest = (...values: (string | undefined)[]) =>
  values
    .filter((value): value is string => value !== undefined && Timestamp.safeParse(value).success)
    .map((value) => new Date(value).toISOString())
    .sort()
    .at(-1);
const displayIssue = (value: string | undefined) => {
  const matches = value?.match(/\b[A-Z][A-Z0-9]*-\d+\b/gu);
  return matches?.length === 1 ? matches[0] : undefined;
};
const comparableIssues = (left: string, right: string) =>
  (/^[A-Z][A-Z0-9]*-\d+$/u.test(left) && /^[A-Z][A-Z0-9]*-\d+$/u.test(right)) ||
  (/^[a-f0-9-]{36}$/iu.test(left) && /^[a-f0-9-]{36}$/iu.test(right));

export interface SeatEfficiencyObservation {
  occupantId: string;
  seatId: string;
  owner: ConversationOwner;
  status?: string | undefined;
  assignment?: OperatorWorkAssignment | undefined;
  goal?: OperatorGoal | undefined;
  telemetry?: SeatTelemetry | undefined;
  reports?: WorkerReportSummary[] | undefined;
  reportRoute?: OperatorFleetSeat["workerReportRouting"];
  lastCommitAt?: string | undefined;
}

/** Durable signals are scoped to a native occupant and its exact admitted owner. */
export class SeatEfficiencyStore {
  private records: z.infer<typeof RecordsSchema> = {};
  private readonly now: () => number;
  private readonly path: string;
  private savedSignature = "";
  public constructor(path: string, options: { now?: () => number } = {}) {
    this.path = path;
    this.now = options.now ?? Date.now;
    if (existsSync(path)) {
      try {
        const legacy = LegacyRecordsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        for (const [id, entry] of Object.entries(legacy)) {
          const { progressAt, lastCommitAt: _unprovenCommit, observed, ...persisted } = entry;
          const record: Record = persisted;
          if (record.progressEvidenceVersion !== 1) {
            // Older aggregates mixed cwd HEAD with real progress. Preserve only
            // separately timestamped reports/reviews; never infer their source.
            record.reviewedProgressAt = latest(record.reviewedProgressAt, progressAt);
            delete record.attributedCommitAt;
            record.lastProgressAt = latest(
              record.reviewedProgressAt,
              record.lastReportAt,
              record.reportFailedAt,
            );
            record.progressEvidenceVersion = 1;
          }
          if (observed) {
            const { lastCommitAt: _legacyCommit, lastProgressAt: _aggregate, ...evidence } = observed;
            record.observed = {
              ...evidence,
              ...(record.lastProgressAt === undefined ? {} : { lastProgressAt: record.lastProgressAt }),
            };
          }
          this.records[id] = RecordSchema.parse(record);
        }
      } catch {
        /* Unavailable display evidence cannot prevent service startup. */
      }
    }
    this.savedSignature = this.signature();
  }

  public assign(
    occupantId: string,
    assignment: {
      owner: ConversationOwner;
      deliverable?: string | undefined;
      objective?: string | undefined;
      model?: string | undefined;
      effort?: string | undefined;
      assignedAt?: string | undefined;
      commitBaseline?: SeatCommitBaseline | undefined;
    },
  ): void {
    z.string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9:/._-]{0,511}$/u)
      .parse(occupantId);
    const owner = ConversationOwnerSchema.parse(assignment.owner);
    const previous = Object.hasOwn(this.records, occupantId) ? this.records[occupantId] : undefined;
    const record =
      previous !== undefined && sameOwner(previous.owner, owner)
        ? previous
        : { owner, firstObservedAt: this.timestamp(), progressEvidenceVersion: 1 as const };
    this.records[occupantId] = RecordSchema.parse({
      ...record,
      owner,
      assignedAt: assignment.assignedAt ?? this.timestamp(),
      ...(assignment.deliverable === undefined ? {} : { assignedDeliverable: assignment.deliverable }),
      ...(assignment.objective === undefined ? {} : { objective: assignment.objective }),
      ...(assignment.model === undefined ? {} : { model: assignment.model }),
      ...(assignment.effort === undefined ? {} : { effort: assignment.effort }),
      ...(assignment.commitBaseline === undefined ? {} : { commitBaseline: assignment.commitBaseline }),
    });
    this.save();
  }

  /** Internal host evidence only; owner changes never inherit another baseline. */
  public readCommitBaseline(occupantId: string, owner: ConversationOwner): SeatCommitBaseline | undefined {
    const record = Object.hasOwn(this.records, occupantId) ? this.records[occupantId] : undefined;
    return record && sameOwner(record.owner, owner) && record.commitBaseline
      ? SeatCommitBaselineSchema.parse(record.commitBaseline)
      : undefined;
  }

  /** Establish a legacy occupant's first-observed baseline without retro-credit. */
  public setCommitBaseline(occupantId: string, owner: ConversationOwner, baseline: SeatCommitBaseline): void {
    const record = this.ownedRecord(occupantId, owner, true);
    if (record.commitBaseline !== undefined) return;
    record.commitBaseline = SeatCommitBaselineSchema.parse(baseline);
    this.save();
  }

  public observe(input: SeatEfficiencyObservation): OperatorSeatEfficiency {
    const record = this.ownedRecord(input.occupantId, input.owner, true);
    const checkedAt = this.timestamp();
    const reports = (input.reports ?? []).filter(
      (report) => report.conversationId === record.owner.conversationId,
    );
    const lastReportAt = latest(
      record.lastReportAt,
      input.telemetry?.lastReportAt,
      input.telemetry?.reportFailedAt,
      ...reports.map((report) => report.acceptedAt),
    );
    const progress = latest(record.reviewedProgressAt, record.attributedCommitAt, lastReportAt);
    const commitAt = latest(input.lastCommitAt, input.telemetry?.lastCommitAt);
    if (record.commitBaseline !== undefined && commitAt !== undefined)
      record.attributedCommitAt = latest(record.attributedCommitAt, commitAt);
    const explicitProgress = input.telemetry?.lastProgressAt;
    if (explicitProgress !== undefined)
      record.reviewedProgressAt = latest(record.reviewedProgressAt, explicitProgress);
    const provenProgress = latest(progress, record.attributedCommitAt, record.reviewedProgressAt);
    if (lastReportAt !== undefined) record.lastReportAt = lastReportAt;
    if (provenProgress !== undefined) record.lastProgressAt = provenProgress;
    else delete record.lastProgressAt;
    const failureAt = input.telemetry?.reportFailedAt;
    if (
      failureAt !== undefined &&
      Timestamp.safeParse(failureAt).success &&
      (record.reportFailedAt === undefined || failureAt > record.reportFailedAt)
    ) {
      record.reportFailedAt = failureAt;
      const ids = new Set(record.reportFailureIds ?? []);
      const observedIds = input.telemetry?.reportFailureIds;
      const additional = observedIds === undefined ? 1 : observedIds.filter((id) => !ids.has(id)).length;
      for (const id of observedIds ?? []) ids.add(id);
      record.reportFailureIds = [...ids].slice(-2000);
      record.reportFailures = (record.reportFailures ?? 0) + additional;
    }
    const flags: string[] = [];
    const assignedIssue = displayIssue(record.assignedDeliverable);
    const currentIssue = input.assignment?.issue?.itemId;
    if (
      record.offScope === true ||
      (assignedIssue !== undefined &&
        currentIssue !== undefined &&
        comparableIssues(assignedIssue, currentIssue) &&
        assignedIssue !== currentIssue) ||
      (input.status === "working" &&
        (record.assignmentStatus === "paused" ||
          record.assignmentStatus === "canceled" ||
          input.goal?.status === "paused"))
    )
      flags.push("off-scope");
    const nativeFailure =
      record.reportFailedAt !== undefined &&
      !(record.lastReportAt !== undefined && record.lastReportAt > record.reportFailedAt) &&
      !reports.some(
        (report) =>
          ["read", "delivered"].includes(report.state) && report.acceptedAt > record.reportFailedAt!,
      );
    if (
      nativeFailure ||
      reports.some((report) => ["pending", "attempting", "uncertain"].includes(report.state)) ||
      (input.reportRoute !== undefined &&
        (["refused", "unadopted"].includes(input.reportRoute.source) ||
          input.reportRoute.reason !== undefined))
    )
      flags.push("reports failing");
    const contextPercent = input.telemetry?.contextPercent;
    if (
      contextPercent !== undefined &&
      Number.isFinite(contextPercent) &&
      contextPercent >= 80 &&
      contextPercent <= 100
    )
      flags.push(`context ${Math.round(contextPercent)}%`);
    const baseline = latest(record.assignedAt ?? record.firstObservedAt, record.lastProgressAt)!;
    if (this.now() - Date.parse(baseline) >= 2 * 60 * 60 * 1000) flags.push("no progress in 2h");
    if (input.status === "done" || input.goal?.status === "complete" || record.assignmentStatus === "done")
      flags.push("done");
    else if (input.status === "idle" || (input.goal?.status === "paused" && input.status !== "working"))
      flags.push("idle");
    // A requested launch value is not proof of the effective native turn setting.
    const model = input.telemetry?.model;
    const effort = input.telemetry?.effort;
    const result = OperatorSeatEfficiencySchema.parse({
      checkedAt,
      ownerConversationId: record.owner.conversationId,
      flags,
      ...(record.assignedDeliverable === undefined
        ? {}
        : { assignedDeliverable: record.assignedDeliverable }),
      ...((input.assignment?.objective ?? input.goal?.objective ?? record.objective)
        ? { objective: input.assignment?.objective ?? input.goal?.objective ?? record.objective }
        : {}),
      ...(currentIssue === undefined ? {} : { currentIssue }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(contextPercent === undefined ||
      !Number.isFinite(contextPercent) ||
      contextPercent < 0 ||
      contextPercent > 100
        ? {}
        : { contextPercent }),
      ...(record.lastProgressAt === undefined ? {} : { lastProgressAt: record.lastProgressAt }),
      ...(record.lastReportAt === undefined ? {} : { lastReportAt: record.lastReportAt }),
      ...(record.reportFailures === undefined ? {} : { reportFailures: record.reportFailures }),
    });
    // Roster decoration (for example overlap) must not mutate durable evidence.
    record.observed = { ...result, flags: [...result.flags] };
    this.save();
    return result;
  }

  public review(input: {
    occupantId: string;
    owner: ConversationOwner;
    offScope?: boolean | undefined;
    assignmentStatus?: "active" | "paused" | "canceled" | "done" | undefined;
    deliverable?: string | undefined;
    progressAt?: string | undefined;
    evidence: string;
  }): OperatorSeatEfficiency {
    const record = this.ownedRecord(input.occupantId, input.owner, false);
    const updated = RecordSchema.parse({
      ...record,
      evidence: input.evidence,
      ...(input.offScope === undefined ? {} : { offScope: input.offScope }),
      ...(input.assignmentStatus === undefined ? {} : { assignmentStatus: input.assignmentStatus }),
      ...(input.deliverable === undefined ? {} : { assignedDeliverable: input.deliverable }),
      ...(input.progressAt === undefined
        ? {}
        : {
            reviewedProgressAt: latest(record.reviewedProgressAt, Timestamp.parse(input.progressAt)),
            lastProgressAt: latest(record.lastProgressAt, input.progressAt),
          }),
    });
    this.records[input.occupantId] = updated;
    this.save();
    // The review updates semantic evidence; the next fresh observation adds live facts.
    const flags = (updated.observed?.flags ?? []).filter(
      (flag) =>
        flag !== "off-scope" &&
        !(input.assignmentStatus !== undefined && ["idle", "done"].includes(flag)) &&
        !(input.progressAt !== undefined && flag === "no progress in 2h"),
    );
    if (updated.offScope === true) flags.unshift("off-scope");
    if (updated.assignmentStatus === "done") flags.push("done");
    else if (["paused", "canceled"].includes(updated.assignmentStatus ?? "")) flags.push("idle");
    const result = OperatorSeatEfficiencySchema.parse({
      ...updated.observed,
      checkedAt: this.timestamp(),
      ownerConversationId: updated.owner.conversationId,
      flags,
      ...(updated.assignedDeliverable === undefined
        ? {}
        : { assignedDeliverable: updated.assignedDeliverable }),
      ...(updated.lastProgressAt === undefined ? {} : { lastProgressAt: updated.lastProgressAt }),
      ...(updated.objective === undefined ? {} : { objective: updated.objective }),
    });
    updated.observed = { ...result, flags: [...result.flags] };
    this.save();
    return result;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
  private ownedRecord(occupantId: string, owner: ConversationOwner, create: boolean): Record {
    z.string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9:/._-]{0,511}$/u)
      .parse(occupantId);
    const proof = ConversationOwnerSchema.parse(owner);
    const existing = Object.hasOwn(this.records, occupantId) ? this.records[occupantId] : undefined;
    if (existing !== undefined) {
      if (sameOwner(existing.owner, proof)) return existing;
      if (!create) throw new Error("Seat efficiency owner does not match the admitted occupant owner");
      // observe is called only with a fresh host-admitted native owner. Adoption
      // may change that owner without launching a new occupant; prior verdicts
      // and assignment/progress evidence must not cross the ownership boundary.
    }
    if (!create) throw new Error("Seat efficiency observation is unavailable for this occupant");
    const record: Record = { owner: proof, firstObservedAt: this.timestamp(), progressEvidenceVersion: 1 };
    this.records[occupantId] = record;
    return record;
  }
  private save(): void {
    const entries = Object.entries(this.records).sort((a, b) =>
      a[1].firstObservedAt.localeCompare(b[1].firstObservedAt),
    );
    for (const [id] of entries.slice(0, Math.max(0, entries.length - 1000))) delete this.records[id];
    const signature = this.signature();
    if (signature === this.savedSignature) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.records), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
    this.savedSignature = signature;
  }
  private signature(): string {
    return JSON.stringify(this.records, (key, value) => (key === "checkedAt" ? undefined : value));
  }
}
