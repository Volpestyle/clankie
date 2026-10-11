import { Hono } from "hono";
import { z } from "zod";
import { readJson } from "./app/http-auth.ts";
import type { TrustedOperatorIdentity } from "./app/types.ts";
import type { CacheReclamationResult } from "./captain/reclaim-worktree-caches.ts";

/** Owner-authenticated API used by every checkout surface. */
export function createWorktreeCacheRoutes(options: {
  authenticate(request: Request): Promise<TrustedOperatorIdentity | "unavailable" | undefined>;
  reclaim?(repository: string, path?: string): Promise<CacheReclamationResult>;
}) {
  const app = new Hono();
  app.post("/v1/checkouts/reclaim-caches", async (context) => {
    const identity = await options.authenticate(context.req.raw);
    if (!identity || identity === "unavailable")
      return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = z
      .strictObject({
        repository: z.string().min(1).max(4096),
        path: z.string().min(1).max(4096).optional(),
      })
      .safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!options.reclaim) return context.json({ error: "checkouts_unavailable" }, 503);
    try {
      return context.json(await options.reclaim(parsed.data.repository, parsed.data.path));
    } catch (error) {
      return context.json(
        { error: "refused", message: error instanceof Error ? error.message : "Cache reclamation refused" },
        409,
      );
    }
  });
  return app;
}
