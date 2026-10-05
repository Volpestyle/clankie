import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
  applyTrackerDescriptionPatch,
  TRACKER_TOOLS,
  validateTrackerToolArgs,
  type TrackerToolBackend,
  type TrackerToolCallOptions,
} from "./tracker-tools.ts";

interface Entity {
  id: string;
  createdAt: string;
  updatedAt: string;
}
interface Team {
  id: string;
  name: string;
  key: string;
}
interface User {
  id: string;
  name: string;
  displayName: string;
  isLocal: true;
}
interface Status {
  id: string;
  name: string;
  type: string;
}
interface Label extends Entity {
  name: string;
  description: string;
  color: string;
  teamId: string | null;
  isGroup: boolean;
  parentId: string | null;
}
interface Issue extends Entity {
  identifier: string;
  title: string;
  description: string;
  teamId: string;
  projectId: string | null;
  statusId: string;
  priority: number;
  labels: string[];
  assigneeId: string | null;
  creatorId: string;
  parentId: string | null;
  blocks: string[];
  blockedBy: string[];
  relatedTo: string[];
  duplicateOf: string | null;
  dueDate: string | null;
  estimate: number | null;
  links: Link[];
}
interface Link {
  url: string;
  title: string;
}
interface Project extends Entity {
  identifier: string;
  slug: string;
  name: string;
  summary: string;
  description: string;
  statusId: string;
  priority: number;
  teamIds: string[];
  leadTeamId: string;
  leadId: string | null;
  labels: string[];
  startDate: string | null;
  targetDate: string | null;
  links: Link[];
}
interface Comment extends Entity {
  body: string;
  parentId: string | null;
  issueId: string | null;
  projectId: string | null;
  statusUpdateId: string | null;
  userId: string;
  quotedText: string | null;
}
interface StatusUpdate extends Entity {
  type: "project";
  projectId: string;
  body: string;
  health: string;
  userId: string;
}
interface Store {
  version: 1;
  nextIssue: number;
  nextProject: number;
  team: Team;
  user: User;
  issueStatuses: Status[];
  projectStatuses: Status[];
  labels: Label[];
  issues: Issue[];
  projects: Project[];
  comments: Comment[];
  statusUpdates: StatusUpdate[];
}

export interface LocalTrackerOptions {
  /** Service state or an explicit in-repo location. Never inferred from cwd. */
  readonly directory: string;
  readonly clock?: () => Date;
  /** Names seed the first store only; persisted identities win on subsequent opens. */
  readonly team?: string;
  readonly project?: string;
  /** Existing repo-board labels seed the first store; saves still reject unknown labels. */
  readonly labels?: readonly string[];
  /** Ancillary storage for native GitHub/Markdown backends without copying their issue bodies. */
  readonly issueResolver?: (reference: string) => Promise<{ id: string; identifier: string } | undefined>;
  /** Repo membership is checked under the store lock, including comment edits and replies. */
  readonly assertIssueWrite?: (issue: Readonly<Record<string, unknown>>) => void;
}

const queues = new Map<string, Promise<void>>();
const norm = (value: string) => value.trim().toLowerCase();
const text = (args: Record<string, unknown>, key: string) => args[key] as string | undefined;
const values = (args: Record<string, unknown>, key: string) => (args[key] ?? []) as string[];
const localUrl = (kind: string, id: string) => `clankie-work://local/${kind}/${id}`;
const priorityRank = (value: number) => (value === 0 ? 5 : value);
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const localKey = (team: Team) => (team.key === "LOCAL" ? "LOCAL" : `LOCAL-${team.key}`);

function seed(options: LocalTrackerOptions, now: string): Store {
  const teamName = options.team ?? "Local";
  const team: Team = {
    id: randomUUID(),
    name: teamName,
    key:
      options.team === undefined
        ? "LOCAL"
        : teamName
            .replace(/[^a-z0-9]/giu, "")
            .toUpperCase()
            .slice(0, 16) || "LOCAL",
  };
  const statuses = (entries: readonly (readonly [string, string])[]): Status[] =>
    entries.map(([name, type]) => ({ id: randomUUID(), name, type }));
  const store: Store = {
    version: 1,
    nextIssue: 1,
    nextProject: 1,
    team,
    user: { id: randomUUID(), name: "Local owner", displayName: "Local owner", isLocal: true },
    issueStatuses: statuses([
      ["Backlog", "backlog"],
      ["Todo", "unstarted"],
      ["In Progress", "started"],
      ["In Review", "started"],
      ["Done", "completed"],
      ["Canceled", "canceled"],
      ["Duplicate", "duplicate"],
    ]),
    projectStatuses: statuses([
      ["Backlog", "backlog"],
      ["Planned", "planned"],
      ["In Progress", "started"],
      ["Completed", "completed"],
      ["Canceled", "canceled"],
    ]),
    labels: [...new Set(options.labels ?? [])].map((name) => {
      if (name.trim() === "") throw new Error("A seeded tracker label cannot be blank");
      return {
        id: randomUUID(),
        name,
        description: "",
        color: "#808080",
        teamId: team.id,
        isGroup: false,
        parentId: null,
        createdAt: now,
        updatedAt: now,
      };
    }),
    issues: [],
    projects: [],
    comments: [],
    statusUpdates: [],
  };
  if (options.project !== undefined) store.projects.push(newProject(store, options.project, now));
  return store;
}

