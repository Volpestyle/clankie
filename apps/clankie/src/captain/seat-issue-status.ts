import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { McpHost } from "../mcp-host.ts";
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
}

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
  const matches = value?.match(/\b[A-Z][A-Z0-9]*-\d+\b/gu);
  return matches?.length === 1 ? matches[0] : undefined;
}

type Tracker = Pick<McpHost, "call">;
type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const oneLine = (value: string) => value.replace(/\s+/gu, " ").trim().slice(0, 400);

export class SeatIssueKeeper {
  private readonly seats = new Map<string, { title: string; issue: string; goneSince?: number }>();
  private live = new Set<string>();
  private state: z.infer<typeof StateSchema> = { paused: {} };
  private readonly now: () => number;
  private readonly exitGraceMs: number;
  private readonly tracker: Tracker;
  private readonly path: string;

  public constructor(
    tracker: Tracker,
    path: string,
    options: { now?: () => number; exitGraceMs?: number } = {},
  ) {
    this.tracker = tracker;
    this.path = path;
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
    const present = new Map<string, LiveSeatIssue & { issue: string }>();
    for (const seat of seats) {
      const issue = seat.keys.map(issueKey).find((key) => key !== undefined);
      if (issue !== undefined) present.set(seat.seatId, { ...seat, issue });
    }
    this.live = new Set([...present.values()].map((seat) => seat.issue));
    const results: SeatIssueSettlement[] = [];
    for (const [seatId, seat] of present) this.seats.set(seatId, { title: seat.title, issue: seat.issue });
    for (const [seatId, seat] of this.seats) {
      if (present.has(seatId)) continue;
      seat.goneSince ??= now;
      if (now - seat.goneSince < this.exitGraceMs) continue;
      this.seats.delete(seatId);
      results.push(
        await this.settle({
          issue: seat.issue,
          seat: seat.title,
          why: "its seat exited without a close",
        }),
      );
    }
    for (const seat of present.values())
      if (Object.hasOwn(this.state.paused, seat.issue)) results.push(await this.resume(seat));
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
    if (seat === undefined) return { outcome: "skipped", detail: "The seat had no tracked issue." };
    return this.settle({
      issue: seat.issue,
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
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.call(
        "list_issues",
        { state: "started", limit: 250, ...(cursor === undefined ? {} : { cursor }) },
        "background",
      );
      const rows = Array.isArray(result) ? result : Array.isArray(result.issues) ? result.issues : [];
      for (const row of rows as Row[]) {
        const key = text(row.identifier) ?? text(row.id);
        if (key === undefined || text(row.status)?.toLowerCase() !== "in progress") continue;
        if (!this.live.has(key)) orphans.push(`- ${key}: ${oneLine(text(row.title) ?? "")}`);
      }
      cursor = !Array.isArray(result) && result.hasNextPage === true ? text(result.cursor) : undefined;
      if (cursor === undefined) break;
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
    seat: string;
    why: string;
    outcome?: SeatIssueOutcome | undefined;
    evidence?: string | undefined;
    unlanded?: boolean | undefined;
  }): Promise<SeatIssueSettlement> {
    const successor = [...this.seats.values()].find((seat) => seat.issue === input.issue && !seat.goneSince);
    // Done needs evidence; a stated Done without it is proof pending.
    const intended: SeatIssueStatus = successor
      ? "In Progress"
      : input.outcome === "done" && input.evidence
        ? "Done"
        : input.outcome === "done" || input.outcome === "verifying"
          ? "Verifying"
          : "Paused";
    try {
      const issue = await this.call("get_issue", { id: input.issue }, "interactive");
      const current = text(issue.status) ?? text(issue.state);
      if (CLOSED_TYPES.has(text(issue.statusType) ?? ""))
        return { outcome: "skipped", issue: input.issue, intended, detail: `Already ${current}.` };
      const team = text(issue.teamId) ?? text(issue.team);
      const statuses = await this.call("list_issue_statuses", { team }, "interactive");
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
      if (status !== current)
        await this.call("save_issue", { id: input.issue, state: status }, "interactive");
      const missing = status.toLowerCase() !== intended.toLowerCase();
      const body = [
        `${successor ? `Handed from ${input.seat} to ${successor.title}` : `${input.seat} left`}: ${oneLine(input.why)}.`,
        input.evidence ? ` Evidence: ${oneLine(input.evidence)}.` : "",
        input.unlanded ? " Unlanded work was left behind." : "",
        ` Status: ${status}${missing ? ` (intended ${intended}; that status does not exist yet)` : ""}.`,
      ].join("");
      await this.call("save_comment", { issueId: input.issue, body }, "interactive");
      if (intended === "Paused") this.state.paused[input.issue] = new Date(this.now()).toISOString();
      else delete this.state.paused[input.issue];
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

  private async resume(seat: LiveSeatIssue & { issue: string }): Promise<SeatIssueSettlement> {
    delete this.state.paused[seat.issue];
    this.save();
    try {
      const issue = await this.call("get_issue", { id: seat.issue }, "background");
      if (text(issue.statusType) !== "unstarted" && text(issue.status)?.toLowerCase() !== "paused")
        return { outcome: "skipped", issue: seat.issue, detail: `Already ${text(issue.status)}.` };
      await this.call("save_issue", { id: seat.issue, state: "In Progress" }, "background");
      await this.call(
        "save_comment",
        { issueId: seat.issue, body: `${seat.title} is working on it again. Status: In Progress.` },
        "background",
      );
      return { outcome: "updated", issue: seat.issue, intended: "In Progress", status: "In Progress" };
    } catch (error) {
      return {
        outcome: "failed",
        issue: seat.issue,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
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
