export type ProviderFamily = "anthropic" | "openai" | "google" | "xai" | "openai-compatible";

/**
 * Picks the AI SDK factory family for a provider. An explicit `baseURL` or an
 * `npm` of "@ai-sdk/openai-compatible" always routes through the generic
 * OpenAI-compatible factory (a custom endpoint is by convention OAI-shaped);
 * otherwise the provider id / npm package selects the native factory, and
 * anything unrecognized falls back to OpenAI-compatible.
 */
export function providerFamilyFor(
  provider: { id: string; npm?: string | undefined },
  baseURL?: string,
): ProviderFamily {
  if (provider.npm === "@ai-sdk/openai-compatible" || baseURL !== undefined) return "openai-compatible";
  if (provider.id === "anthropic" || provider.npm === "@ai-sdk/anthropic") return "anthropic";
  if (provider.id === "openai" || provider.id === "openai-codex" || provider.npm === "@ai-sdk/openai") {
    return "openai";
  }
  if (provider.id === "google" || provider.npm === "@ai-sdk/google") return "google";
  if (provider.id === "xai" || provider.npm === "@ai-sdk/xai") return "xai";
  return "openai-compatible";
}
