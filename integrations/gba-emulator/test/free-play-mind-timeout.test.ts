import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";

const streamObject = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ streamObject }));

import { createModelFreePlayMind } from "../src/free-play-mind.ts";
import type { FreePlayView } from "../src/free-play.ts";

describe("model free-play request deadline", () => {
  it("aborts a provider stream that never settles", async () => {
    streamObject.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      const signal = options.abortSignal!;
      const failure = new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return {
        object: failure,
        partialObjectStream: {
          async *[Symbol.asyncIterator]() {
            await failure;
            yield undefined;
          },
        },
      };
    });
    const mind = createModelFreePlayMind({
      model: {} as LanguageModel,
      requestTimeoutMs: 10,
      maxRetries: 0,
    });

    await expect(mind.decide(emptyView())).rejects.toThrow();
    expect(streamObject).toHaveBeenCalledOnce();
    expect(streamObject.mock.calls[0]?.[0].abortSignal.aborted).toBe(true);
  });

  it("rejects an invalid deadline before issuing a model call", async () => {
    const mind = createModelFreePlayMind({ model: {} as LanguageModel, requestTimeoutMs: 0 });
    await expect(mind.decide(emptyView())).rejects.toThrow(/free_play_model_request_timeout_invalid/u);
  });
});

function emptyView(): FreePlayView {
  return {
    turn: 0,
    observations: [],
    framePng: null,
    refusedHere: [],
    stalledForTurns: null,
    notes: null,
    objective: null,
    interjection: null,
    turnsSinceSpoke: null,
    audience: null,
    history: [],
  };
}
