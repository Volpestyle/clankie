import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { z } from "zod";
import type { GoogleAccountProvider } from "@clankie/protocol/accounts";
import type { CredentialStore, ProviderCredential } from "./credential-store.ts";

export const GOOGLE_OAUTH_APP_PROVIDER_ID = "google-oauth-app";
export const GOOGLE_MANAGE_URL = "https://myaccount.google.com/connections";
export const GOOGLE_ACCOUNT_DEFINITIONS = {
  "google-gmail": {
    name: "Gmail",
    group: "google",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    description: "Read email for your daily briefing.",
    access: "Read messages and labels. Cannot send, change, or delete email.",
    readOnly: true,
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
    tools: ["search_threads", "get_thread", "get_message", "list_labels"],
  },
  "google-calendar": {
    name: "Google Calendar",
    group: "google",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    description: "Read upcoming events for your daily briefing.",
    access: "Read events on calendars you can access. Cannot create, change, or delete events.",
    readOnly: true,
    scope: "https://www.googleapis.com/auth/calendar.events.readonly",
    scopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    ],
    tools: ["list_calendars", "list_events", "get_event", "search_events"],
  },
  "google-drive": {
    name: "Google Drive",
    group: "google",
    url: "https://drivemcp.googleapis.com/mcp/v1",
    description: "Read reference documents you choose in Google Picker.",
    access: "Access to files you choose, including editing permission. Clankie only reads them.",
    readOnly: false,
    scope: "https://www.googleapis.com/auth/drive.file",
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    tools: ["get_file_metadata", "read_file_content", "download_file_content"],
  },
} as const satisfies Record<
  GoogleAccountProvider,
  {
    name: string;
    group: string;
    url: string;
    description: string;
    access: string;
    readOnly: boolean;
    scope: string;
    scopes: readonly string[];
    tools: readonly string[];
  }
>;
export const GOOGLE_PROVIDER_IDS = Object.keys(GOOGLE_ACCOUNT_DEFINITIONS) as GoogleAccountProvider[];
export const GOOGLE_BROKER_IDS = [GOOGLE_OAUTH_APP_PROVIDER_ID, ...GOOGLE_PROVIDER_IDS];
export interface GoogleOAuthApp {
  clientId?: string | undefined;
  redirectUri?: string | undefined;
}
export interface GoogleOAuthEndpoints {
  authorize: string;
  token: string;
  revoke: string;
  jwks: string;
  driveAbout?: string;
}
export const GOOGLE_OAUTH_ENDPOINTS: GoogleOAuthEndpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  driveAbout: "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)",
};
export type GoogleOAuthErrorCode =
  | "reconnect_required"
  | "unavailable"
  | "unconfigured"
  | "disconnected"
  | "provider_rejected";
export class GoogleOAuthError extends Error {
  readonly code: GoogleOAuthErrorCode;
  constructor(code: GoogleOAuthErrorCode) {
    super(`Google account ${code}`);
    this.code = code;
  }
}
const MetadataSchema = z
  .object({
    subject: z.string().min(1).max(255),
    email: z.email().max(320),
    clientId: z.string().min(1).max(512),
    scopes: z.string().min(1).max(2048),
    connectedAt: z.string().datetime(),
    status: z.enum(["connected", "disconnected", "reconnect_required", "unavailable"]),
    lastCheckedAt: z.string().datetime().optional(),
    reason: z
      .enum(["invalid_grant", "scope_required", "provider_unavailable", "revocation_pending"])
      .optional(),
    revocationPending: z.enum(["true", "false"]).optional(),
    revocationAttempts: z.string().regex(/^\d+$/u).optional(),
    revocationNextAt: z.string().regex(/^\d+$/u).optional(),
    identityEpoch: z.string().max(64).optional(),
    pickedFileIds: z.string().max(26_000).optional(),
  })
  .strict();
