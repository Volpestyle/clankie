import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ensureCaptainCredential,
  inspectOperatorCredential,
  resolveOperatorCredential,
  rotateOperatorCredential,
  type CredentialStore,
  type OperatorCredentialStatus,
} from "@clankie/credential-broker";
import QRCode from "qrcode";
import {
  inspectServices,
  parseServiceTarget,
  restartTarget,
  stopTarget,
  type ServiceOutcome,
  type ServiceRegistryOptions,
  type ServiceTarget,
} from "./services.ts";
import { clankieStateDirectory, SERVICE_ORDER } from "./service-supervisor.ts";
import type { CaptainSessionClient, CaptainStreamEvent } from "../src/session/captain-stream.ts";
import {
  reportHerdrAgent,
  reportHerdrMetadata,
  type HerdrCommandRunner,
} from "../src/session/herdr-report.ts";
import { CaptainSessionCursorStore } from "../src/session/session-cursor.ts";
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
const TRACE_CURSOR_NAME = "captain-trace-session.json";
/**
 * Legacy state record carrying the captain build generation the trace cursor is
 * versioned by. The pi service has no build generation, so nothing writes this
 * anymore; a live trace transport supplies it through tests or future tooling.
 */
const CAPTAIN_SERVICE_STATE_NAME = "captain-eve-service.json";
/** Default typed lane for the headless captain session. */
const DEFAULT_TRACE_LANE: TraceLane = "tui";
const TRACE_IDLE_POLL_MS = 500;
const RESTART_TURN_POLL_MS = 100;
const RESTART_AFTER_TURN_FLAG = "--after-operator-turn";

type Writable = { write(chunk: string): unknown };

export interface HeadlessCaptainCommandOptions {
  /** Trace transport seam. The clankie service exposes no session stream yet. */
  readonly clientFactory?: (host: string) => CaptainSessionClient;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly host?: string;
  readonly herdrRunCommand?: HerdrCommandRunner;
  readonly maxTraceEvents?: number;
  readonly operatorCredentialStore?: CredentialStore;
  /** Test seam for the brokered captain bearer the launcher injects. */
  readonly captainCredentialStore?: CredentialStore;
  /**
   * Test seam for the process-table scan. Without it a service probe reads the
   * real machine, so a developer with a live bridge running sees a different
   * status than CI does.
   */
  readonly listProcessCommandsImpl?: () => readonly (readonly [number, string])[];
  readonly repoRoot: string;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly spawnImpl?: ServiceRegistryOptions["spawnImpl"];
  readonly killImpl?: ServiceRegistryOptions["killImpl"];
  readonly processIsAliveImpl?: ServiceRegistryOptions["processIsAliveImpl"];
  readonly readProcessCommandImpl?: ServiceRegistryOptions["readProcessCommandImpl"];
  /** Test seam for the executable a deferred self-restart launches. */
  readonly cliEntryPath?: string;
  readonly stderr?: Writable;
  readonly stdout?: Writable;
  /** Test hook: stop the long-lived trace loop after the current stream ends. */
  readonly traceOnce?: boolean;
}

export function headlessCaptainCursorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(clankieStateDirectory(env), HEADLESS_CURSOR_NAME);
}

export function traceCaptainCursorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(clankieStateDirectory(env), TRACE_CURSOR_NAME);
}

/** Reads the legacy captain service record for its trace-cursor generation. */
function readTraceGeneration(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const record = JSON.parse(
      readFileSync(join(clankieStateDirectory(env), CAPTAIN_SERVICE_STATE_NAME), "utf8"),
    ) as { generation?: unknown };
    return typeof record.generation === "string" && /^[a-f0-9]{64}$/u.test(record.generation)
      ? record.generation
      : undefined;
  } catch {
    return undefined;
  }
}

