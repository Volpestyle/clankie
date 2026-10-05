import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { RuntimeUpdater, UpdateAuthority } from "../../tui/bin/runtime-updater.ts";

export function createRuntimeUpdateRoutes(options: {
  readonly updater?: RuntimeUpdater | undefined;
  readonly refreshHarnesses?: (() => Promise<unknown>) | undefined;
  readonly pluginVersionInstalled?: ((version: string) => void) | undefined;
  readonly authorize: (request: Request) => Promise<UpdateAuthority | undefined>;
}): Hono {
  const app = new Hono();
  app.post("/v1/harness-plugin-version", bodyLimit({ maxSize: 1024 }), async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    const input = z
      .object({ version: z.string().regex(/^\d+\.\d+\.\d+$/u) })
      .strict()
      .safeParse(await context.req.json().catch(() => undefined));
    if (!input.success) return context.json({ error: "invalid_plugin_version" }, 400);
    if (!options.pluginVersionInstalled) return context.json({ error: "plugin_notices_unavailable" }, 503);
    await authority.guard();
    if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
    options.pluginVersionInstalled(input.data.version);
    return context.json({ ok: true, appliesTo: "next_native_client_request" });
  });
  app.post("/v1/harness-refresh", async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    if (!options.refreshHarnesses) return context.json({ error: "harness_refresh_unavailable" }, 503);
    await authority.guard();
    if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
    context.header("Cache-Control", "no-store");
    return context.json(await options.refreshHarnesses());
  });
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
