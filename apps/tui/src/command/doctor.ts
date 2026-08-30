import {
  inspectInstall,
  type ExecFileImpl,
  type InspectInstallOptions,
  type InstallDoctorReport,
} from "../install-doctor.ts";

export type { ExecFileImpl, InstallDoctorReport };

export async function doctorCommand(options: InspectInstallOptions): Promise<InstallDoctorReport> {
  return await inspectInstall(options);
}
