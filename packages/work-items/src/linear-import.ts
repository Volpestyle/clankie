/** Provider records are retained beside their built-in projections, including unsupported metadata. */
export type LinearRecord = Record<string, unknown> & { id: string };
export interface LinearImportSnapshot {
  workspaceId: string;
  team: LinearRecord;
  projects: LinearRecord[];
  issues: LinearRecord[];
  comments: LinearRecord[];
  labels: LinearRecord[];
  milestones: LinearRecord[];
  documents: LinearRecord[];
  statusUpdates: LinearRecord[];
  cycles: LinearRecord[];
  actors: LinearRecord[];
  relations: LinearRecord[];
}
export const linearRow = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const linearId = (value: unknown): string | null =>
  typeof linearRow(value).id === "string" ? (linearRow(value).id as string) : null;

export interface LinearImportReport {
  workspaceId: string;
  counts: Record<string, number>;
  created: number;
  updated: number;
  unchanged: number;
  skipped: { type: string; id: string; reason: string }[];
  samples: string[];
  /** Linear project → built-in tracker project UUID, for an explicit `trackerProjectId` binding. */
  projects: { linearProjectId: string; trackerProjectId: string; name: string }[];
  /** Set for a webhook mirror change whose Linear event id was already applied. */
  duplicate?: boolean;
}

const PAGE = "pageInfo { hasNextPage endCursor }";
const USER = "id name displayName email";
const COMMENT = `id body createdAt updatedAt archivedAt parentId quotedText resolvedAt url user { ${USER} } onBehalfOf { ${USER} } botActor { id name type subType }`;
const DOCUMENT = `id title content createdAt updatedAt archivedAt slugId url sortOrder creator { ${USER} } project { id } issue { id }`;
const LABEL = "id name description color createdAt updatedAt archivedAt isGroup parent { id } team { id }";
const ATTACHMENT = "id title subtitle url createdAt updatedAt archivedAt metadata creator { id name }";
const ISSUE = `id identifier title description createdAt updatedAt archivedAt priority estimate dueDate startedAt completedAt canceledAt url previousIdentifiers team { id name key } project { id } projectMilestone { id } cycle { id } parent { id identifier title } creator { ${USER} } assignee { ${USER} } state { id name type }`;
const PROJECT = `id identifier name description content createdAt updatedAt archivedAt slugId url priority startDate targetDate status { id name type } lead { ${USER} } teams { nodes { id name key } }`;
const MILESTONE = "id name description targetDate sortOrder createdAt updatedAt archivedAt project { id }";
const STATUS_UPDATE = `id body health createdAt updatedAt archivedAt url user { ${USER} } project { id }`;
const RELATION =
  "id type createdAt updatedAt archivedAt issue { id identifier title } relatedIssue { id identifier title }";

