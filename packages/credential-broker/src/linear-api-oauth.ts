import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderAccountSchema, type ProviderCredential } from "./credential-store.ts";

/** Registered app-actor OAuth for GraphQL; deliberately separate from MCP OAuth. */
export const LINEAR_API_PROVIDER_ID = "linear-api";
export const LINEAR_API_AUTHORIZE_ENDPOINT = "https://linear.app/oauth/authorize";
export const LINEAR_API_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
export const LINEAR_API_REVOKE_ENDPOINT = "https://api.linear.app/oauth/revoke";
export const LINEAR_API_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
export const LINEAR_API_OAUTH_SCOPES = ["read", "write"] as const;
type OauthCredential = Extract<ProviderCredential, { type: "oauth" }>;
const TokenResponseSchema = z.object({
  access_token: z.string().min(1).max(65_536),
  refresh_token: z.string().min(1).max(65_536).optional(),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(366 * 24 * 60 * 60),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  scope: z.string().max(8192).optional(),
});

export function providerGrantedScopes(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/[\s,]+/u).filter(Boolean))]
    .filter((scope) => scope.length <= 128)
    .slice(0, 64);
}

export function buildLinearApiAuthorizeUrl(input: {
  clientId: string;
  challenge: string;
  state: string;
  redirectUri: string;
}): string {
  const parameters = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: LINEAR_API_OAUTH_SCOPES.join(","),
    actor: "app",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  return `${LINEAR_API_AUTHORIZE_ENDPOINT}?${parameters}`;
}

async function tokens(parameters: Record<string, string>, request: typeof fetch) {
  let response: Response;
  try {
    response = await request(LINEAR_API_TOKEN_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(parameters),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Linear API token endpoint unavailable");
  }
  if (!response.ok) throw new Error("Linear API token request rejected");
  const parsed = TokenResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error("Linear API token response invalid");
  return parsed.data;
}

export async function verifyLinearApiOauthAccount(
  access: string,
  request: typeof fetch = fetch,
  otherSecrets: readonly string[] = [],
) {
  let response: Response;
  try {
    response = await request(LINEAR_API_GRAPHQL_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "query { viewer { id name email app } organization { id name } }" }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Linear API identity endpoint unavailable");
  }
  if (!response.ok) throw new Error("Linear API identity verification rejected");
  const parsed = z
    .object({
      data: z.object({
        viewer: z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          email: z.string().nullish(),
          app: z.literal(true),
        }),
        organization: z.object({ id: z.string().min(1), name: z.string().min(1) }),
      }),
      errors: z.array(z.unknown()).optional(),
    })
    .safeParse(await response.json().catch(() => undefined));
  if (
    !parsed.success ||
    parsed.data.errors?.length ||
    [access, ...otherSecrets]
      .filter(Boolean)
      .some((secret) => JSON.stringify(parsed.data.data).includes(secret))
  )
    throw new Error("Linear API did not verify an app identity");
  const { viewer, organization } = parsed.data.data;
  return ProviderAccountSchema.parse({
    provider: "linear",
    connectionId: randomUUID(),
    actor: "app",
    userId: viewer.id,
    name: viewer.name,
    ...(viewer.email ? { email: viewer.email } : {}),
    workspaceId: organization.id,
    workspaceName: organization.name,
    verifiedAt: new Date().toISOString(),
  });
}

export async function exchangeLinearApiAuthorizationCode(input: {
  code: string;
  redirectUri: string;
  verifier: string;
  clientId: string;
  fetchImpl?: typeof fetch;
}): Promise<OauthCredential> {
  const request = input.fetchImpl ?? fetch;
  const issued = await tokens(
    {
      grant_type: "authorization_code",
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code: input.code,
      code_verifier: input.verifier,
    },
    request,
  );
  if (!issued.refresh_token) throw new Error("Linear API did not issue a refresh token");
  const account = await verifyLinearApiOauthAccount(issued.access_token, request, [issued.refresh_token]);
  if (
    JSON.stringify(account).includes(issued.refresh_token) ||
    issued.scope?.includes(issued.access_token) ||
    issued.scope?.includes(issued.refresh_token)
  )
    throw new Error("Linear API metadata response invalid");
  return {
    type: "oauth",
    linearAuth: "api",
    access: issued.access_token,
    refresh: issued.refresh_token,
    expires: Date.now() + issued.expires_in * 1000,
    clientId: input.clientId,
    account,
    metadata: { scopes: providerGrantedScopes(issued.scope).join(","), connectedAt: account.verifiedAt },
  };
}

export async function refreshLinearApiOauth(
  credential: OauthCredential,
  request: typeof fetch = fetch,
): Promise<OauthCredential> {
  if (credential.linearAuth !== "api" || !credential.clientId || !credential.refresh)
    throw new Error("Linear API credentials are incomplete");
  const issued = await tokens(
    { grant_type: "refresh_token", client_id: credential.clientId, refresh_token: credential.refresh },
    request,
  );
  if (!issued.refresh_token) throw new Error("Linear API did not rotate the refresh token");
  if (issued.scope?.includes(issued.access_token) || issued.scope?.includes(issued.refresh_token))
    throw new Error("Linear API metadata response invalid");
  return {
    ...credential,
    access: issued.access_token,
    refresh: issued.refresh_token,
    expires: Date.now() + issued.expires_in * 1000,
    metadata: {
      ...credential.metadata,
      ...(issued.scope === undefined ? {} : { scopes: providerGrantedScopes(issued.scope).join(",") }),
    },
  };
}

export async function revokeLinearApiOauth(
  credential: ProviderCredential | undefined,
  request: typeof fetch = fetch,
): Promise<boolean> {
  if (credential?.type !== "oauth" || credential.linearAuth !== "api") return false;
  try {
    const response = await request(LINEAR_API_REVOKE_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        token: credential.refresh || credential.access,
        token_type_hint: credential.refresh ? "refresh_token" : "access_token",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
