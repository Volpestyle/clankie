import {
  FLEET_DIGEST_PATH,
  FleetDigestSnapshotSchema,
  type FleetDigestSnapshot,
} from "@clankie/protocol/fleet-digest";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

export async function runFleetDigestCommand(args: readonly string[], options: OwnerSettingsApiOptions = {}) {
  if (args.some((arg) => arg !== "--json") || args.length > 1)
    throw new Error("Usage: clankie fleet digest [--json]");
  return (await ownerSettingsApi(options)).get(FLEET_DIGEST_PATH, FleetDigestSnapshotSchema);
}

export function formatFleetDigest(digest: FleetDigestSnapshot): string {
  const lines = [`Fleet digest — ${digest.dayUtc} UTC`, `Observed ${digest.generatedAt}`];
  const labels = {
    owner_questions: "Owner decisions pending",
    blocked_workers: "Blocked workers",
    incomplete_sources: "Incomplete sources",
  };
  for (const item of digest.attention) lines.push(`${labels[item.kind]}: ${item.count}`);
  if (!digest.attention.length) lines.push("No owner decisions or blocked workers reported.");
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
