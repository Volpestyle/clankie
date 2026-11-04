import { resolve } from "node:path";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";
import { createServiceOptions, inspectServices, type CreateServiceOptionsInput } from "../../bin/services.ts";
import { readProcessCommand, type ServiceStatus } from "../../bin/service-supervisor.ts";

const USAGE =
  "Usage: clankie cpu-profile [status]\n       clankie cpu-profile on DIRECTORY\n       clankie cpu-profile off";

export interface CpuProfileStatus {
  /**
   * Read from the running service's own command line, not from the setting.
   * Null when a service is up but the launcher knows no process to read.
   */
  readonly running: boolean | null;
  /** Where the running service writes its profile. */
  readonly directory: string | null;
  /** What every later start uses, until it is turned off. */
  readonly configured: string | null;
}

/** The directory in a service's `--cpu-prof-dir`, whose value may hold spaces. */
function profileDirectory(command: string): string | null {
  return /(?:^|\s)--cpu-prof-dir=(.+?)(?:\s--|$)/u.exec(command)?.[1] ?? null;
}

export function cpuProfileStatus(input: {
  readonly configured: string | undefined;
  readonly service: Pick<ServiceStatus, "pid" | "state"> | undefined;
  readonly readCommand?: ((pid: number) => string) | undefined;
}): CpuProfileStatus {
  const { pid, state } = input.service ?? {};
  const configured = input.configured ?? null;
  if (pid === undefined) return { running: state === "healthy" ? null : false, directory: null, configured };
  const directory = profileDirectory((input.readCommand ?? readProcessCommand)(pid));
  return { running: directory !== null, directory, configured };
}

/**
 * `clankie cpu-profile`: the owner's setting for profiling the service. It
 * applies at the service's next start and to every start after that, so it
 * never restarts anything itself.
 */
export async function runCpuProfileCommand(
  args: readonly string[],
  options: CreateServiceOptionsInput & { readonly cwd?: string },
) {
  const env = options.env ?? process.env;
  const settings = new SettingsStore(defaultSettingsPath(env));
  const [action, directory] = args;
  const reading = args.length === 0 || (action === "status" && args.length === 1);
  if (action === "on" && directory !== undefined && args.length === 2) {
    const absolute = resolve(options.cwd ?? process.cwd(), directory);
    await settings.update((value) => ({ ...value, host: { ...value.host, cpuProfileDir: absolute } }));
  } else if (action === "off" && args.length === 1) {
    await settings.update((value) => {
      const { cpuProfileDir: _off, ...host } = value.host;
      return { ...value, host };
    });
  } else if (!reading) throw new Error(USAGE);
  const [service] = await inspectServices(["clankie"], await createServiceOptions(options));
  const status = cpuProfileStatus({
    configured: (await settings.load()).host.cpuProfileDir,
    service,
    readCommand: options.readProcessCommandImpl,
  });
  return {
    ok: true as const,
    ...status,
    ...(status.directory === status.configured ? {} : { appliesAt: "the service's next start" }),
  };
}
