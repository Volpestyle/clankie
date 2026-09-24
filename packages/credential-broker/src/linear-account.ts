import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderAccountSchema, type ProviderAccount } from "./credential-store.ts";

/** Personal API keys authenticate directly; MCP-audience OAuth is not a GraphQL credential. */
export async function verifyLinearApiAccount(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderAccount> {
  const response = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: key, "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ query: "query { viewer { id name email } organization { id name } }" }),
  });
  if (!response.ok) throw new Error(`Linear identity verification failed: HTTP ${response.status}`);
  const payload = z
    .object({
      data: z
        .object({
          viewer: z.object({ id: z.string().min(1), name: z.string().min(1), email: z.string().min(1) }),
          organization: z.object({ id: z.string().min(1), name: z.string().min(1) }),
        })
        .optional(),
      errors: z.array(z.object({ message: z.string() })).optional(),
    })
    .parse(await response.json());
  if (payload.errors?.length) throw new Error(payload.errors.map((entry) => entry.message).join("; "));
  if (payload.data === undefined) throw new Error("Linear did not return an authenticated account");
  return ProviderAccountSchema.parse({
    provider: "linear",
    connectionId: randomUUID(),
    verifiedAt: new Date().toISOString(),
    userId: payload.data.viewer.id,
    email: payload.data.viewer.email,
    name: payload.data.viewer.name,
    workspaceId: payload.data.organization.id,
    workspaceName: payload.data.organization.name,
  });
}
