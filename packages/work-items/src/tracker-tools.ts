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
  /**
   * Who is writing, stamped by the host from an authenticated Clankie identity.
   * Never derived from tool arguments. The built-in tracker records it on every
   * write; other backends ignore it (ADR 0226 amendment, VUH-1916).
   */
  readonly actor?: TrackerActor;
  /** Host-stamped origin recorded on resulting item events (e.g. owner_ask); never a tool argument. */
  readonly via?: string;
}

/** human: the owner; agent-worker: Clankie or a hired worker; app: an enrolled device. */
export type TrackerActorType = "human" | "agent-worker" | "app";
export interface TrackerActorRef {
  readonly type: TrackerActorType;
  readonly id: string;
  readonly name?: string;
}
export interface TrackerActor extends TrackerActorRef {
  /** The model that produced the write, when the host knows it. */
  readonly model?: string;
  /** Outermost principal first (owner, then lead); empty when the actor acts for itself. */
  readonly onBehalfOf: readonly TrackerActorRef[];
}

/** The machine owner and Clankie as they appear in on-behalf-of chains. */
export const TRACKER_OWNER: TrackerActorRef = { type: "human", id: "owner", name: "Owner" };
export const TRACKER_LEAD: TrackerActorRef = { type: "agent-worker", id: "clankie", name: "Clankie" };

/** Built-in tracker only: write receipts, the audit log, preconditions and the item event stream. */
export const BUILT_IN_TRACKER_TOOLS: ReadonlySet<string> = new Set([
  "get_write_receipt",
  "list_audit_events",
  "post_issue_event",
  "list_issue_events",
  "save_issue_status",
  "get_cycle",
  "save_run",
  "list_runs",
  "save_lease",
  "list_ready_issues",
  "list_drift",
]);

/** What a worker reports about an item; the tracker derives the item's state from these. */
export const ISSUE_EVENT_TYPES = ["ack", "plan", "action", "blocked", "ask", "result", "error"] as const;
export type IssueEventType = (typeof ISSUE_EVENT_TYPES)[number];
/** Delivery stages in order. Only a human owner sets owner-verified or moves an item back. */
export const DELIVERY_STAGES = ["reported", "accepted", "landed", "delivered", "owner-verified"] as const;
export type DeliveryStage = (typeof DELIVERY_STAGES)[number];
export const STATUS_CATEGORIES = ["backlog", "unstarted", "started", "completed", "canceled"] as const;

/** One entry in an item's hash-linked event stream (VUH-1917). */
export interface TrackerItemEvent {
  readonly id: string;
  readonly seq: number;
  readonly at: string;
  readonly issueId: string;
  readonly identifier: string;
  /**
   * Worker-reported types, or what the tracker recorded: created, comment, state, priority,
   * stage, verified, reopened, cycle (from/to are cycle ids; via rollover when automatic),
   * run (from/to are run statuses) and lease.
   */
  readonly type:
    | IssueEventType
    | "created"
    | "comment"
    | "state"
    | "priority"
    | "stage"
    | "verified"
    | "reopened"
    | "cycle"
    | "run"
    | "lease";
  readonly actor: TrackerActor;
  /** True when Clankie or his workers wrote it; owner activity (human or the owner's app) is false. */
  readonly selfEcho: boolean;
  readonly body?: string;
  readonly from?: string;
  readonly to?: string;
  readonly commentId?: string;
  /** Host-stamped origin, e.g. owner_ask when an owner answer caused it. */
  readonly via?: string;
  readonly prevHash: string;
  readonly hash: string;
}
const BUILT_IN_ARGUMENTS = ["idempotencyKey", "ifUpdatedAt", "cycleDays"] as const;

