import { z } from "zod";
import type { ProjectsSettings } from "@clankie/protocol/projects";
import type { WorkConvention, WorkRepo } from "@clankie/protocol/work-items";
import { backendFor, readProjectDetails, readProjectWork, type LinearToolCall } from "@clankie/work-items";
import type { WorkRequest, WorkResult } from "./work-items.ts";

const ProjectSchema = z.object({
  id: z.string(),
  uuid: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  leadTeam: z.object({ id: z.string(), key: z.string().optional() }).nullish(),
  teams: z
    .union([
      z.array(z.object({ id: z.string(), key: z.string().optional() })),
      z.object({ nodes: z.array(z.object({ id: z.string(), key: z.string().optional() })) }),
    ])
    .optional(),
});
const PageSchema = z.object({
  projects: z.array(ProjectSchema),
  hasNextPage: z.boolean(),
  cursor: z.string().optional(),
});
const uuid = z.string().uuid();

/** Read-only project references in the current connected account, independent of local checkouts. */
export function createLinearWorkProjects(options: {
  call: LinearToolCall;
  binding(): Promise<string>;
  projects?(): Promise<ProjectsSettings>;
  builtInRepos(): Promise<readonly WorkRepo[]>;
  root: string;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let cached: { binding: string; until: number; value: Promise<z.infer<typeof ProjectSchema>[]> } | undefined;
  const check = async (binding: string) => {
    if ((await options.binding()) !== binding)
      throw new Error("Connected Linear account changed. Read the work again.");
  };
  const catalog = async () => {
    const binding = await options.binding();
    if (!cached || cached.binding !== binding || cached.until <= now()) {
      const value = (async () => {
        const projects: z.infer<typeof ProjectSchema>[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (;;) {
          await check(binding);
          const page = PageSchema.parse(
            await options.call("list_projects", {
              limit: 10,
              includeArchived: false,
              fields: ["id", "uuid", "name", "leadTeam", "teams"],
              ...(cursor ? { cursor } : {}),
            }),
          );
          await check(binding);
          projects.push(...page.projects);
          if (!page.hasNextPage) break;
          if (!page.cursor || cursors.has(page.cursor)) throw new Error("Incomplete Linear project list");
          cursors.add(page.cursor);
          cursor = page.cursor;
        }
        return projects;
      })();
      cached = { binding, until: now() + 60_000, value };
    }
    const projects = await cached.value;
    await check(binding);
    const [settings, builtIn] = await Promise.all([options.projects?.(), options.builtInRepos()]);
    await check(binding);
    const excluded = new Set(
      builtIn
        .filter((repo) => repo.backend === "builtin" && !repo.unavailable)
        .map((repo) => repo.trackerProjectId),
    );
    // An unavailable saved built-in binding must not fall back to its old Linear mirror.
    for (const repo of builtIn)
      if (repo.unavailable) {
        const saved = settings?.projects.find((project) => project.id === repo.projectId);
        if (saved?.trackerProjectId) excluded.add(saved.trackerProjectId);
      }
    const entries = projects.flatMap((project) => {
      const parsed = uuid.safeParse(project.uuid ?? project.id);
      if (!parsed.success || excluded.has(parsed.data)) return [];
      const id = parsed.data;
      const owners = settings?.projects.filter((owner) => owner.linearProjectBinding?.projectId === id) ?? [];
      const owner =
        owners.length === 1 &&
        !builtIn.some((repo) => repo.projectId === owners[0]!.id && repo.backend === "builtin")
          ? owners[0]
          : undefined;
      const repo: WorkRepo = {
        id: `linear-${id}`,
        name: project.name,
        backend: "linear",
        needsDecision: false,
        ...(owner ? { projectId: owner.id } : {}),
      };
      return [{ project, id, repo }];
    });
    return { binding, entries };
  };
  return {
    async repos(): Promise<WorkRepo[]> {
      return (await catalog()).entries.map((entry) => entry.repo);
    },
    async read(
      request: Extract<WorkRequest, { action: "list" | "show" | "activity" | "project" | "project-details" }>,
    ): Promise<WorkResult> {
      const { binding, entries } = await catalog();
      const entry = entries.find((entry) => entry.repo.id === request.repo);
      if (!entry) throw new Error("This Linear project is not available in the connected account.");
      const teams = Array.isArray(entry.project.teams) ? entry.project.teams : entry.project.teams?.nodes;
      const team = entry.project.leadTeam?.id ?? teams?.[0]?.id;
      if (!team) throw new Error("This Linear project's team is unavailable.");
      const call: LinearToolCall = async (name, args) => {
        await check(binding);
        const { team: _team, ...projectArgs } = args;
        // A project can span teams. Repo boards retain their own team scope elsewhere.
        const result = await options.call(
          name,
          name === "list_issues" && args.project === entry.id ? projectArgs : args,
        );
        if (name === "get_issue") {
          const issue = result as
            | { projectId?: unknown; project?: { id?: unknown; uuid?: unknown } }
            | undefined;
          if ((issue?.projectId ?? issue?.project?.uuid ?? issue?.project?.id) !== entry.id)
            throw new Error("This issue belongs to another project.");
        }
        await check(binding);
        return result;
      };
      const convention: WorkConvention = {
        schemaVersion: 1,
        backend: "linear",
        linear: { team, project: entry.id },
        releases: { source: "milestones", lane: "project" },
        decidedBy: "discovery",
        decidedAt: new Date(now()).toISOString(),
      };
      const deps = { linear: call };
      const backend = backendFor(options.root, convention, deps);
      let result: WorkResult;
      if (request.action === "project" || request.action === "project-details") {
        result = {
          repo: entry.repo,
          ...(await (request.action === "project" ? readProjectWork : readProjectDetails)(
            options.root,
            convention,
            deps,
          )),
        };
      } else if (request.action === "list") {
        result = {
          repo: entry.repo,
          items: await backend.list({
            ...(request.status ? { status: request.status } : {}),
            ...(request.owner ? { owner: request.owner } : {}),
            ...(request.label ? { label: request.label } : {}),
            limit: request.limit ?? 250,
          }),
        };
      } else if (request.action === "activity") {
        if (!backend.activity) throw new Error("This tracker keeps no activity");
        result = { repo: entry.repo, itemId: request.id, entries: await backend.activity(request.id) };
      } else {
        const item = await backend.get(request.id);
        if (!item) throw new Error("This issue is unavailable.");
        result = { repo: entry.repo, item };
      }
      await check(binding);
      return result;
    },
  };
}