function newProject(store: Store, name: string, now: string): Project {
  const number = store.nextProject++;
  return {
    id: randomUUID(),
    identifier: `P-${localKey(store.team)}-${String(number)}`,
    slug: `${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")}-${String(number)}`,
    name,
    summary: "",
    description: "",
    statusId: store.projectStatuses[0]!.id,
    priority: 0,
    teamIds: [store.team.id],
    leadTeamId: store.team.id,
    leadId: null,
    labels: [],
    startDate: null,
    targetDate: null,
    links: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Corruption is a hard error, never an empty store that would replace the owner's work. */
function parseStore(content: string): Store {
  const value: unknown = JSON.parse(content);
  if (value === null || typeof value !== "object") throw new Error("Invalid local tracker store");
  const store = value as Store;
  if (
    store.version !== 1 ||
    !Number.isInteger(store.nextIssue) ||
    store.nextIssue < 1 ||
    !Number.isInteger(store.nextProject) ||
    store.nextProject < 1 ||
    typeof store.team?.id !== "string" ||
    typeof store.team.key !== "string" ||
    typeof store.user?.id !== "string"
  )
    throw new Error("Invalid or unsupported local tracker store");
  for (const key of [
    "issueStatuses",
    "projectStatuses",
    "labels",
    "issues",
    "projects",
    "comments",
    "statusUpdates",
  ] as const) {
    if (
      !Array.isArray(store[key]) ||
      store[key].some((entry) => entry === null || typeof entry !== "object" || typeof entry.id !== "string")
    )
      throw new Error(`Invalid local tracker collection ${key}`);
    if (new Set(store[key].map((entry) => entry.id)).size !== store[key].length)
      throw new Error(`Duplicate IDs in local tracker collection ${key}`);
  }
  if (store.issueStatuses.length === 0 || store.projectStatuses.length === 0)
    throw new Error("Local tracker statuses are missing");
  return store;
}

/** Atomic rename prevents torn reads; fsync preserves completed writes across a process crash. */
async function persist(
  path: string,
  store: Store,
  assertHeld: () => void,
  options?: TrackerToolCallOptions,
): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options?.beforeWrite?.();
    assertHeld();
    options?.onDispatch?.();
    await rename(temp, path);
    options?.effectConfirmed?.();
  } finally {
    await rm(temp, { force: true });
  }
}

/** CLI, service and multiple backend instances serialize through the same filesystem lock. */
async function locked<T>(directory: string, operation: (assertHeld: () => void) => Promise<T>): Promise<T> {
  const previous = queues.get(directory) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const pending = new Promise<void>((resolveQueue) => {
    releaseQueue = resolveQueue;
  });
  const queued = previous.then(() => pending);
  queues.set(directory, queued);
  await previous;
  let release: (() => Promise<void>) | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Same cross-process locking policy as the credential broker, including a
    // heartbeat and a final held-lock check before the atomic publish.
    let compromised: Error | undefined;
    release = await lockfile.lock(join(directory, "tracker.json"), {
      realpath: false,
      stale: 60_000,
      update: 10_000,
      retries: { retries: 12, minTimeout: 25, maxTimeout: 5_000 },
      onCompromised: (error) => {
        compromised = error;
      },
    });
    const assertHeld = () => {
      if (compromised !== undefined) throw compromised;
    };
    const result = await operation(assertHeld);
    assertHeld();
    return result;
  } finally {
    try {
      await release?.();
    } finally {
      releaseQueue();
      if (queues.get(directory) === queued) queues.delete(directory);
    }
  }
}

