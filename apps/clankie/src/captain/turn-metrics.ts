import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CaptainSessionLaneV2Schema, type CaptainSessionLaneV2 } from "@clankie/protocol";
import { z } from "zod";

export const TURN_SETTLED_LOG_NAME = "turn-settled.jsonl";
export const TURN_SETTLED_METRICS_TYPE = "captain.turn.settled" as const;

export const TurnSettledOutcomeSchema = z.enum(["completed", "failed", "interrupted"]);
export type TurnSettledOutcome = z.infer<typeof TurnSettledOutcomeSchema>;

/**
 * One JSONL line per settled operator or Discord captain turn. Counters and
 * names only — never Pi trees, tool arguments, tool outputs, or message text.
 */
export const TurnSettledMetricsSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal(TURN_SETTLED_METRICS_TYPE),
    conversationId: z.string().min(1),
    lane: CaptainSessionLaneV2Schema,
    runId: z.string().min(1),
    acceptedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    failedAt: z.string().datetime().optional(),
    outcome: TurnSettledOutcomeSchema,
    toolCount: z.record(z.string(), z.number().int().nonnegative()),
    firstMutatingAt: z.string().datetime().optional(),
    firstMutatingTool: z.string().min(1).optional(),
    mutatingCount: z.number().int().nonnegative(),
    surveyToolCountBeforeFirstMutation: z.number().int().nonnegative().optional(),
    contextTokensStart: z.number().int().nonnegative().optional(),
    contextTokensEnd: z.number().int().nonnegative().optional(),
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
export type TurnSettledMetrics = z.infer<typeof TurnSettledMetricsSchema>;

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

  public constructor(start: TurnMetricsStart) {
    this.conversationId = start.conversationId;
    this.lane = start.lane;
    this.runId = start.runId;
    this.acceptedAt = start.acceptedAt;
    this.contextTokensStart = start.contextTokensStart;
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
    });
  }
}

function totalToolCount(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

/** Count a Pi tool invocation by name; arguments are used only to classify bash. */
export function recordPiToolStart(
  metrics: TurnMetrics,
  event: { readonly type: string; readonly toolName?: string; readonly args?: unknown },
  at: Date = new Date(),
): void {
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
