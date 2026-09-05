import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Generic supervision for the long-lived local services the operator launcher
 * owns. Every rule it encodes was earned by a real failure mode:
 *
 * - a pid record per service, so a later invocation can find what it started;
 * - an ownership check against the live process command before any signal, so a
 *   recycled pid belonging to an unrelated process is never killed;
 * - a health probe gate, so "restarted" means "answered healthy", not "spawned".
 */

export type ServiceId =
  | "clankie"
  | "relay"
  | "discord-bridge"
  | "discord-user-session"
  | "activity"
  | "tunnel";

/** Stable operator-facing service order. */
export const SERVICE_ORDER: readonly ServiceId[] = [
  "clankie",
  "relay",
  "discord-bridge",
  "discord-user-session",
  "activity",
  "tunnel",
];

type ServiceState = "healthy" | "unhealthy" | "unreachable";

interface ServiceRecord {
  readonly id: ServiceId;
  readonly pid: number;
  readonly version: 1;
}

interface ServiceProbe {
  readonly state: ServiceState;
  /** Short operator-facing note, e.g. a presence phase. Never secret-bearing. */
  readonly detail?: string;
}

interface ServiceProbeInput {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof fetch;
  /** Operator credential, when the caller holds one. Probes treat it as optional. */
  readonly operatorToken?: string | undefined;
  readonly record: ServiceRecord | undefined;
  /**
   * Live pids matching this service's command, launcher-owned or not. A probe
   * with no HTTP surface uses this to tell a running process from a stale claim
   * some earlier process left behind.
   */
  readonly matchingPids: readonly number[];
}

export interface ManagedService {
  readonly id: ServiceId;
  readonly label: string;
  /**
   * Executable to spawn. Defaults to `pnpm` for source checkouts; installed
   * services override it through `resolveProcess`. Named so the registry can
   * also own a process that is not one of ours
   * — the activity tunnel is a `cloudflared` binary and was the last thing an
   * operator had to start, remember, and notice the death of by hand.
   */
  readonly command?: string;
  /**
   * Arguments passed to {@link ManagedService.command}. A function form is
   * resolved against the launcher's environment at spawn time, for a service
   * whose arguments are operator configuration rather than a fixed workspace
   * filter.
   */
  readonly spawnArgs: readonly string[] | ((env: NodeJS.ProcessEnv) => readonly string[]);
  /**
   * Installed releases run compiled entrypoints with their bundled Node binary;
   * source checkouts keep using the workspace command above.
   */
  readonly resolveProcess?: (input: { readonly env: NodeJS.ProcessEnv; readonly repoRoot: string }) => {
    readonly command: string;
    readonly args: readonly string[];
  };
  /**
   * Whether this service should run at all in this environment. A service that
   * answers false is never spawned and reports its own reason from `probe`,
   * which is how an unconfigured optional dependency stays out of the way
   * without the operator having to name it in every command.
   */
  readonly enabled?: (env: NodeJS.ProcessEnv) => boolean;
  /** Guards signalling: must recognise the live `ps` command of an owned pid. */
  readonly commandMatches: (command: string) => boolean;
  /** Foreign processes that conflict with this instance, rather than just its command shape. */
  readonly conflictingPids?: (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly matchingPids: readonly number[];
    /** Undefined means inspection failed; an empty array means the port is free. */
    readonly listPortOwners: (port: number) => readonly number[] | undefined;
    readonly readProcessCommand: (pid: number) => string;
  }) => readonly number[];
  /**
   * Dependencies whose restart invalidates state this service is holding, so it
   * has to restart alongside them.
   *
   * The Discord bridge stamps every write with a live claim the clankie service
   * matches against. A service restart rebuilds presence from its event log, so
   * the bridge's claim silently becomes unusable.
   */
  readonly restartsWith?: readonly ServiceId[];
  /** Time after SIGTERM before this service is force-killed. */
  readonly stopGraceMs?: (env: NodeJS.ProcessEnv) => number;
  /** Extra environment the service needs, merged over the caller's env. */
  readonly serviceEnv?: (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly repoRoot: string;
    /**
     * The brokered captain bearer, when one is available. Deliberately handed
     * to each service rather than merged into the shared env: it is a shared
     * secret between the service and its trusted clients, and the Discord
     * bridge refuses to start if it sees the variable at all.
     */
    readonly captainToken?: string | undefined;
  }) => NodeJS.ProcessEnv;
  readonly probe: (input: ServiceProbeInput) => Promise<ServiceProbe>;
}

