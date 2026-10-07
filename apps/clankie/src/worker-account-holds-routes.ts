import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WORKER_ACCOUNT_HOLDS_PATH, WorkerAccountHoldRequestSchema } from "@clankie/protocol/worker-accounts";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";

class TooManyHolds extends Error {}

function snapshot(settings: ClankieSettings) {
  const holds = settings.workerAccountHolds;
  return { holds, revision: createHash("sha256").update(JSON.stringify(holds)).digest("hex") };
}

export function createWorkerAccountHoldsRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
): Hono {
  const app = new Hono();
  app.use(WORKER_ACCOUNT_HOLDS_PATH, async (context, next) => {
    context.header("cache-control", "no-store");
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    await next();
  });
  app.get(WORKER_ACCOUNT_HOLDS_PATH, async (context) => {
    const current = await settings.load();
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    return context.json(snapshot(current));
  });
  app.post(WORKER_ACCOUNT_HOLDS_PATH, bodyLimit({ maxSize: 4096 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = WorkerAccountHoldRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_worker_account_hold" }, 400);
    const { expectedRevision, machine, harness, label, held, reason } = input.data;
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          if (snapshot(current).revision !== expectedRevision)
            throw new Error("Worker account holds changed");
          before = JSON.stringify(current);
          const others = current.workerAccountHolds.filter(
            (hold) => !(hold.machine === machine && hold.harness === harness && hold.label === label),
          );
          if (held && others.length >= 64) throw new TooManyHolds();
          return {
            ...current,
            workerAccountHolds: held
              ? [...others, { machine, harness, label, ...(reason === undefined ? {} : { reason }) }]
              : others,
          };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
          if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
        },
      );
      return context.json(snapshot(updated));
    } catch (error) {
      if (error instanceof TooManyHolds) return context.json({ error: "too_many_worker_account_holds" }, 400);
      return context.json({ error: "worker_account_holds_conflict" }, 409);
    }
  });
  return app;
}
