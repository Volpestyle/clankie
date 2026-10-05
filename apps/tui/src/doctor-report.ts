import type { InstallDoctorReport } from "./install-doctor.ts";

const mark = (ok: boolean) => (ok ? "✓" : "✗");

/** `/doctor` as a checklist; `/doctor json` keeps the full canonical report. */
export function formatDoctorReport(report: InstallDoctorReport): string {
  const captain = report.captain.ready
    ? `${mark(true)} Captain · ${report.captain.model} via ${report.captain.auth}`
    : `${mark(false)} Captain · ${report.captain.reason === "no_model" ? "no model selected" : "no credential for the model"}`;
  const endpoint = report.selectedModel?.endpoint;
  const commands = Object.entries(report.commands);
  const missing = commands.filter(([, presence]) => !presence.present).map(([name]) => name);
  const fleetLinks = (report.remoteHarnesses ?? []).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const fleet = entry as { machine?: unknown; linkState?: { state?: unknown; error?: unknown } };
    if (typeof fleet.machine !== "string" || typeof fleet.linkState?.state !== "string") return [];
    return [
      `  ${mark(fleet.linkState.state === "ready")} Fleet ${fleet.machine} · ${fleet.linkState.state}${
        typeof fleet.linkState.error === "string" ? ` · ${fleet.linkState.error}` : ""
      }`,
    ];
  });
  const lines = [
    `Clankie ${report.version} · ${report.kind} · ${report.persona.displayName}`,
    "",
    `  ${captain}`,
    ...(endpoint ? [`  ${mark(endpoint.reachable)} Model endpoint · ${endpoint.baseURL}`] : []),
    `  ${mark(report.laneTools.reachable)} Lane tools · ${report.laneTools.url}`,
    `  ${mark(report.doorway.state !== "unreachable")} Doorway · ${report.doorway.state}`,
    `  ${mark(report.herdrPlugin.linked === true && report.herdrPlugin.enabled !== false)} Herdr plugin · ${
      report.herdrPlugin.linked
        ? report.herdrPlugin.enabled === false
          ? "linked, disabled"
          : "linked"
        : "not linked"
    }`,
    `  ${mark(missing.length === 0)} Tools · ${
      missing.length ? `missing ${missing.join(", ")}` : `${commands.length} present`
    }`,
    ...fleetLinks,
    `  Credentials · ${report.credentials.length ? report.credentials.map((c) => c.id).join(", ") : "none"}`,
    `  Discord · ${report.discord.activeBody ?? "no body"}${report.discord.voiceEnabled ? " · voice" : ""}`,
    ...(report.mcpServers.length ? [`  MCP · ${report.mcpServers.join(", ")}`] : []),
  ];
  if (report.remediations.length) lines.push("", "Fix", ...report.remediations.map((step) => `  ${step}`));
  lines.push("", `Next: ${report.nextStep}`, "", "/doctor json shows the full report.");
  return lines.join("\n");
}
