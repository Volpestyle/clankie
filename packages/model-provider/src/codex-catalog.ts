import type { Catalog, ModelEntry, ProviderEntry } from "@clankie/model-registry";
import { CODEX_PROVIDER_ID } from "./oauth/openai-codex.ts";

/**
 * The ChatGPT Codex backend is not the public OpenAI model catalog. Keep this
 * list conservative and expand it only after a streamed subscription request
 * is verified. In particular, models visible to the first-party Codex client
 * can still be unavailable to third-party `originator` identities.
 */
const VERIFIED_SUBSCRIPTION_MODELS = new Set(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);

function supportsCodexSubscription(model: ModelEntry): boolean {
  return VERIFIED_SUBSCRIPTION_MODELS.has(model.id);
}

function subscriptionModel(model: ModelEntry): ModelEntry {
  return {
    ...model,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    ...(model.id.includes("gpt-5.5")
      ? { limit: { ...model.limit, context: 400_000, input: 272_000, output: 128_000 } }
      : {}),
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
