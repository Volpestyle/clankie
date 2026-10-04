import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { codexAccounts } from "@clankie/settings";
import { redactSensitiveText } from "@clankie/observability";
import { OperatorGoalSchema, type OperatorGoal } from "@clankie/protocol";
import type { HerdrAgentSession } from "./index.ts";

/**
 * Read the native goal store without resuming a thread or opening a model turn.
 * Codex keeps goals in goals_1.sqlite, independently of rollouts and turn status.
 * Unknown schemas, missing stores and read errors mean unknown, never no goal.
 */
export function readCodexGoal(
  session: HerdrAgentSession,
  homes: readonly string[] = codexAccounts().map((account) => account.home),
): OperatorGoal | undefined {
  const id = codexGoalSessionId(session);
  if (id === undefined) return undefined;
  for (const home of homes) {
    const path = join(home, "goals_1.sqlite");
    if (!existsSync(path)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const row = db.prepare(LOCAL_CODEX_GOAL_QUERY).get(id);
      if (row === undefined) continue;
      return parseCodexGoal(row);
    } catch {
      // A future schema or unavailable account does not take down the fleet.
    } finally {
      db?.close();
    }
  }
  return undefined;
}

/** Only the native UUID is used as a bound SQL parameter, never as a path. */
export function codexGoalSessionId(session: HerdrAgentSession): string | undefined {
  const id =
    session.kind === "id"
      ? session.value
      : session.value.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/iu)?.[1];
  return id !== undefined && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id) ? id : undefined;
}

// Local reads retain the complete objective until the shared redactor runs.
// Cutting raw text can remove a closing quote or part of a credential prefix.
const LOCAL_CODEX_GOAL_QUERY =
  "SELECT objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms FROM thread_goals WHERE thread_id = ? LIMIT 1";

/** Transfer complete bounded text only; a partial objective is an unknown observation. */
export const CODEX_GOAL_QUERY =
  "SELECT CASE WHEN typeof(objective) = 'text' AND instr(objective, char(0)) = 0 AND length(objective) <= 16384 THEN objective ELSE NULL END AS objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms FROM thread_goals WHERE thread_id = ? LIMIT 1";

/** The local and SSH readers share the same validation, redaction and native states. */
export function parseCodexGoal(value: unknown): OperatorGoal | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.objective !== "string" ||
    typeof row.created_at_ms !== "number" ||
    typeof row.updated_at_ms !== "number"
  )
    return undefined;
  const created = new Date(row.created_at_ms);
  const updated = new Date(row.updated_at_ms);
  if (!Number.isFinite(created.getTime()) || !Number.isFinite(updated.getTime())) return undefined;
  const parsed = OperatorGoalSchema.safeParse({
    objective: redactSensitiveText(row.objective).slice(0, 16_384),
    status:
      row.status === "budgetLimited"
        ? "budget_limited"
        : row.status === "usageLimited"
          ? "usage_limited"
          : row.status,
    ...(row.token_budget == null ? {} : { tokenBudget: row.token_budget }),
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    createdAt: created.toISOString(),
    updatedAt: updated.toISOString(),
  });
  return parsed.success ? parsed.data : undefined;
}
