import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { buildSchema, getVariableValues, parse, validate, type OperationDefinitionNode } from "graphql";

export const API_ACCESS = "lin_api_FIXTURE_secret_access_1383";
export const API_REFRESH = "lin_api_FIXTURE_secret_refresh_1383";
export const TEAM_ID = "00000000-0000-4000-8000-000000000001";
export const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
export const ISSUE_ID = "00000000-0000-4000-8000-000000000003";
export const USER_ID = "00000000-0000-4000-8000-000000000004";
export const LABEL_ID = "00000000-0000-4000-8000-000000000005";
export const STATE_ID = "00000000-0000-4000-8000-000000000006";
const STATUS_ID = "00000000-0000-4000-8000-000000000007";
export const COMMENT_ID = "00000000-0000-4000-8000-000000000008";
export const UPDATE_ID = "00000000-0000-4000-8000-000000000009";
const timestamp = "2026-10-05T02:00:00.000Z";
type Row = Record<string, unknown>;
const connection = (nodes: Row[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

/** Local HTTP OAuth/GraphQL provider validates real documents/input against the pinned SDK schema. */
export async function createLinearApiProvider() {
  const schema = buildSchema(await readFile(new URL("./linear-api/schema.graphql", import.meta.url), "utf8"));
  const team = { id: TEAM_ID, name: "Clankie", key: "VUH" };
  const user = { id: USER_ID, name: "Clankie", email: null, displayName: "Clankie", app: true };
  const label = {
    id: LABEL_ID,
    name: "Urgent",
    description: "",
    color: "#ff0000",
    isGroup: false,
    parent: null,
    team,
  };
  const state = { id: STATE_ID, name: "Done", type: "completed", team };
  const status = { id: STATUS_ID, name: "Started", type: "started" };
  const project: Row = {
    id: PROJECT_ID,
    name: "Clankie",
    identifier: "P-VUH-1",
    slugId: "clankie",
    content: "Project description",
    description: "Short summary",
    priority: 1,
    url: "https://linear.app/project/clankie",
    createdAt: timestamp,
    updatedAt: timestamp,
    startDate: null,
    targetDate: null,
    status,
    lead: user,
    teams: connection([team]),
    labels: connection([]),
    lastUpdate: null,
    members: connection([user]),
    projectMilestones: connection([{ id: "milestone", name: "Ship", description: "", targetDate: null }]),
    documents: connection([]),
    externalLinks: connection([]),
    attachments: connection([]),
  };
  const issue: Row = {
    id: ISSUE_ID,
    identifier: "VUH-1383",
    title: "Connect accounts",
    description: "Original description",
    descriptionData: null,
    priority: 1,
    url: "https://linear.app/issue/VUH-1383",
    createdAt: timestamp,
    updatedAt: timestamp,
    dueDate: null,
    estimate: null,
    team,
    project,
    state,
    assignee: user,
    parent: null,
    labels: connection([label]),
    children: connection([]),
    relations: connection([]),
    inverseRelations: connection([]),
  };
  const comment: Row = {
    id: COMMENT_ID,
    body: "Result",
    url: "https://linear.app/comment/result",
    createdAt: timestamp,
    updatedAt: timestamp,
    quotedText: null,
    parent: null,
    issue,
    project: null,
    projectUpdate: null,
    user,
  };
  const update: Row = {
    id: UPDATE_ID,
    body: "On track",
    createdAt: timestamp,
    updatedAt: timestamp,
    health: "onTrack",
    isDiffHidden: false,
    url: "https://linear.app/update/result",
    project,
    user,
  };
  project.lastUpdate = { ...update, project: undefined };
  // Avoid cycles in the HTTP fixture data while retaining actual entity references.
  issue.project = { id: PROJECT_ID, name: "Clankie" };
  comment.issue = { id: ISSUE_ID, identifier: "VUH-1383" };
  update.project = { id: PROJECT_ID, name: "Clankie" };
  const rows: Record<string, Row[]> = {
    issues: [issue],
    projects: [project],
    teams: [team],
    users: [user],
    issueLabels: [label],
    workflowStates: [state],
    projectStatuses: [status],
    comments: [comment],
    projectUpdates: [update],
    projectMilestones: [
      { id: "milestone", name: "Ship", description: "", targetDate: null, project: { id: PROJECT_ID } },
    ],
    projectLabels: [],
    issueRelations: [],
  };
  const entityLists: Record<string, string> = {
    issue: "issues",
    project: "projects",
    team: "teams",
    user: "users",
    comment: "comments",
    projectUpdate: "projectUpdates",
    issueLabel: "issueLabels",
  };
  const seen: Array<{
    path: string;
    body: string;
    authorization: string | undefined;
    query?: string | undefined;
  }> = [];
  const validationErrors: string[] = [];
  let access = API_ACCESS;
  let refresh = API_REFRESH;
  let rotations = 0;
  let reject = false;
  let blockedMutationResponse: { started: () => void; wait: Promise<void> } | undefined;
  let blockedRead: { started: () => void; wait: Promise<void> } | undefined;
  let blocked: { started: () => void; wait: Promise<void> } | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const path = request.url ?? "/";
    const entry = {
      path,
      body,
      authorization: request.headers.authorization,
      query: undefined as string | undefined,
    };
    seen.push(entry);
    const json = (statusCode: number, value: unknown) => {
      response.writeHead(statusCode, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (path === "/oauth/token") {
      const parameters = new URLSearchParams(body);
      if (blocked) {
        const gate = blocked;
        blocked = undefined;
        gate.started();
        await gate.wait;
      }
      if (parameters.get("grant_type") === "refresh_token") {
        if (parameters.get("refresh_token") !== refresh)
          return json(400, { error: "invalid_grant", error_description: refresh });
        access = `${API_ACCESS}_${++rotations}`;
        refresh = `${API_REFRESH}_${rotations}`;
      } else if (parameters.get("code") !== "good-code" || !parameters.get("code_verifier"))
        return json(400, { error: "invalid_grant", error_description: `${API_ACCESS} ${API_REFRESH}` });
      return json(200, {
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 86400,
        scope: "read write",
      });
    }
    if (path === "/oauth/revoke") return json(200, {});
    if (path !== "/graphql") return json(404, {});
    if (blockedRead) {
      const gate = blockedRead;
      blockedRead = undefined;
      gate.started();
      await gate.wait;
    }
    if (reject) return json(503, { message: `${access} ${refresh}` });
    if (request.headers.authorization !== `Bearer ${access}`) return json(401, { message: access });
    try {
      const envelope = JSON.parse(body) as { query: string; variables?: Row };
      entry.query = envelope.query;
      const document = parse(envelope.query);
      const errors = validate(schema, document);
      const operation = document.definitions.find(
        (item): item is OperationDefinitionNode => item.kind === "OperationDefinition",
      );
      if (!operation) throw new Error("Missing operation");
      const inputs = getVariableValues(schema, operation.variableDefinitions ?? [], envelope.variables ?? {});
      if (errors.length || inputs.errors?.length) {
        const messages = [...errors, ...(inputs.errors ?? [])].map((error) => error.message);
        validationErrors.push(...messages);
        return json(400, { errors: messages.map((message) => ({ message })) });
      }
      const variables = inputs.coerced ?? {};
      const data: Row = {};
      for (const selection of operation.selectionSet.selections) {
        if (selection.kind !== "Field") continue;
        const field = selection.name.value;
        const key = selection.alias?.value ?? field;
        if (field === "viewer") data[key] = user;
        else if (field === "organization") data[key] = { id: "personal-workspace", name: "Personal" };
        else if (field === "searchIssues") data[key] = connection(rows.issues!);
        else if (rows[field]) data[key] = connection(rows[field]!);
        else if (operation.operation !== "mutation" && entityLists[field])
          data[key] =
            rows[entityLists[field]!]!.find((row) =>
              [row.id, row.identifier, row.slugId].includes(variables.id),
            ) ?? null;
        else if (field.endsWith("Create") || field.endsWith("Update")) {
          const entity = field.replace(/(?:Create|Update)$/u, "");
          const list = entityLists[entity];
          const input = (variables.input as Row) ?? {};
          if (!list) {
            data[key] = { success: true };
            continue;
          }
          const existing = variables.id ? rows[list]!.find((row) => row.id === variables.id) : undefined;
          const base = existing ?? {
            ...rows[list]?.[0],
            id: `${String(rows[list]!.length + 10).padStart(8, "0")}-0000-4000-8000-000000000000`,
          };
          Object.assign(base, input, { updatedAt: timestamp });
          if (!existing && entity === "issue") base.identifier = `VUH-${rows[list]!.length + 10}`;
          if (input.assigneeId !== undefined) base.assignee = input.assigneeId === null ? null : user;
          if (input.parentId !== undefined)
            base.parent = input.parentId === null ? null : { id: input.parentId, identifier: "VUH-1" };
          if (input.stateId !== undefined) base.state = state;
          if (input.projectId !== undefined)
            base.project = input.projectId === null ? null : { id: input.projectId, name: "Clankie" };
          if (input.labelIds || input.addedLabelIds) base.labels = connection([label]);
          if (!existing) rows[list]!.push(base);
          data[key] = { success: true, [entity]: base };
        } else if (field.endsWith("Delete")) data[key] = { success: true };
        else throw new Error(`Unimplemented fixture field ${field}`);
      }
      if (operation.operation === "mutation" && blockedMutationResponse) {
        const gate = blockedMutationResponse;
        blockedMutationResponse = undefined;
        gate.started();
        await gate.wait;
      }
      return json(200, { data });
    } catch (error) {
      validationErrors.push(error instanceof Error ? error.message : String(error));
      return json(500, { errors: [{ message: "fixture failure" }] });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  const routedFetch: typeof fetch = (input, init) =>
    fetch(
      String(input instanceof Request ? input.url : input).replace("https://api.linear.app", origin),
      init,
    );
  return {
    origin,
    fetch: routedFetch,
    seen,
    validationErrors,
    rows,
    issue,
    project,
    user,
    blockNextGraphql: () => {
      let started!: () => void;
      let release!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      blockedRead = { started, wait };
      return { started: startedPromise, release };
    },
    reject: (value: boolean) => {
      reject = value;
    },
    blockNextMutationResponse: () => {
      let started!: () => void;
      let release!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      blockedMutationResponse = { started, wait };
      return { started: startedPromise, release };
    },
    blockNextExchange: () => {
      let started!: () => void;
      let release!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      blocked = { started, wait };
      return { started: startedPromise, release };
    },
    close: () =>
      new Promise<void>((resolve, fail) => server.close((error) => (error ? fail(error) : resolve()))),
  };
}
