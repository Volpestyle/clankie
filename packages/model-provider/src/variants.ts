import type { ModelEntry } from "@clankie/model-registry";

/**
 * A reasoning-effort preset for a model. `body` holds provider wire-format
 * request fields (snake_case for OpenAI-style APIs, e.g. `reasoning_effort`,
 * `thinking.budget_tokens`). Lowering to the AI SDK's camelCase
 * `providerOptions` happens at generate time via `variantProviderOptions`
 * in instantiate.ts — variants themselves stay transport-agnostic data.
 */
export type ModelVariant = {
  id: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
};

const OPENAI_FAMILY_PROVIDERS = new Set(["openai", "openai-codex", "azure", "openai-compatible"]);

/**
 * Matches gpt-5 family ids ("gpt-5", "gpt-5-nano", "gpt-5.2", "openai/gpt-5-codex")
 * without false-matching "gpt-50" or "gpt-5o". Most of the gpt-5 family
 * additionally accepts `minimal`; GPT-5.5 explicitly does not.
 */
const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/;
const GPT55_FAMILY_RE = /(?:^|\/)gpt-5\.5(?:[.-]|$)/;

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"];

function effortVariant(effort: string): ModelVariant {
  return { id: effort, body: { reasoning_effort: effort } };
}

/**
 * Generates the reasoning variants a model supports, keyed by provider family:
 *
 * - openai / azure / openai-codex / openai-compatible → `reasoning_effort`
 *   tiers low/medium/high, plus `minimal` for the gpt-5 family;
 * - anthropic → extended-thinking token budgets (think-8k / think-16k / think-32k);
 * - xai → `reasoning_effort` low/high (grok reasoning control);
 * - google → `thinkingConfig` token budgets (think-8k / think-16k / think-24k);
 * - any other reasoning-capable provider → `reasoning_effort` low/medium/high.
 *
 * Non-reasoning models have no variants.
 */
export function effortVariantsFor(providerId: string, model: ModelEntry): ModelVariant[] {
  if (!model.reasoning) return [];
  const provider = providerId.toLowerCase();

  if (OPENAI_FAMILY_PROVIDERS.has(provider)) {
    const modelId = model.id.toLowerCase();
    const efforts =
      GPT5_FAMILY_RE.test(modelId) && !GPT55_FAMILY_RE.test(modelId)
        ? ["minimal", ...WIDELY_SUPPORTED_EFFORTS]
        : WIDELY_SUPPORTED_EFFORTS;
    return efforts.map(effortVariant);
  }

  if (provider === "anthropic") {
    return (
      [
        ["think-8k", 8_000],
        ["think-16k", 16_000],
        ["think-32k", 32_000],
      ] as const
    ).map(([id, budget]) => ({
      id,
      body: { thinking: { type: "enabled", budget_tokens: budget } },
    }));
  }

  if (provider === "xai") {
    return ["low", "high"].map(effortVariant);
  }

  if (provider === "google") {
    return (
      [
        ["think-8k", 8_192],
        ["think-16k", 16_384],
        ["think-24k", 24_576],
      ] as const
    ).map(([id, budget]) => ({
      id,
      body: { thinkingConfig: { includeThoughts: true, thinkingBudget: budget } },
    }));
  }

  return WIDELY_SUPPORTED_EFFORTS.map(effortVariant);
}

export function variantById(variants: readonly ModelVariant[], id: string): ModelVariant | undefined {
  return variants.find((variant) => variant.id === id);
}
