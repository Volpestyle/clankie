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
}
export interface LiveSeatIssue {
  readonly seatId: string;
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
type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const oneLine = (value: string) => value.replace(/\s+/gu, " ").trim().slice(0, 400);

export class SeatIssueKeeper {
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
    for (const seat of seats) {
      const keys = [...new Set(seat.keys.map(issueKey).filter((key) => key !== undefined))];
      const issue = keys.length === 1 ? keys[0] : undefined;
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
      } catch (error) {
        results.push({
          outcome: "failed",
          ...(issue ? { issue } : {}),
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
      seat.goneSince ??= now;
      if (now - seat.goneSince < this.exitGraceMs) continue;
      this.seats.delete(seatId);
      results.push(
        await this.settle({
          issue: seat.issue,
          canonicalId: seat.canonicalId,
          attribution: seat.attribution,
          seat: seat.title,
          why: "its seat exited without a close",
        }),
      );
    }
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
  }): Promise<SeatIssueSettlement> {
    const seat = this.seats.get(input.seatId);
    this.seats.delete(input.seatId);
    for (const [key, owners] of this.liveOwners) {
      const remaining = owners.filter((owner) => owner.seatId !== input.seatId);
      if (remaining.length) this.liveOwners.set(key, remaining);
      else {
        this.liveOwners.delete(key);
        this.live.delete(key);
      }
    }
    if (seat === undefined) return { outcome: "skipped", detail: "The seat had no tracked issue." };
    return this.settle({
      issue: seat.issue,
      canonicalId: seat.canonicalId,
      attribution: seat.attribution,
      seat: seat.title,
      why: input.reason,
      outcome: input.outcome,
      evidence: input.evidence,
      unlanded: input.unlanded,
    });
  }

  /**
   * Once a day, list In Progress issues no live seat owns for the lead to
   * resolve. Returns undefined when the check is not due or found nothing.
   */
  public async dailyCheck(force = false): Promise<string | undefined> {
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

  private async settle(input: {
    issue: string;
    canonicalId: string;

    attribution: SeatIssueAttribution;
    seat: string;
    why: string;
    outcome?: SeatIssueOutcome | undefined;
    evidence?: string | undefined;
    unlanded?: boolean | undefined;
  }): Promise<SeatIssueSettlement> {
    let successor: { seatId: string; title: string } | undefined;
    // Done needs evidence; a stated Done without it is proof pending.
    let intended: SeatIssueStatus =
      input.outcome === "done" && input.evidence
        ? "Done"
        : input.outcome === "done" || input.outcome === "verifying"
          ? "Verifying"
          : "Paused";
    try {
      const scope = await input.attribution.resolve();
      const targetId = input.canonicalId;
      const identity = scopedKey(scope, targetId);
      successor = this.liveOwners.get(identity)?.[0];
      if (successor) intended = "In Progress";
      const call = async (tool: string, args: Row) => (await scope.call(tool, args, "interactive")) as Row;
      const issue = await call("get_issue", { id: targetId });
      const canonicalId = text(issue.id);
      if (!canonicalId || canonicalId !== targetId)
        throw new Error("Tracker returned a different canonical issue identity");
      const current = text(issue.status) ?? text(issue.state);
      const retirement = [
        `${successor ? `Handed from ${input.seat} to ${successor.title}` : `${input.seat} left`}: ${oneLine(input.why)}.`,
        input.evidence ? ` Evidence: ${oneLine(input.evidence)}.` : "",
        input.unlanded ? " Unlanded work was left behind." : "",
      ].join("");
      const stage = text(issue.stage);
      if (scope.backend === "builtin" && ["landed", "delivered", "owner-verified"].includes(stage ?? "")) {
        if (!current) throw new Error("Tracker returned no current delivery status");
        // Retirement describes activity, not permission to rewind or verify delivery.
        await call("save_comment", {
          issueId: canonicalId,
          body: `${retirement} Retirement activity: ${intended}. Delivery preserved: ${stage}. Status: ${current}.`,
        });
        delete this.state.paused[identity];
        this.save();
        return {
          outcome: "updated",
          issue: input.issue,
          intended,
          status: current,
          detail: `Delivery preserved: ${stage}; retirement activity recorded in comment.`,
        };
      }
      if (CLOSED_TYPES.has(text(issue.statusType) ?? ""))
        return { outcome: "skipped", issue: input.issue, intended, detail: `Already ${current}.` };
      const team = text(issue.teamId) ?? text(issue.team);
      const statuses = await call("list_issue_statuses", { team });
      const rows = (Array.isArray(statuses) ? statuses : (statuses.statuses ?? [])) as Row[];
      const named = (name: string) =>
        rows.find((row) => text(row.name)?.toLowerCase() === name.toLowerCase());
      const fallback = intended === "Verifying" || intended === "Paused" ? FALLBACK[intended] : undefined;
      const target =
        named(intended) ??
        (fallback && (named(fallback.name) ?? rows.find((row) => row.type === fallback.type))) ??
        (intended === "Done" ? rows.find((row) => row.type === "completed") : undefined);
      const status = text(target?.name);
      if (status === undefined) throw new Error(`No ${intended} status`);
      if (status !== current) await call("save_issue", { id: canonicalId, state: status });
      const missing = status.toLowerCase() !== intended.toLowerCase();
      const body = [
        retirement,
        ` Status: ${status}${missing ? ` (intended ${intended}; that status does not exist yet)` : ""}.`,
      ].join("");
      await call("save_comment", { issueId: canonicalId, body });
      if (intended === "Paused") this.state.paused[identity] = new Date(this.now()).toISOString();
      else delete this.state.paused[identity];
      this.save();
      return { outcome: "updated", issue: input.issue, intended, status };
    } catch (error) {
      return {
        outcome: "failed",
        issue: input.issue,
        intended,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
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
