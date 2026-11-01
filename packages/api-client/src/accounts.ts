import {
  ACCOUNTS_PATH,
  ACCOUNT_DISCONNECT_PATH,
  ACCOUNT_GITHUB_POLL_PATH,
  ACCOUNT_GITHUB_START_PATH,
  ACCOUNT_LINEAR_COMPLETE_PATH,
  ACCOUNT_LINEAR_START_PATH,
  ACCOUNT_GOOGLE_START_PATH,
  ACCOUNT_GOOGLE_COMPLETE_PATH,
  ACCOUNT_GOOGLE_CHECK_PATH,
  AccountDisconnectRequestSchema,
  AccountDisconnectResultSchema,
  AccountGithubPollRequestSchema,
  AccountGithubPollResultSchema,
  AccountGithubStartResultSchema,
  AccountLinearCompleteRequestSchema,
  AccountLinearCompleteResultSchema,
  AccountLinearStartResultSchema,
  AccountGoogleStartRequestSchema,
  AccountGoogleCompleteRequestSchema,
  AccountGoogleStartResultSchema,
  AccountGoogleCompleteResultSchema,
  AccountsResponseSchema,
  type AccountFailure,
  type AccountLinearStartResult,
  type AccountGoogleStartResult,
  type GoogleAccountProvider,
  type AccountProvider,
} from "@clankie/protocol/accounts";

/** Never includes a provider response, credential, code or request URL. */
export class AccountClientError extends Error {
  readonly code: AccountFailure["error"];
  readonly status: number | undefined;
  constructor(code: AccountFailure["error"], status?: number) {
    super(`Account connection: ${code}`);
    this.name = "AccountClientError";
    this.code = code;
    this.status = status;
  }
}

/** The caller supplies its existing sealed device transport for hosted bodies. */
export function createAccountsClient(options: {
  baseUrl: string;
  authorization: () => string | undefined;
  fetchImpl?: typeof fetch;
}) {
  const base = new URL(options.baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.pathname !== "/" && !/^\/h\/[A-Za-z0-9_-]{16,128}\/?$/u.test(base.pathname)) ||
    (base.hostname === "api.clankie.bot" && base.pathname === "/")
  )
    throw new AccountClientError("malformed");
  const origin = options.baseUrl.replace(/\/$/u, "");
  const fetcher = options.fetchImpl ?? fetch;
  async function request<T>(
    path: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    body?: unknown,
  ): Promise<T> {
    const bearer = options.authorization();
    if (!bearer) throw new AccountClientError("authentication_required");
    try {
      const response = await fetcher(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
        cache: "no-store",
      });
      if (response.status === 401) throw new AccountClientError("authentication_required", 401);
      if (response.status === 403) throw new AccountClientError("forbidden", 403);
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > 64 * 1024)
        throw new AccountClientError("unavailable", response.status);
      // React Native's fetch Response may expose text() without a stream reader.
      const bytes = typeof response.body?.getReader === "function" ? response.body.getReader() : undefined;
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (bytes)
        try {
          for (;;) {
            const part = await bytes.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 64 * 1024) throw new AccountClientError("unavailable", response.status);
            chunks.push(part.value);
          }
        } finally {
          if (size > 64 * 1024) await bytes.cancel().catch(() => undefined);
          bytes.releaseLock();
        }
      const joined = bytes ? new Uint8Array(size) : new TextEncoder().encode(await response.text());
      if (joined.byteLength > 64 * 1024) throw new AccountClientError("unavailable", response.status);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(joined)));
      if (!parsed.success) throw new AccountClientError("unavailable", response.status);
      if (
        response.status !== 200 &&
        !(
          parsed.data !== null &&
          typeof parsed.data === "object" &&
          "ok" in parsed.data &&
          parsed.data.ok === false
        )
      )
        throw new AccountClientError("unavailable", response.status);
      return parsed.data;
    } catch (error) {
      if (error instanceof AccountClientError) throw error;
      throw new AccountClientError("unavailable");
    }
  }
  function input<T>(
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    value: unknown,
  ): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new AccountClientError("malformed");
    return parsed.data;
  }
  return {
    list: () => request(ACCOUNTS_PATH, AccountsResponseSchema),
    startGithub: () => request(ACCOUNT_GITHUB_START_PATH, AccountGithubStartResultSchema, {}),
    pollGithub: (flowId: string) =>
      request(
        ACCOUNT_GITHUB_POLL_PATH,
        AccountGithubPollResultSchema,
        input(AccountGithubPollRequestSchema, { flowId }),
      ),
    startLinear: () => request(ACCOUNT_LINEAR_START_PATH, AccountLinearStartResultSchema, {}),
    completeLinear: (state: string, code: string) =>
      request(
        ACCOUNT_LINEAR_COMPLETE_PATH,
        AccountLinearCompleteResultSchema,
        input(AccountLinearCompleteRequestSchema, { state, code }),
      ),
    startGoogle: (provider: GoogleAccountProvider) =>
      request(
        ACCOUNT_GOOGLE_START_PATH,
        AccountGoogleStartResultSchema,
        input(AccountGoogleStartRequestSchema, { provider }),
      ),
    completeGoogle: (
      provider: GoogleAccountProvider,
      state: string,
      code: string,
      pickedFileIds?: string[],
    ) =>
      request(
        ACCOUNT_GOOGLE_COMPLETE_PATH,
        AccountGoogleCompleteResultSchema,
        input(AccountGoogleCompleteRequestSchema, {
          provider,
          state,
          code,
          ...(pickedFileIds === undefined ? {} : { pickedFileIds }),
        }),
      ),
    checkGoogle: (provider: GoogleAccountProvider) =>
      request(
        ACCOUNT_GOOGLE_CHECK_PATH,
        AccountGoogleCompleteResultSchema,
        input(AccountGoogleStartRequestSchema, { provider }),
      ),
    disconnect: (provider: AccountProvider) =>
      request(
        ACCOUNT_DISCONNECT_PATH,
        AccountDisconnectResultSchema,
        input(AccountDisconnectRequestSchema, { provider }),
      ),
  };
}

