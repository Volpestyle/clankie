import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { OperatorFleetSeat, WorkConvention } from "@clankie/protocol";
import type { McpHost } from "../mcp-host.ts";
import { resolveProjectMembership } from "@clankie/settings";
import type { ProjectsSettings } from "@clankie/protocol/projects";
import type { ProjectProcessProof } from "../project-process-proof.ts";
import type { HerdrWatchStore } from "./herdr-watch.ts";
import type { WorkItemsService } from "../work-items.ts";
import type { LinearRequestPriority } from "../linear-request-budget.ts";
import { RepeatedWarnings } from "@clankie/observability";

/**
 * Linear status stays true to the fleet (VUH-1990): In Progress only while a live
 * seat owns the issue. When a seat leaves, its issue moves to Done, Verifying or
 * Paused, or stays In Progress for a named successor, with a one-line comment.
 * Verifying and Paused are picked up by name once the workspace has them; until
 * then the issue falls back to In Progress or Todo and the comment names the
 * intended status.
 */
export type SeatIssueOutcome = "done" | "verifying" | "paused";
type SeatIssueStatus = "Done" | "Verifying" | "Paused" | "In Progress";
export interface SeatIssueSettlement {
  readonly outcome: "updated" | "skipped" | "failed";
  readonly issue?: string;
  readonly intended?: SeatIssueStatus;
  /** The status actually set, which differs from intended while a status is missing. */
  readonly status?: string;
  readonly detail?: string;
  /** A failed close or exit settlement is retried in later roster rounds until then. */
  readonly retryUntil?: string;
}
const unavailableWarnings = new RepeatedWarnings();

/**
 * One line per distinct failure per window. Each fleet projection re-observes
 * every live issue, so an unresolvable one used to warn every few seconds.
 */
export function warnSeatIssueUnavailable(settlement: SeatIssueSettlement): void {
  const { write, suppressed } = unavailableWarnings.admit(
    `${settlement.issue ?? ""}\0${settlement.detail ?? ""}`,
  );
  if (!write) return;
  console.warn(
    "Seat issue status unavailable",
    settlement.issue,
    settlement.detail,
    ...(suppressed > 0 ? [`(repeated ${String(suppressed)} times since the last report)`] : []),
  );
}
export interface LiveSeatIssue {
  readonly seatId: string;
  readonly occupantId?: string;
  readonly title: string;
  /** The seat's deliverable or current issue; only a single tracker key counts. */
  readonly keys: readonly (string | undefined)[];
  /** Additional live assignments; daily-check evidence only, never auto-settled on exit. */
  readonly ownedKeys?: readonly (string | undefined)[];
  /** Host-private verified hire attribution; never accepted from a tool caller. */
  readonly attribution?: SeatIssueAttribution;
}

export interface SeatIssueTrackerScope {
  /** Includes the current saved tracker binding, never just a display key. */
  readonly identity: string;
  readonly backend: WorkConvention["backend"];
  call(tool: string, args: Record<string, unknown>, priority: LinearRequestPriority): Promise<unknown>;
}
export interface SeatIssueAttribution {
  /** Rechecks the retained hire and resolves its CURRENT saved project convention. */
  resolve(): Promise<SeatIssueTrackerScope>;
}

