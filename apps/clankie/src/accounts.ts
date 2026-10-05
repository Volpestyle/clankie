import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  connectLinearApp,
  LINEAR_OAUTH_ISSUER,
  LINEAR_PROVIDER_ID,
  LINEAR_API_PROVIDER_ID,
  buildLinearApiAuthorizeUrl,
  exchangeLinearApiAuthorizationCode,
  revokeLinearApiOauth,
  generateLinearPkce,
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
  pollGithub(flowId: string, guard?: () => Promise<void>): Promise<AccountGithubPollResult>;
  startLinear(): Promise<AccountLinearStartResult>;
  completeLinear(
    state: string,
    code: string,
    guard?: () => Promise<void>,
  ): Promise<AccountLinearCompleteResult>;
  connectLinearApp(
    client: { clientId: string; clientSecret: string },
    guard?: () => Promise<void>,
  ): Promise<AccountLinearCompleteResult>;
  disconnect(provider: AccountProvider, guard?: () => Promise<void>): Promise<AccountDisconnectResult>;
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
  expires_in: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60),
  interval: z.number().int().positive().optional(),
});

const DeviceTokenSchema = z.union([
  z.object({ access_token: z.string().min(1).max(65536), scope: z.string().max(8192).optional() }),
  z.object({ error: z.string(), interval: z.number().int().positive().optional() }),
]);

