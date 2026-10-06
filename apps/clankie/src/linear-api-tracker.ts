import { AsyncLocalStorage } from "node:async_hooks";
import {
  LINEAR_API_GRAPHQL_ENDPOINT,
  LINEAR_API_PROVIDER_ID,
  resolveProviderBearer,
  type CredentialStore,
} from "@clankie/credential-broker";
import {
  TRACKER_TOOLS,
  applyTrackerDescriptionPatch,
  validateTrackerToolArgs,
  type TrackerToolBackend,
  type TrackerToolCallOptions,
} from "@clankie/work-items";
import { z } from "zod";
import { callPrioritySortedLinearIssues } from "./tracker-tool-router.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LinearApiTrackerError("invalid_response");
  return value as RecordValue;
};
const uuid = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
const PAGE = "pageInfo { hasNextPage endCursor }";
const ISSUE =
  "id identifier title description priority url createdAt updatedAt dueDate estimate team { id name key } project { id name } state { id name type } assignee { id name email } projectMilestone { id name } parent { id identifier } labels { nodes { id name } }";
const PROJECT =
  "id name identifier slugId description content priority url createdAt updatedAt startDate targetDate status { id name type } lead { id name email } teams { nodes { id name key } } labels { nodes { id name } } lastUpdate { id body health createdAt updatedAt url }";
const USER = "id name displayName email";
const TEAM = "id name key";
const COMMENT =
  "id body url createdAt updatedAt quotedText parent { id } issue { id identifier } project { id } projectUpdate { id } user { id name }";
const UPDATE = "id body createdAt updatedAt health isDiffHidden url project { id name } user { id name }";
const LABEL = "id name description color isGroup team { id } parent { id }";
const RELATION = "id type issue { id identifier } relatedIssue { id identifier }";

class LinearApiTrackerError extends Error {
  public readonly code:
    | "provider_rejected"
    | "unavailable"
    | "invalid_response"
    | "unsupported_operation"
    | "not_found"
    | "ambiguous_resource"
    | "resource_changed";
  public constructor(code: LinearApiTrackerError["code"], detail?: string) {
    super(detail ?? `Linear API ${code}`);
    this.code = code;
  }
}

