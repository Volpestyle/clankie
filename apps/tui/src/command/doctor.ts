import { runRuntimeCommand } from "./runtime.ts";
import {
  inspectInstall,
  type ExecFileImpl,
  type InspectInstallOptions,
  type InstallDoctorReport,
} from "../install-doctor.ts";

export type { ExecFileImpl, InstallDoctorReport };

export async function doctorCommand(options: InspectInstallOptions): Promise<InstallDoctorReport> {
  const report = await inspectInstall(options);
  let remoteHarnesses: readonly unknown[];
  try {
    const inventory = await runRuntimeCommand(["list"], options);
    const fleets = Array.isArray(inventory.connections)
      ? inventory.connections.filter(
          (entry: { id?: unknown; ssh?: unknown }) => typeof entry.id === "string" && entry.ssh,
        )
      : [];
    remoteHarnesses = await Promise.all(
      fleets.map(async (fleet: { id: string; linkState?: unknown }) => {
        const link = fleet.linkState === undefined ? {} : { linkState: fleet.linkState };
        try {
          return { ...(await runRuntimeCommand(["harnesses", fleet.id], options)), ...link };
        } catch (error) {
          return {
            machine: fleet.id,
            status: "unavailable",
            detail: error instanceof Error ? error.message : String(error),
            ...link,
          };
        }
      }),
    );
  } catch (error) {
    remoteHarnesses = [
      { status: "unavailable", detail: error instanceof Error ? error.message : String(error) },
    ];
  }
  return { ...report, remoteHarnesses };
}

/** Inspect only the selected registered machine; no local executable/config probes. */
export async function machineDoctorCommand(
  machine: string,
  options: Parameters<typeof runRuntimeCommand>[1] = {},
): Promise<Record<string, unknown>> {
  const results = await Promise.allSettled([
    runRuntimeCommand(["harnesses", machine], options),
    runRuntimeCommand(["membership", machine], options),
    runRuntimeCommand(["list"], options),
  ]);
  const value = (result: PromiseSettledResult<Record<string, unknown>>) =>
    result.status === "fulfilled"
      ? result.value
      : {
          status: "unavailable",
          detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
  const inventory = results[2]!;
  const connection =
    inventory.status === "fulfilled" && Array.isArray(inventory.value.connections)
      ? inventory.value.connections.find((entry: { id?: unknown }) => entry.id === machine)
      : undefined;
  return {
    machine,
    harnesses: results[0]!.status === "fulfilled" ? results[0]!.value.harnesses : value(results[0]!),
    membership: value(results[1]!),
    ...(inventory.status === "rejected"
      ? { linkState: value(inventory) }
      : connection?.linkState === undefined
        ? {}
        : { linkState: connection.linkState }),
  };
}
