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
import { SERVICE_ORDER } from "./service-supervisor.ts";
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
import { inspectInstall, type ExecFileImpl } from "../src/install-doctor.ts";
import { runModelCommand } from "./model.ts";

const RESTART_TURN_POLL_MS = 100;
const RESTART_AFTER_TURN_FLAG = "--after-operator-turn";

type Writable = { write(chunk: string): unknown };

export interface HeadlessCaptainCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly host?: string;
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
  /** Test seam so `clankie doctor` does not probe the real PATH. */
  readonly execFileImpl?: ExecFileImpl;
  readonly stderr?: Writable;
  readonly stdout?: Writable;
}

function outputJson(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function commandHelp(): string {
  return [
    "Usage: clankie [--version|-V] [--chat <conversationId>] [<command> ...]",
    "",
    "With no command, clankie opens the fullscreen operator console and requires a TTY.",
    "",
    "Headless commands (no TTY). One JSON document on stdout unless noted; progress",
    "on stderr. Exit 0 on success, 1 on failure. Secrets never as flags.",
    "",
    "  health | status          Probe every launcher-owned service (JSON)",
    "  doctor                   This install: checkout vs release, models, credentials, herdr",
    "                           (JSON; exit 0 — ok means the card was produced)",
    "  restart [service]        Restart in dependency order (JSON; progress on stderr)",
    "  down [service]           Stop in reverse order (JSON; progress on stderr)",
    "  pair [--json] [--timeout SEC]",
    "                           One-time device pairing QR + code (human default; --json for agents)",
    "  devices [--json]         List paired devices",
    "  devices revoke <id> [--json]",
    "                           Revoke a device",
    "  operator-credential rotate [--json]",
    "                           Rotate the local operator credential",
    "  play status              Live embodiment session (JSON)",
    "  play stop                Stop the live playthrough at the next turn boundary",
    "  model [status]           Captain model and local providers (JSON)",
    "  model add-local --id ID --base-url URL [--context N] [--models id,id] [--set]",
    "                           Declare an OpenAI-compatible local runtime (ds4, Ollama, LM Studio)",
    "  model set provider/model Select the captain model",
    "  help | --help | -h       This text",
    "",
    "Services for restart/down: all (default), clankie, relay, discord, user-session, activity, tunnel",
    "Aliases: captain, eve, cp, control-plane, bridge, lab, watch, viewer, cloudflared, app-relay, phone",
    "",
    "Model notes:",
    "  A bare origin (--base-url http://127.0.0.1:8000) is rewritten to /v1.",
    "  Probe is GET {baseURL}/models (3s). If that fails, pass --models id,id.",
    "  --set selects the first listed model as captain.",
    "  Config writes need `clankie restart captain` before the running service uses them.",
    "",
    "pair / devices / operator-credential rotate default to human text; pass --json.",
    "play stop prints 'Nothing is playing.' (not JSON) when idle.",
    "Not on this CLI: /auth, /discord, /connect, /persona, /voice. Local LLM servers are",
    "not launcher-owned; start them yourself.",
    "",
    "Full reference: docs/cli.md (at `clankie doctor`'s repoRoot on every install).",
  ].join("\n");
}

export function isHeadlessCaptainCommand(command: string | undefined): boolean {
  return (
    command === "health" ||
    command === "status" ||
    command === "doctor" ||
    command === "restart" ||
    command === "down" ||
    command === "pair" ||
    command === "devices" ||
    command === "operator-credential" ||
    command === "play" ||
    command === "model" ||
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
  const cliEntryPath =
    options.cliEntryPath ??
    options.env?.CLANKIE_LAUNCHER_PATH ??
    process.env.CLANKIE_LAUNCHER_PATH ??
    process.argv[1];
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
 * the play host winds down at the next turn boundary and leaves the world.
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

async function runDoctor(options: HeadlessCaptainCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const report = await inspectInstall({
    repoRoot: options.repoRoot,
    env,
    ...(options.execFileImpl === undefined ? {} : { execFileImpl: options.execFileImpl }),
  });
  outputJson(options.stdout ?? process.stdout, report);
  return 0;
}

export async function runHeadlessCaptainCommand(
  args: readonly string[],
  options: HeadlessCaptainCommandOptions,
): Promise<number> {
  const command = args[0];
  try {
    if (command === "health" || command === "status") return await runInspection(options);
    if (command === "doctor") return await runDoctor(options);
    if (command === "restart") return await runRestart(args.slice(1), options);
    if (command === "down") return await runDown(args.slice(1), options);
    if (command === "pair") return await runPair(args.slice(1), options);
    if (command === "devices") return await runDevices(args.slice(1), options);
    if (command === "operator-credential") {
      return await runOperatorCredential(args.slice(1), options);
    }
    if (command === "play") return await runPlay(args.slice(1), options);
    if (command === "model") return await runModelCommand(args.slice(1), options);
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
