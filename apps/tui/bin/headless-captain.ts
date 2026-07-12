import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, isCurrentTurnBoundaryEvent, type HandleMessageStreamEvent } from "eve/client";
import {
  captainServiceStatePath,
  captainStateDirectory,
  DEFAULT_CAPTAIN_URL,
  ensureCaptainService,
  inspectCaptain,
  readCaptainServiceRecord,
  restartCaptainService,
  type CaptainServiceHandle,
  type EnsureCaptainServiceOptions,
  type RestartCaptainServiceOptions,
} from "./captain-service.ts";
import { assertCaptainEndpoint, captainInfoGeneration } from "../src/session/captain-identity.ts";
import {
  CaptainSessionCursorStore,
  emptyCaptainCursor,
  type CaptainSessionCursor,
  type StoredCaptainSessionCursor,
} from "../src/session/session-cursor.ts";

const HEADLESS_CURSOR_NAME = "captain-headless-session.json";
const HEADLESS_LOCK_NAME = "captain-headless-session.lock";

type Writable = { write(chunk: string): unknown };

export interface HeadlessCaptainCommandOptions {
  readonly clientFactory?: (host: string) => Client;
  readonly ensureImpl?: (options: EnsureCaptainServiceOptions) => Promise<CaptainServiceHandle>;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly host?: string;
  readonly readStdin?: () => Promise<string>;
  readonly repoRoot: string;
  readonly restartImpl?: (options: RestartCaptainServiceOptions) => Promise<CaptainServiceHandle>;
  readonly stderr?: Writable;
  readonly stdout?: Writable;
}

export function headlessCaptainCursorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(captainStateDirectory(env), HEADLESS_CURSOR_NAME);
}

function headlessCaptainLockPath(env: NodeJS.ProcessEnv): string {
  return join(captainStateDirectory(env), HEADLESS_LOCK_NAME);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withHeadlessLock<T>(env: NodeJS.ProcessEnv, operation: () => Promise<T>): Promise<T> {
  const directory = captainStateDirectory(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = headlessCaptainLockPath(env);
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let stale = false;
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
      stale = typeof record.pid !== "number" || !processIsAlive(record.pid);
    } catch {
      stale = true;
    }
    if (!stale) {
      throw new Error("Another clankie msg/watch command owns the headless captain session.");
    }
    unlinkSync(path);
    fd = openSync(path, "wx", 0o600);
  }
  writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
  try {
    return await operation();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }
}

function createClient(host: string): Client {
  return new Client({
    host,
    maxReconnectAttempts: 5,
    preserveCompletedSessions: true,
    redirect: "error",
  });
}

