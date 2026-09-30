import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { probeHostPower, type HostPowerReport } from "@clankie/protocol/host-power";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";
import {
  KEEP_AWAKE_ENV,
  managedService,
  startOne,
  type CreateServiceOptionsInput,
  type ServiceRegistryOptions,
} from "../../bin/services.ts";
import { inspectService, type ServiceStatus } from "../../bin/service-supervisor.ts";
import type { ExecFileImpl } from "../install-doctor.ts";

const AWAKE_USAGE = "Usage: clankie awake [status|on|off]";
const PMSET_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFileCallback);

export interface AwakeCommandOptions extends CreateServiceOptionsInput {
  readonly settings?: SettingsStore;
  /** Test seam for `pmset`. */
  readonly execFileImpl?: ExecFileImpl;
}

export interface AwakeCommandResult {
  readonly ok: true;
  /** The owner's stored opt-in. */
  readonly keepAwake: boolean;
  /** The launcher's caffeinate, as `clankie status` shows it. */
  readonly service: Pick<ServiceStatus, "state" | "detail" | "pid">;
  readonly power: HostPowerReport;
  readonly note: string;
}

/**
 * `clankie awake`: the owner's always-on Mac. `on` stores the opt-in and starts
 * the launcher's `caffeinate -s` now; `off` stores it and stops that process.
 * It never touches `pmset` or the owner's power settings, and macOS only honors
 * a `-s` assertion while the Mac is plugged in.
 */
export async function runAwakeCommand(
  args: readonly string[],
  options: AwakeCommandOptions,
): Promise<AwakeCommandResult> {
  const verb = args[0] ?? "status";
  if (args.length > 1 || (verb !== "status" && verb !== "on" && verb !== "off")) {
    throw new Error(AWAKE_USAGE);
  }
  const env = options.env ?? process.env;
  const store = options.settings ?? new SettingsStore(defaultSettingsPath(env));
  if (verb !== "status") {
    if (verb === "on" && process.platform !== "darwin") {
      throw new Error(
        "Keep-awake runs caffeinate, which is macOS only. Use your system's power settings, or a hosted Clankie.",
      );
    }
    await store.update((current) => ({ ...current, host: { ...current.host, keepAwake: verb === "on" } }));
  }
  const keepAwake = (await store.load()).host.keepAwake;
  // The stored opt-in decides, not whatever env this shell happened to inherit.
  const serviceEnv = { ...env, [KEEP_AWAKE_ENV]: keepAwake ? "1" : "0" };
  const serviceOptions = registryOptions(options, serviceEnv);
  let service: ServiceStatus;
  if (verb === "status") {
    service = await inspectService(managedService("awake"), serviceOptions);
  } else {
    try {
      service = await startOne("awake", serviceOptions);
    } catch (error) {
      throw new Error(
        `Keep-awake is saved ${verb}, but the launcher could not apply it: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const power = await probeHostPower({
    exec: options.execFileImpl ?? defaultExec,
    keepAwakeRequested: keepAwake,
  });
  return {
    ok: true,
    keepAwake,
    service: {
      state: service.state,
      ...(service.detail === undefined ? {} : { detail: service.detail }),
      ...(service.pid === undefined ? {} : { pid: service.pid }),
    },
    power,
    note: keepAwake
      ? "Keeps this Mac awake only while it is plugged in; unplugged, it sleeps as its power settings say. Disable with `clankie awake off`."
      : "Off: the Mac sleeps as its power settings say. `clankie awake on` keeps it awake while plugged in.",
  };
}

/**
 * Caffeinate needs no credential, so this skips the brokered-credential lookup
 * `createServiceOptions` does for the services that authenticate.
 */
function registryOptions(options: AwakeCommandOptions, env: NodeJS.ProcessEnv): ServiceRegistryOptions {
  const stderr = options.stderr ?? process.stderr;
  return {
    repoRoot: options.repoRoot,
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    ...(options.listProcessCommandsImpl === undefined
      ? {}
      : { listProcessCommandsImpl: options.listProcessCommandsImpl }),
    ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
    ...(options.killImpl === undefined ? {} : { killImpl: options.killImpl }),
    ...(options.processIsAliveImpl === undefined ? {} : { processIsAliveImpl: options.processIsAliveImpl }),
    ...(options.readProcessCommandImpl === undefined
      ? {}
      : { readProcessCommandImpl: options.readProcessCommandImpl }),
    onStatus: (status: string) => stderr.write(`${status}\n`),
  };
}

const defaultExec: ExecFileImpl = async (command, args) => {
  const result = await execFileAsync(command, [...args], { encoding: "utf8", timeout: PMSET_TIMEOUT_MS });
  return { stdout: result.stdout, stderr: result.stderr };
};
