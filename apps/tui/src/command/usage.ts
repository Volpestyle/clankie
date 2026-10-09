import {
  USAGE_PATH,
  USAGE_SETTINGS_PATH,
  UsageReportSchema,
  UsageSettingsSnapshotSchema,
  USAGE_WORDING,
  type UsageReport,
  type UsageSettingsSnapshot,
  type UsageWindow,
  usagePlanLabel,
} from "@clankie/protocol/worker-accounts";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

const USAGE_COMMAND_USAGE =
  "Usage: clankie usage [--refresh] [--json] | usage overlay [on|off] [--expected-revision REV] | usage warning [on|off|HOURS] [--expected-revision REV]";

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
  args = args.filter((arg) => arg !== "--json");
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

const BAR = 10;
function bar(usedPercent: number): string {
  const filled = Math.max(0, Math.min(BAR, Math.round(usedPercent / (100 / BAR))));
  return `${"█".repeat(filled)}${"░".repeat(BAR - filled)}`;
}

/** `3pm` today, `Sat 2am` later, `Oct 14 6am` past a week; in the reader's local time. */
function usageResetLocal(iso: string | undefined, now: number, timeZone?: string): string {
  if (iso === undefined) return "reset unknown";
  const at = new Date(iso);
  const zone = timeZone === undefined ? {} : { timeZone };
  const day = (value: Date) =>
    new Intl.DateTimeFormat("en-CA", { ...zone, dateStyle: "short" }).format(value);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { ...zone, hour: "numeric", minute: "2-digit", hour12: true })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const time = `${parts.hour}${parts.minute === "00" ? "" : `:${parts.minute}`}${String(parts.dayPeriod).toLowerCase()}`;
  if (day(at) === day(new Date(now))) return time;
  if (at.getTime() - now < 6 * 86_400_000)
    return `${new Intl.DateTimeFormat("en-US", { ...zone, weekday: "short" }).format(at)} ${time}`;
  return `${new Intl.DateTimeFormat("en-US", { ...zone, month: "short", day: "numeric" }).format(at)} ${time}`;
}

/**
 * The default `clankie usage` view: one row per account with its plan, the
 * five-hour and weekly windows as percent used with a bar and local reset
 * time, then model-scoped limits and anything unknown, held or unsigned.
 */
export function formatUsageTable(report: UsageReport, now = Date.now(), timeZone?: string): string {
  const cell = (window: UsageWindow | undefined) =>
    window === undefined
      ? "—"
      : `${String(Math.round(window.usedPercent)).padStart(3)}% ${bar(window.usedPercent)} ${usageResetLocal(window.resetsAt, now, timeZone)}`;
  const rows = report.accounts.map((account) => {
    const windows = account.usage?.windows ?? [];
    const name = account.identity?.split("@")[0] ?? account.label;
    const note = account.held
      ? `held${account.held.reason ? `: ${account.held.reason}` : ""}`
      : account.signedIn === false
        ? `not signed in — ${(account.reason ?? "").replace(/^not signed in\.\s*/u, "")}`
        : account.usage === undefined
          ? (account.reason ?? "usage not reported")
          : account.ageSeconds !== undefined && account.ageSeconds >= 600
            ? `read ${Math.round(account.ageSeconds / 60)}m ago`
            : "";
    return {
      cells: [
        account.harness === "claude" ? "Claude" : "Codex",
        name,
        usagePlanLabel(account) ?? "—",
        cell(windows.find((window) => window.id === "session")),
        cell(windows.find((window) => window.id === "week")),
      ],
      // Model-scoped limits, each with its own bar and reset, even at 0% used.
      scoped: windows
        .filter((window) => window.id.includes(":"))
        .map((window) => ({
          label: window.label
            .replace(/^Current week \((.+)\)$/u, "$1 week")
            .replace(/^Weekly limit \((.+)\)$/u, "$1 week"),
          cell: cell(window),
        })),
      note,
    };
  });
  const header = ["HARNESS", "ACCOUNT", "PLAN", "5H", "WEEK"];
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row.cells[index]!.length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((value, index) => (index === cells.length - 1 ? value : value.padEnd(widths[index]!)))
      .join("  ")
      .trimEnd();
  const indent = " ".repeat(widths[0]! + 2);
  // Scoped limits line up under the account and plan columns, their bar under 5H.
  const scopedWidth = widths[1]! + 2 + widths[2]!;
  const warning = report.settings.allocation;
  return [
    line(header),
    ...rows.flatMap((row) => [
      line(row.cells),
      ...row.scoped.map((scoped) => `${indent}${scoped.label.padEnd(scopedWidth)}  ${scoped.cell}`),
      ...(row.note ? [`${indent}${row.note}`] : []),
    ]),
    ...(report.allocation?.recommendations.map((entry) => `${USAGE_WORDING.nextHire}: ${entry.reason}`) ??
      []),
    `Overlay meters ${report.settings.display.overlay ? "shown" : "hidden"}${
      warning === undefined
        ? ""
        : warning.runOutWarning
          ? ` · run-out warning ${warning.runOutWarningHours}h before a weekly reset`
          : " · run-out warning off"
    } · --json for the raw report`,
  ].join("\n");
}
