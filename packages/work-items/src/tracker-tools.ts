/** The tracker speaks the Linear subset already used by Clankie and his workers. */
export interface TrackerToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface TrackerToolBackend {
  catalog(): readonly TrackerToolDescriptor[];
  call(name: string, args: Record<string, unknown>, options?: TrackerToolCallOptions): Promise<unknown>;
}

/** Host authority is checked at the backend's publish boundary, after preparation. */
export interface TrackerToolCallOptions {
  readonly beforeWrite?: () => void | Promise<void>;
  readonly onDispatch?: () => void;
  readonly effectConfirmed?: () => void;
}

const string = { type: "string" };
const boolean = { type: "boolean" };
const nullableString = { type: ["string", "null"] };
const strings = { type: "array", items: string };
const priority = {
  type: "integer",
  minimum: 0,
  maximum: 4,
  description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
};
const pagination = {
  limit: { type: "integer", minimum: 1, maximum: 250, default: 50 },
  cursor: string,
  orderBy: { type: "string", enum: ["createdAt", "updatedAt"] },
};

function object(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const patch = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  description:
    "Ordered, atomic description edits. Anchors must match exactly once unless replace_all is true. Only on update; cannot be combined with description.",
  items: {
    oneOf: [
      object(
        {
          op: { const: "replace" },
          old_string: { ...string, minLength: 1 },
          new_string: string,
          replace_all: boolean,
        },
        ["op", "old_string", "new_string"],
      ),
      ...["insert_before", "insert_after"].map((op) =>
        object(
          { op: { const: op }, anchor: { ...string, minLength: 1 }, text: { ...string, minLength: 1 } },
          ["op", "anchor", "text"],
        ),
      ),
      ...["prepend", "append"].map((op) =>
        object({ op: { const: op }, text: { ...string, minLength: 1 } }, ["op", "text"]),
      ),
      object(
        {
          op: { const: "replace_range" },
          from: { ...string, minLength: 1 },
          to: { ...string, minLength: 1 },
          new_string: string,
        },
        ["op", "from", "to", "new_string"],
      ),
    ],
  },
};

const links = {
  type: "array",
  items: object({ url: string, title: { ...string, minLength: 1 } }, ["url", "title"]),
};
const issueFilters = {
  ...pagination,
  query: string,
  team: string,
  state: string,
  label: string,
  assignee: nullableString,
  creator: string,
  project: string,
  priority,
  parentId: string,
  fields: strings,
  createdAt: string,
  updatedAt: string,
  includeArchived: boolean,
};
const commentTargets = {
  issueId: string,
  projectId: string,
  statusUpdateId: string,
  statusUpdateType: { type: "string", enum: ["project"] },
};

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): TrackerToolDescriptor {
  return { name, description, inputSchema: object(properties, required) };
}