export interface ServiceCommandOptions {
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly killImpl?: (pid: number, signal: NodeJS.Signals) => void;
  readonly onStatus?: (status: string) => void;
  readonly operatorToken?: string | undefined;
  /** Brokered captain bearer, passed to the services that share it. */
  readonly captainToken?: string | undefined;
  readonly processIsAliveImpl?: (pid: number) => boolean;
  readonly readProcessCommandImpl?: (pid: number) => string;
  /** Test seam for the process-table scan behind `matchingPids`. */
  readonly listProcessCommandsImpl?: () => readonly (readonly [number, string])[];
  readonly listPortOwnersImpl?: (port: number) => readonly number[] | undefined;
  readonly spawnImpl?: typeof spawn;
  readonly timeoutMs?: number;
}

export interface ServiceStatus {
  readonly id: ServiceId;
  readonly label: string;
  readonly state: ServiceState;
  readonly owned: boolean;
  readonly detail?: string;
  readonly pid?: number;
}

const DEFAULT_SERVICE_STARTUP_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 10_000;

function clankieStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "clankie");
}

export function serviceStatePath(id: ServiceId, env: NodeJS.ProcessEnv = process.env): string {
  return join(clankieStateDirectory(env), `${id}-service.json`);
}

function serviceLogPath(id: ServiceId, env: NodeJS.ProcessEnv = process.env): string {
  return join(clankieStateDirectory(env), `${id}.log`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommand(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Every live process as `[pid, command]`, for finding a service nobody recorded. */
function listProcessCommands(): readonly (readonly [number, string])[] {
  try {
    return execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .map((line) => {
        const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
        return match === null ? undefined : ([Number(match[1]), match[2] ?? ""] as const);
      })
      .filter((entry): entry is readonly [number, string] => entry !== undefined);
  } catch {
    return [];
  }
}

/**
 * Pids of live processes that are this service, whether or not the launcher
 * started them.
 *
 * This exists because process liveness and published state are different
 * questions, and one service answered the first with the second. The Discord
 * bridge serves no HTTP surface, so its probe inferred "a bridge is running"
 * from the service's presence phase — but that phase is durable state
 * replayed from the event store, and it is only written on transition, never on
 * a heartbeat. A bridge that exits without publishing `off` leaves a `present`
 * behind forever, and `clankie restart` then refuses to proceed against a
 * process that does not exist. Asking the process table is the direct answer.
 */
function findServiceProcessPids(
  service: Pick<ManagedService, "commandMatches">,
  listImpl: () => readonly (readonly [number, string])[] = listProcessCommands,
): readonly number[] {
  return listImpl()
    .filter(([pid, command]) => pid !== process.pid && service.commandMatches(command))
    .map(([pid]) => pid);
}

/** A listener's pid can be a grandchild of the pnpm pid in the launcher record. */
function listPortOwners(port: number): readonly number[] | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pids = output.trim().length === 0 ? [] : output.trim().split(/\s+/u).map(Number);
    return pids.every((pid) => Number.isSafeInteger(pid) && pid > 0) ? pids : undefined;
  } catch (error) {
    // lsof uses exit 1 for no matches. Diagnostics or another failure mean
    // unknown, never permission to start over an uninspected listener.
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return failed.status === 1 && !failed.stdout?.trim() && !failed.stderr?.trim() ? [] : undefined;
  }
}

function conflictingServicePids(
  service: ManagedService,
  env: NodeJS.ProcessEnv,
  options: ServiceCommandOptions,
): readonly number[] {
  const matchingPids = findServiceProcessPids(
    service,
    options.listProcessCommandsImpl ?? listProcessCommands,
  );
  return (
    service.conflictingPids?.({
      env,
      matchingPids,
      listPortOwners: options.listPortOwnersImpl ?? listPortOwners,
      readProcessCommand: options.readProcessCommandImpl ?? readProcessCommand,
    }) ?? matchingPids
  );
}

function readServiceRecord(
  id: ServiceId,
  env: NodeJS.ProcessEnv = process.env,
  processIsAliveImpl: (pid: number) => boolean = processIsAlive,
): ServiceRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(serviceStatePath(id, env), "utf8")) as {
      id?: unknown;
      pid?: unknown;
      version?: unknown;
    };
    return record.version === 1 &&
      record.id === id &&
      typeof record.pid === "number" &&
      Number.isSafeInteger(record.pid) &&
      record.pid > 0 &&
      processIsAliveImpl(record.pid)
      ? {
          id,
          pid: record.pid,
          version: 1,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function writeServiceRecord(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly id: ServiceId;
  readonly pid: number;
}): void {
  const path = serviceStatePath(input.id, input.env);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, id: input.id, pid: input.pid })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The atomic rename already consumed the temporary file.
    }
  }
}