function outputJson(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function commandHelp(): string {
  return [
    "Usage: clankie <command>",
    "",
    "Headless Clankie commands:",
    "  health | status          Probe the clankie service and every local service",
    "  restart [service]        Restart launcher-owned services in dependency order",
    "  down [service]           Stop launcher-owned services in reverse order",
    "  trace [--json] [--lane LANE] [--timeout SEC]",
    "                           Live render-only reasoning/tool stream (stays across turns)",
    "  pair [--json] [--timeout SEC]",
    "                           Show a one-time QR + code to pair a device",
    "  devices [--json]         List paired devices",
    "  devices revoke <id> [--json]",
    "                           Revoke a device's access",
    "  operator-credential rotate [--json]",
    "                           Rotate the local operator credential",
    "  play status              Show the live embodiment (asked play) session",
    "  play stop                Stop the live playthrough cleanly (mints its checkpoint)",
    "",
    "Services for restart/down: all (default), clankie, discord, user-session, activity, tunnel",
    "Aliases: captain, eve, cp, control-plane, bridge, lab, watch, viewer, cloudflared",
    "",
    "With no command, clankie opens the fullscreen operator console and requires a TTY.",
  ].join("\n");
}

export function isHeadlessCaptainCommand(command: string | undefined): boolean {
  return (
    command === "health" ||
    command === "status" ||
    command === "restart" ||
    command === "down" ||
    command === "trace" ||
    command === "pair" ||
    command === "devices" ||
    command === "operator-credential" ||
    command === "play" ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  );
}

function commandHost(options: HeadlessCaptainCommandOptions): string {
  const env = options.env ?? process.env;
  return (
    options.host ?? env.CLANKIE_CONTROL_PLANE_URL ?? env.CLANKIE_CAPTAIN_URL ?? DEFAULT_CONTROL_PLANE_URL
  );
}

async function runInspection(options: HeadlessCaptainCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
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
  // Every local service: the clankie service itself, the bridge, and the
  // surfaces an audience actually reaches — the activity and the tunnel
  // publishing it. Health used to stop earlier, which is how a tunnel stayed
  // dead for six days while health said ready.
  const services = await inspectServices(SERVICE_ORDER, await serviceOptions(options));
  const clankie = services.find((service) => service.id === "clankie");
  const serviceHealthy = clankie?.state === "healthy";
  outputJson(options.stdout ?? process.stdout, {
    ok: serviceHealthy && operatorCredentialHealthy,
    status: !serviceHealthy
      ? (clankie?.state ?? "unreachable")
      : operatorCredentialHealthy
        ? "ready"
        : `operator_credential_${operatorCredential.consistency}`,
    host: commandHost(options),
    ...(clankie === undefined ? {} : { owned: clankie.owned }),
    ...(clankie?.pid === undefined ? {} : { pid: clankie.pid }),
    operatorCredential,
    services,
  });
  return serviceHealthy && operatorCredentialHealthy ? 0 : 1;
}

/**
 * Shared plumbing for the service commands. The operator credential is optional
 * and only enriches the bridge's presence detail, so a missing one degrades the
 * report rather than failing the restart.
 *
 * The captain credential is different in kind: it is one shared secret the
 * dispatch route authenticates, so it is minted on first run rather than merely
 * read. It is handed to each service through `serviceEnv` because the Discord
 * bridge refuses to start when it can see that variable.
 */
async function serviceOptions(options: HeadlessCaptainCommandOptions): Promise<ServiceRegistryOptions> {
  const env = options.env ?? process.env;
  let operatorToken: string | undefined;
  try {
    const credential = await resolveOperatorCredential({
      env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
    operatorToken = credential?.token;
  } catch {
    operatorToken = undefined;
  }
  let captainToken: string | undefined;
  try {
    const credential = await ensureCaptainCredential({
      env,
      ...(options.captainCredentialStore === undefined ? {} : { store: options.captainCredentialStore }),
    });
    captainToken = credential.token;
  } catch {
    // A stack whose captain cannot authenticate is degraded, not dead: presence,
    // health, and every operator-authenticated surface still work. Failing the
    // restart outright would be a worse trade than starting without it.
    captainToken = undefined;
  }
  const stderr = options.stderr ?? process.stderr;
  return {
    repoRoot: options.repoRoot,
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    operatorToken,
    captainToken,
    ...(options.listProcessCommandsImpl === undefined
      ? {}
      : { listProcessCommandsImpl: options.listProcessCommandsImpl }),
    ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
    ...(options.killImpl === undefined ? {} : { killImpl: options.killImpl }),
    ...(options.processIsAliveImpl === undefined ? {} : { processIsAliveImpl: options.processIsAliveImpl }),
    ...(options.readProcessCommandImpl === undefined
      ? {}
      : { readProcessCommandImpl: options.readProcessCommandImpl }),
    // Progress narration goes to stderr so stdout stays a clean JSON document.
    onStatus: (status: string) => stderr.write(`${status}\n`),
  };
}

function describeOutcomes(outcomes: readonly ServiceOutcome[]): string {
  return outcomes
    .map((outcome) =>
      outcome.ok
        ? `✓ ${outcome.label}${outcome.detail === undefined ? "" : ` (${outcome.detail})`}`
        : `✗ ${outcome.label}: ${outcome.error ?? outcome.state ?? "failed"}`,
    )
    .join("\n");
}

interface RestartTurnHandoff {
  readonly eventsPath: string;
  readonly runId: string;
}

function turnPhases(eventsPath: string): Map<string, string> {
  const phases = new Map<string, string>();
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (line.length === 0) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; runId?: unknown; phase?: unknown };
      if (event.type === "turn" && typeof event.runId === "string" && typeof event.phase === "string") {
        phases.set(event.runId, event.phase);
      }
    } catch {
      // A trailing partial append is not a durable event yet; the next poll sees it.
    }
  }
  return phases;
}

