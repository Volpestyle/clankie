import { AsyncLocalStorage } from "node:async_hooks";

// Vitest cancellation ends its await, not the async fixture body. Keep real
// work observed and drain it before removing files it can still write.
class FixtureWork {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private readonly pending = new Set<Promise<void>>();
  constructor(signal: AbortSignal) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
  }
  run<T>(start: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    const result = Promise.resolve().then(() => {
      this.signal.throwIfAborted();
      return start();
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return result;
  }
  wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get: (object, key) => {
        const value = Reflect.get(object, key);
        return typeof value === "function"
          ? (...args: unknown[]) => this.run(() => value.apply(object, args))
          : value;
      },
    });
  }
  stop() {
    this.controller.abort();
  }
  async drain() {
    while (this.pending.size) await Promise.all(this.pending);
  }
}
const current = new AsyncLocalStorage<FixtureWork>();
export function fixtureWork() {
  const work = current.getStore();
  if (!work) throw new Error("Fixture work requires its test lifetime");
  return work;
}
export async function withFixtureWork(run: () => Promise<void>, context: { signal: AbortSignal }) {
  const work = new FixtureWork(context.signal);
  await current.run(work, async () => {
    try {
      await run();
    } finally {
      work.stop();
      await work.drain();
    }
  });
}
