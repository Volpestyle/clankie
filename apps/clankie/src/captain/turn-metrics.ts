import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CAPTAIN_TURN_METRICS_LIMIT_DEFAULT,
  CAPTAIN_TURN_METRICS_LIMIT_MAX,
  CaptainTurnSettledMetricsSchema,
  type CaptainSessionLaneV2,
  type CaptainTurnExecution,
  type CaptainTurnSettledMetrics,
  type CaptainTurnSettledOutcome,
} from "@clankie/protocol";

const TURN_SETTLED_LOG_NAME = "turn-settled.jsonl";
const TURN_SETTLED_METRICS_TYPE = "captain.turn.settled" as const;

export type TurnSettledOutcome = CaptainTurnSettledOutcome;
export type TurnSettledMetrics = CaptainTurnSettledMetrics;
export type TurnExecutionIdentity = CaptainTurnExecution;

/**
 * One JSONL line per settled operator or Discord captain turn. Counters and
 * names only — never Pi trees, tool arguments, tool outputs, or message text.
 * The row shape is the public contract in `@clankie/protocol`, so what the log
 * writes and what the read surfaces answer are the same record.
 */
export const TurnSettledMetricsSchema = CaptainTurnSettledMetricsSchema;

const GIT_INSPECTION_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "rev-parse",
  "describe",
  "ls-files",
  "ls-tree",
  "cat-file",
  "name-rev",
  "symbolic-ref",
  "rev-list",
  "version",
  "help",
  "shortlog",
  "grep",
  "check-ignore",
  "merge-base",
]);

/**
 * write and edit always mutate. bash is classified from the first whitespace
 * token and, when that token is `git`, the next non-flag token.
 *
 * ponytail: this is not a shell parser. Pipelines, `VAR=1 git …`, `sh -c`, and
 * `git status && rm` are classified from the first token only — a `git status`
 * that is not the first token counts as mutating, and a mutating command after
 * `git status &&` counts as inspection.
 */
export function isMutatingTool(name: string, args?: unknown): boolean {
  if (name === "write" || name === "edit") return true;
  if (name !== "bash") return false;
  const command = bashCommand(args);
  if (command === undefined) return true;
  const tokens = command
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  if ((tokens[0] ?? "") !== "git") return true;
  const subcommand = tokens.find((token, index) => index > 0 && !token.startsWith("-"));
  return subcommand === undefined || !GIT_INSPECTION_SUBCOMMANDS.has(subcommand);
}