/** Pi's built-in bash tool exposes its durable session file to every command. */
function activeOperatorTurn(env: NodeJS.ProcessEnv): RestartTurnHandoff | undefined {
  const sessionFile = env.PI_SESSION_FILE?.trim();
  if (sessionFile === undefined || sessionFile.length === 0) return undefined;
  const piDirectory = dirname(sessionFile);
  if (basename(piDirectory) !== "pi") return undefined;
  const eventsPath = join(dirname(piDirectory), "events.jsonl");
  try {
    const active = [...turnPhases(eventsPath)].find(([, phase]) => phase === "accepted");
    return active === undefined ? undefined : { eventsPath, runId: active[0] };
  } catch {
    return undefined;
  }
}

function restartIncludesClankie(target: ServiceTarget): boolean {
  return target === "all" || target === "clankie";
}

async function waitForOperatorTurn(
  handoff: RestartTurnHandoff,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<void> {
  // ponytail: short-lived whole-log scan; keep a byte cursor if conversation logs make this measurable.
  for (;;) {
    const phase = turnPhases(handoff.eventsPath).get(handoff.runId);
    if (phase === "completed" || phase === "failed" || phase === "cancelled") return;
    await sleepImpl(RESTART_TURN_POLL_MS);
  }
}

function scheduleRestartAfterTurn(
  target: ServiceTarget,
  handoff: RestartTurnHandoff,
  options: HeadlessCaptainCommandOptions,
): void {
  const cliEntryPath = options.cliEntryPath ?? process.argv[1];
  if (cliEntryPath === undefined || cliEntryPath.length === 0) {
    throw new Error("Cannot locate the clankie launcher for a deferred restart.");
  }
  const env = { ...(options.env ?? process.env) };
  delete env.PI_SESSION_FILE;
  delete env.PI_SESSION_ID;
  const child = (options.spawnImpl ?? spawn)(
    cliEntryPath,
    ["restart", target, RESTART_AFTER_TURN_FLAG, handoff.eventsPath, handoff.runId],
    { detached: true, env, stdio: "ignore" },
  );
  if (child.pid === undefined) throw new Error("Deferred restart helper did not start.");
  child.unref();
}

async function runRestart(args: readonly string[], options: HeadlessCaptainCommandOptions): Promise<number> {
  const target = parseServiceTarget(args[0]);
  const afterTurn =
    args[1] === RESTART_AFTER_TURN_FLAG && args[2] !== undefined && args[3] !== undefined
      ? { eventsPath: args[2], runId: args[3] }
      : undefined;
  if (args.length > 1 && afterTurn === undefined) {
    throw new Error("Usage: clankie restart [service]");
  }
  if (afterTurn !== undefined) {
    await waitForOperatorTurn(afterTurn, options.sleepImpl ?? sleep);
  } else if (restartIncludesClankie(target)) {
    const activeTurn = activeOperatorTurn(options.env ?? process.env);
    if (activeTurn !== undefined) {
      scheduleRestartAfterTurn(target, activeTurn, options);
      (options.stderr ?? process.stderr).write("Restart scheduled after this conversation turn completes.\n");
      outputJson(options.stdout ?? process.stdout, {
        ok: true,
        status: "scheduled",
        target,
        host: commandHost(options),
        afterRun: activeTurn.runId,
      });
      return 0;
    }
  }
  const registryOptions = await serviceOptions(options);
  const outcomes = await restartTarget(target, registryOptions);
  const clankie = outcomes.find((outcome) => outcome.id === "clankie");
  const ok = outcomes.length > 0 && outcomes.every((outcome) => outcome.ok);
  (options.stderr ?? process.stderr).write(`${describeOutcomes(outcomes)}\n`);
  outputJson(options.stdout ?? process.stdout, {
    ok,
    status: ok ? "ready" : "failed",
    target,
    host: commandHost(options),
    ...(clankie === undefined ? {} : { owned: clankie.ok }),
    services: outcomes,
  });
  return ok ? 0 : 1;
}

async function runDown(args: readonly string[], options: HeadlessCaptainCommandOptions): Promise<number> {
  const target = parseServiceTarget(args[0]);
  const outcomes = await stopTarget(target, await serviceOptions(options));
  const ok = outcomes.every((outcome) => outcome.ok);
  (options.stderr ?? process.stderr).write(`${describeOutcomes(outcomes)}\n`);
  outputJson(options.stdout ?? process.stdout, {
    ok,
    status: ok ? "stopped" : "failed",
    target,
    services: outcomes,
  });
  return ok ? 0 : 1;
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

function boundaryState(event: CaptainStreamEvent): "completed" | "failed" | "waiting" | undefined {
  if (event.type === "session.completed") return "completed";
  if (event.type === "session.failed") return "failed";
  if (event.type === "session.waiting") return "waiting";
  return undefined;
}

/**
 * Consume one captain session event stream without exiting on turn boundaries.
 * Advances only the identity-only trace cursor; never writes event payloads.
 * Returns the updated cursor and how many events were observed.
 */
export async function processTraceStream(input: {
  readonly events: AsyncIterable<CaptainStreamEvent>;
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
    // A boundary settles the turn but never ends the trace subscription.
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

function unavailableTraceClient(): CaptainSessionClient {
  return {
    session: () => ({
      // eslint-disable-next-line require-yield
      stream: async function* (): AsyncIterable<CaptainStreamEvent> {
        throw new Error(
          "The clankie service does not expose a captain session stream yet; `clankie trace` has no live transport.",
        );
      },
    }),
  };
}

async function runTrace(args: readonly string[], options: HeadlessCaptainCommandOptions): Promise<number> {
  const cli = parseTraceArgs(args);
  const env = options.env ?? process.env;
  const host = commandHost(options);
  const stdout = options.stdout ?? process.stdout;
  const mode: TraceRenderMode = cli.json ? "json" : "human";
  const delay = options.sleepImpl ?? sleep;
  const store = new TraceCursorStore(traceCaptainCursorPath(env));

  const generation = readTraceGeneration(env);
  if (generation === undefined) {
    throw new Error(
      "No captain service record with a build generation exists; live session tracing is unavailable.",
    );
  }
  const client = (options.clientFactory ?? unavailableTraceClient)(host);

  let cursor = await resolveTraceSession({ env, generation, lane: cli.lane, store });
  await store.write(cursor);

  const herdrOpts = {
    env,
    ...(options.herdrRunCommand === undefined ? {} : { runCommand: options.herdrRunCommand }),
  };
  await reportHerdrMetadata({
    ...herdrOpts,
    title: "clankie trace",
    token: `lane=${cursor.lane}`,
    agent: "clankie-trace",
  });
  await reportHerdrAgent("working", {
    ...herdrOpts,
    message: "tracing Clankie session stream",
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
        cursor = await resolveTraceSession({ env, generation, lane: cli.lane, store });
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
          events: client.session(sessionState).stream({
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
        // Re-adopt the headless session if a new turn started under a new session id.
        const refreshed = await resolveTraceSession({ env, generation, lane: cli.lane, store });
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
    await reportHerdrAgent("idle", {
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
 * clankie service and render a scannable QR plus a copyable code/deep link.
 * Fully headless: no captain session, no TTY requirement. Fails closed on every
 * error path with an actionable, secret-free message. The QR, code, and deep
 * link are secret-bearing display data — written to stdout for the operator,
 * never logged, persisted, or echoed into error output.
 */
async function runPair(args: readonly string[], options: HeadlessCaptainCommandOptions): Promise<number> {
  const { json, timeoutMs } = parsePairArgs(args);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const controlPlaneUrl = commandHost({ ...options, env });
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
 * Operator-authenticated against the clankie service, fully headless, fails
 * closed with actionable, secret-free messages.
 */
async function runDevices(args: readonly string[], options: HeadlessCaptainCommandOptions): Promise<number> {
  const parsed = parseDevicesArgs(args);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const controlPlaneUrl = commandHost({ ...options, env });
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

/**
 * Operator controls for the live playthrough (asked play, ADR 0063).
 * `status` reads the live embodiment session; `stop` submits the operator
 * stop intent — the kill-switch that never needs Discord, and never a kill:
 * the runner winds down at the next turn boundary and mints its checkpoint.
 */
async function runPlay(args: readonly string[], options: HeadlessCaptainCommandOptions): Promise<number> {
  const action = args[0];
  if (action !== "status" && action !== "stop") {
    throw new Error("Usage: clankie play <status|stop>");
  }
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  const token = credential?.token;
  if (token === undefined) {
    throw new Error("No operator credential is available; start the clankie service once first.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = commandHost({ ...options, env });
  const stdout = options.stdout ?? process.stdout;
  if (action === "status") {
    const response = await fetchImpl(new URL("/v1/embodiment/sessions/live", base), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`clankie service returned ${String(response.status)}`);
    outputJson(stdout, await response.json());
    return 0;
  }
  const response = await fetchImpl(new URL("/v1/embodiment/sessions/live/stop", base), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) {
    stdout.write("Nothing is playing.\n");
    return 0;
  }
  if (!response.ok) {
    throw new Error(`clankie service returned ${String(response.status)}: ${await response.text()}`);
  }
  outputJson(stdout, await response.json());
  return 0;
}

export async function runHeadlessCaptainCommand(
  args: readonly string[],
  options: HeadlessCaptainCommandOptions,
): Promise<number> {
  const command = args[0];
  try {
    if (command === "health" || command === "status") return await runInspection(options);
    if (command === "restart") return await runRestart(args.slice(1), options);
    if (command === "down") return await runDown(args.slice(1), options);
    if (command === "trace") return await runTrace(args.slice(1), options);
    if (command === "pair") return await runPair(args.slice(1), options);
    if (command === "devices") return await runDevices(args.slice(1), options);
    if (command === "operator-credential") {
      return await runOperatorCredential(args.slice(1), options);
    }
    if (command === "play") return await runPlay(args.slice(1), options);
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
