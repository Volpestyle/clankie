import {
  TrackerSyncCommandSchema,
  type TrackerSyncCommand,
  type TrackerSyncModel,
  type TrackerSyncCommit,
  type TrackerSyncResult,
} from "@clankie/protocol";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compareVersions, type ReleaseHistory } from "./releases.ts";
import { withTrackerStoreLock } from "./tracker-store-lock.ts";
import {
  linearId,
  linearRow,
  type LinearImportSnapshot,
  type LinearImportReport,
  type LinearRecord,
} from "./linear-import.ts";
import {
  applyTrackerDescriptionPatch,
  DELIVERY_STAGES,
  TRACKER_LEAD,
  TRACKER_OWNER,
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
  milestoneId?: string | null;
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
  /** The project cycle it is in (VUH-1931); set by the owner or lead, moved by rollover. */
  cycleId?: string | null;
  /** Who is working on it until when (VUH-1918). Kept after expiry until released or taken. */
  lease?: Lease | null;
  blocked?: boolean;
  asking?: boolean;
  errored?: boolean;
}
export interface EvidenceReference {
  recordId: string;
  sha256: string;
  url: string;
  type: "log" | "screenshot" | "video" | "diff" | "eval" | "other";
}
interface EvidenceBundle {
  id: string;
  issueId: string;
  runId: string | null;
  references: EvidenceReference[];
  gaps: string[];
  actor: TrackerActor;
  at: string;
  checked?: { actor: TrackerActor; at: string; eventId: string };
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
  /** Cycle length in days (VUH-1931); absent means one week. */
  cycleDays?: number;
}
interface Lease {
  holder: string;
  actor: TrackerActor;
  acquiredAt: string;
  expiresAt: string;
}
/** One attempt at an issue's work (VUH-1918). Seat, pane and hire come from its actor, live. */
interface Run {
  id: string;
  issueId: string;
  /** Attempt number on its issue: 2 is the first retry. */
  number: number;
  parentRunId: string | null;
  status: "active" | "succeeded" | "failed" | "canceled";
  paused?: boolean;
  /** Event IDs until linked, then ADR 0245 request IDs in ownerAsk references. */
  pendingGates?: string[];
  actor: TrackerActor;
  worktree: string | null;
  branch: string | null;
  startedAt: string;
  endedAt: string | null;
  tokens: number | null;
  costUsd: number | null;
  summary: string | null;
}
/** A time box of one project. Consecutive: each starts where the previous one ended. */
interface Cycle {
  id: string;
  projectId: string;
  number: number;
  startsAt: string;
  endsAt: string;
  createdAt: string;
}
interface Comment extends Entity {
  body: string;
  parentId: string | null;
  issueId: string | null;
  projectId: string | null;
  statusUpdateId: string | null;
  documentId?: string | null;
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
/** A shipped version (VUH-1930). Its items come from landed commits; no tool sets them. */
interface Release {
  /** Stable across syncs: repository, lane and version. */
  id: string;
  repository: string;
  lane: string;
  version: string;
  tag: string;
  commit: string;
  date: string;
  dateKind: "tag" | "commit" | "published";
  /** issueId is set when the key is a built-in item; other keys (VUH-…) are listed by key only. */
  items: { key: string; issueId?: string; commits: string[] }[];
  firstSyncedAt: string;
  syncedAt: string;
}
interface Store {
  version: 1;
  /** Import keeps the native store identity separate from the provider's team id. */
  storeId?: string;
  syncId?: number;
  syncLog?: (TrackerSyncCommit & { prevHash: string; hash: string })[];
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
  /** Mirror records, keyed by provider id; Linear remains authoritative until cutover. */
  linearMirror?: { workspaceId: string; records: Record<string, LinearRecord[]> };
  actors?: (User & { actor: TrackerActor })[];
  milestones?: LinearRecord[];
  documents?: LinearRecord[];
  recordEvents?: { type: string; id: string; at: string; actor: TrackerActor; via: string }[];
  statusUpdates: StatusUpdate[];
  /** Absent in stores written before VUH-1916; created on their next write. */
  receipts?: WriteReceipt[];
  audit?: AuditEvent[];
  /** Strictly increasing write time, so updatedAt is a usable precondition. */
  lastWriteAt?: string;
  /** Hash-linked item event stream (VUH-1917); its seq is the resumable cursor. */
  events?: TrackerItemEvent[];
  /** Shipped versions, derived from repository tags and commits (VUH-1930). */
  releases?: Release[];
  /** Project cycles (VUH-1931), created as they are first needed. */
  cycles?: Cycle[];
  /** Runs of issue work (VUH-1918). */
  runs?: Run[];
  bundles?: EvidenceBundle[];
  /** Links to ADR 0245 records; no question, answer or parallel ask lifecycle here. */
  ownerAsks?: { eventId: string; issueId: string; runId?: string; requestId: string }[];
}

/** Who and why for one write, threaded into item events. */
interface WriteContext {
  readonly actor: TrackerActor;
  readonly via?: string;
}

/** Live delivery of newly committed item events, after their write is durable. */
export type TrackerEventListener = (event: TrackerItemEvent) => void;
export interface LocalTrackerBackend extends TrackerToolBackend {
  sync(
    command: TrackerSyncCommand,
    options?: TrackerToolCallOptions,
    signal?: AbortSignal,
  ): Promise<TrackerSyncResult>;
  /** Host-only mirror write. Never invokes workflow gates, wakes or rollover. */
  importLinear(
    snapshot: LinearImportSnapshot,
    actorMap: Readonly<Record<string, TrackerActor>>,
    options?: TrackerToolCallOptions,
  ): Promise<LinearImportReport>;
  /** Replays events after the cursor (seq), then pushes new ones. Returns an unsubscribe. */
  /** Host-only: link the existing mailbox record to its requesting item event. */
  linkOwnerAsk(eventId: string, requestId: string): Promise<void>;
  /** Host-only: apply an authenticated ADR 0245 resolution. Public tools cannot approve. */
  resolveOwnerAsk(eventId: string, requestId: string, approved: boolean, body: string): Promise<void>;
  subscribe(listener: TrackerEventListener, after?: number): Promise<() => void>;
  /**
   * Upserts a repository's shipped versions and moves each built-in item a version
   * contains to delivered, as stage events. The history is what git records; this is
   * a host operation, not a tool, so no caller can type a release's items.
   */
  syncReleases(history: ReleaseHistory, options?: TrackerToolCallOptions): Promise<ReleaseSyncResult>;
}

export interface ReleaseSyncResult {
  readonly repository: string;
  readonly lane: string;
  readonly releases: readonly { id: string; version: string; items: number; builtIn: number }[];
  /** Items this sync moved to delivered, with the version that shipped them. */
  readonly delivered: readonly { identifier: string; version: string }[];
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
  /**
   * The live seat, pane and hire behind a run's actor, from the host's own hire records
   * (VUH-1918). Read on every view; the tracker keeps no copy of seat state.
   */
  /** Resolve store records at the host boundary. Missing validation fails closed on uploads. */
  readonly validateEvidence?: (issueKey: string, references: readonly EvidenceReference[]) => Promise<void>;
  readonly runner?: (actor: TrackerActor) => Record<string, unknown> | undefined;
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
    typeof store.user?.id !== "string" ||
    (store.storeId !== undefined && (typeof store.storeId !== "string" || store.storeId.length === 0))
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
  if (
    store.bundles !== undefined &&
    (!Array.isArray(store.bundles) ||
      store.bundles.some(
        (bundle) =>
          typeof bundle?.id !== "string" || !Array.isArray(bundle.references) || !Array.isArray(bundle.gaps),
      ))
  )
    throw new Error("Invalid local tracker evidence bundles");
  if (
    store.ownerAsks !== undefined &&
    (!Array.isArray(store.ownerAsks) ||
      store.ownerAsks.some((ref) => typeof ref?.eventId !== "string" || typeof ref.requestId !== "string"))
  )
    throw new Error("Invalid local tracker owner ask references");
  if (store.syncLog !== undefined) {
    if (!Array.isArray(store.syncLog) || store.syncId !== store.syncLog.length)
      throw new Error("Invalid local tracker sync log");
    let previous = "";
    store.syncLog.forEach((commit, index) => {
      if (commit.syncId !== index + 1 || commit.prevHash !== previous || auditHash(commit) !== commit.hash)
        throw new Error("Local tracker sync log is not intact");
      previous = commit.hash;
    });
  } else if (store.syncId !== undefined && store.syncId !== 0)
    throw new Error("Missing local tracker sync log");
  bindStageStatuses(store);
  if (
    store.runs !== undefined &&
    (!Array.isArray(store.runs) || store.runs.some((entry) => typeof entry?.id !== "string"))
  )
    throw new Error("Invalid local tracker runs");
  if (
    store.cycles !== undefined &&
    (!Array.isArray(store.cycles) ||
      store.cycles.some((entry) => typeof entry?.id !== "string" || typeof entry.endsAt !== "string"))
  )
    throw new Error("Invalid local tracker cycles");
  if (
    store.releases !== undefined &&
    (!Array.isArray(store.releases) ||
      store.releases.some((entry) => typeof entry?.id !== "string" || !Array.isArray(entry.items)))
  )
    throw new Error("Invalid local tracker releases");
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

/** The write time (or its transaction operation times) identifies touched records. */
function stampActor(store: Store, actor: TrackerActor, now: string): AuditEvent["entities"] {
  const touched: AuditEvent["entities"] = [];
  for (const [collection, type] of ENTITY_TYPES)
    for (const entry of store[collection] as (Entity & { identifier?: string })[]) {
      if (entry.updatedAt < now) continue;
      if (entry.createdAt >= now) entry.createdByActor = actor;
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
    Partial<
      Pick<
        TrackerItemEvent,
        "body" | "from" | "to" | "commentId" | "bundleId" | "runId" | "requestId" | "gate" | "purpose"
      >
    >,
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
  body?: string,
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
  if (DELIVERY_STAGES.indexOf(target) > DELIVERY_STAGES.indexOf("landed")) {
    const bundle = currentBundle(store, issue.id);
    if (bundle === undefined)
      throw new TrackerWriteRefused(
        "evidence_bundle_required",
        "completion past landed requires an evidence bundle",
      );
    if (target === "owner-verified" && bundle.checked === undefined)
      checkBundle(store, bundle, context, now, "Owner verification checked the bundle.");
    if (bundle.checked === undefined)
      throw new TrackerWriteRefused(
        "bundle_check_required",
        "completion past landed requires an independent bundle check",
      );
  }
  issue.stage = target;
  issue.statusId = statusForStage(store, target).id;
  appendEvent(store, context, now, issue, {
    type: target === "owner-verified" ? "verified" : back ? "reopened" : "stage",
    from: current,
    to: target,
    ...(body === undefined ? {} : { body }),
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
  // These record their own stage events.
  if (
    name === "post_issue_event" ||
    name === "sync_releases" ||
    name === "rollover_cycles" ||
    name === "sync_transaction"
  )
    return;
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
      if (is === "completed")
        throw new TrackerWriteRefused(
          "evidence_bundle_required",
          "create the item, attach a bundle and independently verify it before completing",
        );
      const initialStage = store.issueStatuses.find((status) => status.id === issue.statusId)?.stage;
      if (
        initialStage !== undefined &&
        DELIVERY_STAGES.indexOf(initialStage) > DELIVERY_STAGES.indexOf("landed")
      )
        throw new TrackerWriteRefused(
          "evidence_bundle_required",
          "create the item and attach a checked bundle before setting a status past landed",
        );
      issue.stage = "reported";
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
        moveStage(store, issue, is === "completed" ? "owner-verified" : "accepted", context, now);
      } else {
        const bound = store.issueStatuses.find((status) => status.id === issue.statusId)?.stage;
        if (bound !== undefined) moveStage(store, issue, bound, context, now);
        appendEvent(store, context, now, issue, {
          type: "state",
          ...(from === undefined ? {} : { from }),
          to,
        });
      }
    }
    if (previous !== undefined && previous.priority !== issue.priority)
      appendEvent(store, context, now, issue, {
        type: "priority",
        from: String(previous.priority),
        to: String(issue.priority),
      });
  }
  for (const comment of store.comments) {
    if (
      comment.createdAt !== now ||
      comment.issueId === null ||
      before.comments.some((entry) => entry.id === comment.id)
    )
      continue;
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

const DELIVERED = DELIVERY_STAGES.indexOf("delivered");

/**
 * Upsert each shipped version, then deliver its built-in items oldest version
 * first: an item is delivered by the first release that ships it, on any lane.
 */
function syncReleases(
  store: Store,
  history: ReleaseHistory,
  context: WriteContext,
  now: string,
): ReleaseSyncResult {
  const releases = (store.releases ??= []);
  const synced: Release[] = [];
  for (const snapshot of history.releases) {
    const id = `${history.repository}:${history.lane}:${snapshot.version}`;
    const existing = releases.find((entry) => entry.id === id);
    const release: Release = {
      id,
      repository: history.repository,
      lane: history.lane,
      version: snapshot.version,
      tag: snapshot.tag,
      commit: snapshot.commit,
      date: snapshot.date,
      dateKind: snapshot.dateKind,
      items: snapshot.items.map((item) => {
        const issue = store.issues.find((entry) => norm(entry.identifier) === norm(item.key));
        return {
          key: item.key,
          ...(issue === undefined ? {} : { issueId: issue.id }),
          commits: [...item.commits],
        };
      }),
      firstSyncedAt: existing?.firstSyncedAt ?? now,
      syncedAt: now,
    };
    if (existing === undefined) releases.push(release);
    else releases[releases.indexOf(existing)] = release;
    synced.push(release);
  }
  const delivered: { identifier: string; version: string }[] = [];
  // The history is oldest version first.
  for (const release of synced)
    for (const item of release.items) {
      const issue = store.issues.find((entry) => entry.id === item.issueId);
      if (issue === undefined || DELIVERY_STAGES.indexOf(stageOf(issue)) >= DELIVERED) continue;
      if (["canceled", "duplicate"].includes(categoryOf(store, issue.statusId) ?? "")) continue;
      moveStage(store, issue, "delivered", context, now, `Shipped in ${release.version} (${release.lane})`);
      issue.updatedAt = now;
      delivered.push({ identifier: issue.identifier, version: release.version });
    }
  return {
    repository: history.repository,
    lane: history.lane,
    releases: synced.map((release) => ({
      id: release.id,
      version: release.version,
      items: release.items.length,
      builtIn: release.items.filter((item) => item.issueId !== undefined).length,
    })),
    delivered,
  };
}
/** Oldest first by ship date, then by version. */
const releaseOrder = (a: Release, b: Release) =>
  Date.parse(a.date) - Date.parse(b.date) ||
  compareVersions(a.version, b.version) ||
  a.id.localeCompare(b.id);
const releaseContains = (release: Release, issue: Issue) =>
  release.items.some((item) => item.issueId === issue.id || norm(item.key) === norm(issue.identifier));
/** Linear's release shape where it has one; with a store, items carry their built-in issue. */
function releaseView(release: Release, store?: Store): Record<string, unknown> {
  return {
    ...release,
    name: release.version,
    slugId: release.id,
    pipeline: { name: `${release.repository}:${release.lane}`, lane: release.lane },
    stage: { name: "Shipped", type: "completed" },
    items: release.items.map((item) => {
      const issue = store?.issues.find((entry) => entry.id === item.issueId);
      if (store === undefined)
        return { key: item.key, ...(item.issueId === undefined ? {} : { issueId: item.issueId }) };
      return issue === undefined
        ? item
        : {
            ...item,
            identifier: issue.identifier,
            title: issue.title,
            stage: stageOf(issue),
            url: localUrl("issue", issue.id),
          };
    }),
  };
}
/** Shipped tags carry no release notes; asking for them fails rather than returning none. */
function unsupportedReleaseNotes(args: Record<string, unknown>): void {
  if (args.includeReleaseNotes === true)
    throw new Error("Release notes are not available on the built-in tracker");
}

const DAY = 86_400_000;
/** The automatic move of unfinished items into the next cycle. */
const ROLLOVER = "rollover";
const DEFAULT_CYCLE_DAYS = 7;
const cycleName = (cycle: Cycle) => `Cycle ${String(cycle.number)}`;
const projectCycles = (store: Store, projectId: string) =>
  (store.cycles ?? []).filter((cycle) => cycle.projectId === projectId).sort((a, b) => a.number - b.number);
const isOpen = (store: Store, issue: Issue) =>
  !["completed", "canceled", "duplicate"].includes(categoryOf(store, issue.statusId) ?? "");
/** The owner (directly or through the owner's app) and Clankie as lead: they plan cycles and override runs and leases. */
const ownerOrLead = (actor: TrackerActor) =>
  isOwnerActivity(actor) || (actor.type === "agent-worker" && actor.id === TRACKER_LEAD.id);

function addCycle(store: Store, project: Project, startsAt: string, now: string): Cycle {
  const previous = projectCycles(store, project.id).at(-1);
  const cycle: Cycle = {
    id: randomUUID(),
    projectId: project.id,
    number: (previous?.number ?? 0) + 1,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + (project.cycleDays ?? DEFAULT_CYCLE_DAYS) * DAY).toISOString(),
    createdAt: now,
  };
  (store.cycles ??= []).push(cycle);
  return cycle;
}

/**
 * True when a project's latest cycle has ended, or an unfinished item sits in an
 * ended cycle (a later cycle may already exist, planned ahead): the next access rolls over.
 */
function cyclesDue(store: Store, clock: string): boolean {
  if (store.linearMirror) return false; // provider cycles remain authoritative during mirror
  const ended = new Set(
    (store.cycles ?? []).filter((cycle) => cycle.endsAt <= clock).map((cycle) => cycle.id),
  );
  return (
    store.issues.some((issue) => issue.cycleId != null && ended.has(issue.cycleId) && isOpen(store, issue)) ||
    store.projects.some((project) => {
      const last = projectCycles(store, project.id).at(-1);
      return last !== undefined && last.endsAt <= clock;
    })
  );
}

function moveCycle(
  store: Store,
  issue: Issue,
  target: Cycle | undefined,
  context: WriteContext,
  now: string,
): void {
  const current = (store.cycles ?? []).find((cycle) => cycle.id === issue.cycleId);
  if (current?.id === target?.id) return;
  issue.cycleId = target?.id ?? null;
  // Rollover is bookkeeping, not work: an item that only rolls over still reads as idle.
  if (context.via !== ROLLOVER) issue.updatedAt = now;
  appendEvent(store, context, now, issue, {
    type: "cycle",
    ...(current === undefined ? {} : { from: current.id }),
    ...(target === undefined ? {} : { to: target.id }),
    body: `${current === undefined ? "No cycle" : cycleName(current)} → ${target === undefined ? "no cycle" : cycleName(target)}`,
  });
}

/**
 * Advance every project with cycles to the cycle containing now, creating each
 * elapsed cycle, and roll its unfinished items into the current one (VUH-1931).
 */
function rolloverCycles(
  store: Store,
  clock: string,
  context: WriteContext,
  now: string,
): { rolled: string[] } {
  const rolled: string[] = [];
  for (const project of store.projects) {
    const cycles = projectCycles(store, project.id);
    let last = cycles.at(-1);
    if (last === undefined) continue;
    while (last.endsAt <= clock) last = addCycle(store, project, last.endsAt, now);
    const target = projectCycles(store, project.id).find(
      (cycle) => cycle.startsAt <= clock && clock < cycle.endsAt,
    );
    if (target === undefined) continue; // A clock behind the first cycle's start; nothing has ended.
    const ended = new Set(
      projectCycles(store, project.id)
        .filter((cycle) => cycle.endsAt <= clock)
        .map((cycle) => cycle.id),
    );
    for (const issue of store.issues)
      if (issue.cycleId != null && ended.has(issue.cycleId) && isOpen(store, issue)) {
        moveCycle(store, issue, target, context, now);
        rolled.push(issue.identifier);
      }
  }
  return { rolled };
}

/** The project's current cycle, starting its first at today's UTC midnight when it has none. */
function currentCycle(store: Store, project: Project, now: string, create: boolean): Cycle | undefined {
  const found = projectCycles(store, project.id).find((cycle) => cycle.startsAt <= now && now < cycle.endsAt);
  if (found !== undefined || !create) return found;
  return addCycle(store, project, `${now.slice(0, 10)}T00:00:00.000Z`, now);
}

function findCycle(
  store: Store,
  reference: string | number,
  project: Project | undefined,
  now: string,
  create: boolean,
): Cycle {
  const key = typeof reference === "number" ? String(reference) : norm(reference);
  if (["current", "next", "previous"].includes(key)) {
    if (project === undefined) throw new Error(`Cycle ${key} needs a project; cycles are per project`);
    const current = currentCycle(store, project, now, create);
    if (current === undefined) throw new Error(`${project.name} has no cycles yet`);
    if (key === "current") return current;
    const neighbour = projectCycles(store, project.id).find(
      (cycle) => cycle.number === current.number + (key === "next" ? 1 : -1),
    );
    if (neighbour !== undefined) return neighbour;
    if (key === "next" && create) return addCycle(store, project, current.endsAt, now);
    throw new Error(`${project.name} has no ${key} cycle`);
  }
  const matches = (store.cycles ?? []).filter(
    (cycle) =>
      norm(cycle.id) === key ||
      ((String(cycle.number) === key || norm(cycleName(cycle)) === key) &&
        (project === undefined || cycle.projectId === project.id)),
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length === 0
        ? `Cycle not found: ${String(reference)}`
        : `Cycle ${String(reference)} is ambiguous; pass a project or its id`,
    );
  return matches[0]!;
}

/** Membership is the owner's or the lead's call; a cycle belongs to the issue's project. */
function setIssueCycle(
  store: Store,
  issue: Issue,
  reference: unknown,
  context: WriteContext,
  now: string,
): void {
  if (!ownerOrLead(context.actor))
    throw new TrackerWriteRefused(
      "cycle_planning_reserved",
      "only the owner or the lead adds items to cycles or removes them",
    );
  if (reference === null) return moveCycle(store, issue, undefined, context, now);
  const project =
    issue.projectId === null ? undefined : store.projects.find((entry) => entry.id === issue.projectId);
  if (project === undefined) throw new Error("Cycles are per project; give the issue a project first");
  const cycle = findCycle(store, reference as string | number, project, now, true);
  if (cycle.projectId !== project.id) throw new Error(`${cycleName(cycle)} belongs to a different project`);
  if (cycle.endsAt <= now) throw new Error(`${cycleName(cycle)} has ended`);
  moveCycle(store, issue, cycle, context, now);
}

/**
 * What happened in a cycle, read from the event stream: planned (in it before it
 * started), added after it started, rolled in, removed, finished while in it,
 * rolled over out of it, and still in flight.
 */
function cycleView(store: Store, cycle: Cycle, now: string): Record<string, unknown> {
  const project = store.projects.find((entry) => entry.id === cycle.projectId);
  const summary = {
    planned: new Set<string>(),
    added: new Set<string>(),
    rolledIn: new Set<string>(),
    removed: new Set<string>(),
    finished: new Set<string>(),
    rolledOver: new Set<string>(),
    inFlight: new Set<string>(),
  };
  const members = new Set<string>();
  for (const event of store.events ?? []) {
    if (event.type === "cycle" && event.to === cycle.id) {
      members.add(event.issueId);
      const rolled = event.via === ROLLOVER;
      (rolled ? summary.rolledIn : event.at < cycle.startsAt ? summary.planned : summary.added).add(
        event.identifier,
      );
    } else if (event.type === "cycle" && event.from === cycle.id) {
      members.delete(event.issueId);
      (event.via === ROLLOVER ? summary.rolledOver : summary.removed).add(event.identifier);
    } else if (members.has(event.issueId) && event.at < cycle.endsAt) {
      const completed =
        event.type === "verified" ||
        (event.type === "state" &&
          store.issueStatuses.find((status) => status.name === event.to)?.type === "completed");
      if (completed) summary.finished.add(event.identifier);
    }
  }
  for (const issue of store.issues)
    if (issue.cycleId === cycle.id && isOpen(store, issue) && cycle.startsAt <= now && now < cycle.endsAt)
      summary.inFlight.add(issue.identifier);
  return {
    id: cycle.id,
    number: cycle.number,
    name: cycleName(cycle),
    startsAt: cycle.startsAt,
    endsAt: cycle.endsAt,
    project: project?.name ?? null,
    projectId: cycle.projectId,
    isActive: cycle.startsAt <= now && now < cycle.endsAt,
    isPast: cycle.endsAt <= now,
    isFuture: now < cycle.startsAt,
    issues: store.issues.filter((issue) => issue.cycleId === cycle.id).map((issue) => issue.identifier),
    summary: Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, [...value]])),
  };
}

