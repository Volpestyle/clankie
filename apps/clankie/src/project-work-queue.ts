import type { AutoWorkQueue } from "@clankie/protocol/auto-rounds";
import type { Project } from "@clankie/protocol/projects";
import type { LinearQuery, LocalTrackerBackend } from "@clankie/work-items";
import { withLinearRequestInvocation } from "./tracker-request-priority.ts";

type Row = Record<string, unknown>;
const node = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed tracker queue");
  return value as Row;
};
const relationFields =
  "id type issue { id identifier state { type } } relatedIssue { id identifier state { type } }";
const connection = (fields: string) => `nodes { ${fields} } pageInfo { hasNextPage endCursor }`;
const open = (issue: Row) => !["completed", "canceled", "duplicate"].includes(String(node(issue.state).type));

/** Exact current tracker route, read only; an unavailable queue is never an empty backlog. */
export async function readProjectWorkQueue(
  project: Project,
  deps: {
    route(projectId: string): Promise<string | undefined>;
    linearQuery(): Promise<LinearQuery>;
    builtIn: Pick<LocalTrackerBackend, "readWorkQueue">;
  },
): Promise<AutoWorkQueue> {
  try {
    const repo = await deps.route(project.id);
    if (repo !== undefined) {
      if (!project.trackerProjectId) throw new Error("No built-in project bound");
      return await deps.builtIn.readWorkQueue(project.trackerProjectId);
    }
    if (!project.linearProjectBinding?.projectId) throw new Error("No Linear project bound");
    return await withLinearRequestInvocation("background", async () => {
      const query = await deps.linearQuery();
      const deadline = Date.now() + 30_000;
      const page = async (
        owner: string,
        id: string,
        field: string,
        fields: string,
        filter = "",
        pageSize = 50,
      ): Promise<Row[]> => {
        const rows: Row[] = [],
          seen = new Set<string>();
        let after: string | null = null;
        for (;;) {
          if (Date.now() >= deadline) throw new Error("Tracker queue measurement exceeded 30 seconds");
          const result = await query(
            `query($id:String!, $after:String) { ${owner}(id:$id) { ${field}(first:${pageSize}, after:$after${filter}) { ${connection(fields)} } } }`,
            { id, after },
          );
          const data = node(node(result[owner])[field]);
          if (!Array.isArray(data.nodes)) throw new Error("Incomplete tracker queue");
          rows.push(...data.nodes.map(node));
          const info = node(data.pageInfo);
          if (info.hasNextPage === false) return rows;
          if (info.hasNextPage !== true || typeof info.endCursor !== "string" || seen.has(info.endCursor))
            throw new Error("Nonadvancing tracker queue cursor");
          after = info.endCursor;
          seen.add(after);
        }
      };
      const issues = await page(
        "project",
        project.linearProjectBinding!.projectId,
        "issues",
        `id identifier state { name type } labels(first:50) { ${connection("name")} } relations(first:50) { ${connection(relationFields)} } inverseRelations(first:50) { ${connection(relationFields)} }`,
        ', filter:{ state:{ type:{ nin:["completed","canceled","duplicate"] } } }',
        // The same nested graph at 50 costs 35,346 (provider maximum 10,000).
        // Bound outer pages; continue every cursor and overflow edge page.
        10,
      );
      const relations = new Map<string, Row>();
      const held = new Map<string, string>();
      for (const issue of issues) {
        const labels = node(issue.labels);
        if (!Array.isArray(labels.nodes) || node(labels.pageInfo).hasNextPage !== false)
          throw new Error("Incomplete blocker labels");
        if (
          labels.nodes.some((label: unknown) =>
            /^(?:needs?[- ]owner|owner[- ]blocked|blocked[- ]on[- ]owner)$/iu.test(String(node(label).name)),
          ) ||
          /^(?:needs? owner|owner blocked|blocked on owner)$/iu.test(String(node(issue.state).name))
        )
          held.set(String(issue.id), "owner dependency");
        for (const field of ["relations", "inverseRelations"]) {
          const data = node(issue[field]);
          const rows =
            node(data.pageInfo).hasNextPage === false && Array.isArray(data.nodes)
              ? data.nodes.map(node)
              : await page("issue", String(issue.id), field, relationFields);
          for (const relation of rows) relations.set(String(relation.id), relation);
        }
      }
      const incoming = new Map<string, string[]>(),
        outgoing = new Map<string, string[]>();
      for (const relation of relations.values()) {
        if (relation.type !== "blocks") continue;
        const source = node(relation.issue),
          target = node(relation.relatedIssue);
        if (!open(source) || !open(target)) continue;
        incoming.set(String(target.id), [
          ...(incoming.get(String(target.id)) ?? []),
          String(source.identifier),
        ]);
        outgoing.set(String(source.id), [
          ...(outgoing.get(String(source.id)) ?? []),
          String(target.identifier),
        ]);
      }
      const blocked = issues.filter((issue) => held.has(String(issue.id)) || incoming.has(String(issue.id)));
      const available = issues.filter((issue) => !blocked.includes(issue));
      return {
        state: "known",
        ready: available
          .filter((issue) => node(issue.state).type === "unstarted")
          .map((issue) => String(issue.identifier)),
        backlog: available
          .filter((issue) => node(issue.state).type === "backlog")
          .map((issue) => String(issue.identifier)),
        blocked: blocked.map((issue) => ({
          issue: String(issue.identifier),
          blocks: [...new Set(outgoing.get(String(issue.id)) ?? [])],
          reason:
            held.get(String(issue.id)) ??
            `blocked by ${[...new Set(incoming.get(String(issue.id)))].join(", ")}`,
        })),
      };
    });
  } catch (error) {
    return { state: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}
