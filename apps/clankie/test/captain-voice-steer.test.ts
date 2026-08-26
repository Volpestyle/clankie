import { describe, expect, it, vi } from "vitest";
import {
  DISCORD_TURN_STALL_MS,
  runDurableTurn,
  runOneShotDiscordTurn,
  runTurnWithStallWatchdog,
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

  it("waits on a preparing lane instead of starting a second prompt", async () => {
    const session = new StubSession();
    const lane = makeLane(session);
    let release!: () => void;
    lane.starting = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = runDurableTurn(lane, "first", []);
    const second = runDurableTurn(lane, "second", []);
    await drain();
    expect(session.calls).toHaveLength(0);

    release();
    lane.starting = undefined;
    await drain();
    expect(session.calls).toEqual([{ text: "first", behavior: undefined }]);
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
  it("declares a turn dead only after it has gone silent inside, never for being slow", async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn(() => Promise.resolve());
      const run = runOneShotDiscordTurn(
        { abort, prompt: () => new Promise<void>(() => undefined), subscribe: () => () => undefined },
        "hello",
        [],
      );

      // Long is not the same as dead: nothing is cut off at a tidy number.
      await vi.advanceTimersByTimeAsync(DISCORD_TURN_STALL_MS - 1_000);
      expect(abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(STALL_TICK);
      await expect(run).resolves.toBe(false);
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

const STALL_TICK = 5_000;

describe("runTurnWithStallWatchdog", () => {
  it("carries a completed value through", async () => {
    const outcome = await runTurnWithStallWatchdog(
      { abort: () => Promise.resolve(), subscribe: () => () => undefined },
      () => Promise.resolve("absorbed" as const),
    );
    expect(outcome).toEqual({ completed: true, value: "absorbed" });
  });

  /**
   * The bracket case: 23 browser calls over nine minutes, answering a question
   * the room actually asked. Work is not a wedge, and a turn that keeps
   * emitting signs of life must be allowed to run past any fixed clock.
   */
  it("lets a turn run indefinitely while it keeps showing signs of life", async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn(() => Promise.resolve());
      let emit: (() => void) | undefined;
      let finish: (() => void) | undefined;
      const outcome = runTurnWithStallWatchdog(
        {
          abort,
          subscribe: (listener) => {
            emit = () => listener({ type: "agent_settled" } as never);
            return () => undefined;
          },
        },
        () => new Promise<void>((resolve) => (finish = resolve)),
      );

      // Nine minutes of steady work, well past any whole-turn deadline.
      for (let minute = 0; minute < 9; minute += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        emit?.();
      }
      expect(abort).not.toHaveBeenCalled();

      finish?.();
      await expect(outcome).resolves.toMatchObject({ completed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The turn that provoked this: a host suspend held one `setTimeout` past its
   * delay and a ten-minute backstop fired twenty-two minutes late, so the room
   * waited on an answer nothing was going to produce. Ticking against a clock
   * that jumped forward has to fire on the next tick, not on the delay the
   * timer still believes it owes.
   */
  it("fires on the next tick after a suspended host jumps the clock past the stall window", async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      const abort = vi.fn(() => Promise.resolve());
      const outcome = runTurnWithStallWatchdog(
        { abort, subscribe: () => () => undefined },
        () => new Promise<void>(() => undefined),
        { stallMs: 180_000, now: () => now },
      );

      await vi.advanceTimersByTimeAsync(STALL_TICK);
      now += STALL_TICK;
      expect(abort).not.toHaveBeenCalled();

      // The host slept: wall clock leaps an hour while timers stood still.
      now += 60 * 60_000;
      await vi.advanceTimersByTimeAsync(STALL_TICK);

      await expect(outcome).resolves.toEqual({ completed: false });
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
