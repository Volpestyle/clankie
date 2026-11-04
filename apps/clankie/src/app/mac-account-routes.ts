import {
  beginClankieAccountLogin,
  ClankieAccountAuthError,
  completeClankieAccountLogin,
  readClankieAccountState,
  storeClankieAccountSignIn,
  type ClankieAccountAuthErrorCode,
  type ClankieAccountLoginChallenge,
} from "@clankie/credential-broker";
import type { DomainEvent } from "@clankie/protocol";
import {
  DEFAULT_PUBLIC_GATEWAY_URL,
  MAC_ACCOUNT_COMPLETE_PATH,
  MAC_ACCOUNT_PATH,
  MAC_ACCOUNT_START_PATH,
  MacAccountCompleteRequestSchema,
  MacAccountCompleteResponseSchema,
  MacAccountStartRequestSchema,
  MacAccountStartResponseSchema,
  MacAccountStatusSchema,
  type MacAccountCompleteResponse,
} from "@clankie/protocol/mac-account";
import { gatewayOrigin } from "@clankie/protocol/public-gateway";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticateOperator, readJson } from "./http-auth.ts";
import { logger } from "./log.ts";
import { withSerializedLock } from "./request-state.ts";
import type { ClankieAppDependencies, DeviceAuthDenial, TrustedDeviceIdentity } from "./types.ts";

/** Outlives Cognito's own window for the session; it answers `code_expired` first. */
const PENDING_SIGN_IN_MS = 10 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const RESTART_RETRY_MS = 5_000;
const LOCK = "mac-account";

const ERROR_STATUS: Readonly<Record<ClankieAccountAuthErrorCode, 400 | 403 | 410 | 429 | 502 | 503>> = {
  account_not_invited: 403,
  code_invalid: 400,
  code_expired: 410,
  email_invalid: 400,
  rate_limited: 429,
  refresh_rejected: 403,
  service_unavailable: 503,
  unexpected_response: 502,
};

interface PendingSignIn {
  readonly challenge: ClankieAccountLoginChallenge;
  readonly gatewayUrl: string;
  /** Only the identity that asked for the code may spend it. */
  readonly startedBy: string;
  readonly expiresAtMs: number;
  attempts: number;
}

/**
 * The owner's app signs this Mac in to clankie.bot (ADR 0153, #722). Local only:
 * the caller must be on this Mac's own loopback, whoever it is, and then be the
 * operator or a device with Take Control (ADR 0314). None of these paths are on
 * the public gateway's or the hosted operator's allowlists. The Cognito session
 * and tokens stay in this process and the broker; no response or log carries them.
 */
