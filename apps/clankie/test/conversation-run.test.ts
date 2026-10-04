import { afterEach, expect, it, vi } from "vitest";
import {
  CONVERSATION_RUN_STALL_MS,
  ConversationRunStalledError,
  ConversationServiceRun,
  waitForConversationRun,
} from "../src/captain/conversation-run.ts";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

it("abandons silent preparation at five minutes without waiting for the dependency", async () => {
  vi.useFakeTimers();
  const run = new ConversationServiceRun();
  const dependency = deferred<string>();
  const failure = expect(run.wait("create session", dependency.promise)).rejects.toThrow("create session");
  await vi.advanceTimersByTimeAsync(CONVERSATION_RUN_STALL_MS - 1);
  expect(run.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await failure;
  expect(run.signal.reason).toBeInstanceOf(ConversationRunStalledError);
  run.close();
});

it("observed progress keeps healthy execution alive beyond five minutes", async () => {
  vi.useFakeTimers();
  const run = new ConversationServiceRun();
  const dependency = deferred<string>();
  const executing = run.wait("Pi turn", dependency.promise);
  for (let interval = 0; interval < 4; interval++) {
    await vi.advanceTimersByTimeAsync(CONVERSATION_RUN_STALL_MS - 1_000);
    run.progress("Pi tool execution update");
  }
  expect(run.signal.aborted).toBe(false);
  dependency.resolve("completed healthy work");
  await expect(executing).resolves.toBe("completed healthy work");
  run.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("a once-active execution stalls five minutes after its final progress event", async () => {
  vi.useFakeTimers();
  const run = new ConversationServiceRun();
  const dependency = deferred<void>();
  const failed = expect(run.wait("Pi turn", dependency.promise)).rejects.toThrow("Pi tool started");
  await vi.advanceTimersByTimeAsync(CONVERSATION_RUN_STALL_MS - 1_000);
  run.progress("Pi tool started");
  await vi.advanceTimersByTimeAsync(CONVERSATION_RUN_STALL_MS - 1);
  expect(run.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await failed;
  run.close();
});

it.each(["resolve", "reject"] as const)(
  "a cancelled wait observes a late dependency %s without reviving execution",
  async (settlement) => {
    const controller = new AbortController();
    const run = new ConversationServiceRun(controller.signal);
    const dependency = deferred<string>();
    const completion = vi.fn();
    const interruption = new Error("operator interrupted");
    const failed = expect(run.wait("model selection", dependency.promise).then(completion)).rejects.toBe(
      interruption,
    );
    controller.abort(interruption);
    await failed;
    run.close();
    if (settlement === "resolve") dependency.resolve("late model");
    else dependency.reject(new Error("late ignored dependency failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(completion).not.toHaveBeenCalled();
  },
);

it("an already-cancelled run cannot accept an already-resolved dependency", async () => {
  const controller = new AbortController();
  const interruption = new Error("cancelled before wait");
  controller.abort(interruption);
  await expect(waitForConversationRun(Promise.resolve("late answer"), controller.signal)).rejects.toBe(
    interruption,
  );
});

it("closing a completed run removes its deadline and subscriptions once", async () => {
  vi.useFakeTimers();
  const run = new ConversationServiceRun();
  const cleanup = vi.fn();
  run.onClose(cleanup);
  await expect(run.wait("short execution", Promise.resolve("done"))).resolves.toBe("done");
  run.close();
  run.close();
  await vi.advanceTimersByTimeAsync(CONVERSATION_RUN_STALL_MS * 2);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(run.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
