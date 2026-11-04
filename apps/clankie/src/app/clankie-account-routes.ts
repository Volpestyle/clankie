import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  CLANKIE_ACCOUNT_COMPLETE_PATH,
  CLANKIE_ACCOUNT_PATH,
  CLANKIE_ACCOUNT_START_PATH,
  ClankieAccountCompleteRequestSchema,
  ClankieAccountStartRequestSchema,
  type ClankieAccountErrorCode,
} from "@clankie/protocol/public-gateway";
import { ClankieAccountSignInError } from "../clankie-account-signin.ts";
import { readJson } from "./http-auth.ts";
import { logger } from "./log.ts";
import { ownerMacAdmission, type RegisterPairingRoutesContext } from "./pairing-routes.ts";

const STATUS: Record<ClankieAccountErrorCode, 400 | 403 | 404 | 410 | 429 | 502 | 503> = {
  email_invalid: 400,
  code_invalid: 400,
  account_not_invited: 403,
  challenge_unknown: 404,
  code_expired: 410,
  rate_limited: 429,
  unexpected_response: 502,
  service_unavailable: 503,
};

/**
 * This Mac's clankie.bot sign-in for the owner's own app (#722): status, start
 * and complete, with the pairing offer's admission. Requests and replies carry
 * an email, a code and an opaque challenge id; nothing here logs either or
 * returns a token.
 */
export function registerClankieAccountRoutes(
  ctx: Pick<RegisterPairingRoutesContext, "app" | "dependencies" | "authenticateDevice">,
) {
  const admit = ownerMacAdmission(ctx);
  const signIn = () => ctx.dependencies.clankieAccountSignIn;
  const guarded = async (context: Context, action: () => Promise<Response>) => {
    const admitted = await admit(context.req.raw);
    if ("error" in admitted) return context.json({ error: admitted.error }, admitted.status);
    if (signIn() === undefined) return context.json({ error: "unavailable" }, 503);
    try {
      return await action();
    } catch (error) {
      if (error instanceof ClankieAccountSignInError)
        return context.json({ error: error.code }, STATUS[error.code]);
      logger.warn(
        { event: "clankie_account.failed", error: error instanceof Error ? error.name : "UnknownError" },
        "this Mac's account sign-in failed",
      );
      return context.json({ error: "service_unavailable" }, 503);
    }
  };
  const app: Hono = ctx.app;
  app.get(CLANKIE_ACCOUNT_PATH, (context) =>
    guarded(context, async () => context.json(await signIn()!.status())),
  );
  app.post(CLANKIE_ACCOUNT_START_PATH, bodyLimit({ maxSize: 4 * 1024 }), (context) =>
    guarded(context, async () => {
      const parsed = ClankieAccountStartRequestSchema.safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "malformed" }, 400);
      return context.json(await signIn()!.start(parsed.data.email));
    }),
  );
  app.post(CLANKIE_ACCOUNT_COMPLETE_PATH, bodyLimit({ maxSize: 4 * 1024 }), (context) =>
    guarded(context, async () => {
      const parsed = ClankieAccountCompleteRequestSchema.safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "malformed" }, 400);
      return context.json(await signIn()!.complete(parsed.data.challengeId, parsed.data.code));
    }),
  );
}
