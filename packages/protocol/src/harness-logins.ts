import { z } from "zod";

/**
 * Sign a worker harness into the owner's own account with that harness's
 * official login (`claude auth login`, `codex login --device-auth`), from a
 * paired device or the CLI, with no shell on the body. Credentials stay in the
 * harness's own store; only the login link and code cross this API. Distinct
 * from model sign-in (`model-keys`), which configures Clankie's own model.
 */
export const HARNESS_LOGINS_PATH = "/v1/harness-logins";
export const HARNESS_LOGIN_START_PATH = "/v1/harness-logins/start";
export const HARNESS_LOGIN_STATUS_PATH = "/v1/harness-logins/status";
export const HARNESS_LOGIN_CODE_PATH = "/v1/harness-logins/code";
export const HARNESS_LOGIN_CANCEL_PATH = "/v1/harness-logins/cancel";

export const LoginHarnessSchema = z.enum(["claude", "codex"]);
export type LoginHarness = z.infer<typeof LoginHarnessSchema>;

/** Secret-free: whether each harness is installed here and signed in. */
export const HarnessLoginsResponseSchema = z
  .object({
    harnesses: z.array(
      z
        .object({
          harness: LoginHarnessSchema,
          installed: z.boolean(),
          signedIn: z.boolean(),
          /** The harness's own description of the method, e.g. `claude.ai` or `ChatGPT`. */
          method: z.string().max(64).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type HarnessLoginsResponse = z.infer<typeof HarnessLoginsResponseSchema>;

export const HarnessLoginStartSchema = z.object({ harness: LoginHarnessSchema }).strict();
export const HarnessLoginSessionRequestSchema = z.object({ sessionId: z.string().uuid() }).strict();
/** Claude shows the owner a code after they authorize; it goes back to the waiting login. */
export const HarnessLoginCodeSchema = z
  .object({ sessionId: z.string().uuid(), code: z.string().trim().min(1).max(2048) })
  .strict();

export const HarnessLoginResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      sessionId: z.string().uuid(),
      harness: LoginHarnessSchema,
      expiresAt: z.string().datetime(),
      /** `needs_code`: open `url`, authorize, then send the code it shows (Claude). */
      state: z.enum(["pending", "needs_code", "verifying", "complete", "cancelled", "expired", "failed"]),
      /** Login interaction only, returned exclusively to the initiating principal. */
      url: z.string().url().optional(),
      /** Enter this at `url` (Codex device code). */
      userCode: z.string().max(64).optional(),
      /** The last code was not accepted; the same sign-in waits for another. */
      codeRejected: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.enum(["busy", "not_installed", "session_not_found", "malformed", "unavailable", "forbidden"]),
    })
    .strict(),
]);
export type HarnessLoginResult = z.infer<typeof HarnessLoginResultSchema>;
