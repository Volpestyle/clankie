import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withTrackerStoreLock } from "./tracker-store-lock.ts";
import {
  applyTrackerDescriptionPatch,
  DELIVERY_STAGES,
  TRACKER_TOOLS,
  validateTrackerToolArgs,
  type DeliveryStage,
  type IssueEventType,
  type TrackerActor,
  type TrackerItemEvent,
  type TrackerToolBackend,
  type TrackerToolCallOptions,
} from "./tracker-tools.ts";

interface Entity {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Host-authenticated writers (VUH-1916); absent on records written before actors. */
  createdByActor?: TrackerActor;
  updatedByActor?: TrackerActor;
}

/** One idempotency key's settled outcome, committed in the same replacement as its effect. */
interface WriteReceipt {
  actorKey: string;
  idempotencyKey: string;
  tool: string;
  fingerprint: string;
  state: "applied" | "refused";
  at: string;
  result?: unknown;
  reason?: string;
  detail?: string;
}

/** Append-only: entries are never edited or removed, and each hashes its predecessor. */
interface AuditEvent {
  id: string;
  seq: number;
  at: string;
  tool: string;
  outcome: "applied" | "refused";
  actor: TrackerActor;
  idempotencyKey?: string;
  fields: string[];
  entities: { type: string; id: string; identifier?: string }[];
  target?: string;
  reason?: string;
  detail?: string;
  prevHash: string;
  hash: string;
}

/** A write the tracker declined. Nothing changed; a keyed retry returns the same refusal. */
export class TrackerWriteRefused extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(`Write refused (${reason}): ${detail}`);
    this.name = "TrackerWriteRefused";
    this.reason = reason;
  }
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
  /** The delivery stage whose derived state uses this status name. */
  stage?: DeliveryStage;
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
  /** Derived from the event stream; absent on items written before VUH-1917 (reported). */
  stage?: DeliveryStage;
  blocked?: boolean;
  asking?: boolean;
  errored?: boolean;
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
  /** Absent in stores written before VUH-1916; created on their next write. */
  receipts?: WriteReceipt[];
  audit?: AuditEvent[];
  /** Strictly increasing write time, so updatedAt is a usable precondition. */
  lastWriteAt?: string;
  /** Hash-linked item event stream (VUH-1917); its seq is the resumable cursor. */
  events?: TrackerItemEvent[];
}

/** Who and why for one write, threaded into item events. */
interface WriteContext {
  readonly actor: TrackerActor;
  readonly via?: string;
}

