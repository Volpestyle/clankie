import {
  FLEET_TOOL_CATALOG_HEALTH_PATH,
  FleetToolCatalogHealthPageSchema,
} from "@clankie/protocol/tool-catalog";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import { runRuntimeCommand } from "./runtime.ts";
import { readWorkingPreferences } from "./working-preferences.ts";
import {
  inspectInstall,
  type ExecFileImpl,
  type InspectInstallOptions,
  type InstallDoctorReport,
} from "../install-doctor.ts";

export type { ExecFileImpl, InstallDoctorReport };

/** Readiness first; optional rooms never hide the reason a first turn fails. */
export function formatDoctorSummary(report: InstallDoctorReport): string {
  if (!report.captain.ready) {
    return report.captain.reason === "no_model"
      ? "Choose a model — run `clankie`, then `/setup`."
      : `Sign in to ${report.captain.providerId} — run \`clankie\`, then \`/setup\`.`;
  }
  const endpoint = report.selectedModel?.endpoint;
  if (endpoint && (!endpoint.reachable || !endpoint.declaresModel)) {
    return `The selected model ${report.model} is unavailable — run \`clankie\`, then \`/setup\` to choose a working model.`;
  }
  if (endpoint?.authRequired && !endpoint.credentialStored) {
    return `The selected model needs a key — run \`clankie\`, then \`/auth ${report.selectedModel?.providerId}\`.`;
  }
  if (report.doorway.state === "unreachable") {
    return "Clankie is not answering — run `clankie`.";
  }
  if (report.doorway.state === "sign_in_required") {
    return "Phone access is signed out — run `clankie remote-access on`.";
  }
  if (report.doorway.state === "unavailable") {
    return "Phone access has no connection — run `clankie restart`.";
  }
  if (report.doorway.state === "connecting") {
    return "Phone access is still connecting — run `clankie gateway status` to check again.";
  }
  const remediation = report.remediations[0];
  if (remediation !== undefined) {
    const line = remediation.replace(/\s+/gu, " ").trim();
    return line.includes("`") || line.includes("/discord")
      ? line
      : `${line} Run \`clankie\`, then \`/setup\`.`;
  }
  return "ready";
}

/** Machine cards remain available verbatim via --json; observations are not tool acceptance. */
export function formatMachineDoctorSummary(report: Record<string, unknown>): string {
  const unavailable = [report.harnesses, report.membership].some(
    (card) => typeof card === "object" && card !== null && "status" in card && card.status === "unavailable",
  );
  return unavailable
    ? `Cannot inspect ${report.machine} — run \`clankie connections\` to repair its connection.`
    : "ready";
}

export async function doctorCommand(
  options: InspectInstallOptions & { cwd?: string; host?: string },
): Promise<InstallDoctorReport> {
  const report = await inspectInstall(options);
  const workingPreferences = await readWorkingPreferences({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.credentialStore === undefined ? {} : { operatorCredentialStore: options.credentialStore }),
  });
  let toolCatalogHealth: NonNullable<InstallDoctorReport["toolCatalogHealth"]>;
  try {
    const credential = await resolveOperatorCredential({
      env: options.env ?? process.env,
      ...(options.credentialStore ? { store: options.credentialStore } : {}),
    });
    if (!credential) throw new Error("Native tool catalog health needs the operator credential");
    const response = await (options.fetchImpl ?? fetch)(
      `${commandHost(options)}${FLEET_TOOL_CATALOG_HEALTH_PATH}`,
      {
        headers: { authorization: `Bearer ${credential.token}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) throw new Error(`Native tool catalog health unavailable (HTTP ${response.status})`);
    toolCatalogHealth = FleetToolCatalogHealthPageSchema.parse(await response.json());
  } catch (error) {
    toolCatalogHealth = {
      status: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
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
  return { ...report, remoteHarnesses, toolCatalogHealth, workingPreferences };
}

/** Inspect only the selected registered machine; no local executable/config probes. */
export async function machineDoctorCommand(
  machine: string,
  options: Parameters<typeof runRuntimeCommand>[1] = {},
): Promise<Record<string, unknown>> {
  const results = await Promise.allSettled([
    runRuntimeCommand(["harnesses", machine], options),
    runRuntimeCommand(["membership", machine], options),
  ]);
  const value = (result: PromiseSettledResult<Record<string, unknown>>) =>
    result.status === "fulfilled"
      ? result.value
      : {
          status: "unavailable",
          detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
  return {
    machine,
    harnesses: results[0]!.status === "fulfilled" ? results[0]!.value.harnesses : value(results[0]!),
    membership: value(results[1]!),
  };
}
