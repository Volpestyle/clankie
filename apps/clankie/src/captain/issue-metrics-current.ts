import type { IssueMetricsReport } from "@clankie/protocol";
import type { SeatIssueTrackerScope } from "./seat-issue-status.ts";

type Current = NonNullable<IssueMetricsReport["summary"]>["current"];

/** Read-only census through the same saved tracker scopes used by seat status.
 * Never run the daily status reconciler: it saves state and can settle issues. */
export async function readIssueMetricsCurrent(input: {
  projectIds: string[];
  tracker: (projectId: string) => Promise<SeatIssueTrackerScope>;
  roster: () => Promise<{ liveSeats: number | null; warnings: string[] }>;
}): Promise<Current> {
  const warnings: string[] = [];
  let inProgressCount: number | null = 0;
  const seen = new Set<string>();
  for (const project of input.projectIds) {
    try {
      const tracker = await input.tracker(project);
      let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page === 100) throw new Error("tracker pagination exceeds 100 pages");
        const value = (await tracker.call(
          "list_issues",
          { state: "started", limit: 250, ...(cursor ? { cursor } : {}) },
          "interactive",
        )) as {
          issues?: { id: string; status?: string }[];
          hasNextPage?: boolean;
          cursor?: string;
        };
        if (!Array.isArray(value.issues)) throw new Error("tracker did not return an issue page");
        for (const row of value.issues)
          if (row.status?.toLowerCase() === "in progress") seen.add(`${tracker.identity}:${row.id}`);
        if (!value.hasNextPage) break;
        if (!value.cursor || value.cursor === cursor) throw new Error("tracker cursor unavailable");
        cursor = value.cursor;
      }
    } catch (error) {
      inProgressCount = null;
      warnings.push(
        `In Progress unavailable for ${project}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!input.projectIds.length) {
    inProgressCount = null;
    warnings.push("No configured tracker projects");
  }
  if (inProgressCount !== null) inProgressCount = seen.size;
  let liveSeats: number | null = null;
  try {
    const roster = await input.roster();
    liveSeats = roster.liveSeats;
    warnings.push(...roster.warnings);
  } catch {
    warnings.push("Live fleet census unavailable");
  }
  return { observedAt: new Date().toISOString(), inProgressCount, liveSeats, warnings };
}