/** Live delivery of newly committed item events, after their write is durable. */
export type TrackerEventListener = (event: TrackerItemEvent) => void;
export interface LocalTrackerBackend extends TrackerToolBackend {
  /** Replays events after the cursor (seq), then pushes new ones. Returns an unsubscribe. */
  subscribe(listener: TrackerEventListener, after?: number): Promise<() => void>;
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
      ["Delivered", "started"],
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
  if (store.events !== undefined) {
    if (!Array.isArray(store.events)) throw new Error("Invalid local tracker event stream");
    let previous = "";
    store.events.forEach((event, index) => {
      if (event?.seq !== index + 1 || event.prevHash !== previous || auditHash(event) !== event.hash)
        throw new Error(`Local tracker event stream is not intact at event ${String(index + 1)}`);
      previous = event.hash;
    });
  }
  bindStageStatuses(store);
  if (store.receipts !== undefined && !Array.isArray(store.receipts))
    throw new Error("Invalid local tracker write receipts");
  if (store.audit !== undefined) {
    if (!Array.isArray(store.audit)) throw new Error("Invalid local tracker audit log");
    // An edited, removed or reordered entry breaks the chain; refuse rather than extend it.
    let previous = "";
    store.audit.forEach((event, index) => {
      if (event?.seq !== index + 1 || event.prevHash !== previous || auditHash(event) !== event.hash)
        throw new Error(`Local tracker audit log is not intact at entry ${String(index + 1)}`);
      previous = event.hash;
    });
  }
  return store;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Chain hash over everything but the hash itself; shared by the audit log and the event stream. */
function auditHash(event: object): string {
  return createHash("sha256")
    .update(canonical({ ...event, hash: undefined }))
    .digest("hex");
}
const actorKey = (actor: TrackerActor) => `${actor.type}:${actor.id}`;
/** Callers without a host (standalone CLI use) write as the store's visibly local owner. */
const localActor = (store: Store): TrackerActor => ({
  type: "human",
  id: store.user.id,
  name: store.user.name,
  onBehalfOf: [],
});

/** Every write gets a distinct, increasing timestamp, even under a fixed or coarse clock. */
function nextWriteTime(store: Store, clock: string): string {
  let last = store.lastWriteAt;
  if (last === undefined)
    for (const entry of [
      ...store.labels,
      ...store.issues,
      ...store.projects,
      ...store.comments,
      ...store.statusUpdates,
    ])
      if (last === undefined || entry.updatedAt > last) last = entry.updatedAt;
  const now = last === undefined || clock > last ? clock : new Date(Date.parse(last) + 1).toISOString();
  store.lastWriteAt = now;
  return now;
}

const ENTITY_TYPES = [
  ["issues", "issue"],
  ["projects", "project"],
  ["comments", "comment"],
  ["statusUpdates", "status_update"],
  ["labels", "label"],
] as const;

/** The write's unique timestamp identifies exactly the records it created or changed. */
function stampActor(store: Store, actor: TrackerActor, now: string): AuditEvent["entities"] {
  const touched: AuditEvent["entities"] = [];
  for (const [collection, type] of ENTITY_TYPES)
    for (const entry of store[collection] as (Entity & { identifier?: string })[]) {
      if (entry.updatedAt !== now) continue;
      if (entry.createdAt === now) entry.createdByActor = actor;
      entry.updatedByActor = actor;
      touched.push({
        type,
        id: entry.id,
        ...(entry.identifier === undefined ? {} : { identifier: entry.identifier }),
      });
    }
  return touched;
}

function appendAudit(store: Store, event: Omit<AuditEvent, "id" | "seq" | "prevHash" | "hash">): void {
  store.audit ??= [];
  const body = {
    id: randomUUID(),
    seq: store.audit.length + 1,
    ...event,
    prevHash: store.audit.at(-1)?.hash ?? "",
  };
  store.audit.push({ ...body, hash: auditHash(body) });
}

function auditTarget(args: Record<string, unknown>): string | undefined {
  for (const key of ["id", "issueId", "parentId", "projectId", "statusUpdateId", "project"])
    if (typeof args[key] === "string") return args[key] as string;
  return undefined;
}

/** Statuses named for stages keep their names; deterministic, so reads need not persist it. */
function bindStageStatuses(store: Store): void {
  if (store.issueStatuses.some((status) => status.stage !== undefined)) return;
  for (const [name, type, stage] of [
    ["In Progress", "started", "accepted"],
    ["In Review", "started", "landed"],
    ["Delivered", "started", "delivered"],
    ["Done", "completed", "owner-verified"],
  ] as const) {
    const status = store.issueStatuses.find((entry) => entry.name === name && entry.type === type);
    if (status !== undefined) status.stage = stage;
  }
}
const stageOf = (issue: Issue): DeliveryStage => issue.stage ?? "reported";
const isOwner = (actor: TrackerActor) => actor.type === "human";
/** Owner activity: the owner directly or through the owner's app. Everything else echoes Clankie. */
const isOwnerActivity = (actor: TrackerActor) => actor.type === "human" || actor.type === "app";

function statusForStage(store: Store, stage: DeliveryStage): Status {
  const bound = store.issueStatuses.find((status) => status.stage === stage);
  if (bound !== undefined) return bound;
  const category = stage === "reported" ? "unstarted" : stage === "owner-verified" ? "completed" : "started";
  return store.issueStatuses.find((status) => status.type === category) ?? store.issueStatuses[0]!;
}

function appendEvent(
  store: Store,
  context: WriteContext,
  now: string,
  issue: Issue,
  event: Pick<TrackerItemEvent, "type"> &
    Partial<Pick<TrackerItemEvent, "body" | "from" | "to" | "commentId">>,
): void {
  store.events ??= [];
  const body = {
    id: randomUUID(),
    seq: store.events.length + 1,
    at: now,
    issueId: issue.id,
    identifier: issue.identifier,
    ...event,
    actor: context.actor,
    selfEcho: !isOwnerActivity(context.actor),
    ...(context.via === undefined ? {} : { via: context.via }),
    prevHash: store.events.at(-1)?.hash ?? "",
  };
  store.events.push({ ...body, hash: auditHash(body) });
}

/** Forward for anyone; owner-verified and any move back belong to the owner alone. */
function moveStage(
  store: Store,
  issue: Issue,
  target: DeliveryStage,
  context: WriteContext,
  now: string,
): void {
  const current = stageOf(issue);
  if (target === current) return;
  const back = DELIVERY_STAGES.indexOf(target) < DELIVERY_STAGES.indexOf(current);
  if ((target === "owner-verified" || back) && !isOwner(context.actor))
    throw new TrackerWriteRefused(
      "owner_verification_required",
      target === "owner-verified"
        ? "only the owner verifies an item; report landed or delivered and the owner checks it"
        : `only the owner moves an item back (from ${current} to ${target})`,
    );
  issue.stage = target;
  issue.statusId = statusForStage(store, target).id;
  appendEvent(store, context, now, issue, {
    type: target === "owner-verified" ? "verified" : back ? "reopened" : "stage",
    from: current,
    to: target,
  });
}

const PROGRESS: readonly IssueEventType[] = ["ack", "plan", "action", "result"];

function postIssueEvent(
  store: Store,
  args: Record<string, unknown>,
  context: WriteContext,
  now: string,
  options: LocalTrackerOptions,
): Record<string, unknown> {
  const issue = findIssue(store, args.issueId as string);
  options.assertIssueWrite?.(issueView(store, issue));
  const type = args.type as IssueEventType;
  const progress = PROGRESS.includes(type);
  issue.blocked = type === "blocked" || (!progress && issue.blocked === true);
  issue.asking = type === "ask" || (!progress && issue.asking === true);
  issue.errored = type === "error" || (!progress && issue.errored === true);
  appendEvent(store, context, now, issue, {
    type,
    ...(typeof args.body === "string" ? { body: args.body } : {}),
  });
  const target =
    (args.stage as DeliveryStage | undefined) ??
    (type === "ack" && stageOf(issue) === "reported" ? "accepted" : undefined);
  if (target !== undefined) moveStage(store, issue, target, context, now);
  issue.updatedAt = now;
  return issueView(store, issue);
}

const categoryOf = (store: Store, statusId: string) =>
  store.issueStatuses.find((status) => status.id === statusId)?.type;

/**
 * Hand-set changes become events too. Completing an item is owner verification,
 * and reopening a completed one sends it back; both are the owner's alone.
 */
function recordIssueChanges(
  before: Store,
  store: Store,
  name: string,
  context: WriteContext,
  now: string,
): void {
  if (name === "post_issue_event") return;
  for (const issue of store.issues) {
    if (issue.updatedAt !== now) continue;
    const previous = before.issues.find((entry) => entry.id === issue.id);
    const was = previous === undefined ? undefined : categoryOf(store, previous.statusId);
    const is = categoryOf(store, issue.statusId);
    if (previous === undefined) {
      if (is === "completed" && !isOwner(context.actor))
        throw new TrackerWriteRefused(
          "owner_verification_required",
          "only the owner creates an item as completed",
        );
      issue.stage = is === "completed" ? "owner-verified" : "reported";
      appendEvent(store, context, now, issue, { type: "created", to: stageOf(issue) });
    } else if (previous.statusId !== issue.statusId) {
      const from = before.issueStatuses.find((status) => status.id === previous.statusId)?.name;
      const to = store.issueStatuses.find((status) => status.id === issue.statusId)!.name;
      if (is === "completed" || was === "completed") {
        if (!isOwner(context.actor))
          throw new TrackerWriteRefused(
            "owner_verification_required",
            is === "completed"
              ? `only the owner completes an item; report it with post_issue_event (stage landed or delivered) and the owner verifies it`
              : "only the owner reopens a completed item",
          );
        issue.stage = is === "completed" ? "owner-verified" : "accepted";
        appendEvent(store, context, now, issue, {
          type: is === "completed" ? "verified" : "reopened",
          ...(from === undefined ? {} : { from }),
          to,
        });
      } else
        appendEvent(store, context, now, issue, {
          type: "state",
          ...(from === undefined ? {} : { from }),
          to,
        });
    }
    if (previous !== undefined && previous.priority !== issue.priority)
      appendEvent(store, context, now, issue, {
        type: "priority",
        from: String(previous.priority),
        to: String(issue.priority),
      });
  }
  for (const comment of store.comments) {
    if (comment.createdAt !== now || comment.issueId === null) continue;
    const issue = store.issues.find((entry) => entry.id === comment.issueId);
    if (issue === undefined) continue;
    appendEvent(store, context, now, issue, { type: "comment", body: comment.body, commentId: comment.id });
  }
}

function saveIssueStatus(store: Store, args: Record<string, unknown>): Status {
  const existing =
    args.id === undefined ? undefined : store.issueStatuses.find((status) => status.id === args.id);
  if (args.id !== undefined && existing === undefined)
    throw new Error(`Status not found: ${String(args.id)}`);
  if (existing === undefined && (args.name === undefined || args.type === undefined))
    throw new Error("Creating a status requires name and type");
  const name = ((args.name as string | undefined) ?? existing!.name).trim();
  if (name === "") throw new Error("Status name cannot be blank");
  if (store.issueStatuses.some((status) => status !== existing && norm(status.name) === norm(name)))
    throw new Error(`Status already exists: ${name}`);
  const status: Status = existing ?? { id: randomUUID(), name, type: args.type as string };
  status.name = name;
  if (args.type !== undefined) status.type = args.type as string;
  if (args.stage !== undefined) {
    for (const entry of store.issueStatuses) if (entry.stage === args.stage) delete entry.stage;
    status.stage = args.stage as DeliveryStage;
  }
  if (existing === undefined) store.issueStatuses.push(status);
  return status;
}

/** Precondition on the record as currently stored; checked before any field changes. */
function refuseCreatePrecondition(args: Record<string, unknown>): void {
  if (args.ifUpdatedAt !== undefined) throw new Error("ifUpdatedAt is only valid when updating a record");
}
function assertUnchangedSince(entity: Entity, args: Record<string, unknown>): void {
  if (args.ifUpdatedAt !== undefined && entity.updatedAt !== args.ifUpdatedAt)
    throw new TrackerWriteRefused(
      "precondition_failed",
      `the record changed since ${String(args.ifUpdatedAt)}; it is now at ${entity.updatedAt}. Read it again before updating.`,
    );
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
    stage: stageOf(issue),
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
  if (existing === undefined) refuseCreatePrecondition(args);
  else assertUnchangedSince(existing, args);
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
  if (creating) refuseCreatePrecondition(args);
  const project = creating
    ? newProject(store, args.name as string, now)
    : findProject(store, args.id as string);
  if (!creating) assertUnchangedSince(project, args);
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
  if (existing === undefined) refuseCreatePrecondition(args);
  else assertUnchangedSince(existing, args);
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
  context: WriteContext,
): Promise<unknown> {
  switch (name) {
    case "post_issue_event":
      return postIssueEvent(store, args, context, now, options);
    case "save_issue_status":
      return saveIssueStatus(store, args);
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
        assertUnchangedSince(comment, args);
        if (comment.issueId !== null)
          options.assertIssueWrite?.(issueView(store, findIssue(store, comment.issueId)));
        comment.body = args.body as string;
        comment.updatedAt = now;
        return commentView(store, comment);
      }
      refuseCreatePrecondition(args);
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
      if (existing === undefined) refuseCreatePrecondition(args);
      else assertUnchangedSince(existing, args);
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
    case "list_initiatives":
      return { initiatives: [], hasNextPage: false };
    case "list_milestones":
      findProject(store, args.project as string);
      return { milestones: [], hasNextPage: false };
    default:
      throw new Error(`Unsupported tracker tool ${name}`);
  }
}

