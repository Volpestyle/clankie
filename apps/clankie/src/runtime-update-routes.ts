import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { RuntimeUpdater, UpdateAuthority } from "../../tui/bin/runtime-updater.ts";

export function createRuntimeUpdateRoutes(options: {
  readonly updater?: RuntimeUpdater | undefined;
  readonly authorize: (request: Request) => Promise<UpdateAuthority | undefined>;
}): Hono {
  const app = new Hono();
  app.use("/v1/runtime-update", bodyLimit({ maxSize: 1024 }));
  app.get("/v1/runtime-update", async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    if (!options.updater) return context.json({ error: "runtime_updates_unavailable" }, 503);
    const result = options.updater.status();
    try {
      await authority.guard();
    } catch {
      return context.json({ error: "operator_revoked" }, 403);
    }
    if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
    context.header("Cache-Control", "no-store");
    return context.json(result);
  });
  app.post("/v1/runtime-update", async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    if (!options.updater) return context.json({ error: "runtime_updates_unavailable" }, 503);
    const parsed = z
      .object({ ref: z.string().min(1).max(256).optional() })
      .strict()
      .safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_update_request" }, 400);
    try {
      const result = await options.updater.request(parsed.data.ref ?? "main", authority);
      return context.json(result, result.accepted ? 202 : 409);
    } catch {
      return context.json(
        { error: authority.current() ? "update_refused" : "operator_revoked" },
        authority.current() ? 409 : 403,
      );
    }
  });
  return app;
}
