import { basename } from "node:path";
import { availableParallelism } from "node:os";
import { readFileSync, statSync } from "node:fs";

/**
 * Cores one heavy slot is sized for. Automatic slots are cores / this, so
 * every tool a slot runs must stay near it: one uncapped compiler fan-out
 * (26 clang processes under one xcodebuild, 2026-10-09) fills the machine by
 * itself and every other slot's tests starve (VUH-1981).
 */
export const heavyJobParallelism = 4;
/** Cores one light-lane job is sized for: a focused check beside full gates (VUH-2023). */
export const lightJobParallelism = 2;

/**
 * Which pool a heavy command waits in. A focused check (named test files, one
 * package's typecheck) is `light`: it starts beside full gates in its own
 * smaller-capped lane. Dev servers and watch commands use `server`; everything
 * else, and anything unrecognized, is `full` (custom servers opt in explicitly).
 */
export type HeavyJobLane = "full" | "light" | "server";
/** Tool-native fan-out inside a server permit; its OS CPU budget is separate. */
export const serverJobParallelism = 2;
/** A bounded job held this long is reported, never killed for its age. */
export const longHeldJobMs = 15 * 60_000;
export function serverLaneCapacity(): { slots: number; cpuCores: number; jobCpuCores: number } {
  const cores = Math.max(1, availableParallelism());
  const slots = Math.min(2, Math.max(1, Math.floor(cores / 4)));
  const cpuCores = Math.min(64, cores / 5);
  return { slots, cpuCores, jobCpuCores: cpuCores / slots };
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const MAX_LIGHT_TEST_FILES = 8;
/** Vitest options whose value is a separate argument, so it is not a file filter. */
const VITEST_VALUE_OPTIONS = new Set([
  "-t",
  "--testNamePattern",
  "-c",
  "--config",
  "-r",
  "--root",
  "--dir",
  "--project",
  "--maxWorkers",
  "--minWorkers",
  "--pool",
  "--reporter",
  "--outputFile",
  "--environment",
  "--testTimeout",
  "--hookTimeout",
  "--shard",
  "--mode",
  "--retry",
]);
const PNPM_VALUE_OPTIONS = new Set(["--filter", "-F", "-C", "--dir"]);
/** A pnpm filter that can select more than one package. */
const MULTI_PACKAGE_FILTER = /[*{}[\]!^]|\.\.\./u;

/** Explicit files only: directories, globs and implicit repository scans stay full. */
const MAX_CODE_CHECK_FILES = 64;
const CODE_CHECK_FLAGS = new Set([
  "--write",
  "--check",
  "--list-different",
  "--disable-nested-config",
  "--deny-warnings",
  "--fix",
  "--fix-suggestions",
  "--fix-dangerously",
  "--no-ignore",
  "--disable-inline-config",
]);
const CODE_CHECK_VALUES = new Set([
  "--threads",
  "-c",
  "--config",
  "--ignore-path",
  "--tsconfig",
  "--max-warnings",
  "-A",
  "--allow",
  "-W",
  "--warn",
  "-D",
  "--deny",
  "--format",
]);
type CodeCheck = { offset: number; args: readonly string[] };
function codeCheck(command: string, args: readonly string[]): CodeCheck | undefined {
  let tool = basename(command);
  let offset = 0;
  if (tool === "pnpm") {
    // Scoped scripts may have their own whole-package work; only our root
    // file-aware aliases are known. Explicit binaries can still use pnpm exec.
    while (args[offset]?.startsWith("-")) {
      const flag = args[offset++]!;
      if (PNPM_VALUE_OPTIONS.has(flag)) offset++;
      else if (!flag.includes("=")) return undefined;
    }
    if (["exec", "run"].includes(args[offset] ?? "")) offset++;
    tool = basename(args[offset++] ?? "");
    if (["fmt", "fmt:check", "lint"].includes(tool)) {
      if (offset > (args[0] === "run" ? 2 : 1)) return undefined;
      try {
        const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
        if (scripts?.[tool] !== `node scripts/scoped-code-check.mjs ${tool}`) return undefined;
      } catch {
        return undefined;
      }
    } else if (!["oxfmt", "oxlint"].includes(tool)) return undefined;
  } else if (!["oxfmt", "oxlint"].includes(tool)) return undefined;
  return { offset, args: args.slice(offset) };
}
function codeCheckLane(args: readonly string[]): HeavyJobLane {
  let files = 0;
  let positional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!positional && arg === "--") {
      positional = true;
      continue;
    }
    if (!positional && arg.startsWith("-")) {
      const equal = arg.indexOf("=");
      const flag = equal < 0 ? arg : arg.slice(0, equal);
      if (CODE_CHECK_VALUES.has(flag)) {
        const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
        if (!value || value.startsWith("-")) return "full";
      } else if (!CODE_CHECK_FLAGS.has(arg)) return "full";
      continue;
    }
    if (++files > MAX_CODE_CHECK_FILES || /[*?{}[\]]/u.test(arg)) return "full";
    try {
      if (!statSync(arg).isFile()) return "full";
    } catch {
      return "full";
    }
  }
  return files ? "light" : "full";
}