/** Reads, including the caller's own write receipts and the audit log. */
async function read(
  store: Store,
  name: string,
  args: Record<string, unknown>,
  options: LocalTrackerOptions,
  actor: TrackerActor,
  now: string,
): Promise<unknown> {
  if (name === "get_write_receipt") {
    // Keys are scoped to the authenticated caller: another actor's key is unknown here.
    const receipt = store.receipts?.find(
      (entry) => entry.actorKey === actorKey(actor) && entry.idempotencyKey === args.idempotencyKey,
    );
    if (receipt === undefined) return { idempotencyKey: args.idempotencyKey, state: "unknown" };
    return {
      idempotencyKey: receipt.idempotencyKey,
      state: receipt.state,
      tool: receipt.tool,
      at: receipt.at,
      ...(receipt.state === "applied"
        ? { result: receipt.result }
        : { reason: receipt.reason, detail: receipt.detail }),
    };
  }
  if (name === "list_audit_events") {
    const wanted = args.entityId === undefined ? undefined : norm(args.entityId as string);
    const events = [...(store.audit ?? [])]
      .reverse()
      .filter(
        (event) =>
          wanted === undefined ||
          (event.target !== undefined && norm(event.target) === wanted) ||
          event.entities.some(
            (entity) =>
              norm(entity.id) === wanted ||
              (entity.identifier !== undefined && norm(entity.identifier) === wanted),
          ),
      );
    return page(events as unknown as Record<string, unknown>[], args, "events", name);
  }
  if (name === "list_issue_events") {
    const issue = args.issueId === undefined ? undefined : findIssue(store, args.issueId as string);
    const after = args.after === undefined ? 0 : Number(args.after);
    if (!Number.isInteger(after) || after < 0) throw new Error("Invalid event cursor");
    const limit = typeof args.limit === "number" ? args.limit : 100;
    const matching = (store.events ?? []).filter(
      (event) => event.seq > after && (issue === undefined || event.issueId === issue.id),
    );
    const events = matching.slice(0, limit);
    return {
      events,
      // Resume from here; an empty page keeps the caller's cursor.
      cursor: String(events.at(-1)?.seq ?? after),
      hasNextPage: matching.length > events.length,
    };
  }
  return dispatch(store, name, args, options, now, { actor });
}

