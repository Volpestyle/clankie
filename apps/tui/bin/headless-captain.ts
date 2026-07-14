import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  inspectOperatorCredential,
  resolveOperatorCredential,
  rotateOperatorCredential,
  type CredentialStore,
  type OperatorCredentialStatus,
} from "@clankie/credential-broker";
import { Client, isCurrentTurnBoundaryEvent, type HandleMessageStreamEvent } from "eve/client";
import QRCode from "qrcode";
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
  reportHerdrAgent,
  reportHerdrMetadata,
  type HerdrCommandRunner,
} from "../src/session/herdr-report.ts";
import {
  CaptainSessionCursorStore,
  emptyCaptainCursor,
  type CaptainSessionCursor,
  type StoredCaptainSessionCursor,
} from "../src/session/session-cursor.ts";
import { emptyTraceCursor, TraceCursorStore } from "../src/session/trace-cursor.ts";
import { formatTraceLines, renderTraceEvent, type TraceRenderMode } from "../src/session/trace-renderer.ts";
import { parseTraceLane, type TraceCursor, type TraceLane } from "../src/session/trace-types.ts";
import {
  DEFAULT_CONTROL_PLANE_URL,
  pairingFailureMessage,
  PairingOfferError,
  requestPairingOffer,
  type PairingOffer,
  type PairingOfferStatus,
} from "./pairing-offer.ts";
import {
  DevicesCommandError,
  devicesFailureMessage,
  grantSummary,
  listDevices,
  revokeDevice,
  type DeviceListItem,
} from "./devices.ts";

const HEADLESS_CURSOR_NAME = "captain-headless-session.json";
const HEADLESS_LOCK_NAME = "captain-headless-session.lock";
const TRACE_CURSOR_NAME = "captain-trace-session.json";
/** Default typed lane for the HTTP headless captain session (captain-eve channel mapping). */
const DEFAULT_TRACE_LANE: TraceLane = "tui";
const TRACE_IDLE_POLL_MS = 500;

type Writable = { write(chunk: string): unknown };

export interface HeadlessCaptainCommandOptions {
  readonly clientFactory?: (host: string) => Client;
  readonly ensureImpl?: (options: EnsureCaptainServiceOptions) => Promise<CaptainServiceHandle>;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly host?: string;
  readonly herdrRunCommand?: HerdrCommandRunner;
  readonly maxTraceEvents?: number;
  readonly operatorCredentialStore?: CredentialStore;
  readonly readStdin?: () => Promise<string>;
  readonly repoRoot: string;
  readonly restartImpl?: (options: RestartCaptainServiceOptions) => Promise<CaptainServiceHandle>;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly stderr?: Writable;
  readonly stdout?: Writable;
  /** Test hook: stop the long-lived trace loop after the current stream ends. */
  readonly traceOnce?: boolean;
}

export function headlessCaptainCursorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(captainStateDirectory(env), HEADLESS_CURSOR_NAME);
}

