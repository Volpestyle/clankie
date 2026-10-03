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
      fleets.map(async (fleet: { id: string }) => {
        try {
          return await runRuntimeCommand(["harnesses", fleet.id], options);
        } catch (error) {
          return {
            machine: fleet.id,
            status: "unavailable",
            detail: error instanceof Error ? error.message : String(error),
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