const GithubUserSchema = z.object({
  login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u),
});

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

  const call = (url: string, init: RequestInit) =>
    request(url, { ...init, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

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
    const credential = (await store.get(LINEAR_API_PROVIDER_ID)) ?? (await store.get(LINEAR_PROVIDER_ID));
    if (credential === undefined || credential.type === "wellknown")
      return {
        provider: "linear",
        status:
          apps.linear.clientId === undefined || apps.linear.redirectUri === undefined
            ? "unconfigured"
            : "not_connected",
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
      scopes: credential.type === "oauth" ? scopesOf(credential.metadata?.scopes) : [],
      ...(account === undefined ? {} : { connectedAt: account.verifiedAt }),
      manageUrl: account?.actor === "app" ? "https://linear.app/settings/api" : LINEAR_MANAGE_URL,
    };
  };

  const revokeGithub = async (
    credential: ProviderCredential | undefined,
    apps: OauthApps,
    secret: ProviderCredential | undefined,
  ) => {
    if (credential?.type !== "api") return false;
    const clientId = credential.metadata?.clientId ?? apps.github.clientId;
    if (
      clientId === undefined ||
      secret?.type !== "api" ||
      (secret.metadata?.clientId !== undefined && secret.metadata.clientId !== clientId)
    )
      return false;
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
      // Missing/invalid app secrets, validation and rate limits are not revocation proof.
      return response.status === 204;
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

  const service: AccountsPort = {
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

    async pollGithub(id, guard) {
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
        if (!response.ok || !body.success) return { ok: false, error: "unavailable" };
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
        if (response.ok && user.success && !user.data.login.includes(token.access_token))
          login = user.data.login;
      } catch {
        /* The login is a label; the connection stands without it. */
      }
      await guard?.();
      await store.set(GITHUB_PROVIDER_ID, {
        type: "api",
        key: token.access_token,
        metadata: {
          clientId: flow.clientId,
          scopes: scopesOf(token.scope)
            .filter((scope) => !scope.includes(token.access_token))
            .join(","),
          connectedAt: new Date(polled).toISOString(),
          ...(login === undefined ? {} : { login }),
        },
      });
      return { ok: true, status: "connected", connection: await githubConnection(await options.apps()) };
    },

    async startLinear() {
      const { linear } = await options.apps();
      if (linear.redirectUri === undefined || linear.clientId === undefined)
        return { ok: false, error: "unconfigured" };
      const redirectUri = linear.redirectUri;
      const redirect = new URL(redirectUri);
      if (
        redirect.protocol !== "https:" ||
        redirect.username ||
        redirect.password ||
        redirect.hash ||
        redirect.search
      )
        return { ok: false, error: "unconfigured" };
      const client = { clientId: linear.clientId };
      const started = now();
      prune(linearFlows, started);
      const pkce = generateLinearPkce();
      const state = flowId();
      const expiresAt = started + LINEAR_FLOW_TTL_MS;
      linearFlows.set(state, { verifier: pkce.verifier, redirectUri, client, expiresAt });
      return {
        ok: true,
        flowId: state,
        authorizeUrl: buildLinearApiAuthorizeUrl({
          clientId: client.clientId,
          challenge: pkce.challenge,
          state,
          redirectUri,
        }),
        redirectUri,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    async connectLinearApp(client, guard) {
      let credential: ProviderCredential;
      try {
        credential = await connectLinearApp(client, request);
      } catch {
        return { ok: false, error: "provider_rejected" };
      }
      await guard?.();
      await store.set(LINEAR_PROVIDER_ID, credential);
      return { ok: true, connection: await linearConnection(await options.apps()) };
    },

    async completeLinear(state, code, guard) {
      const flow = linearFlows.get(state);
      // One use: a replayed redirect cannot exchange twice.
      linearFlows.delete(state);
      if (flow === undefined) return { ok: false, error: "unknown_flow" };
      if (flow.expiresAt <= now()) return { ok: false, error: "expired" };
      const configured = (await options.apps()).linear;
      if (configured.clientId !== flow.client.clientId || configured.redirectUri !== flow.redirectUri)
        return { ok: false, error: "unknown_flow" };
      let credential: ProviderCredential;
      try {
        credential = await exchangeLinearApiAuthorizationCode({
          code,
          redirectUri: flow.redirectUri,
          verifier: flow.verifier,
          clientId: flow.client.clientId,
          fetchImpl: request,
        });
      } catch {
        return { ok: false, error: "provider_rejected" };
      }
      await guard?.();
      await store.set(LINEAR_API_PROVIDER_ID, credential);
      return { ok: true, connection: await linearConnection(await options.apps()) };
    },

    async disconnect(provider, guard) {
      const apps = await options.apps();
      if (provider === "github") {
        githubFlows.clear();
        await guard?.();
        let credential = await store.get(GITHUB_PROVIDER_ID);
        const secret = await store.get(GITHUB_OAUTH_APP_PROVIDER_ID);
        let revoked = false;
        await store.delete(GITHUB_PROVIDER_ID, async (current) => {
          credential = current;
          await guard?.();
          revoked = await revokeGithub(current, apps, secret);
          await guard?.();
        });
        const clientId =
          (credential?.type === "api" ? credential.metadata?.clientId : undefined) ?? apps.github.clientId;
        const manageUrl = githubManageUrl(clientId);
        return { ok: true, revoked, ...(revoked || manageUrl === undefined ? {} : { manageUrl }) };
      }
      linearFlows.clear();
      await guard?.();
      const revocations: boolean[] = [];
      let hadCredential = false;
      for (const [id, revoke] of [
        [LINEAR_API_PROVIDER_ID, (current: ProviderCredential) => revokeLinearApiOauth(current, request)],
        [LINEAR_PROVIDER_ID, revokeLinear],
      ] as const) {
        let revoked = false;
        let invoked = false;
        const deleted = await store.delete(id, async (current) => {
          invoked = true;
          await guard?.();
          revoked = await revoke(current);
          await guard?.();
        });
        hadCredential ||= invoked;
        revocations.push(invoked ? revoked : !deleted);
      }
      const revoked = hadCredential && revocations.every(Boolean);
      return { ok: true, revoked, ...(revoked ? {} : { manageUrl: LINEAR_MANAGE_URL }) };
    },
  };
  // A disconnect completes after admitted exchanges, clears all older flows,
  // and cannot be undone by a poll/code exchange already in this body.
  const pending = new Map<AccountProvider, Promise<unknown>>();
  const serialize = <T>(provider: AccountProvider, operation: () => Promise<T>): Promise<T> => {
    const next = (pending.get(provider) ?? Promise.resolve()).then(operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    pending.set(provider, settled);
    void settled.finally(() => {
      if (pending.get(provider) === settled) pending.delete(provider);
    });
    return next;
  };
  return {
    list: () => service.list(),
    startGithub: () => serialize("github", () => service.startGithub()),
    pollGithub: (id, guard) => serialize("github", () => service.pollGithub(id, guard)),
    startLinear: () => serialize("linear", () => service.startLinear()),
    completeLinear: (state, code, guard) =>
      serialize("linear", () => service.completeLinear(state, code, guard)),
    connectLinearApp: (client, guard) => serialize("linear", () => service.connectLinearApp(client, guard)),
    disconnect: (provider, guard) => serialize(provider, () => service.disconnect(provider, guard)),
  };
}