const DEFAULT_LEASE_MINUTES = 30;
const DEFAULT_IDLE_DAYS = 30;
const leaseLive = (issue: Issue, now: string) => issue.lease != null && issue.lease.expiresAt > now;
const runsOf = (store: Store, issueId: string) => (store.runs ?? []).filter((run) => run.issueId === issueId);
const actorName = (actor: TrackerActor) => actor.name ?? actor.id;

function runView(store: Store, run: Run, now: string, options: LocalTrackerOptions): Record<string, unknown> {
  const issue = store.issues.find((entry) => entry.id === run.issueId);
  return {
    ...run,
    identifier: issue?.identifier ?? null,
    blocked: run.status === "active" && (run.paused === true || (run.pendingGates?.length ?? 0) > 0),
    bundle: currentBundle(store, run.issueId, run.id) ?? null,
    ownerAsks: (store.ownerAsks ?? []).filter((ref) => ref.runId === run.id),
    durationMs: Date.parse(run.endedAt ?? now) - Date.parse(run.startedAt),
    link: options.runner?.(run.actor) ?? null,
  };
}

const currentBundle = (store: Store, issueId: string, runId: string | null = null) =>
  (store.bundles ?? []).findLast((bundle) => bundle.issueId === issueId && bundle.runId === runId);