export function traceCaptainCursorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(captainStateDirectory(env), TRACE_CURSOR_NAME);
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
    "  trace [--json] [--lane LANE] [--timeout SEC]",
    "                           Live render-only reasoning/tool stream (stays across turns)",
    "  pair [--json] [--timeout SEC]",
    "                           Show a one-time QR + code to pair a device",
    "  devices [--json]         List paired devices",
    "  devices revoke <id> [--json]",
    "                           Revoke a device's access",
    "  operator-credential rotate [--json]",
    "                           Rotate the local operator credential",
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
    command === "trace" ||
    command === "pair" ||
    command === "devices" ||
    command === "operator-credential" ||
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
  let operatorCredential:
    | OperatorCredentialStatus
    | { readonly present: false; readonly source: "none"; readonly consistency: "invalid" };
  try {
    operatorCredential = await inspectOperatorCredential({
      env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
  } catch {
    operatorCredential = { present: false, source: "none", consistency: "invalid" };
  }
  const operatorCredentialHealthy =
    operatorCredential.present && operatorCredential.consistency !== "mismatch";
  outputJson(options.stdout ?? process.stdout, {
    ok: inspection.state === "healthy" && operatorCredentialHealthy,
    status:
      inspection.state !== "healthy"
        ? inspection.state
        : operatorCredentialHealthy
          ? "ready"
          : `operator_credential_${operatorCredential.consistency}`,
    endpointState: inspection.state,
    host,
    healthPath: inspection.healthPath,
    infoPath: inspection.infoPath,
    ...(inspection.agent === undefined ? {} : { agent: inspection.agent }),
    ...(record?.generation === undefined && inspection.generation === undefined
      ? {}
      : { generation: record?.generation ?? inspection.generation }),
    owned: record !== undefined,
    operatorCredential,
    ...(record === undefined ? {} : { pid: record.pid }),
  });
  return inspection.state === "healthy" && operatorCredentialHealthy ? 0 : 1;
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

interface TraceCliOptions {
  readonly json: boolean;
  readonly lane: TraceLane;
  readonly timeoutMs: number | undefined;
}

function parseTraceArgs(args: readonly string[]): TraceCliOptions {
  let json = false;
  let lane: TraceLane = DEFAULT_TRACE_LANE;
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--lane") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("Usage: clankie trace [--json] [--lane LANE] [--timeout SEC]");
      lane = parseTraceLane(value);
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("Usage: clankie trace [--json] [--lane LANE] [--timeout SEC]");
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Timeout must be a positive number.");
      timeoutMs = seconds * 1_000;
      index += 1;
      continue;
    }
    throw new Error("Usage: clankie trace [--json] [--lane LANE] [--timeout SEC]");
  }
  return { json, lane, timeoutMs };
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

/**
 * Consume one Eve session event stream without exiting on turn boundaries.
 * Advances only the identity-only trace cursor; never writes event payloads.
 * Returns the updated cursor and how many events were observed.
 */
export async function processTraceStream(input: {
  readonly events: AsyncIterable<HandleMessageStreamEvent>;
  readonly cursor: TraceCursor;
  readonly mode: TraceRenderMode;
  readonly write: (line: string) => void;
  readonly onCursor?: (cursor: TraceCursor) => Promise<void>;
  readonly maxEvents?: number;
  readonly signal?: AbortSignal;
}): Promise<{ cursor: TraceCursor; eventsSeen: number; hitBoundary: boolean }> {
  let cursor = input.cursor;
  let eventsSeen = 0;
  let hitBoundary = false;
  for await (const event of input.events) {
    if (input.signal?.aborted) break;
    eventsSeen += 1;
    const nextIndex = cursor.streamIndex + 1;
    const boundary = boundaryState(event);
    if (boundary !== undefined) hitBoundary = true;
    // Stay subscribed across turn settle: active reflects turn state only.
    cursor = {
      version: 1,
      generation: cursor.generation,
      streamIndex: nextIndex,
      lane: cursor.lane,
      active: boundary === undefined,
      ...(cursor.sessionId === undefined ? {} : { sessionId: cursor.sessionId }),
    };
    const lines = formatTraceLines(
      renderTraceEvent({
        lane: cursor.lane,
        event,
        ...(cursor.sessionId === undefined ? {} : { sessionId: cursor.sessionId }),
        streamIndex: nextIndex,
      }),
      input.mode,
    );
    for (const line of lines) input.write(`${line}\n`);
    if (input.onCursor !== undefined) await input.onCursor(cursor);
    // Unlike watch/wait, never break on isCurrentTurnBoundaryEvent.
    if (input.maxEvents !== undefined && eventsSeen >= input.maxEvents) break;
  }
  return { cursor, eventsSeen, hitBoundary };
}

async function resolveTraceSession(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly generation: string;
  readonly lane: TraceLane;
  readonly store: TraceCursorStore;
}): Promise<TraceCursor> {
  const stored = await input.store.read();
  if (stored !== undefined && stored.generation === input.generation && stored.sessionId !== undefined) {
    return { ...stored, lane: input.lane };
  }
  // Adopt the active headless session identity (session id only — no payloads).
  const headless = await new CaptainSessionCursorStore(headlessCaptainCursorPath(input.env)).read();
  if (
    headless?.sessionId !== undefined &&
    (headless.version !== 2 || headless.generation === input.generation)
  ) {
    return {
      version: 1,
      generation: input.generation,
      sessionId: headless.sessionId,
      streamIndex: stored?.sessionId === headless.sessionId ? (stored.streamIndex ?? 0) : 0,
      lane: input.lane,
      active: headless.active,
    };
  }
  if (stored !== undefined && stored.generation === input.generation) {
    return { ...stored, lane: input.lane };
  }
  return emptyTraceCursor(input.generation, input.lane);
}