/** One host path for roster capture and later retirement/exit effects. */
export async function prepareSeatIssueAttribution(
  observed: { fleet: string; pane: string; nativeOccupantId: string | undefined },
  deps: {
    proof(fleet: string, pane: string): Promise<ProjectProcessProof | undefined>;
    watches: Pick<HerdrWatchStore, "projectHireAssignment" | "projectHireBookkeepingAttribution">;
    workItems: Pick<WorkItemsService, "prepareSeatIssueTracker">;
    projects(): Promise<ProjectsSettings>;
  },
): Promise<SeatIssueAttribution> {
  const proof = await deps.proof(observed.fleet, observed.pane);
  if (
    !proof ||
    proof.nativeSessionPending ||
    !observed.nativeOccupantId ||
    proof.nativeOccupantId !== observed.nativeOccupantId ||
    proof.fleet !== observed.fleet ||
    proof.pane !== observed.pane ||
    proof.processes.length !== 1 ||
    deps.watches.projectHireAssignment(observed.fleet, observed.pane, proof).state !== "assigned"
  )
    throw new Error("Native hire attribution is unavailable or changed occupant.");
  const hire = deps.watches.projectHireBookkeepingAttribution(
    observed.fleet,
    observed.pane,
    proof.nativeOccupantId,
  );
  if (!hire) throw new Error("No confirmed hire tracker attribution.");
  const validate = async () => {
    hire.validate();
    const membership = resolveProjectMembership(await deps.projects(), {
      occupantId: proof.nativeOccupantId,
      hire: {
        projectId: hire.projectId,
        occupantId: proof.nativeOccupantId,
        ...(hire.role === undefined ? {} : { role: hire.role }),
      },
    });
    if (membership.outcome !== "member") throw new Error("Hire project or role was revoked.");
    hire.validate();
  };
  await validate();
  return { resolve: () => deps.workItems.prepareSeatIssueTracker(hire.projectId, validate) };
}

const scopedKey = (scope: SeatIssueTrackerScope, issue: string) => JSON.stringify([scope.identity, issue]);

