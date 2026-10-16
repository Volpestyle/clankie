import { isAbsolute } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  VIEWS_PATH,
  ViewExpiredSchema,
  ViewListSchema,
  ViewRenderSchema,
  ViewRequestSchema,
  ViewResultSchema,
} from "@clankie/protocol";
import { renderView, ViewRequestError, type ViewSources, type ViewStore } from "./views.ts";

type ViewCaller = "operator" | "device";

/**
 * Views stay private to the owner (VUH-2035): the same owner authority as
 * fleet resources, which a view can show. List, render, and one POST for
 * create, pin, unpin and expire. `operator` is a local caller holding the
 * operator bearer; `device` is a paired device with terminal control.
 */
export function createViewRoutes(
  authorize: (request: Request) => Promise<ViewCaller | "authentication_required" | "forbidden">,
  store: ViewStore | undefined,
  sources: ViewSources,
): Hono<{ Variables: { caller: ViewCaller } }> {
  const app = new Hono<{ Variables: { caller: ViewCaller } }>();
  for (const path of [VIEWS_PATH, `${VIEWS_PATH}/:id`])
    app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      const authority = await authorize(context.req.raw);
      if (authority !== "operator" && authority !== "device")
        return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
      if (!store) return context.json({ error: "views_unavailable" }, 503);
      context.set("caller", authority);
      await next();
    });
  const failed = (error: unknown) => {
    if (error instanceof ViewRequestError)
      return {
        body: { error: error.code, detail: error.message },
        status: error.code === "not_found" ? 404 : 409,
      } as const;
    throw error;
  };
  app.get(VIEWS_PATH, async (context) => context.json(ViewListSchema.parse({ views: await store!.list() })));
  app.get(`${VIEWS_PATH}/:id`, async (context) => {
    try {
      const view = await store!.get(context.req.param("id"));
      return context.json(ViewRenderSchema.parse(await renderView(view, sources)));
    } catch (error) {
      const { body, status } = failed(error);
      return context.json(body, status);
    }
  });
  app.post(VIEWS_PATH, bodyLimit({ maxSize: 64 * 1024 }), async (context) => {
    const input = ViewRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success)
      return context.json(
        {
          error: "invalid_view_request",
          detail: input.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
            .join("; "),
        },
        400,
      );
    // Sources are read as a local caller on every render, so the trust decision is
    // made here: a device names a tracker only by its registered repo id, never
    // a path that would enroll a new directory (ADR 0191).
    if (input.data.action === "create" && context.get("caller") === "device") {
      const path = Object.entries(input.data.spec.sources).find(
        ([, source]) => source.kind === "tracker_issues" && isAbsolute(source.repo),
      );
      if (path)
        return context.json(
          {
            error: "invalid_view_request",
            detail: `sources.${path[0]}.repo: a device names a registered repo id, not a path`,
          },
          400,
        );
    }
    try {
      const result = await store!.apply(input.data);
      return context.json(
        "expired" in result ? ViewExpiredSchema.parse(result) : ViewResultSchema.parse(result),
        input.data.action === "create" ? 201 : 200,
      );
    } catch (error) {
      const { body, status } = failed(error);
      return context.json(body, status);
    }
  });
  return app;
}