function findIssue(store: Store, reference: string): Issue {
  const result = store.issues.find(
    (entry) => norm(entry.id) === norm(reference) || norm(entry.identifier) === norm(reference),
  );
  if (result === undefined) throw new Error(`Issue not found: ${reference}`);
  return result;
}
function findProject(store: Store, reference: string): Project {
  const matches = store.projects.filter((entry) =>
    [entry.id, entry.identifier, entry.name, entry.slug].some((value) => norm(value) === norm(reference)),
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length === 0
        ? `Project not found: ${reference}`
        : `Project name is ambiguous: ${reference}; use its UUID`,
    );
  return matches[0]!;
}
function findTeam(store: Store, reference: string): Team {
  if (![store.team.id, store.team.name, store.team.key].some((value) => norm(value) === norm(reference)))
    throw new Error(`Team not found: ${reference}`);
  return store.team;
}
function findUser(store: Store, reference: string): User {
  if (
    ![store.user.id, store.user.name, store.user.displayName, "me"].some(
      (value) => norm(value) === norm(reference),
    )
  )
    throw new Error(`User not found: ${reference}`);
  return store.user;
}
function findStatus(statuses: Status[], reference: string): Status {
  const exact = statuses.find((entry) =>
    [entry.id, entry.name].some((value) => norm(value) === norm(reference)),
  );
  const result = exact ?? statuses.find((entry) => norm(entry.type) === norm(reference));
  if (result === undefined) throw new Error(`Status not found: ${reference}`);
  return result;
}
function labelNames(store: Store, references: string[], teamId: string): string[] {
  return [
    ...new Set(
      references.map((reference) => {
        const label = store.labels.find(
          (entry) =>
            (entry.id === reference || entry.name === reference) &&
            (entry.teamId === null || entry.teamId === teamId),
        );
        if (label === undefined || label.isGroup)
          throw new Error(`Unknown or non-applicable label: ${reference}`);
        return label.name;
      }),
    ),
  ];
}
function issueView(store: Store, issue: Issue, relations = false): Record<string, unknown> {
  const status = store.issueStatuses.find((entry) => entry.id === issue.statusId)!;
  const project =
    issue.projectId === null ? undefined : store.projects.find((entry) => entry.id === issue.projectId);
  const assignee = issue.assigneeId === null ? null : store.user;
  const view: Record<string, unknown> = {
    ...issue,
    uuid: issue.id,
    state: status.name,
    status: status.name,
    statusType: status.type,
    priorityLabel: ["None", "Urgent", "High", "Medium", "Low"][issue.priority],
    team: store.team.name,
    project: project?.name ?? null,
    assignee: assignee?.name ?? null,
    createdBy: store.user.name,
    createdById: issue.creatorId,
    url: localUrl("issue", issue.id),
  };
  if (relations) {
    const summary = (id: string) => {
      const target = findIssue(store, id);
      return {
        id: target.id,
        identifier: target.identifier,
        title: target.title,
        url: localUrl("issue", id),
      };
    };
    view.parent = issue.parentId === null ? null : summary(issue.parentId);
    view.subIssues = store.issues
      .filter((entry) => entry.parentId === issue.id)
      .map((entry) => summary(entry.id));
    view.relations = {
      blocks: issue.blocks.map(summary),
      blockedBy: issue.blockedBy.map(summary),
      relatedTo: issue.relatedTo.map(summary),
      duplicateOf: issue.duplicateOf === null ? null : summary(issue.duplicateOf),
    };
  }
  return view;
}
function updateView(store: Store, update: StatusUpdate): Record<string, unknown> {
  return {
    ...update,
    user: store.user,
    project: findProject(store, update.projectId).name,
    url: localUrl("status-update", update.id),
  };
}
function projectView(store: Store, project: Project): Record<string, unknown> {
  const status = store.projectStatuses.find((entry) => entry.id === project.statusId)!;
  const latest = store.statusUpdates
    .filter((entry) => entry.projectId === project.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  return {
    ...project,
    uuid: project.id,
    status: status.name,
    state: status.name,
    statusType: status.type,
    teams: [store.team],
    leadTeam: store.team,
    lead: project.leadId === null ? null : store.user,
    members: [],
    milestones: [],
    resources: { links: project.links, documents: [], attachments: [] },
    latestStatusUpdate: latest === undefined ? null : updateView(store, latest),
    url: localUrl("project", project.id),
  };
}
function commentView(store: Store, comment: Comment): Record<string, unknown> {
  return {
    ...comment,
    author: store.user,
    user: store.user,
    onBehalfOf: null,
    attachments: [],
    url: localUrl("comment", comment.id),
  };
}

function dateBoundary(reference: string, now: string): string {
  let value = Date.parse(reference);
  const relative = /^-P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u.exec(reference);
  if (relative !== null && relative.slice(1).some((part) => part !== undefined))
    value =
      Date.parse(now) -
      (Number(relative[1] ?? 0) * 86_400 +
        Number(relative[2] ?? 0) * 3_600 +
        Number(relative[3] ?? 0) * 60 +
        Number(relative[4] ?? 0)) *
        1_000;
  if (!Number.isFinite(value)) throw new Error(`Invalid date filter: ${reference}`);
  return new Date(value).toISOString();
}
function matchesDates(entity: Entity, args: Record<string, unknown>, now: string): boolean {
  return ["createdAt", "updatedAt"].every(
    (key) =>
      args[key] === undefined ||
      entity[key as "createdAt" | "updatedAt"] >= dateBoundary(args[key] as string, now),
  );
}
function order<T extends Entity & { priority?: number }>(
  entries: T[],
  args: Record<string, unknown>,
  byPriority = false,
): T[] {
  const key = args.orderBy === "createdAt" ? "createdAt" : "updatedAt";
  return entries.sort(
    (a, b) =>
      (byPriority ? priorityRank(a.priority ?? 0) - priorityRank(b.priority ?? 0) : 0) ||
      b[key].localeCompare(a[key]) ||
      a.id.localeCompare(b.id),
  );
}
function page(
  entries: Record<string, unknown>[],
  args: Record<string, unknown>,
  key: string,
  tool: string,
): Record<string, unknown> {
  const { cursor, limit, ...filters } = args;
  const scope = createHash("sha256")
    .update(
      JSON.stringify({
        tool,
        filters: Object.fromEntries(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))),
      }),
    )
    .digest("hex");
  let start = 0;
  if (typeof cursor === "string") {
    let decoded: { id?: unknown; scope?: unknown };
    try {
      decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as typeof decoded;
    } catch {
      throw new Error("Invalid tracker cursor");
    }
    if (decoded.scope !== scope || typeof decoded.id !== "string")
      throw new Error("Tracker cursor belongs to a different query");
    const index = entries.findIndex((entry) => entry.id === decoded.id);
    if (index < 0) throw new Error("Tracker cursor no longer exists in this query; restart pagination");
    start = index + 1;
  }
  const selected = entries.slice(start, start + (typeof limit === "number" ? limit : 50));
  const hasNextPage = start + selected.length < entries.length;
  const last = selected.at(-1);
  return {
    [key]: selected,
    hasNextPage,
    ...(hasNextPage && last !== undefined
      ? { cursor: Buffer.from(JSON.stringify({ id: last.id, scope })).toString("base64url") }
      : {}),
  };
}
function projectFields(
  view: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const fields = values(args, "fields");
  if (fields.length === 0) return view;
  return Object.fromEntries(
    ["id", "identifier", ...fields].filter((key) => Object.hasOwn(view, key)).map((key) => [key, view[key]]),
  );
}