export type GoogleMetadata = z.infer<typeof MetadataSchema>;
export function googleMetadataStrings(metadata: GoogleMetadata): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
export type GoogleCredential = Extract<ProviderCredential, { type: "oauth" }> & { googleAuth: "user" };
export function googleCredentialMetadata(
  credential: ProviderCredential | undefined,
): GoogleMetadata | undefined {
  if (credential?.type !== "oauth" || credential.googleAuth !== "user") return undefined;
  const parsed = MetadataSchema.safeParse(credential.metadata);
  return parsed.success && credential.clientId === parsed.data.clientId ? parsed.data : undefined;
}
export function googleIdentityEpochKey(metadata: Pick<GoogleMetadata, "clientId" | "subject">): string {
  return `googleEpoch_${createHash("sha256")
    .update(JSON.stringify([metadata.clientId, metadata.subject]))
    .digest("hex")}`;
}
export function googleIdentityEpoch(
  app: ProviderCredential | undefined,
  metadata: Pick<GoogleMetadata, "clientId" | "subject">,
): string {
  return app?.type === "api" ? (app.metadata?.[googleIdentityEpochKey(metadata)] ?? "0") : "0";
}
const PickedFileIdsSchema = z
  .array(z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u))
  .min(1)
  .max(100);
export function googlePickedFileIds(credential: ProviderCredential | undefined): string[] {
  const metadata = googleCredentialMetadata(credential);
  try {
    const parsed = PickedFileIdsSchema.safeParse(JSON.parse(metadata?.pickedFileIds ?? "[]"));
    return parsed.success ? [...new Set(parsed.data)] : [];
  } catch {
    return [];
  }
}
export function googleScopes(provider: GoogleAccountProvider): string[] {
  return [...GOOGLE_ACCOUNT_DEFINITIONS[provider].scopes];
}
function grantedScopes(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/\s+/u)
        .filter(Boolean)
        .map((scope) => (scope === "https://www.googleapis.com/auth/userinfo.email" ? "email" : scope)),
    ),
  ].sort();
}
export function googleCredentialUsable(
  credential: ProviderCredential | undefined,
  provider: GoogleAccountProvider,
  clientId?: string,
  now = Date.now(),
): credential is GoogleCredential {
  const metadata = googleCredentialMetadata(credential);
  return (
    credential?.type === "oauth" &&
    metadata !== undefined &&
    metadata.status === "connected" &&
    credential.access.length > 0 &&
    credential.refresh.length > 0 &&
    (clientId === undefined || metadata.clientId === clientId) &&
    credential.expires > now &&
    validScopes(metadata.scopes, provider) &&
    (provider !== "google-drive" || googlePickedFileIds(credential).length > 0)
  );
}
export function generateGooglePkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
export function buildGoogleAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  provider: GoogleAccountProvider;
  challenge: string;
  state: string;
  nonce: string;
  endpoint?: string;
}): string {
  return `${input.endpoint ?? GOOGLE_OAUTH_ENDPOINTS.authorize}?${new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: googleScopes(input.provider).join(" "),
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: input.provider === "google-drive" ? "consent" : "consent select_account",
    include_granted_scopes: "false",
    ...(input.provider === "google-drive" ? { trigger_onepick: "true", allow_multiple: "true" } : {}),
  })}`;
}
/** Callback contract shared by body consent, refresh and runtime tool calls. */
export function validGoogleRedirect(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      url.pathname === "/account/connections/google/callback" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export function googleAppSecret(
  credential: ProviderCredential | undefined,
  clientId: string,
): string | undefined {
  return credential?.type === "api" && credential.metadata?.clientId === clientId
    ? credential.key
    : undefined;
}
async function json(response: Response, max = 100_000): Promise<unknown> {
  const text = await response.text();
  if (text.length > max) throw new GoogleOAuthError("provider_rejected");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GoogleOAuthError("provider_rejected");
  }
}
const TokenSchema = z.object({
  access_token: z.string().min(1).max(65_536),
  refresh_token: z.string().min(1).max(65_536).optional(),
  expires_in: z.number().int().positive().max(86_400),
  token_type: z.string().refine((v) => v.toLowerCase() === "bearer"),
  scope: z.string().min(1).max(2048).optional(),
  id_token: z.string().min(1).max(65_536).optional(),
});
async function requestTokens(parameters: Record<string, string>, request: typeof fetch, endpoint: string) {
  let response: Response;
  try {
    response = await request(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(parameters),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GoogleOAuthError("unavailable");
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429) throw new GoogleOAuthError("unavailable");
    const parsed = z.object({ error: z.string() }).safeParse(await json(response).catch(() => undefined));
    throw new GoogleOAuthError(
      parsed.success && parsed.data.error === "invalid_grant" ? "reconnect_required" : "provider_rejected",
    );
  }
  const parsed = TokenSchema.safeParse(await json(response));
  if (!parsed.success) throw new GoogleOAuthError("provider_rejected");
  return parsed.data;
}
const HeaderSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1).max(256) });
const IdentitySchema = z.object({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
  aud: z.string().min(1),
  azp: z.string().optional(),
  exp: z.number().int(),
  iat: z.number().int(),
  sub: z.string().min(1).max(255),
  email: z.email().max(320),
  email_verified: z.literal(true),
  nonce: z.string().optional(),
});
async function verifyIdentity(
  idToken: string,
  clientId: string,
  nonce: string | undefined,
  request: typeof fetch,
  endpoint: string,
  now: number,
) {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/u.test(p)))
    throw new GoogleOAuthError("provider_rejected");
  let header: z.infer<typeof HeaderSchema>;
  let identity: z.infer<typeof IdentitySchema>;
  try {
    header = HeaderSchema.parse(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")));
    identity = IdentitySchema.parse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
  } catch {
    throw new GoogleOAuthError("provider_rejected");
  }
  if (
    identity.aud !== clientId ||
    (identity.azp !== undefined && identity.azp !== clientId) ||
    identity.exp * 1000 <= now ||
    identity.iat * 1000 > now + 60_000 ||
    (nonce !== undefined && identity.nonce !== nonce)
  )
    throw new GoogleOAuthError("provider_rejected");
  let response: Response;
  try {
    response = await request(endpoint, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GoogleOAuthError("unavailable");
  }
  if (!response.ok) throw new GoogleOAuthError("unavailable");
  const keys = z
    .object({
      keys: z
        .array(
          z.object({
            kty: z.literal("RSA"),
            kid: z.string(),
            n: z.string(),
            e: z.string(),
            use: z.literal("sig").optional(),
            alg: z.literal("RS256").optional(),
          }),
        )
        .max(32),
    })
    .safeParse(await json(response));
  if (!keys.success) throw new GoogleOAuthError("provider_rejected");
  const key = keys.data.keys.find((k) => k.kid === header.kid);
  if (key === undefined) throw new GoogleOAuthError("provider_rejected");
  try {
    if (
      !verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(parts[2]!, "base64url"),
      )
    )
      throw new Error("invalid");
  } catch {
    throw new GoogleOAuthError("provider_rejected");
  }
  return identity;
}
async function verifyDriveIdentity(
  access: string,
  request: typeof fetch,
  endpoints: GoogleOAuthEndpoints,
): Promise<{ sub: string; email: string }> {
  let response: Response;
  try {
    response = await request(endpoints.driveAbout ?? GOOGLE_OAUTH_ENDPOINTS.driveAbout!, {
      redirect: "error",
      headers: { authorization: `Bearer ${access}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GoogleOAuthError("unavailable");
  }
  if (!response.ok)
    throw new GoogleOAuthError(
      response.status >= 500 || response.status === 429 ? "unavailable" : "provider_rejected",
    );
  const parsed = z
    .object({
      user: z.object({
        permissionId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/u),
        emailAddress: z.email().max(320),
      }),
    })
    .safeParse(await json(response));
  if (!parsed.success || JSON.stringify(parsed.data).includes(access))
    throw new GoogleOAuthError("provider_rejected");
  return { sub: `drive:${parsed.data.user.permissionId}`, email: parsed.data.user.emailAddress };
}
function validScopes(raw: string, provider: GoogleAccountProvider) {
  const granted = grantedScopes(raw);
  if (provider === "google-drive")
    return granted.length === 1 && granted[0] === GOOGLE_ACCOUNT_DEFINITIONS[provider].scope;
  const allowed = new Set((["google-gmail", "google-calendar"] as const).flatMap(googleScopes));
  return (
    googleScopes(provider).every((scope) => granted.includes(scope)) &&
    granted.every((scope) => allowed.has(scope))
  );
}
function validateScopes(raw: string | undefined, provider: GoogleAccountProvider) {
  if (raw === undefined || !validScopes(raw, provider)) throw new GoogleOAuthError("provider_rejected");
  return grantedScopes(raw).join(" ");
}
export async function exchangeGoogleAuthorizationCode(input: {
  provider: GoogleAccountProvider;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  verifier: string;
  nonce: string;
  previous?: ProviderCredential | undefined;
  pickedFileIds?: readonly string[] | undefined;
  fetchImpl?: typeof fetch;
  endpoints?: GoogleOAuthEndpoints;
  now?: number;
}): Promise<GoogleCredential> {
  const endpoints = input.endpoints ?? GOOGLE_OAUTH_ENDPOINTS;
  const request = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now();
  if (input.provider === "google-drive" && !PickedFileIdsSchema.safeParse(input.pickedFileIds).success)
    throw new GoogleOAuthError("provider_rejected");
  const issued = await requestTokens(
    {
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    },
    request,
    endpoints.token,
  );
  if (input.provider !== "google-drive" && !issued.id_token) throw new GoogleOAuthError("provider_rejected");
  const identity =
    input.provider === "google-drive"
      ? await verifyDriveIdentity(issued.access_token, request, endpoints)
      : await verifyIdentity(issued.id_token!, input.clientId, input.nonce, request, endpoints.jwks, now);
  const previous = googleCredentialMetadata(input.previous);
  const refresh =
    issued.refresh_token ??
    (input.previous?.type === "oauth" &&
    previous?.subject === identity.sub &&
    previous.clientId === input.clientId &&
    previous.status === "connected"
      ? input.previous.refresh
      : undefined);
  if (!refresh) throw new GoogleOAuthError("provider_rejected");
  if (
    [issued.access_token, refresh, input.clientSecret].some((secret) =>
      JSON.stringify(identity).includes(secret),
    )
  )
    throw new GoogleOAuthError("provider_rejected");
  return {
    type: "oauth",
    googleAuth: "user",
    access: issued.access_token,
    refresh,
    expires: now + issued.expires_in * 1000,
    clientId: input.clientId,
    metadata: {
      subject: identity.sub,
      email: identity.email,
      clientId: input.clientId,
      scopes: validateScopes(issued.scope, input.provider),
      connectedAt: new Date(now).toISOString(),
      lastCheckedAt: new Date(now).toISOString(),
      status: "connected",
      ...(input.provider === "google-drive"
        ? { pickedFileIds: JSON.stringify([...new Set(input.pickedFileIds!)]) }
        : {}),
    },
  };
}
export async function refreshGoogleOAuth(input: {
  credential: GoogleCredential;
  provider: GoogleAccountProvider;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  endpoints?: GoogleOAuthEndpoints;
  now?: number;
}): Promise<GoogleCredential> {
  const metadata = googleCredentialMetadata(input.credential);
  if (metadata === undefined || metadata.status === "disconnected" || !input.credential.refresh)
    throw new GoogleOAuthError("disconnected");
  const request = input.fetchImpl ?? fetch;
  const endpoints = input.endpoints ?? GOOGLE_OAUTH_ENDPOINTS;
  const now = input.now ?? Date.now();
  const issued = await requestTokens(
    {
      grant_type: "refresh_token",
      refresh_token: input.credential.refresh,
      client_id: metadata.clientId,
      client_secret: input.clientSecret,
    },
    request,
    endpoints.token,
  );
  if (input.provider === "google-drive") {
    const identity = await verifyDriveIdentity(issued.access_token, request, endpoints);
    if (
      identity.sub !== metadata.subject ||
      identity.email !== metadata.email ||
      googlePickedFileIds(input.credential).length === 0
    )
      throw new GoogleOAuthError("provider_rejected");
  } else if (issued.id_token !== undefined) {
    const identity = await verifyIdentity(
      issued.id_token,
      metadata.clientId,
      undefined,
      request,
      endpoints.jwks,
      now,
    );
    if (identity.sub !== metadata.subject || identity.email !== metadata.email)
      throw new GoogleOAuthError("provider_rejected");
  }
  const { reason: _reason, ...confirmed } = metadata;
  return {
    ...input.credential,
    access: issued.access_token,
    refresh: issued.refresh_token ?? input.credential.refresh,
    expires: now + issued.expires_in * 1000,
    metadata: {
      ...googleMetadataStrings(confirmed),
      scopes: validateScopes(issued.scope ?? metadata.scopes, input.provider),
      status: "connected",
      lastCheckedAt: new Date(now).toISOString(),
    },
  };
}
export async function revokeGoogleCredential(
  credential: GoogleCredential,
  request: typeof fetch = fetch,
  endpoints = GOOGLE_OAUTH_ENDPOINTS,
): Promise<boolean> {
  try {
    const response = await request(endpoints.revoke, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ token: credential.refresh || credential.access }),
      signal: AbortSignal.timeout(15_000),
    });
    // A 400 invalid_token is not evidence that every project grant was revoked.
    return response.status === 200;
  } catch {
    return false;
  }
}
export async function resolveGoogleBearer(input: {
  store: CredentialStore;
  provider: GoogleAccountProvider;
  apps: () => Promise<GoogleOAuthApp>;
  fetchImpl?: typeof fetch;
  now?: (() => number) | undefined;
  endpoints?: GoogleOAuthEndpoints;
  forceRefresh?: boolean;
  guard?: (() => Promise<void>) | undefined;
}): Promise<string> {
  if (!input.store.updateMany) throw new GoogleOAuthError("unavailable");
  const config = await input.apps();
  if (!config.clientId || !validGoogleRedirect(config.redirectUri))
    throw new GoogleOAuthError("unconfigured");
  let bearer: string | undefined;
  let failure: GoogleOAuthError | undefined;
  await input.store.updateMany(GOOGLE_BROKER_IDS, async (group) => {
    await input.guard?.();
    const credential = group[input.provider];
    const metadata = googleCredentialMetadata(credential);
    const secret = googleAppSecret(group[GOOGLE_OAUTH_APP_PROVIDER_ID], config.clientId!);
    if (!secret) {
      failure = new GoogleOAuthError("unconfigured");
      return group;
    }
    if (
      credential?.type !== "oauth" ||
      credential.googleAuth !== "user" ||
      metadata === undefined ||
      metadata.status === "disconnected"
    ) {
      failure = new GoogleOAuthError("disconnected");
      return group;
    }
    if (metadata.clientId !== config.clientId || metadata.status === "reconnect_required") {
      failure = new GoogleOAuthError("reconnect_required");
      return group;
    }
    if (
      (metadata.identityEpoch ?? "0") !== googleIdentityEpoch(group[GOOGLE_OAUTH_APP_PROVIDER_ID], metadata)
    ) {
      failure = new GoogleOAuthError("disconnected");
      return group;
    }
    const now = input.now?.() ?? Date.now();
    if (
      !input.forceRefresh &&
      googleCredentialUsable(credential, input.provider, config.clientId, now + 60_000)
    ) {
      bearer = credential.access;
      return group;
    }
    try {
      const refreshed = await refreshGoogleOAuth({
        credential: credential as GoogleCredential,
        provider: input.provider,
        clientSecret: secret,
        fetchImpl: input.fetchImpl ?? fetch,
        endpoints: input.endpoints ?? GOOGLE_OAUTH_ENDPOINTS,
        now,
      });
      await input.guard?.();
      group[input.provider] = refreshed;
      bearer = refreshed.access;
    } catch (error) {
      if (!(error instanceof GoogleOAuthError)) throw error;
      failure = error;
      const reconnect = error.code !== "unavailable";
      group[input.provider] = {
        ...credential,
        access: reconnect ? "" : credential.access,
        metadata: {
          ...googleMetadataStrings(metadata),
          status: reconnect ? "reconnect_required" : "unavailable",
          reason: reconnect
            ? error.code === "reconnect_required"
              ? "invalid_grant"
              : "scope_required"
            : "provider_unavailable",
          lastCheckedAt: new Date(now).toISOString(),
        },
      };
    }
    return group;
  });
  if (failure !== undefined) throw failure;
  if (!bearer) throw new GoogleOAuthError("unavailable");
  return bearer;
}
