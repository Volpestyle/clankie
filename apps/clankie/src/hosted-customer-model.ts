import type { CredentialStore } from "@clankie/credential-broker";
import { createModelRegistry } from "@clankie/model-registry";
import {
  CODEX_PROVIDER_ID,
  loadConfig,
  registerConfiguredPiProviders,
  resolvePiModelSelection,
} from "@clankie/model-provider";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiSeatModel } from "./captain/herdr-watch.ts";
import { BrokerCredentialStore } from "./captain/model.ts";

/** The provider id a hosted pi worker sees for the customer's own model (VUH-1373). */
const CUSTOMER_PI_PROVIDER = "clankie-customer";
const INCLUDED_PROVIDER = "clankie";
const ANTHROPIC_OAUTH_MARKER = "sk-ant-oat";

/** The customer's selected model and its current credential, fresh for one call. */
export interface CustomerModelTarget {
  readonly model: Model<Api>;
  /** The provider's real base URL; the loopback forwards under it and nowhere else. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Extra provider headers pi would send with this credential (models.json/extension headers). */
  readonly headers: Readonly<Record<string, string>>;
}

export interface HostedCustomerModels {
  /** The selected customer model with a credential, or undefined on included usage. */
  resolve(): Promise<CustomerModelTarget | undefined>;
}

/**
 * The customer's own model on a hosted body, resolved through Clankie's own
 * Pi runtime over the body's broker. Every call reads the selection and asks
 * the runtime for the credential, so an OAuth token is refreshed by the broker
 * (one refresher per token, shared with the captain) and a rotated or replaced
 * key is used on the very next call. Included usage (`clankie/…`) or a model
 * without a credential resolves to nothing.
 */
export function createHostedCustomerModels(options: {
  readonly store: CredentialStore;
  readonly env?: NodeJS.ProcessEnv;
}): HostedCustomerModels {
  const registry = createModelRegistry({ env: options.env ?? process.env });
  let runtime: Promise<ModelRuntime> | undefined;
  return {
    async resolve() {
      const { config } = await loadConfig(options.env === undefined ? {} : { env: options.env });
      if (config.model === undefined || config.model.startsWith(`${INCLUDED_PROVIDER}/`)) return undefined;
      const catalog = await registry.catalog();
      runtime ??= ModelRuntime.create({
        credentials: new BrokerCredentialStore(options.store),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const models = await runtime;
      registerConfiguredPiProviders(models, config, catalog);
      let model: Model<Api>;
      try {
        model = resolvePiModelSelection(config, models, {
          catalog,
          hasCodexSubscription: (await options.store.get(CODEX_PROVIDER_ID)) !== undefined,
        }).model;
      } catch {
        return undefined;
      }
      if (model.provider === INCLUDED_PROVIDER) return undefined;
      const resolved = await models.getAuth(model);
      const apiKey = resolved?.auth.apiKey;
      if (apiKey === undefined || apiKey.length === 0) return undefined;
      return {
        model,
        baseUrl: resolved?.auth.baseUrl ?? model.baseUrl,
        apiKey,
        headers: Object.fromEntries(
          Object.entries(resolved?.auth.headers ?? {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      };
    },
  };
}

/** The ChatGPT account a codex subscription token belongs to (an identifier, not a secret). */
function chatgptAccountId(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What pi is given instead of the credential, shaped so pi builds the same
 * request it would with the real one; the loopback swaps in the real
 * credential. None of these is a secret:
 * - codex: an unsigned token carrying only the ChatGPT account id, which pi
 *   reads into `chatgpt-account-id`;
 * - an Anthropic subscription: a marker pi recognizes as OAuth, so it sends
 *   the subscription's request shape;
 * - everything else: a placeholder bearer.
 */
export function customerPlaceholderKey(api: string, apiKey: string): string | undefined {
  if (api === "openai-codex-responses") {
    const account = chatgptAccountId(apiKey);
    if (account === undefined) return undefined;
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } }),
    ).toString("base64");
    return `e30.${claims}.clankie-loopback`;
  }
  if (api === "anthropic-messages" && apiKey.includes(ANTHROPIC_OAUTH_MARKER)) {
    return `${ANTHROPIC_OAUTH_MARKER}-clankie-loopback`;
  }
  return "local";
}

/**
 * The pi provider a hosted worker gets for the customer's model: the same API
 * and model limits, pointed at the body's loopback, with a placeholder key.
 */
export function customerSeatModel(
  target: CustomerModelTarget,
  loopbackBaseUrl: string,
): PiSeatModel | undefined {
  const apiKey = customerPlaceholderKey(target.model.api, target.apiKey);
  if (apiKey === undefined) return undefined;
  const { model } = target;
  return {
    model: `${CUSTOMER_PI_PROVIDER}/${model.id}`,
    provider: {
      id: CUSTOMER_PI_PROVIDER,
      config: {
        baseUrl: loopbackBaseUrl,
        api: model.api,
        apiKey,
        models: [
          {
            id: model.id,
            name: model.name,
            reasoning: model.reasoning,
            input: model.input,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            ...(model.compat === undefined ? {} : { compat: model.compat }),
          },
        ],
      },
    },
  };
}

/** Auth headers each API carries; the loopback removes all of them before adding the real one. */
const AUTH_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "chatgpt-account-id"];

/** The real credential, the way `api` sends it. */
export function customerAuthHeaders(api: string, apiKey: string): Record<string, string> {
  if (api === "anthropic-messages") {
    return apiKey.includes(ANTHROPIC_OAUTH_MARKER)
      ? { authorization: `Bearer ${apiKey}` }
      : { "x-api-key": apiKey };
  }
  if (api === "google-generative-ai") return { "x-goog-api-key": apiKey };
  if (api === "openai-codex-responses") {
    const account = chatgptAccountId(apiKey);
    return {
      authorization: `Bearer ${apiKey}`,
      ...(account === undefined ? {} : { "chatgpt-account-id": account }),
    };
  }
  return { authorization: `Bearer ${apiKey}` };
}

export function isCustomerAuthHeader(name: string): boolean {
  return AUTH_HEADERS.includes(name.toLowerCase());
}

/**
 * The upstream URL for a loopback path, or undefined when it would leave the
 * provider's base: the loopback forwards under the selected provider's base
 * URL only, never to a URL the caller names.
 */
export function customerUpstreamUrl(baseUrl: string, pathAndQuery: string): URL | undefined {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (!pathAndQuery.startsWith("/") || pathAndQuery.startsWith("//")) return undefined;
  const [path = "", query] = pathAndQuery.split("?", 2) as [string, string | undefined];
  if (path.split("/").some((segment) => segment === ".." || segment === "." || /%2e/iu.test(segment))) {
    return undefined;
  }
  const url = new URL(
    `${base.pathname.replace(/\/$/u, "")}${path}${query === undefined ? "" : `?${query}`}`,
    base,
  );
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/u, "")))
    return undefined;
  return url;
}
