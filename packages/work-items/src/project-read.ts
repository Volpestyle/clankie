import type { WorkConvention, WorkProjectFacts } from "@clankie/protocol/work-items";
import {
  WorkGoalSchema,
  WorkPlannedReleaseSchema,
  WorkShippedVersionSchema,
} from "@clankie/protocol/work-items";
import type { TrackerDeps } from "./tracker.ts";
import { ghCliApi } from "./backends/github.ts";
import { LINEAR_WORK_ITEM_FIELDS } from "./backends/linear.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tracker returned an invalid project fact");
  return value as Row;
};
const date = (value: unknown) => (typeof value === "string" && value ? { targetDate: value } : {});

/** Complete provider pagination, through the same host snapshot path as work items. */
async function collection(
  call: NonNullable<TrackerDeps["linear"]>,
  name: string,
  key: string,
  args: Row,
): Promise<Row[]> {
  const items: Row[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const result = await call(name, { ...args, limit: 250, ...(cursor === undefined ? {} : { cursor }) });
    const page = Array.isArray(result) ? undefined : row(result);
    const nodes = Array.isArray(result) ? result : page![key];
    if (!Array.isArray(nodes)) throw new Error("Tracker returned an incomplete project collection");
    items.push(...nodes.map(row));
    if (items.length > 25_000) throw new Error("Project facts exceed the read limit");
    if (!page || page.hasNextPage === false) return items;
    if (page.hasNextPage !== true || typeof page.cursor !== "string" || !page.cursor || seen.has(page.cursor))
      throw new Error("Tracker returned incomplete project pagination");
    cursor = page.cursor;
    seen.add(cursor);
  }
}

