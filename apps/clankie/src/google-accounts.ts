import { createHash, randomBytes } from "node:crypto";
import {
  GOOGLE_ACCOUNT_DEFINITIONS,
  GOOGLE_BROKER_IDS,
  GOOGLE_MANAGE_URL,
  GOOGLE_OAUTH_APP_PROVIDER_ID,
  GOOGLE_OAUTH_ENDPOINTS,
  GOOGLE_PROVIDER_IDS,
  GoogleOAuthError,
  buildGoogleAuthorizeUrl,
  exchangeGoogleAuthorizationCode,
  generateGooglePkce,
  googleAppSecret,
  validGoogleRedirect,
  googleCredentialMetadata,
  googleMetadataStrings,
  googlePickedFileIds,
  googleIdentityEpoch,
  googleIdentityEpochKey,
  resolveGoogleBearer,
  revokeGoogleCredential,
  type CredentialGroup,
  type CredentialStore,
  type GoogleCredential,
  type GoogleOAuthApp,
  type GoogleOAuthEndpoints,
} from "@clankie/credential-broker";
import type {
  AccountConnection,
  AccountDisconnectResult,
  AccountGoogleCompleteResult,
  AccountGoogleStartResult,
  GoogleAccountProvider,
} from "@clankie/protocol/accounts";

