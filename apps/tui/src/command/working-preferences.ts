import {
  FleetWorkingPreferencesSchema,
  formatFleetAutonomyGuidance,
  type FleetAutonomy,
} from "@clankie/protocol";
import { machineSetupContext } from "./machine-setup.ts";

export type WorkingPreferencesReport =
  | { status: "available"; workingDirectory: string; projectId?: string; effective: FleetAutonomy }
  | { status: "unavailable"; detail: string };

/** A read-only view of the current, proven workspace; never an enrollment or grant. */
export async function readWorkingPreferences(
  options: Parameters<typeof machineSetupContext>[1] = {},
): Promise<WorkingPreferencesReport> {
  try {
    const context = await machineSetupContext("local", options);
    if (context.workingPreferences !== true)
      throw new Error("This service does not expose working preferences; update it to read resolved policy.");
    return {
      status: "available",
      workingDirectory: context.workingDirectory,
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      effective: {
        closure: context.effective.closure,
        machineSetup: context.effective.machineSetup,
        ...FleetWorkingPreferencesSchema.parse({
          commit: context.effective.commit,
          push: context.effective.push,
          release: context.effective.release,
          verification: context.effective.verification,
          reportingStyle: context.effective.reportingStyle,
        }),
      },
    };
  } catch (error) {
    return { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
}

export function formatWorkingPreferences(report: WorkingPreferencesReport): string[] {
  if (report.status === "unavailable") return [`Working preferences unavailable: ${report.detail}`];
  return [
    `Working preferences: ${report.projectId === undefined ? "global defaults (no approved project)" : `project ${report.projectId} overrides global defaults`} for ${report.workingDirectory}`,
    ...formatFleetAutonomyGuidance(report.effective),
  ];
}