/** Schemas deliberately cover the supported subset; unavailable features fail explicitly. */
export const TRACKER_TOOLS: readonly TrackerToolDescriptor[] = [
  tool(
    "get_issue",
    "Read an issue by UUID or identifier. Read immediately before an update; includeRelations reveals parents, children and blocking/related issues.",
    { id: string, includeRelations: boolean, includeCustomerNeeds: boolean, includeReleases: boolean },
    ["id"],
  ),
  tool(
    "list_issues",
    "List or search issues. Priority sorts Urgent→Low, unprioritized last, before pagination. Follow cursor while hasNextPage is true.",
    issueFilters,
  ),
  tool(
    "search_issues",
    "Search issue titles, identifiers and descriptions with the same filters and priority ordering as list_issues.",
    issueFilters,
    ["query"],
  ),
  tool(
    "save_issue",
    "Create (team and title required) or update (id required) an issue. Omitted fields remain unchanged. Labels replace the full set; addLabels/removeLabels apply deltas. Relations append unless explicitly removed. Description patches use the current stored body atomically.",
    {
      id: string,
      title: { ...string, minLength: 1 },
      description: string,
      patch,
      team: string,
      priority,
      project: nullableString,
      state: string,
      assignee: nullableString,
      labels: strings,
      addLabels: strings,
      removeLabels: strings,
      parentId: nullableString,
      blocks: strings,
      blockedBy: strings,
      relatedTo: strings,
      removeBlocks: strings,
      removeBlockedBy: strings,
      removeRelatedTo: strings,
      duplicateOf: nullableString,
      dueDate: nullableString,
      estimate: { type: ["number", "null"] },
      links,
    },
  ),
  tool(
    "list_comments",
    "List comments and replies on exactly one issue, project or project status update. Follow pagination; replies retain parentId and quotedText.",
    { ...pagination, ...commentTargets },
  ),
  tool(
    "save_comment",
    "Create or edit a comment. On create provide exactly one issueId/projectId/statusUpdateId; a reply uses parentId and inherits its target. On edit provide id. body replaces the current body.",
    { id: string, ...commentTargets, parentId: string, body: string },
    ["body"],
  ),
  tool(
    "create_comment",
    "Create a comment or reply (compatibility alias for save_comment).",
    { ...commentTargets, parentId: string, body: string },
    ["body"],
  ),
  tool(
    "get_project",
    "Read a project by UUID, identifier, name or slug, including its latest status update. Read immediately before edits.",
    {
      query: string,
      includeMilestones: boolean,
      includeMembers: boolean,
      includeResources: boolean,
      includeCustomerNeeds: boolean,
      customerNeedsLimit: { type: "integer", minimum: 1, maximum: 50 },
      customerNeedsCursor: string,
    },
    ["query"],
  ),
  tool("list_projects", "List projects, priority first. Follow cursor until exhausted.", {
    ...pagination,
    limit: { type: "integer", minimum: 1, maximum: 50, default: 50 },
    query: string,
    state: string,
    team: string,
    member: string,
    label: string,
    createdAt: string,
    updatedAt: string,
    includeMilestones: boolean,
    includeMembers: boolean,
    includeArchived: boolean,
    fields: strings,
  }),
  tool(
    "save_project",
    "Create (name and addTeams/setTeams required) or update (id) a project. Omitted fields remain unchanged. patch edits the current description atomically; labels replace the complete set.",
    {
      id: string,
      name: { ...string, minLength: 1 },
      summary: { ...string, maxLength: 255 },
      description: string,
      patch,
      state: string,
      priority,
      addTeams: strings,
      removeTeams: strings,
      setTeams: strings,
      leadTeam: string,
      labels: strings,
      lead: nullableString,
      startDate: string,
      targetDate: string,
      links,
    },
  ),
  tool(
    "get_status_updates",
    "List project status updates or read one by UUID. Read immediately before replacement; follow cursor when listing.",
    {
      ...pagination,
      type: { type: "string", enum: ["project"] },
      id: string,
      project: string,
      user: string,
      createdAt: string,
      updatedAt: string,
      includeArchived: boolean,
    },
    ["type"],
  ),
  tool(
    "save_status_update",
    "Create or update a project status update. type is project; creation needs project and body. body replaces the complete body, so read the latest update first.",
    {
      type: { type: "string", enum: ["project"] },
      id: string,
      project: string,
      body: string,
      health: { type: "string", enum: ["onTrack", "atRisk", "offTrack"] },
      isDiffHidden: boolean,
    },
    ["type"],
  ),
  tool(
    "get_user",
    "Read a tracker user. me identifies the current backend actor; local identity never claims to be an authenticated Linear actor.",
    { query: string },
    ["query"],
  ),
  tool("list_users", "List tracker users.", { ...pagination, query: string }),
  tool("get_team", "Resolve a team by UUID, key or name.", { query: string }, ["query"]),
  tool("list_teams", "List tracker teams.", { ...pagination, query: string }),
  tool(
    "list_issue_statuses",
    "List the team's issue statuses; use their names, types or UUIDs in save_issue.",
    { team: string },
    ["team"],
  ),
  tool("list_project_statuses", "List available project statuses.", { team: string }),
  tool(
    "list_issue_labels",
    "List existing labels. Unknown labels are rejected by saves; create them explicitly first.",
    { ...pagination, name: string, team: string, includeArchived: boolean, includeGroups: boolean },
  ),
  tool(
    "save_issue_label",
    "Create (name) or update (id) a label. Unknown labels are never silently created by issue saves.",
    {
      id: string,
      name: { ...string, minLength: 1 },
      description: string,
      color: string,
      teamId: string,
      parent: string,
      isGroup: boolean,
    },
  ),
  tool(
    "create_issue_label",
    "Create a label (compatibility alias for save_issue_label).",
    {
      name: { ...string, minLength: 1 },
      description: string,
      color: string,
      teamId: string,
      parent: string,
      isGroup: boolean,
    },
    ["name"],
  ),
  tool(
    "list_initiatives",
    "List Linear initiatives (goals). includeProjects carries native project progress; the local subset has no goals.",
    { ...pagination, query: string, includeProjects: boolean, includeArchived: boolean, fields: strings },
  ),
  tool(
    "list_milestones",
    "List project milestones. The local subset currently has no milestones.",
    { ...pagination, project: string },
    ["project"],
  ),
];

