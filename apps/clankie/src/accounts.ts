import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  connectLinearApp,
  LINEAR_OAUTH_ISSUER,
  LINEAR_OAUTH_SCOPES,
  LINEAR_PROVIDER_ID,
  buildLinearAuthorizeUrl,
  exchangeLinearAuthorizationCode,
  generateLinearPkce,
  registerLinearOauthClient,
  type CredentialStore,
  type ProviderCredential,
} from "@clankie/credential-broker";
import type {
  AccountConnection,
  AccountDisconnectResult,
  AccountGithubPollResult,
  AccountGithubStartResult,
  AccountLinearCompleteResult,
  AccountLinearStartResult,
  AccountProvider,
  AccountsResponse,
} from "@clankie/protocol/accounts";

/**
 * The owner's own GitHub and Linear accounts, linked to this body (ADR 0196).
 * Tokens go straight from the provider into the credential broker; flows keep
 * their device code and PKCE verifier here, and every result is a closed code,
 * because provider error text can echo what it was sent.
 */

const GITHUB_PROVIDER_ID = "github";
/** Optional OAuth app client secret; GitHub only revokes a grant for the app that holds it. */
export const GITHUB_OAUTH_APP_PROVIDER_ID = "github-oauth-app";
const GITHUB_SCOPES = ["repo"] as const;
const GITHUB_WEB = "https://github.com";
const GITHUB_API = "https://api.github.com";
const LINEAR_FLOW_TTL_MS = 10 * 60_000;
const LINEAR_MANAGE_URL = "https://linear.app/settings/account/security";
const MAX_PENDING_FLOWS = 16;
const REQUEST_TIMEOUT_MS = 15_000;

export interface OauthApps {
  readonly github: { readonly clientId?: string | undefined };
  readonly linear: { readonly clientId?: string | undefined; readonly redirectUri?: string | undefined };
}

export interface AccountsPort {
  list(): Promise<AccountsResponse>;
  startGithub(): Promise<AccountGithubStartResult>;
  pollGithub(flowId: string): Promise<AccountGithubPollResult>;
  startLinear(): Promise<AccountLinearStartResult>;
  completeLinear(state: string, code: string): Promise<AccountLinearCompleteResult>;
  connectLinearApp(client: { clientId: string; clientSecret: string }): Promise<AccountLinearCompleteResult>;
  disconnect(provider: AccountProvider): Promise<AccountDisconnectResult>;
}

export interface AccountsOptions {
  readonly store: CredentialStore;
  /** Read for every request, so a client ID set with the CLI applies without a restart. */
  readonly apps: () => Promise<OauthApps>;
  readonly fetch?: typeof fetch;
  /** Test seams: the fake provider's origins. */
  readonly githubWeb?: string;
  readonly githubApi?: string;
  readonly linearIssuer?: string;
  readonly now?: () => number;
}

/** Settings first, the environment wins: a hosted body's provisioner sets the environment. */
export function oauthAppsFrom(
  settings: {
    readonly github?: { readonly clientId?: string | undefined };
    readonly linear?: { readonly clientId?: string | undefined; readonly redirectUri?: string | undefined };
  },
  env: NodeJS.ProcessEnv,
): OauthApps {
  const pick = (name: string, fallback: string | undefined) => env[name]?.trim() || fallback;
  return {
    github: { clientId: pick("CLANKIE_GITHUB_OAUTH_CLIENT_ID", settings.github?.clientId) },
    linear: {
      clientId: pick("CLANKIE_LINEAR_OAUTH_CLIENT_ID", settings.linear?.clientId),
      redirectUri: pick("CLANKIE_LINEAR_OAUTH_REDIRECT_URI", settings.linear?.redirectUri),
    },
  };
}

/** The GitHub connection's token for tools on this body, or undefined when GitHub is not connected. */
export async function githubConnectionToken(
  store: Pick<CredentialStore, "get">,
): Promise<string | undefined> {
  const credential = await store.get(GITHUB_PROVIDER_ID);
  return credential?.type === "api" ? credential.key : undefined;
}

const DeviceCodeSchema = z.object({
  device_code: z.string().min(1).max(512),
  user_code: z.string().min(1).max(64),
  verification_uri: z.url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().optional(),
});

