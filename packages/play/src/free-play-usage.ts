import type { LanguageModelUsage } from "ai";
import { z } from "zod";

/** Provider-reported tokens; null cost means the registry has no usable rates. */
export const FreePlayUsageSchema = z.strictObject({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Includes a 16k reservation for each interrupted/unreported metered call. */
  chargedTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().finite().nullable(),
  unreportedCalls: z.number().int().nonnegative(),
});
export type FreePlayUsage = z.infer<typeof FreePlayUsageSchema>;
export type FreePlayUsageReporter = (usage: FreePlayUsage) => void;
export interface FreePlayPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}
export function emptyFreePlayUsage(): FreePlayUsage {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    chargedTokens: 0,
    estimatedCostUsd: 0,
    unreportedCalls: 0,
  };
}
export function unreportedFreePlayUsage(): FreePlayUsage {
  return {
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    chargedTokens: 16_000,
    estimatedCostUsd: null,
    unreportedCalls: 1,
  };
}
export function pricedFreePlayUsage(usage: LanguageModelUsage, pricing?: FreePlayPricing): FreePlayUsage {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (input === undefined || output === undefined) return unreportedFreePlayUsage();
  const read = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const write = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const ordinary = Math.max(0, input - read - write);
  return {
    calls: 1,
    inputTokens: input,
    outputTokens: output,
    chargedTokens: input + output,
    estimatedCostUsd:
      pricing === undefined
        ? null
        : (ordinary * pricing.input +
            read * (pricing.cacheRead ?? pricing.input) +
            write * (pricing.cacheWrite ?? pricing.input) +
            output * pricing.output) /
          1_000_000,
    unreportedCalls: 0,
  };
}
export function addFreePlayUsage(total: FreePlayUsage, usage: FreePlayUsage): void {
  total.calls += usage.calls;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.chargedTokens += usage.chargedTokens;
  total.unreportedCalls += usage.unreportedCalls;
  total.estimatedCostUsd =
    total.estimatedCostUsd === null || usage.estimatedCostUsd === null
      ? null
      : total.estimatedCostUsd + usage.estimatedCostUsd;
}