/** Runtime validation is shared with adapters; tool transport schemas alone are not a boundary. */
export function validateTrackerToolArgs(name: string, args: Record<string, unknown>): void {
  const descriptor = TRACKER_TOOLS.find((entry) => entry.name === name);
  if (descriptor === undefined) throw new Error(`Unsupported tracker tool ${name}`);
  validate(args, descriptor.inputSchema, name);
}

function validate(value: unknown, schema: Record<string, unknown>, path: string): void {
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validate(value, candidate as Record<string, unknown>, path);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1)
      throw new Error(`${path}: value must match exactly one supported patch operation`);
    return;
  }
  if (schema.const !== undefined && value !== schema.const)
    throw new Error(`${path}: expected ${String(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    throw new Error(`${path}: unsupported value ${String(value)}`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (
    types.length > 0 &&
    !types.some(
      (type) =>
        type === actual || (type === "integer" && typeof value === "number" && Number.isInteger(value)),
    )
  )
    throw new Error(`${path}: expected ${types.join(" or ")}`);
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (typeof schema.minimum === "number" && value < schema.minimum) ||
      (typeof schema.maximum === "number" && value > schema.maximum)
    )
      throw new Error(`${path}: number is outside the supported range`);
  }
  if (
    typeof value === "string" &&
    ((typeof schema.minLength === "number" && value.length < schema.minLength) ||
      (typeof schema.maxLength === "number" && value.length > schema.maxLength))
  )
    throw new Error(`${path}: string length is outside the supported range`);
  if (Array.isArray(value)) {
    if (
      (typeof schema.minItems === "number" && value.length < schema.minItems) ||
      (typeof schema.maxItems === "number" && value.length > schema.maxItems)
    )
      throw new Error(`${path}: invalid array length`);
    if (schema.items !== undefined)
      value.forEach((entry, index) =>
        validate(entry, schema.items as Record<string, unknown>, `${path}[${String(index)}]`),
      );
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const required of (schema.required ?? []) as string[])
      if (record[required] === undefined) throw new Error(`${path}: missing ${required}`);
    for (const [key, entry] of Object.entries(record)) {
      const child = properties[key];
      if (child === undefined && schema.additionalProperties === false)
        throw new Error(`${path}: unsupported parameter ${key}`);
      if (child !== undefined) validate(entry, child, `${path}.${key}`);
    }
  }
}

/** Apply Linear's patch vocabulary to a fresh body. No partial result escapes on failure. */
export function applyTrackerDescriptionPatch(content: string, operations: unknown): string {
  validate(operations, patch, "patch");
  let next = content;
  const uniqueIndex = (anchor: string) => {
    const index = next.indexOf(anchor);
    if (index < 0 || next.indexOf(anchor, index + 1) >= 0)
      throw new Error(`Patch anchor must match current content exactly once: ${anchor}`);
    return index;
  };
  for (const operation of operations as Record<string, unknown>[]) {
    const text = operation.text as string;
    switch (operation.op) {
      case "append":
        next += text;
        break;
      case "prepend":
        next = text + next;
        break;
      case "replace": {
        const old = operation.old_string as string;
        if (operation.replace_all === true) {
          if (!next.includes(old)) throw new Error(`Patch anchor not found: ${old}`);
          next = next.split(old).join(operation.new_string as string);
        } else {
          const index = uniqueIndex(old);
          next = next.slice(0, index) + (operation.new_string as string) + next.slice(index + old.length);
        }
        break;
      }
      case "insert_before":
      case "insert_after": {
        const anchor = operation.anchor as string;
        const index = uniqueIndex(anchor) + (operation.op === "insert_after" ? anchor.length : 0);
        next = next.slice(0, index) + text + next.slice(index);
        break;
      }
      case "replace_range": {
        const from = operation.from as string;
        const start = uniqueIndex(from);
        const to = operation.to as string;
        const end = next.indexOf(to, start + from.length);
        if (end < 0 || next.indexOf(to, end + 1) >= 0)
          throw new Error("Patch range end must match exactly once after its start anchor");
        next = next.slice(0, start) + (operation.new_string as string) + next.slice(end);
        break;
      }
    }
  }
  return next;
}
