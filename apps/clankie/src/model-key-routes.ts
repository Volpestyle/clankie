import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  MODEL_KEYS_PATH,
  MODEL_KEY_SET_PATH,
  MODEL_KEY_VALIDATE_PATH,
  MODEL_SELECT_PATH,
  MODEL_KEY_REMOVE_PATH,
  MODEL_SUBSCRIPTIONS_PATH,
  MODEL_OPTIONS_PATH,
  MODEL_EFFORT_SET_PATH,
  ModelEffortSetRequestSchema,
  ModelOptionsResponseSchema,
  ModelSubscriptionsResponseSchema,
  ModelKeySetRequestSchema,
  ModelKeyValidateRequestSchema,
  ModelSelectRequestSchema,
  ModelKeyRemoveRequestSchema,
  ModelKeysResponseSchema,
  ModelKeyResultSchema,
  MODEL_SUBSCRIPTION_METHODS_PATH,
  MODEL_SUBSCRIPTION_START_PATH,
  MODEL_SUBSCRIPTION_STATUS_PATH,
  MODEL_SUBSCRIPTION_CANCEL_PATH,
  ModelSubscriptionMethodsSchema,
  ModelSubscriptionStartSchema,
  ModelSubscriptionSessionRequestSchema,
  ModelSubscriptionResultSchema,
} from "@clankie/protocol/model-keys";
import type { ModelKeysPort } from "./model-keys.ts";
import type { ModelSignInAuthority } from "./model-subscriptions.ts";

export function createModelKeyRoutes(
  models: ModelKeysPort | undefined,
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  setup: {
    keyEntryAllowed?: (request: Request) => Promise<boolean>;
    signInAuthority?: (request: Request) => Promise<ModelSignInAuthority | undefined>;
  } = {},
): Hono {
  const app = new Hono();
  // Hono handles handler exceptions before outer middleware catches them.
  // Keep broker/runtime failures away from its default raw console.error.
  app.onError((_error, context) => context.json({ ok: false, error: "unavailable" }, 503));
  // No request, raw error or event-log logging. The model port emits catalog-only outcome telemetry.
  for (const path of [
    MODEL_KEYS_PATH,
    MODEL_KEY_SET_PATH,
    MODEL_KEY_VALIDATE_PATH,
    MODEL_SELECT_PATH,
    MODEL_KEY_REMOVE_PATH,
    MODEL_SUBSCRIPTIONS_PATH,
    MODEL_OPTIONS_PATH,
    MODEL_EFFORT_SET_PATH,
    MODEL_SUBSCRIPTION_METHODS_PATH,
    MODEL_SUBSCRIPTION_START_PATH,
    MODEL_SUBSCRIPTION_STATUS_PATH,
    MODEL_SUBSCRIPTION_CANCEL_PATH,
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
  app.get(MODEL_SUBSCRIPTIONS_PATH, async (context) => {
    try {
      const listed = (await models!.subscriptions?.()) ?? { subscriptions: [] };
      return context.json(ModelSubscriptionsResponseSchema.parse(listed));
    } catch {
      return context.json({ ok: false, error: "unavailable" }, 503);
    }
  });
  app.get(MODEL_SUBSCRIPTION_METHODS_PATH, async (context) => {
    if (!models?.subscriptionMethods) return context.json({ ok: false, error: "unavailable" }, 503);
    return context.json(ModelSubscriptionMethodsSchema.parse(await models.subscriptionMethods()));
  });
  for (const path of [
    MODEL_SUBSCRIPTION_START_PATH,
    MODEL_SUBSCRIPTION_STATUS_PATH,
    MODEL_SUBSCRIPTION_CANCEL_PATH,
  ]) {
    app.post(path, async (context) => {
      const authority = await setup.signInAuthority?.(context.req.raw);
      if (!authority) return context.json({ ok: false, error: "forbidden" }, 403);
      const body: unknown = await context.req.json().catch(() => undefined);
      let result;
      if (path === MODEL_SUBSCRIPTION_START_PATH) {
        const parsed = ModelSubscriptionStartSchema.safeParse(body);
        if (!parsed.success) return context.json({ ok: false, error: "malformed" }, 400);
        result = await models!.startSubscription?.(parsed.data, authority);
      } else {
        const parsed = ModelSubscriptionSessionRequestSchema.safeParse(body);
        if (!parsed.success) return context.json({ ok: false, error: "malformed" }, 400);
        result = models!.subscriptionStatus?.(
          parsed.data.sessionId,
          authority.principal,
          path === MODEL_SUBSCRIPTION_CANCEL_PATH,
        );
      }
      const safe = ModelSubscriptionResultSchema.parse(result ?? { ok: false, error: "unavailable" });
      return context.json(
        safe,
        safe.ok ? 200 : safe.error === "busy" ? 409 : safe.error === "session_not_found" ? 404 : 400,
      );
    });
  }
  app.get(MODEL_OPTIONS_PATH, async (context) => {
    try {
      if (models!.options === undefined) return context.json({ ok: false, error: "unavailable" }, 503);
      return context.json(ModelOptionsResponseSchema.parse(await models!.options()));
    } catch {
      return context.json({ ok: false, error: "unavailable" }, 503);
    }
  });
  for (const path of [
    MODEL_KEY_SET_PATH,
    MODEL_KEY_VALIDATE_PATH,
    MODEL_SELECT_PATH,
    MODEL_KEY_REMOVE_PATH,
    MODEL_EFFORT_SET_PATH,
  ]) {
    app.post(path, async (context) => {
      try {
        const body: unknown = await context.req.json().catch(() => undefined);
        const result = await (async () => {
          if (path === MODEL_KEY_SET_PATH) {
            const parsed = ModelKeySetRequestSchema.safeParse(body);
            if (parsed.success)
              return models!.set(
                parsed.data.providerId,
                parsed.data.apiKey,
                async () =>
                  (await authorize(context.req.raw)) === true &&
                  ((await setup.keyEntryAllowed?.(context.req.raw)) ?? true),
              );
          } else if (path === MODEL_KEY_VALIDATE_PATH) {
            const parsed = ModelKeyValidateRequestSchema.safeParse(body);
            if (parsed.success) return models!.validate(parsed.data.providerId, parsed.data.modelId);
          } else if (path === MODEL_SELECT_PATH) {
            const parsed = ModelSelectRequestSchema.safeParse(body);
            if (parsed.success) return models!.select(parsed.data.model);
          } else if (path === MODEL_EFFORT_SET_PATH) {
            const parsed = ModelEffortSetRequestSchema.safeParse(body);
            if (parsed.success)
              return models!.setEffort === undefined
                ? ({ ok: false, error: "unavailable" } as const)
                : models!.setEffort(parsed.data.effort);
          } else {
            const parsed = ModelKeyRemoveRequestSchema.safeParse(body);
            if (parsed.success) return models!.remove(parsed.data.providerId);
          }
          return { ok: false, error: "malformed" } as const;
        })();
        const safe = ModelKeyResultSchema.parse(result);
        return context.json(safe, safe.ok ? 200 : safe.error === "forbidden" ? 403 : 400);
      } catch {
        // Broker failures and upstream errors may contain a key. Never forward or log them.
        return context.json({ ok: false, error: "unavailable" }, 503);
      }
    });
  }
  return app;
}
