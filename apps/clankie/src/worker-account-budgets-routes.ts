import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WORKER_ACCOUNT_BUDGETS_PATH, WorkerAccountBudgetRequestSchema } from "@clankie/protocol/worker-accounts";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";

class TooManyBudgets extends Error {}

function snapshot(
  settings: ClankieSettings,
  resolve?: (machine: string, harness: string, label: string) => string,
) {
  const budgets = settings.workerAccountBudgets.map((budget) => ({
    ...budget,
    label: resolve?.(budget.machine, budget.harness, budget.label) ?? budget.label,
  }));
  return { budgets, revision: createHash("sha256").update(JSON.stringify(budgets)).digest("hex") };
}

/** Owner-only, revision-fenced per-account usage budgets (#603), shaped like the holds route. */
export function createWorkerAccountBudgetsRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  resolve?: (machine: string, harness: string, label: string) => string,
): Hono {
  const app = new Hono();
  app.use(WORKER_ACCOUNT_BUDGETS_PATH, async (context, next) => {
    context.header("cache-control", "no-store");
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    await next();
  });
  app.get(WORKER_ACCOUNT_BUDGETS_PATH, async (context) => {
    const current = await settings.load();
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    return context.json(snapshot(current, resolve));
  });
  app.post(WORKER_ACCOUNT_BUDGETS_PATH, bodyLimit({ maxSize: 4096 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = WorkerAccountBudgetRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_worker_account_budget" }, 400);
    const { expectedRevision, machine, harness, label, stopAtPercent } = input.data;
    const named = resolve?.(machine, harness, label) ?? label;
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          if (snapshot(current, resolve).revision !== expectedRevision)
            throw new Error("Worker account budgets changed");
          before = JSON.stringify(current);
          const others = current.workerAccountBudgets.filter(
            (budget) =>
              !(
                budget.machine === machine &&
                budget.harness === harness &&
                (resolve?.(machine, harness, budget.label) ?? budget.label) === named
              ),
          );
          if (stopAtPercent !== null && others.length >= 64) throw new TooManyBudgets();
          return {
            ...current,
            workerAccountBudgets:
              stopAtPercent === null ? others : [...others, { machine, harness, label: named, stopAtPercent }],
          };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
          if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
        },
      );
      return context.json(snapshot(updated, resolve));
    } catch (error) {
      if (error instanceof TooManyBudgets) return context.json({ error: "too_many_worker_account_budgets" }, 400);
      return context.json({ error: "worker_account_budgets_conflict" }, 409);
    }
  });
  return app;
}
