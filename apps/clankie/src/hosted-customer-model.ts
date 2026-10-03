import type { CredentialStore } from "@clankie/credential-broker";
import { createModelRegistry } from "@clankie/model-registry";
import {
  assertModelCredentialAllowed,
  ModelSubscriptionPolicyError,
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
        credentials: new BrokerCredentialStore(options.store, {
          hosted: true,
          ...(options.env ? { env: options.env } : {}),
        }),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const models = await runtime;
      registerConfiguredPiProviders(models, config, catalog);
      let model: Model<Api>;
      try {
        model = resolvePiModelSelection(config, models, {
          catalog,
          hasCodexSubscription: false,
        }).model;
      } catch {
        return undefined;
      }
      if (model.provider === INCLUDED_PROVIDER) return undefined;
      if (model.api === "openai-codex-responses")
        throw new ModelSubscriptionPolicyError("hosted_chatgpt_approval_required");
      assertModelCredentialAllowed(model.provider, await options.store.get(model.provider), { hosted: true });
      const resolved = await models.getAuth(model);
      const apiKey = resolved?.auth.apiKey;
      if (apiKey === undefined || apiKey.length === 0) return undefined;
      if (model.api === "anthropic-messages")
        assertModelCredentialAllowed("anthropic", { type: "api", key: apiKey }, { hosted: true });
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

/** Workers receive a placeholder; Claude/ChatGPT subscription routes are unavailable. */
export function customerPlaceholderKey(api: string, apiKey: string): string | undefined {
  if (api === "openai-codex-responses" || (api === "anthropic-messages" && apiKey.startsWith("sk-ant-oat")))
    return undefined;
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
  if (api === "openai-codex-responses")
    throw new ModelSubscriptionPolicyError("hosted_chatgpt_approval_required");
  if (api === "anthropic-messages") {
    assertModelCredentialAllowed("anthropic", { type: "api", key: apiKey }, { hosted: true });
    return { "x-api-key": apiKey };
  }
  if (api === "google-generative-ai") return { "x-goog-api-key": apiKey };
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
