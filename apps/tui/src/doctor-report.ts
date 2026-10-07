import { stripVTControlCharacters } from "node:util";
import type { InstallDoctorReport } from "./install-doctor.ts";
import { formatWorkingPreferences } from "./command/working-preferences.ts";
import { formatRuntimeHealth } from "./command/runtime-health.ts";
import { formatSeatDeliveryAge } from "./command/seat-delivery.ts";

const mark = (ok: boolean) => (ok ? "✓" : "✗");
const clean = (text: string) =>
  stripVTControlCharacters(text)
    .replace(/[\r\n\t]/gu, " ")
    .trim();

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
      `  ${mark(fleet.linkState.state === "ready")} Fleet ${clean(fleet.machine)} · ${clean(fleet.linkState.state)}${
        typeof fleet.linkState.error === "string" ? ` · ${clean(fleet.linkState.error)}` : ""
      }`,
    ];
  });
  const workerTools = (report.workerTools?.workers ?? []).map((worker) => {
    const marker =
      worker.status === "ready" ? "✓" : ["missing", "stalled"].includes(worker.status) ? "✗" : "○";
    const status =
      worker.status === "ready"
        ? "catalog served"
        : worker.status === "not-observed"
          ? "unknown"
          : worker.status;
    const version = worker.pluginVersion === undefined ? "plugin unknown" : `plugin ${worker.pluginVersion}`;
    const expected =
      worker.expectedPluginVersion === undefined ? "" : ` / deployed ${worker.expectedPluginVersion}`;
    return `  ${marker} Worker ${clean(worker.seatId)} tools · ${status} · ${clean(worker.reason)} · ${version}${expected}${worker.behind ? " · behind" : ""}${worker.restartNeeded ? " · restart needed" : ""}${worker.remediation ? ` · ${clean(worker.remediation)}` : ""}`;
  });
  const resources = formatResourceLines(report.resources);
  if (report.workerTools?.error)
    workerTools.push(`  ○ Worker tools · unknown · ${clean(report.workerTools.error)}`);
  const workerReports = (report.workerReports?.workers ?? []).map((worker) => {
    const health = worker.report;
    const marker = health?.outcome === "stored" ? "✓" : health ? "✗" : "○";
    return `  ${marker} Worker ${clean(worker.seatId)} report · ${health ? `${health.outcome} at ${health.observedAt} · ${health.reason}` : "unknown"}${worker.flags.length ? ` · ${worker.flags.join(", ")}` : ""}`;
  });
  if (report.workerReports?.error)
    workerReports.push(`  ○ Worker reports · unknown · ${clean(report.workerReports.error)}`);
  const lines = [
    `Clankie ${report.version} · ${report.kind} · ${report.persona.displayName}`,
    "",
    `  ${captain}`,
    `  ${report.runtimeHealth?.state === "alarm" ? "✗" : report.runtimeHealth?.state === "healthy" ? "✓" : "○"} ${report.runtimeHealth ? formatRuntimeHealth(report.runtimeHealth) : "Runtime health · unknown"}`,
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
    ...workerTools,
    ...workerReports,
    ...(report.seatDeliveries === undefined
      ? []
      : "unresolved" in report.seatDeliveries
        ? report.seatDeliveries.unresolved.length === 0
          ? ["  ✓ Seat deliveries · none unresolved"]
          : report.seatDeliveries.unresolved.map(
              (entry) =>
                `  ! Seat delivery ${clean(entry.receiptId)} · ${clean(entry.conversationId)} · unresolved ${formatSeatDeliveryAge(entry.ageMs)} · only its own resend is refused · \`clankie seat-delivery settle ${clean(entry.receiptId)} abandoned-unknown --conversation ${clean(entry.conversationId)}\``,
            )
        : [`  ○ Seat deliveries · unknown · ${clean(report.seatDeliveries.detail)}`]),
    ...resources,
    ...(report.checkouts && "checkouts" in report.checkouts
      ? report.checkouts.checkouts.map(
          (entry) =>
            `  ${entry.outcome === "observed" && !entry.behind ? "✓" : "○"} Checkout ${clean(entry.path)} · ${entry.outcome === "unavailable" ? "unavailable" : `${entry.behind} behind / ${entry.ahead} ahead · ${entry.dirty ? "dirty" : "clean"} · ${entry.staleWorktrees} stale / ${entry.linkedWorktrees} linked worktrees`} · cached origin/main`,
        )
      : report.checkouts
        ? [`  ○ Checkouts · ${clean(report.checkouts.detail)}`]
        : []),
    ...(report.fleetHealthMetrics?.windows.map(
      (window) =>
        `  Fleet failures ${window.minutes}m · proof ${(window.proofRefusalRate * 100).toFixed(2)}% (${window.proof.refusals}/${window.proof.attempts}, ${window.proofRefusalsPerMinute.toFixed(2)}/min) · reports ${(window.reportFailureRate * 100).toFixed(2)}% (${window.reports.failures}/${window.reports.attempts}, ${window.reportFailuresPerMinute.toFixed(2)}/min)`,
    ) ?? []),
    ...(report.linearRequestBudget === undefined
      ? []
      : "accounts" in report.linearRequestBudget
        ? report.linearRequestBudget.accounts.map(
            (account) =>
              `  ${account.status === "normal" ? "✓" : "!"} Linear requests · ${account.accountId} · ${account.requests} observed/hour · ${Math.round(account.utilization * 100)}% of ${account.limit} · ${account.status}${account.backgroundMinIntervalMs ? " · background reads at most once/minute" : ""}`,
          )
        : [`  ○ Linear requests · unknown · ${clean(report.linearRequestBudget.detail)}`]),
    `  Credentials · ${report.credentials.length ? report.credentials.map((c) => c.id).join(", ") : "none"}`,
    ...(report.tracker
      ? [
          `  Tracker · ${report.tracker.backend} · ${
            report.tracker.reason === "owner_connected"
              ? "owner-connected Linear account"
              : report.tracker.reason === "linear_disabled"
                ? "Linear disabled; using durable local store"
                : "Linear disconnected; using durable local store"
          }${report.tracker.directory ? ` · ${report.tracker.directory}` : ""}`,
        ]
      : []),
    `  Discord · ${report.discord.activeBody ?? "no body"}${report.discord.voiceEnabled ? " · voice" : ""}`,
    ...(report.mcpServers.length ? [`  MCP · ${report.mcpServers.join(", ")}`] : []),
    ...(report.workingPreferences === undefined
      ? []
      : ["", ...formatWorkingPreferences(report.workingPreferences).map((line) => `  ${line}`)]),
  ];
  if (report.remediations.length) lines.push("", "Fix", ...report.remediations.map((step) => `  ${step}`));
  lines.push("", `Next: ${report.nextStep}`, "", "/doctor json shows the full report.");
  return lines.join("\n");
}