/** Durable local Linear-shaped tracker, also used as ancillary storage for repo backends. */
export function createLocalTracker(options: LocalTrackerOptions): LocalTrackerBackend {
  const directory = resolve(options.directory);
  const path = join(directory, "tracker.json");
  const listeners = new Set<TrackerEventListener>();
  const publish = (events: readonly TrackerItemEvent[]) => {
    for (const event of events)
      for (const listener of listeners) {
        try {
          listener(structuredClone(event));
        } catch {
          // A subscriber's failure never undoes or blocks a committed write.
        }
      }
  };
  return {
    catalog: () => TRACKER_TOOLS,
    async subscribe(listener, after = 0) {
      // Replay and registration share the store lock, so no event falls between them.
      await withTrackerStoreLock(path, async () => {
        let events: TrackerItemEvent[] = [];
        try {
          events = parseStore(await readFile(path, "utf8")).events ?? [];
        } catch (error) {
          if (codeOf(error) !== "ENOENT") throw error;
        }
        for (const event of events.filter((entry) => entry.seq > after)) listener(structuredClone(event));
        listeners.add(listener);
      });
      return () => {
        listeners.delete(listener);
      };
    },
    async call(name, args, callOptions) {
      validateTrackerToolArgs(name, args);
      return withTrackerStoreLock(path, async (assertHeld) => {
        const clock = (options.clock ?? (() => new Date()))().toISOString();
        let store: Store;
        let initialized = false;
        try {
          store = parseStore(await readFile(path, "utf8"));
        } catch (error) {
          if (codeOf(error) !== "ENOENT") throw error;
          store = seed(options, clock);
          initialized = true;
        }
        const actor = callOptions?.actor ?? localActor(store);
        const writing = /^(?:save|create|post)_/u.test(name);
        if (!writing) {
          const result = await read(store, name, args, options, actor, clock);
          if (initialized) await persist(path, store, assertHeld);
          // Callers cannot mutate objects subsequently reused by another backend call.
          return structuredClone(result);
        }
        const key = args.idempotencyKey as string | undefined;
        const request = Object.fromEntries(
          Object.entries(args).filter(([field]) => field !== "idempotencyKey"),
        );
        const fingerprint = createHash("sha256")
          .update(canonical([name, request]))
          .digest("hex");
        const prior =
          key === undefined
            ? undefined
            : store.receipts?.find(
                (entry) => entry.actorKey === actorKey(actor) && entry.idempotencyKey === key,
              );
        if (prior !== undefined) {
          if (prior.fingerprint !== fingerprint)
            throw new TrackerWriteRefused(
              "idempotency_conflict",
              `idempotencyKey ${key!} was already used for a different ${prior.tool} write; choose a new key for a new change`,
            );
          if (prior.state === "refused") throw new TrackerWriteRefused(prior.reason!, prior.detail!);
          // The original effect stands. Pass the host's fences so a revoked caller
          // cannot read it back, and report it as settled rather than uncertain.
          await callOptions?.beforeWrite?.();
          assertHeld();
          callOptions?.onDispatch?.();
          callOptions?.effectConfirmed?.();
          return structuredClone(prior.result);
        }
        const before = structuredClone(store);
        const now = nextWriteTime(store, clock);
        const fields = Object.keys(request).sort();
        let result: unknown;
        const context: WriteContext = {
          actor,
          ...(callOptions?.via === undefined ? {} : { via: callOptions.via }),
        };
        const firstEvent = (store.events?.length ?? 0) + 1;
        try {
          result = await dispatch(store, name, request, options, now, context);
          recordIssueChanges(before, store, name, context, now);
        } catch (error) {
          // Nothing the write changed survives. The refusal itself is recorded,
          // so a keyed retry answers the same and the audit log shows the attempt.
          const refusal =
            error instanceof TrackerWriteRefused
              ? error
              : new TrackerWriteRefused(
                  "invalid_request",
                  error instanceof Error ? error.message : String(error),
                );
          const detail = refusal.message.replace(/^Write refused \([^)]*\): /u, "");
          store = before;
          store.lastWriteAt = now;
          const target = auditTarget(request);
          appendAudit(store, {
            at: now,
            tool: name,
            outcome: "refused",
            actor,
            ...(key === undefined ? {} : { idempotencyKey: key }),
            fields,
            entities: [],
            ...(target === undefined ? {} : { target }),
            reason: refusal.reason,
            detail,
          });
          if (key !== undefined)
            (store.receipts ??= []).push({
              actorKey: actorKey(actor),
              idempotencyKey: key,
              tool: name,
              fingerprint,
              state: "refused",
              at: now,
              reason: refusal.reason,
              detail,
            });
          // Bookkeeping only: no tracker record changed, so no publication callbacks.
          await persist(path, store, assertHeld);
          throw refusal;
        }
        const entities = stampActor(store, actor, now);
        // Views were built before stamping; the receipt keeps exactly what the caller sees.
        const view = result as Record<string, unknown>;
        if (view.updatedAt === now) {
          view.updatedByActor = actor;
          if (view.createdAt === now) view.createdByActor = actor;
        }
        const derived = store.issues.find((issue) => issue.id === view.id);
        if (derived !== undefined) {
          view.stage = stageOf(derived);
          view.state = view.status = store.issueStatuses.find(
            (status) => status.id === derived.statusId,
          )!.name;
        }
        const settled = structuredClone(result);
        appendAudit(store, {
          at: now,
          tool: name,
          outcome: "applied",
          actor,
          ...(key === undefined ? {} : { idempotencyKey: key }),
          fields,
          entities,
        });
        if (key !== undefined)
          (store.receipts ??= []).push({
            actorKey: actorKey(actor),
            idempotencyKey: key,
            tool: name,
            fingerprint,
            state: "applied",
            at: now,
            result: settled,
          });
        await persist(path, store, assertHeld, callOptions);
        publish(store.events?.slice(firstEvent - 1) ?? []);
        return settled;
      });
    },
  };
}
