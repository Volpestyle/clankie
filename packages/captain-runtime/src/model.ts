import {
  CaptainAdmissionController,
  CaptainProviderPressureError,
  type CaptainAdmissionRequest,
} from "./admission.ts";

export interface AdmittedLanguageModelOptions extends Omit<CaptainAdmissionRequest, "requestId"> {
  readonly requestId: string;
  readonly admission: CaptainAdmissionController;
  readonly isProviderPressure?: (error: unknown) => boolean;
}

/**
 * Wraps an AI-SDK-shaped model without importing provider types. `doStream`
 * holds its permit until the returned stream closes, errors, or is cancelled.
 */
export function createAdmittedLanguageModel<T extends object>(
  model: T,
  options: AdmittedLanguageModelOptions,
): T {
  let callSequence = 0;
  return new Proxy(model, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      if (property !== "doGenerate" && property !== "doStream") return original;
      if (typeof original !== "function") return original;
      return async (callOptions: unknown) => {
        const request = {
          requestId: `${options.requestId}:${String(callSequence++)}`,
          laneKey: options.laneKey,
          lane: options.lane,
        } as const;
        if (property === "doGenerate") {
          return options.admission.execute(request, async (signal) => {
            try {
              return await Reflect.apply(original, target, [withAbortSignal(callOptions, signal)]);
            } catch (error) {
              throw providerError(error, options.isProviderPressure);
            }
          });
        }

        const lease = await options.admission.acquire(request);
        try {
          const result = (await Reflect.apply(original, target, [
            withAbortSignal(callOptions, lease.signal),
          ])) as unknown;
          if (!hasReadableStream(result)) {
            lease.release("stream_response_missing");
            return result;
          }
          return {
            ...result,
            stream: releaseWithStream(result.stream, {
              release: lease.release,
              park: lease.park,
              ...(options.isProviderPressure === undefined
                ? {}
                : { isProviderPressure: options.isProviderPressure }),
            }),
          };
        } catch (error) {
          const normalized = providerError(error, options.isProviderPressure);
          if (normalized instanceof CaptainProviderPressureError) lease.park(normalized.message);
          lease.release();
          throw normalized;
        }
      };
    },
  });
}

function withAbortSignal(input: unknown, admissionSignal: AbortSignal): unknown {
  if (input === null || typeof input !== "object") return input;
  const record = input as Record<string, unknown>;
  const callerSignal = record.abortSignal;
  const signal =
    callerSignal instanceof AbortSignal ? AbortSignal.any([callerSignal, admissionSignal]) : admissionSignal;
  return { ...record, abortSignal: signal };
}

function hasReadableStream(value: unknown): value is { readonly stream: ReadableStream<unknown> } {
  return (
    value !== null &&
    typeof value === "object" &&
    "stream" in value &&
    (value as { stream?: unknown }).stream instanceof ReadableStream
  );
}

function releaseWithStream<T>(
  source: ReadableStream<T>,
  lifecycle: {
    readonly release: (reason?: string) => void;
    readonly park: (reason: string) => void;
    readonly isProviderPressure?: (error: unknown) => boolean;
  },
): ReadableStream<T> {
  const reader = source.getReader();
  let finished = false;
  const finish = (error?: unknown): void => {
    if (finished) return;
    finished = true;
    if (error !== undefined && lifecycle.isProviderPressure?.(error) === true) {
      lifecycle.park("provider_pressure_stream");
    }
    lifecycle.release();
  };
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        finish(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
}

function providerError(error: unknown, predicate: ((error: unknown) => boolean) | undefined): unknown {
  if (error instanceof CaptainProviderPressureError || predicate?.(error) !== true) return error;
  return new CaptainProviderPressureError(error instanceof Error ? error.message : "Provider pressure");
}