async function runTrace(args: readonly string[], options: HeadlessCaptainCommandOptions): Promise<number> {
  const cli = parseTraceArgs(args);
  const env = options.env ?? process.env;
  const host = commandHost(options);
  const stdout = options.stdout ?? process.stdout;
  const mode: TraceRenderMode = cli.json ? "json" : "human";
  const delay = options.sleepImpl ?? sleep;
  const store = new TraceCursorStore(traceCaptainCursorPath(env));

  const record = readCaptainServiceRecord(captainServiceStatePath(env), host);
  const connected = await connectCaptain({
    host,
    ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
    ...(record?.generation === undefined ? {} : { generation: record.generation }),
  });

  let cursor = await resolveTraceSession({
    env,
    generation: connected.generation,
    lane: cli.lane,
    store,
  });
  await store.write(cursor);

  const herdrOpts = {
    env,
    ...(options.herdrRunCommand === undefined ? {} : { runCommand: options.herdrRunCommand }),
  };
  await reportHerdrMetadata({
    ...herdrOpts,
    title: "clankie trace",
    customStatus: `lane=${cursor.lane}`,
    agent: "clankie-trace",
  });
  await reportHerdrAgent("working", {
    ...herdrOpts,
    message: "tracing captain session stream",
  });

  const controller = new AbortController();
  const timer =
    cli.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort();
        }, cli.timeoutMs);

  let totalEvents = 0;
  try {
    while (!controller.signal.aborted) {
      if (cursor.sessionId === undefined) {
        cursor = await resolveTraceSession({
          env,
          generation: connected.generation,
          lane: cli.lane,
          store,
        });
        if (cursor.sessionId === undefined) {
          if (options.traceOnce === true) break;
          await delay(TRACE_IDLE_POLL_MS);
          continue;
        }
        await store.write(cursor);
      }

      const sessionState = {
        streamIndex: cursor.streamIndex,
        sessionId: cursor.sessionId,
      };
      try {
        const result = await processTraceStream({
          events: connected.client.session(sessionState).stream({
            startIndex: cursor.streamIndex,
            signal: controller.signal,
          }),
          cursor,
          mode,
          write: (line) => {
            stdout.write(line);
          },
          onCursor: async (next) => {
            cursor = next;
            await store.write(next);
          },
          ...(options.maxTraceEvents === undefined
            ? {}
            : { maxEvents: Math.max(0, options.maxTraceEvents - totalEvents) }),
          signal: controller.signal,
        });
        cursor = result.cursor;
        totalEvents += result.eventsSeen;
        await store.write(cursor);
        if (options.maxTraceEvents !== undefined && totalEvents >= options.maxTraceEvents) break;
        if (options.traceOnce === true) break;
        if (controller.signal.aborted) break;
        // Stream ended: reconnect with identity-only cursor (no payload on disk).
        await delay(TRACE_IDLE_POLL_MS);
        // Re-adopt headless session if a new turn started under a new session id.
        const refreshed = await resolveTraceSession({
          env,
          generation: connected.generation,
          lane: cli.lane,
          store,
        });
        if (refreshed.sessionId !== cursor.sessionId) {
          cursor = refreshed;
          await store.write(cursor);
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        throw error;
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await reportHerdrAgent(controller.signal.aborted ? "idle" : "idle", {
      ...herdrOpts,
      message: "trace stopped",
    }).catch(() => undefined);
  }

  if (controller.signal.aborted && cli.timeoutMs !== undefined) {
    outputJson(options.stderr ?? process.stderr, {
      ok: false,
      status: "timeout",
      ...(cursor.sessionId === undefined ? {} : { sessionId: cursor.sessionId }),
    });
    return 124;
  }
  return 0;
}

interface PairCliOptions {
  readonly json: boolean;
  readonly timeoutMs: number;
}

const DEFAULT_PAIR_TIMEOUT_MS = 10_000;
const PAIR_USAGE = "Usage: clankie pair [--json] [--timeout SEC]";

function parsePairArgs(args: readonly string[]): PairCliOptions {
  let json = false;
  let timeoutMs = DEFAULT_PAIR_TIMEOUT_MS;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--timeout") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(PAIR_USAGE);
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Timeout must be a positive number.");
      timeoutMs = seconds * 1_000;
      index += 1;
      continue;
    }
    throw new Error(PAIR_USAGE);
  }
  return { json, timeoutMs };
}

/**
 * `clankie pair` — request one short-lived, single-use pairing offer from the
 * platform pairing service and render a scannable QR plus a copyable code/deep
 * link. Fully headless: no captain/model session, no TTY requirement. Fails
 * closed on every error path with an actionable, secret-free message. The QR,
 * code, and deep link are secret-bearing display data — written to stdout for
 * the operator, never logged, persisted, or echoed into error output.
 */
