import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  MODEL_KEYS_PATH,
  MODEL_KEY_SET_PATH,
  MODEL_KEY_VALIDATE_PATH,
  MODEL_SELECT_PATH,
  MODEL_KEY_REMOVE_PATH,
  ModelKeySetRequestSchema,
  ModelKeyValidateRequestSchema,
  ModelSelectRequestSchema,
  ModelKeyRemoveRequestSchema,
  ModelKeysResponseSchema,
  ModelKeyResultSchema,
} from "@clankie/protocol/model-keys";
import type { ModelKeysPort } from "./model-keys.ts";

export function createModelKeyRoutes(
  models: ModelKeysPort | undefined,
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
): Hono {
  const app = new Hono();
  // Intentionally no request, error, event-log, or telemetry logging in this surface.
  for (const path of [
    MODEL_KEYS_PATH,
    MODEL_KEY_SET_PATH,
    MODEL_KEY_VALIDATE_PATH,
    MODEL_SELECT_PATH,
    MODEL_KEY_REMOVE_PATH,
  ]) {
    app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      try {
        const authority = await authorize(context.req.raw);
        if (authority !== true)
          return context.json({ ok: false, error: authority }, authority === "forbidden" ? 403 : 401);
        if (models === undefined) return context.json({ ok: false, error: "unavailable" }, 503);
        await next();
      } catch {
        return context.json({ ok: false, error: "unavailable" }, 503);
      }
    });
    app.use(
      path,
      bodyLimit({
        maxSize: 16 * 1024,
        onError: (context) => context.json({ ok: false, error: "malformed" }, 413),
      }),
    );
  }
  app.get(MODEL_KEYS_PATH, async (context) => {
    try {
      return context.json(ModelKeysResponseSchema.parse(await models!.list()));
    } catch {
      return context.json({ ok: false, error: "unavailable" }, 503);
    }
  });
  for (const path of [
    MODEL_KEY_SET_PATH,
    MODEL_KEY_VALIDATE_PATH,
    MODEL_SELECT_PATH,
    MODEL_KEY_REMOVE_PATH,
  ]) {
    app.post(path, async (context) => {
      try {
        const body: unknown = await context.req.json().catch(() => undefined);
        const result = await (async () => {
          if (path === MODEL_KEY_SET_PATH) {
            const parsed = ModelKeySetRequestSchema.safeParse(body);
            if (parsed.success) return models!.set(parsed.data.providerId, parsed.data.apiKey);
          } else if (path === MODEL_KEY_VALIDATE_PATH) {
            const parsed = ModelKeyValidateRequestSchema.safeParse(body);
            if (parsed.success) return models!.validate(parsed.data.providerId, parsed.data.modelId);
          } else if (path === MODEL_SELECT_PATH) {
            const parsed = ModelSelectRequestSchema.safeParse(body);
            if (parsed.success) return models!.select(parsed.data.model);
          } else {
            const parsed = ModelKeyRemoveRequestSchema.safeParse(body);
            if (parsed.success) return models!.remove(parsed.data.providerId);
          }
          return { ok: false, error: "malformed" } as const;
        })();
        const safe = ModelKeyResultSchema.parse(result);
        return context.json(safe, safe.ok ? 200 : 400);
      } catch {
        // Broker failures and upstream errors may contain a key. Never forward or log them.
        return context.json({ ok: false, error: "unavailable" }, 503);
      }
    });
  }
  return app;
}
