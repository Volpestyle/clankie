/**
 * Resolving a stored credential into a usable `Authorization: Bearer` value.
 *
 * A connector's secret is not always the thing you send. An `api` credential is
 * the bearer verbatim; an `oauth` one expires, so the live value has to be
 * refreshed and written back before it goes out on the wire. Callers that talk
 * to a service — today the MCP host — want the bearer, not that distinction, so
 * it is resolved here once instead of at every call site.
 *
 * Refresh is per-provider because the token endpoint is: `linear` is the only
 * connector with an OAuth flow so far, and an unknown provider's expired token
 * is returned as-is rather than guessed at.
 */
import type { CredentialStore, ProviderCredential } from "./credential-store.ts";
import { LINEAR_PROVIDER_ID, linearOauthNeedsRefresh, refreshLinearOauth } from "./linear-oauth.ts";

type OauthCredential = Extract<ProviderCredential, { type: "oauth" }>;

/** Providers whose expired access tokens this process knows how to renew. */
const REFRESHERS: Readonly<Record<string, (credential: OauthCredential) => Promise<OauthCredential>>> = {
  [LINEAR_PROVIDER_ID]: refreshLinearOauth,
};

/**
 * The bearer to send for `providerId`, or `undefined` when nothing is connected.
 *
 * A refresh that fails falls back to the stored access token rather than
 * refusing: the token may still have life left, and letting the service reject
 * it produces a truthful error instead of a speculative local one.
 */
export async function resolveProviderBearer(
  providerId: string,
  credentials: CredentialStore,
  now = Date.now(),
): Promise<string | undefined> {
  const stored = await credentials.get(providerId);
  if (stored === undefined) return undefined;
  if (stored.type === "api") return stored.key.trim().length > 0 ? stored.key : undefined;
  if (stored.type === "wellknown") return stored.token.trim().length > 0 ? stored.token : undefined;
  if (stored.access.trim().length === 0) return undefined;
  if (!linearOauthNeedsRefresh(stored, now)) return stored.access;

  const refresh = REFRESHERS[providerId];
  if (refresh === undefined) return stored.access;
  try {
    const refreshed = await refresh(stored);
    await credentials.set(providerId, refreshed);
    return refreshed.access;
  } catch {
    return stored.access;
  }
}
