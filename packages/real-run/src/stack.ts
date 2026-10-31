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

    /** Each launched process, settled once it exited and its log file holds all it wrote. */
    const drained = new WeakMap<ChildProcess, Promise<void>>();
    const launch = (name: "clankie" | "relay", logPath: string) => {
      const child = spawn(process.execPath, [scratchStack, "run", directory, name], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const log = createWriteStream(logPath, { flags: "a" });
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      // "close" fires once the process exited and both its pipes ended.
      drained.set(child, new Promise<void>((done) => child.once("close", () => log.end(() => done()))));
      return child;
    };
    const stop = (child: ChildProcess | undefined, what: string) =>
      Effect.tryPromise({
        try: async () => {
          if (!child) return;
          if (child.exitCode === null && child.signalCode === null) {
            process.kill(-child.pid!, "SIGTERM");
            const timer = setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 15_000);
            await drained.get(child);
            clearTimeout(timer);
          }
          await drained.get(child);
        },
        catch: (cause) => new ProcessFailed({ what: `stop ${what}`, cause }),
      });
    // The service's supervisor stops its Herdr server on SIGTERM, but the server runs
    // in its own process group so that it outlives a service restart (ADR 0164), and
    // a supervisor that died first leaves it running. The end of the run asks it to
    // stop through its socket, then reaps any server still running from this home's
    // own copy of Herdr (the service always runs it from STATE/herdr/bin/herdr).
    const herdrRoot = join(env.CLANKIE_STATE!, "herdr");
    const herdrBinary = join(herdrRoot, "bin/herdr");
    const run = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) =>
      new Promise<string>((done) =>
        execFile(file, args, { timeout: 15_000, ...options }, (_error, stdout) => done(stdout)),
      );
    const herdrServers = async () =>
      (await run("ps", ["-axo", "pid=,args="]))
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(.*)$/u.exec(line))
        .filter((match) => match?.[2]?.startsWith(`${herdrBinary} server`))
        .map((match) => Number(match![1]));
    const stopHerdr = Effect.tryPromise({
      try: async () => {
        const socketPath = join(herdrRoot, "herdr.sock");
        if (existsSync(socketPath) && existsSync(herdrBinary))
          await run(herdrBinary, ["server", "stop"], {
            env: {
              ...process.env,
              XDG_CONFIG_HOME: herdrRoot,
              XDG_STATE_HOME: herdrRoot,
              XDG_RUNTIME_DIR: herdrRoot,
              HERDR_SOCKET_PATH: socketPath,
            },
          });
        for (let attempt = 0; attempt < 20; attempt++) {
          const left = await herdrServers();
          if (!left.length) return;
          for (const pid of left) process.kill(pid, attempt < 10 ? "SIGTERM" : "SIGKILL");
          await new Promise((done) => setTimeout(done, 500));
        }
        throw new Error(`still running: ${(await herdrServers()).join(", ")}`);
      },
      catch: (cause) => new ProcessFailed({ what: "stop the scratch Herdr server", cause }),
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
        // An interrupted run aborts the command it is waiting on.
        try: (signal) =>
          new Promise<CliResult>((done) =>
            execFile(
              process.execPath,
              [scratchStack, "run", directory, "cli", ...args],
              { cwd: repoRoot, timeout: 120_000, maxBuffer: 32 * 1024 * 1024, signal },
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
    /** Stops everything the run started and waits until their logs are complete. */
    const close = Effect.suspend(() =>
      Effect.all([stop(service, "the service"), stop(relay, "the relay")]).pipe(
        Effect.ignore,
        Effect.andThen(stopHerdr.pipe(Effect.catch((error) => Effect.logError(error.message)))),
      ),
    ).pipe(Effect.withSpan("stack.close"));
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
