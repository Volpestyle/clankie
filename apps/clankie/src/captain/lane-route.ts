import type { LaneSession } from "./captain-types.ts";
import type { CaptainModelRuntime } from "./model.ts";

/** Pi's answers to a compaction request that leave nothing to do. */
const BENIGN_COMPACTION_REFUSALS = new Set(["Already compacted", "Nothing to compact (session too small)"]);

/**
 * Resolve an idle lane's route for its next run, then compact if the last run was trimmed.
 * The route comes first: resolving it refuses while Clankie only watches (ADR 0307), and
 * compaction sends the session's history to a model, so nothing reaches a provider then.
 */
export async function routeLaneRun(
  lane: Pick<LaneSession, "purpose" | "budget" | "session">,
  runtime: Pick<CaptainModelRuntime, "resolveRoute">,
): Promise<Awaited<ReturnType<CaptainModelRuntime["resolveRoute"]>>> {
  const route = await runtime.resolveRoute(lane.purpose);
  if (lane.budget.compactBeforeNextRun) {
    lane.budget.compactBeforeNextRun = false;
    // A request had to be trimmed to fit the included-usage limit: compact now,
    // while idle, so this run's requests fit whole.
    await lane.session.compact().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // Pi's own threshold may already have compacted, or the bytes were
      // images that compaction cannot shrink; the request budget still holds.
      if (BENIGN_COMPACTION_REFUSALS.has(message)) return;
      console.warn("Compaction before the next run failed:", message);
    });
  }
  return route;
}