const FALLBACK: Record<"Verifying" | "Paused", { name: string; type: string }> = {
  Verifying: { name: "In Progress", type: "started" },
  Paused: { name: "Todo", type: "unstarted" },
};
const CLOSED_TYPES = new Set(["completed", "canceled", "duplicate"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const RETIREMENT_RETRY_MS = 6 * 60 * 60 * 1000;
const StateSchema = z
  .object({
    lastCheckAt: z.string().datetime().optional(),
    /** Issues this keeper paused when their seat left, restored if a seat takes them again. */
    paused: z.record(z.string(), z.string().datetime()).default({}),
  })
  .strict();

function issueKey(value: string | undefined): string | undefined {
  if (value !== undefined && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value.trim()))
    return value.trim();
  const matches = value?.match(/(?<![\w-])[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+(?![\w-])/gu);
  return matches?.length === 1 ? matches[0] : undefined;
}

/** Explicit native work beats a historical hire; mentions in reports are not assignments. */
export function liveSeatIssue(seat: OperatorFleetSeat): LiveSeatIssue {
  const efficiency = ["refused", "unadopted"].includes(seat.workerReportRouting?.source ?? "")
    ? undefined
    : seat.efficiency;
  const nativeIssue = seat.assignment?.issue?.itemId ?? efficiency?.currentIssue;
  const newerDeliverable =
    efficiency?.deliverableAssignedAt !== undefined &&
    seat.assignment !== undefined &&
    Date.parse(efficiency.deliverableAssignedAt) > Date.parse(seat.assignment.updatedAt);
  const current = newerDeliverable
    ? (efficiency?.assignedDeliverable ?? nativeIssue)
    : (nativeIssue ?? efficiency?.assignedDeliverable);
  return {
    seatId: seat.seatId,
    occupantId: seat.occupantId,
    title: seat.title,
    keys: [current],
    ownedKeys: [
      ...(efficiency?.ownedIssues ?? []),
      ...(seat.subagents?.recent ?? [])
        .filter((child) => child.status === "running")
        .map((child) => issueKey(child.label)),
    ],
  };
}

type Tracker = Pick<McpHost, "call">;

interface Retirement {
  readonly issue: string;
  readonly canonicalId: string;
  readonly attribution: SeatIssueAttribution;
  readonly seat: string;
  readonly why: string;
  readonly outcome?: SeatIssueOutcome | undefined;
  readonly evidence?: string | undefined;
  readonly unlanded?: boolean | undefined;
  /** Refs this close parked clean unlanded commits on (VUH-2802). */
  readonly parked?: readonly string[] | undefined;
}
interface RetirementPlan {
  readonly scope: string;
  readonly identity: string;
  /** Unset when retirement only comments, preserving built-in delivery. */
  readonly status?: string;
  readonly comment: string;
  readonly pause: boolean;
  readonly result: SeatIssueSettlement;
  statusSet?: boolean;
  commentAttempted?: boolean;
  commented?: boolean;
}
interface PendingRetirement {
  readonly retirement: Retirement;
  attempts: number;
  retryAt: number;
  until: number;
  plan?: RetirementPlan;
  running?: boolean;
}

// Done needs evidence; a stated Done without it is proof pending. No stated
// outcome (auto-tidy, an owner close) changes no status: the comment records it.
const retirementIntent = (input: Retirement): SeatIssueStatus | undefined =>
  input.outcome === "done" && input.evidence
    ? "Done"
    : input.outcome === "done" || input.outcome === "verifying"
      ? "Verifying"
      : input.outcome === "paused"
        ? "Paused"
        : undefined;
const stated = (intended: SeatIssueStatus | undefined) => (intended === undefined ? {} : { intended });
// Retirement never moves an item back out of review; Done and Verifying still move forward.
const REVIEW_STATUSES = new Set(["in review", "verifying"]);
const backward = (intended: SeatIssueStatus, current: string | undefined) =>
  (intended === "Paused" || intended === "In Progress") && REVIEW_STATUSES.has(current?.toLowerCase() ?? "");
/** Only the built-in tracker's own lookup miss proves a key names no item in that scope. */
const absentFrom = (scope: SeatIssueTrackerScope, error: unknown) =>
  scope.backend === "builtin" && error instanceof Error && /\bIssue not found: /u.test(error.message);
type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const oneLine = (value: string) => value.replace(/\s+/gu, " ").trim().slice(0, 400);

export class SeatIssueKeeper {
  // Cache refusals only, never an authority-bearing scope. Retirement and
  // resumption still resolve their current scope immediately before effects.
  private readonly unavailable = new Map<string, { attempts: number; retryAt: number }>();
  // Unresolved observations are possible owners, never evidence of absence.
  private readonly unknownOwners = new Map<string, LiveSeatIssue>();
  // In memory only: attribution cannot outlive the process, and the daily check
  // still reports an issue whose retirement was lost to a restart.
  private readonly pending = new Map<string, PendingRetirement>();
  private readonly seats = new Map<
    string,
    {
      title: string;
      issue: string;
      canonicalId: string;
      attribution: SeatIssueAttribution;
      goneSince?: number;
    }
  >();
  private readonly identities = new Map<string, string>();
  private live = new Set<string>();
  private readonly scopes = new Map<string, SeatIssueAttribution>();
  private liveOwners = new Map<string, { seatId: string; title: string }[]>();
  private state: z.infer<typeof StateSchema> = { paused: {} };
  private readonly now: () => number;
  private readonly exitGraceMs: number;
  private readonly tracker: Tracker;
  private readonly path: string;
  private readonly requireAttribution: boolean;
  private readonly legacyScope: SeatIssueTrackerScope;
  private readonly humanOwners: () => Promise<{
    ownerUserIds: readonly string[];
    ownerUserEmails: readonly string[];
  }>;

  public constructor(
    tracker: Tracker,
    path: string,
    options: {
      requireAttribution?: boolean;
      now?: () => number;
      exitGraceMs?: number;
      humanOwners?: () => Promise<{ ownerUserIds: readonly string[]; ownerUserEmails: readonly string[] }>;
    } = {},
  ) {
    this.tracker = tracker;
    this.path = path;
    this.requireAttribution = options.requireAttribution ?? false;
    this.legacyScope = {
      identity: "legacy-linear",
      backend: "linear",
      call: (tool, args, priority) => this.call(tool, args, priority),
    };
    this.humanOwners = options.humanOwners ?? (async () => ({ ownerUserIds: [], ownerUserEmails: [] }));
    this.now = options.now ?? Date.now;
    this.exitGraceMs = options.exitGraceMs ?? 10 * 60_000;
    try {
      if (existsSync(path)) this.state = StateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      /* A lost ledger only forgets which pauses to restore; it cannot block startup. */
    }
  }

  /**
   * Each roster refresh: a seat absent past the grace period exited without a
   * close, and an issue this keeper paused goes back to In Progress once a live
   * seat holds it again.
   */
  public async observe(seats: readonly LiveSeatIssue[]): Promise<SeatIssueSettlement[]> {
    const now = this.now();
    const results: SeatIssueSettlement[] = [];
    const present = new Map<
      string,
      LiveSeatIssue & {
        issue: string;
        canonicalId: string;
        attribution: SeatIssueAttribution;
        scope: SeatIssueTrackerScope;
      }
    >();
    this.liveOwners.clear();
    this.unknownOwners.clear();
    const observedKeys = new Set<string>();
    for (const seat of seats) {
      const observationKey = JSON.stringify([seat.seatId, seat.occupantId, seat.keys, seat.ownedKeys]);
      observedKeys.add(observationKey);
      const unavailable = this.unavailable.get(observationKey);
      const keys = [...new Set(seat.keys.map(issueKey).filter((key) => key !== undefined))];
      const issue = keys.length === 1 ? keys[0] : undefined;
      if (keys.length || (seat.ownedKeys ?? []).some((key) => issueKey(key)) || this.seats.has(seat.seatId))
        this.unknownOwners.set(seat.seatId, seat);
      if (unavailable && now < unavailable.retryAt) continue;
      const attribution =
        seat.attribution ?? (this.requireAttribution ? undefined : { resolve: async () => this.legacyScope });
      if (!attribution) {
        if (issue)
          results.push({ outcome: "failed", issue, detail: "No verified hire tracker attribution." });
        continue;
      }
      try {
        const scope = await attribution.resolve();
        this.scopes.set(scope.identity, attribution);
        const canonicalId = issue === undefined ? undefined : await this.canonicalId(scope, issue);
        if (issue !== undefined && canonicalId !== undefined)
          present.set(seat.seatId, { ...seat, issue, canonicalId, attribution, scope });
        for (const key of [issue, ...(seat.ownedKeys ?? []).map(issueKey)]) {
          if (key === undefined) continue;
          const identity = scopedKey(scope, await this.canonicalId(scope, key));
          this.liveOwners.set(identity, [
            ...(this.liveOwners.get(identity) ?? []),
            { seatId: seat.seatId, title: seat.title },
          ]);
        }
        this.unavailable.delete(observationKey);
        this.unknownOwners.delete(seat.seatId);
      } catch (error) {
        const result: SeatIssueSettlement = {
          outcome: "failed",
          ...(issue ? { issue } : {}),
          detail: error instanceof Error ? error.message : String(error),
        };
        const attempts = Math.min((unavailable?.attempts ?? 0) + 1, 5);
        this.unavailable.set(observationKey, {
          attempts,
          retryAt: this.now() + Math.min(30_000 * 2 ** (attempts - 1), 300_000),
        });
        results.push(result);
      }
    }
    for (const key of this.unavailable.keys()) if (!observedKeys.has(key)) this.unavailable.delete(key);
    this.live = new Set(this.liveOwners.keys());
    for (const [seatId, seat] of present)
      this.seats.set(seatId, {
        title: seat.title,
        issue: seat.issue,
        canonicalId: seat.canonicalId,
        attribution: seat.attribution,
      });
    for (const [seatId, seat] of this.seats) {
      if (present.has(seatId)) continue;
      // A present seat with unavailable attribution has not exited.
      if (seats.some((observed) => observed.seatId === seatId)) {
        delete seat.goneSince;
        continue;
      }
      seat.goneSince ??= now;
      if (now - seat.goneSince < this.exitGraceMs) continue;
      this.seats.delete(seatId);
      results.push(
        await this.retire(seatId, {
          issue: seat.issue,
          canonicalId: seat.canonicalId,
          attribution: seat.attribution,
          seat: seat.title,
          why: "its seat exited without a close",
          // A crash leaves work mid-flight; resume() restores it when a seat returns.
          outcome: "paused",
        }),
      );
    }
    results.push(...(await this.retryRetirements(present)));
    for (const seat of present.values())
      if (Object.hasOwn(this.state.paused, scopedKey(seat.scope, seat.canonicalId)))
        results.push(await this.resume(seat));
    return results;
  }

  /** A lead closed this seat; its stated outcome decides the issue's next status. */
  public async closed(input: {
    seatId: string;
    reason: string;
    outcome?: SeatIssueOutcome | undefined;
    evidence?: string | undefined;
    unlanded?: boolean | undefined;
    /** Refs this close parked clean unlanded commits on (VUH-2802). */
    parked?: readonly string[] | undefined;
  }): Promise<SeatIssueSettlement> {
    const seat = this.seats.get(input.seatId);
    this.seats.delete(input.seatId);
    this.unknownOwners.delete(input.seatId);
    for (const [key, owners] of this.liveOwners) {
      const remaining = owners.filter((owner) => owner.seatId !== input.seatId);
      if (remaining.length) this.liveOwners.set(key, remaining);
      else {
        this.liveOwners.delete(key);
        this.live.delete(key);
      }
    }
    if (seat === undefined) return { outcome: "skipped", detail: "The seat had no tracked issue." };
    return this.retire(input.seatId, {
      issue: seat.issue,
      canonicalId: seat.canonicalId,
      attribution: seat.attribution,
      seat: seat.title,
      why: input.reason,
      outcome: input.outcome,
      evidence: input.evidence,
      unlanded: input.unlanded,
      parked: input.parked,
    });
  }

  /**
   * Once a day, list In Progress issues no live seat owns for the lead to
   * resolve. Returns undefined when the check is not due or found nothing.
   */
  public async dailyCheck(force = false): Promise<string | undefined> {
    // An unreadable live assignment cannot prove an orphan. Leave the check due
    // so the next successful roster observation can make a complete report.
    if (this.unknownOwners.size) return;
    const now = this.now();
    const last = this.state.lastCheckAt === undefined ? undefined : Date.parse(this.state.lastCheckAt);
    if (!force && last !== undefined && now - last < DAY_MS) return;
    const orphans: string[] = [];
    const owners = await this.humanOwners();
    const scopes = new Map<string, SeatIssueTrackerScope>();
    if (!this.requireAttribution) scopes.set(this.legacyScope.identity, this.legacyScope);
    for (const attribution of this.scopes.values()) {
      try {
        const scope = await attribution.resolve();
        scopes.set(scope.identity, scope);
      } catch {
        /* A revoked scope is unavailable, never the default tracker. */
      }
    }
    for (const scope of scopes.values()) {
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = (await scope.call(
          "list_issues",
          { state: "started", limit: 250, ...(cursor === undefined ? {} : { cursor }) },
          "background",
        )) as Row;
        const rows = Array.isArray(result) ? result : Array.isArray(result.issues) ? result.issues : [];
        for (const row of rows as Row[]) {
          const key = text(row.identifier) ?? text(row.id);
          if (key === undefined || text(row.status)?.toLowerCase() !== "in progress") continue;
          const assignee =
            typeof row.assignee === "object" && row.assignee !== null ? (row.assignee as Row) : undefined;
          const assigneeId = text(assignee?.id) ?? text(row.assigneeId);
          const assigneeEmail = text(assignee?.email);
          // Only configured owner identity counts; names and arbitrary assignees are not proof.
          if (
            (assigneeId !== undefined && owners.ownerUserIds.includes(assigneeId)) ||
            (assigneeEmail !== undefined &&
              owners.ownerUserEmails.some((email) => email.toLowerCase() === assigneeEmail.toLowerCase()))
          )
            continue;
          if (!this.live.has(scopedKey(scope, text(row.id) ?? key)))
            orphans.push(`- ${key}: ${oneLine(text(row.title) ?? "")}`);
        }
        cursor = !Array.isArray(result) && result.hasNextPage === true ? text(result.cursor) : undefined;
        if (cursor === undefined) break;
      }
    }
    this.state.lastCheckAt = new Date(now).toISOString();
    this.save();
    if (!orphans.length) return;
    return [
      `Daily status check: ${orphans.length} In Progress issue${orphans.length === 1 ? "" : "s"} with no live owning seat.`,
      "Resolve each: Done with evidence, Verifying, Paused with where it stopped, or hand it to a seat (work-items skill).",
      ...orphans.slice(0, 100),
      ...(orphans.length > 100 ? [`…and ${orphans.length - 100} more.`] : []),
    ].join("\n");
  }

  /**
   * Settle now, or keep a failed settlement for retry in later roster rounds
   * with its original outcome and evidence. The pane is never closed again.
   */
  private async retire(seatId: string, retirement: Retirement): Promise<SeatIssueSettlement> {
    const pending: PendingRetirement = { retirement, attempts: 0, retryAt: 0, until: 0 };
    const result = await this.settle(pending, "interactive");
    if (result.outcome !== "failed") return result;
    pending.until = this.now() + RETIREMENT_RETRY_MS;
    this.pending.set(seatId, pending);
    return this.deferred(pending, result);
  }

  private async retryRetirements(
    present: ReadonlyMap<string, { canonicalId: string }>,
  ): Promise<SeatIssueSettlement[]> {
    const results: SeatIssueSettlement[] = [];
    for (const [seatId, pending] of this.pending) {
      // A seat that returned with confirmed attribution owns its issue again.
      if (present.get(seatId)?.canonicalId === pending.retirement.canonicalId && pending.plan === undefined) {
        this.pending.delete(seatId);
        continue;
      }
      if (pending.running || this.now() < pending.retryAt) continue;
      pending.running = true;
      try {
        const result = await this.settle(pending, "background");
        if (result.outcome !== "failed") {
          this.pending.delete(seatId);
          results.push(result);
        } else if (this.now() >= pending.until) {
          this.pending.delete(seatId);
          results.push({
            ...result,
            detail: `${result.detail ?? ""} Issue settlement retries ended; settle it by hand.`.trim(),
          });
        } else results.push(this.deferred(pending, result));
      } finally {
        pending.running = false;
      }
    }
    return results;
  }

  private deferred(pending: PendingRetirement, result: SeatIssueSettlement): SeatIssueSettlement {
    pending.attempts = Math.min(pending.attempts + 1, 5);
    pending.retryAt = this.now() + Math.min(30_000 * 2 ** (pending.attempts - 1), 300_000);
    return { ...result, retryUntil: new Date(pending.until).toISOString() };
  }

  private async settle(
    pending: PendingRetirement,
    priority: LinearRequestPriority,
  ): Promise<SeatIssueSettlement> {
    const input = pending.retirement;
    let intended = pending.plan ? pending.plan.result.intended : retirementIntent(input);
    try {
      const scope = await input.attribution.resolve();
      const call = async (tool: string, args: Row) => (await scope.call(tool, args, priority)) as Row;
      const targetId = input.canonicalId;
      let plan = pending.plan;
      let current: string | undefined;
      if (plan !== undefined) {
        // A started settlement only finishes; a retry never decides it again.
        if (plan.scope !== scope.identity) throw new Error("Retirement tracker scope changed");
      } else {
        const identity = scopedKey(scope, targetId);
        let successor = this.liveOwners.get(identity)?.[0];
        if (!successor)
          for (const seat of this.unknownOwners.values()) {
            const keys = [...seat.keys, ...(seat.ownedKeys ?? [])]
              .map(issueKey)
              .filter((key) => key !== undefined);
            if (!keys.length) throw new Error("Live successor assignment is unavailable");
            // Canonical identity in this verified scope can prove the seat names
            // other work. In any other scope it could not own this target either.
            let names: boolean | undefined = false;
            for (const key of keys) {
              try {
                if ((await this.canonicalId(scope, key)) !== targetId) continue;
                names = true;
              } catch (error) {
                // A key with no item in this scope names other work, e.g. another tracker's key.
                if (absentFrom(scope, error)) continue;
                names = undefined;
              }
              break;
            }
            if (names === false) continue;
            // Observation backoff is not retirement authority. Recheck each
            // possible successor now; if still unknown, defer without effects.
            const attribution =
              seat.attribution ??
              (this.requireAttribution ? undefined : { resolve: async () => this.legacyScope });
            if (!attribution) throw new Error("Live successor tracker attribution is unavailable");
            const candidate = await attribution.resolve();
            if (candidate.identity !== scope.identity) continue;
            for (const key of keys) {
              if ((await this.canonicalId(candidate, key)) === targetId) {
                successor = { seatId: seat.seatId, title: seat.title };
                break;
              }
            }
            if (successor) break;
          }
        if (successor) intended = "In Progress";
        const issue = await call("get_issue", { id: targetId });
        const canonicalId = text(issue.id);
        if (!canonicalId || canonicalId !== targetId)
          throw new Error("Tracker returned a different canonical issue identity");
        current = text(issue.status) ?? text(issue.state);
        const retirement = [
          `${successor ? `Handed from ${input.seat} to ${successor.title}` : `${input.seat} left`}: ${oneLine(input.why)}.`,
          input.evidence ? ` Evidence: ${oneLine(input.evidence)}.` : "",
          input.unlanded ? " Unlanded work was left behind." : "",
          input.parked?.length ? ` Unlanded commits parked on ${input.parked.join(", ")}.` : "",
        ].join("");
        const stage = text(issue.stage);
        if (scope.backend === "builtin" && ["landed", "delivered", "owner-verified"].includes(stage ?? "")) {
          if (!current) throw new Error("Tracker returned no current delivery status");
          // Retirement describes activity, not permission to rewind or verify delivery.
          plan = {
            scope: scope.identity,
            identity,
            comment: `${retirement} Retirement activity: ${intended ?? "no outcome stated"}. Delivery preserved: ${stage}. Status: ${current}.`,
            pause: false,
            result: {
              outcome: "updated",
              issue: input.issue,
              ...stated(intended),
              status: current,
              detail: `Delivery preserved: ${stage}; retirement activity recorded in comment.`,
            },
          };
        } else if (CLOSED_TYPES.has(text(issue.statusType) ?? ""))
          return {
            outcome: "skipped",
            issue: input.issue,
            ...stated(intended),
            detail: `Already ${current}.`,
          };
        else if (intended === undefined || backward(intended, current)) {
          if (!current) throw new Error("Tracker returned no current status");
          plan = {
            scope: scope.identity,
            identity,
            comment: `${retirement} Status kept: ${current}${intended === undefined ? " (no outcome stated)" : ` (asked ${intended}; it doesn't move an item back out of review)`}.`,
            pause: false,
            result: {
              outcome: "updated",
              issue: input.issue,
              ...stated(intended),
              status: current,
              detail: `Status kept: ${current}.`,
            },
          };
        } else {
          const goal = intended;
          const team = text(issue.teamId) ?? text(issue.team);
          const statuses = await call("list_issue_statuses", { team });
          const rows = (Array.isArray(statuses) ? statuses : (statuses.statuses ?? [])) as Row[];
          const named = (name: string) =>
            rows.find((row) => text(row.name)?.toLowerCase() === name.toLowerCase());
          const fallback = goal === "Verifying" || goal === "Paused" ? FALLBACK[goal] : undefined;
          const target =
            named(goal) ??
            (fallback && (named(fallback.name) ?? rows.find((row) => row.type === fallback.type))) ??
            (goal === "Done" ? rows.find((row) => row.type === "completed") : undefined);
          const status = text(target?.name);
          if (status === undefined) throw new Error(`No ${goal} status`);
          const missing = status.toLowerCase() !== goal.toLowerCase();
          plan = {
            scope: scope.identity,
            identity,
            status,
            comment: `${retirement} Status: ${status}${missing ? ` (intended ${goal}; that status does not exist yet)` : ""}.`,
            pause: goal === "Paused",
            result: { outcome: "updated", issue: input.issue, intended: goal, status },
          };
        }
      }
      // Frozen before the first external effect so a retry applies each effect once.
      pending.plan = plan;
      if (plan.status !== undefined && !plan.statusSet) {
        if (current === undefined) {
          const issue = await call("get_issue", { id: targetId });
          if (text(issue.id) !== targetId)
            throw new Error("Tracker returned a different canonical issue identity");
          current = text(issue.status) ?? text(issue.state);
          // Settled by someone else between attempts.
          if (current !== plan.status && CLOSED_TYPES.has(text(issue.statusType) ?? ""))
            return {
              outcome: "skipped",
              issue: input.issue,
              ...stated(intended),
              detail: `Already ${current}.`,
            };
        }
        if (plan.status !== current) await call("save_issue", { id: targetId, state: plan.status });
        plan.statusSet = true;
      }
      if (!plan.commented) {
        // An uncertain earlier post may have applied; read before posting again.
        if (!plan.commentAttempted || !(await this.hasComment(scope, targetId, plan.comment, priority))) {
          plan.commentAttempted = true;
          await call("save_comment", { issueId: targetId, body: plan.comment });
        }
        plan.commented = true;
      }
      if (plan.pause) this.state.paused[plan.identity] = new Date(this.now()).toISOString();
      else delete this.state.paused[plan.identity];
      this.save();
      return plan.result;
    } catch (error) {
      return {
        outcome: "failed",
        issue: input.issue,
        ...stated(intended),
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async hasComment(
    scope: SeatIssueTrackerScope,
    issueId: string,
    body: string,
    priority: LinearRequestPriority,
  ): Promise<boolean> {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = (await scope.call(
        "list_comments",
        { issueId, limit: 100, ...(cursor === undefined ? {} : { cursor }) },
        priority,
      )) as Row;
      const rows = Array.isArray(result)
        ? result
        : Array.isArray(result.comments)
          ? result.comments
          : undefined;
      if (rows === undefined) throw new Error("Tracker comments are unreadable");
      if ((rows as Row[]).some((row) => text(row.body)?.trim() === body.trim())) return true;
      cursor = !Array.isArray(result) && result.hasNextPage === true ? text(result.cursor) : undefined;
      if (cursor === undefined) return false;
    }
    throw new Error("Tracker comments exceed the retirement lookup bound");
  }

  private async resume(
    seat: LiveSeatIssue & {
      issue: string;
      canonicalId: string;
      attribution: SeatIssueAttribution;
      scope: SeatIssueTrackerScope;
    },
  ): Promise<SeatIssueSettlement> {
    try {
      const scope = await seat.attribution.resolve();
      const identity = scopedKey(scope, seat.canonicalId);
      const call = async (tool: string, args: Row) => (await scope.call(tool, args, "background")) as Row;
      const issue = await call("get_issue", { id: seat.canonicalId });
      const canonicalId = text(issue.id);
      if (!canonicalId || canonicalId !== seat.canonicalId)
        throw new Error("Tracker returned a different canonical issue identity");
      if (text(issue.statusType) !== "unstarted" && text(issue.status)?.toLowerCase() !== "paused")
        return { outcome: "skipped", issue: seat.issue, detail: `Already ${text(issue.status)}.` };
      await call("save_issue", { id: canonicalId, state: "In Progress" });
      await call("save_comment", {
        issueId: canonicalId,
        body: `${seat.title} is working on it again. Status: In Progress.`,
      });
      delete this.state.paused[identity];
      this.save();
      return { outcome: "updated", issue: seat.issue, intended: "In Progress", status: "In Progress" };
    } catch (error) {
      return {
        outcome: "failed",
        issue: seat.issue,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Cache only immutable IDs within the complete saved scope; aliases share ownership. */
  private async canonicalId(scope: SeatIssueTrackerScope, reference: string): Promise<string> {
    const cached = this.identities.get(scopedKey(scope, reference));
    if (cached) return cached;
    const issue = (await scope.call("get_issue", { id: reference }, "background")) as Row;
    const id = text(issue.id);
    const key = text(issue.identifier);
    if (!id || (reference !== id && reference !== key))
      throw new Error("Tracker returned a different canonical issue identity");
    this.identities.set(scopedKey(scope, id), id);
    if (key) this.identities.set(scopedKey(scope, key), id);
    return id;
  }

  private async call(tool: string, args: Row, requestPriority: LinearRequestPriority): Promise<Row> {
    const result = await this.tracker.call({
      lane: "operator",
      server: "linear",
      tool,
      arguments: args,
      resultMode: "data",
      requestPriority,
      timeoutMs: 15_000,
    });
    if (result.outcome !== "ok") throw new Error(`${tool}: ${result.reason} ${result.detail}`);
    if (result.isError) throw new Error(`${tool}: ${result.content.slice(0, 300)}`);
    return JSON.parse(result.content) as Row;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state));
    renameSync(temporary, this.path);
  }
}