/** Optional machine metadata is bounded and independent of captain readiness. */
function formatResourceLines(resources: InstallDoctorReport["resources"]): string[] {
  if (!resources) return [];
  if ("status" in resources) return [`  ○ Fleet resources · unavailable · ${clean(resources.detail)}`];
  const holder = (entry: { seatId?: string | undefined; pid?: number | undefined }) =>
    entry.seatId ? clean(entry.seatId) : entry.pid ? `PID ${entry.pid}` : "unattributed";
  return [
    `  ${mark(resources.pressure.healthy)} Fleet resources · ${resources.capacity.used}/${resources.capacity.heavySlots} shared permits · simulator limit ${resources.capacity.simulatorSlots} · ${resources.queue.length} queued`,
    ...(!resources.pressure.healthy ? [`    Pressure · ${resources.pressure.reason ?? "unavailable"}`] : []),
    ...resources.leases.map(
      (lease) =>
        `    ${holder(lease)} · ${lease.kind}${lease.executable ? ` ${clean(lease.executable)}` : ""}${lease.deviceId ? ` ${clean(lease.deviceId)}` : ""} · ${clean(lease.state)}`,
    ),
    ...resources.queue.map(
      (entry) =>
        `    Queued ${holder(entry)} · ${entry.kind}${entry.executable ? ` ${clean(entry.executable)}` : ""}`,
    ),
  ];
}
