import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderAccountSchema, type ProviderCredential } from "./credential-store.ts";

type OauthCredential = Extract<ProviderCredential, { type: "oauth" }>;
const LINEAR_APP_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";

/** Workspace-owned app authentication. Secrets never leave the broker/API boundary. */
export async function connectLinearApp(
  client: { clientId: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OauthCredential> {
  const response = await fetchImpl(LINEAR_APP_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      scope: "read,write",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  // Provider bodies can echo secrets; only closed errors cross this boundary.
  if (!response.ok) throw new Error("Linear app token request rejected");
  const tokens = z
    .object({
      access_token: z.string().min(1),
      expires_in: z.number().positive(),
      token_type: z.literal("Bearer").optional(),
    })
    .safeParse(await response.json());
  if (!tokens.success) throw new Error("Linear app token response invalid");
  const account = await verifyLinearAppAccount(tokens.data.access_token, fetchImpl);
  return {
    type: "oauth",
    linearAuth: "app",
    access: tokens.data.access_token,
    refresh: "",
    expires: Date.now() + tokens.data.expires_in * 1000,
    ...client,
    account,
  };
}

export async function verifyLinearAppAccount(access: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "query { viewer { id name email app } organization { id name } }" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Linear app identity verification rejected");
  const result = z
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
    .safeParse(await response.json());
  if (!result.success || result.data.errors?.length) throw new Error("Linear did not verify an app identity");
  const { viewer, organization } = result.data.data;
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

export async function refreshLinearApp(
  credential: OauthCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<OauthCredential> {
  if (
    credential.clientId === undefined ||
    credential.clientSecret === undefined ||
    credential.account?.actor !== "app"
  )
    throw new Error("Linear app credentials are incomplete");
  const renewed = await connectLinearApp(
    { clientId: credential.clientId, clientSecret: credential.clientSecret },
    fetchImpl,
  );
  if (
    renewed.account?.userId !== credential.account.userId ||
    renewed.account.workspaceId !== credential.account.workspaceId
  )
    throw new Error("Linear app identity changed; reconnect explicitly");
  return { ...renewed, account: { ...renewed.account, connectionId: credential.account.connectionId } };
}
