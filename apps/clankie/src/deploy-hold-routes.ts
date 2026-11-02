import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  DEPLOY_HOLDS_PATH,
  DeployHoldRequestSchema,
  DeployHoldResponseSchema,
} from "@clankie/protocol/deploy-holds";
import type { DeployHolds } from "./deploy-holds.ts";

/** Owner-only: fleet, body and device tokens cannot place or release a deploy hold. */
export function createDeployHoldRoutes(options: {
  holds?: DeployHolds | undefined;
  authorize: (request: Request) => Promise<(() => Promise<void>) | undefined>;
}): Hono {
  const app = new Hono();
  app.use(DEPLOY_HOLDS_PATH, bodyLimit({ maxSize: 64 * 1024 }));
  app.post(DEPLOY_HOLDS_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const guard = await options.authorize(context.req.raw);
    if (!guard) return context.json({ ok: false, error: "operator_required" }, 403);
    const parsed = DeployHoldRequestSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ ok: false, error: "invalid_deploy_hold_request" }, 400);
    const holds = options.holds;
    if (!holds) return context.json({ ok: false, error: "deploy_holds_unavailable" }, 503);
    const request = parsed.data;
    try {
      await guard();
      const result =
        request.action === "list"
          ? { ok: true, holds: await holds.list(), receipts: await holds.receipts() }
          : request.action === "hold"
            ? { ok: true, holds: await holds.acquire(request) }
            : await holds
                .release(request.id, request.actor, request.reason)
                .then(({ holds, receipt }) => ({ ok: true, holds, receipts: [receipt] }));
      return context.json(DeployHoldResponseSchema.parse(result));
    } catch (error) {
      return context.json({ ok: false, error: String(error) }, 409);
    }
  });
  return app;
}
