import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";

const queues = new Map<string, Promise<void>>();

/** Serialize each durable store across CLI/service processes and backend instances. */
export async function withTrackerStoreLock<T>(
  storePath: string,
  operation: (assertHeld: () => void) => Promise<T>,
): Promise<T> {
  const path = resolve(storePath);
  const previous = queues.get(path) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const pending = new Promise<void>((resolveQueue) => {
    releaseQueue = resolveQueue;
  });
  const queued = previous.then(() => pending);
  queues.set(path, queued);
  await previous;
  let release: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Same heartbeat policy as the credential broker. A sibling ancillary
    // store uses a different path and can be accessed while this lock is held.
    let compromised: Error | undefined;
    release = await lockfile.lock(path, {
      realpath: false,
      stale: 60_000,
      update: 10_000,
      retries: { retries: 12, minTimeout: 25, maxTimeout: 5_000 },
      onCompromised: (error) => {
        compromised = error;
      },
    });
    const assertHeld = () => {
      if (compromised !== undefined) throw compromised;
    };
    const result = await operation(assertHeld);
    assertHeld();
    return result;
  } finally {
    try {
      await release?.();
    } finally {
      releaseQueue();
      if (queues.get(path) === queued) queues.delete(path);
    }
  }
}
