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
  const id =
    session.kind === "id"
      ? session.value
      : session.value.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/iu)?.[1];
  if (id === undefined || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)) return undefined;
  for (const home of homes) {
    const path = join(home, "goals_1.sqlite");
    if (!existsSync(path)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const row = db
        .prepare(
          "SELECT objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms FROM thread_goals WHERE thread_id = ?",
        )
        .get(id);
      if (row === undefined) continue;
      const status =
        row.status === "budgetLimited"
          ? "budget_limited"
          : row.status === "usageLimited"
            ? "usage_limited"
            : row.status;
      const parsed = OperatorGoalSchema.safeParse({
        objective: redactSensitiveText(String(row.objective)).slice(0, 16_384),
        status,
        ...(row.token_budget == null ? {} : { tokenBudget: row.token_budget }),
        tokensUsed: row.tokens_used,
        timeUsedSeconds: row.time_used_seconds,
        createdAt: new Date(Number(row.created_at_ms)).toISOString(),
        updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
      });
      return parsed.success ? parsed.data : undefined;
    } catch {
      // A future schema or unavailable account does not take down the fleet.
    } finally {
      db?.close();
    }
  }
  return undefined;
}
