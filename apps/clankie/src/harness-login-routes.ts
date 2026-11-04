import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  HARNESS_LOGINS_PATH,
  HARNESS_LOGIN_ACCOUNTS_PATH,
  HARNESS_LOGIN_CANCEL_PATH,
  HARNESS_LOGIN_CODE_PATH,
  HARNESS_LOGIN_INSTALL_PATH,
  HARNESS_LOGIN_REMOVE_PATH,
  HARNESS_LOGIN_START_PATH,
  HARNESS_LOGIN_STATUS_PATH,
  HarnessAccountLoginResultSchema,
  HarnessInstallRequestSchema,
  HarnessInstallResultSchema,
  HarnessLoginAccountsResponseSchema,
  HarnessLoginCodeSchema,
  HarnessLoginRemoveResultSchema,
  HarnessLoginRemoveSchema,
  HarnessLoginSessionRequestSchema,
  HarnessLoginStartSchema,
  HarnessLoginsResponseSchema,
  type HarnessAccountLoginResult,
  type HarnessInstallResult,
  type HarnessLoginRemoveResult,
  type HarnessLoginResult,
} from "@clankie/protocol/harness-logins";
import type { HarnessInstalls } from "./harness-installs.ts";
import type { HarnessSignIns } from "./harness-logins.ts";

/** Same authority as model keys: the operator, or a device holding Take Control. */
export function createHarnessLoginRoutes(
  logins: HarnessSignIns | undefined,
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  principal: (request: Request) => Promise<string | undefined>,
  setup: {
    readonly installs?: HarnessInstalls | undefined;
    /** The owner's fleet machine-setup preference; unreadable keeps it the owner's. */
    readonly machineSetup?: () => Promise<"owner" | "lead">;
  } = {},
): Hono {
  const app = new Hono();
  app.onError((_error, context) => context.json({ ok: false, error: "unavailable" }, 503));
  // Login links and codes are interaction data: no request or result logging here.
  for (const path of [
    HARNESS_LOGINS_PATH,
    HARNESS_LOGIN_ACCOUNTS_PATH,
    HARNESS_LOGIN_START_PATH,
    HARNESS_LOGIN_STATUS_PATH,
    HARNESS_LOGIN_CODE_PATH,
    HARNESS_LOGIN_CANCEL_PATH,
    HARNESS_LOGIN_REMOVE_PATH,
    HARNESS_LOGIN_INSTALL_PATH,
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
  app.get(HARNESS_LOGIN_ACCOUNTS_PATH, async (context) =>
    context.json(HarnessLoginAccountsResponseSchema.parse(await logins!.accounts())),
  );
  const installAnswer = (result: HarnessInstallResult, started = false) => {
    const parsed = HarnessInstallResultSchema.parse(result);
    if (parsed.ok) return { body: parsed, status: started ? (202 as const) : (200 as const) };
    const status = {
      busy: 409,
      already_installed: 409,
      installer_unavailable: 409,
      machine_setup_owner_approval_required: 403,
      install_not_found: 404,
      malformed: 400,
      forbidden: 403,
      unavailable: 503,
    }[parsed.error] as 400 | 403 | 404 | 409 | 503;
    return { body: parsed, status };
  };
  app.get(HARNESS_LOGIN_INSTALL_PATH, (context) => {
    if (!setup.installs) return context.json({ ok: false, error: "unavailable" }, 503);
    const { body, status } = installAnswer(setup.installs.current());
    return context.json(body, status);
  });
  app.post(HARNESS_LOGIN_INSTALL_PATH, async (context) => {
    const who = await principal(context.req.raw);
    if (who === undefined) return context.json({ ok: false, error: "forbidden" }, 403);
    if (!setup.installs) return context.json({ ok: false, error: "unavailable" }, 503);
    // allow-swallowed-rejection -- an unreadable body is malformed, answered 400 below.
    const parsed = HarnessInstallRequestSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ ok: false, error: "malformed" }, 400);
    const approved = parsed.data.ownerApproved === true;
    // Installing software is machine setup: while the owner keeps it, they claim it here.
    // allow-swallowed-rejection -- an unreadable preference keeps machine setup the owner's.
    const mode = (await setup.machineSetup?.().catch(() => undefined)) ?? "owner";
    if (mode !== "lead" && !approved)
      return context.json({ ok: false, error: "machine_setup_owner_approval_required" }, 403);
    const { body, status } = installAnswer(
      await setup.installs.start(parsed.data.harness, approved ? "claimed" : "not_claimed"),
      true,
    );
    return context.json(body, status);
  });
  const answer = (result: HarnessAccountLoginResult | HarnessLoginRemoveResult) => {
    const parsed =
      "deleted" in result
        ? HarnessLoginRemoveResultSchema.parse(result)
        : HarnessAccountLoginResultSchema.parse(result);
    if (parsed.ok) return { body: parsed, status: 200 as const };
    const status = {
      managed_credits_only: 403,
      busy: 409,
      not_installed: 404,
      session_not_found: 404,
      profile_not_found: 404,
      profile_exists: 409,
      default_profile: 409,
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
    HARNESS_LOGIN_REMOVE_PATH,
  ]) {
    app.post(path, async (context) => {
      const who = await principal(context.req.raw);
      if (who === undefined) return context.json({ ok: false, error: "forbidden" }, 403);
      const body: unknown = await context.req.json().catch(() => undefined);
      let result: HarnessLoginResult | HarnessAccountLoginResult | HarnessLoginRemoveResult;
      if (path === HARNESS_LOGIN_START_PATH) {
        const parsed = HarnessLoginStartSchema.safeParse(body);
        if (!parsed.success) return context.json({ ok: false, error: "malformed" }, 400);
        const { harness, profile, add } = parsed.data;
        result = await logins!.start(harness, who, {
          ...(profile === undefined ? {} : { profile }),
          ...(add === undefined ? {} : { add: add.label === undefined ? {} : { label: add.label } }),
        });
      } else if (path === HARNESS_LOGIN_REMOVE_PATH) {
        const parsed = HarnessLoginRemoveSchema.safeParse(body);
        if (!parsed.success) return context.json({ ok: false, error: "malformed" }, 400);
        result = await logins!.remove(parsed.data.harness, parsed.data.profile);
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