export type AccountsClient = ReturnType<typeof createAccountsClient>;
export type PendingLinearAccountFlow = Extract<AccountLinearStartResult, { ok: true }>;
export type PendingGoogleAccountFlow = Extract<AccountGoogleStartResult, { ok: true }> & {
  provider: GoogleAccountProvider;
};

const GOOGLE_SCOPES: Record<GoogleAccountProvider, readonly string[]> = {
  "google-gmail": ["https://www.googleapis.com/auth/gmail.readonly"],
  "google-calendar": [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
  ],
  "google-drive": ["https://www.googleapis.com/auth/drive.file"],
};

/** Consent is bound to the body-retained state and PKCE verifier, with selected-file Drive access. */
export function validateGoogleAccountStart(flow: PendingGoogleAccountFlow): void {
  try {
    const authorize = new URL(flow.authorizeUrl);
    const redirect = new URL(flow.redirectUri);
    const parameters = authorize.searchParams;
    const scopes = (parameters.get("scope") ?? "").split(/\s+/u).filter(Boolean);
    const drive = flow.provider === "google-drive";
    const allowedScopes = [...(drive ? [] : ["openid", "email"]), ...(GOOGLE_SCOPES[flow.provider] ?? [])];
    const allowed = [
      "client_id",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
      "nonce",
      "code_challenge",
      "code_challenge_method",
      "access_type",
      "prompt",
      "include_granted_scopes",
      ...(drive ? ["trigger_onepick", "allow_multiple"] : []),
    ];
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
    if (
      authorize.origin !== "https://accounts.google.com" ||
      authorize.pathname !== "/o/oauth2/v2/auth" ||
      authorize.username ||
      authorize.password ||
      authorize.hash ||
      (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && loopback)) ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash ||
      redirect.pathname !== "/account/connections/google/callback" ||
      parameters.get("state") !== flow.flowId ||
      parameters.get("redirect_uri") !== flow.redirectUri ||
      parameters.get("response_type") !== "code" ||
      parameters.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parameters.get("code_challenge") ?? "") ||
      !/^[A-Za-z0-9_-]{16,128}$/u.test(parameters.get("nonce") ?? "") ||
      parameters.get("access_type") !== "offline" ||
      parameters.get("prompt") !== (drive ? "consent" : "consent select_account") ||
      (drive && parameters.get("trigger_onepick") !== "true") ||
      (parameters.has("allow_multiple") &&
        !["true", "false"].includes(parameters.get("allow_multiple") ?? "")) ||
      parameters.get("include_granted_scopes") !== "false" ||
      !parameters.get("client_id") ||
      !/^[A-Za-z0-9_-]{16,128}$/u.test(flow.flowId) ||
      !Number.isFinite(Date.parse(flow.expiresAt)) ||
      !GOOGLE_SCOPES[flow.provider] ||
      scopes.length !== allowedScopes.length ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((scope) => !allowedScopes.includes(scope)) ||
      [...parameters.keys()].some((key) => !allowed.includes(key) || parameters.getAll(key).length !== 1)
    )
      throw new Error();
  } catch {
    throw new AccountClientError("malformed");
  }
}

export type GoogleAccountCallback =
  | { state: string; code: string; pickedFileIds?: string[] }
  | { state: string; error: "denied" | "provider_rejected" };