const DeviceTokenSchema = z.union([
  z.object({ access_token: z.string().min(1), scope: z.string().optional() }),
  z.object({ error: z.string(), interval: z.number().int().positive().optional() }),
]);

const GithubUserSchema = z.object({ login: z.string().min(1).max(100) });

const AuthorizationServerSchema = z.object({ revocation_endpoint: z.url().optional() });

interface GithubFlow {
  readonly deviceCode: string;
  readonly clientId: string;
  readonly expiresAt: number;
  interval: number;
  nextPollAt: number;
}

interface LinearFlow {
  readonly verifier: string;
  readonly redirectUri: string;
  readonly client: { clientId: string; clientSecret?: string };
  readonly expiresAt: number;
}

const flowId = () => randomBytes(24).toString("base64url");

function prune<T extends { expiresAt: number }>(flows: Map<string, T>, now: number) {
  for (const [id, flow] of flows) if (flow.expiresAt <= now) flows.delete(id);
  while (flows.size >= MAX_PENDING_FLOWS) flows.delete(flows.keys().next().value!);
}

function scopesOf(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/u)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0)
    .slice(0, 64);
}

export function createAccounts(options: AccountsOptions): AccountsPort {
  const { store } = options;
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const githubWeb = options.githubWeb ?? GITHUB_WEB;
  const githubApi = options.githubApi ?? GITHUB_API;
  const linearIssuer = options.linearIssuer ?? LINEAR_OAUTH_ISSUER;
  const githubFlows = new Map<string, GithubFlow>();
  const linearFlows = new Map<string, LinearFlow>();
  /** Dynamic registrations are per redirect URI; one is enough for the process. */
  const linearClients = new Map<string, Promise<{ clientId: string; clientSecret?: string }>>();

  const call = (url: string, init: RequestInit) =>
    request(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  const githubManageUrl = (clientId: string | undefined) =>
    clientId === undefined ? undefined : `${GITHUB_WEB}/settings/connections/applications/${clientId}`;

  const githubConnection = async (apps: OauthApps): Promise<AccountConnection> => {
    const credential = await store.get(GITHUB_PROVIDER_ID);
    const clientId =
      (credential?.type === "api" ? credential.metadata?.clientId : undefined) ?? apps.github.clientId;
    const manageUrl = githubManageUrl(clientId);
    if (credential?.type !== "api")
      return {
        provider: "github",
        status: apps.github.clientId === undefined ? "unconfigured" : "not_connected",
        scopes: [],
      };
    const connectedAt = credential.metadata?.connectedAt;
    return {
      provider: "github",
      status: "connected",
      ...(credential.metadata?.login === undefined ? {} : { account: credential.metadata.login }),
      scopes: scopesOf(credential.metadata?.scopes),
      ...(connectedAt === undefined || Number.isNaN(Date.parse(connectedAt)) ? {} : { connectedAt }),
      ...(manageUrl === undefined ? {} : { manageUrl }),
    };
  };

  const linearConnection = async (apps: OauthApps): Promise<AccountConnection> => {
    const credential = await store.get(LINEAR_PROVIDER_ID);
    if (credential === undefined || credential.type === "wellknown")
      return {
        provider: "linear",
        status: apps.linear.redirectUri === undefined ? "unconfigured" : "not_connected",
        scopes: [],
      };
    const account = credential.account;
    return {
      provider: "linear",
      status: "connected",
      ...(account === undefined
        ? {}
        : {
            account: account.actor === "app" ? account.name : (account.email ?? account.name),
            actor: account.actor ?? "user",
            workspace: account.workspaceName,
          }),
      // A personal API key carries its owner's full access and no scope list.
      scopes: credential.type === "oauth" ? scopesOf(LINEAR_OAUTH_SCOPES) : [],
      ...(account === undefined ? {} : { connectedAt: account.verifiedAt }),
      manageUrl: account?.actor === "app" ? "https://linear.app/settings/api" : LINEAR_MANAGE_URL,
    };
  };

  const revokeGithub = async (credential: ProviderCredential | undefined, apps: OauthApps) => {
    if (credential?.type !== "api") return false;
    const clientId = credential.metadata?.clientId ?? apps.github.clientId;
    const secret = await store.get(GITHUB_OAUTH_APP_PROVIDER_ID);
    if (clientId === undefined || secret?.type !== "api") return false;
    try {
      const response = await call(`${githubApi}/applications/${encodeURIComponent(clientId)}/grant`, {
        method: "DELETE",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Basic ${Buffer.from(`${clientId}:${secret.key}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: credential.key }),
      });
      // 404/422: GitHub no longer knows the grant, which is the state disconnect wants.
      return response.status === 204 || response.status === 404 || response.status === 422;
    } catch {
      return false;
    }
  };

  const revokeLinear = async (credential: ProviderCredential | undefined) => {
    if (credential?.type !== "oauth" || credential.clientId === undefined) return false;
    try {
      const metadata =
        credential.linearAuth === "app"
          ? undefined
          : AuthorizationServerSchema.safeParse(
              await (
                await call(`${linearIssuer}/.well-known/oauth-authorization-server`, {
                  headers: { accept: "application/json" },
                })
              ).json(),
            );
      const endpoint =
        credential.linearAuth === "app"
          ? "https://api.linear.app/oauth/revoke"
          : metadata?.success
            ? metadata.data.revocation_endpoint
            : undefined;
      if (endpoint === undefined) return false;
      // RFC 7009: revoking the refresh token ends the grant; the access token goes with it.
      const response = await call(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          token: credential.refresh.length > 0 ? credential.refresh : credential.access,
          token_type_hint: credential.refresh.length > 0 ? "refresh_token" : "access_token",
          client_id: credential.clientId,
          ...(credential.clientSecret === undefined ? {} : { client_secret: credential.clientSecret }),
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  };

  return {
    async list() {
      const apps = await options.apps();
      return { connections: [await githubConnection(apps), await linearConnection(apps)] };
    },

    async startGithub() {
      const { github } = await options.apps();
      if (github.clientId === undefined) return { ok: false, error: "unconfigured" };
      let parsed: z.infer<typeof DeviceCodeSchema>;
      try {
        const response = await call(`${githubWeb}/login/device/code`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: github.clientId, scope: GITHUB_SCOPES.join(" ") }),
        });
        const body = DeviceCodeSchema.safeParse(await response.json().catch(() => undefined));
        if (!response.ok || !body.success) return { ok: false, error: "provider_rejected" };
        parsed = body.data;
      } catch {
        return { ok: false, error: "unavailable" };
      }
      const started = now();
      prune(githubFlows, started);
      const id = flowId();
      const interval = Math.min(Math.max(parsed.interval ?? 5, 1), 600);
      const expiresAt = started + parsed.expires_in * 1000;
      githubFlows.set(id, {
        deviceCode: parsed.device_code,
        clientId: github.clientId,
        expiresAt,
        interval,
        nextPollAt: started,
      });
      return {
        ok: true,
        flowId: id,
        userCode: parsed.user_code,
        verificationUri: parsed.verification_uri,
        expiresAt: new Date(expiresAt).toISOString(),
        interval,
      };
    },

    async pollGithub(id) {
      const flow = githubFlows.get(id);
      if (flow === undefined) return { ok: false, error: "unknown_flow" };
      const polled = now();
      if (flow.expiresAt <= polled) {
        githubFlows.delete(id);
        return { ok: false, error: "expired" };
      }
      // A client polling faster than GitHub allows is answered here, not forwarded.
      if (polled < flow.nextPollAt) return { ok: true, status: "pending", interval: flow.interval };
      flow.nextPollAt = polled + flow.interval * 1000;
      let token: z.infer<typeof DeviceTokenSchema>;
      try {
        const response = await call(`${githubWeb}/login/oauth/access_token`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: flow.clientId,
            device_code: flow.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });
        const body = DeviceTokenSchema.safeParse(await response.json().catch(() => undefined));
        if (!body.success) return { ok: false, error: "unavailable" };
        token = body.data;
      } catch {
        return { ok: false, error: "unavailable" };
      }
      if ("error" in token) {
        if (token.error === "authorization_pending")
          return { ok: true, status: "pending", interval: flow.interval };
        if (token.error === "slow_down") {
          flow.interval = Math.min(token.interval ?? flow.interval + 5, 600);
          flow.nextPollAt = polled + flow.interval * 1000;
          return { ok: true, status: "pending", interval: flow.interval };
        }
        githubFlows.delete(id);
        if (token.error === "expired_token") return { ok: false, error: "expired" };
        if (token.error === "access_denied") return { ok: false, error: "denied" };
        return { ok: false, error: "provider_rejected" };
      }
      githubFlows.delete(id);
      let login: string | undefined;
      try {
        const response = await call(`${githubApi}/user`, {
          headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.access_token}` },
        });
        const user = GithubUserSchema.safeParse(await response.json().catch(() => undefined));
        if (response.ok && user.success) login = user.data.login;
      } catch {
        /* The login is a label; the connection stands without it. */
      }
      await store.set(GITHUB_PROVIDER_ID, {
        type: "api",
        key: token.access_token,
        metadata: {
          clientId: flow.clientId,
          scopes: scopesOf(token.scope).join(","),
          connectedAt: new Date(polled).toISOString(),
          ...(login === undefined ? {} : { login }),
        },
      });
      return { ok: true, status: "connected", connection: await githubConnection(await options.apps()) };
    },

    async startLinear() {
      const { linear } = await options.apps();
      if (linear.redirectUri === undefined) return { ok: false, error: "unconfigured" };
      const redirectUri = linear.redirectUri;
      let client: { clientId: string; clientSecret?: string };
      if (linear.clientId !== undefined) client = { clientId: linear.clientId };
      else {
        let registration = linearClients.get(redirectUri);
        if (registration === undefined) {
          registration = registerLinearOauthClient(redirectUri, request);
          linearClients.set(redirectUri, registration);
        }
        try {
          client = await registration;
        } catch {
          linearClients.delete(redirectUri);
          return { ok: false, error: "provider_rejected" };
        }
      }
      const started = now();
      prune(linearFlows, started);
      const pkce = generateLinearPkce();
      const state = flowId();
      const expiresAt = started + LINEAR_FLOW_TTL_MS;
      linearFlows.set(state, { verifier: pkce.verifier, redirectUri, client, expiresAt });
      return {
        ok: true,
        flowId: state,
        authorizeUrl: buildLinearAuthorizeUrl({
          clientId: client.clientId,
          challenge: pkce.challenge,
          state,
          redirectUri,
        }),
        redirectUri,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    async connectLinearApp(client) {
      let credential: ProviderCredential;
      try {
        credential = await connectLinearApp(client, request);
      } catch {
        return { ok: false, error: "provider_rejected" };
      }
      await store.set(LINEAR_PROVIDER_ID, credential);
      return { ok: true, connection: await linearConnection(await options.apps()) };
    },

    async completeLinear(state, code) {
      const flow = linearFlows.get(state);
      // One use: a replayed redirect cannot exchange twice.
      linearFlows.delete(state);
      if (flow === undefined) return { ok: false, error: "unknown_flow" };
      if (flow.expiresAt <= now()) return { ok: false, error: "expired" };
      let credential: ProviderCredential;
      try {
        credential = await exchangeLinearAuthorizationCode({
          code,
          redirectUri: flow.redirectUri,
          verifier: flow.verifier,
          clientId: flow.client.clientId,
          ...(flow.client.clientSecret === undefined ? {} : { clientSecret: flow.client.clientSecret }),
          fetchImpl: request,
        });
      } catch {
        return { ok: false, error: "provider_rejected" };
      }
      await store.set(LINEAR_PROVIDER_ID, credential);
      return { ok: true, connection: await linearConnection(await options.apps()) };
    },

    async disconnect(provider) {
      const apps = await options.apps();
      if (provider === "github") {
        const credential = await store.get(GITHUB_PROVIDER_ID);
        const revoked = await revokeGithub(credential, apps);
        await store.delete(GITHUB_PROVIDER_ID);
        const clientId =
          (credential?.type === "api" ? credential.metadata?.clientId : undefined) ?? apps.github.clientId;
        const manageUrl = githubManageUrl(clientId);
        return { ok: true, revoked, ...(revoked || manageUrl === undefined ? {} : { manageUrl }) };
      }
      const credential = await store.get(LINEAR_PROVIDER_ID);
      const revoked = await revokeLinear(credential);
      await store.delete(LINEAR_PROVIDER_ID);
      return { ok: true, revoked, ...(revoked ? {} : { manageUrl: LINEAR_MANAGE_URL }) };
    },
  };
}
