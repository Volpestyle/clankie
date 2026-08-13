export const DEFAULT_RESERVED_TOKENS = 20_000;

export interface CaptainContextBudget {
  readonly context: number;
  readonly reserved: number;
  readonly usable: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

/**
 * Derives the captain's usable prompt budget from authoritative registry
 * limits. A missing/zero output limit is treated as unknown and reserves the
 * conservative default instead of silently reserving nothing.
 */
export function contextBudget(
  contextTokens: number,
  maxOutputTokens: number | undefined,
): CaptainContextBudget {
  const context = positiveInteger(contextTokens, "Context window");
  const output =
    maxOutputTokens === undefined || maxOutputTokens <= 0
      ? DEFAULT_RESERVED_TOKENS
      : positiveInteger(maxOutputTokens, "Maximum output");
  const reserved = Math.min(DEFAULT_RESERVED_TOKENS, output, Math.max(context - 1, 0));
  return {
    context,
    reserved,
    usable: context - reserved,
  };
}

/**
 * Eve compacts when input is strictly greater than its threshold. Subtract one
 * token so integer provider counts trigger exactly when input >= usable.
 */
export function compactionContextWindow(budget: CaptainContextBudget): number {
  return Math.max(1, budget.usable - 1);
}

export function shouldCompact(inputTokens: number, budget: CaptainContextBudget): boolean {
  if (!Number.isFinite(inputTokens) || inputTokens < 0) {
    throw new Error("Input token count must be finite and non-negative");
  }
  return inputTokens >= budget.usable;
}

export function contextPercent(inputTokens: number, budget: CaptainContextBudget): number {
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return 0;
  return Math.min(100, (inputTokens / budget.context) * 100);
}
