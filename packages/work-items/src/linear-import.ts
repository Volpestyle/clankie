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
}

const PAGE = "pageInfo { hasNextPage endCursor }";
const USER = "id name displayName email";
const COMMENT = `id body createdAt updatedAt archivedAt parentId quotedText resolvedAt url user { ${USER} } onBehalfOf { ${USER} } botActor { id name type subType }`;
const DOCUMENT = `id title content createdAt updatedAt archivedAt slugId url sortOrder creator { ${USER} } project { id } issue { id }`;
const LABEL = "id name description color createdAt updatedAt archivedAt isGroup parent { id } team { id }";
const ATTACHMENT = "id title subtitle url createdAt updatedAt archivedAt metadata creator { id name }";
const ISSUE = `id identifier title description createdAt updatedAt archivedAt priority estimate dueDate startedAt completedAt canceledAt url previousIdentifiers team { id name key } project { id } projectMilestone { id } cycle { id } parent { id identifier title } creator { ${USER} } assignee { ${USER} } state { id name type }`;

/** Every connection is paginated separately: no nested first-page truncation. Queries only. */
export async function collectLinearImport(input: {
  projectId: string;
  query: (query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>;
}): Promise<LinearImportSnapshot> {
  const q = input.query;
  const root = await q(
    `query($id:String!) { organization { id } project(id:$id) { id identifier name description content createdAt updatedAt archivedAt slugId url priority startDate targetDate status { id name type } lead { ${USER} } teams { nodes { id name key } } } }`,
    { id: input.projectId },
  );
  const project = linearRow(root.project) as LinearRecord;
  if (!project.id) throw new Error("Linear project not found");
  const teams = linearRow(project.teams).nodes as LinearRecord[];
  if (teams.length !== 1)
    throw new Error("Import currently requires a single-team project; no team mapping was selected");
  const team = teams[0]!;
  const page = async (owner: string, id: string, field: string, fields: string): Promise<LinearRecord[]> => {
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
  const issues = await page("project", project.id, "issues", ISSUE);
  project.attachments = await page("project", project.id, "attachments", ATTACHMENT);
  const snapshot: LinearImportSnapshot = {
    workspaceId: String(linearRow(root.organization).id),
    team,
    projects: [project],
    issues,
    comments: [],
    labels: [],
    milestones: [],
    documents: [],
    statusUpdates: [],
    cycles: [],
    actors: [],
    relations: [],
  };
  snapshot.milestones = await page(
    "project",
    project.id,
    "projectMilestones",
    "id name description targetDate sortOrder createdAt updatedAt archivedAt project { id }",
  );
  snapshot.documents = await page("project", project.id, "documents", DOCUMENT);
  snapshot.statusUpdates = await page(
    "project",
    project.id,
    "projectUpdates",
    `id body health createdAt updatedAt archivedAt url user { ${USER} } project { id }`,
  );
  snapshot.comments.push(
    ...(await page("project", project.id, "comments", COMMENT)).map((c) => ({ ...c, projectId: project.id })),
  );
  snapshot.cycles = await page(
    "team",
    team.id,
    "cycles",
    "id number name description startsAt endsAt completedAt createdAt updatedAt archivedAt team { id }",
  );
  snapshot.labels = await page("team", team.id, "labels", LABEL);
  for (const issue of issues) {
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
    snapshot.relations.push(
      ...(await page(
        "issue",
        issue.id,
        "relations",
        "id type createdAt updatedAt archivedAt issue { id identifier title } relatedIssue { id identifier title }",
      )),
    );
    snapshot.relations.push(
      ...(await page(
        "issue",
        issue.id,
        "inverseRelations",
        "id type createdAt updatedAt archivedAt issue { id identifier title } relatedIssue { id identifier title }",
      )),
    );
  }
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
    ...issues,
    project,
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
  snapshot.actors = [...actors.values()];
  for (const issue of issues)
    for (const history of issue.history as LinearRecord[]) {
      const user = linearRow(history.actor);
      if (typeof user.id === "string") actors.set(user.id, user as LinearRecord);
    }
  snapshot.actors = [...actors.values()];
  for (const key of ["comments", "documents", "relations", "labels"] as const)
    snapshot[key] = [...new Map(snapshot[key].map((record) => [record.id, record])).values()];
  return snapshot;
}