function clearServiceRecord(id: ServiceId, env: NodeJS.ProcessEnv): void {
  try {
    unlinkSync(serviceStatePath(id, env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

/**
 * Refuses to signal a pid whose live command no longer looks like the service we
 * started. Pids are recycled; without this a stale record could target an
 * unrelated process the operator very much wants to keep.
 */
function assertOwnedPid(input: {
  readonly command: string;
  readonly service: ManagedService;
  readonly pid: number;
}): void {
  if (!input.service.commandMatches(input.command)) {
    throw new Error(
      `Recorded ${input.service.id} pid ${input.pid} no longer identifies a launcher-owned process; refusing to signal it.`,
    );
  }
}

export async function inspectService(
  service: ManagedService,
  options: ServiceCommandOptions,
): Promise<ServiceStatus> {
  const env = options.env ?? process.env;
  const record = readServiceRecord(service.id, env, options.processIsAliveImpl ?? processIsAlive);
  const probe = await service.probe({
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    operatorToken: options.operatorToken,
    record,
    matchingPids: findServiceProcessPids(service, options.listProcessCommandsImpl ?? listProcessCommands),
  });
  return {
    id: service.id,
    label: service.label,
    state: probe.state,
    owned: record !== undefined,
    ...(probe.detail === undefined ? {} : { detail: probe.detail }),
    ...(record === undefined ? {} : { pid: record.pid }),
  };
}

export async function stopService(
  service: ManagedService,
  options: ServiceCommandOptions,
): Promise<{ readonly stopped: boolean; readonly signal?: NodeJS.Signals }> {
  const env = options.env ?? process.env;
  const record = readServiceRecord(service.id, env, options.processIsAliveImpl ?? processIsAlive);
  if (record === undefined) {
    // A foreign instance on another port has nothing here to stop. A conflict
    // must be resolved by its owner; durable presence alone proves no process.
    const occupyingPids = conflictingServicePids(service, env, options);
    if (occupyingPids.length > 0) {
      throw new Error(
        `${service.label} is running but was not started by the clankie launcher. Stop its owning process, then retry.`,
      );
    }
    return { stopped: true };
  }

  assertOwnedPid({
    command: (options.readProcessCommandImpl ?? readProcessCommand)(record.pid),
    pid: record.pid,
    service,
  });

  const kill = options.killImpl ?? signalProcessGroup;
  const isAlive = options.processIsAliveImpl ?? processIsAlive;
  options.onStatus?.(`Stopping ${service.label}…`);
  kill(record.pid, "SIGTERM");

  let signal: NodeJS.Signals = "SIGTERM";
  const deadline = Date.now() + (service.stopGraceMs?.(env) ?? STOP_GRACE_MS);
  while (Date.now() < deadline) {
    if (!isAlive(record.pid)) break;
    await sleep(100);
  }
  if (isAlive(record.pid)) {
    // A wedged service must not block the restart it was asked to perform.
    signal = "SIGKILL";
    options.onStatus?.(`${service.label} ignored SIGTERM; escalating to SIGKILL…`);
    kill(record.pid, "SIGKILL");
    const killDeadline = Date.now() + 5_000;
    while (Date.now() < killDeadline) {
      if (!isAlive(record.pid)) break;
      await sleep(100);
    }
  }
  if (isAlive(record.pid)) {
    throw new Error(`${service.label} (pid ${record.pid}) did not exit after SIGKILL.`);
  }
  clearServiceRecord(service.id, env);
  return { stopped: true, signal };
}

export async function startService(
  service: ManagedService,
  options: ServiceCommandOptions,
): Promise<ServiceStatus> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SERVICE_STARTUP_TIMEOUT_MS;

  // A service the operator has not configured is not a failure to report or a
  // process to spawn; its probe explains itself and `all` walks past it.
  // Stop a leftover process so switching the active Discord body cannot leave
  // two mouths up.
  if (service.enabled?.(env) === false) {
    await stopService(service, options);
    return await inspectService(service, options);
  }

  const existing = await inspectService(service, options);
  if (existing.state === "healthy") return existing;
  // An unhealthy edge or another instance's command is not occupancy. Use the
  // same resource check as stop, since restart must pass both guards.
  if (!existing.owned) {
    const occupyingPids = conflictingServicePids(service, env, options);
    if (occupyingPids.length > 0) {
      throw new Error(
        `${service.label} is occupied by a process the clankie launcher does not own and is not healthy. Stop it, then retry.`,
      );
    }
  }

  const stateDir = clankieStateDirectory(env);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const logPath = serviceLogPath(service.id, env);
  const logFd = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);

  let child: ChildProcess | undefined;
  try {
    options.onStatus?.(`Starting ${service.label}…`);
    const serviceEnv =
      service.serviceEnv?.({ env, repoRoot: options.repoRoot, captainToken: options.captainToken }) ?? env;
    const fallbackArgs =
      typeof service.spawnArgs === "function" ? service.spawnArgs(serviceEnv) : service.spawnArgs;
    const resolved = service.resolveProcess?.({ env: serviceEnv, repoRoot: options.repoRoot }) ?? {
      command: service.command ?? "pnpm",
      args: fallbackArgs,
    };
    child = (options.spawnImpl ?? spawn)(resolved.command, [...resolved.args], {
      cwd: options.repoRoot,
      detached: true,
      env: serviceEnv,
      stdio: ["ignore", logFd, logFd],
    });
    if (child.pid === undefined) throw new Error(`${service.label} spawn returned no pid.`);
    writeServiceRecord({ env, id: service.id, pid: child.pid });
  } finally {
    closeSync(logFd);
  }

  const serviceChild = child;
  let spawnError: Error | undefined;
  serviceChild.once("error", (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readServiceRecord(service.id, env, options.processIsAliveImpl ?? processIsAlive);
    const probe = await service.probe({
      env,
      fetchImpl,
      operatorToken: options.operatorToken,
      record,
      matchingPids: findServiceProcessPids(service, options.listProcessCommandsImpl ?? listProcessCommands),
    });
    if (probe.state === "healthy") {
      // Never hold the launcher's event loop open on a detached service, or
      // one-shot commands hang after reporting ready.
      serviceChild.unref();
      return {
        id: service.id,
        label: service.label,
        state: "healthy",
        owned: true,
        ...(probe.detail === undefined ? {} : { detail: probe.detail }),
        ...(serviceChild.pid === undefined ? {} : { pid: serviceChild.pid }),
      };
    }
    if (spawnError !== undefined) {
      clearServiceRecord(service.id, env);
      throw new Error(`${service.label} could not start: ${spawnError.message}. See ${logPath}.`, {
        cause: spawnError,
      });
    }
    if (serviceChild.exitCode !== null) {
      clearServiceRecord(service.id, env);
      throw new Error(`${service.label} exited with code ${String(serviceChild.exitCode)}. See ${logPath}.`);
    }
    await sleep(100);
  }

  serviceChild.unref();
  throw new Error(
    `${service.label} did not report healthy within ${Math.round(timeoutMs / 1_000)}s. It may still be coming up — check \`clankie status\` or ${logPath}.`,
  );
}

export async function restartService(
  service: ManagedService,
  options: ServiceCommandOptions,
): Promise<ServiceStatus> {
  await stopService(service, options);
  return await startService(service, options);
}
