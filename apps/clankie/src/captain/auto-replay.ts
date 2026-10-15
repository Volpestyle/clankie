import { z } from "zod";
import type { AutoRoundsResponse } from "@clankie/protocol/auto-rounds";
import { ProjectIdSchema, type Project } from "@clankie/protocol/projects";
import { localDays } from "@clankie/work-items";
import { withDrift } from "./auto-drift.ts";
import { measureVelocityWithin, type VelocityDeps } from "./auto-velocity.ts";

/** Bounded, read-only operator request. The range selects completed local days. */
export const AutoReplayQuerySchema = z
  .object({
    replay: z.literal("true"),
    project: ProjectIdSchema,
    since: z.iso.datetime({ offset: true }),
    until: z.iso.datetime({ offset: true }),
    includeWorkPolicy: z.literal("true").optional(),
  })
  .strict()
  .refine((value) => {
    const duration = Date.parse(value.until) - Date.parse(value.since);
    return duration > 0 && duration <= 14 * 86_400_000;
  }, "Replay needs an increasing window of at most 14 days");
export type AutoReplayQuery = z.infer<typeof AutoReplayQuerySchema>;
export class AutoReplayInputError extends Error {}

/** Same velocity and slice-1 detection as a live tick; no record write or wake capability. */
export async function replayAutoRounds(
  project: Project,
  query: AutoReplayQuery,
  deps: VelocityDeps,
  now = new Date(),
): Promise<AutoRoundsResponse> {
  AutoReplayQuerySchema.parse(query);
  if (Date.parse(query.until) > now.getTime())
    throw new AutoReplayInputError("Replay cannot read the future");
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const window = { since: new Date(query.since).toISOString(), until: new Date(query.until).toISOString() };
  const days = localDays(window, timeZone).filter(
    (day) => day.start >= window.since && day.end <= window.until,
  );
  if (!days.length) throw new AutoReplayInputError("Replay needs at least one complete local day");
  const rounds: AutoRoundsResponse["rounds"] = [];
  const deadline = Date.now() + 120_000;
  for (const day of days) {
    if (Date.now() >= deadline) throw new Error("Replay exceeded its two-minute measurement budget");
    const asOf = new Date(Date.parse(day.end) - 1).toISOString();
    const velocity = await measureVelocityWithin(
      project,
      null,
      {
        ...deps,
        outcomes: (target, input) => deps.outcomes(target, { ...input, asOf }),
      },
      new Date(day.end),
      Math.max(1, deadline - Date.now()),
    );
    rounds.push({
      roundId: `replay:${project.id}:${day.date}`,
      conversationId: "replay",
      at: day.end,
      delivery: null,
      projects: [
        {
          ...withDrift(velocity, []),
          caveats: [
            ...velocity.caveats,
            "Read-only replay: no wake, tracker write, round-record write or pending drift consumption.",
            ...(project.wipCap === undefined ? ["No WIP cap is set; over_wip cannot be evaluated."] : []),
          ],
        },
      ],
    });
  }
  return { schemaVersion: 1, rounds };
}
