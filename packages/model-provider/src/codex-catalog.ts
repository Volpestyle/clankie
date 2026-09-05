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
 *
 * The list shrinks on the same evidence it grows on. `gpt-5.4` was dropped
 * 2026-09-04 after the probe refused it at every effort with "The 'gpt-5.4'
 * model is not supported when using Codex with a ChatGPT account"; an entry the
 * backend will not serve only redirects an `openai/…` ref away from the metered
 * key that still serves it.
 */
export const CODEX_SUBSCRIPTION_MODEL_IDS = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
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
 * Every backend model shares one window regardless of the API-key window
 * models.dev reports for the same id, so the subscription entry states the
 * transport's own limit rather than inheriting a number it will not honor.
 *
 * This figure is a floor, not a measured ceiling: probed 2026-09-04, the
 * backend accepted a 900,051-token input for both `gpt-6-astra` (API window
 * 1,050,000) and `gpt-5.6-terra` (API window 272,000) without complaint, which
 * says the two share one transport limit above this number but not that either
 * attended to all of it. Raising it wants its own measurement of effective
 * attention, since every subscription model's context management reads it.
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
