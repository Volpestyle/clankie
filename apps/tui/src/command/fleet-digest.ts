import {
  FLEET_DAILY_DIGEST_PATH,
  FLEET_DIGEST_PATH,
  FleetDailyDigestReadSchema,
  FleetDigestSnapshotSchema,
  type FleetDailyDigestRead,
  type FleetDigestSnapshot,
} from "@clankie/protocol/fleet-digest";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

const USAGE = "Usage: clankie fleet digest [--daily] [--json]";

export async function runFleetDigestCommand(args: readonly string[], options: OwnerSettingsApiOptions = {}) {
  if (args.some((arg) => arg !== "--json") || args.length > 1) throw new Error(USAGE);
  return (await ownerSettingsApi(options)).get(FLEET_DIGEST_PATH, FleetDigestSnapshotSchema);
}

export async function runFleetDailyDigestCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions = {},
) {
  const flags = args.filter((arg) => arg !== "--daily");
  if (flags.some((arg) => arg !== "--json") || flags.length > 1 || args.length !== flags.length + 1)
    throw new Error(USAGE);
  return (await ownerSettingsApi(options)).get(FLEET_DAILY_DIGEST_PATH, FleetDailyDigestReadSchema);
}

function attentionLines(attention: FleetDigestSnapshot["attention"]): string[] {
  const labels = {
    owner_questions: "Owner decisions pending",
    blocked_workers: "Blocked workers",
    incomplete_sources: "Incomplete sources",
  };
  return attention.length
    ? attention.map((item) => `${labels[item.kind]}: ${item.count}`)
    : ["No owner decisions or blocked workers reported."];
}

export function formatFleetDailyDigest(read: FleetDailyDigestRead): string {
  const when = read.schedule.time === "off" ? "off" : `${read.schedule.time} ${read.schedule.timeZone}`;
  const lines = [`Daily fleet digest — schedule: ${when}`, `Waits observed ${read.waits.observedAt}`];
  lines.push(...attentionLines(read.waits.attention));
  const digest = read.digest;
  if (!digest) {
    lines.push("No daily digest has been generated yet.");
    return lines.join("\n") + "\n";
  }
  lines.push(
    `Covers ${digest.since} to ${digest.generatedAt} (${digest.slot}, ${digest.timeZone}).`,
    `Pull requests: ${digest.pullRequests.opened} opened, ${digest.pullRequests.merged} merged.`,
    `Issues: ${digest.issues.opened} opened, ${digest.issues.closed} closed.`,
    `CI findings: ${digest.ciFindings.opened} filed, ${digest.ciFindings.open} open now.`,
    `Workers: ${digest.workers.hired} project hires, ${digest.workers.closed} confirmed closes.`,
    `Reports: ${digest.reports.done} done, ${digest.reports.blocked} blocked.`,
    `Accounts: ${digest.burn.accountsObserved} observed, ${digest.burn.accountsRunningOut} projected to run out before reset, ${digest.burn.accountsWithUnknownPace} with unknown pace.`,
    "Retained observations only; missing data is unknown. Reports do not establish completed work.",
  );
  return lines.join("\n") + "\n";
}

export function formatFleetDigest(digest: FleetDigestSnapshot): string {
  const lines = [`Fleet digest — ${digest.dayUtc} UTC`, `Observed ${digest.generatedAt}`];
  lines.push(...attentionLines(digest.attention));
  const workers = digest.workers;
  lines.push(
    `Workers: ${workers.hired} current hires; ${workers.working} working, ${workers.waiting} waiting, ${workers.blocked} blocked, ${workers.idle} idle, ${workers.finished} finished, ${workers.unclassified} unclassified.`,
  );
  const activity = digest.activity;
  lines.push(
    `Today (UTC): ${activity.doneReportsToday} done reports, ${activity.blockedReportsToday} blocked reports, ${activity.confirmedClosesToday} confirmed closes.`,
  );
  lines.push(
    `Retained PRs: ${digest.pullRequests.open} open, ${digest.pullRequests.merged} merged; source retention since ${digest.pullRequests.retainedSince}.`,
  );
  lines.push(
    `Account burn: ${digest.burn.accountsObserved} accounts observed, ${digest.burn.accountsRunningOut} projected to run out; ${digest.burn.accountsWithUnknownPace} with unknown pace.`,
  );
  lines.push(
    `Known tokens in last hour: ${digest.burn.lastHourKnownTokens}; ${digest.burn.accountsMissingTokens} accounts missing token data.`,
  );
  const heavy = digest.resources.heavy;
  lines.push(
    heavy === "unknown"
      ? "Heavy capacity: unknown."
      : `Heavy capacity: ${heavy.used}/${heavy.slots} slots held, ${heavy.queued} queued.`,
  );
  const machines = digest.resources.machines;
  lines.push(
    machines === "unknown"
      ? "Machine observations: unknown."
      : `Machine observations: ${machines.available} available, ${machines.unavailable} unavailable.`,
  );
  lines.push("Retained observations only; missing data is unknown. Reports do not establish completed work.");
  return lines.join("\n") + "\n";
}