function checkBundle(
  store: Store,
  bundle: EvidenceBundle,
  context: WriteContext,
  now: string,
  body?: string,
) {
  const issue = findIssue(store, bundle.issueId);
  if (currentBundle(store, bundle.issueId, bundle.runId)?.id !== bundle.id)
    throw new TrackerWriteRefused("bundle_superseded", "check the current bundle, not a superseded version");
  const workers = [
    bundle.actor,
    ...runsOf(store, issue.id).map((run) => run.actor),
    ...(store.events ?? [])
      .filter(
        (event) =>
          event.issueId === issue.id &&
          event.at < now &&
          event.via !== "owner_ask" &&
          (["action", "result"].includes(event.type) || (event.type === "stage" && event.to === "landed")),
      )
      .map((event) => event.actor),
  ];
  if (workers.some((actor) => actorKey(actor) === actorKey(context.actor)))
    throw new TrackerWriteRefused("bundle_self_check", "an actor who did the work cannot check its bundle");
  if (bundle.checked !== undefined) return;
  appendEvent(store, context, now, issue, {
    type: "bundle_checked",
    bundleId: bundle.id,
    ...(bundle.runId === null ? {} : { runId: bundle.runId }),
    ...(body === undefined ? {} : { body }),
  });
  bundle.checked = { actor: context.actor, at: now, eventId: store.events!.at(-1)!.id };
}

async function saveBundle(
  store: Store,
  args: Record<string, unknown>,
  context: WriteContext,
  now: string,
  options: LocalTrackerOptions,
) {
  const issue = findIssue(store, args.issueId as string);
  options.assertIssueWrite?.(issueView(store, issue));
  const runId = (args.runId as string | undefined) ?? null;
  if (runId === null && DELIVERY_STAGES.indexOf(stageOf(issue)) > DELIVERY_STAGES.indexOf("landed"))
    throw new TrackerWriteRefused(
      "bundle_locked",
      "the owner must reopen an item to landed or earlier before replacing its completion bundle",
    );
  if (runId !== null && !(store.runs ?? []).some((run) => run.id === runId && run.issueId === issue.id))
    throw new Error("runId must name a run on this issue");
  const references = args.references as EvidenceReference[];
  for (const ref of references)
    if (ref.url !== `clankie://evidence/sha256/${ref.sha256}`)
      throw new Error("Evidence link and sha256 must match");
  if (!options.validateEvidence)
    throw new TrackerWriteRefused(
      "evidence_store_unavailable",
      "the host must validate evidence-store record IDs before attaching them",
    );
  await options.validateEvidence(issue.identifier, references);
  const bundle: EvidenceBundle = {
    id: randomUUID(),
    issueId: issue.id,
    runId,
    references,
    gaps: args.gaps as string[],
    actor: context.actor,
    at: now,
  };
  (store.bundles ??= []).push(bundle);
  appendEvent(store, context, now, issue, {
    type: "bundle",
    bundleId: bundle.id,
    ...(runId === null ? {} : { runId }),
  });
  issue.updatedAt = now;
  return bundle;
}

function postAsk(
  store: Store,
  args: Record<string, unknown>,
  context: WriteContext,
  now: string,
  options: LocalTrackerOptions,
) {
  const issue = findIssue(store, args.issueId as string);
  options.assertIssueWrite?.(issueView(store, issue));
  const run =
    args.runId === undefined
      ? undefined
      : (store.runs ?? []).find((entry) => entry.id === args.runId && entry.issueId === issue.id);
  if (args.runId !== undefined && run === undefined) throw new Error("runId must name a run on this issue");
  if (run && actorKey(run.actor) !== actorKey(context.actor) && !ownerOrLead(context.actor))
    throw new TrackerWriteRefused(
      "run_owner_required",
      "only its runner, owner or lead requests a gate on a run",
    );
  if (args.purpose === "gate" && (!run || !args.gate)) throw new Error("A gate requires runId and gate");
  if (args.purpose !== "gate" && args.gate !== undefined) throw new Error("gate requires purpose gate");
  if (run && run.status !== "active") throw new Error("A finished run cannot request an ask");
  appendEvent(store, context, now, issue, {
    type: "ask",
    purpose: args.purpose as "decision" | "gate",
    body: args.body as string,
    ...(run === undefined ? {} : { runId: run.id }),
    ...(args.gate === undefined ? {} : { gate: args.gate as NonNullable<TrackerItemEvent["gate"]> }),
  });
  const event = store.events!.at(-1)!;
  if (args.purpose === "gate") (run!.pendingGates ??= []).push(event.id);
  issue.updatedAt = now;
  return event;
}

