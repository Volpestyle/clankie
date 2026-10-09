import {
  USAGE_PATH,
  USAGE_SETTINGS_PATH,
  UsageReportSchema,
  UsageSettingsSnapshotSchema,
  USAGE_WORDING,
  type UsageAccount,
  type UsageReport,
  type UsageSettingsSnapshot,
} from "@clankie/protocol/worker-accounts";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

const USAGE_COMMAND_USAGE =
  "Usage: clankie usage [--refresh] | usage overlay [on|off] [--expected-revision REV] | usage warning [on|off|HOURS] [--expected-revision REV]";

/**
 * `clankie usage` (VUH-1961): this Mac's Claude and Codex accounts with each
 * limit's percent used and reset, from `GET /v1/usage`. `overlay on|off` is
 * the owner's show/hide choice for the desktop meters. `warning on|off|HOURS`
 * sets when Clankie's lead hears that an account is on pace to run out
 * before its weekly reset (VUH-1974).
 */
export async function runUsageCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions,
): Promise<UsageReport | UsageSettingsSnapshot> {
  const api = await ownerSettingsApi(options);
  if (args.length === 0 || (args.length === 1 && args[0] === "--refresh"))
    return api.get(`${USAGE_PATH}${args[0] === "--refresh" ? "?refresh=1" : ""}`, UsageReportSchema);
  if (args[0] !== "overlay" && args[0] !== "warning") throw new Error(USAGE_COMMAND_USAGE);
  const [command, value, flag, revision, ...rest] = args;
  if (value === undefined) return api.get(USAGE_SETTINGS_PATH, UsageSettingsSnapshotSchema);
  const hours = command === "warning" && /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) : undefined;
  if (
    (value !== "on" && value !== "off" && (hours === undefined || hours > 168)) ||
    rest.length ||
    (flag !== undefined && (flag !== "--expected-revision" || revision === undefined))
  )
    throw new Error(USAGE_COMMAND_USAGE);
  const expectedRevision =
    revision ?? (await api.get(USAGE_SETTINGS_PATH, UsageSettingsSnapshotSchema)).revision;
  return api.write(
    USAGE_SETTINGS_PATH,
    command === "overlay"
      ? { expectedRevision, display: { overlay: value === "on" } }
      : {
          expectedRevision,
          allocation:
            hours === undefined
              ? { runOutWarning: value === "on" }
              : { runOutWarning: true, runOutWarningHours: hours },
        },
    UsageSettingsSnapshotSchema,
  );
}

/** The run-out warning setting in one line. */
export function runOutWarningText(settings: UsageSettingsSnapshot): string {
  const allocation = settings.allocation;
  if (allocation === undefined) return "This Clankie has no run-out warning setting.";
  return allocation.runOutWarning
    ? `Run-out warning on: Clankie's lead hears once when an account is on pace to run out ${allocation.runOutWarningHours}h or more before its weekly reset.`
    : "Run-out warning off.";
}

function until(iso: string | undefined, now: number): string {
  if (iso === undefined) return "reset unknown";
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  if (minutes < 60) return `resets in ${minutes}m`;
  if (minutes < 48 * 60) return `resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `resets in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

/** One line per account and one per window, for the console. */
export function formatUsage(report: UsageReport, now = Date.now()): string {
  const lines = report.accounts.map((account: UsageAccount) => {
    const head = `${account.harness} ${account.label}${account.identity ? ` (${account.identity}${account.plan ? `, ${account.plan}` : ""})` : ""}${account.held ? " · set aside" : ""}`;
    if (!account.usage) return `${head}\n  ${account.reason ?? "usage not reported"}`;
    const age = account.ageSeconds === undefined ? "" : ` · read ${Math.round(account.ageSeconds / 60)}m ago`;
    return [
      `${head}${age}`,
      ...account.usage.windows.map(
        (window) =>
          `  ${window.label}: ${Math.round(100 - window.usedPercent)}% left · ${until(window.resetsAt, now)}`,
      ),
    ].join("\n");
  });
  const warning = report.settings.allocation;
  return [
    ...lines,
    ...(report.allocation?.recommendations.map((entry) => `${USAGE_WORDING.nextHire}: ${entry.reason}`) ??
      []),
    `Overlay meters ${report.settings.display.overlay ? "shown" : "hidden"} (/usage overlay on|off)`,
    ...(warning === undefined
      ? []
      : [
          warning.runOutWarning
            ? `Run-out warning on, ${warning.runOutWarningHours}h or more before a weekly reset (/usage warning on|off|HOURS)`
            : "Run-out warning off (/usage warning on|off|HOURS)",
        ]),
  ].join("\n");
}