type LinearQuery = (query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>;
type LinearPage = (owner: string, id: string, field: string, fields: string) => Promise<LinearRecord[]>;

function linearPager(q: LinearQuery): LinearPage {
  return async (owner, id, field, fields) => {
    const records: LinearRecord[] = [];
    let after: string | null = null;
    const seen = new Set<string>();
    do {
      const data = await q(
        `query($id:String!, $after:String) { ${owner}(id:$id) { ${field}(first:100, after:$after${field === "stateHistory" ? "" : ", includeArchived:true"}) { nodes { ${fields} } ${PAGE} } } }`,
        { id, after },
      );
      const connection = linearRow(linearRow(data[owner])[field]);
      if (!Array.isArray(connection.nodes)) throw new Error(`Missing Linear ${owner}.${field} connection`);
      records.push(...(connection.nodes as LinearRecord[]));
      const info = linearRow(connection.pageInfo);
      if (info.hasNextPage !== true) break;
      if (typeof info.endCursor !== "string" || seen.has(info.endCursor))
        throw new Error("Nonadvancing Linear cursor");
      seen.add(info.endCursor);
      after = info.endCursor;
    } while (after !== null);
    return records;
  };
}

async function collectLinearProject(q: LinearQuery, projectId: string) {
  const root = await q(`query($id:String!) { organization { id } project(id:$id) { ${PROJECT} } }`, {
    id: projectId,
  });
  const project = linearRow(root.project) as LinearRecord;
  if (!project.id) throw new Error("Linear project not found");
  const teams = linearRow(project.teams).nodes as LinearRecord[];
  if (teams.length !== 1)
    throw new Error("Import currently requires a single-team project; no team mapping was selected");
  return { workspaceId: String(linearRow(root.organization).id), project, team: teams[0]! };
}

function emptySnapshot(
  workspaceId: string,
  team: LinearRecord,
  projects: LinearRecord[],
): LinearImportSnapshot {
  return {
    workspaceId,
    team,
    projects,
    issues: [],
    comments: [],
    labels: [],
    milestones: [],
    documents: [],
    statusUpdates: [],
    cycles: [],
    actors: [],
    relations: [],
  };
}

/** One issue's graph: comments, state spans, history, labels, attachments, documents, relations. */
async function collectLinearIssueGraph(
  page: LinearPage,
  snapshot: LinearImportSnapshot,
  issue: LinearRecord,
): Promise<void> {
  snapshot.comments.push(
    ...(await page("issue", issue.id, "comments", COMMENT)).map((c) => ({ ...c, issueId: issue.id })),
  );
  issue.stateHistory = await page(
    "issue",
    issue.id,
    "stateHistory",
    "id startedAt endedAt state { id name type }",
  );
  issue.history = await page(
    "issue",
    issue.id,
    "history",
    `id createdAt updatedAt archivedAt actor { ${USER} } actorId fromState { id name type } toState { id name type } changes fromPriority toPriority fromProjectMilestone { id } toProjectMilestone { id } botActor { id name userDisplayName type subType }`,
  );
  issue.labels = await page("issue", issue.id, "labels", LABEL);
  snapshot.labels.push(...(issue.labels as LinearRecord[]));
  issue.attachments = await page("issue", issue.id, "attachments", ATTACHMENT);
  snapshot.documents.push(...(await page("issue", issue.id, "documents", DOCUMENT)));
  snapshot.relations.push(...(await page("issue", issue.id, "relations", RELATION)));
  snapshot.relations.push(...(await page("issue", issue.id, "inverseRelations", RELATION)));
}

/** Comment replies, source actors and de-duplication, shared by full and scoped collection. */
async function finishLinearSnapshot(
  page: LinearPage,
  snapshot: LinearImportSnapshot,
): Promise<LinearImportSnapshot> {
  const seenComments = new Set<string>();
  for (let index = 0; index < snapshot.comments.length; index++) {
    const comment = snapshot.comments[index]!;
    if (seenComments.has(comment.id)) continue;
    seenComments.add(comment.id);
    const replies = await page("comment", comment.id, "children", COMMENT);
    for (const reply of replies)
      if (!seenComments.has(reply.id))
        snapshot.comments.push({
          ...reply,
          issueId: comment.issueId,
          projectId: comment.projectId,
          statusUpdateId: comment.statusUpdateId,
          documentId: comment.documentId,
        });
  }
  const actors = new Map<string, LinearRecord>();
  for (const record of [
    ...snapshot.issues,
    ...snapshot.projects,
    ...snapshot.comments,
    ...snapshot.documents,
    ...snapshot.statusUpdates,
  ])
    for (const field of ["creator", "assignee", "lead", "user", "onBehalfOf", "botActor"]) {
      const actor = linearRow(record[field]);
      if (typeof actor.id === "string")
        actors.set(actor.id, {
          ...actor,
          ...(field === "botActor" ? { isBotActor: true } : {}),
        } as LinearRecord);
    }
  for (const issue of snapshot.issues)
    for (const history of (issue.history ?? []) as LinearRecord[]) {
      const user = linearRow(history.actor);
      if (typeof user.id === "string") actors.set(user.id, user as LinearRecord);
    }
  snapshot.actors = [...actors.values()];
  for (const key of ["comments", "documents", "relations", "labels"] as const)
    snapshot[key] = [...new Map(snapshot[key].map((record) => [record.id, record])).values()];
  return snapshot;
}

/** Every connection is paginated separately: no nested first-page truncation. Queries only. */
export async function collectLinearImport(input: {
  projectId: string;
  query: LinearQuery;
}): Promise<LinearImportSnapshot> {
  const q = input.query;
  const page = linearPager(q);
  const { workspaceId, project, team } = await collectLinearProject(q, input.projectId);
  const issues = await page("project", project.id, "issues", ISSUE);
  project.attachments = await page("project", project.id, "attachments", ATTACHMENT);
  const snapshot = emptySnapshot(workspaceId, team, [project]);
  snapshot.issues = issues;
  snapshot.milestones = await page("project", project.id, "projectMilestones", MILESTONE);
  snapshot.documents = await page("project", project.id, "documents", DOCUMENT);
  snapshot.statusUpdates = await page("project", project.id, "projectUpdates", STATUS_UPDATE);
  snapshot.comments.push(
    ...(await page("project", project.id, "comments", COMMENT)).map((c) => ({
      ...c,
      projectId: project.id,
    })),
  );
  snapshot.cycles = await page(
    "team",
    team.id,
    "cycles",
    "id number name description startsAt endsAt completedAt createdAt updatedAt archivedAt team { id }",
  );
  snapshot.labels = await page("team", team.id, "labels", LABEL);
  for (const issue of issues) await collectLinearIssueGraph(page, snapshot, issue);
  for (const update of snapshot.statusUpdates)
    snapshot.comments.push(
      ...(await page("projectUpdate", update.id, "comments", COMMENT)).map((c) => ({
        ...c,
        statusUpdateId: update.id,
      })),
    );
  for (const document of snapshot.documents)
    snapshot.comments.push(
      ...(await page("document", document.id, "comments", COMMENT)).map((c) => ({
        ...c,
        documentId: document.id,
      })),
    );
  return finishLinearSnapshot(page, snapshot);
}

/**
 * Mirror drift repair (VUH-1965): re-read only the named records with the import's
 * own field selections. Issues found outside the project are reported, never imported.
 */
export async function collectLinearScoped(input: {
  projectId: string;
  query: LinearQuery;
  issueIds?: readonly string[];
  milestones?: boolean;
  labels?: boolean;
  statusUpdates?: boolean;
}): Promise<{ snapshot: LinearImportSnapshot; outside: string[] }> {
  const q = input.query;
  const page = linearPager(q);
  const { workspaceId, project, team } = await collectLinearProject(q, input.projectId);
  project.attachments = await page("project", project.id, "attachments", ATTACHMENT);
  const snapshot = emptySnapshot(workspaceId, team, [project]);
  const outside: string[] = [];
  for (const id of new Set(input.issueIds ?? [])) {
    const issue = linearRow((await q(`query($id:String!) { issue(id:$id) { ${ISSUE} } }`, { id })).issue);
    if (typeof issue.id !== "string" || linearId(issue.project) !== project.id) {
      outside.push(id);
      continue;
    }
    snapshot.issues.push(issue as LinearRecord);
    await collectLinearIssueGraph(page, snapshot, issue as LinearRecord);
  }
  if (input.milestones)
    snapshot.milestones = await page("project", project.id, "projectMilestones", MILESTONE);
  if (input.labels) snapshot.labels.push(...(await page("team", team.id, "labels", LABEL)));
  if (input.statusUpdates)
    snapshot.statusUpdates = await page("project", project.id, "projectUpdates", STATUS_UPDATE);
  return { snapshot: await finishLinearSnapshot(page, snapshot), outside };
}
