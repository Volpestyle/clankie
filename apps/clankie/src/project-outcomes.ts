import type { Project } from "@clankie/protocol/projects";
import {
  collectLinearOutcomes,
  type LinearQuery,
  type LocalTrackerBackend,
  type OutcomeWindow,
  type TrackerOutcomes,
} from "@clankie/work-items";
import { withLinearRequestInvocation } from "./tracker-request-priority.ts";

export type ProjectOutcomesRead =
  | { readonly state: "read"; readonly outcomes: TrackerOutcomes }
  | { readonly state: "unavailable"; readonly reason: string };

/**
 * One project's tracker outcomes for an Auto round (ADR 0270), from the backend its
 * workers write to: `route` is the work service's `trackerRepoForProject` (undefined
 * means Linear). Linear reads are one background admission, so under budget pressure
 * they yield to owner and lead work. A refusal or gap is reported, never a zero.
 */
export async function readProjectOutcomes(
  project: Project,
  input: {
    readonly window: OutcomeWindow;
    readonly history?: boolean;
    readonly media?: boolean;
    readonly asOf?: string;
  },
  deps: {
    readonly route: (projectId: string) => Promise<string | undefined>;
    readonly linearQuery: () => Promise<LinearQuery>;
    readonly builtIn: Pick<LocalTrackerBackend, "readOutcomes">;
  },
): Promise<ProjectOutcomesRead> {
  const unavailable = (reason: string): ProjectOutcomesRead => ({ state: "unavailable", reason });
  let repo: string | undefined;
  try {
    repo = await deps.route(project.id);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  try {
    if (repo === undefined) {
      const projectId = project.linearProjectBinding?.projectId;
      if (projectId === undefined)
        return unavailable("Its tracker is Linear, but no Linear project is bound.");
      return {
        state: "read",
        outcomes: await withLinearRequestInvocation("background", async () =>
          collectLinearOutcomes({ projectId, query: await deps.linearQuery(), ...input }),
        ),
      };
    }
    if (project.trackerProjectId === undefined)
      return unavailable("Outcome reads cover Linear and the built-in tracker; this project uses neither.");
    return {
      state: "read",
      outcomes: await deps.builtIn.readOutcomes({ projectId: project.trackerProjectId, ...input }),
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}