function vitestLane(args: readonly string[]): HeavyJobLane {
  const files: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "run" && files.length === 0) continue;
    if (arg === "--") continue;
    if (VITEST_VALUE_OPTIONS.has(arg)) {
      index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    files.push(arg);
  }
  return files.length > 0 &&
    files.length <= MAX_LIGHT_TEST_FILES &&
    files.every((file) => TEST_FILE.test(file))
    ? "light"
    : "full";
}

/** `pnpm [--filter ONE | -C DIR] [run] typecheck`: one package's typecheck. */
function pnpmTypecheckLane(args: readonly string[]): HeavyJobLane {
  let filters = 0;
  let scoped = false;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split("=", 2) : [arg];
    if (flag === "-r" || flag === "--recursive" || flag === "-w" || flag === "--workspace-root")
      return "full";
    if (PNPM_VALUE_OPTIONS.has(flag!)) {
      const value = inline ?? args[++index];
      if (value === undefined) return "full";
      if (flag === "--filter" || flag === "-F") {
        if (MULTI_PACKAGE_FILTER.test(value)) return "full";
        filters++;
      }
      scoped = true;
      continue;
    }
    if (arg.startsWith("-")) continue;
    rest.push(arg);
  }
  if (rest[0] === "run") rest.shift();
  return scoped && filters <= 1 && rest.length === 1 && rest[0] === "typecheck" ? "light" : "full";
}

export function heavyJobLane(command: string, args: readonly string[]): HeavyJobLane {
  const check = codeCheck(command, args);
  if (check) return codeCheckLane(check.args);
  const words = [command, ...args];
  const executable = basename(command);
  // Recognize launchers and explicit watch modes, without reading scripts or
  // treating arbitrary shell text / test-name patterns as command words.
  if (["sh", "bash", "zsh", "fish"].includes(executable)) return "full";
  let tool = executable;
  let rest = [...args];
  if (["pnpm", "npm", "yarn", "npx", "bun"].includes(tool)) {
    while (rest[0]?.startsWith("-")) {
      const flag = rest.shift()!;
      if (PNPM_VALUE_OPTIONS.has(flag)) rest.shift();
    }
    if (["exec", "run", "dlx"].includes(rest[0] ?? "")) rest.shift();
    tool = basename(rest.shift() ?? "");
  } else if (["node", "nodejs"].includes(tool)) {
    if (rest.some((arg) => arg === "--watch" || arg.startsWith("--watch="))) return "server";
    tool = basename(rest.shift() ?? "");
  }
  if (/^(?:dev|watch)(?::[\w-]+)*$/u.test(tool) || /:watch(?:$|:)/u.test(tool) || tool === "start")
    return "server";
  if (["vite", "next", "expo", "tsx", "tsc", "vitest", "webpack"].includes(tool)) {
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index]!;
      if (tool === "vitest" && VITEST_VALUE_OPTIONS.has(arg)) {
        index++;
        continue;
      }
      if (
        arg === "--watch" ||
        arg === "-w" ||
        arg === "watch" ||
        (arg.startsWith("--watch=") && arg !== "--watch=false")
      )
        return "server";
    }
    if (tool === "expo" && (rest.length === 0 || rest[0] === "start")) return "server";
    if (tool === "next" && ["dev", "start"].includes(rest[0] ?? "")) return "server";
    if (tool === "vite" && !rest.includes("build")) return "server";
    if (tool === "webpack" && rest[0] === "serve") return "server";
    if (tool === "vitest" && !rest.includes("run") && !rest.includes("--run")) return "server";
  }
  const vitest = words.findIndex((word) => /^vitest(?:\.m?js)?$/u.test(basename(word)));
  if (vitest >= 0) return vitestLane(words.slice(vitest + 1));
  const tsc = words.findIndex((word) => basename(word) === "tsc");
  if (tsc >= 0)
    return words.slice(tsc + 1).some((word) => word === "-b" || word === "--build") ? "full" : "light";
  if (basename(command) === "pnpm") return pnpmTypecheckLane(args);
  return "full";
}

