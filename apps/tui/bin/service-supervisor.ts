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
 * owns. The captain gained this machinery first (see `captain-service.ts`);
 * every rule it encodes was earned by a real failure mode, so the control plane
 * and the Discord bridge reuse it rather than growing a second, weaker copy:
 *
 * - a pid record per service, so a later invocation can find what it started;
 * - an ownership check against the live process command before any signal, so a
 *   recycled pid belonging to an unrelated process is never killed;
 * - a health probe gate, so "restarted" means "answered healthy", not "spawned".
 */

export type ServiceId = "captain-eve" | "control-plane" | "discord-bridge" | "activity" | "runner";

/** Ordered by dependency: each service may only depend on those before it. */
export const SERVICE_ORDER: readonly ServiceId[] = [
  "captain-eve",
  "control-plane",
  "discord-bridge",
  "activity",
  "runner",
];

export type ServiceState = "healthy" | "unhealthy" | "unreachable";

export interface ServiceRecord {
  readonly id: ServiceId;
  readonly pid: number;
  /** Absent for the captain, whose record predates this field. */
  readonly startedAt?: string;
  readonly version: 1;
}

export interface ServiceProbe {
  readonly state: ServiceState;
  /** Short operator-facing note, e.g. a presence phase. Never secret-bearing. */
  readonly detail?: string;
}

export interface ServiceProbeInput {
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
  readonly dependsOn: readonly ServiceId[];
  /** Arguments passed to `pnpm` to start the service. */
  readonly spawnArgs: readonly string[];
  /** Guards signalling: must recognise the live `ps` command of an owned pid. */
  readonly commandMatches: (command: string) => boolean;
  /**
   * Dependencies whose restart invalidates state this service is holding, so it
   * has to restart alongside them.
   *
   * Narrower than {@link ManagedService.dependsOn} on purpose. `dependsOn`
   * describes who calls whom and orders startup; it does not mean a dependency's
   * restart breaks the dependent. The Discord bridge is the case that does: it
   * stamps every write with a live claim the control plane matches against, and
   * a control plane that restarts rebuilds presence from the event store, so the
   * bridge's claim silently becomes unusable. Restarting the captain, by
   * contrast, breaks nothing downstream and should stay the targeted operation
   * the operator asked for.
   */
  readonly restartsWith?: readonly ServiceId[];
  /** Extra environment the service needs, merged over the caller's env. */
  readonly serviceEnv?: (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly repoRoot: string;
    /**
     * The brokered captain bearer, when one is available. Deliberately handed to
     * each service rather than merged into the shared env: captain-eve and the
     * control plane are the two halves of this shared secret, and the Discord
     * bridge refuses to start if it sees the variable at all.
     */
    readonly captainToken?: string | undefined;
  }) => NodeJS.ProcessEnv;
  /** Overrides the default record location/format (the captain has its own). */
  readonly readRecord?: (
    env: NodeJS.ProcessEnv,
    processIsAliveImpl: (pid: number) => boolean,
  ) => ServiceRecord | undefined;
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

export function clankieStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "clankie");
}

export function serviceStatePath(id: ServiceId, env: NodeJS.ProcessEnv = process.env): string {
  return join(clankieStateDirectory(env), `${id}-service.json`);
}

export function serviceLogPath(id: ServiceId, env: NodeJS.ProcessEnv = process.env): string {
  return join(clankieStateDirectory(env), `${id}.log`);
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readProcessCommand(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Every live process as `[pid, command]`, for finding a service nobody recorded. */
export function listProcessCommands(): readonly (readonly [number, string])[] {
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
 * from the control plane's presence phase — but that phase is durable state
 * replayed from the event store, and it is only written on transition, never on
 * a heartbeat. A bridge that exits without publishing `off` leaves a `present`
 * behind forever, and `clankie restart` then refuses to proceed against a
 * process that does not exist. Asking the process table is the direct answer.
 */
export function findServiceProcessPids(
  service: Pick<ManagedService, "commandMatches">,
  listImpl: () => readonly (readonly [number, string])[] = listProcessCommands,
): readonly number[] {
  return listImpl()
    .filter(([pid, command]) => pid !== process.pid && service.commandMatches(command))
    .map(([pid]) => pid);
}

export function readServiceRecord(
  id: ServiceId,
  env: NodeJS.ProcessEnv = process.env,
  processIsAliveImpl: (pid: number) => boolean = processIsAlive,
): ServiceRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(serviceStatePath(id, env), "utf8")) as {
      id?: unknown;
      pid?: unknown;
      startedAt?: unknown;
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
          ...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
          version: 1,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveRecord(
  service: ManagedService,
  env: NodeJS.ProcessEnv,
  processIsAliveImpl: (pid: number) => boolean,
): ServiceRecord | undefined {
  return service.readRecord === undefined
    ? readServiceRecord(service.id, env, processIsAliveImpl)
    : service.readRecord(env, processIsAliveImpl);
}

function writeServiceRecord(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly id: ServiceId;
  readonly pid: number;
  readonly startedAt: string;
}): void {
  const path = serviceStatePath(input.id, input.env);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, id: input.id, pid: input.pid, startedAt: input.startedAt })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
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
  const record = resolveRecord(service, env, options.processIsAliveImpl ?? processIsAlive);
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
  const record = resolveRecord(service, env, options.processIsAliveImpl ?? processIsAlive);
  if (record === undefined) {
    // Nothing owned is running. A foreign process is the caller's to resolve;
    // reporting "stopped" here would let a restart silently start a duplicate.
    //
    // The question is whether a *process* exists, so ask the process table
    // rather than a probe. Probes describe published state, and published state
    // outlives the process that published it: the Discord bridge's `present`
    // phase is durable and written only on transition, so a bridge killed
    // without publishing `off` used to look alive here indefinitely and wedge
    // every subsequent restart against a process that was long gone.
    const matchingPids = findServiceProcessPids(
      service,
      options.listProcessCommandsImpl ?? listProcessCommands,
    );
    if (matchingPids.length > 0) {
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
  const deadline = Date.now() + STOP_GRACE_MS;
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

  const existing = await inspectService(service, options);
  if (existing.state === "healthy") return existing;
  if (existing.state === "unhealthy" && !existing.owned) {
    throw new Error(
      `${service.label} is occupied by a process the clankie launcher does not own and is not healthy. Stop it, then retry.`,
    );
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
    child = (options.spawnImpl ?? spawn)("pnpm", [...service.spawnArgs], {
      cwd: options.repoRoot,
      detached: true,
      env: serviceEnv,
      stdio: ["ignore", logFd, logFd],
    });
    if (child.pid === undefined) throw new Error(`${service.label} spawn returned no pid.`);
    writeServiceRecord({ env, id: service.id, pid: child.pid, startedAt: new Date().toISOString() });
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
    const record = resolveRecord(service, env, options.processIsAliveImpl ?? processIsAlive);
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
