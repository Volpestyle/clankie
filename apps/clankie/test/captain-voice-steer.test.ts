import { describe, expect, it, vi } from "vitest";
import {
  DISCORD_TEXT_TURN_HARD_TIMEOUT_MS,
  runDurableTurn,
  runOneShotDiscordTurn,
} from "../src/captain/captain.ts";

/**
 * The durable-lane dispatch (ADR 0091): an idle lane runs, a streaming lane
 * absorbs the message as a pi steer, and the accepted-but-not-yet-streaming
 * window waits and re-decides. The stub mirrors the pi contract the dispatch
 * leans on: prompt() while streaming with streamingBehavior "steer" queues and
 * returns immediately; a started run stays "streaming" until it settles.
 */
class StubSession {
  public isStreaming = false;
  public readonly calls: { text: string; behavior: string | undefined }[] = [];
  private readonly runs: { resolve: () => void; reject: (error: Error) => void }[] = [];

  public prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void> {
    this.calls.push({ text, behavior: options?.streamingBehavior });
    if (this.isStreaming && options?.streamingBehavior === "steer") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.runs.push({
        resolve: () => {
          this.isStreaming = false;
          resolve();
        },
        reject: (error) => {
          this.isStreaming = false;
          reject(error);
        },
      });
    });
  }

  /** pi flips isStreaming after prompt() is accepted, not inside the call. */
  public startStreaming(): void {
    this.isStreaming = true;
  }

  public settleRun(): void {
    this.runs.shift()?.resolve();
  }

  public failRun(error: Error): void {
    this.runs.shift()?.reject(error);
  }
}

function makeLane(session: StubSession): Parameters<typeof runDurableTurn>[0] {
  return { session, capture: {}, running: undefined };
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("runDurableTurn", () => {
  it("steers a message into a live run and reports it absorbed after the run settles", async () => {
    const session = new StubSession();
    const lane = makeLane(session);

    const first = runDurableTurn(lane, "first", []);
    session.startStreaming();
    const second = runDurableTurn(lane, "second", []);
    await drain();

    expect(session.calls).toEqual([
      { text: "first", behavior: undefined },
      { text: "second", behavior: "steer" },
    ]);

    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await drain();
    expect(secondSettled).toBe(false);

    session.settleRun();
    await expect(first).resolves.toBe("ran");
    await expect(second).resolves.toBe("absorbed");
  });

  it("waits out a run that has not started streaming yet, then runs its own turn", async () => {
    const session = new StubSession();
    const lane = makeLane(session);

    const first = runDurableTurn(lane, "first", []);
    const second = runDurableTurn(lane, "second", []);
    await drain();

    expect(session.calls).toHaveLength(1);
    session.settleRun();
    await expect(first).resolves.toBe("ran");
    await drain();

    expect(session.calls).toEqual([
      { text: "first", behavior: undefined },
      { text: "second", behavior: undefined },
    ]);
    session.settleRun();
    await expect(second).resolves.toBe("ran");
  });

  it("fails a steered turn when the run it joined fails", async () => {
    const session = new StubSession();
    const lane = makeLane(session);

    const first = runDurableTurn(lane, "first", []);
    session.startStreaming();
    const second = runDurableTurn(lane, "second", []);
    await drain();

    session.failRun(new Error("model unavailable"));
    await expect(first).rejects.toThrow("model unavailable");
    await expect(second).rejects.toThrow("steered into failed");
  });

  it("resets captured media only when starting a run, never when steering", async () => {
    const session = new StubSession();
    const lane = makeLane(session);
    lane.capture.media = { artifactRef: "generated/old", filename: "old.png" };

    const first = runDurableTurn(lane, "first", []);
    expect(lane.capture.media).toBeUndefined();

    session.startStreaming();
    lane.capture.media = { artifactRef: "generated/fresh", filename: "fresh.png" };
    const second = runDurableTurn(lane, "second", []);
    await drain();
    expect(lane.capture.media).toEqual({ artifactRef: "generated/fresh", filename: "fresh.png" });

    session.settleRun();
    await expect(first).resolves.toBe("ran");
    await expect(second).resolves.toBe("absorbed");
  });
});

describe("runOneShotDiscordTurn", () => {
  it("allows tool-using Discord text runs beyond the typing window, then enforces the hard deadline", async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn(() => Promise.resolve());
      const run = runOneShotDiscordTurn(
        { abort, prompt: () => new Promise<void>(() => undefined) },
        "hello",
        [],
      );

      await vi.advanceTimersByTimeAsync(60_000);
      expect(abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DISCORD_TEXT_TURN_HARD_TIMEOUT_MS - 60_000);

      await expect(run).resolves.toBe(false);
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
