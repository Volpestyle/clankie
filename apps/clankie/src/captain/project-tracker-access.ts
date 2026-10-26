import { validateTrackerToolArgs } from "@clankie/work-items";
/** Host-side project fence for both direct and deferred remote lead tools.
 * Unknown operations stay unavailable until their target can be proved.
 */
const TOOLS = new Set([
  "save_guided_review",
  "get_guided_review",
  "list_guided_reviews",
  "post_guided_finding",
  "post_retire_guided_review",
  "save_issue_view",
  "get_issue_view",
  "list_issue_views",
  "list_issue_view_issues",
  "post_delete_issue_view",
  "get_issue",
  "list_issues",
  "search_issues",
  "save_issue",
  "get_project",
  "save_project",
  "list_comments",
  "save_comment",
  "create_comment",
  "list_milestones",
  "get_milestone",
  "get_status_updates",
  "save_status_update",
  "list_documents",
  "get_document",
  "get_user",
]);
export const projectTrackerTool = (name: string) => TOOLS.has(name);
type RecordValue = Record<string, unknown>;
type Read = (name: string, args: RecordValue) => Promise<unknown>;
function refuse(): never {
  throw new Error("remote_lead_tracker_project_denied");
}
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : refuse();
const resourceId = (value: unknown): unknown => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return undefined;
  const item = record(value);
  return item.uuid ?? item.id;
};
export function assertTrackerProject(value: unknown, project: string): void {
  const item = record(value);
  if (resourceId(item.projectId ?? item.project) !== project) refuse();
}

export async function authorizeProjectTrackerCall(
  name: string,
  args: RecordValue,
  project: string,
  read: Read,
): Promise<RecordValue> {
  if (!TOOLS.has(name) || args.repo !== undefined) refuse();
  validateTrackerToolArgs(name, args);
  const parameters = { ...args };
  const projectRef = async (reference: unknown) => {
    if (typeof reference !== "string") refuse();
    if (reference !== project && resourceId(await read("get_project", { query: reference })) !== project)
      refuse();
  };
  const issueRef = async (reference: unknown) => {
    if (typeof reference !== "string" || reference.length === 0) refuse();
    assertTrackerProject(await read("get_issue", { id: reference }), project);
  };
  // Reject explicit moves and filters before injecting an omitted project.
  if (args.project !== undefined) await projectRef(args.project);
  if (args.projectId !== undefined) await projectRef(args.projectId);
  switch (name) {
    case "save_guided_review":
    case "get_guided_review":
    case "list_guided_reviews":
    case "post_guided_finding":
    case "post_retire_guided_review":
      await issueRef(args.issueId);
      break;
    case "save_issue_view":
    case "get_issue_view":
    case "list_issue_views":
    case "list_issue_view_issues":
    case "post_delete_issue_view": {
      // No inference: the caller and persisted view must name this exact project.
      // The current backend checks store identity on every read/write/apply.
      if (args.project !== project) refuse();
      if (args.id !== undefined)
        assertTrackerProject(
          await read("get_issue_view", { id: args.id, project, storeId: args.storeId }),
          project,
        );
      if (args.filter !== undefined) {
        const filter = record(args.filter);
        if (filter.parentId !== undefined) await issueRef(filter.parentId);
      }
      break;
    }
    case "get_user":
      if (args.query !== "me") refuse();
      break;
    case "get_issue":
      // Expanded relations/releases may contain other projects' records.
      if (
        args.includeRelations === true ||
        args.includeReleases === true ||
        args.includeCustomerNeeds === true
      )
        refuse();
      await issueRef(args.id);
      break;
    case "save_issue":
      if (args.id !== undefined) await issueRef(args.id);
      parameters.project = project;
      for (const field of ["parentId", "duplicateOf"])
        if (args[field] !== undefined && args[field] !== null) await issueRef(args[field]);
      for (const field of [
        "blocks",
        "blockedBy",
        "relatedTo",
        "removeBlocks",
        "removeBlockedBy",
        "removeRelatedTo",
      ]) {
        if (args[field] === undefined) continue;
        if (!Array.isArray(args[field])) refuse();
        for (const reference of args[field] as unknown[]) await issueRef(reference);
      }
      break;
    case "list_issues":
    case "search_issues":
    case "list_milestones":
    case "list_documents":
      parameters.project = project;
      if (args.issueId !== undefined) await issueRef(args.issueId);
      break;
    case "get_project":
      await projectRef(args.query);
      parameters.query = project;
      break;
    case "save_project":
      await projectRef(args.id); // Creating an unrelated project is not delegated.
      parameters.id = project;
      break;
    case "get_milestone":
      assertTrackerProject(await read("get_milestone", { id: args.id }), project);
      break;
    case "get_status_updates":
    case "save_status_update":
      if (args.type !== "project") refuse();
      if (args.id !== undefined)
        assertTrackerProject(await read("get_status_updates", { type: "project", id: args.id }), project);
      if (args.id === undefined) parameters.project = project;
      else delete parameters.project;
      break;
    case "get_document": {
      const document = record(await read("get_document", { id: args.id }));
      if (document.issueId != null || document.issue != null)
        await issueRef(document.issueId ?? resourceId(document.issue));
      else assertTrackerProject(document, project);
      break;
    }
    case "list_comments":
    case "save_comment":
    case "create_comment": {
      // Editing/replying requires an explicit scoped target. Never trust a
      // caller's target as proof that an existing comment belongs to it.
      const targets = ["issueId", "projectId", "statusUpdateId"].filter((key) => args[key] !== undefined);
      if (targets.length !== 1) refuse();
      if (args.issueId !== undefined) await issueRef(args.issueId);
      if (args.statusUpdateId !== undefined)
        assertTrackerProject(
          await read("get_status_updates", { type: "project", id: args.statusUpdateId }),
          project,
        );
      for (const field of ["id", "parentId"]) {
        if (args[field] === undefined) continue;
        let cursor: unknown;
        const seen = new Set<unknown>();
        let found = false;
        do {
          const page = record(
            await read("list_comments", {
              ...Object.fromEntries(targets.map((key) => [key, args[key]])),
              limit: 250,
              ...(cursor === undefined ? {} : { cursor }),
            }),
          );
          if (!Array.isArray(page.comments)) refuse();
          found = page.comments.some((comment) => resourceId(comment) === args[field]);
          if (found || page.hasNextPage !== true) break;
          cursor = page.cursor;
          if (typeof cursor !== "string" || seen.has(cursor) || seen.size >= 100) refuse();
          seen.add(cursor);
        } while (!found);
        if (!found) refuse();
      }
      break;
    }
  }
  return parameters;
}
