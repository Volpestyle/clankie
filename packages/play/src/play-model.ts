import { streamObject, type LanguageModel } from "ai";
import type { z } from "zod";
import {
  pricedFreePlayUsage,
  unreportedFreePlayUsage,
  type FreePlayPricing,
  type FreePlayUsageReporter,
} from "./free-play-usage.ts";

export type PlayProviderOptions = NonNullable<Parameters<typeof streamObject>[0]["providerOptions"]>;

/** One streamed, bounded model request; games supply their prompt and wire schema. */
export function createModelPlayMind<View, Wire>(options: {
  model: LanguageModel;
  schema: z.ZodType<Wire>;
  system: string;
  render(view: View): string | { text: string; framePng?: Uint8Array | null };
  maxOutputTokens?: (view: View) => number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  pricing?: FreePlayPricing;
  providerOptions?: PlayProviderOptions;
}) {
  return {
    async decide(view: View, signal?: AbortSignal, onUsage?: FreePlayUsageReporter) {
      const timeout = options.requestTimeoutMs ?? 60_000;
      if (!Number.isSafeInteger(timeout) || timeout <= 0)
        throw new RangeError("free_play_model_request_timeout_invalid");
      const deadline = AbortSignal.timeout(timeout);
      const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
      const prompt = options.render(view);
      let usage = unreportedFreePlayUsage();
      let rejectStream!: (reason: unknown) => void;
      const failure = new Promise<never>((_, reject) => {
        rejectStream = reject;
      });
      failure.catch(() => {});
      const stream = streamObject({
        model: options.model,
        schema: options.schema,
        instructions: {
          role: "system",
          content: options.system,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
        messages: [
          {
            role: "user",
            content:
              typeof prompt === "string"
                ? prompt
                : [
                    { type: "text", text: prompt.text },
                    ...(prompt.framePng
                      ? [{ type: "file" as const, mediaType: "image/png", data: prompt.framePng }]
                      : []),
                  ],
          },
        ],
        ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens(view) } : {}),
        maxRetries: options.maxRetries ?? 0,
        abortSignal: requestSignal,
        providerOptions: options.providerOptions ?? {},
        onError: ({ error }) => rejectStream(error),
        onFinish: (event) => {
          usage = pricedFreePlayUsage(event.usage, options.pricing);
          onUsage?.(usage);
        },
      });
      // Consume the stream to start subscription-provider requests. Keep the
      // drain inside the same deadline as the final object, even if a provider
      // ignores cancellation or returns an error part without settling it.
      const drain = (async () => {
        try {
          for await (const _partial of stream.partialObjectStream) {
          }
        } catch (error) {
          rejectStream(error);
        }
      })();
      const settled = Promise.race([Promise.all([stream.object, drain]).then(([answer]) => answer), failure]);
      settled.catch(() => {});
      const decision = await withPlayAbort(
        settled,
        requestSignal,
        () => new Error("free_play_model_request_deadline_exceeded", { cause: requestSignal.reason }),
      );
      return { decision, usage };
    },
  };
}

export function withPlayAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  error = () => signal.reason,
): Promise<T> {
  if (signal.aborted) return Promise.reject(error());
  return new Promise((resolve, reject) => {
    const abort = () => reject(error());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
  });
}
