import { basename } from "node:path";

/**
 * Cores one heavy slot is sized for. Automatic slots are cores / this, so
 * every tool a slot runs must stay near it: one uncapped compiler fan-out
 * (26 clang processes under one xcodebuild, 2026-10-09) fills the machine by
 * itself and every other slot's tests starve (VUH-1981).
 */
export const heavyJobParallelism = 4;

const cap = (value: string | undefined) => {
  const requested = Number(value);
  return String(
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, heavyJobParallelism)
      : heavyJobParallelism,
  );
};

/** `make -jN` within the slot; a bare `-j` (unlimited) or a larger N is lowered, other flags kept. */
function makeFlags(value: string | undefined): string {
  const flags = (value ?? "").trim();
  const jobs = /(^|\s)(?:-j|--jobs)(?:=|\s*)(\d*)(?=\s|$)/u.exec(flags);
  if (!jobs) return `${flags} -j${heavyJobParallelism}`.trim();
  return flags.replace(jobs[0], `${jobs[1]}-j${cap(jobs[2])}`);
}

/** Tool-native limits also reach package scripts and nested heavy commands. */
export function heavyJobEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    VITEST_MAX_WORKERS: cap(env.VITEST_MAX_WORKERS),
    TURBO_CONCURRENCY: cap(env.TURBO_CONCURRENCY),
    CARGO_BUILD_JOBS: cap(env.CARGO_BUILD_JOBS),
    MAKEFLAGS: makeFlags(env.MAKEFLAGS),
    // Go programs, esbuild among them, size their scheduler from this.
    GOMAXPROCS: cap(env.GOMAXPROCS),
    RAYON_NUM_THREADS: cap(env.RAYON_NUM_THREADS),
    OMP_NUM_THREADS: cap(env.OMP_NUM_THREADS),
    npm_config_child_concurrency: cap(env.npm_config_child_concurrency),
  };
}

/**
 * xcodebuild has no environment knob for its compile fan-out, so a heavy
 * xcodebuild gets `-jobs` unless the caller already chose one.
 */
export function heavyJobArgs(command: string, args: readonly string[]): string[] {
  if (basename(command) !== "xcodebuild" || args.includes("-jobs")) return [...args];
  return [...args, "-jobs", String(heavyJobParallelism)];
}