function contentChange(existing: string, args: Record<string, unknown>, creating: boolean): string {
  if (args.patch !== undefined) {
    if (creating || args.description !== undefined)
      throw new Error("patch requires an existing entity and cannot be combined with description");
    return applyTrackerDescriptionPatch(existing, args.patch);
  }
  return text(args, "description") ?? existing;
}

function saveIssue(store: Store, args: Record<string, unknown>, now: string): Record<string, unknown> {
  const creating = args.id === undefined;
  if (creating && (text(args, "title")?.trim() === undefined || args.team === undefined))
    throw new Error("Creating an issue requires title and team");
  if (creating && args.removeLabels !== undefined) throw new Error("removeLabels is only valid on update");
  if (args.labels !== undefined && (args.addLabels !== undefined || args.removeLabels !== undefined))
    throw new Error("labels cannot be combined with addLabels/removeLabels");
  if (
    args.team !== undefined &&
    (args.addLabels !== undefined || args.removeLabels !== undefined) &&
    !creating
  )
    throw new Error("Label deltas cannot be combined with a team change");
  if (args.team !== undefined) findTeam(store, args.team as string);
  const existing = creating ? undefined : findIssue(store, args.id as string);
  const issue: Issue = existing ?? {
    id: randomUUID(),
    identifier: `${localKey(store.team)}-${String(store.nextIssue)}`,
    title: text(args, "title")!,
    description: "",
    teamId: store.team.id,
    projectId: null,
    statusId: findStatus(store.issueStatuses, "Todo").id,
    priority: 0,
    labels: [],
    assigneeId: null,
    creatorId: store.user.id,
    parentId: null,
    blocks: [],
    blockedBy: [],
    relatedTo: [],
    duplicateOf: null,
    dueDate: null,
    estimate: null,
    links: [],
    createdAt: now,
    updatedAt: now,
  };
  issue.description = contentChange(issue.description, args, creating);
  if (args.title !== undefined) {
    if ((args.title as string).trim() === "") throw new Error("Issue title cannot be blank");
    issue.title = args.title as string;
  }
  if (args.priority !== undefined) issue.priority = args.priority as number;
  if (args.project !== undefined)
    issue.projectId = args.project === null ? null : findProject(store, args.project as string).id;
  if (args.assignee !== undefined)
    issue.assigneeId = args.assignee === null ? null : findUser(store, args.assignee as string).id;
  if (args.labels !== undefined) issue.labels = labelNames(store, values(args, "labels"), issue.teamId);
  else {
    const add = labelNames(store, values(args, "addLabels"), issue.teamId);
    const remove = labelNames(store, values(args, "removeLabels"), issue.teamId);
    issue.labels = [...new Set([...issue.labels, ...add])].filter((name) => !remove.includes(name));
  }
  if (args.parentId !== undefined) {
    const parent = args.parentId === null ? null : findIssue(store, args.parentId as string);
    let ancestor = parent;
    const visited = new Set<string>();
    while (ancestor !== null) {
      if (ancestor.id === issue.id || visited.has(ancestor.id))
        throw new Error("Issue parent would create a cycle");
      visited.add(ancestor.id);
      ancestor = ancestor.parentId === null ? null : findIssue(store, ancestor.parentId);
    }
    issue.parentId = parent?.id ?? null;
  }
  if (args.state !== undefined) {
    const status = findStatus(store.issueStatuses, args.state as string);
    if (status.type === "duplicate" && issue.duplicateOf === null)
      throw new Error("Issues can only be moved to a duplicate state when a duplicate issue relation exists");
    issue.statusId = status.id;
  }
  if (args.duplicateOf !== undefined) {
    const duplicate = args.duplicateOf === null ? null : findIssue(store, args.duplicateOf as string);
    if (duplicate?.id === issue.id) throw new Error("An issue cannot be a duplicate of itself");
    issue.duplicateOf = duplicate?.id ?? null;
    if (duplicate === null && findStatus(store.issueStatuses, issue.statusId).type === "duplicate")
      throw new Error("A duplicate issue must retain its duplicate relation");
  }
  if (args.dueDate !== undefined) issue.dueDate = args.dueDate as string | null;
  if (args.estimate !== undefined) issue.estimate = args.estimate as number | null;
  for (const link of (args.links ?? []) as Link[]) {
    try {
      new URL(link.url);
    } catch {
      throw new Error(`Invalid link URL: ${link.url}`);
    }
    if (!issue.links.some((existingLink) => existingLink.url === link.url)) issue.links.push(link);
  }
  if (creating) {
    store.nextIssue++;
    store.issues.push(issue);
  }
  // Relations are reciprocal; all validation and edits commit in one store replacement.
  for (const [key, inverse, removeKey] of [
    ["blocks", "blockedBy", "removeBlocks"],
    ["blockedBy", "blocks", "removeBlockedBy"],
    ["relatedTo", "relatedTo", "removeRelatedTo"],
  ] as const) {
    for (const reference of values(args, key)) {
      const target = findIssue(store, reference);
      if (target.id === issue.id) throw new Error("An issue cannot relate to itself");
      if (!issue[key].includes(target.id)) issue[key].push(target.id);
      if (!target[inverse].includes(issue.id)) target[inverse].push(issue.id);
      target.updatedAt = now;
    }
    for (const reference of values(args, removeKey)) {
      const target = findIssue(store, reference);
      issue[key] = issue[key].filter((id) => id !== target.id);
      target[inverse] = target[inverse].filter((id) => id !== issue.id);
      target.updatedAt = now;
    }
  }
  issue.updatedAt = now;
  return issueView(store, issue, true);
}

