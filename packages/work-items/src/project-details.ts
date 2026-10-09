import {
  WorkProjectDetailsSchema,
  type WorkConvention,
  type WorkProjectDetails,
} from "@clankie/protocol/work-items";
import { trackerToolsFor, type TrackerDeps } from "./tracker.ts";

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid project details");
  return value as Row;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function name(value: unknown): string | undefined {
  return typeof value === "string" ? text(value) : value ? text(row(value).name) : undefined;
}
/** Canonical Markdown retains uploaded media as links, including evidence-store references. */
function embeddedLinks(body: string): WorkProjectDetails["resources"] {
  return [...body.matchAll(/!?\[([^\]]*)\]\(<?((?:https?:\/\/|clankie:\/\/)[^\s)>]+)>?\)/gu)].map(
    (match) => ({ title: match[1] || "Media", url: match[2]! }),
  );
}
function links(values: unknown): WorkProjectDetails["resources"] {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new Error("Invalid project resources");
  return values.map((value) => {
    const item = row(value);
    const url = text(item.url);
    if (!url) throw new Error("Project resource has no location");
    return { title: text(item.title) ?? text(item.label) ?? text(item.name) ?? url, url };
  });
}

/** The same canonical tools read Linear and the built-in tracker. No account fallback or inferred project. */
export async function readProjectDetails(
  root: string,
  convention: WorkConvention,
  deps: TrackerDeps,
): Promise<WorkProjectDetails> {
  if (convention.backend !== "linear" || !convention.linear?.project)
    throw new Error("This tracker has no project details");
  const tools = trackerToolsFor(root, convention, deps);
  const project = row(
    await tools.call("get_project", { query: convention.linear.project, includeResources: true }),
  );
  const id = text(project.uuid) ?? text(project.id);
  if (!id) throw new Error("Project has no identity");
  const resources = project.resources ? row(project.resources) : {};
  const updates: WorkProjectDetails["updates"] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = row(
      await tools.call("get_status_updates", {
        type: "project",
        project: id,
        limit: 100,
        orderBy: "createdAt",
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!Array.isArray(page.statusUpdates)) throw new Error("Project updates unavailable");
    for (const value of page.statusUpdates) {
      const update = row(value);
      if (!text(update.id) || !text(update.createdAt) || typeof update.body !== "string")
        throw new Error("Incomplete project update");
      updates.push({
        id: text(update.id) ?? "",
        body: typeof update.body === "string" ? update.body : "",
        createdAt: text(update.createdAt) ?? "",
        health: text(update.health),
        author: name(update.user ?? update.author),
        attachments: [...links(update.attachments), ...embeddedLinks(update.body as string)],
      });
      if (updates.length === 200) break;
    }
    if (page.hasNextPage === false || updates.length >= 200) break;
    if (page.hasNextPage !== true || typeof page.cursor !== "string" || seen.has(page.cursor))
      throw new Error("Incomplete project update pagination");
    cursor = page.cursor;
    seen.add(cursor);
  } while (cursor);
  const teams = Array.isArray(project.teams) ? project.teams : project.teams ? row(project.teams).nodes : [];
  if (!Array.isArray(teams)) throw new Error("Project teams unavailable");
  return WorkProjectDetailsSchema.parse({
    id,
    name: project.name,
    identifier: text(project.identifier),
    summary: text(project.summary),
    description: text(project.description),
    status: name(project.status),
    priority: typeof project.priority === "number" ? project.priority : undefined,
    lead: name(project.lead),
    startDate: text(project.startDate),
    targetDate: text(project.targetDate),
    teams: teams.map(name).filter(Boolean),
    resources: [...links(resources.links), ...links(resources.documents), ...links(resources.attachments)],
    updates: updates.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
}
