import { describe, expect, it, vi } from "vitest";
import {
  createDraftPacer,
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
  public readonly state: {
    messages: { role: string; stopReason?: string; errorMessage?: string }[];
  } = { messages: [] };
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

  /**
   * pi's own settlement shape (Agent.handleRunFailure): a run that failed
   * resolves like any other and leaves only a terminal assistant message
   * carrying the stop reason. An aborted run arrives the same way.
   */
  public settleRunAs(stopReason: string, errorMessage?: string): void {
    this.state.messages.push({
      role: "assistant",
      stopReason,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
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

    let owner: string | undefined;
    const first = runDurableTurn(lane, "first", [], { deliveryId: "first-message" });
    session.startStreaming();
    const second = runDurableTurn(lane, "second", [], {
      deliveryId: "second-message",
      onAbsorbed: (id) => {
        owner = id;
      },
    });
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
    expect(owner).toBe("first-message");
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

  it("carries pi's own reason out of a run that resolved with stopReason error", async () => {
    const session = new StubSession();
    const lane = makeLane(session);

    const turn = runDurableTurn(lane, "first", []);
    await drain();

    session.settleRunAs("error", "The usage limit has been reached");
    await expect(turn).rejects.toThrow("The usage limit has been reached");
  });

  it("never tells absorbed turns the run succeeded when pi settled it in error", async () => {
    const session = new StubSession();
    const lane = makeLane(session);

    const first = runDurableTurn(lane, "first", []);
    // The fact absorbed turns wait on is settled with the run that owns it, so
    // it has to be wrong here before any waiter resumes and re-reads the lane.
    const shared = lane.running;
    session.startStreaming();
    const second = runDurableTurn(lane, "second", []);
    await drain();

    session.settleRunAs("error", "The usage limit has been reached");
    await expect(first).rejects.toMatchObject({
      message: "The usage limit has been reached",
      code: "captain_usage_limit_reached",
    });
    await expect(second).rejects.toThrow("steered into failed");
    await expect(shared).resolves.toBe(false);
  });

  it("fails a run pi errored without a reason rather than reporting a silent turn", async () => {
    const session = new StubSession();
    const lane = makeLane(session);

    const turn = runDurableTurn(lane, "first", []);
    await drain();

    session.settleRunAs("error");
    await expect(turn).rejects.toMatchObject({
      message: "The model run failed without a reason.",
      code: "captain_model_failed",
    });
  });

  it("leaves a normal stop alone, so an answer with no tool calls still runs", async () => {
    const session = new StubSession();
    const lane = makeLane(session);

    const turn = runDurableTurn(lane, "first", []);
    await drain();

    session.settleRunAs("stop");
    await expect(turn).resolves.toBe("ran");
  });

  it("leaves an aborted run to the caller's own interrupt path", async () => {
    const session = new StubSession();
    const lane = makeLane(session);

    const turn = runDurableTurn(lane, "first", []);
    await drain();

    session.settleRunAs("aborted", "This operation was aborted");
    await expect(turn).resolves.toBe("ran");
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
  it.each([
    "Codex error: The usage limit has been reached",
    "Codex error: usage_limit_reached",
    "You have hit your ChatGPT usage limit (pro plan). Try again in ~30 min.",
  ])("preserves the provider failure %s with a content-free usage-limit code", async (errorMessage) => {
    await expect(
      runOneShotDiscordTurn(
        {
          state: { messages: [{ role: "assistant", stopReason: "error", errorMessage }] },
          prompt: () => Promise.resolve(),
          abort: () => Promise.resolve(),
          subscribe: () => () => undefined,
        },
        "hello",
        [],
      ),
    ).rejects.toMatchObject({ message: errorMessage, code: "captain_usage_limit_reached" });
  });

  it.each([
    {
      code: "allowance_exhausted",
      status: 429,
      type: "insufficient_quota",
      message:
        "Your included model usage is used up. Add your own key in the Clankie app, or it resets on 2026-10-26.",
      expected: "captain_usage_limit_reached",
    },
    {
      code: "daily_cap",
      status: 429,
      type: "insufficient_quota",
      message: "Today's included model usage is used up.",
      expected: "captain_usage_limit_reached",
    },
    {
      code: "escalation_not_in_plan",
      status: 403,
      type: "invalid_request_error",
      message: "Escalating to the work model is part of Pro.",
      expected: "captain_model_failed",
    },
  ])(
    "shows the customer the hosted model proxy's own sentence for $code",
    async ({ code, status, type, message, expected }) => {
      // What Pi makes of the proxy's answer (VUH-1371): status plus the JSON body.
      const errorMessage = `OpenAI API error (${String(status)}): ${JSON.stringify({ message, type, code })}`;
      await expect(
        runOneShotDiscordTurn(
          {
            state: { messages: [{ role: "assistant", stopReason: "error", errorMessage }] },
            prompt: () => Promise.resolve(),
            abort: () => Promise.resolve(),
            subscribe: () => () => undefined,
          },
          "hello",
          [],
        ),
      ).rejects.toMatchObject({ message, code: expected });
    },
  );

  it("leaves other provider errors as Pi reported them", async () => {
    const errorMessage =
      'OpenAI API error (400): {"message":"bad","type":"invalid_request_error","code":"other"}';
    await expect(
      runOneShotDiscordTurn(
        {
          state: { messages: [{ role: "assistant", stopReason: "error", errorMessage }] },
          prompt: () => Promise.resolve(),
          abort: () => Promise.resolve(),
          subscribe: () => () => undefined,
        },
        "hello",
        [],
      ),
    ).rejects.toMatchObject({ message: errorMessage, code: "captain_model_failed" });
  });

  it("declares a turn dead only after it has gone silent inside, never for being slow", async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn(() => Promise.resolve());
      const run = runOneShotDiscordTurn(
        {
          state: { messages: [] },
          abort,
          prompt: () => new Promise<void>(() => undefined),
          subscribe: () => () => undefined,
        },
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
  function toolFixture(signal?: AbortSignal) {
    const abort = vi.fn(async () => {});
    const unsubscribe = vi.fn();
    let emit!: (event: { type: string; toolCallId?: string }) => void;
    let finish!: () => void;
    const stallMs = 30_000;
    const outcome = runTurnWithStallWatchdog(
      {
        abort,
        subscribe: (listener) => {
          emit = (event) => listener(event as never);
          return unsubscribe;
        },
      },
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      { stallMs, ...(signal === undefined ? {} : { signal }) },
    );
    return { abort, unsubscribe, emit, finish, stallMs, outcome };
  }

  it("does not abort a silent native tool until it ends and the full idle window expires", async () => {
    vi.useFakeTimers();
    try {
      const f = toolFixture();
      f.emit({ type: "tool_execution_start", toolCallId: "native-browser-task" });
      await vi.advanceTimersByTimeAsync(f.stallMs * 3);
      expect(f.abort).not.toHaveBeenCalled();
      f.emit({ type: "message_update" });
      await vi.advanceTimersByTimeAsync(f.stallMs * 2);
      expect(f.abort).not.toHaveBeenCalled();
      f.emit({ type: "tool_execution_end", toolCallId: "native-browser-task" });
      await vi.advanceTimersByTimeAsync(f.stallMs - 1);
      expect(f.abort).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(f.outcome).resolves.toEqual({ completed: false });
      expect(f.abort).toHaveBeenCalledOnce();
      expect(f.unsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("overlapping native tools and repeated starts cannot prematurely rearm the room watchdog", async () => {
    vi.useFakeTimers();
    try {
      const f = toolFixture();
      f.emit({ type: "tool_execution_start", toolCallId: "tool-one" });
      f.emit({ type: "tool_execution_start", toolCallId: "tool-one" });
      f.emit({ type: "tool_execution_start", toolCallId: "tool-two" });
      f.emit({ type: "tool_execution_end", toolCallId: "tool-one" });
      f.emit({ type: "tool_execution_end", toolCallId: "tool-one" });
      f.emit({ type: "tool_execution_end", toolCallId: "unrelated-tool" });
      await vi.advanceTimersByTimeAsync(f.stallMs * 3);
      expect(f.abort).not.toHaveBeenCalled();
      f.emit({ type: "tool_execution_end", toolCallId: "tool-two" });
      await vi.advanceTimersByTimeAsync(f.stallMs - 1);
      expect(f.abort).not.toHaveBeenCalled();
      f.finish();
      await expect(f.outcome).resolves.toEqual({ completed: true, value: undefined });
      expect(f.unsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancellation still releases the room watchdog while a native tool remains in flight", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const f = toolFixture(controller.signal);
      f.emit({ type: "tool_execution_start", toolCallId: "silent-tool" });
      await vi.advanceTimersByTimeAsync(f.stallMs * 2);
      const reason = new Error("operator cancelled native tool");
      const failed = expect(f.outcome).rejects.toBe(reason);
      controller.abort(reason);
      await failed;
      expect(f.unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

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

describe("createDraftPacer", () => {
  it("sends the first draft at once, then at most one per interval", () => {
    const sent: string[] = [];
    let clock = 1_000;
    const pacer = createDraftPacer((text) => sent.push(text), { intervalMs: 60, now: () => clock });

    pacer.push("h");
    pacer.push("he");
    clock += 59;
    pacer.push("hel");
    clock += 1;
    pacer.push("hell");
    clock += 5;
    pacer.push("hello");

    // Every draft carries the whole message, so the swallowed ones cost nothing.
    expect(sent).toEqual(["h", "hell"]);
  });

  it("opens the gate again for the first token of the next message", () => {
    const sent: string[] = [];
    let clock = 1_000;
    const pacer = createDraftPacer((text) => sent.push(text), { intervalMs: 60, now: () => clock });

    pacer.push("done");
    clock += 5;
    pacer.reset();
    pacer.push("next");

    expect(sent).toEqual(["done", "next"]);
  });
});

it("keeps overlapping voice asks from different people in independent service runs", async () => {
  const { DiscordVoiceIngress } = await import("@clankie/discord-presence-core");
  const sessions = new Map<string, StubSession>();
  const actors: string[] = [];
  const ingress = new DiscordVoiceIngress(
    {
      getHealth: async () => ({ profileHash: "profile" }),
      submitDiscordCaptainChannelTurn: async (request) => {
        actors.push(request.trigger.actorId);
        // Service admission gives every delivery a fresh child, including another
        // ask from the same person. Ingress must never share a streaming lane.
        const session = new StubSession();
        sessions.set(request.deliveryId, session);
        await runDurableTurn(makeLane(session), request.trigger.body ?? "", [], {
          deliveryId: request.deliveryId,
        });
        return {
          state: "settled",
          captainSessionId: request.deliveryId,
          turnId: request.deliveryId,
          response: request.trigger.actorId,
        };
      },
    },
    { characterId: "clankie", credentialRef: "discord_bot", transportKind: "bot" },
  );
  const ask = (userId: string, deliveryId: string, transcript: string) =>
    ingress.handle({
      userId,
      deliveryId,
      transcript,
      guildId: "12345",
      channelId: "67890",
      presenceSessionId: "voice",
    });
  const alice = ask("1111", "alice", "look up a game");
  await drain();
  sessions.get("alice")!.startStreaming();
  const bob = ask("2222", "bob", "check the weather");
  const carol = ask("3333", "carol", "find a song");
  const refinement = ask("1111", "alice-refines", "only co-op games");
  await drain();
  expect(actors).toEqual(["1111", "2222", "3333", "1111"]);
  expect([...sessions.keys()]).toEqual(["alice", "bob", "carol", "alice-refines"]);
  expect(new Set(sessions.values()).size).toBe(4);
  for (const [id, text] of [
    ["alice", "look up a game"],
    ["bob", "check the weather"],
    ["carol", "find a song"],
    ["alice-refines", "only co-op games"],
  ])
    expect(sessions.get(id!)!.calls).toEqual([{ text, behavior: undefined }]);
  let aliceSettled = false;
  void alice.then(() => {
    aliceSettled = true;
  });
  sessions.get("bob")!.settleRun();
  await expect(bob).resolves.toMatchObject({ state: "settled", response: "2222" });
  sessions.get("carol")!.settleRun();
  await expect(carol).resolves.toMatchObject({ state: "settled", response: "3333" });
  sessions.get("alice-refines")!.settleRun();
  await expect(refinement).resolves.toMatchObject({ state: "settled", response: "1111" });
  expect(aliceSettled).toBe(false);
  expect(sessions.get("alice")!.isStreaming).toBe(true);
  sessions.get("alice")!.settleRun();
  await expect(alice).resolves.toMatchObject({ state: "settled", response: "1111" });
});

it("reserves actual lane start while guidance authorizes and never prepares guidance for absorbed input", async () => {
  const session = new StubSession();
  const lane = makeLane(session);
  let release!: () => void;
  const commit = vi.fn(() => "first with private context");
  const secondPrepare = vi.fn(async () => () => "must not be used");
  const first = runDurableTurn(lane, "first", [], {
    preparePrompt: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return commit;
    },
  });
  const second = runDurableTurn(lane, "second", [], { preparePrompt: secondPrepare });
  expect(session.calls).toHaveLength(0);
  expect(commit).not.toHaveBeenCalled();
  release();
  await drain();
  session.startStreaming();
  await drain();
  // A waiting turn re-decides on the reservation transition and enters only the active run.
  const third = runDurableTurn(lane, "third", [], { preparePrompt: secondPrepare });
  await drain();
  expect(commit).toHaveBeenCalledTimes(1);
  expect(secondPrepare).not.toHaveBeenCalled();
  session.settleRun();
  expect(await first).toBe("ran");
  expect(await third).toBe("absorbed");
  // The second waiter may have seen accepted-before-streaming and waits for that run to settle.
  await drain();
  if (session.calls.some((call) => call.text === "must not be used")) {
    session.settleRun();
  }
  await second;
});
it("a turn already absorbed never evaluates or consumes its guidance preparation", async () => {
  const session = new StubSession();
  const lane = makeLane(session);
  const first = runDurableTurn(lane, "first", []);
  session.startStreaming();
  const prepare = vi.fn(async () => () => "private");
  const absorbed = runDurableTurn(lane, "second", [], { preparePrompt: prepare });
  await drain();
  expect(prepare).not.toHaveBeenCalled();
  session.settleRun();
  expect(await first).toBe("ran");
  expect(await absorbed).toBe("absorbed");
});

it("a stalled reserved preparation cannot consume guidance or prompt after late authorization", async () => {
  const session = new StubSession();
  const lane = makeLane(session);
  let release!: () => void;
  const consume = vi.fn(() => "private");
  const watchdogSession = { abort: vi.fn(async () => {}), subscribe: () => () => {} };
  const result = await runTurnWithStallWatchdog(
    watchdogSession,
    (signal) =>
      runDurableTurn(lane, "natural", [], {
        signal,
        preparePrompt: () =>
          new Promise<() => string>((resolve) => {
            release = () => resolve(consume);
          }),
      }),
    { stallMs: 5 },
  );
  expect(result).toEqual({ completed: false });
  await drain();
  expect(lane.starting).toBeUndefined();
  release();
  await drain();
  expect(consume).not.toHaveBeenCalled();
  expect(session.calls).toEqual([]);
  expect(watchdogSession.abort).toHaveBeenCalledOnce();
});
