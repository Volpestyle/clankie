import { z } from "zod";

export const MANAGED_CREDITS_ONLY_MESSAGE =
  "Managed Clankie uses AI credits only. Subscription sign-in and customer model keys are available on self-hosted bodies.";

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
/** Every account per harness, and removing one (VUH-2841). */
export const HARNESS_LOGIN_ACCOUNTS_PATH = "/v1/harness-logins/accounts";
export const HARNESS_LOGIN_REMOVE_PATH = "/v1/harness-logins/remove";

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

/** A profile's label: `default` is the harness's own home, others live beside it as `~/.claude-<label>`. */
export const HarnessProfileSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

/**
 * Every account the body knows per harness, one row per signed-in identity
 * (homes sharing one sign-in collapse) plus one per signed-out profile. Kept
 * apart from `GET /v1/harness-logins`, which shipped apps parse strictly.
 * No home path, token or native account ID crosses it.
 */
export const HarnessLoginAccountSchema = z
  .object({
    /** What re-sign and remove target. */
    profile: HarnessProfileSchema,
    /** Every profile holding this sign-in, `profile` first. */
    profiles: z.array(HarnessProfileSchema).min(1).max(16),
    /** It holds the harness's own default home, which can be re-signed but never removed. */
    default: z.boolean(),
    /** Clankie created every profile it holds, so removing them deletes them. */
    managed: z.boolean(),
    /** `null`: the harness's own status did not answer. */
    signedIn: z.boolean().nullable(),
    /** The account's email as its harness reports it. */
    identity: z.string().max(320).optional(),
    plan: z.string().max(64).optional(),
    /** Lowest remaining fraction of its usage windows; `null` when not read. */
    headroom: z.number().min(0).max(1).nullable(),
    resetsAt: z.string().datetime().optional(),
    /** Clankie would hire on it now. */
    ready: z.boolean(),
    /** The owner set it aside from automatic choice. */
    held: z.literal(true).optional(),
  })
  .strict();
export type HarnessLoginAccount = z.infer<typeof HarnessLoginAccountSchema>;

export const HarnessLoginAccountsResponseSchema = z
  .object({
    harnesses: z.array(
      z
        .object({
          harness: LoginHarnessSchema,
          installed: z.boolean(),
          accounts: z.array(HarnessLoginAccountSchema).max(64),
        })
        .strict(),
    ),
  })
  .strict();
export type HarnessLoginAccountsResponse = z.infer<typeof HarnessLoginAccountsResponseSchema>;

/**
 * `{harness}` alone signs in the default home, as shipped apps send it.
 * `profile` re-signs exactly that profile; `add` creates a new profile home and
 * signs a new account into it, never an existing home.
 */
export const HarnessLoginStartSchema = z
  .object({
    harness: LoginHarnessSchema,
    profile: HarnessProfileSchema.optional(),
    add: z.object({ label: HarnessProfileSchema.optional() }).strict().optional(),
  })
  .strict()
  .refine((start) => start.profile === undefined || start.add === undefined, "profile or add, not both");
export const HarnessLoginRemoveSchema = z
  .object({ harness: LoginHarnessSchema, profile: HarnessProfileSchema })
  .strict();
export const HarnessLoginSessionRequestSchema = z.object({ sessionId: z.string().uuid() }).strict();
/** Claude shows the owner a code after they authorize; it goes back to the waiting login. */
export const HarnessLoginCodeSchema = z
  .object({ sessionId: z.string().uuid(), code: z.string().trim().min(1).max(2048) })
  .strict();

const HarnessLoginSessionSchema = z
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
    /** The profile this sign-in targets; only when the start named `profile` or `add`. */
    profile: HarnessProfileSchema.optional(),
    /** Complete: the vendor page signed a different account into this profile. */
    identityChanged: z
      .object({ before: z.string().max(320).optional(), after: z.string().max(320).optional() })
      .strict()
      .optional(),
    /** Complete: this account was already signed in under that profile. */
    duplicateOf: HarnessProfileSchema.optional(),
  })
  .strict();

const LOGIN_ERRORS = [
  "managed_credits_only",
  "busy",
  "not_installed",
  "session_not_found",
  "malformed",
  "unavailable",
  "forbidden",
] as const;
const loginFailure = <const T extends readonly [string, ...string[]]>(errors: T) =>
  z.object({ ok: z.literal(false), message: z.string().optional(), error: z.enum(errors) }).strict();

/** Every sign-in answer. Its error codes stay those shipped apps handle exhaustively. */
export const HarnessLoginResultSchema = z.discriminatedUnion("ok", [
  HarnessLoginSessionSchema,
  loginFailure(LOGIN_ERRORS),
]);
export type HarnessLoginResult = z.infer<typeof HarnessLoginResultSchema>;

/**
 * A start naming `profile` or `add`, and remove, may also answer these codes.
 * Only a client that sends those requests receives them.
 */
export const HarnessAccountLoginResultSchema = z.discriminatedUnion("ok", [
  HarnessLoginSessionSchema,
  loginFailure([...LOGIN_ERRORS, "profile_not_found", "profile_exists", "default_profile"]),
]);
export type HarnessAccountLoginResult = z.infer<typeof HarnessAccountLoginResultSchema>;

export const HarnessLoginRemoveResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      harness: LoginHarnessSchema,
      profile: HarnessProfileSchema,
      /** The profile was Clankie's and is gone; otherwise it is signed out and stays listed. */
      deleted: z.boolean(),
    })
    .strict(),
  HarnessAccountLoginResultSchema.options[1],
]);
export type HarnessLoginRemoveResult = z.infer<typeof HarnessLoginRemoveResultSchema>;