function bashCommand(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as { readonly command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

export function contextTokenCount(
  usage: { readonly tokens?: number | null } | undefined,
): number | undefined {
  return typeof usage?.tokens === "number" ? usage.tokens : undefined;
}

/**
 * What is about to run this turn, read off the live session at the moment it
 * executes. A `/model` or `/effort` switch under a live conversation has already
 * landed on the session by then, so it lands on the next executing turn instead
 * of being reconstructed from a settings snapshot after the fact.
 */
export function sessionExecutionIdentity(session: {
  readonly model?: { readonly id?: unknown; readonly provider?: unknown } | undefined;
  readonly thinkingLevel?: unknown;
}): TurnExecutionIdentity | undefined {
  const model = session.model;
  if (typeof model?.id !== "string" || typeof model.provider !== "string") return undefined;
  const effort = typeof session.thinkingLevel === "string" ? session.thinkingLevel : undefined;
  if (model.id.length === 0 || model.provider.length === 0 || effort === undefined || effort.length === 0) {
    return undefined;
  }
  return { model: model.id, provider: model.provider, effort };
}

export interface TurnMetricsStart {
  readonly conversationId: string;
  readonly lane: CaptainSessionLaneV2;
  readonly runId: string;
  readonly acceptedAt: string;
  readonly contextTokensStart?: number;
}

/** In-memory counters for one owned run. An absorbed steer has no collector. */
export class TurnMetrics {
  private readonly conversationId: string;
  private readonly lane: CaptainSessionLaneV2;
  private readonly runId: string;
  private readonly acceptedAt: string;
  private readonly contextTokensStart: number | undefined;
  private readonly toolCount = new Map<string, number>();
  private mutatingCount = 0;
  private toolsBeforeFirstMutation = 0;
  private firstMutatingAt: string | undefined;
  private firstMutatingTool: string | undefined;
  private execution: TurnExecutionIdentity | undefined;
  private reportedTotalTokens = 0;
  private usageReports = 0;

  public constructor(start: TurnMetricsStart) {
    this.conversationId = start.conversationId;
    this.lane = start.lane;
    this.runId = start.runId;
    this.acceptedAt = start.acceptedAt;
    this.contextTokensStart = start.contextTokensStart;
  }

  /** Called as the turn executes, so a failed or interrupted turn still names what ran it. */
  public recordExecution(execution: TurnExecutionIdentity | undefined): void {
    if (execution !== undefined) this.execution = execution;
  }

  public recordTool(name: string, at: Date, args?: unknown): void {
    this.toolCount.set(name, (this.toolCount.get(name) ?? 0) + 1);
    if (!isMutatingTool(name, args)) return;
    if (this.firstMutatingAt === undefined) {
      this.toolsBeforeFirstMutation = totalToolCount(this.toolCount) - 1;
      this.firstMutatingAt = at.toISOString();
      this.firstMutatingTool = name;
    }
    this.mutatingCount += 1;
  }

  /**
   * One assistant message's reported total. A multi-round turn reports once per
   * round; the sum and the number of reports are both kept, because a sum with
   * no count cannot say whether a low number is a cheap turn or a silent
   * provider.
   */
  public recordReportedUsage(totalTokens: number): void {
    if (!Number.isFinite(totalTokens) || totalTokens < 0) return;
    this.reportedTotalTokens += Math.trunc(totalTokens);
    this.usageReports += 1;
  }

  public finish(outcome: TurnSettledOutcome, at: Date, contextTokensEnd?: number): TurnSettledMetrics {
    const atIso = at.toISOString();
    const toolCount = Object.fromEntries(this.toolCount);
    return TurnSettledMetricsSchema.parse({
      schemaVersion: 1,
      type: TURN_SETTLED_METRICS_TYPE,
      conversationId: this.conversationId,
      lane: this.lane,
      runId: this.runId,
      acceptedAt: this.acceptedAt,
      ...(outcome === "completed" ? { completedAt: atIso } : { failedAt: atIso }),
      outcome,
      toolCount,
      ...(this.firstMutatingAt === undefined || this.firstMutatingTool === undefined
        ? {}
        : {
            firstMutatingAt: this.firstMutatingAt,
            firstMutatingTool: this.firstMutatingTool,
            surveyToolCountBeforeFirstMutation: this.toolsBeforeFirstMutation,
          }),
      mutatingCount: this.mutatingCount,
      ...(this.contextTokensStart === undefined ? {} : { contextTokensStart: this.contextTokensStart }),
      ...(contextTokensEnd === undefined ? {} : { contextTokensEnd }),
      ...(this.execution === undefined ? {} : { execution: this.execution }),
      // Nothing reported is unavailable, not zero: an omitted field says so and
      // a zero would read as a free turn.
      ...(this.usageReports === 0
        ? {}
        : { usage: { totalTokens: this.reportedTotalTokens, reports: this.usageReports } }),
    });
  }
}

function totalToolCount(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

/**
 * Count what a Pi session event contributes: a tool invocation by name (its
 * arguments are used only to classify bash), and a finished assistant message's
 * reported usage. One entry point so every lane that subscribes counts the same
 * things — a lane that only forwarded tool starts would lose every usage report.
 */
export function recordPiTurnEvent(
  metrics: TurnMetrics,
  event: {
    readonly type: string;
    readonly toolName?: string;
    readonly args?: unknown;
    readonly message?: { readonly role?: unknown; readonly usage?: { readonly totalTokens?: unknown } };
  },
  at: Date = new Date(),
): void {
  if (event.type === "message_end") {
    if (event.message?.role !== "assistant") return;
    const totalTokens = event.message.usage?.totalTokens;
    if (typeof totalTokens === "number") metrics.recordReportedUsage(totalTokens);
    return;
  }
  if (event.type !== "tool_execution_start") return;
  if (typeof event.toolName !== "string" || event.toolName.length === 0) return;
  metrics.recordTool(event.toolName, at, event.args);
}

export function turnSettledLogPath(stateDir: string): string {
  return join(stateDir, TURN_SETTLED_LOG_NAME);
}

/** Append-only JSONL beside autonomy.json — outside ConversationStore.prune. */
export class TurnSettledLog {
  public readonly path: string;

  public constructor(path: string) {
    this.path = path;
  }

  public append(line: TurnSettledMetrics): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(TurnSettledMetricsSchema.parse(line))}\n`, "utf8");
  }

  /**
   * Recent rows, newest first, bounded by `limit` and optionally narrowed to one
   * run. Rows written before VUH-1115 come back with `execution` and `usage`
   * explicitly null rather than missing, so a reader never has to guess whether
   * an absent field means unknown or zero.
   *
   * ponytail: reads the whole file and scans backwards, like LaneLog. Rotate or
   * index it if the log ever outgrows a read.
   */
  public async read(query: TurnMetricsQuery = {}): Promise<readonly TurnSettledMetrics[]> {
    const limit = boundedLimit(query.limit);
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split("\n");
    const items: TurnSettledMetrics[] = [];
    for (let index = lines.length - 1; index >= 0 && items.length < limit; index -= 1) {
      const line = lines[index];
      if (line === undefined || line.length === 0) continue;
      const row = parseTurnSettledLine(line);
      if (row === undefined) continue;
      if (query.runId !== undefined && row.runId !== query.runId) continue;
      items.push(row);
    }
    return items;
  }
}

export interface TurnMetricsQuery {
  /** Clamped into 1…CAPTAIN_TURN_METRICS_LIMIT_MAX; absent means the default. */
  readonly limit?: number;
  readonly runId?: string;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CAPTAIN_TURN_METRICS_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(limit), 1), CAPTAIN_TURN_METRICS_LIMIT_MAX);
}

function parseTurnSettledLine(line: string): TurnSettledMetrics | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const row = TurnSettledMetricsSchema.safeParse(parsed);
  if (!row.success) return undefined;
  return { ...row.data, execution: row.data.execution ?? null, usage: row.data.usage ?? null };
}

/** An absorbed steer has no collector; a metrics write must not fail the turn. */
export function tryAppendTurnSettled(
  log: TurnSettledLog,
  metrics: TurnMetrics | undefined,
  outcome: TurnSettledOutcome,
  at: Date,
  contextTokensEnd?: number,
): void {
  if (metrics === undefined) return;
  try {
    log.append(metrics.finish(outcome, at, contextTokensEnd));
  } catch {
    // Metrics must not fail the turn they measured.
  }
}
