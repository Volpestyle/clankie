/** Tool-native limits also reach package scripts and nested heavy commands. */
export const heavyJobParallelism = 4;

export function heavyJobEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const limit = (value: string | undefined) => {
    const requested = Number(value);
    return String(
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, heavyJobParallelism)
        : heavyJobParallelism,
    );
  };
  return {
    ...env,
    VITEST_MAX_WORKERS: limit(env.VITEST_MAX_WORKERS),
    TURBO_CONCURRENCY: limit(env.TURBO_CONCURRENCY),
  };
}
