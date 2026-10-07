import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  HARNESS_LOGINS_PATH,
  HARNESS_LOGIN_CANCEL_PATH,
  HARNESS_LOGIN_CODE_PATH,
  HARNESS_LOGIN_START_PATH,
  HARNESS_LOGIN_STATUS_PATH,
  HarnessLoginCodeSchema,
  HarnessLoginResultSchema,
  HarnessLoginSessionRequestSchema,
  HarnessLoginStartSchema,
  HarnessLoginsResponseSchema,
  type HarnessLoginResult,
} from "@clankie/protocol/harness-logins";
import type { HarnessSignIns } from "./harness-logins.ts";

/** Same authority as model keys: the operator, or a device holding Take Control. */
export function createHarnessLoginRoutes(
  logins: HarnessSignIns | undefined,
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  principal: (request: Request) => Promise<string | undefined>,
): Hono {
  const app = new Hono();
  app.onError((_error, context) => context.json({ ok: false, error: "unavailable" }, 503));
  // Login links and codes are interaction data: no request or result logging here.
  for (const path of [
    HARNESS_LOGINS_PATH,
    HARNESS_LOGIN_START_PATH,
    HARNESS_LOGIN_STATUS_PATH,
    HARNESS_LOGIN_CODE_PATH,
    HARNESS_LOGIN_CANCEL_PATH,
  ]) {
    app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      const authority = await authorize(context.req.raw);
      if (authority !== true)
        return context.json({ ok: false, error: authority }, authority === "forbidden" ? 403 : 401);
      if (logins === undefined) return context.json({ ok: false, error: "unavailable" }, 503);
      await next();
    });
    app.use(
      path,
      bodyLimit({
        maxSize: 16 * 1024,
        onError: (context) => context.json({ ok: false, error: "malformed" }, 413),
      }),
    );
  }
  app.get(HARNESS_LOGINS_PATH, async (context) =>
    context.json(HarnessLoginsResponseSchema.parse(await logins!.list())),
  );
  const answer = (result: HarnessLoginResult) => {
    const parsed = HarnessLoginResultSchema.parse(result);
    if (parsed.ok) return { body: parsed, status: 200 as const };
    const status = {
      busy: 409,
      not_installed: 404,
      session_not_found: 404,
      malformed: 400,
      forbidden: 403,
      unavailable: 503,
    }[parsed.error] as 400 | 403 | 404 | 409 | 503;
    return { body: parsed, status };
  };
  for (const path of [
    HARNESS_LOGIN_START_PATH,
    HARNESS_LOGIN_STATUS_PATH,
    HARNESS_LOGIN_CODE_PATH,
    HARNESS_LOGIN_CANCEL_PATH,
  ]) {
    app.post(path, async (context) => {
      const who = await principal(context.req.raw);
      if (who === undefined) return context.json({ ok: false, error: "forbidden" }, 403);
      const body: unknown = await context.req.json().catch(() => undefined);
      let result: HarnessLoginResult;
      if (path === HARNESS_LOGIN_START_PATH) {
        const parsed = HarnessLoginStartSchema.safeParse(body);
        if (!parsed.success) return context.json({ ok: false, error: "malformed" }, 400);
        result = await logins!.start(parsed.data.harness, who);
      } else if (path === HARNESS_LOGIN_CODE_PATH) {
        const parsed = HarnessLoginCodeSchema.safeParse(body);
        if (!parsed.success) return context.json({ ok: false, error: "malformed" }, 400);
        result = logins!.code(parsed.data.sessionId, who, parsed.data.code);
      } else {
        const parsed = HarnessLoginSessionRequestSchema.safeParse(body);
        if (!parsed.success) return context.json({ ok: false, error: "malformed" }, 400);
        result = logins!.status(parsed.data.sessionId, who, path === HARNESS_LOGIN_CANCEL_PATH);
      }
      const { body: response, status } = answer(result);
      return context.json(response, status);
    });
  }
  return app;
}
