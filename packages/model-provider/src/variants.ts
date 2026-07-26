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

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"];

/** A model-id pattern and the effort ladder that model accepts. */
type EffortLadder = readonly [RegExp, readonly string[]];

/**
 * Matches a family prefix with or without a provider path ("openai/gpt-5-codex")
 * and with or without a size suffix ("gpt-5.6-sol"), without false-matching
 * "gpt-50" or "gpt-5o".
 */
function family(pattern: string): RegExp {
  return new RegExp(`(?:^|/)${pattern}(?:[.-]|$)`);
}

/**
 * OpenAI reasoning ladders, transcribed from each model page's
 * "Reasoning.effort supports:" line. They hold for both OpenAI transports:
 * streamed Codex-backend probes accept the same per-model tiers the API
 * documents (`none` on 5.4/5.5, `max` on 5.6). The Codex client's own `ultra`
 * tier is deliberately absent — the backend rejects it for Clankie's
 * `originator` identity with `invalid_value` on `reasoning.effort`.
 *
 * First match wins: `-pro` models expose a narrower ladder than their base
 * sibling and so are matched first, and newer generations precede the older
 * family fallbacks. Under-offering a tier only hides an option; offering one
 * the model rejects fails the whole request.
 */
const OPENAI_EFFORTS: readonly EffortLadder[] = [
  [family("gpt-5-pro"), ["high"]],
  [family("gpt-5\\.[2-9]-pro"), ["medium", "high", "xhigh"]],
  [family("gpt-5\\.6"), ["none", "low", "medium", "high", "xhigh", "max"]],
  [family("gpt-5\\.[45]"), ["none", "low", "medium", "high", "xhigh"]],
  [family("gpt-5\\.3"), ["low", "medium", "high", "xhigh"]],
  [family("gpt-5\\.2"), ["none", "low", "medium", "high", "xhigh"]],
  [family("gpt-5\\.1-codex-max"), ["low", "medium", "high", "xhigh"]],
  [family("gpt-5\\.1"), ["none", "low", "medium", "high"]],
  [family("gpt-5"), ["minimal", "low", "medium", "high"]],
];

function ladderFor(ladders: readonly EffortLadder[], modelId: string): readonly string[] | undefined {
  return ladders.find(([pattern]) => pattern.test(modelId))?.[1];
}

function effortVariant(effort: string): ModelVariant {
  return { id: effort, body: { reasoning_effort: effort } };
}

/**
 * Generates the reasoning variants a model supports, keyed by provider family:
 *
 * - openai / azure / openai-codex / openai-compatible → the model's documented
 *   `reasoning_effort` ladder (gpt-5.6 reaches `max`, gpt-5.2/5.4/5.5 reach
 *   `xhigh`, gpt-5 still accepts `minimal`), else low/medium/high;
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
    const efforts = ladderFor(OPENAI_EFFORTS, model.id.toLowerCase()) ?? WIDELY_SUPPORTED_EFFORTS;
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