export interface GoogleAccountsOptions {
  store: CredentialStore;
  apps: () => Promise<GoogleOAuthApp>;
  fetch?: typeof fetch;
  now?: () => number;
  endpoints?: GoogleOAuthEndpoints;
}
export interface GoogleAccountsPort {
  list(): Promise<AccountConnection[]>;
  start(provider: GoogleAccountProvider): Promise<AccountGoogleStartResult>;
  complete(
    provider: GoogleAccountProvider,
    state: string,
    code: string,
    guard?: () => Promise<void>,
    pickedFileIds?: readonly string[],
  ): Promise<AccountGoogleCompleteResult>;
  check(provider: GoogleAccountProvider, guard?: () => Promise<void>): Promise<AccountGoogleCompleteResult>;
  disconnect(provider: GoogleAccountProvider, guard?: () => Promise<void>): Promise<AccountDisconnectResult>;
}
interface Flow {
  provider: GoogleAccountProvider;
  verifier: string;
  nonce: string;
  clientId: string;
  redirectUri: string;
  binding: string;
  expiresAt: number;
}
const FLOW_TTL = 10 * 60_000;
const MAX_REVOCATION_ATTEMPTS = 3;
function appBinding(group: CredentialGroup, config: GoogleOAuthApp): string | undefined {
  if (!config.clientId || !config.redirectUri) return undefined;
  const credential = group[GOOGLE_OAUTH_APP_PROVIDER_ID];
  const secret = googleAppSecret(credential, config.clientId);
  if (secret === undefined || credential?.type !== "api") return undefined;
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.clientId,
        config.redirectUri,
        secret,
        credential.metadata?.googleGeneration ?? "0",
      ]),
    )
    .digest("hex");
}
/** One catalog and lifecycle on the tenant body. Portals never hold Google tokens. */
export function createGoogleAccounts(options: GoogleAccountsOptions): GoogleAccountsPort {
  const store = options.store;
  const now = options.now ?? Date.now;
  const request = options.fetch ?? fetch;
  const endpoints = options.endpoints ?? GOOGLE_OAUTH_ENDPOINTS;
  const flows = new Map<string, Flow>();
  let pending: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const mutate = async (transform: (group: CredentialGroup) => Promise<CredentialGroup>) => {
    if (store.updateMany === undefined) throw new GoogleOAuthError("unavailable");
    return store.updateMany(GOOGLE_BROKER_IDS, transform);
  };
  const retryRevocations = async (guard?: () => Promise<void>) => {
    await mutate(async (group) => {
      const due = GOOGLE_PROVIDER_IDS.filter((provider) => {
        const metadata = googleCredentialMetadata(group[provider]);
        return (
          metadata?.status === "disconnected" &&
          metadata.revocationPending === "true" &&
          Number(metadata.revocationAttempts ?? "0") < MAX_REVOCATION_ATTEMPTS &&
          Number(metadata.revocationNextAt ?? "0") <= now()
        );
      });
      for (const provider of due) {
        const credential = group[provider];
        const metadata = googleCredentialMetadata(credential);
        if (
          credential?.type !== "oauth" ||
          !metadata ||
          metadata.revocationPending !== "true" ||
          Number(metadata.revocationNextAt ?? "0") > now() ||
          Number(metadata.revocationAttempts ?? "0") >= MAX_REVOCATION_ATTEMPTS
        )
          continue;
        await guard?.();
        const revoked = await revokeGoogleCredential(credential as GoogleCredential, request, endpoints);
        await guard?.();
        const attempts = Number(metadata.revocationAttempts ?? "0") + 1;
        // Google revokes all of this user's grants to this project. Reconcile
        // every sibling locally, without affecting another user's identity.
        for (const sibling of GOOGLE_PROVIDER_IDS) {
          const current = group[sibling];
          const siblingMetadata = googleCredentialMetadata(current);
          if (
            current?.type !== "oauth" ||
            siblingMetadata?.clientId !== metadata.clientId ||
            siblingMetadata.email !== metadata.email ||
            siblingMetadata.status !== "disconnected"
          )
            continue;
          const { reason: _reason, ...rest } = siblingMetadata;
          group[sibling] = {
            ...current,
            access: "",
            refresh: revoked ? "" : current.refresh,
            expires: 0,
            metadata: {
              ...googleMetadataStrings(rest),
              status: "disconnected",
              revocationPending: revoked ? "false" : "true",
              revocationAttempts: String(attempts),
              revocationNextAt: String(now() + 60_000 * attempts),
              ...(revoked ? {} : { reason: "revocation_pending" }),
              lastCheckedAt: new Date(now()).toISOString(),
            },
          };
        }
      }
      return group;
    });
  };
  const connection = async (
    provider: GoogleAccountProvider,
    config: GoogleOAuthApp,
  ): Promise<AccountConnection> => {
    const credential = await store.get(provider);
    const metadata = googleCredentialMetadata(credential);
    const app = await store.get(GOOGLE_OAUTH_APP_PROVIDER_ID);
    const secret = config.clientId ? googleAppSecret(app, config.clientId) : undefined;
    const definition = GOOGLE_ACCOUNT_DEFINITIONS[provider];
    const { scope: _scope, scopes: _scopes, tools: _tools, url: _url, ...catalog } = definition;
    const configured =
      !!config.clientId &&
      !!config.redirectUri &&
      validGoogleRedirect(config.redirectUri) &&
      secret !== undefined;
    let status: AccountConnection["status"] = configured ? "not_connected" : "unconfigured";
    if (metadata !== undefined) {
      status = metadata.status;
      if (app?.type === "api" && (metadata.identityEpoch ?? "0") !== googleIdentityEpoch(app, metadata))
        status = "disconnected";
      if (status === "connected" && config.clientId !== undefined && config.clientId !== metadata.clientId)
        status = "reconnect_required";
      else if (status === "connected" && !configured) status = "unconfigured";
      else if (status === "connected" && credential?.type === "oauth" && credential.expires <= now())
        status = "expired";
    } else if ([...flows.values()].some((flow) => flow.provider === provider && flow.expiresAt > now()))
      status = "awaiting_consent";
    return {
      provider,
      ...catalog,
      status,
      scopes: metadata?.scopes.split(/\s+/u) ?? [],
      manageUrl: GOOGLE_MANAGE_URL,
      ...(provider === "google-drive" && metadata !== undefined
        ? { selectedFileIds: googlePickedFileIds(credential) }
        : {}),
      ...(metadata === undefined
        ? {}
        : {
            account: metadata.email,
            actor: "user",
            connectedAt: metadata.connectedAt,
            ...(metadata.lastCheckedAt === undefined ? {} : { lastCheckedAt: metadata.lastCheckedAt }),
            ...(metadata.reason === undefined ? {} : { reason: metadata.reason }),
            revocationPending: metadata.revocationPending === "true",
          }),
    };
  };
  return {
    list: () =>
      serialize(async () => {
        if (store.updateMany !== undefined) await retryRevocations();
        const config = await options.apps();
        return Promise.all(GOOGLE_PROVIDER_IDS.map((provider) => connection(provider, config)));
      }),
    start: (provider) =>
      serialize(async () => {
        const config = await options.apps();
        if (!config.clientId || !config.redirectUri || !validGoogleRedirect(config.redirectUri))
          return { ok: false, error: "unconfigured" };
        let binding: string | undefined;
        let revocationPending = false;
        try {
          await mutate(async (group) => {
            revocationPending = GOOGLE_PROVIDER_IDS.some(
              (id) => googleCredentialMetadata(group[id])?.revocationPending === "true",
            );
            binding = appBinding(group, config);
            return group;
          });
        } catch {
          return { ok: false, error: "unavailable" };
        }
        if (!binding) return { ok: false, error: "unconfigured" };
        // A pending project revoke must settle before admitting a new grant;
        // otherwise its eventual retry could revoke freshly consented access.
        if (revocationPending) return { ok: false, error: "unavailable" };
        for (const [state, flow] of flows)
          if (flow.expiresAt <= now() || flow.provider === provider) flows.delete(state);
        if (flows.size >= 16) flows.delete(flows.keys().next().value!);
        const pkce = generateGooglePkce();
        const state = randomBytes(32).toString("base64url");
        const nonce = randomBytes(32).toString("base64url");
        const expiresAt = now() + FLOW_TTL;
        flows.set(state, {
          provider,
          verifier: pkce.verifier,
          nonce,
          clientId: config.clientId,
          redirectUri: config.redirectUri,
          binding,
          expiresAt,
        });
        return {
          ok: true,
          flowId: state,
          redirectUri: config.redirectUri,
          expiresAt: new Date(expiresAt).toISOString(),
          authorizeUrl: buildGoogleAuthorizeUrl({
            provider,
            clientId: config.clientId,
            redirectUri: config.redirectUri,
            state,
            nonce,
            challenge: pkce.challenge,
            endpoint: endpoints.authorize,
          }),
        };
      }),
    complete: (provider, state, code, guard, pickedFileIds) =>
      serialize(async () => {
        const flow = flows.get(state);
        flows.delete(state);
        if (flow === undefined || flow.provider !== provider) return { ok: false, error: "unknown_flow" };
        if (flow.expiresAt <= now()) return { ok: false, error: "expired" };
        const config = await options.apps();
        let failure: "unknown_flow" | "unconfigured" | "provider_rejected" | "unavailable" | undefined;
        try {
          await mutate(async (group) => {
            await guard?.();
            if (appBinding(group, config) !== flow.binding) {
              failure = "unknown_flow";
              return group;
            }
            const secret = googleAppSecret(group[GOOGLE_OAUTH_APP_PROVIDER_ID], flow.clientId);
            if (!secret) {
              failure = "unconfigured";
              return group;
            }
            try {
              const credential = await exchangeGoogleAuthorizationCode({
                provider,
                code,
                clientId: flow.clientId,
                clientSecret: secret,
                redirectUri: flow.redirectUri,
                verifier: flow.verifier,
                nonce: flow.nonce,
                previous: group[provider],
                pickedFileIds,
                fetchImpl: request,
                endpoints,
                now: now(),
              });
              await guard?.();
              const metadata = googleCredentialMetadata(credential)!;
              group[provider] = {
                ...credential,
                metadata: {
                  ...credential.metadata,
                  identityEpoch: googleIdentityEpoch(group[GOOGLE_OAUTH_APP_PROVIDER_ID], metadata),
                },
              };
            } catch (error) {
              if (!(error instanceof GoogleOAuthError)) throw error;
              failure = error.code === "unavailable" ? "unavailable" : "provider_rejected";
            }
            return group;
          });
        } catch (error) {
          if (!(error instanceof GoogleOAuthError)) throw error;
          return { ok: false, error: "unavailable" };
        }
        if (failure !== undefined) return { ok: false, error: failure };
        return { ok: true, connection: await connection(provider, config) };
      }),
    check: (provider, guard) =>
      serialize(async () => {
        const config = await options.apps();
        if (!config.clientId || !config.redirectUri || !validGoogleRedirect(config.redirectUri))
          return { ok: false, error: "unconfigured" };
        try {
          await resolveGoogleBearer({
            store,
            provider,
            apps: options.apps,
            fetchImpl: request,
            endpoints,
            now,
            forceRefresh: true,
            guard,
          });
        } catch (error) {
          if (!(error instanceof GoogleOAuthError)) throw error;
          if (error.code === "unconfigured") return { ok: false, error: "unconfigured" };
          if (error.code === "disconnected") return { ok: false, error: "denied" };
          if (error.code === "unavailable") return { ok: false, error: "unavailable" };
          return { ok: false, error: "provider_rejected" };
        }
        return { ok: true, connection: await connection(provider, await options.apps()) };
      }),
    disconnect: (provider, guard) =>
      serialize(async () => {
        flows.clear();
        let affected = false;
        await mutate(async (group) => {
          await guard?.();
          const app = group[GOOGLE_OAUTH_APP_PROVIDER_ID];
          const epochs: Record<string, string> = {};
          for (const sibling of GOOGLE_PROVIDER_IDS) {
            const metadata = googleCredentialMetadata(group[sibling]);
            if (metadata) epochs[googleIdentityEpochKey(metadata)] = randomBytes(16).toString("hex");
          }
          // The barrier must survive missing app setup and partial Keychain
          // publication. An inert marker has no clientId and cannot authorize
          // Google requests; secret provisioning preserves these epochs.
          group[GOOGLE_OAUTH_APP_PROVIDER_ID] = {
            ...(app?.type === "api" ? app : { type: "api", key: randomBytes(32).toString("base64url") }),
            metadata: {
              ...(app?.type === "api" ? app.metadata : {}),
              googleGeneration: randomBytes(16).toString("hex"),
              ...epochs,
            },
          };
          for (const sibling of GOOGLE_PROVIDER_IDS) {
            const credential = group[sibling];
            const metadata = googleCredentialMetadata(credential);
            if (credential?.type !== "oauth" || !metadata) continue;
            affected = true;
            group[sibling] = {
              ...credential,
              access: "",
              expires: 0,
              metadata: {
                ...googleMetadataStrings(metadata),
                status: "disconnected",
                revocationPending: credential.refresh ? "true" : "false",
                revocationAttempts: "0",
                revocationNextAt: "0",
                ...(credential.refresh ? { reason: "revocation_pending" } : {}),
              },
            };
          }
          return group;
        });
        await retryRevocations(guard);
        const selected = googleCredentialMetadata(await store.get(provider));
        const revoked = affected && selected?.revocationPending === "false";
        return { ok: true, revoked, ...(revoked ? {} : { manageUrl: GOOGLE_MANAGE_URL }) };
      }),
  };
}