/** Registered API OAuth stays inside the body; the public tool vocabulary carries no credentials. */
export function createLinearApiTracker(options: {
  credentials: CredentialStore;
  fetch?: typeof fetch;
}): TrackerToolBackend {
  const request = options.fetch ?? fetch;
  const invocation = new AsyncLocalStorage<TrackerToolCallOptions>();
  const graphql = async (
    query: string,
    variables: RecordValue = {},
    publication?: TrackerToolCallOptions,
  ): Promise<RecordValue> => {
    const bearer = await resolveProviderBearer(LINEAR_API_PROVIDER_ID, options.credentials, Date.now(), {
      fetch: request,
    });
    if (!bearer) throw new LinearApiTrackerError("unavailable", "Connect Linear to use the API tracker");
    const authority = publication ?? invocation.getStore();
    await authority?.beforeWrite?.();
    publication?.onDispatch?.();
    let response: Response;
    try {
      response = await request(LINEAR_API_GRAPHQL_ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new LinearApiTrackerError("unavailable");
    }
    if (!response.ok) throw new LinearApiTrackerError("provider_rejected");
    const text = await response.text();
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new LinearApiTrackerError("invalid_response");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LinearApiTrackerError("invalid_response");
    }
    const parsed = z
      .object({ data: z.record(z.string(), z.unknown()).nullish(), errors: z.array(z.unknown()).optional() })
      .safeParse(json);
    // Provider errors can echo submitted codes/tokens; only closed codes escape.
    if (!parsed.success || !parsed.data.data) throw new LinearApiTrackerError("invalid_response");
    if (parsed.data.errors?.length) throw new LinearApiTrackerError("provider_rejected");
    if (publication) {
      const results = Object.values(parsed.data.data).map(record);
      if (results.some((result) => result.success !== true))
        throw new LinearApiTrackerError("invalid_response");
      publication.effectConfirmed?.();
    }
    const credential = await options.credentials.get(LINEAR_API_PROVIDER_ID);
    const secrets = [bearer, credential?.type === "oauth" ? credential.refresh : undefined].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const redact = (value: unknown): unknown => {
      if (typeof value === "string")
        return secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)]));
      return value;
    };
    return record(redact(parsed.data.data));
  };
  const one = async (field: string, id: string, selection: string) => {
    const data = await graphql(`query TrackerRead($id: String!) { ${field}(id: $id) { ${selection} } }`, {
      id,
    });
    if (!data[field]) throw new LinearApiTrackerError("not_found");
    return record(data[field]);
  };
  const page = async (
    field: string,
    filterType: string,
    selection: string,
    args: RecordValue,
    filter: RecordValue = {},
  ) => {
    const filtered = !["projectStatuses", "issueRelations"].includes(field);
    const searched = field === "searchIssues";
    const data = await graphql(
      `query TrackerList(${searched ? "$term: String!, " : ""}${filtered ? `$filter: ${filterType}, ` : ""}$first: Int!, $after: String, $orderBy: PaginationOrderBy, $includeArchived: Boolean) { ${field}(${searched ? "term: $term, " : ""}${filtered ? "filter: $filter, " : ""}first: $first, after: $after, orderBy: $orderBy, includeArchived: $includeArchived) { nodes { ${selection} } ${PAGE} } }`,
      {
        ...(searched ? { term: args.query } : {}),
        filter,
        first: args.limit ?? 50,
        after: args.cursor ?? null,
        orderBy: args.orderBy ?? "updatedAt",
        includeArchived: args.includeArchived ?? false,
      },
    );
    const connection = record(data[field]);
    const info = record(connection.pageInfo);
    if (
      !Array.isArray(connection.nodes) ||
      typeof info.hasNextPage !== "boolean" ||
      (info.hasNextPage && typeof info.endCursor !== "string")
    )
      throw new LinearApiTrackerError("invalid_response");
    return {
      nodes: connection.nodes.map(record),
      hasNextPage: info.hasNextPage,
      cursor: info.endCursor ?? undefined,
    };
  };
  const all = async (field: string, filterType: string, selection: string, filter: RecordValue = {}) => {
    const nodes: RecordValue[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const result = await page(field, filterType, selection, { limit: 250, cursor }, filter);
      nodes.push(...result.nodes);
      if (nodes.length > 25_000)
        throw new LinearApiTrackerError("invalid_response", "Linear lookup is too broad");
      if (!result.hasNextPage) return nodes;
      const next = String(result.cursor);
      if (seen.has(next)) throw new LinearApiTrackerError("invalid_response");
      seen.add(next);
      cursor = next;
    }
  };
  const resolve = async (
    kind: "team" | "project" | "user" | "label" | "state" | "projectStatus",
    value: unknown,
    teamId?: string,
  ): Promise<RecordValue> => {
    if (typeof value !== "string" || !value) throw new LinearApiTrackerError("not_found");
    if (kind === "user" && value === "me")
      return record((await graphql(`query TrackerViewer { viewer { ${USER} } }`)).viewer);
    const specs = {
      team: ["teams", "TeamFilter", TEAM],
      project: ["projects", "ProjectFilter", PROJECT],
      user: ["users", "UserFilter", USER],
      label: ["issueLabels", "IssueLabelFilter", LABEL],
      state: ["workflowStates", "WorkflowStateFilter", "id name type team { id }"],
      projectStatus: ["projectStatuses", "ProjectStatusFilter", "id name type"],
    } as const;
    const [field, filterType, selection] = specs[kind];
    const filter: RecordValue = {
      ...(uuid(value) ? { id: { eq: value } } : {}),
      ...(teamId && kind === "state" ? { team: { id: { eq: teamId } } } : {}),
      ...(teamId && kind === "label"
        ? { or: [{ team: { null: true } }, { team: { id: { eq: teamId } } }] }
        : {}),
    };
    const candidates = await all(field, filterType, selection, filter);
    const matches = candidates.filter((entry) =>
      [
        entry.id,
        entry.name,
        entry.key,
        entry.identifier,
        entry.slugId,
        entry.email,
        entry.displayName,
        ...(["state", "projectStatus"].includes(kind) ? [entry.type] : []),
      ].some((key) => typeof key === "string" && key.toLowerCase() === value.toLowerCase()),
    );
    if (matches.length !== 1)
      throw new LinearApiTrackerError(matches.length ? "ambiguous_resource" : "not_found");
    return matches[0]!;
  };
  const id = async (kind: Parameters<typeof resolve>[0], value: unknown, teamId?: string) =>
    String((await resolve(kind, value, teamId)).id);
  const nodes = (value: unknown): RecordValue[] => {
    if (!value) return [];
    const items = record(value).nodes;
    if (!Array.isArray(items)) throw new LinearApiTrackerError("invalid_response");
    return items.map(record);
  };
  const projectProjection = (project: RecordValue): RecordValue => ({
    ...project,
    summary: project.description,
    description: project.content,
    status: project.status ? record(project.status).name : undefined,
    statusType: project.status ? record(project.status).type : undefined,
  });
  const projectMembers = async (
    projectId: string,
    field: string,
    selection: string,
  ): Promise<RecordValue[]> => {
    let cursor: string | undefined;
    const seen = new Set<string>();
    const items: RecordValue[] = [];
    for (;;) {
      const data = await graphql(
        `query TrackerProjectMembers($id: String!, $after: String) { project(id: $id) { ${field}(first: 250, after: $after) { nodes { ${selection} } ${PAGE} } } }`,
        { id: projectId, after: cursor ?? null },
      );
      const connection = record(record(data.project)[field]);
      const info = record(connection.pageInfo);
      items.push(...nodes(connection));
      if (items.length > 25000) throw new LinearApiTrackerError("invalid_response");
      if (info.hasNextPage === false) return items;
      if (info.hasNextPage !== true || typeof info.endCursor !== "string" || seen.has(info.endCursor))
        throw new LinearApiTrackerError("invalid_response");
      cursor = info.endCursor;
      seen.add(cursor);
    }
  };
  const expandedProject = async (project: RecordValue, args: RecordValue) => {
    const result = projectProjection(project);
    if (args.includeMilestones)
      result.milestones = await projectMembers(
        String(project.id),
        "projectMilestones",
        "id name description targetDate",
      );
    if (args.includeMembers) result.members = await projectMembers(String(project.id), "members", USER);
    if (args.includeResources)
      result.resources = {
        documents: await projectMembers(String(project.id), "documents", "id title url"),
        links: await projectMembers(String(project.id), "externalLinks", "id label url"),
        attachments: await projectMembers(String(project.id), "attachments", "id title url"),
      };
    return result;
  };
  const issueProjection = (issue: RecordValue): RecordValue => ({
    ...Object.fromEntries(Object.entries(issue).filter(([key]) => key !== "descriptionData")),
    teamId: record(issue.team).id,
    projectId: issue.project ? record(issue.project).id : null,
    status: issue.state ? record(issue.state).name : undefined,
    statusType: issue.state ? record(issue.state).type : undefined,
    milestone: issue.projectMilestone ?? null,
    parentId: issue.parent ? record(issue.parent).id : null,
    labels: nodes(issue.labels).map((label) => label.name),
  });
  const mutation = async (
    entity: string,
    selection: string,
    input: RecordValue,
    publication: TrackerToolCallOptions,
    existingId?: string,
  ) => {
    const op = existingId ? "Update" : "Create";
    const field = `${entity}${op}`;
    const type = `${entity[0]!.toUpperCase()}${entity.slice(1)}${op}Input`;
    const data = await graphql(
      `mutation TrackerWrite($input: ${type}!${existingId ? ", $id: String!" : ""}) { ${field}(${existingId ? "id: $id, " : ""}input: $input) { success ${entity} { ${selection} } } }`,
      { input, ...(existingId ? { id: existingId } : {}) },
      publication,
    );
    return record(record(data[field])[entity]);
  };
  const unsupported = (args: RecordValue, fields: string[]) => {
    const unsupportedField = fields.find((field) => args[field] !== undefined && args[field] !== false);
    if (unsupportedField)
      throw new LinearApiTrackerError(
        "unsupported_operation",
        `Linear API does not support ${unsupportedField} through this tracker`,
      );
  };
  const locks = new Map<string, Promise<unknown>>();
  const serialized = <T>(key: string, operation: () => Promise<T>) => {
    const next = (locks.get(key) ?? Promise.resolve()).then(operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, settled);
    void settled.finally(() => {
      if (locks.get(key) === settled) locks.delete(key);
    });
    return next;
  };

  const call = async (
    name: string,
    args: RecordValue,
    publication: TrackerToolCallOptions = {},
  ): Promise<unknown> => {
    validateTrackerToolArgs(name, args);
    if (name === "get_issue") {
      unsupported(args, ["includeCustomerNeeds", "includeReleases"]);
      const issue = await one(
        "issue",
        String(args.id),
        `${ISSUE}${args.includeRelations ? ` children { nodes { id identifier title } } relations { nodes { ${RELATION} } } inverseRelations { nodes { ${RELATION} } }` : ""}`,
      );
      return issueProjection(issue);
    }
    if (name === "list_issues" || name === "search_issues") {
      const filter: RecordValue = {};
      for (const [field, kind] of [
        ["team", "team"],
        ["project", "project"],
        ["assignee", "user"],
        ["creator", "user"],
        ["state", "state"],
      ] as const)
        if (args[field] !== undefined)
          filter[field] =
            args[field] === null
              ? { null: true }
              : field === "state" &&
                  ["triage", "backlog", "unstarted", "started", "completed", "canceled"].includes(
                    String(args[field]),
                  )
                ? { type: { eq: args[field] } }
                : {
                    id: {
                      eq: await id(
                        kind,
                        args[field],
                        field === "state" && args.team ? await id("team", args.team) : undefined,
                      ),
                    },
                  };
      if (args.label !== undefined) filter.labels = { some: { id: { eq: await id("label", args.label) } } };
      if (args.priority !== undefined) filter.priority = { eq: args.priority };
      if (args.parentId !== undefined)
        filter.parent = { id: { eq: String((await one("issue", String(args.parentId), "id")).id) } };
      for (const field of ["createdAt", "updatedAt"] as const)
        if (args[field]) filter[field] = { gte: args[field] };
      const result = await page(args.query ? "searchIssues" : "issues", "IssueFilter", ISSUE, args, filter);
      return {
        issues: result.nodes.map(issueProjection),
        hasNextPage: result.hasNextPage,
        cursor: result.cursor,
      };
    }
    if (name === "get_user" || name === "get_team" || name === "get_project") {
      if (name === "get_project")
        unsupported(args, ["includeCustomerNeeds", "customerNeedsLimit", "customerNeedsCursor"]);
      const value = await resolve(
        name === "get_user" ? "user" : name === "get_team" ? "team" : "project",
        args.query,
      );
      return name === "get_project" ? expandedProject(value, args) : value;
    }
    if (name === "list_initiatives") {
      const result = await page(
        "initiatives",
        "InitiativeFilter",
        "id name status targetDate",
        args,
        args.query ? { name: { containsIgnoreCase: args.query } } : {},
      );
      for (const initiative of result.nodes) {
        if (!args.includeProjects) continue;
        const projects: RecordValue[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (;;) {
          const data = await graphql(
            `query TrackerGoalProjects($id: String!, $after: String) { initiative(id: $id) { projects(first: 250, after: $after) { nodes { id name progress status { name } } ${PAGE} } } }`,
            { id: initiative.id, after: cursor ?? null },
          );
          const connection = record(record(data.initiative).projects);
          const info = record(connection.pageInfo);
          projects.push(...nodes(connection));
          if (projects.length > 25_000) throw new LinearApiTrackerError("invalid_response");
          if (info.hasNextPage === false) break;
          if (info.hasNextPage !== true || typeof info.endCursor !== "string" || seen.has(info.endCursor))
            throw new LinearApiTrackerError("invalid_response");
          cursor = info.endCursor;
          seen.add(cursor);
        }
        initiative.projects = projects;
      }
      return { initiatives: result.nodes, hasNextPage: result.hasNextPage, cursor: result.cursor };
    }
    const lists = {
      list_users: ["users", "UserFilter", USER, "users"],
      list_teams: ["teams", "TeamFilter", TEAM, "teams"],
      list_projects: ["projects", "ProjectFilter", PROJECT, "projects"],
      list_issue_labels: ["issueLabels", "IssueLabelFilter", LABEL, "labels"],
      list_project_statuses: ["projectStatuses", "ProjectStatusFilter", "id name type", "statuses"],
      list_milestones: [
        "projectMilestones",
        "ProjectMilestoneFilter",
        "id name description targetDate project { id }",
        "milestones",
      ],
    } as const;
    if (name in lists) {
      const [field, filterType, selection, key] = lists[name as keyof typeof lists];
      const filter: RecordValue = {};
      if (args.query ?? args.name) {
        if (field === "projects" && uuid(args.query)) filter.id = { eq: args.query };
        else filter.name = { containsIgnoreCase: args.query ?? args.name };
      }
      if (args.team && field !== "projectStatuses")
        filter[field === "projects" ? "accessibleTeams" : "team"] =
          field === "projects"
            ? { some: { id: { eq: await id("team", args.team) } } }
            : { id: { eq: await id("team", args.team) } };
      if (args.project) filter.project = { id: { eq: await id("project", args.project) } };
      if (args.member) filter.members = { some: { id: { eq: await id("user", args.member) } } };
      if (args.label) filter.labels = { some: { name: { eqIgnoreCase: args.label } } };
      if (args.state) filter.status = { id: { eq: await id("projectStatus", args.state) } };
      for (const date of ["createdAt", "updatedAt"]) if (args[date]) filter[date] = { gte: args[date] };
      if (args.team && field === "projectStatuses") await id("team", args.team);
      if (field === "issueLabels" && args.includeGroups === false) filter.isGroup = { eq: false };
      if (field === "projects") {
        const credential = await options.credentials.get(LINEAR_API_PROVIDER_ID);
        const binding = credential?.type === "oauth" ? credential.account?.connectionId : undefined;
        const sorted = await callPrioritySortedLinearIssues(
          args,
          async (providerArgs) => {
            const result = await page(field, filterType, selection, providerArgs, filter);
            return {
              content: JSON.stringify({
                issues: result.nodes,
                hasNextPage: result.hasNextPage,
                cursor: result.cursor,
              }),
              isError: false,
            };
          },
          `linear-api-projects:${binding ?? "disconnected"}`,
        );
        const result = record(JSON.parse(sorted.content));
        return {
          projects: await Promise.all(
            (result.issues as RecordValue[]).map((project) => expandedProject(project, args)),
          ),
          hasNextPage: result.hasNextPage,
          cursor: result.cursor,
        };
      }
      const result = await page(field, filterType, selection, args, filter);
      return {
        [key]: result.nodes,
        hasNextPage: result.hasNextPage,
        cursor: result.cursor,
      };
    }
    if (name === "list_issue_statuses") {
      const statuses = await all("workflowStates", "WorkflowStateFilter", "id name type", {
        team: { id: { eq: await id("team", args.team) } },
      });
      return { statuses };
    }
    if (name === "list_comments") {
      const targets = ["issueId", "projectId", "statusUpdateId"].filter((field) => args[field] !== undefined);
      if (targets.length !== 1)
        throw new LinearApiTrackerError("unsupported_operation", "Select exactly one comment target");
      const field = targets[0]!;
      const native = field === "issueId" ? "issue" : field === "projectId" ? "project" : "projectUpdate";
      const target =
        field === "issueId"
          ? await one("issue", String(args[field]), "id")
          : field === "projectId"
            ? await resolve("project", args[field])
            : { id: args[field] };
      const result = await page("comments", "CommentFilter", COMMENT, args, {
        [native]: { id: { eq: target.id } },
      });
      return {
        comments: result.nodes.map((comment) => ({
          ...comment,
          parentId: comment.parent ? record(comment.parent).id : null,
        })),
        hasNextPage: result.hasNextPage,
        cursor: result.cursor,
      };
    }
    if (name === "save_comment" || name === "create_comment") {
      const input: RecordValue = { body: args.body };
      if (args.id === undefined) {
        const targets = ["issueId", "projectId", "statusUpdateId"].filter(
          (field) => args[field] !== undefined,
        );
        if (targets.length !== 1 && args.parentId === undefined)
          throw new LinearApiTrackerError("unsupported_operation", "Select exactly one comment target");
        if (targets.length > 1)
          throw new LinearApiTrackerError("unsupported_operation", "Select exactly one comment target");
        if (args.issueId) input.issueId = (await one("issue", String(args.issueId), "id")).id;
        if (args.projectId) input.projectId = await id("project", args.projectId);
        if (args.statusUpdateId) input.projectUpdateId = args.statusUpdateId;
        if (args.parentId) {
          const parent = await one("comment", String(args.parentId), COMMENT);
          input.parentId = parent.id;
          for (const [key, field] of [
            ["issue", "issueId"],
            ["project", "projectId"],
            ["projectUpdate", "projectUpdateId"],
          ] as const)
            if (input[field] !== undefined && (!parent[key] || record(parent[key]).id !== input[field]))
              throw new LinearApiTrackerError(
                "unsupported_operation",
                "Reply target differs from its parent",
              );
          if (!targets.length)
            for (const [key, field] of [
              ["issue", "issueId"],
              ["project", "projectId"],
              ["projectUpdate", "projectUpdateId"],
            ] as const)
              if (parent[key]) input[field] = record(parent[key]).id;
        }
      }
      return mutation("comment", COMMENT, input, publication, args.id as string | undefined);
    }
    if (name === "save_issue_label" || name === "create_issue_label") {
      if (args.id && args.teamId !== undefined)
        throw new LinearApiTrackerError(
          "unsupported_operation",
          "Linear label updates cannot move a label between teams",
        );
      const input = Object.fromEntries(
        Object.entries(args).filter(([key]) => key !== "id" && key !== "parent"),
      );
      if (args.teamId) input.teamId = await id("team", args.teamId);
      if (args.parent) input.parentId = await id("label", args.parent);
      return mutation("issueLabel", LABEL, input, publication, args.id as string | undefined);
    }
    if (name === "get_status_updates") {
      if (args.id) return one("projectUpdate", String(args.id), UPDATE);
      const filter: RecordValue = {};
      if (args.project) filter.project = { id: { eq: await id("project", args.project) } };
      if (args.user) filter.user = { id: { eq: await id("user", args.user) } };
      for (const date of ["createdAt", "updatedAt"]) if (args[date]) filter[date] = { gte: args[date] };
      const result = await page("projectUpdates", "ProjectUpdateFilter", UPDATE, args, filter);
      return { statusUpdates: result.nodes, hasNextPage: result.hasNextPage, cursor: result.cursor };
    }
    if (name === "save_status_update") {
      if (args.id && (args.isDiffHidden !== undefined || args.project !== undefined))
        throw new LinearApiTrackerError(
          "unsupported_operation",
          "Linear cannot change the project or diff visibility of an existing status update",
        );
      if (!args.id && (!args.project || args.body === undefined))
        throw new LinearApiTrackerError(
          "unsupported_operation",
          "Creating a status update requires project and body",
        );
      const input = Object.fromEntries(
        Object.entries(args).filter(([key]) => !["id", "type", "project"].includes(key)),
      );
      if (args.project) input.projectId = await id("project", args.project);
      return mutation("projectUpdate", UPDATE, input, publication, args.id as string | undefined);
    }
    if (name === "save_issue" || name === "save_project")
      return serialized(`${name}:${String(args.id ?? "create")}`, async () => {
        const isIssue = name === "save_issue";
        const before = args.id
          ? await one(isIssue ? "issue" : "project", String(args.id), isIssue ? ISSUE : PROJECT)
          : undefined;
        const teamId = args.team
          ? await id("team", args.team)
          : before?.team
            ? String(record(before.team).id)
            : undefined;
        if (isIssue && !before && (!teamId || !args.title))
          throw new LinearApiTrackerError(
            "unsupported_operation",
            "Creating an issue requires team and title",
          );
        const input: RecordValue = {};
        for (const field of isIssue
          ? ["title", "priority", "dueDate", "estimate"]
          : ["name", "priority", "startDate", "targetDate"])
          if (args[field] !== undefined) input[field] = args[field];
        if (isIssue && teamId) input.teamId = teamId;
        if (args.description !== undefined && args.patch !== undefined)
          throw new LinearApiTrackerError(
            "unsupported_operation",
            "Description and patch cannot be combined",
          );
        if (args.patch !== undefined && !before)
          throw new LinearApiTrackerError(
            "unsupported_operation",
            "Description patches require an existing resource",
          );
        if (args.description !== undefined) input[isIssue ? "description" : "content"] = args.description;
        if (args.patch !== undefined) {
          const original = String(before![isIssue ? "description" : "content"] ?? "");
          if (/uploads\.linear\.app/u.test(original))
            throw new LinearApiTrackerError(
              "unsupported_operation",
              "Linear API cannot safely patch a description containing uploaded media; use a comment to attach evidence",
            );
          input[isIssue ? "description" : "content"] = applyTrackerDescriptionPatch(original, args.patch);
        }
        if (isIssue) {
          if (args.project !== undefined)
            input.projectId = args.project === null ? null : await id("project", args.project);
          if (args.assignee !== undefined)
            input.assigneeId = args.assignee === null ? null : await id("user", args.assignee);
          if (args.state !== undefined) input.stateId = await id("state", args.state, teamId);
          if (args.parentId !== undefined)
            input.parentId =
              args.parentId === null ? null : (await one("issue", String(args.parentId), "id")).id;
          for (const [field, native] of [
            ["labels", "labelIds"],
            ["addLabels", "addedLabelIds"],
            ["removeLabels", "removedLabelIds"],
          ] as const)
            if (args[field] !== undefined)
              input[native] = await Promise.all(
                (args[field] as string[]).map((label) => id("label", label, teamId)),
              );
        } else {
          if (args.summary !== undefined) input.description = args.summary;
          if (args.lead !== undefined) input.leadId = args.lead === null ? null : await id("user", args.lead);
          if (args.state !== undefined) input.statusId = await id("projectStatus", args.state);
          if (args.leadTeam !== undefined) input.leadTeamId = await id("team", args.leadTeam);
          if (args.setTeams !== undefined || args.addTeams !== undefined || args.removeTeams !== undefined) {
            let teams =
              args.setTeams === undefined
                ? nodes(before?.teams).map((team) => String(team.id))
                : await Promise.all((args.setTeams as string[]).map((team) => id("team", team)));
            teams = [
              ...new Set([
                ...teams,
                ...(await Promise.all(((args.addTeams ?? []) as string[]).map((team) => id("team", team)))),
              ]),
            ];
            const removed = await Promise.all(
              ((args.removeTeams ?? []) as string[]).map((team) => id("team", team)),
            );
            input.teamIds = teams.filter((team) => !removed.includes(team));
          }
          if (!before && (!input.name || !Array.isArray(input.teamIds) || !input.teamIds.length))
            throw new LinearApiTrackerError(
              "unsupported_operation",
              "Creating a project requires name and teams",
            );
          if (args.labels !== undefined) {
            const labels = await all("projectLabels", "ProjectLabelFilter", "id name");
            input.labelIds = (args.labels as string[]).map((wanted) => {
              const found = labels.filter((label) => [label.id, label.name].includes(wanted));
              if (found.length !== 1) throw new LinearApiTrackerError("not_found", "Unknown project label");
              return found[0]!.id;
            });
          }
        }
        if (before && args.patch !== undefined) {
          const fresh = await one(isIssue ? "issue" : "project", String(before.id), "id updatedAt");
          if (fresh.updatedAt !== before.updatedAt) throw new LinearApiTrackerError("resource_changed");
        }
        const saved = await mutation(
          isIssue ? "issue" : "project",
          isIssue ? ISSUE : PROJECT,
          input,
          publication,
          before ? String(before.id) : undefined,
        );
        if (isIssue) {
          if (args.duplicateOf === null) {
            const duplicates = (await all("issueRelations", "", RELATION)).filter(
              (relation) => relation.type === "duplicate" && record(relation.issue).id === saved.id,
            );
            for (const relation of duplicates)
              await graphql(
                "mutation TrackerRelationDelete($id: String!) { issueRelationDelete(id: $id) { success } }",
                { id: relation.id },
                publication,
              );
          }
          for (const [field, type, inverse, remove] of [
            ["blocks", "blocks", false, false],
            ["blockedBy", "blocks", true, false],
            ["relatedTo", "related", false, false],
            ["removeBlocks", "blocks", false, true],
            ["removeBlockedBy", "blocks", true, true],
            ["removeRelatedTo", "related", false, true],
            ["duplicateOf", "duplicate", false, false],
          ] as const) {
            if (args[field] === undefined || args[field] === null) continue;
            const related =
              typeof args[field] === "string" ? [args[field] as string] : (args[field] as string[]);
            for (const other of related) {
              const target = await one("issue", other, "id");
              const relationInput = {
                issueId: inverse ? target.id : saved.id,
                relatedIssueId: inverse ? saved.id : target.id,
                type,
              };
              if (remove) {
                const existing = (await all("issueRelations", "", RELATION)).filter(
                  (relation) =>
                    relation.type === type &&
                    ((record(relation.issue).id === relationInput.issueId &&
                      record(relation.relatedIssue).id === relationInput.relatedIssueId) ||
                      (type === "related" &&
                        record(relation.issue).id === relationInput.relatedIssueId &&
                        record(relation.relatedIssue).id === relationInput.issueId)),
                );
                for (const relation of existing)
                  await graphql(
                    "mutation TrackerRelationDelete($id: String!) { issueRelationDelete(id: $id) { success } }",
                    { id: relation.id },
                    publication,
                  );
              } else
                await graphql(
                  "mutation TrackerRelationCreate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }",
                  { input: relationInput },
                  publication,
                );
            }
          }
        }
        for (const link of (args.links ?? []) as Array<{ url: string; title: string }>) {
          await graphql(
            isIssue
              ? "mutation TrackerAttachment($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }"
              : "mutation TrackerProjectLink($input: EntityExternalLinkCreateInput!) { entityExternalLinkCreate(input: $input) { success } }",
            {
              input: {
                ...(isIssue
                  ? { issueId: saved.id, title: link.title }
                  : { projectId: saved.id, label: link.title }),
                url: link.url,
              },
            },
            publication,
          );
        }
        return isIssue ? issueProjection(saved) : projectProjection(saved);
      });
    throw new LinearApiTrackerError("unsupported_operation", `Unsupported Linear API tool ${name}`);
  };
  return {
    catalog: () =>
      TRACKER_TOOLS.map((tool) =>
        tool.name === "get_issue"
          ? {
              ...tool,
              description: `${tool.description} This API connection currently refuses customer-needs and releases projections.`,
            }
          : tool.name === "get_project"
            ? {
                ...tool,
                description: `${tool.description} Customer-needs projections are currently unavailable through this API connection.`,
              }
            : tool.name === "list_milestones"
              ? {
                  ...tool,
                  description:
                    "List project milestones through the registered Linear API connection. Follow cursor while hasNextPage is true.",
                }
              : tool.name === "save_issue" || tool.name === "save_project"
                ? {
                    ...tool,
                    description: tool.description
                      .replace(
                        "Description patches use the current stored body atomically.",
                        "Description patches reread the current API body before publication; uploaded-media descriptions require comments for evidence.",
                      )
                      .replace(
                        "patch edits the current description atomically",
                        "patch rereads the current API description before publication",
                      ),
                  }
                : tool,
      ),
    call: (name, args, authority = {}) => invocation.run(authority, () => call(name, args, authority)),
  };
}