function saveProject(store: Store, args: Record<string, unknown>, now: string): Record<string, unknown> {
  const creating = args.id === undefined;
  if (args.setTeams !== undefined && (args.addTeams !== undefined || args.removeTeams !== undefined))
    throw new Error("setTeams cannot be combined with addTeams/removeTeams");
  if (
    creating &&
    (args.name === undefined ||
      (values(args, "setTeams").length === 0 && values(args, "addTeams").length === 0))
  )
    throw new Error("Creating a project requires name and addTeams or setTeams");
  const project = creating
    ? newProject(store, args.name as string, now)
    : findProject(store, args.id as string);
  if (args.name !== undefined) {
    if ((args.name as string).trim() === "") throw new Error("Project name cannot be blank");
    project.name = args.name as string;
  }
  project.description = contentChange(project.description, args, creating);
  if (args.summary !== undefined) project.summary = args.summary as string;
  if (args.state !== undefined) project.statusId = findStatus(store.projectStatuses, args.state as string).id;
  if (args.priority !== undefined) project.priority = args.priority as number;
  let teams =
    args.setTeams === undefined
      ? project.teamIds
      : values(args, "setTeams").map((reference) => findTeam(store, reference).id);
  teams = [
    ...new Set([...teams, ...values(args, "addTeams").map((reference) => findTeam(store, reference).id)]),
  ];
  const removed = values(args, "removeTeams").map((reference) => findTeam(store, reference).id);
  teams = teams.filter((id) => !removed.includes(id));
  if (args.leadTeam !== undefined) {
    project.leadTeamId = findTeam(store, args.leadTeam as string).id;
    if (!teams.includes(project.leadTeamId)) teams.push(project.leadTeamId);
  }
  if (teams.length === 0) throw new Error("A project requires at least one team");
  project.teamIds = teams;
  if (args.labels !== undefined)
    project.labels = labelNames(store, values(args, "labels"), project.leadTeamId);
  if (args.lead !== undefined)
    project.leadId = args.lead === null ? null : findUser(store, args.lead as string).id;
  if (args.startDate !== undefined) project.startDate = args.startDate as string;
  if (args.targetDate !== undefined) project.targetDate = args.targetDate as string;
  for (const link of (args.links ?? []) as Link[]) {
    try {
      new URL(link.url);
    } catch {
      throw new Error(`Invalid link URL: ${link.url}`);
    }
    if (!project.links.some((existing) => existing.url === link.url)) project.links.push(link);
  }
  project.updatedAt = now;
  if (creating) store.projects.push(project);
  return projectView(store, project);
}

