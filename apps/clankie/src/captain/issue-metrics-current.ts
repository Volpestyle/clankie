import type { IssueMetricsReport } from "@clankie/protocol";
import type { IssueHolder } from "../work-item-holders.ts";

type Current = NonNullable<IssueMetricsReport["summary"]>["current"];

/**
 * In progress is what live agents hold now (#318), never the tracker's state alone:
 * the distinct issues live seats in scope have stated they are working on.
 */
export async function readIssueMetricsCurrent(input: {
  roster: () => Promise<{
    liveSeats: number | null;
    /** Issue holders among the live seats in scope; null when membership is unknown. */
    holders: readonly IssueHolder[] | null;
    warnings: string[];
  }>;
}): Promise<Current> {
  const warnings: string[] = [];
  let liveSeats: number | null = null;
  let inProgressCount: number | null = null;
  try {
    const roster = await input.roster();
    liveSeats = roster.liveSeats;
    inProgressCount =
      roster.holders === null
        ? null
        : new Set(
            roster.holders.map((holder) =>
              JSON.stringify([holder.repoId ?? "", holder.itemId.replace(/^#/u, "").toLowerCase()]),
            ),
          ).size;
    warnings.push(...roster.warnings);
  } catch {
    warnings.push("Live fleet census unavailable");
  }
  return { observedAt: new Date().toISOString(), inProgressCount, liveSeats, warnings };
}
