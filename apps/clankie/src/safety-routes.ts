import { Hono } from "hono";
import { ZodError } from "zod";
import {
  SafetyApprovalAnswerSchema,
  SafetySettingsSchema,
  SafetyUpdateSchema,
  SAFETY_PATH,
  SAFETY_APPROVALS_PATH,
} from "@clankie/protocol";
import type { ClankieSettings } from "@clankie/settings";
import type { SafetyBoundary } from "./safety.ts";

export function createSafetyRoutes(options: {
  settings: {
    load(): Promise<ClankieSettings>;
    update?: (
      mutate: (value: ClankieSettings) => ClankieSettings,
      guard?: () => Promise<void>,
    ) => Promise<ClankieSettings>;
  };
  boundary?: SafetyBoundary;
  authorize: (request: Request) => Promise<boolean>;
}): Hono {
  const app = new Hono();
  for (const path of [SAFETY_PATH, SAFETY_APPROVALS_PATH])
    app.use(path, async (context, next) => {
      if (!(await options.authorize(context.req.raw)))
        return context.json({ error: "operator_authentication_required" }, 401);
      context.header("cache-control", "no-store");
      await next();
    });
  app.get(SAFETY_PATH, async (context) => context.json({ safety: (await options.settings.load()).safety }));
  app.post(SAFETY_PATH, async (context) => {
    const patch = SafetyUpdateSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!patch.success) return context.json({ error: "malformed" }, 400);
    if (!options.settings.update) return context.json({ error: "settings_unavailable" }, 503);
    try {
      const updated = await options.settings.update(
        (value) => ({ ...value, safety: SafetySettingsSchema.parse({ ...value.safety, ...patch.data }) }),
        async () => {
          if (!(await options.authorize(context.req.raw)))
            throw new Error("operator_authentication_required");
        },
      );
      return context.json({ safety: updated.safety });
    } catch (error) {
      if (error instanceof ZodError) return context.json({ error: "malformed" }, 400);
      if (error instanceof Error && error.message === "operator_authentication_required")
        return context.json({ error: error.message }, 401);
      throw error;
    }
  });
  app.get(SAFETY_APPROVALS_PATH, (context) => context.json({ approvals: options.boundary?.list() ?? [] }));
  app.post(SAFETY_APPROVALS_PATH, async (context) => {
    const answer = SafetyApprovalAnswerSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!answer.success) return context.json({ error: "malformed" }, 400);
    if (!options.boundary) return context.json({ error: "safety_unavailable" }, 503);
    if (!(await options.authorize(context.req.raw)))
      return context.json({ error: "operator_authentication_required" }, 401);
    try {
      const approval = await options.boundary.answer(
        answer.data.id,
        answer.data.fingerprint,
        answer.data.approve,
        async () => {
          if (!(await options.authorize(context.req.raw)))
            throw new Error("operator_authentication_required");
        },
      );
      return context.json({ approval });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
  return app;
}
