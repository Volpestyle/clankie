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
import {
  HOST_SETTINGS_PATH,
  HostSettingsSnapshotSchema,
  HOST_SETTINGS_WORDING,
} from "@clankie/protocol/owner-settings";
import { commandHost } from "./io.ts";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";
import type { ExecFileImpl } from "../install-doctor.ts";

const AWAKE_USAGE = "Usage: clankie awake [status|on|off] [--local-setup]";
const PMSET_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFileCallback);

export interface AwakeCommandOptions extends CreateServiceOptionsInput, OwnerSettingsApiOptions {
  readonly expectedRevision?: string;
  /** Explicit bootstrap only: no ordinary API failure falls back to this. */
  readonly localSetup?: boolean;
  readonly settings?: SettingsStore;
  /** Test seam for `pmset`. */
  readonly execFileImpl?: ExecFileImpl;
}

export interface AwakeCommandResult {
  readonly ok: true;
  readonly revision?: string;
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
  const localSetup = options.localSetup === true || args.includes("--local-setup");
  const revisionIndex = args.indexOf("--expected-revision");
  const expectedRevision =
    options.expectedRevision ?? (revisionIndex < 0 ? undefined : args[revisionIndex + 1]);
  if (
    (revisionIndex >= 0 && !/^[a-f0-9]{64}$/u.test(args[revisionIndex + 1] ?? "")) ||
    (localSetup && expectedRevision !== undefined)
  )
    throw new Error(AWAKE_USAGE);
  args = args.filter(
    (arg, index) =>
      arg !== "--local-setup" &&
      (revisionIndex < 0 || (index !== revisionIndex && index !== revisionIndex + 1)),
  );
  const verb = args[0] ?? "status";
  if (args.length > 1 || (verb !== "status" && verb !== "on" && verb !== "off")) {
    throw new Error(AWAKE_USAGE);
  }
  const env = options.env ?? process.env;
  const store = options.settings ?? new SettingsStore(defaultSettingsPath(env));
  if (!localSetup) {
    const api = await ownerSettingsApi(options);
    let state = await api.get(HOST_SETTINGS_PATH, HostSettingsSnapshotSchema);
    if (verb !== "status")
      state = await api.write(
        HOST_SETTINGS_PATH,
        {
          schemaVersion: 1,
          expectedRevision: expectedRevision ?? state.revision,
          changes: { keepAwake: verb === "on" },
        },
        HostSettingsSnapshotSchema,
      );
    const power = state.power ?? {
      state: "unknown" as const,
      source: "unknown" as const,
      sleepAfterMinutes: null,
      heldAwakeBy: [],
      keepAwakeRequested: state.host.keepAwake,
    };
    return {
      ok: true,
      revision: state.revision,
      keepAwake: state.host.keepAwake,
      service: state.keepAwakeService
        ? {
            state: state.keepAwakeService.state,
            ...(state.keepAwakeService.detail === undefined ? {} : { detail: state.keepAwakeService.detail }),
            ...(state.keepAwakeService.pid === undefined ? {} : { pid: state.keepAwakeService.pid }),
          }
        : {
            state: "unreachable",
            detail: "Sleep assertion status unavailable on the selected host.",
          },
      power,
      note: HOST_SETTINGS_WORDING.keepAwake.description,
    };
  }
  const setupHost = new URL(commandHost(options));
  if (options.ownerFetcher || !["localhost", "127.0.0.1", "[::1]"].includes(setupHost.hostname))
    throw new Error("Local setup cannot target a remote host");
  if (verb !== "status") {
    let reachable = false;
    try {
      await (options.fetchImpl ?? fetch)(new URL("/health", setupHost), {
        signal: AbortSignal.timeout(2000),
      });
      reachable = true;
    } catch {
      /* bootstrap while service is down */
    }
    if (reachable) throw new Error("Clankie is running. Use the owner settings API instead of local setup.");
    if (verb === "on" && process.platform !== "darwin") throw new Error("Keep-awake is macOS only");
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

/** Read the launcher's own sleep assertion on this host. */
export async function savedKeepAwakeStatus(
  options: AwakeCommandOptions,
): Promise<AwakeCommandResult["service"]> {
  const env = options.env ?? process.env;
  const settings = options.settings ?? new SettingsStore(defaultSettingsPath(env));
  const keepAwake = (await settings.load()).host.keepAwake;
  const status = await inspectService(
    managedService("awake"),
    registryOptions(options, { ...env, [KEEP_AWAKE_ENV]: keepAwake ? "1" : "0" }),
  );
  return {
    state: status.state,
    ...(status.detail === undefined ? {} : { detail: status.detail }),
    ...(status.pid === undefined ? {} : { pid: status.pid }),
  };
}

/** Apply the saved host choice through the launcher's owned process registry. */
export async function applySavedKeepAwake(options: AwakeCommandOptions): Promise<void> {
  const env = options.env ?? process.env;
  const settings = options.settings ?? new SettingsStore(defaultSettingsPath(env));
  const keepAwake = (await settings.load()).host.keepAwake;
  await startOne("awake", registryOptions(options, { ...env, [KEEP_AWAKE_ENV]: keepAwake ? "1" : "0" }));
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