async function runPair(args: readonly string[], options: HeadlessCaptainCommandOptions): Promise<number> {
  const { json, timeoutMs } = parsePairArgs(args);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const controlPlaneUrl = env.CLANKIE_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL;
  const operatorCredential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let offer: PairingOffer;
  try {
    offer = await requestPairingOffer({
      controlPlaneUrl,
      operatorToken: operatorCredential?.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      signal: controller.signal,
    });
  } catch (error) {
    const status: PairingOfferStatus = error instanceof PairingOfferError ? error.status : "unavailable";
    const message = error instanceof PairingOfferError ? error.message : pairingFailureMessage("unavailable");
    if (json) outputJson(stdout, { ok: false, status, error: message });
    else stderr.write(`clankie: ${message}\n`);
    return 1;
  } finally {
    clearTimeout(timer);
  }

  if (json) {
    outputJson(stdout, { ok: true, code: offer.code, deepLink: offer.deepLink, expiresAt: offer.expiresAt });
    return 0;
  }

  const qr = await QRCode.toString(offer.deepLink, { type: "terminal", small: true });
  stdout.write(
    [
      "Scan this QR with the Clankie app to pair this device:",
      "",
      qr,
      `Pairing code: ${offer.code}`,
      "Or open this link on the device:",
      offer.deepLink,
      `Expires ${offer.expiresAt} · single use — run \`clankie pair\` again for a new offer.`,
      "",
    ].join("\n"),
  );
  return 0;
}

const DEVICES_USAGE = "Usage: clankie devices [--json] | clankie devices revoke <id> [--json]";
const DEFAULT_DEVICES_TIMEOUT_MS = 10_000;

type DevicesCliOptions =
  | { readonly json: boolean; readonly subcommand: "list" }
  | { readonly json: boolean; readonly subcommand: "revoke"; readonly deviceId: string };

function parseDevicesArgs(args: readonly string[]): DevicesCliOptions {
  let json = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length === 0) return { json, subcommand: "list" };
  if (positional[0] === "revoke") {
    const deviceId = positional[1];
    if (deviceId === undefined || positional.length > 2) throw new Error(DEVICES_USAGE);
    return { json, subcommand: "revoke", deviceId };
  }
  throw new Error(DEVICES_USAGE);
}

/**
 * `clankie devices` — list paired devices, or `clankie devices revoke <id>`.
 * Operator-authenticated against the control plane, fully headless, fails closed
 * with actionable, secret-free messages.
 */
async function runDevices(args: readonly string[], options: HeadlessCaptainCommandOptions): Promise<number> {
  const parsed = parseDevicesArgs(args);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const controlPlaneUrl = env.CLANKIE_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL;
  const operatorCredential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_DEVICES_TIMEOUT_MS);
  const request = {
    controlPlaneUrl,
    operatorToken: operatorCredential?.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    signal: controller.signal,
  };
  try {
    if (parsed.subcommand === "revoke") {
      const device = await revokeDevice(parsed.deviceId, request);
      if (parsed.json) outputJson(stdout, { ok: true, device });
      else stdout.write(`Revoked ${device.deviceId} (${device.name}).\n`);
      return 0;
    }
    const devices = await listDevices(request);
    if (parsed.json) outputJson(stdout, { ok: true, devices });
    else stdout.write(`${formatDevicesTable(devices)}\n`);
    return 0;
  } catch (error) {
    const status = error instanceof DevicesCommandError ? error.status : "unavailable";
    const message =
      error instanceof DevicesCommandError ? error.message : devicesFailureMessage("unavailable");
    if (parsed.json) outputJson(stdout, { ok: false, status, error: message });
    else stderr.write(`clankie: ${message}\n`);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

const OPERATOR_CREDENTIAL_USAGE = "Usage: clankie operator-credential rotate [--json]";

async function runOperatorCredential(
  args: readonly string[],
  options: HeadlessCaptainCommandOptions,
): Promise<number> {
  const json = args.includes("--json");
  if (args[0] !== "rotate" || args.some((arg) => arg !== "rotate" && arg !== "--json")) {
    throw new Error(OPERATOR_CREDENTIAL_USAGE);
  }
  const env = options.env ?? process.env;
  const credential = await rotateOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  const output = options.stdout ?? process.stdout;
  if (json) outputJson(output, { ok: true, status: "rotated", source: credential.source });
  else output.write("Operator credential rotated. Existing operator sessions are invalidated.\n");
  return 0;
}

function formatDevicesTable(devices: readonly DeviceListItem[]): string {
  if (devices.length === 0) return "No paired devices.";
  const header = ["DEVICE", "NAME", "PLATFORM", "STATUS", "GRANTS", "PAIRED"] as const;
  const rows = devices.map((device) => [
    device.deviceId,
    device.name,
    device.platform,
    device.status,
    grantSummary(device),
    device.activatedAt ?? device.createdAt,
  ]);
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [renderRow(header), ...rows.map(renderRow)].join("\n");
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
    if (command === "trace") return await runTrace(args.slice(1), options);
    if (command === "pair") return await runPair(args.slice(1), options);
    if (command === "devices") return await runDevices(args.slice(1), options);
    if (command === "operator-credential") {
      return await runOperatorCredential(args.slice(1), options);
    }
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