function outputJson(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function commandHelp(): string {
  return [
    "Usage: clankie <command>",
    "",
    "Headless captain commands:",
    "  health | status          Probe /eve/v1/health and /eve/v1/info",
    "  restart                  Restart a launcher-owned captain service",
    "  msg [--new] <message>    Send without opening the TTY face; omit message to read stdin",
    "  watch [--timeout SEC]    Stream JSONL events until the active turn settles",
    "  wait [--timeout SEC]     Wait silently and print the final boundary",
    "",
    "With no command, clankie opens the fullscreen operator console and requires a TTY.",
  ].join("\n");
}

export function isHeadlessCaptainCommand(command: string | undefined): boolean {
  return (
    command === "health" ||
    command === "status" ||
    command === "restart" ||
    command === "msg" ||
    command === "watch" ||
    command === "wait" ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  );
}

function commandHost(options: HeadlessCaptainCommandOptions): string {
  const env = options.env ?? process.env;
  return options.host ?? env.CLANKIE_CAPTAIN_URL ?? DEFAULT_CAPTAIN_URL;
}

async function runInspection(options: HeadlessCaptainCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const host = commandHost(options);
  const inspection = await inspectCaptain(host, options.fetchImpl ?? fetch);
  const record = readCaptainServiceRecord(captainServiceStatePath(env), host);
  outputJson(options.stdout ?? process.stdout, {
    ok: inspection.state === "healthy",
    status: inspection.state === "healthy" ? "ready" : inspection.state,
    endpointState: inspection.state,
    host,
    healthPath: inspection.healthPath,
    infoPath: inspection.infoPath,
    ...(inspection.agent === undefined ? {} : { agent: inspection.agent }),
    ...(record?.generation === undefined && inspection.generation === undefined
      ? {}
      : { generation: record?.generation ?? inspection.generation }),
    owned: record !== undefined,
    ...(record === undefined ? {} : { pid: record.pid }),
  });
  return inspection.state === "healthy" ? 0 : 1;
}

async function runRestart(options: HeadlessCaptainCommandOptions): Promise<number> {
  const host = commandHost(options);
  const handle = await (options.restartImpl ?? restartCaptainService)({
    repoRoot: options.repoRoot,
    host,
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl ?? fetch,
  });
  outputJson(options.stdout ?? process.stdout, {
    ok: true,
    status: "ready",
    host: handle.host,
    owned: handle.owned,
    ...(handle.generation === undefined ? {} : { generation: handle.generation }),
  });
  return 0;
}

async function readMessage(
  args: readonly string[],
  options: HeadlessCaptainCommandOptions,
): Promise<{
  message: string;
  startNew: boolean;
}> {
  const startNew = args[0] === "--new";
  const messageArgs = startNew ? args.slice(1) : args;
  const message =
    messageArgs.length > 0 ? messageArgs.join(" ") : await (options.readStdin ?? readStandardInput)();
  if (message.trim().length === 0) throw new Error("clankie msg requires a non-empty message.");
  return { message, startNew };
}

async function readStandardInput(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

async function connectCaptain(input: {
  readonly clientFactory?: (host: string) => Client;
  readonly generation?: string;
  readonly host: string;
}): Promise<{ client: Client; generation: string }> {
  const client = (input.clientFactory ?? createClient)(input.host);
  const [health, info] = await Promise.all([client.health(), client.info()]);
  assertCaptainEndpoint(health, info);
  const generation = input.generation ?? captainInfoGeneration(info);
  if (generation === undefined) {
    throw new Error("Captain endpoint does not expose a durable build identity.");
  }
  return { client, generation };
}

function normalizeCursor(
  cursor: StoredCaptainSessionCursor | undefined,
  generation: string,
  startNew: boolean,
): CaptainSessionCursor {
  if (startNew || cursor === undefined) return emptyCaptainCursor(generation);
  if (cursor.version !== 2 || cursor.generation !== generation) {
    if (cursor.active) {
      throw new Error(
        "The saved headless turn belongs to a different captain build. Inspect mission state, then use `clankie msg --new ...` to abandon it explicitly.",
      );
    }
    return emptyCaptainCursor(generation);
  }
  return cursor;
}

async function runMessage(args: readonly string[], options: HeadlessCaptainCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const host = commandHost(options);
  const input = await readMessage(args, options);
  return await withHeadlessLock(env, async () => {
    const handle = await (options.ensureImpl ?? ensureCaptainService)({
      repoRoot: options.repoRoot,
      host,
      env,
      fetchImpl: options.fetchImpl ?? fetch,
    });
    const connected = await connectCaptain({
      host,
      ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
      ...(handle.generation === undefined ? {} : { generation: handle.generation }),
    });
    const store = new CaptainSessionCursorStore(headlessCaptainCursorPath(env));
    const cursor = normalizeCursor(await store.read(), connected.generation, input.startNew);
    if (cursor.active) {
      throw new Error("The headless captain turn is still active. Run `clankie watch` or `clankie wait`.");
    }
    const response = await connected.client.session(cursor).send({ message: input.message });
    const next: CaptainSessionCursor = {
      version: 2,
      active: true,
      generation: connected.generation,
      sessionId: response.sessionId,
      streamIndex: cursor.sessionId === response.sessionId ? cursor.streamIndex : 0,
      ...(response.continuationToken === undefined
        ? cursor.continuationToken === undefined
          ? {}
          : { continuationToken: cursor.continuationToken }
        : { continuationToken: response.continuationToken }),
    };
    await store.write(next);
    outputJson(options.stdout ?? process.stdout, {
      ok: true,
      status: "submitted",
      sessionId: response.sessionId,
      next: "clankie watch",
    });
    return 0;
  });
}

function parseTimeout(args: readonly string[]): number | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--timeout") {
    throw new Error("Usage: clankie watch|wait [--timeout SEC]");
  }
  const seconds = Number(args[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Timeout must be a positive number.");
  return seconds * 1_000;
}

function boundaryState(event: HandleMessageStreamEvent): "completed" | "failed" | "waiting" | undefined {
  if (event.type === "session.completed") return "completed";
  if (event.type === "session.failed") return "failed";
  if (event.type === "session.waiting") return "waiting";
  return undefined;
}

async function runWatch(
  args: readonly string[],
  options: HeadlessCaptainCommandOptions,
  quiet: boolean,
): Promise<number> {
  const timeoutMs = parseTimeout(args);
  const env = options.env ?? process.env;
  const host = commandHost(options);
  return await withHeadlessLock(env, async () => {
    const store = new CaptainSessionCursorStore(headlessCaptainCursorPath(env));
    const stored = await store.read();
    if (stored === undefined || !stored.active || stored.sessionId === undefined) {
      outputJson(options.stdout ?? process.stdout, { ok: true, status: "idle" });
      return 0;
    }
    const record = readCaptainServiceRecord(captainServiceStatePath(env), host);
    const connected = await connectCaptain({
      host,
      ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
      ...(record?.generation === undefined ? {} : { generation: record.generation }),
    });
    const cursor = normalizeCursor(stored, connected.generation, false);
    const controller = new AbortController();
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort();
          }, timeoutMs);
    let nextIndex = cursor.streamIndex;
    let boundary: "completed" | "failed" | "waiting" | undefined;
    try {
      for await (const event of connected.client.session(cursor).stream({
        startIndex: cursor.streamIndex,
        signal: controller.signal,
      })) {
        nextIndex += 1;
        if (!quiet) outputJson(options.stdout ?? process.stdout, event);
        boundary = boundaryState(event);
        if (boundary === "failed") {
          await store.write(emptyCaptainCursor(connected.generation));
        } else {
          await store.write({ ...cursor, active: boundary === undefined, streamIndex: nextIndex });
        }
        if (isCurrentTurnBoundaryEvent(event)) break;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        outputJson(options.stderr ?? process.stderr, {
          ok: false,
          status: "timeout",
          sessionId: cursor.sessionId,
        });
        return 124;
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (boundary === undefined) {
      throw new Error("Captain event stream ended before the turn reached a boundary.");
    }
    outputJson(options.stdout ?? process.stdout, {
      ok: boundary !== "failed",
      status: boundary,
      sessionId: cursor.sessionId,
      streamIndex: nextIndex,
    });
    return boundary === "failed" ? 1 : 0;
  });
}

export async function runHeadlessCaptainCommand(
  args: readonly string[],
  options: HeadlessCaptainCommandOptions,
): Promise<number> {
  const command = args[0];
  try {
    if (command === "health" || command === "status") return await runInspection(options);
    if (command === "restart") return await runRestart(options);
    if (command === "msg") return await runMessage(args.slice(1), options);
    if (command === "watch") return await runWatch(args.slice(1), options, false);
    if (command === "wait") return await runWatch(args.slice(1), options, true);
    if (command === "help" || command === "--help" || command === "-h") {
      (options.stdout ?? process.stdout).write(`${commandHelp()}\n`);
      return 0;
    }
    throw new Error(commandHelp());
  } catch (error) {
    (options.stderr ?? process.stderr).write(
      `clankie: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
