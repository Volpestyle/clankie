/** Try every teardown step; the first failure is rethrown after the rest run. */
export async function runShutdownSteps(steps: readonly (() => void | Promise<void>)[]): Promise<void> {
  let failure: unknown;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

/** Collapse concurrent shutdown signals onto one in-flight teardown. */
export function coalesceOnce<T>(run: (signal: T) => Promise<void>): (signal: T) => Promise<void> {
  let shutdown: Promise<void> | undefined;
  return (signal) => {
    shutdown ??= run(signal);
    return shutdown;
  };
}