function saveLabel(store: Store, args: Record<string, unknown>, now: string): Label {
  const existing =
    args.id === undefined
      ? undefined
      : store.labels.find((entry) => entry.id === args.id || entry.name === args.id);
  if (args.id !== undefined && existing === undefined) throw new Error(`Label not found: ${String(args.id)}`);
  if (existing === undefined && args.name === undefined) throw new Error("Creating a label requires name");
  const name = (text(args, "name") ?? existing!.name).trim();
  if (name === "") throw new Error("Label name cannot be blank");
  const teamId =
    args.teamId === undefined ? (existing?.teamId ?? null) : findTeam(store, args.teamId as string).id;
  if (
    store.labels.some((entry) => entry.id !== existing?.id && entry.name === name && entry.teamId === teamId)
  )
    throw new Error(`Label already exists: ${name}`);
  const parent =
    args.parent === undefined
      ? undefined
      : store.labels.find((entry) => entry.id === args.parent || entry.name === args.parent);
  if (args.parent !== undefined && (parent === undefined || !parent.isGroup || parent.id === existing?.id))
    throw new Error("A label parent must be a different existing label group");
  const label: Label = existing ?? {
    id: randomUUID(),
    name,
    description: "",
    color: "#808080",
    teamId,
    parentId: null,
    isGroup: false,
    createdAt: now,
    updatedAt: now,
  };
  if (existing !== undefined && existing.name !== name) {
    for (const entry of [...store.issues, ...store.projects])
      entry.labels = entry.labels.map((value) => (value === existing.name ? name : value));
  }
  label.name = name;
  label.teamId = teamId;
  if (args.description !== undefined) label.description = args.description as string;
  if (args.color !== undefined) label.color = args.color as string;
  if (args.isGroup !== undefined) label.isGroup = args.isGroup as boolean;
  if (parent !== undefined) label.parentId = parent.id;
  label.updatedAt = now;
  if (existing === undefined) store.labels.push(label);
  return label;
}

async function commentTarget(
  store: Store,
  args: Record<string, unknown>,
  options: LocalTrackerOptions,
): Promise<Pick<Comment, "issueId" | "projectId" | "statusUpdateId">> {
  const provided = ["issueId", "projectId", "statusUpdateId"].filter((key) => args[key] !== undefined);
  if (provided.length !== 1) throw new Error("Provide exactly one issueId, projectId or statusUpdateId");
  if (args.statusUpdateType !== undefined && args.statusUpdateId === undefined)
    throw new Error("statusUpdateType requires statusUpdateId");
  const target = { issueId: null, projectId: null, statusUpdateId: null } as Pick<
    Comment,
    "issueId" | "projectId" | "statusUpdateId"
  >;
  if (args.issueId !== undefined) {
    const reference = args.issueId as string;
    const local = store.issues.find(
      (entry) => norm(entry.id) === norm(reference) || norm(entry.identifier) === norm(reference),
    );
    const external = local === undefined ? await options.issueResolver?.(reference) : undefined;
    if (local === undefined && external === undefined) throw new Error(`Issue not found: ${reference}`);
    target.issueId = local?.id ?? external!.id;
  }
  if (args.projectId !== undefined) target.projectId = findProject(store, args.projectId as string).id;
  if (args.statusUpdateId !== undefined) {
    const update = store.statusUpdates.find((entry) => entry.id === args.statusUpdateId);
    if (update === undefined) throw new Error(`Status update not found: ${String(args.statusUpdateId)}`);
    target.statusUpdateId = update.id;
  }
  return target;
}

