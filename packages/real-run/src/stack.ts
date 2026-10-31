import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { Data, Effect } from "effect";

export const repoRoot = resolve(import.meta.dirname, "../../..");
const scratchStack = join(repoRoot, "scripts/scratch-stack.mjs");

/** An outcome the real app should have shown and did not. */
class CheckFailed extends Data.TaggedError("CheckFailed")<{
  readonly check: string;
  readonly detail?: unknown;
}> {
  override get message() {
    const detail = this.detail === undefined ? "" : ` — saw ${JSON.stringify(this.detail)?.slice(0, 1500)}`;
    return `${this.check}${detail}`;
  }
}

/** A process the run depends on could not start, answer or stop. */
class ProcessFailed extends Data.TaggedError("ProcessFailed")<{
  readonly what: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return `could not ${this.what}: ${String(this.cause)}`;
  }
}

export const check = (condition: unknown, name: string, detail?: unknown) =>
  condition ? Effect.void : Effect.fail(new CheckFailed({ check: name, detail }));

/** Polls `read` until it returns a value, or fails with the last thing it saw. */
export const until = <A>(
  what: string,
  read: () => Promise<A | undefined>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    let last: unknown;
    while (Date.now() < deadline) {
      const value = yield* Effect.promise(() =>
        read().then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        ),
      );
      if ("result" in value && value.result !== undefined) return value.result;
      last = "error" in value ? String(value.error) : "no value yet";
      yield* Effect.sleep(options.intervalMs ?? 250);
    }
    return yield* Effect.fail(new CheckFailed({ check: `timed out: ${what}`, detail: last }));
  });

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The one JSON document a headless command prints, when it printed one. */
  readonly json: unknown;
}

export interface ServiceLogLine {
  readonly level?: number;
  readonly event?: string;
  readonly msg?: string;
  readonly [key: string]: unknown;
}

/**
 * One scratch Clankie home (`scripts/scratch-stack.mjs --broker-operator`): its own
 * HOME, state, settings, credential broker file and free ports. Nothing here reads
 * or writes the owner's ~/.config/clankie, live service or Herdr sessions.
 */
export const makeStack = (directory: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((done, fail) =>
          execFile(
            process.execPath,
            [scratchStack, directory, "--broker-operator"],
            { cwd: repoRoot },
            (error) => (error ? fail(error) : done()),
          ),
        ),
      catch: (cause) => new ProcessFailed({ what: "create the scratch home", cause }),
    });
    const env = parseEnv(readFileSync(join(directory, "stack.env"), "utf8")) as Record<string, string>;
    const serviceUrl = env.CLANKIE_CAPTAIN_URL!;
    const relayUrl = env.CLANKIE_RELAY_URL!;
    const serviceLogPath = join(directory, "service.log");
    const relayLogPath = join(directory, "relay.log");
    let service: ChildProcess | undefined;
    let relay: ChildProcess | undefined;
    let boots = 0;

    const launch = (name: "clankie" | "relay", logPath: string) => {
      const child = spawn(process.execPath, [scratchStack, "run", directory, name], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const log = createWriteStream(logPath, { flags: "a" });
      child.stdout?.pipe(log);
      child.stderr?.pipe(log);
      return child;
    };
    const stop = (child: ChildProcess | undefined, what: string) =>
      Effect.tryPromise({
        try: async () => {
          if (!child || child.exitCode !== null || child.signalCode !== null) return;
          const exited = new Promise<void>((done) => child.once("exit", () => done()));
          process.kill(-child.pid!, "SIGTERM");
          const timer = setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 15_000);
          await exited;
          clearTimeout(timer);
        },
        catch: (cause) => new ProcessFailed({ what: `stop ${what}`, cause }),
      });
    const healthy = (url: string) => () =>
      fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) }).then(async (response) =>
        response.ok ? ((await response.json()) as Record<string, unknown>) : undefined,
      );

    const startService = Effect.gen(function* () {
      boots++;
      service = launch("clankie", serviceLogPath);
      const health = yield* until("the service answers /health", healthy(serviceUrl), { timeoutMs: 90_000 });
      yield* Effect.logInfo("service healthy").pipe(Effect.annotateLogs({ boot: boots, pid: service.pid }));
      return health;
    }).pipe(Effect.withSpan("service.start"));
    const stopService = Effect.suspend(() => stop(service, "the service")).pipe(
      Effect.withSpan("service.stop"),
    );
    const startRelay = Effect.gen(function* () {
      relay = launch("relay", relayLogPath);
      return yield* until("the relay answers /health", healthy(relayUrl), { timeoutMs: 60_000 });
    }).pipe(Effect.withSpan("relay.start"));

    /** The installed `clankie` CLI, as an agent runs it: this checkout's, in the scratch home. */
    const cli = (...args: string[]) =>
      Effect.tryPromise({
        try: () =>
          new Promise<CliResult>((done) =>
            execFile(
              process.execPath,
              [scratchStack, "run", directory, "cli", ...args],
              { cwd: repoRoot, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
              (error, stdout, stderr) => {
                let json: unknown;
                try {
                  json = JSON.parse(stdout);
                } catch {
                  json = undefined;
                }
                const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
                done({ code, stdout, stderr, json });
              },
            ),
          ),
        catch: (cause) => new ProcessFailed({ what: `clankie ${args.join(" ")}`, cause }),
      }).pipe(
        Effect.tap((result) =>
          Effect.logDebug("cli").pipe(
            Effect.annotateLogs({
              args: args.join(" "),
              exit: result.code,
              stderr: result.stderr.slice(-2000),
            }),
          ),
        ),
        Effect.withSpan("cli", { attributes: { args: args.join(" ") } }),
      );
    /** A headless command that must exit 0 with one JSON document. */
    const cliJson = (...args: string[]) =>
      cli(...args).pipe(
        Effect.flatMap((result) =>
          result.code === 0 && result.json !== undefined
            ? Effect.succeed(result.json as Record<string, any>)
            : Effect.fail(
                new CheckFailed({
                  check: `clankie ${args.join(" ")} exits 0 with JSON`,
                  detail: {
                    exit: result.code,
                    stdout: result.stdout.slice(0, 2000),
                    stderr: result.stderr.slice(-2000),
                  },
                }),
              ),
        ),
      );
    const http = (path: string, init: RequestInit = {}) =>
      Effect.tryPromise({
        try: () => fetch(`${serviceUrl}${path}`, { ...init, signal: AbortSignal.timeout(10_000) }),
        catch: (cause) => new ProcessFailed({ what: `HTTP ${path}`, cause }),
      });
    /** The service's own structured (pino) log lines, from every boot so far. */
    const serviceLog = (): ServiceLogLine[] =>
      existsSync(serviceLogPath)
        ? readFileSync(serviceLogPath, "utf8")
            .split("\n")
            .flatMap((line) => {
              if (!line.startsWith("{")) return [];
              try {
                return [JSON.parse(line) as ServiceLogLine];
              } catch {
                return [];
              }
            })
        : [];
    const close = Effect.suspend(() =>
      Effect.all([stop(service, "the service"), stop(relay, "the relay")]),
    ).pipe(Effect.ignore);
    return {
      directory,
      env,
      serviceUrl,
      relayUrl,
      startService,
      stopService,
      startRelay,
      cli,
      cliJson,
      http,
      serviceLog,
      close,
    };
  });

export type Stack = Effect.Success<ReturnType<typeof makeStack>>;
