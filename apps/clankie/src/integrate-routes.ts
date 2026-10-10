import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  INTEGRATE_PATH,
  IntegrationRequestSchema,
  IntegrationResponseSchema,
} from "@clankie/protocol/integrate";
import type { IntegrationQueue } from "./integrate.ts";
import type { DeployHolds } from "./deploy-holds.ts";

/** Owner-only Git execution; fleet/body/device tokens cannot create a landing override. */
export function createIntegrationRoutes(options: {
  queue?: IntegrationQueue | undefined;
  holds?: DeployHolds | undefined;
  authorize: (request: Request) => Promise<(() => Promise<void>) | undefined>;
}): Hono {
  const app = new Hono();
  app.use(INTEGRATE_PATH, bodyLimit({ maxSize: 64 * 1024 }));
  app.post(INTEGRATE_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const guard = await options.authorize(context.req.raw);
    if (!guard) return context.json({ ok: false, error: "operator_required" }, 403);
    const parsed = IntegrationRequestSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ ok: false, error: "invalid_integration_request" }, 400);
    const request = parsed.data;
    if (!options.holds || (!options.queue && ["run", "status", "push"].includes(request.action)))
      return context.json({ ok: false, error: "integration_unavailable" }, 503);
    try {
      await guard();
      const result = await (async () => {
        if (request.action === "holds")
          return { ok: true, holds: await options.holds!.list(), receipts: await options.holds!.receipts() };
        if (request.action === "hold") return { ok: true, holds: await options.holds!.acquire(request) };
        if (request.action === "release") {
          const { holds, receipt } = await options.holds!.release(request.id, request.actor, request.reason);
          return { ok: true, holds, receipts: [receipt] };
        }
        if (request.action === "status" && !request.id)
          return { ok: true, queue: await options.queue!.snapshot() };
        const batch =
          request.action === "run"
            ? await options.queue!.start(request, guard)
            : request.action === "push"
              ? await options.queue!.land(request.id, guard)
              : await options.queue!.status(request.id!);
        return { ok: !["conflict", "failed", "held", "partial", "interrupted"].includes(batch.state), batch };
      })();
      return context.json(IntegrationResponseSchema.parse(result));
    } catch (error) {
      return context.json({ ok: false, error: String(error) }, 409);
    }
  });
  return app;
}