/** Facts only: neither a completed milestone nor an initiative implies shipment. */
export async function readProjectWork(
  root: string,
  convention: WorkConvention,
  deps: TrackerDeps,
): Promise<WorkProjectFacts> {
  const releaseSource = convention.releases?.source ?? "both";
  const lane = convention.releases?.lane ?? "repository";
  const facts: WorkProjectFacts = { releaseSource, planned: [], shipped: [], goals: [], unavailable: [] };
  const capture = async (
    read: "planned" | "shipped" | "goals",
    task: () => Promise<void>,
    message: string,
  ) => {
    try {
      await task();
    } catch {
      facts.unavailable.push({ read, message });
    }
  };
  const github =
    convention.backend === "github" ? (deps.github ?? (deps.gh ? ghCliApi(deps.gh) : undefined)) : undefined;
  const githubRoot = convention.github ? `repos/${convention.github.repo}` : undefined;

  if (releaseSource !== "tags")
    await capture(
      "planned",
      async () => {
        if (convention.backend === "linear") {
          const scope = convention.linear;
          if (!deps.linear || !scope?.project) throw new Error("No connected project");
          const milestones = await collection(deps.linear, "list_milestones", "milestones", {
            project: scope.project,
          });
          // Exactly the work-list fields/filters: this consumes its already cached scan,
          // and follows its snapshot cursors rather than fetching every milestone's issues.
          const issues = milestones.length
            ? await collection(deps.linear, "list_issues", "issues", {
                team: scope.team,
                project: scope.project,
                ...(scope.label ? { label: scope.label } : {}),
                fields: LINEAR_WORK_ITEM_FIELDS,
              })
            : [];
          facts.planned = milestones.map((milestone) =>
            WorkPlannedReleaseSchema.parse({
              id: milestone.id,
              name: milestone.name,
              ...date(milestone.targetDate),
              itemIds: issues
                .filter((issue) => {
                  const value = issue.milestone ?? issue.projectMilestone;
                  return value != null && row(value).id === milestone.id;
                })
                .map((issue) => issue.identifier ?? issue.id),
            }),
          );
        } else if (github && githubRoot) {
          const milestones = await github.list(`${githubRoot}/milestones?state=open&per_page=100`);
          const issues = milestones.length
            ? await github.list(`${githubRoot}/issues?state=all&per_page=100`)
            : [];
          facts.planned = milestones.map((value) => {
            const milestone = row(value);
            return WorkPlannedReleaseSchema.parse({
              id: String(milestone.number),
              name: milestone.title,
              ...date(milestone.due_on),
              itemIds: issues
                .map(row)
                .filter(
                  (issue) =>
                    issue.pull_request === undefined &&
                    issue.milestone != null &&
                    row(issue.milestone).number === milestone.number,
                )
                .map((issue) => `#${String(issue.number)}`),
            });
          });
        } else throw new Error("This tracker has no planned releases");
      },
      "Planned milestones are unavailable for this tracker or project.",
    );

  if (releaseSource !== "milestones")
    await capture(
      "shipped",
      async () => {
        const shipped: WorkProjectFacts["shipped"] = [];
        let partial = false;
        if (github && githubRoot) {
          try {
            for (const value of await github.list(`${githubRoot}/releases?per_page=100`)) {
              const release = row(value);
              if (
                release.draft === true ||
                typeof release.tag_name !== "string" ||
                !release.tag_name.startsWith("v")
              )
                continue;
              shipped.push(
                WorkShippedVersionSchema.parse({
                  version: release.tag_name,
                  lane,
                  date: release.published_at,
                  dateKind: "published",
                  itemIds: [],
                  location: release.html_url,
                }),
              );
            }
          } catch {
            partial = true;
          }
        }
        // No remote fetch and no commit-message inference. These are the tags this
        // host actually has, with annotated tag dates or explicit commit-date provenance.
        try {
          if (!deps.run) throw new Error("Local version tags are unavailable");
          const tags = await deps.run(
            "git",
            [
              "for-each-ref",
              "--format=%(refname:strip=2)%09%(objecttype)%09%(creatordate:iso-strict)",
              "refs/tags/v*",
            ],
            root,
          );
          for (const line of tags.trim().split("\n").filter(Boolean)) {
            const [version, kind, timestamp] = line.split("\t");
            if (shipped.some((entry) => entry.version === version)) continue;
            shipped.push(
              WorkShippedVersionSchema.parse({
                version,
                lane,
                date: timestamp,
                dateKind: kind === "tag" ? "tag" : "commit",
                itemIds: [],
              }),
            );
          }
        } catch {
          partial = true;
        }
        facts.shipped = shipped.sort((a, b) => b.date.localeCompare(a.date));
        if (partial) throw new Error("Some version sources are unavailable");
      },
      "Version tags or published versions could not be read. Store build and release-item associations are not inferred.",
    );

  if (convention.backend === "linear")
    await capture(
      "goals",
      async () => {
        const scope = convention.linear;
        if (!deps.linear || !scope?.project) throw new Error("No connected project");
        const candidates = await collection(deps.linear, "list_projects", "projects", {
          query: scope.project,
          fields: ["id", "name"],
        });
        const projects = candidates.filter((project) =>
          [project.id, project.name, project.identifier, project.slugId].some(
            (value) => typeof value === "string" && value.toLowerCase() === scope.project!.toLowerCase(),
          ),
        );
        if (projects.length !== 1) throw new Error("Project is not proven");
        const initiatives = await collection(deps.linear, "list_initiatives", "initiatives", {
          includeProjects: true,
        });
        const goals: WorkProjectFacts["goals"] = [];
        for (const initiative of initiatives) {
          if (!Array.isArray(initiative.projects)) throw new Error("Initiative projects are unavailable");
          const members = initiative.projects.map(row);
          if (
            !members.some(
              (project) => (project.uuid ?? project.id) === (projects[0]!.uuid ?? projects[0]!.id),
            )
          )
            continue;
          goals.push(
            WorkGoalSchema.parse({
              id: initiative.uuid ?? initiative.id,
              name: initiative.name,
              status: initiative.status,
              ...date(initiative.targetDate),
              projects: members.map((project) => ({
                id: project.uuid ?? project.id,
                name: project.name,
                ...(project.status == null
                  ? {}
                  : {
                      status: typeof project.status === "string" ? project.status : row(project.status).name,
                    }),
                ...(typeof project.progress === "number" ? { progress: project.progress } : {}),
              })),
            }),
          );
        }
        facts.goals = goals;
        if (goals.some((goal) => goal.projects.some((project) => project.progress === undefined)))
          facts.unavailable.push({
            read: "goals",
            message: "The connected tracker did not state progress for every goal project.",
          });
      },
      "Linear goals or their project progress could not be read.",
    );
  return facts;
}
