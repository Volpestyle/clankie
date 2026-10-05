import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { RuntimeUpdater, UpdateAuthority } from "../../tui/bin/runtime-updater.ts";
import { HoldOverrideSchema } from "@clankie/protocol/integrate";
import type { DeployHolds } from "./deploy-holds.ts";

export function createRuntimeUpdateRoutes(options: {
  readonly updater?: RuntimeUpdater | undefined;
  readonly holds?: DeployHolds | undefined;
  readonly authorize: (request: Request) => Promise<UpdateAuthority | undefined>;
}): Hono {
  const app = new Hono();
  app.use("/v1/runtime-update", bodyLimit({ maxSize: 16 * 1024 }));
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
    return context.json({ ...result, ...(options.holds ? { holds: await options.holds.list() } : {}) });
  });
  app.post("/v1/runtime-update", async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    if (!options.updater) return context.json({ error: "runtime_updates_unavailable" }, 503);
    const parsed = z
      .object({
        ref: z.string().min(1).max(256).optional(),
        overrides: z.array(HoldOverrideSchema).max(32).default([]),
      })
      .strict()
      .safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_update_request" }, 400);
    try {
      const deploy = async () => {
        await authority.guard();
        return options.updater!.request(parsed.data.ref ?? "main", authority);
      };
      if (!options.holds && parsed.data.overrides.length) throw Error("Deploy holds unavailable");
      const result = options.holds
        ? await options.holds.landing(
            `runtime-update:${parsed.data.ref ?? "main"}`,
            parsed.data.overrides,
            deploy,
          )
        : await deploy();
      return context.json(result, result.accepted ? 202 : 409);
    } catch (error) {
      return context.json(
        { error: authority.current() ? "update_refused" : "operator_revoked", detail: String(error) },
        authority.current() ? 409 : 403,
      );
    }
  });
  return app;
}