function controlRun(
  store: Store,
  args: Record<string, unknown>,
  context: WriteContext,
  now: string,
  options: LocalTrackerOptions,
) {
  if (!ownerOrLead(context.actor))
    throw new TrackerWriteRefused(
      "run_control_reserved",
      "only the owner or lead steers, pauses or stops a run",
    );
  const run = (store.runs ?? []).find((entry) => entry.id === args.runId);
  if (!run) throw new Error("Run not found");
  if (run.status !== "active") throw new Error("Run already finished");
  const issue = findIssue(store, run.issueId);
  options.assertIssueWrite?.(issueView(store, issue));
  const action = args.action as "steer" | "pause" | "resume" | "stop";
  if (action === "pause") run.paused = true;
  if (action === "resume") run.paused = false;
  if (action === "stop") {
    run.status = "canceled";
    run.endedAt = now;
  }
  appendEvent(store, context, now, issue, {
    type: action,
    runId: run.id,
    ...(args.body === undefined ? {} : { body: args.body as string }),
  });
  issue.updatedAt = now;
  return runView(store, run, now, options);
}

/** Start a run (issueId) or update or finish one (id). Only its runner, the owner or the lead touch it. */
function saveRun(
  store: Store,
  args: Record<string, unknown>,
  context: WriteContext,
  now: string,
  options: LocalTrackerOptions,
): Record<string, unknown> {
  if ((args.id === undefined) === (args.issueId === undefined))
    throw new Error("save_run takes issueId to start a run or id to update one");
  let run: Run;
  let issue: Issue;
  if (args.id === undefined) {
    issue = findIssue(store, args.issueId as string);
    options.assertIssueWrite?.(issueView(store, issue));
    if (leaseLive(issue, now) && issue.lease!.holder !== actorKey(context.actor))
      throw new TrackerWriteRefused(
        "lease_held",
        `${issue.identifier} is leased by ${actorName(issue.lease!.actor)} until ${issue.lease!.expiresAt}`,
      );
    if (args.status !== undefined) throw new Error("A run starts active; finish it with its id");
    const parent =
      args.parentRunId === undefined
        ? undefined
        : (store.runs ?? []).find((entry) => entry.id === args.parentRunId);
    if (args.parentRunId !== undefined && parent === undefined)
      throw new Error(`Run not found: ${String(args.parentRunId)}`);
    if (parent?.status === "active" && (parent.paused || (parent.pendingGates?.length ?? 0) > 0))
      throw new TrackerWriteRefused(
        "run_blocked",
        "a child run cannot bypass its parent's pause or owner gate",
      );
    run = {
      id: randomUUID(),
      issueId: issue.id,
      number: runsOf(store, issue.id).length + 1,
      parentRunId: parent?.id ?? null,
      status: "active",
      actor: context.actor,
      worktree: (args.worktree as string | undefined) ?? null,
      branch: (args.branch as string | undefined) ?? null,
      startedAt: now,
      endedAt: null,
      tokens: null,
      costUsd: null,
      summary: null,
    };
    (store.runs ??= []).push(run);
    appendEvent(store, context, now, issue, {
      type: "run",
      to: "active",
      body: `Run ${String(run.number)} started${run.worktree === null ? "" : ` in ${run.worktree}`}`,
    });
  } else {
    const found = (store.runs ?? []).find((entry) => entry.id === args.id);
    if (found === undefined) throw new Error(`Run not found: ${String(args.id)}`);
    run = found;
    issue = findIssue(store, run.issueId);
    if (actorKey(run.actor) !== actorKey(context.actor) && !ownerOrLead(context.actor))
      throw new TrackerWriteRefused(
        "run_owner_required",
        "only the run's own runner, the owner or the lead updates it",
      );
    if (args.parentRunId !== undefined) throw new Error("A run's parent is set when it starts");
    options.assertIssueWrite?.(issueView(store, issue));
    if ((run.pendingGates?.length ?? 0) > 0 || run.paused === true)
      if (args.status !== "canceled")
        throw new TrackerWriteRefused(
          "run_blocked",
          "run is paused or waiting for an owner gate; only cancellation is allowed",
        );
    if (run.status !== "active") throw new Error(`Run ${String(run.number)} already ${run.status}`);
  }
  for (const key of ["worktree", "branch", "tokens", "costUsd", "summary"] as const)
    if (args[key] !== undefined && args.id !== undefined)
      (run as unknown as Record<string, unknown>)[key] = args[key];
  if (args.status !== undefined) {
    run.status = args.status as Run["status"];
    run.endedAt = now;
    appendEvent(store, context, now, issue, {
      type: "run",
      from: "active",
      to: run.status,
      body: `Run ${String(run.number)} ${run.status}${run.summary === null ? "" : `: ${run.summary}`}`,
    });
  }
  issue.updatedAt = now;
  return runView(store, run, now, options);
}

/** Take, renew or release an issue's lease. An expired lease is anyone's to take. */
function saveLease(
  store: Store,
  args: Record<string, unknown>,
  context: WriteContext,
  now: string,
  options: LocalTrackerOptions,
): Record<string, unknown> {
  const issue = findIssue(store, args.issueId as string);
  options.assertIssueWrite?.(issueView(store, issue));
  const held = issue.lease ?? undefined;
  const mine = held !== undefined && held.holder === actorKey(context.actor);
  if (args.release === true) {
    if (held === undefined) return issueView(store, issue);
    if (!mine && !ownerOrLead(context.actor))
      throw new TrackerWriteRefused(
        "lease_held",
        `${issue.identifier} is leased by ${actorName(held.actor)}`,
      );
    issue.lease = null;
    appendEvent(store, context, now, issue, {
      type: "lease",
      body: `Lease released (${actorName(held.actor)})`,
    });
  } else {
    if (args.ttlMinutes !== undefined && typeof args.ttlMinutes !== "number")
      throw new Error("ttlMinutes must be a number");
    if (held !== undefined && !mine && leaseLive(issue, now))
      throw new TrackerWriteRefused(
        "lease_held",
        `${issue.identifier} is leased by ${actorName(held.actor)} until ${held.expiresAt}`,
      );
    const expiresAt = new Date(
      Date.parse(now) + ((args.ttlMinutes as number | undefined) ?? DEFAULT_LEASE_MINUTES) * 60_000,
    ).toISOString();
    if (!mine)
      appendEvent(store, context, now, issue, {
        type: "lease",
        body:
          held === undefined
            ? `Leased until ${expiresAt}`
            : `Leased until ${expiresAt}; ${actorName(held.actor)}'s lease expired at ${held.expiresAt}`,
      });
    issue.lease = {
      holder: actorKey(context.actor),
      actor: context.actor,
      acquiredAt: mine ? held.acquiredAt : now,
      expiresAt,
    };
  }
  issue.updatedAt = now;
  return issueView(store, issue);
}

/** Rolled up from the issue's runs: attempts, what is still active, time, tokens and cost. */
function workSummary(store: Store, issue: Issue, now: string): Record<string, unknown> {
  const runs = runsOf(store, issue.id);
  const sum = (values: (number | null)[]) =>
    values.some((value) => value !== null)
      ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
      : null;
  return {
    runs: runs.length,
    activeRuns: runs.filter((run) => run.status === "active").length,
    durationMs: runs.reduce(
      (total, run) => total + Date.parse(run.endedAt ?? now) - Date.parse(run.startedAt),
      0,
    ),
    tokens: sum(runs.map((run) => run.tokens)),
    costUsd: sum(runs.map((run) => run.costUsd)),
    leased: leaseLive(issue, now),
  };
}

function inCurrentCycle(store: Store, issue: Issue, now: string): boolean {
  const cycle = (store.cycles ?? []).find((entry) => entry.id === issue.cycleId);
  return cycle !== undefined && cycle.startsAt <= now && now < cycle.endsAt;
}

