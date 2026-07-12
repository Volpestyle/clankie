export interface CaptainTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: {
    readonly read: number;
    readonly write: number;
  };
}

export const ZERO_TOKEN_USAGE: CaptainTokenUsage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Normalizes Eve's provider-reported usage. reasoningTokens is accepted
 * additively when Eve exposes it; Eve 0.22.4 omits it, so the separate field
 * remains zero rather than being guessed from output.
 */
export function normalizeTokenUsage(value: unknown): CaptainTokenUsage {
  const usage = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const cache =
    usage.cache !== null && typeof usage.cache === "object" ? (usage.cache as Record<string, unknown>) : {};
  return {
    input: tokenCount(usage.inputTokens ?? usage.input),
    output: tokenCount(usage.outputTokens ?? usage.output),
    reasoning: tokenCount(usage.reasoningTokens ?? usage.reasoning),
    cache: {
      read: tokenCount(usage.cacheReadTokens ?? cache.read),
      write: tokenCount(usage.cacheWriteTokens ?? cache.write),
    },
  };
}

export function addTokenUsage(left: CaptainTokenUsage, right: CaptainTokenUsage): CaptainTokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cache: {
      read: left.cache.read + right.cache.read,
      write: left.cache.write + right.cache.write,
    },
  };
}