/** Callback extras identify Google's consent UI; they never alter the pending provider or grant. */
export function parseGoogleAccountCallback(
  value: string,
  pending: Pick<PendingGoogleAccountFlow, "provider" | "flowId" | "expiresAt">,
  now = Date.now(),
): GoogleAccountCallback {
  try {
    const url = new URL(value);
    const query = url.searchParams;
    if (
      url.protocol !== "clankie:" ||
      url.hostname !== "accounts" ||
      url.pathname !== "/google/callback" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      query.getAll("state").length !== 1 ||
      query.get("state") !== pending.flowId ||
      !Number.isFinite(Date.parse(pending.expiresAt)) ||
      Date.parse(pending.expiresAt) <= now ||
      [...query.keys()].some(
        (key) =>
          ![
            "state",
            "code",
            "error",
            "error_description",
            "scope",
            "authuser",
            "prompt",
            "iss",
            "picked_file_ids",
          ].includes(key) || query.getAll(key).length !== 1,
      ) ||
      query.has("code") === query.has("error") ||
      (query.has("picked_file_ids") && (pending.provider !== "google-drive" || query.has("error")))
    )
      throw new Error();
    if (query.has("error"))
      return {
        state: pending.flowId,
        error: query.get("error") === "access_denied" ? "denied" : "provider_rejected",
      };
    const callback = AccountLinearCompleteRequestSchema.parse({
      state: pending.flowId,
      code: query.get("code"),
    });
    if (!query.has("picked_file_ids")) return callback;
    const pickedFileIds = query.get("picked_file_ids")!.split(",");
    if (
      pickedFileIds.length > 100 ||
      new Set(pickedFileIds).size !== pickedFileIds.length ||
      pickedFileIds.some((id) => !/^[A-Za-z0-9_-]{1,256}$/u.test(id))
    )
      throw new Error();
    return { ...callback, pickedFileIds };
  } catch {
    throw new AccountClientError("malformed");
  }
}

/** Validate before opening a provider URL supplied by a body. */
export function validateLinearAccountStart(flow: PendingLinearAccountFlow): void {
  try {
    const authorize = new URL(flow.authorizeUrl);
    const redirect = new URL(flow.redirectUri);
    const parameters = authorize.searchParams;
    const allowed = [
      "client_id",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
      "actor",
      "prompt",
    ];
    if (
      authorize.origin !== "https://linear.app" ||
      authorize.pathname !== "/oauth/authorize" ||
      authorize.username ||
      authorize.password ||
      authorize.hash ||
      redirect.protocol !== "https:" ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash ||
      parameters.get("state") !== flow.flowId ||
      parameters.get("redirect_uri") !== flow.redirectUri ||
      parameters.get("response_type") !== "code" ||
      parameters.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parameters.get("code_challenge") ?? "") ||
      !parameters.get("client_id") ||
      !/^[A-Za-z0-9_-]{16,128}$/u.test(flow.flowId) ||
      !Number.isFinite(Date.parse(flow.expiresAt)) ||
      !parameters.get("scope") ||
      [...parameters.keys()].some((key) => !allowed.includes(key) || parameters.getAll(key).length !== 1)
    )
      throw new Error();
  } catch {
    throw new AccountClientError("malformed");
  }
}

export type LinearAccountCallback =
  | { state: string; code: string }
  | { state: string; error: "denied" | "provider_rejected" };

/** A callback is input, never a pairing link. The caller consumes its pending flow once. */
export function parseLinearAccountCallback(
  value: string,
  pending: Pick<PendingLinearAccountFlow, "flowId" | "expiresAt">,
  now = Date.now(),
): LinearAccountCallback {
  try {
    const url = new URL(value);
    const query = url.searchParams;
    if (
      url.protocol !== "clankie:" ||
      url.hostname !== "accounts" ||
      url.pathname !== "/linear/callback" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      query.getAll("state").length !== 1 ||
      query.get("state") !== pending.flowId ||
      !Number.isFinite(Date.parse(pending.expiresAt)) ||
      Date.parse(pending.expiresAt) <= now ||
      [...query.keys()].some(
        (key) =>
          !["state", "code", "error", "error_description"].includes(key) || query.getAll(key).length !== 1,
      ) ||
      query.has("code") === query.has("error")
    )
      throw new Error();
    if (query.has("error"))
      return {
        state: pending.flowId,
        error: query.get("error") === "access_denied" ? "denied" : "provider_rejected",
      };
    return AccountLinearCompleteRequestSchema.parse({ state: pending.flowId, code: query.get("code") });
  } catch {
    throw new AccountClientError("malformed");
  }
}