const capTo = (value: string | undefined, limit: number) => {
  const requested = Number(value);
  return String(Number.isInteger(requested) && requested > 0 ? Math.min(requested, limit) : limit);
};

/** `make -jN` within the slot; a bare `-j` (unlimited) or a larger N is lowered, other flags kept. */
function makeFlags(value: string | undefined, limit: number): string {
  const flags = (value ?? "").trim();
  const jobs = /(^|\s)(?:-j|--jobs)(?:=|\s*)(\d*)(?=\s|$)/u.exec(flags);
  if (!jobs) return `${flags} -j${limit}`.trim();
  return flags.replace(jobs[0], `${jobs[1]}-j${capTo(jobs[2], limit)}`);
}

/** Tool-native limits also reach package scripts and nested heavy commands. */
export function heavyJobEnvironment(
  env: NodeJS.ProcessEnv,
  limit: number = heavyJobParallelism,
): NodeJS.ProcessEnv {
  const cap = (value: string | undefined) => capTo(value, limit);
  return {
    ...env,
    VITEST_MAX_WORKERS: cap(env.VITEST_MAX_WORKERS),
    TURBO_CONCURRENCY: cap(env.TURBO_CONCURRENCY),
    CARGO_BUILD_JOBS: cap(env.CARGO_BUILD_JOBS),
    MAKEFLAGS: makeFlags(env.MAKEFLAGS, limit),
    // Go programs, esbuild among them, size their scheduler from this.
    GOMAXPROCS: cap(env.GOMAXPROCS),
    RAYON_NUM_THREADS: cap(env.RAYON_NUM_THREADS),
    OMP_NUM_THREADS: cap(env.OMP_NUM_THREADS),
  };
}

/**
 * Known formatter/linter tools receive a native thread cap matching the permit.
 * xcodebuild gets `-jobs` because it has no environment knob for compile fan-out.
 */
export function heavyJobArgs(
  command: string,
  args: readonly string[],
  limit = heavyJobParallelism,
): string[] {
  const check = codeCheck(command, args);
  if (check) {
    const result = args.slice(0, check.offset);
    let threads = Number(capTo(process.env.RAYON_NUM_THREADS, limit));
    let positional = false;
    for (let index = check.offset; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "--") positional = true;
      if (!positional && (arg === "--threads" || arg.startsWith("--threads="))) {
        const value = arg === "--threads" ? args[++index] : arg.slice("--threads=".length);
        // Let the tool report malformed flags rather than turning a bad
        // command into a successful one. Lower valid caps remain lower.
        if (!value || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
          return [...args];
        threads = Math.min(threads, Number(value));
      } else result.push(arg);
    }
    const separator = result.indexOf("--", check.offset);
    result.splice(separator < 0 ? result.length : separator, 0, `--threads=${threads}`);
    return result;
  }
  if (basename(command) !== "xcodebuild" || args.includes("-jobs")) return [...args];
  return [...args, "-jobs", String(heavyJobParallelism)];
}