async function dispatch(
  store: Store,
  name: string,
  args: Record<string, unknown>,
  options: LocalTrackerOptions,
  now: string,
): Promise<unknown> {
  switch (name) {
    case "get_issue":
      return issueView(store, findIssue(store, args.id as string), args.includeRelations === true);
    case "save_issue": {
      if (typeof args.id === "string")
        options.assertIssueWrite?.(issueView(store, findIssue(store, args.id)));
      const saved = saveIssue(store, args, now);
      options.assertIssueWrite?.(saved);
      return saved;
    }
    case "list_issues":
    case "search_issues": {
      if (args.team !== undefined) findTeam(store, args.team as string);
      const project = args.project === undefined ? undefined : findProject(store, args.project as string).id;
      const parent = args.parentId === undefined ? undefined : findIssue(store, args.parentId as string).id;
      const assignee =
        args.assignee === undefined
          ? undefined
          : args.assignee === null || args.assignee === "null"
            ? null
            : findUser(store, args.assignee as string).id;
      const creator = args.creator === undefined ? undefined : findUser(store, args.creator as string).id;
      const label =
        args.label === undefined ? undefined : labelNames(store, [args.label as string], store.team.id)[0];
      const state = args.state === undefined ? undefined : norm(args.state as string);
      const query = norm(text(args, "query") ?? "");
      const result = store.issues.filter((entry) => {
        const status = findStatus(store.issueStatuses, entry.statusId);
        const stateMatches =
          state === undefined ||
          [status.id, status.name, status.type].some((value) => norm(value) === state) ||
          (state === "open" && !["completed", "canceled", "duplicate"].includes(status.type));
        return (
          stateMatches &&
          (project === undefined || entry.projectId === project) &&
          (parent === undefined || entry.parentId === parent) &&
          (assignee === undefined || entry.assigneeId === assignee) &&
          (creator === undefined || entry.creatorId === creator) &&
          (label === undefined || entry.labels.includes(label)) &&
          (args.priority === undefined || entry.priority === args.priority) &&
          matchesDates(entry, args, now) &&
          `${entry.identifier}\n${entry.title}\n${entry.description}`.toLowerCase().includes(query)
        );
      });
      return page(
        order(result, args, true).map((entry) => projectFields(issueView(store, entry), args)),
        args,
        "issues",
        name,
      );
    }
    case "get_project":
      return projectView(store, findProject(store, args.query as string));
    case "save_project":
      return saveProject(store, args, now);
    case "list_projects": {
      if (args.team !== undefined) findTeam(store, args.team as string);
      if (args.member !== undefined) findUser(store, args.member as string);
      const label =
        args.label === undefined ? undefined : labelNames(store, [args.label as string], store.team.id)[0];
      const query = norm(text(args, "query") ?? "");
      const result = store.projects.filter((entry) => {
        const status = findStatus(store.projectStatuses, entry.statusId);
        return (
          (args.state === undefined ||
            [status.id, status.name, status.type].some(
              (value) => norm(value) === norm(args.state as string),
            )) &&
          (label === undefined || entry.labels.includes(label)) &&
          entry.name.toLowerCase().includes(query) &&
          (args.member === undefined || entry.leadId === store.user.id) &&
          matchesDates(entry, args, now)
        );
      });
      return page(
        order(result, args, true).map((entry) => projectFields(projectView(store, entry), args)),
        args,
        "projects",
        name,
      );
    }
    case "save_comment":
    case "create_comment": {
      if (args.id !== undefined) {
        if (args.statusUpdateType !== undefined)
          throw new Error("statusUpdateType cannot be combined with comment id");
        const comment = store.comments.find((entry) => entry.id === args.id);
        if (comment === undefined) throw new Error(`Comment not found: ${String(args.id)}`);
        if (comment.issueId !== null)
          options.assertIssueWrite?.(issueView(store, findIssue(store, comment.issueId)));
        comment.body = args.body as string;
        comment.updatedAt = now;
        return commentView(store, comment);
      }
      let target: Pick<Comment, "issueId" | "projectId" | "statusUpdateId">;
      let parentId: string | null = null;
      if (args.parentId !== undefined) {
        if (args.statusUpdateType !== undefined)
          throw new Error("statusUpdateType cannot be combined with parentId");
        const parent = store.comments.find((entry) => entry.id === args.parentId);
        if (parent === undefined) throw new Error(`Parent comment not found: ${String(args.parentId)}`);
        target = {
          issueId: parent.issueId,
          projectId: parent.projectId,
          statusUpdateId: parent.statusUpdateId,
        };
        parentId = parent.id;
      } else {
        target = await commentTarget(store, args, options);
        if (target.statusUpdateId !== null)
          parentId =
            store.comments.find(
              (entry) => entry.statusUpdateId === target.statusUpdateId && entry.parentId === null,
            )?.id ?? null;
      }
      if (target.issueId !== null)
        options.assertIssueWrite?.(issueView(store, findIssue(store, target.issueId)));
      const comment: Comment = {
        id: randomUUID(),
        body: args.body as string,
        ...target,
        parentId,
        userId: store.user.id,
        quotedText: null,
        createdAt: now,
        updatedAt: now,
      };
      store.comments.push(comment);
      return commentView(store, comment);
    }
    case "list_comments": {
      const target = await commentTarget(store, args, options);
      const result = store.comments.filter(
        (entry) =>
          entry.issueId === target.issueId &&
          entry.projectId === target.projectId &&
          entry.statusUpdateId === target.statusUpdateId,
      );
      return page(
        order(result, args).map((entry) => commentView(store, entry)),
        args,
        "comments",
        name,
      );
    }
    case "get_status_updates": {
      if (args.id !== undefined) {
        const update = store.statusUpdates.find((entry) => entry.id === args.id);
        if (update === undefined) throw new Error(`Status update not found: ${String(args.id)}`);
        return updateView(store, update);
      }
      const project = args.project === undefined ? undefined : findProject(store, args.project as string).id;
      if (args.user !== undefined) findUser(store, args.user as string);
      return page(
        order(
          store.statusUpdates.filter(
            (entry) =>
              (project === undefined || entry.projectId === project) && matchesDates(entry, args, now),
          ),
          args,
        ).map((entry) => updateView(store, entry)),
        args,
        "statusUpdates",
        name,
      );
    }
    case "save_status_update": {
      const existing =
        args.id === undefined ? undefined : store.statusUpdates.find((entry) => entry.id === args.id);
      if (args.id !== undefined && existing === undefined)
        throw new Error(`Status update not found: ${String(args.id)}`);
      if (existing === undefined && (args.project === undefined || args.body === undefined))
        throw new Error("Creating a status update requires project and body");
      const projectId =
        args.project === undefined ? existing!.projectId : findProject(store, args.project as string).id;
      if (existing !== undefined && existing.projectId !== projectId)
        throw new Error("A status update cannot move to a different project");
      const update: StatusUpdate = existing ?? {
        id: randomUUID(),
        type: "project",
        projectId,
        body: "",
        health: "onTrack",
        userId: store.user.id,
        createdAt: now,
        updatedAt: now,
      };
      if (args.body !== undefined) update.body = args.body as string;
      if (args.health !== undefined) update.health = args.health as string;
      update.updatedAt = now;
      if (existing === undefined) store.statusUpdates.push(update);
      findProject(store, projectId).updatedAt = now;
      return updateView(store, update);
    }
    case "get_user":
      return findUser(store, args.query as string);
    case "list_users":
      return page(
        norm(store.user.name).includes(norm(text(args, "query") ?? "")) ? [{ ...store.user }] : [],
        args,
        "users",
        name,
      );
    case "get_team":
      return findTeam(store, args.query as string);
    case "list_teams":
      return page(
        `${store.team.name} ${store.team.key}`.toLowerCase().includes(norm(text(args, "query") ?? ""))
          ? [{ ...store.team }]
          : [],
        args,
        "teams",
        name,
      );
    case "list_issue_statuses":
      findTeam(store, args.team as string);
      return store.issueStatuses;
    case "list_project_statuses":
      if (args.team !== undefined) findTeam(store, args.team as string);
      return store.projectStatuses;
    case "save_issue_label":
    case "create_issue_label":
      return saveLabel(store, args, now);
    case "list_issue_labels": {
      const teamId = args.team === undefined ? undefined : findTeam(store, args.team as string).id;
      const result = store.labels.filter(
        (entry) =>
          (teamId === undefined || entry.teamId === null || entry.teamId === teamId) &&
          (args.includeGroups === true || !entry.isGroup) &&
          entry.name.toLowerCase().includes(norm(text(args, "name") ?? "")),
      );
      return page(
        order(result, args).map((entry) => ({ ...entry })),
        args,
        "labels",
        name,
      );
    }
    case "list_milestones":
      findProject(store, args.project as string);
      return { milestones: [], hasNextPage: false };
    default:
      throw new Error(`Unsupported tracker tool ${name}`);
  }
}

/** Durable local Linear-shaped tracker, also used as ancillary storage for repo backends. */
export function createLocalTracker(options: LocalTrackerOptions): TrackerToolBackend {
  const directory = resolve(options.directory);
  const path = join(directory, "tracker.json");
  return {
    catalog: () => TRACKER_TOOLS,
    async call(name, args, callOptions) {
      validateTrackerToolArgs(name, args);
      return locked(directory, async (assertHeld) => {
        const now = (options.clock ?? (() => new Date()))().toISOString();
        let store: Store;
        let initialized = false;
        try {
          store = parseStore(await readFile(path, "utf8"));
        } catch (error) {
          if (codeOf(error) !== "ENOENT") throw error;
          store = seed(options, now);
          initialized = true;
        }
        const result = await dispatch(store, name, args, options, now);
        const writing = /^(?:save|create)_/u.test(name);
        if (initialized || writing) await persist(path, store, assertHeld, writing ? callOptions : undefined);
        // Callers cannot mutate objects subsequently reused by another backend call.
        return structuredClone(result);
      });
    },
  };
}