/** Other backends fail explicitly instead of silently dropping exactly-once or precondition input. */
export function refuseBuiltInTrackerFeatures(name: string, args: Record<string, unknown>): void {
  if (BUILT_IN_TRACKER_TOOLS.has(name))
    throw new Error(`${name} is available only on Clankie's built-in tracker`);
  const used = BUILT_IN_ARGUMENTS.filter((key) => args[key] !== undefined);
  if (used.length > 0)
    throw new Error(
      `${used.join(" and ")} ${used.length === 1 ? "is" : "are"} supported only by Clankie's built-in tracker`,
    );
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

const idempotencyKey = {
  type: "string",
  minLength: 8,
  maxLength: 128,
  description:
    "Built-in tracker only. A key you choose for this write, unique per intended change. A retry with the same key and arguments returns the original result instead of writing twice; read get_write_receipt with it when a result was lost.",
};
const ifUpdatedAt = {
  type: "string",
  minLength: 1,
  description:
    "Built-in tracker only, updates only. The updatedAt you last read; the write is refused, changing nothing, if the record changed since.",
};
const writeControls = { idempotencyKey, ifUpdatedAt };

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
  cycle: {
    ...string,
    description: "Cycle ID, number, or current/next/previous (with project on the built-in tracker).",
  },
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
    "Read an issue by UUID or identifier. Read immediately before an update; includeRelations reveals parents, children and blocking/related issues; includeReleases lists the releases that shipped it, oldest (the one that delivered it) first.",
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
      cycle: {
        type: ["string", "number", "null"],
        description:
          "Cycle ID, number, or current/next; null removes the issue from its cycle. On the built-in tracker the issue needs a project, and only the owner or the lead sets cycle membership.",
      },
      dueDate: nullableString,
      estimate: { type: ["number", "null"] },
      links,
      ...writeControls,
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
    { id: string, ...commentTargets, parentId: string, body: string, ...writeControls },
    ["body"],
  ),
  tool(
    "create_comment",
    "Create a comment or reply (compatibility alias for save_comment).",
    { ...commentTargets, parentId: string, body: string, idempotencyKey },
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
      cycleDays: {
        type: "integer",
        minimum: 1,
        maximum: 56,
        description:
          "Built-in tracker only. Cycle length in days for this project (default 7). Applies from the next cycle; the current one keeps its end.",
      },
      startDate: string,
      targetDate: string,
      links,
      ...writeControls,
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
      ...writeControls,
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
      ...writeControls,
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
      idempotencyKey,
    },
    ["name"],
  ),
  tool(
    "list_initiatives",
    "List Linear initiatives (goals). includeProjects carries native project progress; the local subset has no goals.",
    { ...pagination, query: string, includeProjects: boolean, includeArchived: boolean, fields: strings },
  ),
  tool(
    "get_write_receipt",
    "Built-in tracker only. Look up a write you sent with idempotencyKey: applied (with its original result), refused (with the reason), or unknown (nothing was applied or refused under that key from you, so sending it again is safe).",
    { idempotencyKey: { ...idempotencyKey, description: "The key the write was sent with." } },
    ["idempotencyKey"],
  ),
  tool(
    "list_audit_events",
    "Built-in tracker only. The append-only audit log, newest first: every applied or refused write with its actor, on-behalf-of chain, model and the records it touched.",
    { limit: pagination.limit, cursor: string, entityId: string },
  ),
  tool(
    "post_issue_event",
    'Built-in tracker only. Report progress on an issue as a typed event; its state is derived from these rather than set by hand. ack accepts the work; blocked, ask and error flag it until the next ack/plan/action/result. stage advances delivery: accepted, landed (merged), delivered (released). Only the owner verifies (owner-verified) or sends an item back; landing raises a "check it works" ask for the owner.',
    {
      issueId: { ...string, minLength: 1 },
      type: { type: "string", enum: [...ISSUE_EVENT_TYPES] },
      body: { ...string, maxLength: 4000 },
      stage: { type: "string", enum: [...DELIVERY_STAGES] },
      idempotencyKey,
    },
    ["issueId", "type"],
  ),
  tool(
    "list_issue_events",
    "Built-in tracker only. The hash-linked event stream, oldest first, for one issue or all. Pass the returned cursor as after to resume; selfEcho marks Clankie's and his workers' own events.",
    {
      issueId: string,
      after: { ...string, description: "Cursor from a previous page; omit to start at the beginning." },
      limit: { type: "integer", minimum: 1, maximum: 250, default: 100 },
    },
  ),
  tool(
    "save_issue_status",
    "Built-in tracker only. Create (name and type) or rename (id) an issue status. type is its category (backlog, unstarted, started, completed, canceled); stage binds it to a delivery stage so derived state uses this name.",
    {
      id: string,
      name: { ...string, minLength: 1, maxLength: 64 },
      type: { type: "string", enum: [...STATUS_CATEGORIES] },
      stage: { type: "string", enum: DELIVERY_STAGES.filter((stage) => stage !== "reported") },
    },
  ),
  tool(
    "list_releases",
    "List releases, newest first. On the built-in tracker these are shipped version tags; each lists the item keys its commits name since the previous version (nobody types them), pipeline is the repository lane, and query also matches an item key such as LOCAL-12 or VUH-1930.",
    {
      ...pagination,
      query: string,
      pipeline: string,
      stage: string,
      stageType: { type: "string", enum: ["planned", "started", "completed", "canceled"] },
      version: string,
      hasReleaseNotes: boolean,
      includeReleaseNotes: boolean,
      createdAt: string,
      updatedAt: string,
      includeArchived: boolean,
    },
  ),
  tool(
    "get_release",
    "Retrieve a release by ID or slug, with its items. On the built-in tracker the id may also be an unambiguous version; built-in items carry their title and delivery stage, and every item lists the commits that name it.",
    { id: { ...string, minLength: 1 }, includeReleaseNotes: boolean },
    ["id"],
  ),
  tool(
    "list_cycles",
    "Retrieve cycles. On the built-in tracker cycles are per project (default one week), unfinished items roll over to the next cycle automatically, and each cycle carries its summary from the event stream: planned, added, rolled in, removed, finished, rolled over and in flight.",
    {
      teamId: string,
      type: { type: "string", enum: ["current", "previous", "next"] },
      project: { ...string, description: "Built-in tracker: the project whose cycles to read." },
    },
  ),
  tool(
    "get_cycle",
    "Built-in tracker only. One cycle by ID, or by number with project, with its summary from the event stream.",
    { id: { ...string, minLength: 1 }, project: string },
    ["id"],
  ),
  tool(
    "save_run",
    "Built-in tracker only. Start a run on an issue (issueId; one attempt of the work, optionally a child of parentRunId) or update yours (id): finish it with status succeeded, failed or canceled, and report tokens and costUsd. Your seat, pane and hire are linked from your identity; give the worktree and branch you work in. A run cannot start on an issue someone else holds the lease on.",
    {
      id: string,
      issueId: string,
      parentRunId: string,
      worktree: { ...string, maxLength: 4096 },
      branch: { ...string, maxLength: 256 },
      status: { type: "string", enum: ["succeeded", "failed", "canceled"] },
      tokens: { type: "integer", minimum: 0 },
      costUsd: { type: "number", minimum: 0 },
      summary: { ...string, maxLength: 4000 },
      idempotencyKey,
    },
  ),
  tool(
    "list_runs",
    "Built-in tracker only. Runs, newest first, for one issue or all: attempt number, parent run, status, worktree and branch, duration, tokens and cost, and the live link to the seat, pane and hire that runs it.",
    {
      issueId: string,
      status: { type: "string", enum: ["active", "succeeded", "failed", "canceled"] },
      limit: pagination.limit,
      cursor: string,
    },
  ),
  tool(
    "save_lease",
    "Built-in tracker only. Take or renew the lease on an issue while you work on it (default 30 minutes), or release it. A lease expires on its own; while it is live nobody else can lease the issue or start a run on it, and the issue leaves the ready queue.",
    {
      issueId: { ...string, minLength: 1 },
      ttlMinutes: { type: "integer", minimum: 1, maximum: 1440 },
      release: boolean,
      idempotencyKey,
    },
    ["issueId"],
  ),
  tool(
    "list_ready_issues",
    "Built-in tracker only. The ready queue: open issues not yet landed, unblocked, with no live lease and no active run. The project's current cycle comes first, then priority (urgent to low, none last), then oldest.",
    { project: string, limit: pagination.limit, cursor: string },
  ),
  tool(
    "list_drift",
    "Built-in tracker only. Work that has drifted: leases that expired without a release, runs still active on closed issues, and open issues with no update in idleDays (default 30).",
    { project: string, idleDays: { type: "integer", minimum: 1, maximum: 365 } },
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