/** Open, not yet landed, unblocked, unleased and not being run: what a worker can pick up now. */
function readyIssues(store: Store, project: Project | undefined, now: string): Issue[] {
  const landed = DELIVERY_STAGES.indexOf("landed");
  const open = (id: string) => {
    const target = store.issues.find((entry) => entry.id === id);
    return target !== undefined && isOpen(store, target);
  };
  return store.issues
    .filter(
      (issue) =>
        (project === undefined || issue.projectId === project.id) &&
        isOpen(store, issue) &&
        DELIVERY_STAGES.indexOf(stageOf(issue)) < landed &&
        issue.blocked !== true &&
        !issue.blockedBy.some(open) &&
        !leaseLive(issue, now) &&
        !runsOf(store, issue.id).some((run) => run.status === "active"),
    )
    .sort(
      (a, b) =>
        Number(inCurrentCycle(store, b, now)) - Number(inCurrentCycle(store, a, now)) ||
        priorityRank(a.priority) - priorityRank(b.priority) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
}

function drift(
  store: Store,
  project: Project | undefined,
  idleDays: number,
  now: string,
): Record<string, unknown> {
  const scoped = store.issues.filter((issue) => project === undefined || issue.projectId === project.id);
  const idleBefore = new Date(Date.parse(now) - idleDays * DAY).toISOString();
  return {
    staleLeases: scoped
      .filter((issue) => issue.lease != null && issue.lease.expiresAt <= now)
      .map((issue) => ({
        identifier: issue.identifier,
        holder: actorName(issue.lease!.actor),
        expiresAt: issue.lease!.expiresAt,
      })),
    activeRunsOnClosedIssues: (store.runs ?? [])
      .filter((run) => run.status === "active")
      .flatMap((run) => {
        const issue = scoped.find((entry) => entry.id === run.issueId);
        return issue === undefined || isOpen(store, issue)
          ? []
          : [
              {
                identifier: issue.identifier,
                state: store.issueStatuses.find((status) => status.id === issue.statusId)!.name,
                runId: run.id,
                runner: actorName(run.actor),
                worktree: run.worktree,
                startedAt: run.startedAt,
              },
            ];
      }),
    idleIssues: scoped
      .filter((issue) => isOpen(store, issue) && issue.updatedAt < idleBefore)
      .map((issue) => ({ identifier: issue.identifier, title: issue.title, updatedAt: issue.updatedAt })),
    idleDays,
  };
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
  const imported = store.actors?.find((user) =>
    [user.id, user.name, user.displayName].some((value) => norm(value) === norm(reference)),
  );
  if (imported) return imported;
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
  const assignee = issue.assigneeId === null ? null : findUser(store, issue.assigneeId);
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
    createdBy: findUser(store, issue.creatorId).name,
    createdById: issue.creatorId,
    url: localUrl("issue", issue.id),
    stage: stageOf(issue),
    bundle: currentBundle(store, issue.id) ?? null,
    ownerAsks: (store.ownerAsks ?? []).filter((ref) => ref.issueId === issue.id),
  };
  if (relations) {
    const summary = (id: string) => {
      const external = [
        ...(store.linearMirror?.records.issues ?? []).map((entry) => linearRow(entry.parent)),
        ...(store.linearMirror?.records.relations ?? []).flatMap((entry) => [
          linearRow(entry.issue),
          linearRow(entry.relatedIssue),
        ]),
      ].find((entry) => entry.id === id);
      if (!store.issues.some((entry) => entry.id === id))
        return {
          id,
          identifier: external?.identifier ?? id,
          title: external?.title ?? "Outside imported project",
          external: true,
        };
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
    user: findUser(store, update.userId),
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
    lead: project.leadId === null ? null : findUser(store, project.leadId),
    members: [],
    milestones: (store.milestones ?? []).filter((entry) => linearId(entry.project) === project.id),
    resources: {
      links: project.links,
      documents: (store.documents ?? []).filter((entry) => linearId(entry.project) === project.id),
      attachments: [],
    },
    latestStatusUpdate: latest === undefined ? null : updateView(store, latest),
    cycleDays: project.cycleDays ?? DEFAULT_CYCLE_DAYS,
    url: localUrl("project", project.id),
  };
}
function commentView(store: Store, comment: Comment): Record<string, unknown> {
  return {
    ...comment,
    author: findUser(store, comment.userId),
    user: findUser(store, comment.userId),
    onBehalfOf: linearRow(comment).onBehalfOf ?? null,
    attachments: linearRow(comment).attachments ?? [],
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
  if (args.cycleDays !== undefined) project.cycleDays = args.cycleDays as number;
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
    case "get_issue": {
      const issue = findIssue(store, args.id as string);
      const view = {
        ...issueView(store, issue, args.includeRelations === true),
        work: workSummary(store, issue, now),
      };
      if (args.includeReleases !== true) return view;
      return {
        ...view,
        releases: (store.releases ?? [])
          .filter((release) => releaseContains(release, issue))
          .sort(releaseOrder)
          .map((release) => releaseView(release)),
      };
    }
    case "list_releases": {
      unsupportedReleaseNotes(args);
      if (args.hasReleaseNotes === true) return page([], args, "releases", name);
      const query = norm(text(args, "query") ?? "");
      const stage = args.stage === undefined ? undefined : norm(args.stage as string);
      const result = (store.releases ?? []).filter(
        (release) =>
          (args.pipeline === undefined ||
            [release.lane, release.repository, `${release.repository}:${release.lane}`].some(
              (value) => norm(value) === norm(args.pipeline as string),
            )) &&
          (args.version === undefined || release.version === args.version) &&
          (args.stageType === undefined || args.stageType === "completed") &&
          (stage === undefined || stage === "shipped" || stage === "completed") &&
          (query === "" ||
            release.version.toLowerCase().includes(query) ||
            release.items.some((item) => norm(item.key) === query)) &&
          ["createdAt", "updatedAt"].every(
            (key) =>
              args[key] === undefined ||
              (key === "createdAt" ? release.firstSyncedAt : release.syncedAt) >=
                dateBoundary(args[key] as string, now),
          ),
      );
      // Newest shipped first: a release's order is its ship date, not when it was recorded.
      result.sort((a, b) => releaseOrder(b, a));
      return page(
        result.map((release) => releaseView(release)),
        args,
        "releases",
        name,
      );
    }
    case "get_release": {
      unsupportedReleaseNotes(args);
      const reference = norm(args.id as string);
      const matches = (store.releases ?? []).filter(
        (entry) => norm(entry.id) === reference || norm(entry.version) === reference,
      );
      if (matches.length !== 1)
        throw new Error(
          matches.length === 0
            ? `Release not found: ${String(args.id)}`
            : `Version ${String(args.id)} shipped in several repositories or lanes; pass the release id`,
        );
      return releaseView(matches[0]!, store);
    }
    case "save_issue": {
      if (typeof args.id === "string")
        options.assertIssueWrite?.(issueView(store, findIssue(store, args.id)));
      const { cycle, ...fields } = args;
      const saved = saveIssue(store, fields, now);
      options.assertIssueWrite?.(saved);
      const issue = findIssue(store, saved.id as string);
      const inCycle = (store.cycles ?? []).find((entry) => entry.id === issue.cycleId);
      // A cycle belongs to one project; moving the issue out of it leaves the cycle.
      if (cycle === undefined && inCycle !== undefined && inCycle.projectId !== issue.projectId)
        moveCycle(store, issue, undefined, context, now);
      if (cycle !== undefined) setIssueCycle(store, issue, cycle, context, now);
      return cycle === undefined && inCycle?.projectId === issue.projectId
        ? saved
        : issueView(store, issue, true);
    }
    case "save_evidence_bundle":
      return saveBundle(store, args, context, now, options);
    case "get_evidence_bundle": {
      const issue = findIssue(store, args.issueId as string);
      return currentBundle(store, issue.id, (args.runId as string | undefined) ?? null) ?? null;
    }
    case "post_bundle_check": {
      const bundle = (store.bundles ?? []).find((entry) => entry.id === args.bundleId);
      if (!bundle) throw new Error("Bundle not found");
      options.assertIssueWrite?.(issueView(store, findIssue(store, bundle.issueId)));
      checkBundle(store, bundle, context, now, args.body as string | undefined);
      return bundle;
    }
    case "post_issue_ask":
      return postAsk(store, args, context, now, options);
    case "post_run_control":
      return controlRun(store, args, context, now, options);
    case "save_run":
      return saveRun(store, args, context, now, options);
    case "save_lease":
      return saveLease(store, args, context, now, options);
    case "list_runs": {
      const issue = args.issueId === undefined ? undefined : findIssue(store, args.issueId as string);
      const runs = (store.runs ?? [])
        .filter(
          (run) =>
            (issue === undefined || run.issueId === issue.id) &&
            (args.status === undefined || run.status === args.status),
        )
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.number - a.number);
      return page(
        runs.map((run) => runView(store, run, now, options)),
        args,
        "runs",
        name,
      );
    }
    case "list_ready_issues": {
      const project = args.project === undefined ? undefined : findProject(store, args.project as string);
      return page(
        readyIssues(store, project, now).map((issue) => ({
          ...issueView(store, issue),
          inCurrentCycle: inCurrentCycle(store, issue, now),
        })),
        args,
        "issues",
        name,
      );
    }
    case "list_drift": {
      const project = args.project === undefined ? undefined : findProject(store, args.project as string);
      return drift(store, project, (args.idleDays as number | undefined) ?? DEFAULT_IDLE_DAYS, now);
    }
    case "list_cycles": {
      if (args.teamId !== undefined) findTeam(store, args.teamId as string);
      const project = args.project === undefined ? undefined : findProject(store, args.project as string);
      if (store.linearMirror) {
        const cycles = (store.cycles ?? []).filter(
          (cycle) =>
            (project === undefined ||
              store.issues.some((issue) => issue.projectId === project.id && issue.cycleId === cycle.id)) &&
            (args.type === undefined ||
              (args.type === "current"
                ? cycle.startsAt <= now && cycle.endsAt > now
                : args.type === "previous"
                  ? cycle.endsAt <= now
                  : cycle.startsAt > now)),
        );
        return {
          cycles: cycles.map((cycle) => ({
            ...cycle,
            issues: store.issues
              .filter((issue) => issue.cycleId === cycle.id)
              .map((issue) => issue.identifier),
          })),
          hasNextPage: false,
        };
      }
      const projects = project === undefined ? store.projects : [project];
      const cycles = projects.flatMap((entry) => {
        if (args.type === undefined) return projectCycles(store, entry.id);
        try {
          return [findCycle(store, args.type as string, entry, now, false)];
        } catch {
          return [];
        }
      });
      return { cycles: cycles.map((cycle) => cycleView(store, cycle, now)), hasNextPage: false };
    }
    case "get_cycle": {
      const project = args.project === undefined ? undefined : findProject(store, args.project as string);
      return cycleView(store, findCycle(store, args.id as string, project, now, false), now);
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
      const cycle =
        args.cycle === undefined
          ? undefined
          : findCycle(
              store,
              args.cycle as string,
              args.project === undefined ? undefined : findProject(store, args.project as string),
              now,
              false,
            ).id;
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
          (cycle === undefined || entry.cycleId === cycle) &&
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
        [store.user, ...(store.actors ?? [])]
          .filter((user) => norm(user.name).includes(norm(text(args, "query") ?? "")))
          .map((user) => ({ ...user })),
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
      return page(
        (store.milestones ?? []).filter(
          (entry) => linearId(entry.project) === findProject(store, args.project as string).id,
        ),
        args,
        "milestones",
        name,
      );
    case "get_milestone": {
      const record = store.milestones?.find((entry) => entry.id === args.id);
      if (!record) throw new Error(`Milestone not found: ${String(args.id)}`);
      return record;
    }
    case "get_document": {
      const record = store.documents?.find((entry) => entry.id === args.id || entry.slugId === args.id);
      if (!record) throw new Error(`Document not found: ${String(args.id)}`);
      return {
        ...record,
        comments: store.comments
          .filter((comment) => comment.documentId === record.id)
          .map((comment) => commentView(store, comment)),
      };
    }
    case "list_documents":
      return page(
        (store.documents ?? []).filter(
          (entry) =>
            (args.project === undefined || entry.projectId === findProject(store, String(args.project)).id) &&
            (args.issueId === undefined || entry.issueId === findIssue(store, String(args.issueId)).id) &&
            String(entry.title)
              .toLowerCase()
              .includes(norm(text(args, "query") ?? "")),
        ),
        args,
        "documents",
        name,
      );
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

/** Shared by backend instances pointing at the same journal; publication follows rename. */
const syncListeners = new Map<string, Set<() => void>>();

/** Stable normalized objects: the app owns projections, the server owns fields and references. */
function syncModels(store: Store): TrackerSyncModel[] {
  const models: TrackerSyncModel[] = [];
  const projectOfIssue = (id: string | null | undefined): string[] => {
    const project = store.issues.find((issue) => issue.id === id)?.projectId;
    // Unprojected items have an explicit group; empty is reserved for shared metadata.
    return [project ?? "unprojected"];
  };
  const add = (
    modelName: TrackerSyncModel["modelName"],
    entries: readonly object[],
    groups: (data: Record<string, unknown>) => string[],
  ) => {
    for (const entry of entries) {
      const data = structuredClone(entry) as Record<string, unknown>;
      models.push({ modelName, modelId: data.id as string, projectIds: groups(data), data });
    }
  };
  add(
    "issue",
    store.issues.map((issue) => ({
      ...issue,
      ownerAsks: (store.ownerAsks ?? []).filter((ref) => ref.issueId === issue.id),
    })),
    (data) => [(data.projectId as string) ?? "unprojected"],
  );
  add("project", store.projects, (data) => [data.id as string, "workspace"]);
  add("milestone", store.milestones ?? [], (data) => [data.projectId as string, "workspace"]);
  add("document", store.documents ?? [], (data) => [
    ...(data.projectId ? [data.projectId as string] : projectOfIssue(data.issueId as string)),
    "workspace",
  ]);
  add("comment", store.comments, (data) =>
    data.projectId
      ? [data.projectId as string]
      : data.statusUpdateId
        ? [store.statusUpdates.find((update) => update.id === data.statusUpdateId)!.projectId]
        : data.documentId
          ? (() => {
              const document = store.documents?.find((entry) => entry.id === data.documentId);
              return document?.projectId
                ? [document.projectId as string]
                : projectOfIssue(document?.issueId as string | undefined);
            })()
          : projectOfIssue(data.issueId as string),
  );
  add("cycle", store.cycles ?? [], (data) =>
    data.projectId ? [data.projectId as string, "workspace"] : ["workspace"],
  );
  add("status_update", store.statusUpdates, (data) => [data.projectId as string, "workspace"]);
  for (const [modelName, entries] of [
    ["run", store.runs ?? []],
    ["bundle", store.bundles ?? []],
    ["event", store.events ?? []],
  ] as const)
    add(modelName, entries, (data) => projectOfIssue(data.issueId as string));
  add(
    "lease",
    store.issues
      .filter((issue) => issue.lease)
      .map((issue) => ({ id: issue.id, issueId: issue.id, ...issue.lease })),
    (data) => projectOfIssue(data.issueId as string),
  );
  add("release", store.releases ?? [], (data) => {
    const groups = (data.items as Release["items"]).flatMap((item) => projectOfIssue(item.issueId));
    return [...new Set([...(groups.length ? groups : ["unprojected"]), "workspace"])];
  });
  add("label", store.labels, () => []);
  add("issue_status", store.issueStatuses, () => []);
  add("project_status", store.projectStatuses, () => []);
  add("team", [store.team], () => []);
  add("user", [store.user, ...(store.actors ?? [])], () => []);
  return models;
}
const syncModelKey = (model: Pick<TrackerSyncModel, "modelName" | "modelId">) =>
  `${model.modelName}:${model.modelId}`;
const inSyncGroups = (groups: readonly string[], wanted: readonly string[]) =>
  groups.length === 0 || groups.some((id) => wanted.includes(id));
function lazySyncModel(model: TrackerSyncModel): TrackerSyncModel {
  const data = { ...model.data };
  const omitted =
    model.modelName === "comment"
      ? ["body", "quotedText"]
      : model.modelName === "run"
        ? ["summary", "worktree", "branch"]
        : model.modelName === "event"
          ? ["body"]
          : [];
  for (const field of omitted) delete data[field];
  if (omitted.length) data.unhydratedFields = omitted;
  return { ...model, data };
}
function appendSync(
  before: Store,
  store: Store,
  actor: TrackerActor,
  tool: string,
  at: string,
  key?: string,
): void {
  const prior = new Map(syncModels(before).map((model) => [syncModelKey(model), model]));
  const deltas: TrackerSyncCommit["deltas"] = [];
  for (const model of syncModels(store)) {
    const previous = prior.get(syncModelKey(model));
    prior.delete(syncModelKey(model));
    if (previous && canonical(previous) === canonical(model)) continue;
    const data =
      previous && canonical(previous.projectIds) === canonical(model.projectIds)
        ? Object.fromEntries(
            Object.entries(model.data).filter(
              ([field, value]) => canonical(value) !== canonical(previous.data[field]),
            ),
          )
        : model.data;
    deltas.push({
      ...model,
      data,
      action: previous ? "update" : "insert",
      previousProjectIds: previous?.projectIds ?? [],
      removedFields: previous ? Object.keys(previous.data).filter((field) => !(field in model.data)) : [],
    });
  }
  for (const model of prior.values())
    deltas.push({
      ...model,
      action: "delete",
      data: {},
      previousProjectIds: model.projectIds,
      removedFields: [],
    });
  const body = {
    syncId: (store.syncId ?? 0) + 1,
    actor: { ...actor },
    tool,
    at,
    ...(key === undefined ? {} : { idempotencyKey: key }),
    deltas,
    prevHash: store.syncLog?.at(-1)?.hash ?? "",
  };
  store.syncId = body.syncId;
  (store.syncLog ??= []).push({ ...body, hash: auditHash(body) });
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
  /** One applied or refused write: effect, receipt, audit and events in one atomic replacement. */
  const write = async (
    initial: Store,
    clock: string,
    name: string,
    request: Record<string, unknown>,
    keyed: { key: string; fingerprint: string } | undefined,
    actor: TrackerActor,
    callOptions: TrackerToolCallOptions | undefined,
    assertHeld: () => void,
    apply: (store: Store, now: string, context: WriteContext) => unknown,
  ): Promise<unknown> => {
    let store = initial;
    const key = keyed?.key;
    const fingerprint = keyed?.fingerprint ?? "";
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
      result = await apply(store, now, context);
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
      appendSync(before, store, actor, name, now, key);
      await persist(path, store, assertHeld);
      for (const listener of syncListeners.get(path) ?? []) listener();
      throw refusal;
    }
    const entities = stampActor(store, actor, now);
    // Views were built before stamping; the receipt keeps exactly what the caller sees.
    const views =
      name === "sync_transaction"
        ? (result as { results: Record<string, unknown>[] }).results
        : [result as Record<string, unknown>];
    for (const view of views) {
      if (typeof view.updatedAt === "string" && view.updatedAt >= now) {
        view.updatedByActor = actor;
        if (typeof view.createdAt === "string" && view.createdAt >= now) view.createdByActor = actor;
      }
      const derived = store.issues.find((issue) => issue.id === view.id);
      if (derived !== undefined) {
        view.stage = stageOf(derived);
        view.state = view.status = store.issueStatuses.find((status) => status.id === derived.statusId)!.name;
      }
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
    appendSync(before, store, actor, name, now, key);
    await persist(path, store, assertHeld, callOptions);
    for (const listener of syncListeners.get(path) ?? []) listener();
    publish(store.events?.slice(firstEvent - 1) ?? []);
    return settled;
  };
  const load = async () => {
    const clock = (options.clock ?? (() => new Date()))().toISOString();
    try {
      return { store: parseStore(await readFile(path, "utf8")), clock, initialized: false };
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
      return { store: seed(options, clock), clock, initialized: true };
    }
  };
  return {
    catalog: () => TRACKER_TOOLS,
    async sync(input, callOptions, signal) {
      const command = TrackerSyncCommandSchema.parse(input);
      signal?.throwIfAborted();
      const roll = async (store: Store, clock: string, assertHeld: () => void) => {
        if (cyclesDue(store, clock))
          await write(
            store,
            clock,
            "rollover_cycles",
            {},
            undefined,
            { ...TRACKER_LEAD, onBehalfOf: [] },
            { via: ROLLOVER },
            assertHeld,
            (target, now, context) => rolloverCycles(target, clock, context, now),
          );
      };
      if (command.action === "transaction") {
        // Validate every operation before dispatch; one receipt owns the whole transaction.
        for (const operation of command.operations) {
          validateTrackerToolArgs(operation.name, operation.arguments);
          if (
            !/^(?:save|create|post)_/u.test(operation.name) ||
            operation.arguments.idempotencyKey !== undefined
          )
            throw new Error("Transactions contain write tools without nested idempotency keys");
        }
        return withTrackerStoreLock(path, async (assertHeld) => {
          const { store, clock } = await load();
          await roll(store, clock, assertHeld);
          const actor = callOptions?.actor ?? localActor(store);
          const key = command.idempotencyKey;
          const fingerprint = createHash("sha256")
            .update(
              canonical([
                "sync_transaction",
                command.operations,
                // Unfenced transactions keep their original fingerprint.
                ...(command.expectedStoreId === undefined ? [] : [command.expectedStoreId]),
              ]),
            )
            .digest("hex");
          const prior = store.receipts?.find(
            (entry) => entry.actorKey === actorKey(actor) && entry.idempotencyKey === key,
          );
          if (prior) {
            if (prior.fingerprint !== fingerprint)
              throw new TrackerWriteRefused(
                "idempotency_conflict",
                "Key already used for a different transaction",
              );
            await callOptions?.beforeWrite?.();
            assertHeld();
            if (prior.state === "refused") throw new TrackerWriteRefused(prior.reason!, prior.detail!);
            return { outcome: "applied" as const, result: structuredClone(prior.result) };
          }
          const result = await write(
            store,
            clock,
            "sync_transaction",
            {
              operations: command.operations,
              ...(command.expectedStoreId === undefined ? {} : { expectedStoreId: command.expectedStoreId }),
            },
            { key, fingerprint },
            actor,
            callOptions,
            assertHeld,
            async (target, now, context) => {
              // Checked under the journal lock, so a swap after the client's own check cannot slip a write through.
              const storeId = target.storeId ?? target.team.id;
              if (command.expectedStoreId !== undefined && command.expectedStoreId !== storeId)
                throw new TrackerWriteRefused(
                  "store_replaced",
                  `transaction expected store ${command.expectedStoreId}; the tracker store is now ${storeId}`,
                );
              const results = [];
              for (const [index, operation] of command.operations.entries()) {
                // Distinct operation versions also preserve temporal independent-check fences.
                const operationNow = index === 0 ? now : nextWriteTime(target, now);
                const beforeOperation = structuredClone(target);
                const result = await dispatch(
                  target,
                  operation.name,
                  operation.arguments,
                  options,
                  operationNow,
                  context,
                );
                // Preserve every tool's stage, completion and evidence fences, including intermediate effects.
                recordIssueChanges(beforeOperation, target, operation.name, context, operationNow);
                results.push(result);
              }
              return { results };
            },
          );
          return { outcome: "applied" as const, result };
        });
      }
      let wake: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const awakened = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const listeners = syncListeners.get(path) ?? new Set<() => void>();
      syncListeners.set(path, listeners);
      const listener = () => wake?.();
      listeners.add(listener);
      try {
        const readSync = () =>
          withTrackerStoreLock(path, async (assertHeld): Promise<TrackerSyncResult> => {
            signal?.throwIfAborted();
            const { store, clock, initialized } = await load();
            await roll(store, clock, assertHeld);
            if (initialized) await persist(path, store, assertHeld);
            const storeId = store.storeId ?? store.team.id;
            const lastSyncId = store.syncId ?? 0;
            const wildcard =
              command.action === "bootstrap" && command.type === "full" && command.projects.includes("*");
            const requested = wildcard
              ? [...store.projects.map((project) => project.id), "unprojected", "workspace"]
              : command.projects;
            const groupIds = [
              ...new Set(
                requested.map((id) => {
                  if (id === "unprojected" || id === "workspace") return id;
                  if (!store.projects.some((project) => project.id === id))
                    throw new Error(`Sync project UUID not found: ${id}`);
                  return id;
                }),
              ),
            ];
            // Discovery remains live even when clients only name their current project groups.
            if (command.action === "subscribe" && !groupIds.includes("workspace")) groupIds.push("workspace");
            if (command.action === "bootstrap" || command.action === "batch") {
              let models = syncModels(store).filter((model) => inSyncGroups(model.projectIds, groupIds));
              if (command.action === "batch") {
                const wanted = new Set(command.models.map(syncModelKey));
                models = models.filter((model) => wanted.has(syncModelKey(model)));
                return { outcome: "batch", storeId, lastSyncId, models };
              }
              if (command.lazy) models = models.map(lazySyncModel);
              const metadata = {
                kind: "metadata",
                schemaVersion: 1,
                type: command.type,
                storeId,
                lastSyncId,
                syncGroups: groupIds,
                modelCount: models.length,
              };
              return {
                outcome: "bootstrap",
                ndjson: [...models, metadata].map((line) => JSON.stringify(line)).join("\n") + "\n",
              };
            }
            if (command.storeId !== storeId || command.lastSyncId > lastSyncId)
              return {
                outcome: "rebootstrap",
                storeId,
                lastSyncId,
                projects: groupIds,
                reason: command.storeId !== storeId ? "store_changed" : "cursor_gap",
              };
            const available = (store.syncLog ?? []).filter((commit) => commit.syncId > command.lastSyncId);
            const commits = available
              .slice(0, command.limit)
              .map(({ prevHash: _prev, hash: _hash, ...commit }) => ({
                ...commit,
                // Older retained commits predate workspace routing; project metadata is
                // projected into the new group without rewriting the hash-linked journal.
                deltas: commit.deltas
                  .map((delta) =>
                    ["project", "milestone", "document", "status_update", "cycle", "release"].includes(
                      delta.modelName,
                    )
                      ? {
                          ...delta,
                          projectIds: [...new Set([...delta.projectIds, "workspace"])],
                          previousProjectIds: delta.previousProjectIds.length
                            ? [...new Set([...delta.previousProjectIds, "workspace"])]
                            : [],
                        }
                      : delta,
                  )
                  .filter(
                    (delta) =>
                      inSyncGroups(delta.projectIds, groupIds) ||
                      (delta.previousProjectIds.length > 0 &&
                        inSyncGroups(delta.previousProjectIds, groupIds)),
                  ),
              }));
            // Register under the same lock as the replay snapshot, closing the bootstrap/live race.
            listeners.add(listener);
            return {
              outcome: "deltas",
              storeId,
              lastSyncId: commits.at(-1)?.syncId ?? command.lastSyncId,
              commits,
              hasMore: available.length > commits.length,
            };
          });
        const first = await readSync();
        if (
          command.action !== "subscribe" ||
          first.outcome !== "deltas" ||
          first.commits.length ||
          !command.waitMs
        )
          return first;
        timer = setTimeout(listener, command.waitMs);
        signal?.addEventListener("abort", listener, { once: true });
        if (signal?.aborted) listener();
        await awakened;
        return await readSync();
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", listener);
        listeners.delete(listener);
        if (!listeners.size) syncListeners.delete(path);
      }
    },
    async importLinear(snapshot, actorMap, callOptions) {
      return withTrackerStoreLock(path, async (assertHeld) => {
        const { store, clock } = await load();
        const before = structuredClone(store);
        if (store.linearMirror && store.linearMirror.workspaceId !== snapshot.workspaceId)
          throw new Error("Scratch store belongs to another Linear workspace");
        if (store.linearMirror && store.team.id !== snapshot.team.id)
          throw new Error("Scratch store has another Linear team; no team mapping was selected");
        if (!store.linearMirror && store.issues.length > 0)
          throw new Error("Import requires an empty scratch store or its existing mirror");
        const report: LinearImportReport = {
          workspaceId: snapshot.workspaceId,
          counts: {},
          created: 0,
          updated: 0,
          unchanged: 0,
          skipped: [],
          samples: snapshot.issues.slice(0, 5).map((i) => String(i.identifier)),
          // Imported projects keep their Linear UUID as the built-in project UUID.
          projects: snapshot.projects.map((project) => ({
            linearProjectId: project.id,
            trackerProjectId: project.id,
            name: String(project.name),
          })),
        };
        report.counts.archivedIssues = snapshot.issues.filter((issue) => issue.archivedAt != null).length;
        report.counts.stateHistory = snapshot.issues.reduce(
          (count, issue) => count + ((issue.stateHistory ?? []) as unknown[]).length,
          0,
        );
        report.counts.attachments = snapshot.issues.reduce(
          (count, issue) => count + ((issue.attachments ?? []) as unknown[]).length,
          0,
        );
        const records: Record<string, LinearRecord[]> = {};
        for (const [key, value] of Object.entries(snapshot)) {
          if (!Array.isArray(value)) continue;
          records[key] = value as LinearRecord[];
          report.counts[key] = value.length;
          for (const record of value as LinearRecord[]) {
            const prior = store.linearMirror?.records[key]?.find((r) => r.id === record.id);
            if (!prior) report.created++;
            else if (canonical(prior) === canonical(record)) report.unchanged++;
            else report.updated++;
          }
        }
        const actorMappingsChanged = snapshot.actors.some(
          (record) =>
            actorMap[record.id] !== undefined &&
            canonical(store.actors?.find((actor) => actor.id === record.id)?.actor) !==
              canonical(actorMap[record.id]),
        );
        if (report.created + report.updated === 0 && !actorMappingsChanged) return report;
        const actor = callOptions?.actor ?? { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
        const sourceActor = (record: LinearRecord): TrackerActor => {
          const id = linearId(record.botActor ?? record.actor ?? record.creator ?? record.user);
          return (id && actorMap[id]) || actor;
        };
        const entity = (record: LinearRecord) => ({
          ...record,
          createdAt: String(record.createdAt ?? clock),
          updatedAt: String(record.updatedAt ?? record.createdAt ?? clock),
          createdByActor: sourceActor(record),
          updatedByActor: sourceActor(record),
        });
        const id = (record: LinearRecord, key: string) => linearId(record[key]);
        const upsert = <T extends { id: string }>(target: T[], incoming: T[]) => {
          for (const record of incoming) {
            const index = target.findIndex((r) => r.id === record.id);
            if (index < 0) target.push(record);
            else target[index] = record;
          }
        };
        store.storeId ??= store.team.id;
        store.team = snapshot.team as unknown as Team;
        upsert(
          (store.actors ??= []),
          snapshot.actors.map((record) => ({
            id: record.id,
            name: String(record.name),
            displayName: String(record.displayName ?? record.name),
            isLocal: true as const,
            actor: actorMap[record.id] ?? {
              type: "app",
              id: `linear:${record.id}`,
              name: String(record.name),
              onBehalfOf: [],
            },
          })),
        );
        const statuses = new Map<string, Status>();
        for (const issue of snapshot.issues) {
          const state = linearRow(issue.state) as unknown as Status;
          statuses.set(state.id, state);
          for (const span of (issue.stateHistory ?? []) as LinearRecord[]) {
            const status = linearRow(span.state) as unknown as Status;
            statuses.set(status.id, status);
          }
        }
        upsert(store.issueStatuses, [...statuses.values()]);
        for (const project of snapshot.projects)
          upsert(store.projectStatuses, [linearRow(project.status) as unknown as Status]);
        upsert(
          store.labels,
          snapshot.labels.map((record) => ({
            ...entity(record),
            name: String(record.name),
            description: String(record.description ?? ""),
            color: String(record.color ?? ""),
            teamId: id(record, "team"),
            isGroup: record.isGroup === true,
            parentId: id(record, "parent"),
          })),
        );
        upsert(
          store.projects,
          snapshot.projects.map((record) => ({
            ...entity(record),
            identifier: String(record.identifier ?? record.id),
            slug: String(record.slugId ?? record.id),
            name: String(record.name),
            summary: String(record.description ?? ""),
            description: String(record.content ?? record.description ?? ""),
            statusId: id(record, "status")!,
            priority: Number(record.priority ?? 0),
            teamIds: [snapshot.team.id],
            leadTeamId: snapshot.team.id,
            leadId: id(record, "lead"),
            labels: [],
            startDate: record.startDate as string | null,
            targetDate: record.targetDate as string | null,
            links: [],
          })),
        );
        upsert(
          (store.milestones ??= []),
          snapshot.milestones.map((record) => ({ ...entity(record), projectId: id(record, "project")! })),
        );
        upsert(
          (store.documents ??= []),
          snapshot.documents.map((record) => ({
            ...entity(record),
            projectId: id(record, "project"),
            issueId: id(record, "issue"),
          })),
        );
        upsert(
          store.statusUpdates,
          snapshot.statusUpdates.map((record) => ({
            ...entity(record),
            type: "project" as const,
            projectId: id(record, "project")!,
            body: String(record.body ?? ""),
            health: String(record.health),
            userId: id(record, "user") ?? store.user.id,
          })),
        );
        // Linear cycles belong to a team. Preserve them once, never invent a project or roll them over.
        upsert(
          (store.cycles ??= []),
          snapshot.cycles.map((record) => ({
            ...record,
            projectId: "",
            number: Number(record.number),
            startsAt: String(record.startsAt),
            endsAt: String(record.endsAt),
            createdAt: String(record.createdAt),
          })),
        );
        upsert(
          store.comments,
          snapshot.comments.map((record) => ({
            ...entity(record),
            body: String(record.body ?? ""),
            parentId: (record.parentId as string | null) ?? null,
            issueId: (record.issueId as string | null) ?? null,
            projectId: (record.projectId as string | null) ?? null,
            statusUpdateId: (record.statusUpdateId as string | null) ?? null,
            userId: id(record, "user") ?? store.user.id,
            quotedText: (record.quotedText as string | null) ?? null,
          })),
        );
        upsert(
          store.issues,
          snapshot.issues.map((record) => {
            const relations = snapshot.relations;
            const forward = (type: string) =>
              relations
                .filter((r) => r.type === type && id(r, "issue") === record.id)
                .map((r) => id(r, "relatedIssue")!);
            const backward = (type: string) =>
              relations
                .filter((r) => r.type === type && id(r, "relatedIssue") === record.id)
                .map((r) => id(r, "issue")!);
            return {
              ...entity(record),
              identifier: String(record.identifier),
              title: String(record.title),
              description: String(record.description ?? ""),
              teamId: snapshot.team.id,
              projectId: id(record, "project"),
              milestoneId: id(record, "projectMilestone"),
              statusId: id(record, "state")!,
              priority: Number(record.priority),
              labels: (record.labels as LinearRecord[]).map((label) => String(label.name)),
              assigneeId: id(record, "assignee"),
              creatorId: id(record, "creator") ?? store.user.id,
              parentId: id(record, "parent"),
              blocks: forward("blocks"),
              blockedBy: backward("blocks"),
              relatedTo: [...new Set([...forward("related"), ...backward("related")])],
              duplicateOf: forward("duplicate")[0] ?? null,
              dueDate: record.dueDate as string | null,
              estimate: record.estimate as number | null,
              links: ((record.attachments ?? []) as LinearRecord[]).map((a) => ({
                title: String(a.title),
                url: String(a.url),
              })),
              cycleId: id(record, "cycle"),
            };
          }),
        );
        // Historical records stay historical: no invented owner verification, asks or lease effects.
        for (const [kind, incoming] of Object.entries(records))
          for (const record of incoming) {
            const prior = store.linearMirror?.records[kind]?.find((r) => r.id === record.id);
            if (prior && canonical(prior) === canonical(record)) continue;
            (store.recordEvents ??= []).push({
              type: kind,
              id: record.id,
              at: clock,
              actor: sourceActor(record),
              via: "linear_import",
            });
            if (kind === "issues") {
              const issue = findIssue(store, record.id);
              if (!prior)
                appendEvent(
                  store,
                  { actor: sourceActor(record), via: "linear_import" },
                  String(record.createdAt),
                  issue,
                  { type: "created" },
                );
              const oldSpans = (prior?.stateHistory ?? []) as LinearRecord[];
              const stateChanges = ((record.history ?? []) as LinearRecord[]).filter((history) =>
                linearId(history.toState),
              );
              for (const span of stateChanges.length ? [] : ((record.stateHistory ?? []) as LinearRecord[]))
                if (!oldSpans.some((s) => s.id === span.id))
                  appendEvent(
                    store,
                    { actor: sourceActor(record), via: "linear_import" },
                    String(span.startedAt),
                    issue,
                    { type: "state", to: String(linearRow(span.state).name) },
                  );
              for (const history of stateChanges)
                if (
                  linearId(history.toState) &&
                  !((prior?.history ?? []) as LinearRecord[]).some((h) => h.id === history.id)
                )
                  appendEvent(
                    store,
                    { actor: sourceActor(history), via: "linear_import" },
                    String(history.createdAt),
                    issue,
                    {
                      type: "state",
                      from: String(linearRow(history.fromState).name ?? ""),
                      to: String(linearRow(history.toState).name),
                      body: `Linear history ${history.id}`,
                    },
                  );
            }
            if (kind === "comments" && typeof record.issueId === "string")
              appendEvent(
                store,
                { actor: sourceActor(record), via: "linear_import" },
                String(record.createdAt),
                findIssue(store, record.issueId),
                { type: "comment", body: String(record.body), commentId: record.id },
              );
          }
        const merged = { ...store.linearMirror?.records };
        for (const [kind, incoming] of Object.entries(records))
          merged[kind] = [
            ...new Map([...(merged[kind] ?? []), ...incoming].map((record) => [record.id, record])).values(),
          ];
        store.linearMirror = { workspaceId: snapshot.workspaceId, records: merged };
        appendAudit(store, {
          at: clock,
          tool: "import_linear",
          outcome: "applied",
          actor,
          fields: Object.keys(records),
          entities: Object.entries(records).flatMap(([type, entries]) =>
            entries.map((record) => ({
              type,
              id: record.id,
              ...(typeof record.identifier === "string" ? { identifier: record.identifier } : {}),
            })),
          ),
        });
        parseStore(JSON.stringify(store));
        appendSync(before, store, actor, "import_linear", clock);
        await persist(path, store, assertHeld, callOptions);
        for (const listener of syncListeners.get(path) ?? []) listener();
        return report;
      });
    },
    async linkOwnerAsk(eventId, requestId) {
      await withTrackerStoreLock(path, async (assertHeld) => {
        const { store, clock } = await load();
        const prior = (store.ownerAsks ?? []).find((ref) => ref.eventId === eventId);
        if (prior?.requestId === requestId) return;
        if (prior) throw new Error("Ask event already linked to a different mailbox record");
        await write(
          store,
          clock,
          "link_owner_ask",
          { eventId, requestId },
          undefined,
          { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] },
          { via: "owner_ask" },
          assertHeld,
          (target, now, context) => {
            const event = target.events?.find((entry) => entry.id === eventId);
            if (!event) throw new Error("Ask source event not found");
            const issue = findIssue(target, event.issueId);
            (target.ownerAsks ??= []).push({
              eventId,
              requestId,
              issueId: issue.id,
              ...(event.runId === undefined ? {} : { runId: event.runId }),
            });
            appendEvent(target, context, now, issue, {
              type: "ask",
              requestId,
              ...(event.runId === undefined ? {} : { runId: event.runId }),
              body: "ADR 0245 ask linked.",
            });
            issue.updatedAt = now;
            return issueView(target, issue);
          },
        );
      });
    },
    async resolveOwnerAsk(eventId, requestId, approved, body) {
      await withTrackerStoreLock(path, async (assertHeld) => {
        const { store, clock } = await load();
        // Public idempotency keys cannot shadow a host resolution. The committed,
        // host-stamped resolution event is its receipt in the same atomic journal.
        if (
          store.events?.some(
            (event) =>
              event.requestId === requestId &&
              event.via === "owner_ask" &&
              (event.type === "gate" || event.type === "result"),
          )
        )
          return;
        await write(
          store,
          clock,
          "resolve_owner_ask",
          { eventId, requestId, approved },
          undefined,
          { ...TRACKER_OWNER, onBehalfOf: [] },
          { via: "owner_ask" },
          assertHeld,
          (target, now, context) => {
            if (!target.ownerAsks?.some((ref) => ref.eventId === eventId && ref.requestId === requestId))
              throw new Error("Ask is not linked to this event");
            const event = target.events!.find((entry) => entry.id === eventId)!;
            const issue = findIssue(target, event.issueId);
            if (event.purpose === "gate") {
              const run = target.runs?.find((entry) => entry.id === event.runId);
              if (!run) throw new Error("Gate run not found");
              if (approved) run.pendingGates = (run.pendingGates ?? []).filter((id) => id !== eventId);
              appendEvent(target, context, now, issue, {
                type: "gate",
                requestId,
                runId: run.id,
                from: "pending",
                to: approved ? "approved" : "refused",
                body,
                gate: event.gate!,
              });
            } else if (event.to === "landed" || event.type === "stage" || event.type === "reopened") {
              appendEvent(target, context, now, issue, { type: "result", requestId, body });
              moveStage(target, issue, approved ? "owner-verified" : "accepted", context, now, body);
            } else appendEvent(target, context, now, issue, { type: "result", requestId, body });
            issue.updatedAt = now;
            return issueView(target, issue);
          },
        );
      });
    },
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
    async syncReleases(history, callOptions) {
      return withTrackerStoreLock(path, async (assertHeld) => {
        const { store, clock } = await load();
        const actor = callOptions?.actor ?? localActor(store);
        // Audit names the sync's scope, not its derived contents.
        const request = { repository: history.repository, lane: history.lane };
        return (await write(
          store,
          clock,
          "sync_releases",
          request,
          undefined,
          actor,
          callOptions,
          assertHeld,
          (target, now, context) => syncReleases(target, history, context, now),
        )) as ReleaseSyncResult;
      });
    },
    async call(name, args, callOptions) {
      validateTrackerToolArgs(name, args);
      return withTrackerStoreLock(path, async (assertHeld) => {
        const { store, clock, initialized } = await load();
        // Cycles roll over on the first access after one ends, as Clankie's own write.
        if (cyclesDue(store, clock))
          await write(
            store,
            clock,
            "rollover_cycles",
            {},
            undefined,
            { ...TRACKER_LEAD, onBehalfOf: [] },
            { via: ROLLOVER },
            assertHeld,
            (target, now, context) => rolloverCycles(target, clock, context, now),
          );
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
        return write(
          store,
          clock,
          name,
          request,
          key === undefined ? undefined : { key, fingerprint },
          actor,
          callOptions,
          assertHeld,
          (target, now, context) => dispatch(target, name, request, options, now, context),
        );
      });
    },
  };
}
