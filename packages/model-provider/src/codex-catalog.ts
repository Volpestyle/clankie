import type { Catalog, ModelEntry, ProviderEntry } from "@clankie/model-registry";
import { CODEX_PROVIDER_ID } from "./oauth/openai-codex.ts";

/**
 * The ChatGPT Codex backend is not the public OpenAI model catalog. Keep this
 * list conservative and expand it only after a streamed subscription request
 * is verified — `codex-model-probe-cli.ts` (`pnpm models:codex-probe`) is that
 * check. In particular, models visible to the first-party Codex client can
 * still be unavailable to third-party `originator` identities: the client's
 * `ultra` effort tier is refused on this transport, as is the bare `gpt-5.6`
 * alias, which the backend answers only by size slug.
 */
export const CODEX_SUBSCRIPTION_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;

const VERIFIED_SUBSCRIPTION_MODELS: ReadonlySet<string> = new Set(CODEX_SUBSCRIPTION_MODEL_IDS);

/**
 * API-only ids the subscription still serves under a different slug. The bare
 * `gpt-5.6` alias routes to Sol on the API transport, so a ref naming it means
 * Sol on either transport even though the backend answers only by size slug.
 */
const SUBSCRIPTION_ALIASES: Readonly<Record<string, string>> = { "gpt-5.6": "gpt-5.6-sol" };

/**
 * The subscription slug serving `modelId`, or undefined when the Codex backend
 * cannot serve that model at all.
 */
export function codexSubscriptionModelIdFor(modelId: string): string | undefined {
  if (VERIFIED_SUBSCRIPTION_MODELS.has(modelId)) return modelId;
  return SUBSCRIPTION_ALIASES[modelId];
}

/**
 * Every backend model shares one window regardless of the larger API-key
 * window models.dev reports for the same id, so the subscription entry states
 * the backend's own limit rather than inheriting a number the transport will
 * not honor.
 */
const SUBSCRIPTION_LIMIT = { context: 400_000, input: 272_000, output: 128_000 };

function supportsCodexSubscription(model: ModelEntry): boolean {
  return VERIFIED_SUBSCRIPTION_MODELS.has(model.id);
}

function subscriptionModel(model: ModelEntry): ModelEntry {
  return {
    ...model,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { ...model.limit, ...SUBSCRIPTION_LIMIT },
  };
}

/**
 * Adds an explicit ChatGPT-subscription provider beside the OpenAI API-key
 * provider. Only models verified against streamed Codex-backend requests are
 * exposed. The two provider identities never borrow credentials.
 */
export function withCodexSubscriptionProvider(catalog: Catalog): Catalog {
  if (catalog[CODEX_PROVIDER_ID] !== undefined) return catalog;
  const openai = catalog.openai;
  if (openai === undefined) return catalog;
  const models = Object.fromEntries(
    Object.entries(openai.models)
      .filter(([, model]) => supportsCodexSubscription(model))
      .map(([id, model]) => [id, subscriptionModel(model)]),
  );
  const provider: ProviderEntry = {
    ...openai,
    id: CODEX_PROVIDER_ID,
    name: "OpenAI · ChatGPT subscription",
    env: [],
    models,
  };
  return { ...catalog, [CODEX_PROVIDER_ID]: provider };
}
