import { z } from "zod";

/**
 * Account connections (ADR 0196): the owner links their own GitHub and Linear
 * accounts to their own Clankie. Tokens live only in the body's credential
 * broker; nothing here ever carries one back out. Owner/operator or an active
 * Take Control device only; remote calls use the encrypted envelope.
 */
export const ACCOUNTS_PATH = "/v1/accounts";
export const ACCOUNT_GITHUB_START_PATH = "/v1/accounts/github/start";
export const ACCOUNT_GITHUB_POLL_PATH = "/v1/accounts/github/poll";
export const ACCOUNT_LINEAR_START_PATH = "/v1/accounts/linear/start";
export const ACCOUNT_LINEAR_COMPLETE_PATH = "/v1/accounts/linear/complete";
export const ACCOUNT_LINEAR_APP_PATH = "/v1/accounts/linear/app";
export const ACCOUNT_DISCONNECT_PATH = "/v1/accounts/disconnect";
export const ACCOUNT_GOOGLE_START_PATH = "/v1/accounts/google/start";
export const ACCOUNT_GOOGLE_COMPLETE_PATH = "/v1/accounts/google/complete";
export const ACCOUNT_GOOGLE_CHECK_PATH = "/v1/accounts/google/check";

export const GoogleAccountProviderSchema = z.enum(["google-gmail", "google-calendar", "google-drive"]);
export type GoogleAccountProvider = z.infer<typeof GoogleAccountProviderSchema>;
export const AccountProviderSchema = z.enum(["github", "linear", ...GoogleAccountProviderSchema.options]);
export type AccountProvider = z.infer<typeof AccountProviderSchema>;

const FlowIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u);

/** Write-only app credentials. Never returned in a connection response. */
export const AccountLinearAppRequestSchema = z
  .object({
    clientId: z.string().trim().min(1).max(256),
    clientSecret: z.string().trim().min(1).max(4096),
  })
  .strict();

export const AccountGithubPollRequestSchema = z.object({ flowId: FlowIdSchema }).strict();
export const AccountLinearCompleteRequestSchema = z
  .object({
    /** The `state` Linear echoed on the redirect; it names the flow. */
    state: FlowIdSchema,
    code: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[\x21-\x7e]+$/u),
  })
  .strict();
export const AccountDisconnectRequestSchema = z.object({ provider: AccountProviderSchema }).strict();

/** What a connection may show: who, which scopes, since when. Never a token, prefix or suffix. */
export const AccountConnectionSchema = z
  .object({
    provider: AccountProviderSchema,
    /** `unconfigured`: this body has no OAuth client for the provider yet. */
    status: z.enum([
      "connected",
      "not_connected",
      "unconfigured",
      "awaiting_consent",
      "expired",
      "reconnect_required",
      "unavailable",
      "disconnected",
    ]),
    /** Body-owned catalog metadata. Optional for older bodies, never inferred from credentials by a portal. */
    name: z.string().max(128).optional(),
    group: z.string().max(64).optional(),
    description: z.string().max(512).optional(),
    access: z.string().max(512).optional(),
    readOnly: z.boolean().optional(),
    lastCheckedAt: z.string().datetime().optional(),
    revocationPending: z.boolean().optional(),
    selectedFileIds: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u))
      .max(100)
      .optional(),
    reason: z
      .enum(["invalid_grant", "scope_required", "provider_unavailable", "revocation_pending"])
      .optional(),
    account: z.string().max(320).optional(),
    actor: z.enum(["user", "app"]).optional(),
    workspace: z.string().max(320).optional(),
    scopes: z.array(z.string().max(128)).max(64),
    connectedAt: z.string().datetime().optional(),
    /** Where the owner can review or revoke the grant at the provider. */
    manageUrl: z.url().optional(),
  })
  .strict();
export type AccountConnection = z.infer<typeof AccountConnectionSchema>;

export const AccountsResponseSchema = z
  .object({ connections: z.array(AccountConnectionSchema).max(16) })
  .strict();
export type AccountsResponse = z.infer<typeof AccountsResponseSchema>;

const Failure = z
  .object({
    ok: z.literal(false),
    error: z.enum([
      "authentication_required",
      "forbidden",
      "malformed",
      "unconfigured",
      "unknown_flow",
      "expired",
      "denied",
      "provider_rejected",
      "unavailable",
    ]),
  })
  .strict();
export type AccountFailure = z.infer<typeof Failure>;

export const AccountGithubStartResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      flowId: FlowIdSchema,
      /** The code the owner types at `verificationUri`; the device code stays on the body. */
      userCode: z.string().min(1).max(64),
      verificationUri: z.url(),
      expiresAt: z.string().datetime(),
      /** Seconds between polls. */
      interval: z.number().int().min(1).max(600),
    })
    .strict(),
  Failure,
]);
export type AccountGithubStartResult = z.infer<typeof AccountGithubStartResultSchema>;

export const AccountGithubPollResultSchema = z.union([
  z
    .object({ ok: z.literal(true), status: z.literal("pending"), interval: z.number().int().min(1).max(600) })
    .strict(),
  z
    .object({ ok: z.literal(true), status: z.literal("connected"), connection: AccountConnectionSchema })
    .strict(),
  Failure,
]);
export type AccountGithubPollResult = z.infer<typeof AccountGithubPollResultSchema>;

export const AccountLinearStartResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      /** Also the OAuth `state`; the PKCE verifier stays on the body. */
      flowId: FlowIdSchema,
      authorizeUrl: z.url(),
      redirectUri: z.string().min(1).max(512),
      expiresAt: z.string().datetime(),
    })
    .strict(),
  Failure,
]);
export type AccountLinearStartResult = z.infer<typeof AccountLinearStartResultSchema>;

export const AccountLinearCompleteResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), connection: AccountConnectionSchema }).strict(),
  Failure,
]);
export type AccountLinearCompleteResult = z.infer<typeof AccountLinearCompleteResultSchema>;

export const AccountDisconnectResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      /** False when the provider could not be asked; the local token is deleted either way. */
      revoked: z.boolean(),
      manageUrl: z.url().optional(),
    })
    .strict(),
  Failure,
]);
export type AccountDisconnectResult = z.infer<typeof AccountDisconnectResultSchema>;

export const AccountGoogleStartRequestSchema = z.object({ provider: GoogleAccountProviderSchema }).strict();
export const AccountGoogleCompleteRequestSchema = AccountLinearCompleteRequestSchema.extend({
  provider: GoogleAccountProviderSchema,
  /** The system Google Picker returns selected IDs with its one-time code. */
  pickedFileIds: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u))
    .min(1)
    .max(100)
    .optional(),
})
  .strict()
  .refine((value) =>
    value.provider === "google-drive"
      ? value.pickedFileIds !== undefined && new Set(value.pickedFileIds).size === value.pickedFileIds.length
      : value.pickedFileIds === undefined,
  );
export const AccountGoogleStartResultSchema = AccountLinearStartResultSchema;
export type AccountGoogleStartResult = z.infer<typeof AccountGoogleStartResultSchema>;
export const AccountGoogleCompleteResultSchema = AccountLinearCompleteResultSchema;
export type AccountGoogleCompleteResult = z.infer<typeof AccountGoogleCompleteResultSchema>;