export function registerMacAccountRoutes(ctx: {
  readonly app: Hono;
  readonly dependencies: ClankieAppDependencies;
  readonly clock: () => Date;
  readonly recordEvent: (
    type: string,
    streamId: string,
    occurredAt: string,
    data: Record<string, unknown>,
  ) => DomainEvent;
  readonly authenticateDevice: (
    request: Request,
  ) => Promise<TrustedDeviceIdentity | "unavailable" | DeviceAuthDenial>;
  readonly locks: Map<string, Promise<unknown>>;
}): () => void {
  let pending: PendingSignIn | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  const callers = new WeakMap<Context, string>();
  const account = () => {
    const { macAccount, settings } = ctx.dependencies;
    return macAccount === undefined || settings?.update === undefined
      ? undefined
      : {
          macAccount,
          settings: { load: settings.load.bind(settings), update: settings.update.bind(settings) },
        };
  };
  const livePending = () => {
    if (pending !== undefined && pending.expiresAtMs <= ctx.clock().getTime()) pending = undefined;
    return pending;
  };

  for (const path of [MAC_ACCOUNT_PATH, MAC_ACCOUNT_START_PATH, MAC_ACCOUNT_COMPLETE_PATH]) {
    ctx.app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      const setup = ctx.dependencies.modelDeviceSetup;
      if (setup?.platform !== "darwin" || setup.hosted || account() === undefined)
        return context.json({ error: "not_found" }, 404);
      // Before any credential: a valid operator bearer does not reach these from elsewhere.
      if (!ctx.dependencies.isSameMacRequest?.(context.req.raw))
        return context.json({ error: "native_loopback_required" }, 403);
      const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
      if (operator === "unavailable")
        return context.json({ error: "operator_authentication_unavailable" }, 503);
      if (operator) {
        callers.set(context, operator.operatorId);
        return await next();
      }
      const device = await ctx.authenticateDevice(context.req.raw);
      if (device === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
      if ("denied" in device) return context.json({ error: "operator_authentication_required" }, 401);
      if (!device.grants.terminalControl) return context.json({ error: "forbidden" }, 403);
      callers.set(context, `device:${device.deviceId}`);
      return await next();
    });
  }
  for (const path of [MAC_ACCOUNT_START_PATH, MAC_ACCOUNT_COMPLETE_PATH])
    ctx.app.use(path, bodyLimit({ maxSize: 1024 }));

  const refusal = (context: Context, error: unknown) => {
    // The message can repeat what Cognito said; the code is all a caller needs.
    const code = error instanceof ClankieAccountAuthError ? error.code : "service_unavailable";
    logger.warn({ event: "mac_account.refused", code }, "Clankie account sign-in refused");
    return context.json({ error: code }, ERROR_STATUS[code]);
  };

  /** Keeps trying until he is idle: the tokens are stored, so nothing is left for the owner to do. */
  const restart = (restartWhenIdle: () => boolean): MacAccountCompleteResponse["restart"] => {
    if (restartTimer !== undefined) return "waiting";
    if (restartWhenIdle()) return "restarting";
    restartTimer = setInterval(() => {
      if (!restartWhenIdle()) return;
      clearInterval(restartTimer);
      restartTimer = undefined;
    }, RESTART_RETRY_MS);
    restartTimer.unref();
    return "waiting";
  };

  ctx.app.get(MAC_ACCOUNT_PATH, async (context) => {
    const ready = account()!;
    const { publicGateway } = await ready.settings.load();
    const stored = await readClankieAccountState({
      publicGateway,
      credentials: ready.macAccount.credentials,
    });
    const doorway = ctx.dependencies.publicGatewayDoorway?.() ?? { state: "disabled" as const };
    // A credential the account rejected is still in the broker; the doorway knows better.
    const rejected = stored.state === "signed_in" && doorway.state === "sign_in_required";
    return context.json(
      MacAccountStatusSchema.parse({
        state: rejected ? "signed_out" : stored.state,
        ...(stored.email === undefined || rejected ? {} : { email: stored.email }),
        pending: livePending() !== undefined,
        doorway,
      }),
    );
  });

  ctx.app.post(MAC_ACCOUNT_START_PATH, async (context) => {
    const parsed = MacAccountStartRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    const ready = account()!;
    const startedBy = callers.get(context)!;
    return await withSerializedLock(ctx.locks, LOCK, async () => {
      try {
        // Settings name the gateway, never the caller: the email goes nowhere else.
        const { publicGateway } = await ready.settings.load();
        const gatewayUrl = gatewayOrigin(publicGateway.url ?? DEFAULT_PUBLIC_GATEWAY_URL);
        const challenge = await beginClankieAccountLogin({ gatewayUrl, email: parsed.data.email });
        const expiresAtMs = ctx.clock().getTime() + PENDING_SIGN_IN_MS;
        // A new code replaces the last; Cognito has already spent that session.
        pending = { challenge, gatewayUrl, startedBy, expiresAtMs, attempts: 0 };
        return context.json(
          MacAccountStartResponseSchema.parse({
            email: challenge.email,
            expiresAt: new Date(expiresAtMs).toISOString(),
          }),
        );
      } catch (error) {
        return refusal(context, error);
      }
    });
  });

  ctx.app.post(MAC_ACCOUNT_COMPLETE_PATH, async (context) => {
    const parsed = MacAccountCompleteRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    const ready = account()!;
    const caller = callers.get(context)!;
    return await withSerializedLock(ctx.locks, LOCK, async () => {
      const signIn = livePending();
      if (signIn === undefined || signIn.startedBy !== caller)
        return context.json({ error: "no_sign_in_pending" }, 409);
      signIn.attempts += 1;
      if (signIn.attempts >= MAX_CODE_ATTEMPTS) pending = undefined;
      try {
        const credential = await completeClankieAccountLogin({
          challenge: signIn.challenge,
          code: parsed.data.code,
        });
        pending = undefined;
        await storeClankieAccountSignIn({
          gatewayUrl: signIn.gatewayUrl,
          credential,
          email: signIn.challenge.email,
          credentials: ready.macAccount.credentials,
          settings: ready.settings,
        });
        ctx.recordEvent("mac_account.signed_in", "mac-account", ctx.clock().toISOString(), {
          signedInBy: caller,
        });
        return context.json(
          MacAccountCompleteResponseSchema.parse({
            state: "signed_in",
            email: signIn.challenge.email,
            restart: restart(ready.macAccount.restartWhenIdle),
          }),
        );
      } catch (error) {
        if (error instanceof ClankieAccountAuthError && error.code === "code_expired") pending = undefined;
        return refusal(context, error);
      }
    });
  });

  return () => {
    clearInterval(restartTimer);
    restartTimer = undefined;
  };
}
