import {
  captureGuidedReview,
  validateGuidedReviewContent,
  type CreateGuidedReviewInput,
  type GuidedReviewIdentity,
  type GuidedReviewMutationReceipt,
  type GuidedReviewSource,
  type GuidedReviewCapture,
  type GuidedReviewFindingInput,
  type GuidedReviewStep,
  type GuidedFindingAction,
} from "./guided-review.ts";
import type { AutoWorkQueue } from "@clankie/protocol/auto-rounds";
import {
  WorkInboxTargetSchema,
  WorkInboxListSchema,
  WorkInboxGetSchema,
  WorkInboxSnoozeSchema,
  WorkInboxUnsnoozeSchema,
  type WorkInboxTarget,
  type WorkInboxPendingQuestion,
} from "@clankie/protocol/work-items";
import {
  TrackerSyncCommandSchema,
  TrackerSyncResultSchema,
  type TrackerSyncCommand,
  type TrackerSyncModel,
  type TrackerSyncCommit,
  type TrackerSyncResult,
} from "@clankie/protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { copyFile, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compareVersions, type ReleaseHistory } from "./releases.ts";
import {
  appendJournal,
  CHECKPOINT_MIN_BYTES,
  JOURNAL_DIRECTORY,
  JOURNAL_THRESHOLD_BYTES,
  type JournalHeader,
  type JournalRecord,
  journalVersion,
  readJournalCommits,
  readJournalRecord,
  journalRecords,
  readJournalTail,
  RECEIPT_RESULT_BYTES,
  replayJournal,
  sealSegment,
  setJournalAside,
  startSegment,
  storeChanges,
  writeCheckpointFile,
  writeSegment,
} from "./tracker-journal.ts";
import { withTrackerStoreLock } from "./tracker-store-lock.ts";
import {
  linearId,
  linearRow,
  type LinearImportSnapshot,
  type LinearImportReport,
  type LinearRecord,
} from "./linear-import.ts";
import type { LinearMirrorRemoval, LinearMirrorView } from "./linear-mirror.ts";
import {
  summarizeOutcomes,
  outcomeMedia,
  type OutcomeHistory,
  type OutcomeIssue,
  type OutcomeStateSpan,
  type OutcomeWindow,
  type TrackerOutcomes,
} from "./outcomes.ts";
import {
  applyTrackerDescriptionPatch,
  DELIVERY_STAGES,
  TRACKER_LEAD,
  TRACKER_OWNER,
  TRACKER_TOOLS,
  SAVED_ISSUE_VIEW_TOOLS,
  INBOX_TOOLS,
  GUIDED_REVIEW_TOOLS,
  validateTrackerToolArgs,
  type DeliveryStage,
  type IssueEventType,
  type TrackerActor,
  type TrackerItemEvent,
  type TrackerReadSnapshot,
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

/** Source and anchors are immutable after creation; only discussion state changes. */
export interface GuidedReviewRecord extends Entity {
  schemaVersion: 1;
  storeId: string;
  issueId: string;
  projectId: string | null;
  runId?: string;
  identity: GuidedReviewIdentity;
  inspection: GuidedReviewCapture["inspection"];
  snapshotSha256: string;
  walkthrough: GuidedReviewStep[];
  findings: (GuidedReviewFindingInput & {
    id: string;
    resolved: boolean;
    replies: { id: string; body: string; actor: TrackerActor; at: string }[];
    history: ({ id: string; actor: TrackerActor; at: string } & GuidedFindingAction)[];
  })[];
}

/** Explicit retirement preserves bindings and identity while reclaiming active payload bytes. */
export type GuidedReviewTombstone = Pick<
  GuidedReviewRecord,
  | "id"
  | "schemaVersion"
  | "storeId"
  | "issueId"
  | "projectId"
  | "runId"
  | "identity"
  | "snapshotSha256"
  | "createdAt"
  | "updatedAt"
  | "createdByActor"
  | "updatedByActor"
> & { retiredAt: string; retiredByActor: TrackerActor; retirementEventId: string };

type StoredGuidedReview = GuidedReviewRecord | GuidedReviewTombstone;
function retiredGuidedReview(review: StoredGuidedReview): review is GuidedReviewTombstone {
  return "retiredAt" in review;
}
export type { GuidedReviewMutationReceipt } from "./guided-review.ts";

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
  /** The sync commit that settled it (LOCAL-VUH-42); its journal record holds the full result. */
  syncId?: number;
  /** A large applied result lives only in that journal record, not in the checkpoint or memory. */
  resultInJournal?: true;
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
  /** Lead closure is separate from the owner's delivery verification. */
  leadCompletion?: { actor: TrackerActor; at: string; bundleId: string };
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
interface SavedIssueView extends Entity {
  schemaVersion: 1;
  storeId: string;
  projectId: string;
  name: string;
  filter: Record<string, unknown>;
}

interface Store {
  version: 1;
  /** Private attention metadata in the existing store; never a question lifecycle or sync model. */
  inboxSnoozes?: InboxSnooze[];
  issueViews?: SavedIssueView[];
  /** Import keeps the native store identity separate from the provider's team id. */
  storeId?: string;
  syncId?: number;
  /**
   * The sync log in memory. A journal-backed store keeps only the commits since its checkpoint;
   * `syncBase` names the commit before them, and older ones are read from the journal.
   */
  syncLog?: (TrackerSyncCommit & { prevHash: string; hash: string })[];
  syncBase?: { syncId: number; hash: string };
  /** Only in a checkpoint file: the journal segments it covers (LOCAL-VUH-42). */
  journal?: JournalHeader;
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
  linearMirror?: {
    workspaceId: string;
    records: Record<string, LinearRecord[]>;
    /** Linear webhook events already applied by the mirror (VUH-1965), newest last. */
    events?: { id: string; deliveryId?: string; at: string; type: string; action: string }[];
    /**
     * Set when the owner promoted this copy to the live store (VUH-1987). The
     * records stay as provenance; the store is now authoritative and writable.
     */
    cutover?: { at: string; linearProjectId: string; scratch: string };
  };
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
  guidedReviews?: StoredGuidedReview[];
  /** Links to ADR 0245 records; no question, answer or parallel ask lifecycle here. */
  ownerAsks?: { eventId: string; issueId: string; runId?: string; requestId: string }[];
}

/** One accepted Linear webhook event applied through the import mapper (VUH-1965). */
export interface LinearMirrorChange {
  readonly eventId: string;
  readonly deliveryId?: string | undefined;
  readonly type: string;
  readonly action: string;
  /** The original Linear actor, mapped the way the import maps authors. */
  readonly actor: TrackerActor;
  readonly removed?: readonly LinearMirrorRemoval[];
}

const MIRROR_EVENTS_RETAINED = 5_000;

/** Who and why for one write, threaded into item events. */
interface WriteContext {
  readonly actor: TrackerActor;
  readonly guidedReviewCapture?: GuidedReviewCapture;
  readonly via?: string;
  readonly authorizeLeadClosure?: TrackerToolCallOptions["authorizeLeadClosure"];
  readonly closureFences?: (() => void)[];
}

/** Live delivery of newly committed item events, after their write is durable. */
export type TrackerEventListener = (event: TrackerItemEvent) => void;
export interface OwnerAskLink {
  readonly eventId: string;
  readonly issueId: string;
  readonly requestId: string;
  /** What the host owner loop raises for this source event: an ask's purpose, or a landed check. */
  readonly purpose: "decision" | "gate" | "verify";
}
/** The source-event shapes the owner loop links an ask to; anything else is not a valid relation. */
function ownerAskSourcePurpose(event: {
  readonly type: string;
  readonly purpose?: string;
  readonly from?: string;
  readonly to?: string;
}): OwnerAskLink["purpose"] | undefined {
  if (event.type === "ask")
    return event.purpose === "decision" || event.purpose === "gate" ? event.purpose : undefined;
  const landed = DELIVERY_STAGES.indexOf("landed");
  if (event.type === "reopened") return event.to === "landed" ? "verify" : undefined;
  if (event.type !== "stage") return undefined;
  const from = DELIVERY_STAGES.indexOf((event.from ?? "reported") as (typeof DELIVERY_STAGES)[number]);
  const to = DELIVERY_STAGES.indexOf(event.to as (typeof DELIVERY_STAGES)[number]);
  return from < landed && to >= landed ? "verify" : undefined;
}

interface InboxSnooze extends Entity {
  schemaVersion: 1;
  storeId: string;
  projectId: string;
  actorKey: string;
  target: WorkInboxTarget;
  until: string;
}
export interface InboxPendingFence {
  readonly rows: readonly WorkInboxPendingQuestion[];
  recheck(): Promise<void>;
  assertCurrent(): void;
}
export interface InboxAttentionOptions extends TrackerToolCallOptions {
  readonly actor: TrackerActor;
  /** Host-only: the canonical live mailbox, authorized by the current request. */
  readonly prepare: (links: readonly OwnerAskLink[]) => Promise<InboxPendingFence>;
}

export interface LocalTrackerBackend extends TrackerToolBackend {
  inboxAttention(
    name: string,
    args: Record<string, unknown>,
    options: InboxAttentionOptions,
  ): Promise<{
    readonly value: unknown;
    /** Current tracker file + live mailbox + current host authorization, for the final response. */
    readonly assertCurrent: () => void;
  }>;
  /** Fixture-only existing-store read. Never enters ordinary dispatch, seed or rollover. */
  strictGetUser(
    beforeRead: (snapshot: { storeId: string; storeDigest: string }) => Promise<() => void>,
  ): Promise<{
    user: unknown;
    storeId: string;
    storeDigest: string;
  }>;
  /** Whether this backend can ever emit READ proof for the operation; never proof itself. */
  readSnapshotCandidate(name: string): boolean;
  /** Revalidate an original READ target without replaying, seeding or rolling the store. */
  withReadSnapshot<T>(
    snapshot: TrackerReadSnapshot,
    apply: (assertStoreCurrent: () => void) => Promise<T>,
  ): Promise<T>;
  sync(
    command: TrackerSyncCommand,
    options?: TrackerToolCallOptions,
    signal?: AbortSignal,
  ): Promise<TrackerSyncResult>;
  /** Host-only mirror write. Never invokes workflow gates, wakes or rollover. */
  importLinear(
    snapshot: LinearImportSnapshot,
    actorMap: Readonly<Record<string, TrackerActor>>,
    options?: TrackerToolCallOptions & { readonly mirrorEvent?: LinearMirrorChange },
  ): Promise<LinearImportReport>;
  /** Host-only: what a webhook mirror plans against; undefined when this is not a mirror store. */
  linearMirrorView(projectId: string): Promise<LinearMirrorView | undefined>;
  /** The persisted store identity; it changes when a cutover or switch-back replaces the store. */
  storeId(): Promise<string>;
  /**
   * Host-only: checkpoint a journal-backed store now and wait for it. A single-file store above
   * the journal threshold moves onto the journal; a smaller one is left as it is. Checkpoints
   * otherwise run in the background as the journal grows.
   */
  checkpoint(): Promise<void>;
  /** Host-only: persisted store identity for an exact project UUID; safe inside publication fences. */
  projectStoreId(id: string): Promise<string | undefined>;
  /** Host-only: link the existing mailbox record to its requesting item event. */
  linkOwnerAsk(eventId: string, requestId: string): Promise<void>;
  /** Host-only: apply an authenticated ADR 0245 resolution. Public tools cannot approve. */
  resolveOwnerAsk(eventId: string, requestId: string, approved: boolean, body: string): Promise<void>;
  /** Replays events after the cursor (seq), then pushes new ones. Returns an unsubscribe. */
  subscribe(listener: TrackerEventListener, after?: number): Promise<() => void>;
  /**
   * Upserts a repository's shipped versions and moves each built-in item a version
   * contains to delivered, as stage events. The history is what git records; this is
   * a host operation, not a tool, so no caller can type a release's items.
   */
  syncReleases(history: ReleaseHistory, options?: TrackerToolCallOptions): Promise<ReleaseSyncResult>;
  /** Read-only current ready work and explicit blocker edges for Auto staffing. */
  readWorkQueue(projectId: string): Promise<AutoWorkQueue>;
  /** Host-only read of one project's outcome facts for Auto rounds (ADR 0270). */
  readOutcomes(input: {
    readonly projectId: string;
    readonly window: OutcomeWindow;
    readonly history?: boolean;
    readonly media?: boolean;
    readonly asOf?: string;
  }): Promise<TrackerOutcomes>;
}

export interface ReleaseSyncResult {
  readonly repository: string;
  readonly lane: string;
  readonly releases: readonly { id: string; version: string; items: number; builtIn: number }[];
  /** Items this sync moved to delivered, with the version that shipped them. */
  readonly delivered: readonly { identifier: string; version: string }[];
  /** Release membership was retained, but these built-in items did not move stage. */
  readonly skipped: readonly { identifier: string; version: string; reason: string; detail: string }[];
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
  /** Host-only issue/project source authority; absent capability refuses filesystem reads. */
  readonly authorizeGuidedReviewSource?: (
    issue: Readonly<Record<string, unknown>>,
    source: GuidedReviewSource,
    actor: TrackerActor,
  ) => Promise<() => void>;
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
/** A Linear copy that has not been cut over: read-only, changed only from Linear. */
function mirroring(store: Store): store is Store & { linearMirror: NonNullable<Store["linearMirror"]> } {
  return store.linearMirror !== undefined && store.linearMirror.cutover === undefined;
}
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
  if (store.issueViews !== undefined) {
    if (
      !Array.isArray(store.issueViews) ||
      store.issueViews.length > 1000 ||
      new Set(store.issueViews.map((view) => view.id)).size !== store.issueViews.length
    )
      throw new Error("Invalid local saved issue views");
    for (const view of store.issueViews) {
      validateTrackerToolArgs("save_issue_view", {
        schemaVersion: view.schemaVersion,
        storeId: view.storeId,
        project: view.projectId,
        name: view.name,
        filter: view.filter,
      });
      if (
        view.storeId !== (store.storeId ?? store.team.id) ||
        !store.projects.some((project) => project.id === view.projectId) ||
        typeof view.id !== "string" ||
        typeof view.createdAt !== "string" ||
        typeof view.updatedAt !== "string" ||
        JSON.stringify(view.filter).length > 8192
      )
        throw new Error("Invalid local saved issue view binding");
    }
  }
  if (store.guidedReviews !== undefined) {
    if (
      !Array.isArray(store.guidedReviews) ||
      store.guidedReviews.filter((review) => !retiredGuidedReview(review)).length > 1000 ||
      new Set(store.guidedReviews.map((review) => review.id)).size !== store.guidedReviews.length
    )
      throw new Error("Invalid guided review collection");
    // Ordinary tracker reads inspect only metadata, never hash every retained patch.
    for (const review of store.guidedReviews) validateGuidedReviewMetadata(store, review);
  }
  if (store.inboxSnoozes !== undefined) {
    if (!Array.isArray(store.inboxSnoozes) || store.inboxSnoozes.length > 1000)
      throw new Error("Invalid inbox snooze collection");
    const keys = new Set<string>();
    for (const entry of store.inboxSnoozes) {
      const key = canonical([entry.projectId, entry.actorKey, entry.target]);
      if (
        entry.schemaVersion !== 1 ||
        entry.storeId !== (store.storeId ?? store.team.id) ||
        !store.projects.some((project) => project.id === entry.projectId) ||
        !/^(human|agent-worker|app):.+/u.test(entry.actorKey) ||
        !WorkInboxTargetSchema.safeParse(entry.target).success ||
        typeof entry.id !== "string" ||
        keys.has(key) ||
        !Number.isFinite(Date.parse(entry.createdAt)) ||
        !Number.isFinite(Date.parse(entry.updatedAt)) ||
        !Number.isFinite(Date.parse(entry.until)) ||
        Date.parse(entry.until) <= Date.parse(entry.createdAt)
      )
        throw new Error("Invalid inbox snooze binding");
      keys.add(key);
    }
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
  if (store.journal !== undefined) {
    // A checkpoint's sync commits live in the journal it names; the in-memory log starts after it.
    const header = store.journal;
    if (
      header.version !== 1 ||
      store.syncLog !== undefined ||
      store.syncBase !== undefined ||
      store.syncId !== header.syncId ||
      typeof header.syncHash !== "string" ||
      !Array.isArray(header.sealed)
    )
      throw new Error("Invalid local tracker journal checkpoint");
    store.syncBase = { syncId: header.syncId, hash: header.syncHash };
    store.syncLog = [];
  }
  if (store.syncLog !== undefined) {
    const base = store.syncBase ?? { syncId: 0, hash: "" };
    if (!Array.isArray(store.syncLog) || store.syncId !== base.syncId + store.syncLog.length)
      throw new Error("Invalid local tracker sync log");
    let previous = base.hash;
    store.syncLog.forEach((commit, index) => {
      if (
        commit.syncId !== base.syncId + index + 1 ||
        commit.prevHash !== previous ||
        auditHash(commit) !== commit.hash
      )
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
  ["issueViews", "issue_view"],
  ["guidedReviews", "guided_review"],
] as const;

/** The write time (or its transaction operation times) identifies touched records. */
function stampActor(store: Store, actor: TrackerActor, now: string): AuditEvent["entities"] {
  const touched: AuditEvent["entities"] = [];
  for (const [collection, type] of ENTITY_TYPES)
    for (const found of (store[collection] ?? []) as (Entity & { identifier?: string })[]) {
      if (found.updatedAt < now) continue;
      // A transaction settles each operation, so an earlier operation's records are frozen again.
      const entry = owned(store[collection] as (Entity & { identifier?: string })[], found);
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
    if (status !== undefined) owned(store.issueStatuses, status).stage = stage;
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
        | "body"
        | "from"
        | "to"
        | "status"
        | "commentId"
        | "bundleId"
        | "runId"
        | "requestId"
        | "gate"
        | "purpose"
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
    selfEcho: !isOwnerActivity(context.actor) && context.actor.type !== "external",
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
  const back = DELIVERY_STAGES.indexOf(target) < DELIVERY_STAGES.indexOf(current);
  if ((target === "owner-verified" || back) && !isOwner(context.actor))
    throw new TrackerWriteRefused(
      "owner_verification_required",
      target === "owner-verified"
        ? "only the owner verifies an item; report landed or delivered and the owner checks it"
        : `only the owner moves an item back (from ${current} to ${target})`,
    );
  if (target === current) return;
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
  if (back || target === "owner-verified") delete issue.leadCompletion;
  if (issue.leadCompletion === undefined) issue.statusId = statusForStage(store, target).id;
  appendEvent(store, context, now, issue, {
    type: target === "owner-verified" ? "verified" : back ? "reopened" : "stage",
    from: current,
    to: target,
    status: store.issueStatuses.find((status) => status.id === issue.statusId)!.name,
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
 * Hand-set changes become events too. A scoped lead can close landed work under
 * the owner's lead policy; verification and reopening remain the owner's alone.
 */
async function recordIssueChanges(
  before: Store,
  store: Store,
  name: string,
  context: WriteContext,
  now: string,
): Promise<void> {
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
      appendEvent(store, context, now, issue, {
        type: "created",
        to: stageOf(issue),
        status: store.issueStatuses.find((status) => status.id === issue.statusId)!.name,
      });
    } else if (previous.statusId !== issue.statusId) {
      const from = before.issueStatuses.find((status) => status.id === previous.statusId)?.name;
      const to = store.issueStatuses.find((status) => status.id === issue.statusId)!.name;
      if (is === "completed" || was === "completed") {
        if (is === "completed" && !isOwner(context.actor)) {
          if (issue.projectId !== previous.projectId)
            throw new TrackerWriteRefused(
              "lead_closure_required",
              "an item cannot change project in the same write as lead closure",
            );
          if (!context.authorizeLeadClosure)
            throw new TrackerWriteRefused(
              "owner_verification_required",
              "completion requires the current scoped lead and owner-authored lead closure policy",
            );
          const fence = await context.authorizeLeadClosure(issue.projectId);
          fence();
          context.closureFences?.push(fence);
          if (DELIVERY_STAGES.indexOf(stageOf(previous)) < DELIVERY_STAGES.indexOf("landed"))
            throw new TrackerWriteRefused("landed_required", "lead closure requires landed implementation");
          const bundle = currentBundle(store, issue.id);
          if (!bundle)
            throw new TrackerWriteRefused(
              "evidence_bundle_required",
              "lead closure requires an evidence bundle",
            );
          if (!bundle.checked)
            throw new TrackerWriteRefused(
              "bundle_check_required",
              "lead closure requires an independent bundle check of acceptance evidence",
            );
          issue.leadCompletion = { actor: context.actor, at: now, bundleId: bundle.id };
          appendEvent(store, context, now, issue, {
            type: "state",
            ...(from === undefined ? {} : { from }),
            to,
            bundleId: bundle.id,
          });
        } else {
          if (!isOwner(context.actor))
            throw new TrackerWriteRefused(
              "owner_verification_required",
              is === "completed"
                ? `only the owner completes an item; report it with post_issue_event (stage landed or delivered) and the owner verifies it`
                : "only the owner reopens a completed item",
            );
          moveStage(store, issue, is === "completed" ? "owner-verified" : "accepted", context, now);
        }
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
  const status: Status = existing
    ? owned(store.issueStatuses, existing)
    : { id: randomUUID(), name, type: args.type as string };
  status.name = name;
  if (args.type !== undefined) status.type = args.type as string;
  if (args.stage !== undefined) {
    for (const entry of store.issueStatuses)
      if (entry.stage === args.stage) delete owned(store.issueStatuses, entry).stage;
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
  const skipped: ReleaseSyncResult["skipped"][number][] = [];
  // The history is oldest version first.
  for (const release of synced)
    for (const item of release.items) {
      const found = store.issues.find((entry) => entry.id === item.issueId);
      if (found === undefined) continue;
      const issue = owned(store.issues, found);
      const skip = (reason: string, detail: string) =>
        skipped.push({ identifier: issue.identifier, version: release.version, reason, detail });
      if (issue.stage === undefined) {
        skip("delivery_stage_missing", "No delivery stage is recorded; release membership retained.");
        continue;
      }
      if (DELIVERY_STAGES.indexOf(issue.stage) >= DELIVERED) {
        skip("already_delivered", `Current delivery stage is ${issue.stage}.`);
        continue;
      }
      const category = categoryOf(store, issue.statusId);
      if (category === "canceled" || category === "duplicate") {
        skip(category, `Item status is ${category}.`);
        continue;
      }
      try {
        moveStage(store, issue, "delivered", context, now, `Shipped in ${release.version} (${release.lane})`);
      } catch (error) {
        if (!(error instanceof TrackerWriteRefused)) throw error;
        skip(error.reason, error.message);
        continue;
      }
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
    skipped,
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
  if (mirroring(store)) return false; // provider cycles remain authoritative during mirror
  // Imported Linear team cycles (no project) are history; only project cycles roll over.
  const ended = new Set(
    (store.cycles ?? [])
      .filter((cycle) => cycle.projectId !== "" && cycle.endsAt <= clock)
      .map((cycle) => cycle.id),
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
        moveCycle(store, owned(store.issues, issue), target, context, now);
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

function currentBundle(store: Store, issueId: string, runId: string | null = null) {
  const bundle = (store.bundles ?? []).findLast(
    (entry) => entry.issueId === issueId && entry.runId === runId,
  );
  return bundle && owned(store.bundles!, bundle);
}

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
  // Independence keeps agents from attesting their own work. The owner is the
  // authority it protects and the only one who verifies, so he is never refused.
  if (!isOwner(context.actor) && workers.some((actor) => actorKey(actor) === actorKey(context.actor)))
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

const guidedSnapshotHash = (
  review: Pick<GuidedReviewRecord, "identity" | "inspection" | "walkthrough" | "findings">,
) =>
  createHash("sha256")
    .update(
      canonical({
        identity: review.identity,
        inspection: review.inspection,
        walkthrough: review.walkthrough,
        findings: review.findings.map(({ body, severity, anchor }) => ({ body, severity, anchor })),
      }),
    )
    .digest("hex");

export const GUIDED_REVIEW_LIMITS = Object.freeze({
  perIssue: 3,
  totalBytes: 8 * 1024 * 1024,
  discussionBytes: 256 * 1024,
});

/** Shared capacity is reserved for immutable captures; discussion has its own per-review budget. */
function assertGuidedReviewBudget(store: Store, review: GuidedReviewRecord, tool: string): void {
  if (tool === "save_guided_review") {
    const snapshots = (store.guidedReviews ?? [])
      .filter((entry): entry is GuidedReviewRecord => !retiredGuidedReview(entry))
      .map((entry) => ({
        ...entry,
        updatedAt: entry.createdAt,
        updatedByActor: entry.createdByActor,
        findings: entry.findings.map(
          ({ resolved: _resolved, replies: _replies, history: _history, ...finding }) => finding,
        ),
      }));
    if (Buffer.byteLength(JSON.stringify(snapshots)) > GUIDED_REVIEW_LIMITS.totalBytes)
      throw new TrackerWriteRefused(
        "guided_review_budget",
        "Guided review snapshots exceed the stored byte budget. An authenticated owner can retire an eligible review with clankie work owner post_retire_guided_review, then save a new revision on the same issue. Reviews with legacy full/pointer receipts cannot be retired.",
      );
  }
  const discussion = review.findings.map(({ resolved, replies, history }) => ({
    resolved,
    replies,
    history,
  }));
  if (Buffer.byteLength(JSON.stringify(discussion)) > GUIDED_REVIEW_LIMITS.discussionBytes)
    throw new TrackerWriteRefused(
      "guided_review_discussion_budget",
      "This guided review has reached its discussion byte budget. Replies, resolve and reopen edits share this budget. An authenticated owner can retire an eligible review with clankie work owner post_retire_guided_review, then save a new revision on the same issue. Reviews with legacy full/pointer receipts cannot be retired.",
    );
}

/** The public compact result is immutable and independently replayable after retirement. */
function guidedReviewMutationReceipt(
  review: StoredGuidedReview,
  name: string,
  actor: TrackerActor,
): GuidedReviewMutationReceipt {
  const event = retiredGuidedReview(review)
    ? undefined
    : review.findings
        .flatMap((finding) => finding.history)
        .sort((a, b) => a.at.localeCompare(b.at))
        .at(-1);
  return {
    schemaVersion: 1,
    reviewId: review.id,
    storeId: review.storeId,
    issueId: review.issueId,
    projectId: review.projectId,
    identity: structuredClone(review.identity),
    snapshotSha256: review.snapshotSha256,
    operation:
      name === "save_guided_review" ? "save" : retiredGuidedReview(review) ? "retire" : event!.action,
    eventId: retiredGuidedReview(review) ? review.retirementEventId : (event?.id ?? null),
    updatedAt: review.updatedAt,
    actor: structuredClone(actor),
  };
}

function replayGuidedReviewReceipt(store: Store, value: unknown): unknown {
  if (!value || typeof value !== "object" || !("guidedReviewSnapshot" in value)) return value;
  const receipt = value as {
    guidedReviewSnapshot: string;
    result?: Omit<GuidedReviewRecord, "inspection">;
    eventId?: string | null;
    updatedAt?: string;
  };
  const review = (store.guidedReviews ?? []).find((entry) => entry.id === receipt.guidedReviewSnapshot);
  if (!review || retiredGuidedReview(review))
    throw new Error("Guided review receipt snapshot is unavailable");
  validateStoredGuidedReview(store, review);
  // Read the original compact receipts written before event references were introduced.
  if (receipt.result) {
    if (receipt.result.id !== review.id || receipt.result.snapshotSha256 !== review.snapshotSha256)
      throw new Error("Guided review receipt snapshot is unavailable");
    const restored = { ...receipt.result, inspection: review.inspection };
    validateStoredGuidedReview(store, restored);
    return restored;
  }
  const events = review.findings
    .flatMap((finding) => finding.history)
    .sort((a, b) => a.at.localeCompare(b.at));
  const end = receipt.eventId === null ? -1 : events.findIndex((event) => event.id === receipt.eventId);
  if (receipt.eventId !== null && end < 0) throw new Error("Guided review receipt event is unavailable");
  const included = new Set(events.slice(0, end + 1).map((event) => event.id));
  const restored = structuredClone(review);
  for (const finding of restored.findings) {
    finding.history = finding.history.filter((event) => included.has(event.id));
    finding.replies = finding.replies.filter((reply) => included.has(reply.id));
    finding.resolved = false;
    for (const event of finding.history) if (event.action !== "reply") finding.resolved = event.resolved;
  }
  restored.updatedAt = receipt.updatedAt!;
  if (end >= 0) restored.updatedByActor = events[end]!.actor;
  else if (restored.createdByActor) restored.updatedByActor = restored.createdByActor;
  else delete restored.updatedByActor;
  validateStoredGuidedReview(store, restored);
  return restored;
}

function guidedReviewSummary(review: StoredGuidedReview): Record<string, unknown> {
  if (retiredGuidedReview(review)) return { ...review };
  return {
    id: review.id,
    schemaVersion: review.schemaVersion,
    storeId: review.storeId,
    issueId: review.issueId,
    projectId: review.projectId,
    ...(review.runId === undefined ? {} : { runId: review.runId }),
    identity: review.identity,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    fileCount: review.inspection.fileCount,
    stepCount: review.walkthrough.length,
    findingCount: review.findings.length,
    unresolvedCount: review.findings.filter((finding) => !finding.resolved).length,
    findings: review.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      resolved: finding.resolved,
      replyCount: finding.replies.length,
    })),
  };
}

function validateGuidedReviewMetadata(store: Store, review: StoredGuidedReview): void {
  const issue = store.issues.find((entry) => entry.id === review.issueId);
  if (
    review.schemaVersion !== 1 ||
    typeof review.id !== "string" ||
    !issue ||
    review.storeId !== (store.storeId ?? store.team.id) ||
    !(review.projectId === null || store.projects.some((entry) => entry.id === review.projectId)) ||
    !Number.isFinite(Date.parse(review.createdAt)) ||
    !Number.isFinite(Date.parse(review.updatedAt)) ||
    (review.runId !== undefined &&
      !(store.runs ?? []).some((run) => run.id === review.runId && run.issueId === issue.id))
  )
    throw new Error("Invalid guided review binding");
  if (retiredGuidedReview(review)) {
    if (
      !Number.isFinite(Date.parse(review.retiredAt)) ||
      review.retiredAt !== review.updatedAt ||
      typeof review.retirementEventId !== "string" ||
      !review.retiredByActor ||
      !/^[a-f0-9]{64}$/u.test(review.snapshotSha256) ||
      (review.identity?.kind !== "patch" && review.identity?.kind !== "git")
    )
      throw new Error("Invalid retired guided review metadata");
    if (
      review.identity.kind === "patch"
        ? !/^[a-f0-9]{64}$/u.test(review.identity.sha256)
        : typeof review.identity.gitDirectory !== "string" ||
          review.identity.gitDirectory.length > 4096 ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(review.identity.baseCommit) ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(review.identity.headCommit)
    )
      throw new Error("Invalid retired guided review identity");
    return;
  }
  if (
    !review.inspection ||
    typeof review.inspection !== "object" ||
    review.inspection.complete !== true ||
    !Number.isSafeInteger(review.inspection.fileCount) ||
    review.inspection.fileCount! < 0 ||
    review.inspection.fileCount! > 200 ||
    !Array.isArray(review.walkthrough) ||
    review.walkthrough.length < 1 ||
    review.walkthrough.length > 200 ||
    !Array.isArray(review.findings) ||
    review.findings.length > 200 ||
    !/^[a-f0-9]{64}$/u.test(review.snapshotSha256) ||
    !review.identity ||
    (review.identity.kind !== "patch" && review.identity.kind !== "git")
  )
    throw new Error("Invalid guided review metadata");
  if (
    review.identity.kind === "patch"
      ? !/^[a-f0-9]{64}$/u.test(review.identity.sha256)
      : typeof review.identity.gitDirectory !== "string" ||
        review.identity.gitDirectory.length > 4096 ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(review.identity.baseCommit) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(review.identity.headCommit)
  )
    throw new Error("Invalid guided review identity metadata");
  for (const finding of review.findings)
    if (
      !finding ||
      typeof finding.id !== "string" ||
      finding.id.length > 128 ||
      typeof finding.resolved !== "boolean" ||
      !["info", "warning", "error", "critical"].includes(finding.severity) ||
      !Array.isArray(finding.replies) ||
      finding.replies.length > 1000 ||
      !Array.isArray(finding.history) ||
      finding.history.length > 2000
    )
      throw new Error("Invalid guided finding metadata");
}

function validateStoredGuidedReview(store: Store, review: GuidedReviewRecord): void {
  validateGuidedReviewMetadata(store, review);
  validateGuidedReviewContent(review.inspection, review.walkthrough, review.findings);
  const actual: GuidedReviewIdentity =
    "source" in review.inspection
      ? { kind: "patch", sha256: review.inspection.patch.sha256 }
      : {
          kind: "git",
          gitDirectory: review.inspection.gitDirectory,
          baseCommit: review.inspection.base.commit,
          headCommit: review.inspection.head.commit,
        };
  if (
    canonical(actual) !== canonical(review.identity) ||
    guidedSnapshotHash(review) !== review.snapshotSha256 ||
    new Set(review.findings.map((finding) => finding.id)).size !== review.findings.length
  )
    throw new Error("Invalid guided review snapshot integrity");
  for (const finding of review.findings) {
    if (
      typeof finding.id !== "string" ||
      typeof finding.resolved !== "boolean" ||
      !Array.isArray(finding.replies) ||
      finding.replies.length > 1000 ||
      !Array.isArray(finding.history) ||
      finding.history.length > 2000
    )
      throw new Error("Invalid guided finding discussion");
    const validActor = (actor: TrackerActor) =>
      actor &&
      typeof actor.id === "string" &&
      ["human", "agent-worker", "app"].includes(actor.type) &&
      Array.isArray(actor.onBehalfOf);
    for (const reply of finding.replies)
      if (
        typeof reply.id !== "string" ||
        typeof reply.body !== "string" ||
        !reply.body.trim() ||
        reply.body.length > 16000 ||
        !validActor(reply.actor) ||
        !Number.isFinite(Date.parse(reply.at))
      )
        throw new Error("Invalid guided finding reply");
    for (const event of finding.history)
      if (
        typeof event.id !== "string" ||
        !validActor(event.actor) ||
        !Number.isFinite(Date.parse(event.at)) ||
        (event.action !== "reply" && event.action !== "resolve") ||
        (event.action === "reply"
          ? typeof event.body !== "string" || !event.body.trim() || event.body.length > 16000
          : typeof event.resolved !== "boolean")
      )
        throw new Error("Invalid guided finding history");
  }
}

function guidedReviewForIssue(store: Store, args: Record<string, unknown>, options: LocalTrackerOptions) {
  const issue = findIssue(store, args.issueId as string);
  options.assertIssueWrite?.(issueView(store, issue));
  const review = (store.guidedReviews ?? []).find(
    (entry) => entry.id === args.id && entry.issueId === issue.id,
  );
  if (!review || review.storeId !== (store.storeId ?? store.team.id))
    throw new Error("Guided review not found on this issue");
  return owned(store.guidedReviews!, review);
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
  if (
    runId === null &&
    (issue.leadCompletion !== undefined ||
      DELIVERY_STAGES.indexOf(stageOf(issue)) > DELIVERY_STAGES.indexOf("landed"))
  )
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
  const found =
    args.runId === undefined
      ? undefined
      : (store.runs ?? []).find((entry) => entry.id === args.runId && entry.issueId === issue.id);
  if (args.runId !== undefined && found === undefined) throw new Error("runId must name a run on this issue");
  const run = found && owned(store.runs!, found);
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
  const found = (store.runs ?? []).find((entry) => entry.id === args.runId);
  if (!found) throw new Error("Run not found");
  const run = owned(store.runs!, found);
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
    run = owned(store.runs!, found);
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

/**
 * Copy-on-write (LOCAL-VUH-42). A committed store is deep-frozen and shared by reads and by
 * the next write. A write's draft copies only the top level and each collection array, so
 * adding, removing or reordering records leaves the committed store untouched; a record is
 * cloned only when the write changes it (`own`). A mutation that skips `own` throws, so a
 * missed site refuses its write instead of corrupting committed state.
 */
function freezeRecords(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) freezeRecords(child);
}
/**
 * Freezes every record the draft holds and returns its immutable snapshot; the draft stays
 * writable. Given the committed store the draft came from, a record still at the same place
 * there is frozen already, so only what this write placed is walked.
 */
function settle(store: Store, base?: Store): Store {
  const snapshot = { ...store } as Record<string, unknown>;
  const committed = base as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(snapshot)) {
    if (!Array.isArray(value)) continue;
    const records = [...value];
    const previous = committed?.[key];
    if (Array.isArray(previous)) {
      for (let index = 0; index < records.length; index++)
        if (records[index] !== previous[index]) freezeRecords(records[index]);
      Object.freeze(records);
    }
    snapshot[key] = records;
  }
  freezeRecords(snapshot);
  return snapshot as unknown as Store;
}
function draftOf(store: Store): Store {
  const draft = { ...store } as Record<string, unknown>;
  // Spread, not slice: V8 slices a frozen array element by element.
  for (const [key, value] of Object.entries(draft)) if (Array.isArray(value)) draft[key] = [...value];
  return draft as unknown as Store;
}
/** Names the code that changed a committed record in place, so a missed `own` is found. */
function frozenRecordSite(error: Error): string {
  if (
    !(error instanceof TypeError) ||
    !/read only|not extensible|Cannot (?:add|delete|assign)/u.test(error.message)
  )
    return "";
  const site = error.stack?.split("\n").find((line) => /tracker-local\.ts:\d+/u.test(line));
  return ` (committed tracker record changed in place${site === undefined ? "" : ` ${site.trim()}`})`;
}
/** The draft's own writable copy of a committed record, replacing it in its collection. */
function own<T extends object>(collection: T[], entry: T): T {
  if (!Object.isFrozen(entry)) return entry;
  const index = collection.indexOf(entry);
  if (index < 0) throw new Error("Tracker record is not in this collection");
  const copy = structuredClone(entry);
  collection[index] = copy;
  return copy;
}
/** Records found in a write's draft are its own; a committed store's stay shared and frozen. */
const owned = <T extends object>(collection: T[], entry: T): T =>
  Object.isFrozen(collection) ? entry : own(collection, entry);

/** Each store file's committed snapshot, frozen and shared by every backend instance in the process. */
const committedStores = new Map<string, { current?: Committed }>();
/** A store as committed by this process, and where its next commit goes. */
interface Committed {
  readonly version: string;
  /** SHA-256 and size of `tracker.json` as committed: the single file, or the checkpoint. */
  readonly digest: string;
  readonly bytes: number;
  /** Frozen; reads share it and writes draft from it. */
  readonly store: Store;
  readonly journal?: {
    readonly header: JournalHeader;
    readonly live: { readonly name: string; readonly size: number };
    /** Bytes appended since the checkpoint, against which the next checkpoint is due. */
    readonly bytes: number;
    readonly checkpointBytes: number;
  };
}
/** The record carries the sync commit itself; the checkpoint header replaces the rest. */
const JOURNAL_SKIP: ReadonlySet<string> = new Set(["syncLog", "syncId", "syncBase", "journal"]);
/** At most one background checkpoint per store file in this process. */
const checkpoints = new Map<string, Promise<void>>();
/** Sealed segments this process has already proven, so reopening does not hash them again. */
const verifiedSegments = new Set<string>();

/** Proves a hash chain from `from` on: consecutive sequence numbers, links and hashes. */
function assertChained<T extends { prevHash: string; hash: string }>(
  entries: readonly T[],
  from: number,
  sequence: (entry: T) => number,
  base: { sequence: number; hash: string },
  label: string,
): void {
  let previous = from === 0 ? base.hash : entries[from - 1]!.hash;
  for (let index = from; index < entries.length; index++) {
    const entry = entries[index]!;
    if (
      sequence(entry) !== base.sequence + index + 1 ||
      entry.prevHash !== previous ||
      auditHash(entry) !== entry.hash
    )
      throw new Error(`Local tracker ${label} is not intact at ${String(base.sequence + index + 1)}`);
    previous = entry.hash;
  }
}
const sharedPrefix = (left: readonly unknown[] = [], right: readonly unknown[] = []) => {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index++;
  return index;
};
/** Replays journal records, then proves what they added to each chain, as opening a file does. */
function replayVerified(base: Store, records: readonly JournalRecord[]): Store {
  const store = replayJournal(base, records);
  const head = { sequence: 0, hash: "" };
  assertChained(
    store.events ?? [],
    sharedPrefix(base.events, store.events),
    (event) => event.seq,
    head,
    "event stream",
  );
  assertChained(
    store.audit ?? [],
    sharedPrefix(base.audit, store.audit),
    (event) => event.seq,
    head,
    "audit log",
  );
  const syncBase = store.syncBase ?? { syncId: 0, hash: "" };
  assertChained(
    store.syncLog ?? [],
    sharedPrefix(base.syncLog, store.syncLog),
    (commit) => commit.syncId,
    { sequence: syncBase.syncId, hash: syncBase.hash },
    "sync log",
  );
  return store;
}
/**
 * A receipt keeps a large applied result only in its journal record once a checkpoint covers
 * it. Guided review receipts are compact already, and retirement reads them, so they stay.
 */
function boundedReceipts(receipts: readonly WriteReceipt[], header: JournalHeader): WriteReceipt[] {
  return receipts.map((receipt) => {
    if (
      receipt.state !== "applied" ||
      receipt.resultInJournal === true ||
      receipt.syncId === undefined ||
      receipt.syncId <= header.since ||
      receipt.syncId > header.syncId ||
      GUIDED_REVIEW_TOOLS.has(receipt.tool) ||
      JSON.stringify(receipt.result ?? null).length <= RECEIPT_RESULT_BYTES
    )
      return receipt;
    const { result: _result, ...bounded } = receipt;
    return { ...bounded, resultInJournal: true };
  });
}
/** The in-memory store once a checkpoint covers it: only later commits, bounded receipts. */
function compactedStore(store: Store, header: JournalHeader): Store {
  return {
    ...store,
    syncBase: { syncId: header.syncId, hash: header.syncHash },
    syncLog: (store.syncLog ?? []).filter((commit) => commit.syncId > header.syncId),
    ...(store.receipts === undefined ? {} : { receipts: boundedReceipts(store.receipts, header) }),
  };
}
/** What a checkpoint file holds: the store without its sync log, and the journal header. */
function checkpointContent(store: Store, header: JournalHeader): Record<string, unknown> {
  return {
    ...store,
    syncLog: undefined,
    syncBase: undefined,
    ...(store.receipts === undefined ? {} : { receipts: boundedReceipts(store.receipts, header) }),
    journal: header,
  };
}

/** Atomic rename prevents torn reads; fsync preserves completed writes across a process crash. */
async function persist(
  path: string,
  store: Store,
  assertHeld: () => void,
  options?: TrackerToolCallOptions,
): Promise<Buffer> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(store, null, 2)}\n`);
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options?.beforeWrite?.();
    assertHeld();
    options?.onDispatch?.();
    await rename(temp, path);
    options?.effectConfirmed?.();
    return bytes;
  } finally {
    await rm(temp, { force: true });
  }
}

function findIssue(store: Store, reference: string): Issue {
  const result = store.issues.find(
    (entry) => norm(entry.id) === norm(reference) || norm(entry.identifier) === norm(reference),
  );
  if (result === undefined) throw new Error(`Issue not found: ${reference}`);
  return owned(store.issues, result);
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
  return owned(store.projects, matches[0]!);
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
  // An imported issue's provider reference is `{id}` alone; readers get the milestone's name (VUH-1991).
  const milestone =
    issue.milestoneId == null ? undefined : store.milestones?.find((entry) => entry.id === issue.milestoneId);
  const view: Record<string, unknown> = {
    ...issue,
    ...(issue.milestoneId == null
      ? {}
      : {
          projectMilestone:
            milestone === undefined ? null : { id: milestone.id, name: String(milestone.name) },
        }),
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
  const label: Label = existing
    ? owned(store.labels, existing)
    : {
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
    for (const collection of [store.issues, store.projects] as (Issue | Project)[][])
      for (const entry of collection)
        if (entry.labels.includes(existing.name))
          owned(collection, entry).labels = entry.labels.map((value) =>
            value === existing.name ? name : value,
          );
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

function issueViewProject(store: Store, args: Record<string, unknown>): Project {
  if (args.storeId !== (store.storeId ?? store.team.id)) throw new Error("Saved view tracker store mismatch");
  const project = store.projects.find((entry) => entry.id === args.project);
  if (!project) throw new Error("Saved views require an exact existing project UUID");
  return project;
}
function savedIssueView(store: Store, args: Record<string, unknown>): SavedIssueView {
  const project = issueViewProject(store, args);
  const view = store.issueViews?.find(
    (entry) => entry.id === args.id && entry.projectId === project.id && entry.storeId === args.storeId,
  );
  if (!view) throw new Error("Saved issue view not found in this store/project");
  return view;
}

function validateSavedFilter(
  store: Store,
  project: Project,
  filter: Record<string, unknown>,
  now: string,
): void {
  // Normal issue reads parse these lazily per issue; saved definitions must
  // refuse invalid dates even while the project's current issue list is empty.
  for (const key of ["createdAt", "updatedAt"])
    if (filter[key] !== undefined) dateBoundary(filter[key] as string, now);
  if (filter.parentId !== undefined && findIssue(store, filter.parentId as string).projectId !== project.id)
    throw new Error("Saved view parent belongs to another project");
  if (
    filter.cycle !== undefined &&
    findCycle(store, filter.cycle as string, project, now, false).projectId !== project.id
  )
    throw new Error("Saved view cycle belongs to another project");
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
    case "save_guided_review": {
      const issue = findIssue(store, args.issueId as string);
      options.assertIssueWrite?.(issueView(store, issue));
      if ((store.guidedReviews ?? []).filter((review) => !retiredGuidedReview(review)).length >= 1000)
        throw new Error("Guided review limit reached");
      if (
        (store.guidedReviews ?? []).filter(
          (review) => review.issueId === issue.id && !retiredGuidedReview(review),
        ).length >= GUIDED_REVIEW_LIMITS.perIssue
      )
        throw new TrackerWriteRefused(
          "guided_review_limit",
          "This issue has reached its active review limit. An authenticated owner can retire an eligible review with clankie work owner post_retire_guided_review, then save a new revision on the same issue. Reviews with legacy full/pointer receipts cannot be retired.",
        );
      const runId = args.runId as string | undefined;
      if (runId !== undefined) {
        const run = (store.runs ?? []).find((entry) => entry.id === runId && entry.issueId === issue.id);
        if (!run || (actorKey(run.actor) !== actorKey(context.actor) && !ownerOrLead(context.actor)))
          throw new Error("Guided review run must belong to this issue and caller");
      }
      const capture = context.guidedReviewCapture;
      if (!capture) throw new Error("Guided review capture must be prepared before acquiring the store lock");
      if (canonical(capture.identity) !== canonical(args.expectedSource))
        throw new TrackerWriteRefused(
          "source_mismatch",
          "Prepared guided review source does not match expectedSource",
        );
      const review: GuidedReviewRecord = {
        id: randomUUID(),
        schemaVersion: 1,
        storeId: store.storeId ?? store.team.id,
        issueId: issue.id,
        projectId: issue.projectId,
        ...(runId === undefined ? {} : { runId }),
        identity: capture.identity,
        inspection: capture.inspection,
        walkthrough: structuredClone(args.walkthrough as GuidedReviewStep[]),
        findings: (args.findings as GuidedReviewFindingInput[]).map((finding) => ({
          ...structuredClone(finding),
          id: randomUUID(),
          resolved: false,
          replies: [],
          history: [],
        })),
        snapshotSha256: "",
        createdAt: now,
        updatedAt: now,
      };
      review.snapshotSha256 = guidedSnapshotHash(review);
      validateStoredGuidedReview(store, review);
      (store.guidedReviews ??= []).push(review);
      return review;
    }
    case "get_guided_review": {
      const review = guidedReviewForIssue(store, args, options);
      if (!retiredGuidedReview(review)) validateStoredGuidedReview(store, review);
      return review;
    }
    case "list_guided_reviews": {
      const issue = findIssue(store, args.issueId as string);
      options.assertIssueWrite?.(issueView(store, issue));
      return page(
        (store.guidedReviews ?? [])
          .filter((review) => review.issueId === issue.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(guidedReviewSummary),
        args,
        "guidedReviews",
        name,
      );
    }
    case "post_guided_finding": {
      const review = guidedReviewForIssue(store, args, options);
      if (retiredGuidedReview(review))
        throw new TrackerWriteRefused(
          "guided_review_retired",
          "This review is retired; save a new source revision on the same issue",
        );
      validateStoredGuidedReview(store, review);
      if (canonical(review.identity) !== canonical(args.expectedSource))
        throw new TrackerWriteRefused("source_mismatch", "Guided finding source does not match this review");
      if (args.ifUpdatedAt === undefined) throw new Error("ifUpdatedAt is required for guided finding edits");
      assertUnchangedSince(review, args);
      const finding = review.findings.find((entry) => entry.id === args.findingId);
      if (!finding) throw new Error("Guided finding not found");
      if (finding.history.length >= 2000) throw new Error("Guided finding history limit reached");
      const edit = args.edit as GuidedFindingAction;
      const event = { ...structuredClone(edit), id: randomUUID(), actor: context.actor, at: now };
      if (edit.action === "reply") {
        if (finding.replies.length >= 1000 || !edit.body.trim())
          throw new Error("Invalid or excessive finding reply");
        finding.replies.push({ id: event.id, body: edit.body, actor: context.actor, at: now });
      } else finding.resolved = edit.resolved;
      finding.history.push(event);
      review.updatedAt = now;
      return review;
    }
    case "post_retire_guided_review": {
      const review = guidedReviewForIssue(store, args, options);
      // The ordinary operator route's Clankie label is not native lead proof.
      // Existing owner activity is the only destructive authority proven here.
      if (!isOwnerActivity(context.actor))
        throw new TrackerWriteRefused(
          "guided_review_retire_authority",
          "Retirement requires authenticated owner activity; an actor label or issue-write authority is insufficient",
        );
      if (retiredGuidedReview(review))
        throw new TrackerWriteRefused("guided_review_retired", "This review is already retired");
      validateStoredGuidedReview(store, review);
      if (canonical(review.identity) !== canonical(args.expectedSource))
        throw new TrackerWriteRefused("source_mismatch", "Retirement source does not match this review");
      assertUnchangedSince(review, args);
      // Legacy historical full results require payload retention. Do not silently rewrite them.
      if (
        (store.receipts ?? []).some((receipt) => {
          if (
            receipt.state !== "applied" ||
            !["save_guided_review", "post_guided_finding"].includes(receipt.tool)
          )
            return false;
          const result = receipt.result as Record<string, unknown> | undefined;
          return result?.guidedReviewSnapshot === review.id || result?.id === review.id;
        })
      )
        throw new TrackerWriteRefused(
          "guided_review_legacy_receipts",
          "Legacy full-response receipts require payload retention; retirement needs an explicit compatibility decision",
        );
      const tombstone: GuidedReviewTombstone = {
        id: review.id,
        schemaVersion: 1,
        storeId: review.storeId,
        issueId: review.issueId,
        projectId: review.projectId,
        ...(review.runId === undefined ? {} : { runId: review.runId }),
        identity: review.identity,
        snapshotSha256: review.snapshotSha256,
        createdAt: review.createdAt,
        ...(review.createdByActor === undefined ? {} : { createdByActor: review.createdByActor }),
        updatedAt: now,
        updatedByActor: context.actor,
        retiredAt: now,
        retiredByActor: context.actor,
        retirementEventId: randomUUID(),
      };
      store.guidedReviews![store.guidedReviews!.indexOf(review)] = tombstone;
      return tombstone;
    }
    case "save_issue_view": {
      const project = issueViewProject(store, args);
      const existing = args.id === undefined ? undefined : savedIssueView(store, args);
      if (existing) assertUnchangedSince(existing, args);
      else refuseCreatePrecondition(args);
      const title = args.name === undefined ? existing?.name : (args.name as string).trim();
      const filter = (args.filter ?? existing?.filter) as Record<string, unknown> | undefined;
      if (!title || filter === undefined) throw new Error("A new saved view requires name and filter");
      if (JSON.stringify(filter).length > 8192) throw new Error("Saved filter exceeds 8192 characters");
      validateSavedFilter(store, project, filter, now);
      // Resolve and validate references through the normal list implementation.
      await dispatch(
        store,
        "list_issues",
        { ...filter, project: project.id, limit: 1 },
        options,
        now,
        context,
      );
      if (!existing && (store.issueViews?.length ?? 0) >= 1000) throw new Error("Saved view limit reached");
      if (
        (store.issueViews ?? []).some(
          (entry) => entry.projectId === project.id && entry.id !== existing?.id && entry.name === title,
        )
      )
        throw new Error("Saved view name already exists in this project");
      const view: SavedIssueView = {
        ...(existing ?? { id: randomUUID(), createdAt: now }),
        schemaVersion: 1,
        storeId: args.storeId as string,
        projectId: project.id,
        name: title,
        filter: structuredClone(filter),
        updatedAt: now,
      };
      store.issueViews ??= [];
      if (existing) store.issueViews[store.issueViews.indexOf(existing)] = view;
      else store.issueViews.push(view);
      return structuredClone(view);
    }
    case "post_delete_issue_view": {
      const view = savedIssueView(store, args);
      assertUnchangedSince(view, args);
      store.issueViews = store.issueViews!.filter((entry) => entry.id !== view.id);
      return { id: view.id, projectId: view.projectId, storeId: view.storeId, deleted: true };
    }
    case "get_issue_view":
      return structuredClone(savedIssueView(store, args));
    case "list_issue_views": {
      const project = issueViewProject(store, args);
      return page(
        order(
          (store.issueViews ?? []).filter((entry) => entry.projectId === project.id),
          args,
        ).map((entry) => ({ ...entry })),
        args,
        "views",
        name,
      );
    }
    case "list_issue_view_issues": {
      const view = savedIssueView(store, args);
      validateSavedFilter(store, issueViewProject(store, args), view.filter, now);
      return dispatch(
        store,
        "list_issues",
        {
          ...view.filter,
          project: view.projectId,
          ...Object.fromEntries(
            ["limit", "cursor", "orderBy"]
              .filter((key) => args[key] !== undefined)
              .map((key) => [key, args[key]]),
          ),
        },
        options,
        now,
        context,
      );
    }
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
      const found = (store.bundles ?? []).find((entry) => entry.id === args.bundleId);
      if (!found) throw new Error("Bundle not found");
      const bundle = owned(store.bundles!, found);
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
        const found = store.comments.find((entry) => entry.id === args.id);
        if (found === undefined) throw new Error(`Comment not found: ${String(args.id)}`);
        const comment = owned(store.comments, found);
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
      const update: StatusUpdate = existing
        ? owned(store.statusUpdates, existing)
        : {
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

/**
 * Snapshot list reads (LOCAL-VUH-43): the first page fixes the whole result in memory and
 * later pages read it, never the live store. Bounded and process-local, so a restart,
 * eviction or replaced store reports the snapshot expired.
 */
const listSnapshots = new Map<
  string,
  { storeId: string; syncId: number; scope: string; issues: unknown[]; size: number; readAt: number }
>();
const SNAPSHOT_IDLE_MS = 5 * 60_000;
const SNAPSHOT_COUNT = 16;
const SNAPSHOT_CHARACTERS = 32 * 1024 * 1024;

function snapshotCursor(cursor: unknown): { snapshot: string; offset: number; scope: string } | undefined {
  if (typeof cursor !== "string") return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof decoded.snapshot === "string" &&
      Number.isSafeInteger(decoded.offset) &&
      typeof decoded.scope === "string"
      ? (decoded as { snapshot: string; offset: number; scope: string })
      : undefined;
  } catch {
    return undefined;
  }
}

async function snapshotPage(
  store: Store,
  name: string,
  args: Record<string, unknown>,
  all: (filters: Record<string, unknown>) => Promise<unknown[]>,
): Promise<Record<string, unknown>> {
  const { cursor, limit, snapshot: _snapshot, ...filters } = args;
  const scope = createHash("sha256")
    .update(
      JSON.stringify({ tool: name, filters: Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)) }),
    )
    .digest("hex");
  const storeId = store.storeId ?? store.team.id;
  const now = Date.now();
  for (const [token, entry] of listSnapshots)
    if (now - entry.readAt > SNAPSHOT_IDLE_MS) listSnapshots.delete(token);
  let token: string;
  let start = 0;
  if (cursor !== undefined) {
    const decoded = snapshotCursor(cursor);
    if (decoded === undefined || decoded.scope !== scope)
      throw new Error("Tracker cursor belongs to a different query");
    const entry = listSnapshots.get(decoded.snapshot);
    if (entry === undefined || entry.storeId !== storeId)
      throw new Error(
        "Tracker snapshot expired; list again with snapshot: true, then follow list_changes from its syncId",
      );
    token = decoded.snapshot;
    start = decoded.offset;
  } else {
    const issues = await all(filters);
    token = randomUUID();
    listSnapshots.set(token, {
      storeId,
      syncId: store.syncId ?? 0,
      scope,
      issues,
      size: JSON.stringify(issues).length,
      readAt: now,
    });
    let retained = [...listSnapshots.values()].reduce((total, entry) => total + entry.size, 0);
    // Oldest read first; the new snapshot itself always stays.
    for (const [oldest, entry] of listSnapshots) {
      if (oldest === token || (listSnapshots.size <= SNAPSHOT_COUNT && retained <= SNAPSHOT_CHARACTERS))
        break;
      listSnapshots.delete(oldest);
      retained -= entry.size;
    }
  }
  const entry = listSnapshots.get(token)!;
  // Re-inserting keeps the map in least-recently-read order.
  listSnapshots.delete(token);
  listSnapshots.set(token, { ...entry, readAt: now });
  const selected = entry.issues.slice(start, start + (typeof limit === "number" ? limit : 50));
  const hasNextPage = start + selected.length < entry.issues.length;
  return {
    issues: selected,
    hasNextPage,
    ...(hasNextPage
      ? {
          cursor: Buffer.from(
            JSON.stringify({ snapshot: token, offset: start + selected.length, scope }),
          ).toString("base64url"),
        }
      : {}),
    syncId: entry.syncId,
    storeId: entry.storeId,
  };
}

/** Reads, including the caller's own write receipts and the audit log. */
async function read(
  store: Store,
  name: string,
  args: Record<string, unknown>,
  options: LocalTrackerOptions,
  actor: TrackerActor,
  now: string,
  receiptResult: (receipt: WriteReceipt) => Promise<unknown> = async (receipt) => receipt.result,
): Promise<unknown> {
  if (
    (name === "list_issues" || name === "list_ready_issues") &&
    (args.snapshot === true || snapshotCursor(args.cursor) !== undefined)
  )
    return snapshotPage(store, name, args, async (filters) => {
      const result = (await dispatch(
        store,
        name,
        { ...filters, limit: Number.MAX_SAFE_INTEGER },
        options,
        now,
        { actor },
      )) as { issues: unknown[] };
      return result.issues;
    });
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
        ? { result: replayGuidedReviewReceipt(store, await receiptResult(receipt)) }
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

/**
 * Stable normalized objects: the app owns projections, the server owns fields and references.
 * A model whose data or groups derive from another record must be named in syncCandidates too.
 */
function syncModels(store: Store, wanted?: ReadonlySet<string>): TrackerSyncModel[] {
  const models: TrackerSyncModel[] = [];
  // A wanted set names a few records; by model, so a collection with none is not walked.
  const wantedIds = new Map<string, Set<string>>();
  for (const key of wanted ?? []) {
    const at = key.indexOf(":");
    const ids = wantedIds.get(key.slice(0, at)) ?? new Set<string>();
    wantedIds.set(key.slice(0, at), ids.add(key.slice(at + 1)));
  }
  const want = (modelName: TrackerSyncModel["modelName"], id: string) =>
    wanted === undefined || wantedIds.get(modelName)?.has(id) === true;
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
    if (wanted !== undefined && !wantedIds.has(modelName)) return;
    for (const entry of entries) {
      if (!want(modelName, (entry as { id: string }).id)) continue;
      const data = structuredClone(entry) as Record<string, unknown>;
      models.push({ modelName, modelId: data.id as string, projectIds: groups(data), data });
    }
  };
  add(
    "issue",
    store.issues
      .filter((issue) => want("issue", issue.id))
      .map((issue) => ({
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
      .filter((issue) => issue.lease && want("lease", issue.id))
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
/** Bodies a lazy reader fetches on demand (get_issue, list_comments or batch), not in bulk. */
const LAZY_SYNC_FIELDS: Partial<Record<TrackerSyncModel["modelName"], readonly string[]>> = {
  comment: ["body", "quotedText"],
  run: ["summary", "worktree", "branch"],
  event: ["body"],
};
function lazySyncModel(model: TrackerSyncModel): TrackerSyncModel {
  const data = { ...model.data };
  const omitted = [...(LAZY_SYNC_FIELDS[model.modelName] ?? [])];
  for (const field of omitted) delete data[field];
  if (omitted.length) data.unhydratedFields = omitted;
  return { ...model, data };
}
/** Records in one list and not the other, by identity; an append compares only its tail. */
function identityChanges<T extends object>(previous: readonly T[] = [], current: readonly T[] = []): T[] {
  if (previous === current) return [];
  let start = 0;
  while (start < previous.length && start < current.length && previous[start] === current[start]) start++;
  const before = new Set(previous.slice(start));
  const after = new Set(current.slice(start));
  return [
    ...[...after].filter((entry) => !before.has(entry)),
    ...[...before].filter((entry) => !after.has(entry)),
  ];
}
type SyncSource = [TrackerSyncModel["modelName"], (store: Store) => readonly { id: string }[] | undefined];
const SYNC_SOURCES: SyncSource[] = [
  ["issue", (store) => store.issues],
  ["project", (store) => store.projects],
  ["milestone", (store) => store.milestones],
  ["document", (store) => store.documents],
  ["comment", (store) => store.comments],
  ["cycle", (store) => store.cycles],
  ["status_update", (store) => store.statusUpdates],
  ["run", (store) => store.runs],
  ["bundle", (store) => store.bundles],
  ["event", (store) => store.events],
  ["release", (store) => store.releases],
  ["label", (store) => store.labels],
  ["issue_status", (store) => store.issueStatuses],
  ["project_status", (store) => store.projectStatuses],
  ["team", (store) => [store.team]],
  ["user", (store) => [store.user, ...(store.actors ?? [])]],
];
/**
 * The sync models a write may have changed (LOCAL-VUH-42). Committed records are frozen, so a
 * changed record is a new object; add what derives from one: an issue's lease and owner asks,
 * and the groups of everything that follows a moved issue, document or status update. A
 * superset of the real changes, so appendSync's comparison still decides each delta.
 */
function syncCandidates(before: Store, store: Store): Set<string> {
  const wanted = new Set<string>();
  const changed = new Map<string, { id: string }[]>();
  for (const [modelName, source] of SYNC_SOURCES) {
    const entries = identityChanges(source(before), source(store));
    changed.set(modelName, entries);
    for (const entry of entries) wanted.add(`${modelName}:${entry.id}`);
  }
  for (const ref of identityChanges(before.ownerAsks, store.ownerAsks)) wanted.add(`issue:${ref.issueId}`);
  const issues = new Set<string>();
  for (const key of wanted) if (key.startsWith("issue:")) issues.add(key.slice("issue:".length));
  const projectOf = (target: Store, id: string) => target.issues.find((issue) => issue.id === id)?.projectId;
  const moved = new Set([...issues].filter((id) => projectOf(before, id) !== projectOf(store, id)));
  const documents = new Set((changed.get("document") ?? []).map((entry) => entry.id));
  const updates = new Set((changed.get("status_update") ?? []).map((entry) => entry.id));
  for (const id of issues) wanted.add(`lease:${id}`);
  if (moved.size + documents.size + updates.size === 0) return wanted;
  for (const target of [before, store]) {
    for (const document of target.documents ?? [])
      if (moved.has(document.issueId as string)) documents.add(document.id);
    for (const comment of target.comments)
      if (
        moved.has(comment.issueId as string) ||
        documents.has(comment.documentId as string) ||
        updates.has(comment.statusUpdateId as string)
      )
        wanted.add(`comment:${comment.id}`);
    for (const [modelName, entries] of [
      ["document", target.documents ?? []],
      ["run", target.runs ?? []],
      ["bundle", target.bundles ?? []],
      ["event", target.events ?? []],
    ] as const)
      for (const entry of entries)
        if (moved.has(entry.issueId as string)) wanted.add(`${modelName}:${entry.id}`);
    for (const release of target.releases ?? [])
      if (release.items.some((item) => item.issueId !== undefined && moved.has(item.issueId)))
        wanted.add(`release:${release.id}`);
  }
  return wanted;
}
function appendSync(
  before: Store,
  store: Store,
  actor: TrackerActor,
  tool: string,
  at: string,
  key?: string,
): void {
  const deltas = syncDeltas(before, store, syncCandidates(before, store));
  // Every test write proves the incremental diff equals the full one (LOCAL-VUH-42).
  if (process.env.VITEST && canonical(deltas) !== canonical(syncDeltas(before, store)))
    throw new Error(`Incremental sync diff diverged from the full diff for ${tool}`);
  const body = {
    syncId: (store.syncId ?? 0) + 1,
    actor: { ...actor },
    tool,
    at,
    ...(key === undefined ? {} : { idempotencyKey: key }),
    deltas,
    prevHash: store.syncLog?.at(-1)?.hash ?? store.syncBase?.hash ?? "",
  };
  store.syncId = body.syncId;
  (store.syncLog ??= []).push({ ...body, hash: auditHash(body) });
}
function syncDeltas(before: Store, store: Store, wanted?: ReadonlySet<string>): TrackerSyncCommit["deltas"] {
  const prior = new Map(syncModels(before, wanted).map((model) => [syncModelKey(model), model]));
  const deltas: TrackerSyncCommit["deltas"] = [];
  for (const model of syncModels(store, wanted)) {
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
  return deltas;
}

/**
 * One commit as one project sees it (list_changes): changed fields and ids, lazy bodies left
 * out. Entering the project reads as an insert and leaving it as a delete. Undefined when
 * nothing in the commit belongs to the project.
 */
function projectChanges(commit: TrackerSyncCommit, projectId: string): Record<string, unknown> | undefined {
  const changes = commit.deltas.flatMap((delta) => {
    const inside = delta.projectIds.includes(projectId);
    const before = delta.previousProjectIds.includes(projectId);
    if (!inside && !before) return [];
    const action = !inside ? "delete" : delta.action === "update" && !before ? "insert" : delta.action;
    const fields = { ...delta.data };
    const omitted = (LAZY_SYNC_FIELDS[delta.modelName] ?? []).filter((field) => field in fields);
    for (const field of omitted) delete fields[field];
    return [
      {
        model: delta.modelName,
        id: delta.modelId,
        action,
        ...(action === "delete" ? {} : { fields }),
        ...(action === "update" && delta.removedFields.length ? { removedFields: delta.removedFields } : {}),
        ...(action !== "delete" && omitted.length ? { omitted } : {}),
      },
    ];
  });
  if (!changes.length) return undefined;
  const actor = commit.actor as Partial<TrackerActor>;
  return {
    syncId: commit.syncId,
    at: commit.at,
    tool: commit.tool,
    actor: { type: actor.type, id: actor.id, ...(actor.name === undefined ? {} : { name: actor.name }) },
    changes,
  };
}
const CHANGES_CHARACTERS = 40_000;
const CHANGES_SCAN = 2_000;

/**
 * Item-event subscribers per store file, shared by every backend instance in the process:
 * a project-scoped instance (a `builtin` repo's writes) publishes to the owner loop too.
 */
const eventListeners = new Map<string, Set<TrackerEventListener>>();

/** Only these original branches have been audited for the strict no-effect contract. */
function strictReadOperation(
  name: string,
  options: LocalTrackerOptions,
): TrackerReadSnapshot["operation"] | undefined {
  // load invokes a caller-authored clock before classification; its purity is unproved.
  if (options.clock !== undefined) return undefined;
  switch (name) {
    case "get_issue":
    case "get_user":
      return name;
    case "list_runs":
      // runView may call arbitrary host code; that callback has no purity contract.
      return options.runner === undefined ? name : undefined;
    default:
      return undefined;
  }
}

interface LockedReadIdentity {
  readonly canonicalDirectory: string;
  readonly directory: BigIntStats;
  readonly file: BigIntStats;
  readonly bytes: Buffer;
  /** The journal's state beside those bytes; a commit appends there without touching them. */
  readonly journal: string;
}

const sameFile = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;

/** Synchronous so no target substitution can cross the host's final commit fence. */
function assertReadIdentity(directory: string, path: string, identity: LockedReadIdentity): void {
  if (
    realpathSync(directory) !== identity.canonicalDirectory ||
    realpathSync(path) !== join(identity.canonicalDirectory, "tracker.json") ||
    !sameFile(statSync(directory, { bigint: true }), identity.directory) ||
    !sameFile(statSync(path, { bigint: true }), identity.file) ||
    !readFileSync(path).equals(identity.bytes) ||
    journalVersion(directory) !== identity.journal ||
    !sameFile(statSync(path, { bigint: true }), identity.file) ||
    realpathSync(path) !== join(identity.canonicalDirectory, "tracker.json") ||
    realpathSync(directory) !== identity.canonicalDirectory ||
    !sameFile(statSync(directory, { bigint: true }), identity.directory)
  )
    throw new Error("The original tracker READ target changed");
}

/** Durable local Linear-shaped tracker, also used as ancillary storage for repo backends. */
/**
 * An item's status spans, replayed from its event stream. State events name their
 * status; created and stage-family events carry it since VUH-2282, and older ones
 * fall back to the status their stage maps to.
 */
function statusSpans(store: Store, issue: Issue): OutcomeStateSpan[] {
  const byName = (name: string) => store.issueStatuses.find((status) => status.name === name);
  const changes: { at: string; status: Status | undefined }[] = [];
  let initial: Status | undefined;
  let leadClosed = false;
  // Imported history is appended in provider order; replay in time order (seq breaks ties).
  const events = (store.events ?? [])
    .filter((event) => event.issueId === issue.id)
    .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
  for (const event of events) {
    if (event.type === "created") {
      if (event.status !== undefined) initial = byName(event.status);
    } else if (event.type === "state" && event.to !== undefined) {
      if (changes.length === 0 && initial === undefined && event.from) initial = byName(event.from);
      if (event.bundleId !== undefined) leadClosed = true;
      changes.push({ at: event.at, status: byName(event.to) });
    } else if (event.type === "stage" || event.type === "verified" || event.type === "reopened") {
      // A forward stage after lead closure leaves the completed status in place.
      if (event.status !== undefined) changes.push({ at: event.at, status: byName(event.status) });
      else if (event.type !== "stage" || !leadClosed)
        changes.push({ at: event.at, status: statusForStage(store, event.to as DeliveryStage) });
      if (event.type !== "stage") leadClosed = false;
    }
  }
  const current = store.issueStatuses.find((status) => status.id === issue.statusId)!;
  initial ??= changes.length === 0 ? current : statusForStage(store, "reported");
  const spans: { state: { name: string; type: string }; startedAt: string; endedAt: string | null }[] = [];
  for (const change of [{ at: issue.createdAt, status: initial }, ...changes]) {
    const status = change.status ?? current;
    // A change at the same instant (an import's first span) replaces what it follows.
    while (spans.length > 0 && spans.at(-1)!.startedAt >= change.at) spans.pop();
    const last = spans.at(-1);
    if (last?.state.name === status.name) {
      last.endedAt = null;
      continue;
    }
    if (last) last.endedAt = change.at;
    spans.push({ state: { name: status.name, type: status.type }, startedAt: change.at, endedAt: null });
  }
  return spans;
}

function builtInOutcomes(
  store: Store,
  input: { projectId: string; window: OutcomeWindow; history?: boolean; media?: boolean; asOf?: string },
  readAt: string,
): TrackerOutcomes {
  findProject(store, input.projectId);
  const members = store.issues.filter((issue) => issue.projectId === input.projectId);
  const spans = new Map(members.map((issue) => [issue.id, statusSpans(store, issue)]));
  const recentComments = new Map<string, Comment[]>();
  if (input.media) {
    const memberIds = new Set(members.map((issue) => issue.id));
    for (const comment of store.comments) {
      if (comment.issueId === null || !memberIds.has(comment.issueId)) continue;
      const recent = [...(recentComments.get(comment.issueId) ?? []), comment]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 3);
      recentComments.set(comment.issueId, recent);
    }
  }
  const issues = members.map((issue): OutcomeIssue => {
    const status = store.issueStatuses.find((entry) => entry.id === issue.statusId)!;
    const last = spans.get(issue.id)!.at(-1);
    // An imported parent outside the project keeps its provider identifier in the mirror record.
    const parent =
      issue.parentId === null
        ? undefined
        : (store.issues.find((entry) => entry.id === issue.parentId) ??
          (store.linearMirror?.records.issues ?? [])
            .map((record) => linearRow(record.parent))
            .find((record) => record.id === issue.parentId));
    return {
      id: issue.id,
      identifier: issue.identifier,
      media: !input.media
        ? []
        : [
            ...outcomeMedia(issue.description, issue.updatedAt),
            ...(recentComments.get(issue.id) ?? []).flatMap((comment) =>
              outcomeMedia(comment.body, comment.updatedAt),
            ),
          ],
      title: issue.title,
      state: { name: status.name, type: status.type },
      completedAt: status.type === "completed" && last?.state.type === "completed" ? last.startedAt : null,
      parent:
        issue.parentId === null
          ? null
          : { id: issue.parentId, identifier: String(parent?.identifier ?? issue.parentId) },
      hasChildren: store.issues.some((entry) => entry.parentId === issue.id),
      milestoneId: issue.milestoneId ?? null,
    };
  });
  const history: OutcomeHistory[] | undefined = input.history
    ? members
        .filter(
          (issue) =>
            issue.updatedAt >= input.window.since ||
            store.issueStatuses.find((status) => status.id === issue.statusId)?.type === "started",
        )
        .map((issue) => ({ id: issue.id, identifier: issue.identifier, spans: spans.get(issue.id)! }))
    : undefined;
  return summarizeOutcomes({
    tracker: "built-in",
    projectId: input.projectId,
    window: input.window,
    readAt,
    ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
    issues,
    milestones: (store.milestones ?? [])
      .filter((entry) => linearId(entry.project) === input.projectId || entry.projectId === input.projectId)
      .map((entry) => ({ id: entry.id, name: String(entry.name) })),
    milestoneIssues: issues,
    statusUpdates: store.statusUpdates
      .filter((update) => update.projectId === input.projectId)
      .map((update) => ({
        id: update.id,
        createdAt: update.createdAt,
        url: localUrl("status-update", update.id),
        health: update.health,
      })),
    ...(history === undefined ? {} : { history }),
    caveats: [
      "Project membership is current: an issue that moved projects counts where it sits now.",
      ...(members.some((issue) =>
        (store.events ?? []).some(
          (event) => event.issueId === issue.id && event.type === "created" && event.status === undefined,
        ),
      )
        ? [
            "Items created before VUH-2282 start in the status their first recorded change left, or the reported stage's status.",
          ]
        : []),
    ],
  });
}

function ownerAskLinks(store: Store, projectId: string): OwnerAskLink[] {
  const links: OwnerAskLink[] = [];
  const eventIds = new Set<string>();
  const requestIds = new Set<string>();
  for (const ref of store.ownerAsks ?? []) {
    // A repeated event or request is ambiguous; never retarget by first match.
    if (eventIds.has(ref.eventId) || requestIds.has(ref.requestId))
      throw new Error("Owner ask links are ambiguous");
    eventIds.add(ref.eventId);
    requestIds.add(ref.requestId);
    const issue = store.issues.find((entry) => entry.id === ref.issueId);
    const event = store.events?.find((entry) => entry.id === ref.eventId);
    if (!issue || !event || event.issueId !== issue.id)
      throw new Error("Owner ask link lost its source event or issue");
    const purpose = ownerAskSourcePurpose(event);
    if (purpose === undefined) throw new Error("Owner ask link source event is not an owner-ask source");
    if (purpose === "gate") {
      const run = store.runs?.find((entry) => entry.id === event.runId && entry.issueId === issue.id);
      // Use the real gate's event identity, not a request ID or a copied blocked flag.
      if (run?.status !== "active" || !run.pendingGates?.includes(event.id)) continue;
    }
    const category = store.issueStatuses.find((status) => status.id === issue.statusId)?.type;
    if (
      category === "canceled" ||
      issue.stage === "owner-verified" ||
      (category === "completed" && purpose !== "verify")
    )
      continue;
    if (issue.projectId === projectId)
      links.push({ eventId: ref.eventId, issueId: ref.issueId, requestId: ref.requestId, purpose });
  }
  return links;
}

export function createLocalTracker(options: LocalTrackerOptions): LocalTrackerBackend {
  const directory = resolve(options.directory);
  const path = join(directory, "tracker.json");
  const fileVersion = () => {
    const file = statSync(path, { bigint: true });
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
  };
  /** Both halves of the committed store: any commit, by anyone, changes one of them. */
  const storeVersion = () => `${fileVersion()}|${journalVersion(directory)}`;
  const listeners = eventListeners.get(path) ?? new Set<TrackerEventListener>();
  eventListeners.set(path, listeners);
  // The committed snapshot is frozen, so reads share it and writes take a draft of it. Every
  // backend for this file in the process shares it too: production opens a scoped instance per
  // hire call, and none should re-parse another's commit.
  const shared = committedStores.get(path) ?? {};
  committedStores.set(path, shared);
  /** `tracker.json` as committed: the single legacy file, or a checkpoint plus its journal tail. */
  const openCommitted = async (bytes: Buffer, version: string): Promise<Committed> => {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const parsed = parseStore(bytes.toString("utf8"));
    const header = parsed.journal;
    if (header === undefined) return { version, digest, bytes: bytes.length, store: settle(parsed) };
    delete parsed.journal;
    const tail = await readJournalTail(directory, header, { verified: verifiedSegments });
    if (tail.live === undefined) throw new Error("Tracker journal has no segment to append to");
    return {
      version,
      digest,
      bytes: bytes.length,
      store: settle(replayVerified(parsed, tail.records)),
      journal: { header, live: tail.live, bytes: tail.bytes, checkpointBytes: bytes.length },
    };
  };
  /** Another process or backend committed: replay its journal records, or reopen. */
  const refresh = async (version: string, read?: Buffer): Promise<Committed> => {
    const bytes = read ?? (await readFile(path));
    const current = shared.current;
    // Only byte-identical, already validated content may skip parsing/auditing.
    if (current !== undefined && createHash("sha256").update(bytes).digest("hex") === current.digest) {
      if (current.journal === undefined) return { ...current, version };
      try {
        const head = current.store.syncLog?.at(-1) ?? current.store.syncBase!;
        const tail = await readJournalTail(directory, current.journal.header, {
          verified: false,
          after: { syncId: current.store.syncId ?? 0, hash: head.hash },
        });
        if (tail.live !== undefined)
          return {
            ...current,
            version,
            store: settle(replayVerified(current.store, tail.records)),
            journal: { ...current.journal, live: tail.live, bytes: tail.bytes },
          };
      } catch {
        // Anything but a clean continuation reopens from the checkpoint and proves it all again.
      }
    }
    return openCommitted(bytes, version);
  };
  const readStore = async (mutable = true): Promise<Store> => {
    // A different process can replace or edit the store, so every read checks
    // the store's version. Its identity, size and timestamps change with any
    // write; ctime also catches an in-place edit that restores mtime. Reading
    // the whole store on each call was the service's main allocation churn
    // (VUH-2379). The version is taken before the read, so a racing write
    // leaves a stale version that the next read misses.
    const version = storeVersion();
    if (shared.current?.version !== version) shared.current = await refresh(version);
    return mutable ? draftOf(shared.current.store) : shared.current.store;
  };
  /** Set after each durable commit: the store version that commit left. */
  let landed: string | undefined;
  /**
   * Our own commit becomes the snapshot the next call reuses, without reading it back. A
   * journal-backed store appends one record; a small one rewrites its single file, and moves
   * to the journal before the commit that would cost more than the threshold.
   */
  const commit = async (store: Store, assertHeld: () => void, callOptions?: TrackerToolCallOptions) => {
    let current = shared.current;
    if (current !== undefined && current.journal === undefined && current.bytes > JOURNAL_THRESHOLD_BYTES)
      current = shared.current = await migrateToJournal(current, assertHeld);
    const confirmed = {
      ...callOptions,
      effectConfirmed: () => {
        landed = storeVersion();
        callOptions?.effectConfirmed?.();
      },
    };
    if (current?.journal !== undefined) {
      shared.current = await appendCommit(current, store, assertHeld, confirmed);
      if (
        shared.current.journal!.bytes >=
        Math.max(CHECKPOINT_MIN_BYTES, shared.current.journal!.checkpointBytes / 8)
      )
        scheduleCheckpoint();
      return;
    }
    const bytes = await persist(path, store, assertHeld, confirmed);
    // Exactly what reopening these bytes would hold: open binds stage statuses after reading.
    bindStageStatuses(store);
    shared.current = {
      version: storeVersion(),
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      store: settle(store, current?.store),
    };
  };
  const appendCommit = async (
    current: Committed,
    store: Store,
    assertHeld: () => void,
    callOptions: TrackerToolCallOptions,
  ): Promise<Committed> => {
    const journal = current.journal!;
    const base = current.store;
    const added = (store.syncLog ?? []).filter((entry) => entry.syncId > (base.syncId ?? 0));
    if (added.length !== 1 || store.syncId !== (base.syncId ?? 0) + 1)
      throw new Error("A journal commit carries exactly one sync commit");
    const record = { syncId: store.syncId, commit: added[0]!, ...storeChanges(base, store, JOURNAL_SKIP) };
    const line = `${JSON.stringify(record)}\n`;
    await callOptions.beforeWrite?.();
    const size = await appendJournal(directory, journal.live, line, () => {
      assertHeld();
      callOptions.onDispatch?.();
    });
    callOptions.effectConfirmed?.();
    return {
      ...current,
      version: storeVersion(),
      store: settle(
        {
          ...store,
          ...(base.syncBase === undefined ? {} : { syncBase: base.syncBase }),
          syncLog: [...(base.syncLog ?? []), added[0]!],
        },
        base,
      ),
      journal: {
        ...journal,
        live: { name: journal.live.name, size },
        bytes: journal.bytes + size - journal.live.size,
      },
    };
  };
  /**
   * One-time move of a large single-file store onto the journal, under the store lock. Its exact
   * bytes are kept beside it first; its sync history becomes the first sealed segment; the
   * checkpoint rename is the switch. Until then the single file stays authoritative, and a
   * journal left by an interrupted attempt is set aside.
   */
  const migrateToJournal = async (current: Committed, assertHeld: () => void): Promise<Committed> => {
    await copyFile(path, join(directory, `tracker.pre-journal-${Date.now()}.json`), constants.COPYFILE_EXCL);
    await setJournalAside(directory, "unused");
    const store = current.store;
    const history = store.syncLog ?? [];
    const sealed = history.length
      ? [
          await writeSegment(
            directory,
            1,
            history.map((entry) => `${JSON.stringify({ syncId: entry.syncId, commit: entry })}\n`),
          ),
        ]
      : [];
    const header: JournalHeader = {
      version: 1,
      syncId: store.syncId ?? 0,
      syncHash: history.at(-1)?.hash ?? "",
      since: store.syncId ?? 0,
      sealed,
    };
    const live = await startSegment(directory, header.syncId + 1);
    const checkpoint = await writeCheckpoint(store, header, assertHeld);
    return {
      version: storeVersion(),
      ...checkpoint,
      store: settle(compactedStore(store, header)),
      journal: { header, live: { name: live, size: 0 }, bytes: 0, checkpointBytes: checkpoint.bytes },
    };
  };
  /** Writes a checkpoint to a temp file and renames it in once `ready` passes under the lock. */
  const writeCheckpoint = async (store: Store, header: JournalHeader, ready: () => void) => {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const written = await writeCheckpointFile(checkpointContent(store, header), temp);
      ready();
      await rename(temp, path);
      return { digest: written.sha256, bytes: written.bytes };
    } finally {
      await rm(temp, { force: true });
    }
  };
  /**
   * Seals the live segments and starts a new one under the lock, writes the checkpoint of that
   * frozen snapshot with no lock held, then renames it in under the lock if nothing replaced the
   * store meanwhile. Commits keep appending throughout; a crash at any point reopens from the
   * previous checkpoint and replays every segment after it.
   */
  const checkpointNow = async (): Promise<void> => {
    const started = await withTrackerStoreLock(path, async (assertHeld) => {
      try {
        await readStore(false);
      } catch (error) {
        if (codeOf(error) === "ENOENT") return undefined;
        throw error;
      }
      let current = shared.current!;
      // The host checkpoints at start, so a large single-file store moves then, not in a write.
      if (current.journal === undefined && current.bytes > JOURNAL_THRESHOLD_BYTES)
        current = shared.current = await migrateToJournal(current, assertHeld);
      if (current.journal === undefined || current.journal.bytes === 0) return undefined;
      const names = (await readdir(join(directory, JOURNAL_DIRECTORY)))
        .filter((name) => /^\d{12}\.jsonl$/u.test(name))
        .sort();
      const unsealed = names.slice(current.journal.header.sealed.length);
      const sealed = [...current.journal.header.sealed];
      for (const name of unsealed) sealed.push(await sealSegment(directory, name));
      const syncId = current.store.syncId ?? 0;
      const header: JournalHeader = {
        version: 1,
        syncId,
        syncHash: (current.store.syncLog?.at(-1) ?? current.store.syncBase!).hash,
        since: current.journal.header.since,
        sealed,
      };
      const live = await startSegment(directory, syncId + 1);
      shared.current = {
        ...current,
        version: storeVersion(),
        journal: { ...current.journal, live: { name: live, size: 0 }, bytes: 0 },
      };
      return { store: current.store, header, base: fileVersion() };
    });
    if (started === undefined) return;
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const written = await writeCheckpointFile(checkpointContent(started.store, started.header), temp);
      await withTrackerStoreLock(path, async (assertHeld) => {
        // Only the checkpoint this one extends may be replaced.
        if (fileVersion() !== started.base) return;
        assertHeld();
        await rename(temp, path);
        const current = shared.current;
        if (current?.journal === undefined || current.digest === written.sha256) return;
        shared.current = {
          ...current,
          version: storeVersion(),
          digest: written.sha256,
          bytes: written.bytes,
          store: settle(compactedStore(current.store, started.header)),
          journal: { ...current.journal, header: started.header, checkpointBytes: written.bytes },
        };
      });
    } finally {
      await rm(temp, { force: true });
    }
  };
  const scheduleCheckpoint = () => {
    if (checkpoints.has(path)) return;
    const running = checkpointNow()
      // allow-swallowed-rejection -- a failed checkpoint loses nothing: commits are already durable, and the next one retries
      .catch(() => {})
      .finally(() => checkpoints.delete(path));
    checkpoints.set(path, running);
  };
  /** A receipt's full result, from its journal record when the checkpoint left it there. */
  const receiptResult = async (receipt: WriteReceipt): Promise<unknown> => {
    if (receipt.resultInJournal !== true) return receipt.result;
    const record = await readJournalRecord(directory, receipt.syncId!);
    const full = ((record?.append?.receipts ?? []) as WriteReceipt[]).find(
      (entry) => entry.actorKey === receipt.actorKey && entry.idempotencyKey === receipt.idempotencyKey,
    );
    if (full === undefined)
      throw new Error("This write receipt's result is missing from the tracker journal");
    return full.result;
  };
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
    const before = settle(store, shared.current?.store);
    const now = nextWriteTime(store, clock);
    const fields = Object.keys(request).sort();
    let result: unknown;
    const context: WriteContext = {
      actor,
      ...(callOptions?.via === undefined ? {} : { via: callOptions.via }),
      ...(callOptions?.authorizeLeadClosure === undefined
        ? {}
        : { authorizeLeadClosure: callOptions.authorizeLeadClosure }),
      closureFences: [],
    };
    const firstEvent = (store.events?.length ?? 0) + 1;
    try {
      // Linear stays authoritative until cutover (ADR 0181): a mirror changes only from Linear.
      if (mirroring(store))
        throw new TrackerWriteRefused(
          "mirror_read_only",
          "This store mirrors Linear; make the change in Linear until cutover",
        );
      result = await apply(store, now, context);
      if (name === "save_guided_review" || name === "post_guided_finding") {
        // Project exactly the actor stamps and compact result receipt persisted below.
        // This runs inside the rollback path, so a budget refusal keeps the previous snapshot.
        const review = result as GuidedReviewRecord;
        if (review.createdAt >= now) review.createdByActor = actor;
        review.updatedByActor = actor;
        assertGuidedReviewBudget(store, review, name);
      }
      await recordIssueChanges(before, store, name, context, now);
    } catch (error) {
      // Nothing the write changed survives. The refusal itself is recorded,
      // so a keyed retry answers the same and the audit log shows the attempt.
      const refusal =
        error instanceof TrackerWriteRefused
          ? error
          : new TrackerWriteRefused(
              "invalid_request",
              error instanceof Error ? `${error.message}${frozenRecordSite(error)}` : String(error),
            );
      const detail = refusal.message.replace(/^Write refused \([^)]*\): /u, "");
      store = draftOf(before);
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
          syncId: (store.syncId ?? 0) + 1,
        });
      // Inbox refusals still require live mailbox/project/store authority before bookkeeping.
      appendSync(before, store, actor, name, now, key);
      await commit(store, assertHeld, INBOX_TOOLS.has(name) ? callOptions : undefined);
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
        if (derived.leadCompletion !== undefined) view.leadCompletion = derived.leadCompletion;
        else delete view.leadCompletion;
      }
    }
    const settled = structuredClone(result);
    const publicResult = ["save_guided_review", "post_guided_finding", "post_retire_guided_review"].includes(
      name,
    )
      ? guidedReviewMutationReceipt(settled as StoredGuidedReview, name, actor)
      : settled;
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
        result: publicResult,
        syncId: (store.syncId ?? 0) + 1,
      });
    appendSync(before, store, actor, name, now, key);
    await commit(store, assertHeld, {
      ...callOptions,
      onDispatch: () => {
        for (const fence of context.closureFences ?? []) fence();
        callOptions?.onDispatch?.();
        for (const fence of context.closureFences ?? []) fence();
      },
    });
    for (const listener of syncListeners.get(path) ?? []) listener();
    publish(store.events?.slice(firstEvent - 1) ?? []);
    return publicResult;
  };
  const loadExisting = async (mutable: boolean, captureRead: boolean) => {
    let origin: Pick<LockedReadIdentity, "canonicalDirectory" | "directory"> | undefined;
    if (captureRead) {
      try {
        const canonicalDirectory = realpathSync(directory);
        const directoryIdentity = statSync(directory, { bigint: true });
        if (
          directoryIdentity.isDirectory() &&
          directoryIdentity.ino > 0n &&
          directoryIdentity.birthtimeNs > 0n
        )
          origin = { canonicalDirectory, directory: directoryIdentity };
      } catch {
        // An unproven canonical incarnation keeps the ordinary path, without READ proof.
      }
    }
    if (origin === undefined) return { store: await readStore(mutable), readIdentity: undefined };
    // Proof binds the exact bytes this call parses, so it reads them itself rather
    // than trusting a cached version taken outside this file handle.
    let readIdentity: LockedReadIdentity | undefined;
    let bytes: Buffer;
    let version: string;
    const journal = journalVersion(directory);
    const file = await open(path, "r");
    try {
      const before = await file.stat({ bigint: true });
      bytes = await file.readFile();
      const after = await file.stat({ bigint: true });
      version = `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}|${journal}`;
      if (
        before.isFile() &&
        before.ino > 0n &&
        before.birthtimeNs > 0n &&
        sameFile(before, after) &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        journalVersion(directory) === journal
      )
        readIdentity = { ...origin, file: after, bytes, journal };
    } finally {
      await file.close();
    }
    if (shared.current?.version !== version) shared.current = await refresh(version, bytes);
    if (readIdentity !== undefined) {
      try {
        assertReadIdentity(directory, path, readIdentity);
      } catch {
        readIdentity = undefined;
      }
    }
    return { store: mutable ? draftOf(shared.current.store) : shared.current.store, readIdentity };
  };
  const load = async ({
    mutable = true,
    captureRead = false,
  }: { mutable?: boolean; captureRead?: boolean } = {}) => {
    const clock = (options.clock ?? (() => new Date()))().toISOString();
    try {
      return { ...(await loadExisting(mutable, captureRead)), clock, initialized: false };
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
      return { store: seed(options, clock), clock, initialized: true, readIdentity: undefined };
    }
  };
  /**
   * list_changes (LOCAL-VUH-43): one project's view of the sync journal, read through
   * `sync` subscribe so its cursor, long poll and rebootstrap rules apply unchanged.
   */
  const listChanges = async (
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> => {
    if (typeof args.project !== "string")
      throw new Error("list_changes needs a project (a hired worker's comes from its hire)");
    if (args.since !== undefined && args.storeId === undefined)
      throw new Error("list_changes since needs the storeId returned with that syncId");
    const limit = (args.limit as number | undefined) ?? 50;
    const deadline = Date.now() + ((args.waitMs as number | undefined) ?? 0);
    const head = await withTrackerStoreLock(path, async (assertHeld) => {
      const { store, initialized } = await load({ mutable: false });
      if (initialized) await persist(path, store, assertHeld);
      return {
        storeId: store.storeId ?? store.team.id,
        syncId: store.syncId ?? 0,
        projectId: findProject(store, args.project as string).id,
      };
    });
    const storeId = (args.storeId as string | undefined) ?? head.storeId;
    let cursor = (args.since as number | undefined) ?? head.syncId;
    const changes: Record<string, unknown>[] = [];
    let characters = 0;
    let scanned = 0;
    for (;;) {
      const page = await backend.sync(
        {
          action: "subscribe",
          projects: [head.projectId],
          storeId,
          lastSyncId: cursor,
          // Wait only while nothing has matched; skipped commits keep the remaining wait.
          waitMs: changes.length ? 0 : Math.max(0, deadline - Date.now()),
          limit: 250,
        },
        undefined,
        signal,
      );
      if (page.outcome === "rebootstrap")
        return {
          outcome: "rebootstrap",
          reason: page.reason,
          storeId: page.storeId,
          syncId: page.lastSyncId,
        };
      if (page.outcome !== "deltas") throw new Error("Unexpected tracker sync result");
      for (const commit of page.commits) {
        const seen = projectChanges(commit, head.projectId);
        if (seen !== undefined) {
          const size = JSON.stringify(seen).length;
          if (changes.length && (changes.length >= limit || characters + size > CHANGES_CHARACTERS))
            return { outcome: "changes", storeId, syncId: cursor, changes, hasMore: true };
          changes.push(seen);
          characters += size;
        }
        cursor = commit.syncId;
        scanned += 1;
      }
      if (page.hasMore && scanned < CHANGES_SCAN) continue;
      if (page.hasMore || changes.length || Date.now() >= deadline)
        return { outcome: "changes", storeId, syncId: cursor, changes, hasMore: page.hasMore };
    }
  };
  const backend: LocalTrackerBackend = {
    catalog: () => TRACKER_TOOLS,
    async strictGetUser(beforeRead) {
      if (
        options.clock ||
        options.runner ||
        options.issueResolver ||
        options.assertIssueWrite ||
        options.validateEvidence
      )
        throw new Error("Strict fixture read forbids custom callbacks");
      const privateFile = (target: string, directoryOnly = false) => {
        const stat = lstatSync(target, { bigint: true });
        if (
          realpathSync(target) !== target ||
          stat.uid !== BigInt(process.getuid!()) ||
          (stat.mode & 0o077n) !== 0n ||
          stat.isSymbolicLink() ||
          (directoryOnly ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
        )
          throw new Error("Strict fixture read requires private nonsymlink store");
        return stat;
      };
      const originalDirectory = privateFile(directory, true);
      privateFile(path);
      return withTrackerStoreLock(
        path,
        async (assertHeld) => {
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const initial = await file.stat({ bigint: true });
            const bytes = await file.readFile();
            const store = parseStore(bytes.toString("utf8"));
            // Fixture stores are single files; a checkpoint alone is not the whole store.
            if (store.journal !== undefined)
              throw new Error("Strict fixture read requires a single-file store");
            const storeId = store.storeId ?? store.team.id;
            if (!storeId || cyclesDue(store, new Date().toISOString()))
              throw new Error("Strict fixture store identity or rollover refusal");
            const same = (a: typeof initial, b: typeof initial) =>
              a.dev === b.dev &&
              a.ino === b.ino &&
              a.birthtimeNs === b.birthtimeNs &&
              a.size === b.size &&
              a.mtimeNs === b.mtimeNs &&
              a.ctimeNs === b.ctimeNs;
            const assertCurrent = () => {
              assertHeld();
              const currentDirectory = privateFile(directory, true);
              if (
                currentDirectory.dev !== originalDirectory.dev ||
                currentDirectory.ino !== originalDirectory.ino ||
                currentDirectory.birthtimeNs !== originalDirectory.birthtimeNs ||
                !same(initial, privateFile(path)) ||
                !readFileSync(path).equals(bytes) ||
                !same(initial, privateFile(path)) ||
                cyclesDue(store, new Date().toISOString())
              )
                throw new Error("Strict fixture read target changed");
            };
            assertCurrent();
            const final = await beforeRead({
              storeId,
              storeDigest: createHash("sha256").update(bytes).digest("hex"),
            });
            assertCurrent();
            final();
            assertCurrent();
            // Pure backend-owned branch, with no await or ordinary dispatcher fallback.
            return {
              user: structuredClone(findUser(store, "me")),
              storeId,
              storeDigest: createHash("sha256").update(bytes).digest("hex"),
            };
          } finally {
            await file.close();
          }
        },
        { existingOnly: true },
      );
    },
    readSnapshotCandidate: (name) => strictReadOperation(name, options) !== undefined,
    async withReadSnapshot(snapshot, apply) {
      if (
        snapshot.version !== 1 ||
        snapshot.classification !== "READ" ||
        snapshot.contract !== "builtin-strict-no-effect/v1" ||
        !["get_issue", "list_runs", "get_user"].includes(snapshot.operation) ||
        snapshot.target.kind !== "builtin" ||
        typeof snapshot.target.storeId !== "string" ||
        snapshot.target.storeId.length === 0 ||
        !/^\d+$/u.test(snapshot.target.directoryIdentity.dev) ||
        !/^\d+$/u.test(snapshot.target.directoryIdentity.ino) ||
        !/^[1-9]\d*$/u.test(snapshot.target.directoryIdentity.birthTimeNs) ||
        snapshot.target.canonicalDirectory !== realpathSync(directory)
      )
        throw new Error("The original tracker READ snapshot does not match this backend");
      // The logical persisted store identity survives normal atomic tracker replacements.
      return withTrackerStoreLock(
        path,
        async (assertHeld) => {
          const { store, readIdentity } = await loadExisting(false, true);
          if (
            readIdentity === undefined ||
            readIdentity.canonicalDirectory !== snapshot.target.canonicalDirectory ||
            readIdentity.directory.dev.toString() !== snapshot.target.directoryIdentity.dev ||
            readIdentity.directory.ino.toString() !== snapshot.target.directoryIdentity.ino ||
            readIdentity.directory.birthtimeNs.toString() !== snapshot.target.directoryIdentity.birthTimeNs ||
            (store.storeId ?? store.team.id) !== snapshot.target.storeId
          )
            throw new Error("The original tracker READ store is missing or replaced");
          const assertStoreCurrent = () => {
            assertHeld();
            assertReadIdentity(directory, path, readIdentity);
          };
          assertStoreCurrent();
          return apply(assertStoreCurrent);
        },
        { existingOnly: true },
      );
    },
    async sync(input, callOptions, signal) {
      const command = structuredClone(TrackerSyncCommandSchema.parse(input));
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
      if (command.action === "list_issue_views" || command.action === "list_issue_view_issues") {
        const { action, ...args } = command;
        validateTrackerToolArgs(action, args);
        return withTrackerStoreLock(path, async (assertHeld) => {
          // The existing service callback checks the original device's live grant.
          // Check it after lock admission and again after canonical dispatch, before disclosure.
          await callOptions?.beforeWrite?.();
          signal?.throwIfAborted();
          assertHeld();
          const { store, clock } = await load();
          issueViewProject(store, args);
          await roll(store, clock, assertHeld);
          issueViewProject(store, args);
          const result = await read(
            store,
            action,
            args,
            options,
            callOptions?.actor ?? localActor(store),
            clock,
          );
          await callOptions?.beforeWrite?.();
          signal?.throwIfAborted();
          assertHeld();
          issueViewProject(await readStore(false), args);
          return TrackerSyncResultSchema.parse({
            ...(result as Record<string, unknown>),
            storeId: command.storeId,
            projectId: command.project,
            ...(command.action === "list_issue_view_issues"
              ? { outcome: "issue_view_issues", viewId: command.id }
              : { outcome: "issue_views" }),
          });
        });
      }
      if (command.action === "transaction") {
        // Validate every operation before dispatch; one receipt owns the whole transaction.
        for (const operation of command.operations) {
          validateTrackerToolArgs(operation.name, operation.arguments);
          if (GUIDED_REVIEW_TOOLS.has(operation.name))
            throw new Error("Guided reviews require the authenticated direct tool route");
          if (
            !/^(?:save|create|post)_/u.test(operation.name) ||
            operation.arguments.idempotencyKey !== undefined
          )
            throw new Error("Transactions contain write tools without nested idempotency keys");
        }
        return withTrackerStoreLock(path, async (assertHeld) => {
          const { store, clock } = await load();
          await roll(store, clock, assertHeld);
          for (const operation of command.operations)
            if (SAVED_ISSUE_VIEW_TOOLS.has(operation.name)) issueViewProject(store, operation.arguments);
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
            return { outcome: "applied" as const, result: structuredClone(await receiptResult(prior)) };
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
                const beforeOperation = settle(target);
                const result = await dispatch(
                  target,
                  operation.name,
                  operation.arguments,
                  options,
                  operationNow,
                  context,
                );
                // Preserve every tool's stage, completion and evidence fences, including intermediate effects.
                await recordIssueChanges(beforeOperation, target, operation.name, context, operationNow);
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
        // Long-pollers wake on every commit: read the committed store itself, never a copy.
        const answer = async (store: Store): Promise<TrackerSyncResult> => {
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
          // Commits before the checkpoint are no longer in memory; the journal retains them all.
          const page =
            command.lastSyncId < (store.syncBase?.syncId ?? 0)
              ? await readJournalCommits(directory, command.lastSyncId, command.limit)
              : (() => {
                  const available = (store.syncLog ?? []).filter(
                    (commit) => commit.syncId > command.lastSyncId,
                  );
                  return {
                    commits: available.slice(0, command.limit),
                    hasMore: available.length > command.limit,
                  };
                })();
          const commits = (page.commits as NonNullable<Store["syncLog"]>).map(
            ({ prevHash: _prev, hash: _hash, ...commit }) => ({
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
                    (delta.previousProjectIds.length > 0 && inSyncGroups(delta.previousProjectIds, groupIds)),
                ),
            }),
          );
          // Register while the replay snapshot is current (under the lock, or in the same
          // synchronous step), closing the bootstrap/live race.
          listeners.add(listener);
          return {
            outcome: "deltas",
            storeId,
            lastSyncId: commits.at(-1)?.syncId ?? command.lastSyncId,
            commits,
            hasMore: page.hasMore,
          };
        };
        const readSync = () =>
          withTrackerStoreLock(path, async (assertHeld): Promise<TrackerSyncResult> => {
            signal?.throwIfAborted();
            const loaded = await load({ mutable: false });
            const { clock, initialized } = loaded;
            let store = loaded.store;
            if (cyclesDue(store, clock)) {
              store = draftOf(store);
              await roll(store, clock, assertHeld);
            }
            if (initialized) await commit(store, assertHeld);
            return answer(store);
          });
        /**
         * A subscriber re-subscribes after every page, so ten long-pollers taking the store lock
         * after each commit would queue ahead of the next write. A current snapshot whose page is
         * in memory is read without it: from reading the snapshot to registering the listener
         * runs in one synchronous step, so no commit in this process lands between them. A
         * rollover due, a new store or older commits in the journal take the locked path.
         */
        const readCurrent = () => {
          const current = shared.current;
          const clock = (options.clock ?? (() => new Date()))().toISOString();
          try {
            if (
              command.action !== "subscribe" ||
              current === undefined ||
              current.version !== storeVersion() ||
              command.lastSyncId < (current.store.syncBase?.syncId ?? 0) ||
              cyclesDue(current.store, clock)
            )
              return readSync();
          } catch {
            return readSync();
          }
          signal?.throwIfAborted();
          return answer(current.store);
        };
        const first = await readCurrent();
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
        return await readCurrent();
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", listener);
        listeners.delete(listener);
        if (!listeners.size) syncListeners.delete(path);
      }
    },
    async importLinear(source, sourceActors, callOptions) {
      // The committed store is frozen and shared, so it never holds the caller's own objects.
      const snapshot = structuredClone(source);
      const actorMap = structuredClone(sourceActors);
      return withTrackerStoreLock(path, async (assertHeld) => {
        const loaded = await load();
        const { clock } = loaded;
        // A mirror import rewrites records wholesale, so it works on a full copy, not a draft.
        const before = settle(loaded.store);
        const store = structuredClone(before);
        if (store.linearMirror?.cutover)
          throw new Error("This store was cut over from Linear; import into a scratch store instead");
        if (store.linearMirror && store.linearMirror.workspaceId !== snapshot.workspaceId)
          throw new Error("Scratch store belongs to another Linear workspace");
        if (store.linearMirror && store.team.id !== snapshot.team.id)
          throw new Error("Scratch store has another Linear team; no team mapping was selected");
        if (!store.linearMirror && store.issues.length > 0)
          throw new Error("Import requires an empty scratch store or its existing mirror");
        const mirrorEvent = callOptions?.mirrorEvent;
        if (mirrorEvent && !store.linearMirror) throw new Error("Webhook mirror requires an imported store");
        const duplicate =
          mirrorEvent && store.linearMirror?.events?.some((e) => e.id === mirrorEvent.eventId);
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
        if (duplicate) return { ...report, duplicate: true };
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
        const via = mirrorEvent ? "linear_mirror" : "linear_import";
        // A webhook change is attributed to whoever made it in Linear, not the record author.
        const eventActor = (record: LinearRecord): TrackerActor => mirrorEvent?.actor ?? sourceActor(record);
        const sourceActor = (record: LinearRecord): TrackerActor => {
          const id = linearId(record.botActor ?? record.actor ?? record.creator ?? record.user);
          return (id && actorMap[id]) || actor;
        };
        const entity = (record: LinearRecord) => ({
          ...record,
          createdAt: String(record.createdAt ?? clock),
          updatedAt: String(record.updatedAt ?? record.createdAt ?? clock),
          createdByActor: sourceActor(record),
          updatedByActor: eventActor(record),
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
        // A partial (webhook or drift) snapshot keeps the relations the mirror already holds.
        const currentRelations = [
          ...new Map(
            [...(store.linearMirror?.records.relations ?? []), ...snapshot.relations].map((r) => [r.id, r]),
          ).values(),
        ].filter((relation) => relation.archivedAt == null);
        upsert(
          store.issues,
          snapshot.issues.map((record) => {
            const relations = currentRelations;
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
        // Removed provider records leave the native lists; their mirror record keeps the archive marker.
        for (const removal of mirrorEvent?.removed ?? [])
          if (removal.kind === "comments") store.comments = store.comments.filter((c) => c.id !== removal.id);
        const firstEvent = (store.events?.length ?? 0) + 1;
        // Historical records stay historical: no invented owner verification, asks or lease effects.
        for (const [kind, incoming] of Object.entries(records))
          for (const record of incoming) {
            const prior = store.linearMirror?.records[kind]?.find((r) => r.id === record.id);
            if (prior && canonical(prior) === canonical(record)) continue;
            (store.recordEvents ??= []).push({
              type: kind,
              id: record.id,
              at: clock,
              actor: eventActor(record),
              via,
            });
            if (kind === "issues") {
              const issue = findIssue(store, record.id);
              if (!prior)
                appendEvent(store, { actor: eventActor(record), via }, String(record.createdAt), issue, {
                  type: "created",
                });
              const oldSpans = (prior?.stateHistory ?? []) as LinearRecord[];
              const stateChanges = ((record.history ?? []) as LinearRecord[]).filter((history) =>
                linearId(history.toState),
              );
              for (const span of stateChanges.length ? [] : ((record.stateHistory ?? []) as LinearRecord[]))
                if (!oldSpans.some((s) => s.id === span.id))
                  appendEvent(store, { actor: sourceActor(record), via }, String(span.startedAt), issue, {
                    type: "state",
                    to: String(linearRow(span.state).name),
                  });
              for (const history of stateChanges)
                if (
                  linearId(history.toState) &&
                  !((prior?.history ?? []) as LinearRecord[]).some((h) => h.id === history.id)
                )
                  appendEvent(
                    store,
                    { actor: mirrorEvent?.actor ?? sourceActor(history), via },
                    String(history.createdAt),
                    issue,
                    {
                      type: "state",
                      from: String(linearRow(history.fromState).name ?? ""),
                      to: String(linearRow(history.toState).name),
                      body: `Linear history ${history.id}`,
                    },
                  );
              if (prior && prior.priority !== record.priority)
                appendEvent(
                  store,
                  { actor: eventActor(record), via },
                  String(record.updatedAt ?? clock),
                  issue,
                  {
                    type: "priority",
                    from: String(prior.priority),
                    to: String(record.priority),
                  },
                );
            }
            const removed = mirrorEvent?.removed?.some((r) => r.kind === kind && r.id === record.id);
            if (kind === "comments" && typeof record.issueId === "string" && !removed)
              appendEvent(
                store,
                { actor: eventActor(record), via },
                String(prior ? (record.updatedAt ?? record.createdAt) : record.createdAt),
                findIssue(store, record.issueId),
                { type: "comment", body: String(record.body), commentId: record.id },
              );
          }
        const merged = { ...store.linearMirror?.records };
        for (const [kind, incoming] of Object.entries(records))
          merged[kind] = [
            ...new Map([...(merged[kind] ?? []), ...incoming].map((record) => [record.id, record])).values(),
          ];
        const events = [
          ...(store.linearMirror?.events ?? []),
          ...(mirrorEvent
            ? [
                {
                  id: mirrorEvent.eventId,
                  ...(mirrorEvent.deliveryId ? { deliveryId: mirrorEvent.deliveryId } : {}),
                  at: clock,
                  type: mirrorEvent.type,
                  action: mirrorEvent.action,
                },
              ]
            : []),
        ].slice(-MIRROR_EVENTS_RETAINED);
        store.linearMirror = {
          workspaceId: snapshot.workspaceId,
          records: merged,
          ...(events.length ? { events } : {}),
        };
        const tool = mirrorEvent ? "mirror_linear" : "import_linear";
        appendAudit(store, {
          at: clock,
          tool,
          outcome: "applied",
          actor: mirrorEvent?.actor ?? actor,
          fields: Object.keys(records),
          entities: Object.entries(records).flatMap(([type, entries]) =>
            entries.map((record) => ({
              type,
              id: record.id,
              ...(typeof record.identifier === "string" ? { identifier: record.identifier } : {}),
            })),
          ),
          ...(mirrorEvent ? { target: `linear-event:${mirrorEvent.eventId}` } : {}),
        });
        parseStore(JSON.stringify(store));
        appendSync(before, store, mirrorEvent?.actor ?? actor, tool, clock);
        await commit(store, assertHeld, callOptions);
        for (const listener of syncListeners.get(path) ?? []) listener();
        publish(store.events?.slice(firstEvent - 1) ?? []);
        return report;
      });
    },
    async readWorkQueue(projectId) {
      const { store, clock } = await load({ mutable: false });
      findProject(store, projectId);
      const members = store.issues.filter((issue) => issue.projectId === projectId && isOpen(store, issue));
      const open = (id: string) => store.issues.some((issue) => issue.id === id && isOpen(store, issue));
      const key = (id: string) => store.issues.find((issue) => issue.id === id)?.identifier ?? id;
      const blocked = members.filter((issue) => issue.blocked || issue.asking || issue.blockedBy.some(open));
      const ready = readyIssues(store, findProject(store, projectId), clock).filter(
        (issue) =>
          !issue.asking &&
          store.issueStatuses.find((status) => status.id === issue.statusId)?.type === "unstarted",
      );
      return {
        state: "known",
        ready: ready.map((issue) => issue.identifier),
        backlog: members
          .filter(
            (issue) =>
              !blocked.includes(issue) &&
              store.issueStatuses.find((status) => status.id === issue.statusId)?.type === "backlog",
          )
          .map((issue) => issue.identifier),
        blocked: blocked.map((issue) => ({
          issue: issue.identifier,
          blocks: issue.blocks.filter(open).map(key),
          reason: issue.asking
            ? "owner ask pending"
            : issue.blocked
              ? "recorded blocker"
              : `blocked by ${issue.blockedBy.filter(open).map(key).join(", ")}`,
        })),
      };
    },
    async readOutcomes(input) {
      const { store, clock } = await load({ mutable: false });
      return builtInOutcomes(store, input, clock);
    },
    async checkpoint() {
      await checkpoints.get(path);
      // No store yet: nothing to move or checkpoint, and no directory or lock to create.
      if (!existsSync(path)) return;
      await checkpointNow();
    },
    async storeId() {
      const { store } = await load({ mutable: false });
      return store.storeId ?? store.team.id;
    },
    async projectStoreId(id) {
      const { store, initialized } = await load({ mutable: false });
      if (initialized || !store.projects.some((project) => project.id === id)) return undefined;
      return store.storeId ?? store.team.id;
    },
    async linearMirrorView(projectId) {
      const { store } = await load();
      if (!mirroring(store)) return undefined;
      return {
        workspaceId: store.linearMirror.workspaceId,
        team: store.team as unknown as LinearRecord,
        projectId,
        records: store.linearMirror.records,
        issueStatuses: store.issueStatuses,
        projectStatuses: store.projectStatuses,
        appliedEvents: new Set((store.linearMirror.events ?? []).map((event) => event.id)),
      };
    },
    async inboxAttention(name, args, callOptions) {
      if (!INBOX_TOOLS.has(name)) throw new Error("Unsupported inbox operation");
      const schema =
        name === "inbox_pending_questions"
          ? WorkInboxListSchema
          : name === "get_inbox_item"
            ? WorkInboxGetSchema
            : name === "post_snooze_inbox_item"
              ? WorkInboxSnoozeSchema
              : WorkInboxUnsnoozeSchema;
      const input = schema.parse(args);
      const writing = name.startsWith("post_");
      return withTrackerStoreLock(
        path,
        async (assertHeld) => {
          let version = storeVersion();
          const store = await readStore(writing);
          const assertStore = () => {
            assertHeld();
            if (storeVersion() !== version) throw new Error("Inbox tracker store changed. Read again.");
          };
          assertStore();
          if (input.storeId !== (store.storeId ?? store.team.id)) throw new Error("store_replaced");
          if (!store.projects.some((project) => project.id === input.project))
            throw new Error("Inbox project is not in the current tracker store");
          if (mirroring(store)) throw new Error("Inbox requires a writable built-in tracker");
          const links = ownerAskLinks(store, input.project);
          await callOptions.beforeWrite?.();
          assertStore();
          const pending = await callOptions.prepare(links);
          assertStore();
          let assertTime = () => {};
          const assertCurrent = () => {
            assertStore();
            pending.assertCurrent();
            assertTime();
          };
          const beforeWrite = async () => {
            await callOptions.beforeWrite?.();
            await pending.recheck();
            assertCurrent();
          };
          await beforeWrite();
          const actor = callOptions.actor;
          if (!actor.id || !["human", "agent-worker", "app"].includes(actor.type))
            throw new Error("Authenticated inbox actor is unavailable");
          const privateKey = actorKey(actor);
          const now = (options.clock?.() ?? new Date()).toISOString();
          const owned = (store.inboxSnoozes ?? []).filter(
            (entry) => entry.actorKey === privateKey && entry.projectId === input.project,
          );
          const entryFor = (target: WorkInboxTarget) =>
            owned.find((entry) => canonical(entry.target) === canonical(target));
          const view = (row: WorkInboxPendingQuestion) => {
            const state = entryFor(row.target);
            const active = state !== undefined && state.until > now;
            return {
              ...row,
              id: row.target.requestId,
              attention: active ? "snoozed" : "active",
              until: state?.until ?? null,
              updatedAt: state?.updatedAt ?? null,
            };
          };
          // The pending set and every selector are supplied by the canonical host mailbox/link join.
          const rows = pending.rows.map(view);
          assertTime = () => {
            const current = (options.clock?.() ?? new Date()).toISOString();
            if (owned.some((entry) => entry.until > now !== entry.until > current))
              throw new Error("Inbox attention expired. Read again.");
          };
          if (name === "inbox_pending_questions") {
            const list = WorkInboxListSchema.parse(input);
            const filtered = rows.filter(
              (row) => list.attention === "all" || row.attention === list.attention,
            );
            // Reuse tracker pagination, with an actor/store/project/mode and current-result fingerprint.
            const result = page(
              filtered,
              {
                ...list,
                actorKey: privateKey,
                snapshot: createHash("sha256").update(canonical(filtered)).digest("hex"),
              },
              "rows",
              name,
            );
            assertCurrent();
            return {
              value: {
                storeId: input.storeId,
                projectId: input.project,
                ...result,
                complete: result.hasNextPage === false,
              },
              assertCurrent,
            };
          }
          const target = WorkInboxGetSchema.parse({
            project: input.project,
            storeId: input.storeId,
            target: args.target,
          }).target;
          const row = pending.rows.find((entry) => canonical(entry.target) === canonical(target));
          if (!row) throw new Error("Inbox target is not a current eligible pending question");
          if (!writing) return { value: view(row), assertCurrent };
          const mutation = WorkInboxUnsnoozeSchema.parse(
            Object.fromEntries(Object.entries(input).filter(([key]) => key !== "until")),
          );
          const request = Object.fromEntries(
            Object.entries(input).filter(([key]) => key !== "idempotencyKey"),
          );
          const fingerprint = createHash("sha256")
            .update(canonical([name, request]))
            .digest("hex");
          // Current actor, store, project and pending target are checked BEFORE receipt replay.
          const prior = store.receipts?.find(
            (entry) => entry.actorKey === privateKey && entry.idempotencyKey === mutation.idempotencyKey,
          );
          if (prior) {
            if (prior.fingerprint !== fingerprint)
              throw new TrackerWriteRefused(
                "idempotency_conflict",
                "Inbox key already used for another write",
              );
            if (prior.state === "refused") throw new TrackerWriteRefused(prior.reason!, prior.detail!);
            assertCurrent();
            return { value: structuredClone(await receiptResult(prior)), assertCurrent };
          }
          if (row.expectedRevision !== mutation.expectedRevision) throw new Error("inbox_fence_stale");
          const existing = entryFor(target);
          if ((existing?.updatedAt ?? null) !== mutation.ifUpdatedAt)
            throw new TrackerWriteRefused("precondition_failed", "Inbox attention changed; inspect it again");
          let until: string | undefined;
          const retained = (store.inboxSnoozes ?? []).filter(
            (entry) =>
              entry !== existing &&
              !(entry.actorKey === privateKey && entry.projectId === input.project && entry.until <= now),
          );
          if (name === "post_snooze_inbox_item") {
            until = new Date(WorkInboxSnoozeSchema.parse(input).until).toISOString();
            const duration = Date.parse(until) - Date.parse(now);
            if (duration <= 0 || duration > 30 * 24 * 60 * 60 * 1000)
              throw new Error("Snooze until must be in the future and within 30 days");
            const active = (store.inboxSnoozes ?? []).filter(
              (entry) => entry.until > now && entry !== existing,
            );
            if (
              retained.length >= 1000 ||
              active.filter((entry) => entry.actorKey === privateKey).length >= 100
            )
              throw new Error("Inbox active snooze limit reached");
          }
          // The old attention projection is being replaced. Fence the new timestamp at
          // dispatch and final publication, including expiry during an asynchronous rename.
          assertTime = () => {
            if (until !== undefined && until <= (options.clock?.() ?? new Date()).toISOString())
              throw new Error("Inbox snooze expired before publication. Read again.");
          };
          const result = await write(
            store,
            now,
            name,
            request,
            { key: mutation.idempotencyKey, fingerprint },
            actor,
            {
              ...callOptions,
              beforeWrite,
              onDispatch: () => {
                assertCurrent();
                callOptions.onDispatch?.();
                assertCurrent();
              },
              effectConfirmed: () => {
                // The commit records the version it left; anything else on disk is not this write.
                version = storeVersion();
                if (version !== landed)
                  throw new Error("Inbox store changed after dispatch; attention may have committed");
                callOptions.effectConfirmed?.();
              },
            },
            assertHeld,
            (draft, at) => {
              // Only this actor's attention changes; no issue, question, gate, run or event edits.
              draft.inboxSnoozes = retained;
              let saved: InboxSnooze | undefined;
              if (until !== undefined) {
                saved = {
                  schemaVersion: 1,
                  id: existing?.id ?? randomUUID(),
                  storeId: input.storeId,
                  projectId: input.project,
                  actorKey: privateKey,
                  target,
                  until,
                  createdAt: existing?.createdAt ?? at,
                  updatedAt: at,
                  createdByActor: actor,
                  updatedByActor: actor,
                };
                draft.inboxSnoozes.push(saved);
              }
              return {
                ...row,
                id: target.requestId,
                attention: saved ? "snoozed" : "active",
                until: saved?.until ?? null,
                updatedAt: saved?.updatedAt ?? null,
              };
            },
          );
          // Rename is asynchronous: failure here may follow a commit, and the HTTP route reports it honestly.
          assertCurrent();
          return { value: result, assertCurrent };
        },
        { existingOnly: true },
      );
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
              const found = target.runs?.find((entry) => entry.id === event.runId);
              if (!found) throw new Error("Gate run not found");
              const run = owned(target.runs!, found);
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
          events = (await readStore(false)).events ?? [];
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
      if (name === "save_guided_review") args = structuredClone(args);
      validateTrackerToolArgs(name, args);
      if (name === "list_changes") return listChanges(args, callOptions?.signal);
      if (GUIDED_REVIEW_TOOLS.has(name)) {
        const actor = callOptions?.actor;
        if (
          !actor ||
          !actor.id ||
          !["human", "agent-worker", "app"].includes(actor.type) ||
          !Array.isArray(actor.onBehalfOf)
        )
          throw new Error("Guided reviews require an authenticated host actor");
        if (
          /^(?:save|post)_/u.test(name) &&
          (typeof args.idempotencyKey !== "string" || !args.idempotencyKey.trim())
        )
          throw new Error("Guided review writes require an idempotency key");
      }
      if (INBOX_TOOLS.has(name)) throw new Error("Inbox requires the authenticated owner mailbox route");
      const operation = strictReadOperation(name, options);
      let guidedReviewCapture: GuidedReviewCapture | undefined;
      let guidedSourceFence: (() => void) | undefined;
      let guidedBinding: { storeId: string; issueId: string; projectId: string | null } | undefined;
      if (name === "save_guided_review") {
        // Only the short issue/receipt read holds the tracker lock. Git/file capture never does.
        const prepared = await withTrackerStoreLock(path, async () => {
          const { store } = await load({ mutable: false });
          const issue = findIssue(store, args.issueId as string);
          options.assertIssueWrite?.(issueView(store, issue));
          return {
            issue: structuredClone(issueView(store, issue)),
            binding: {
              storeId: store.storeId ?? store.team.id,
              issueId: issue.id,
              projectId: issue.projectId,
            },
            replay:
              store.receipts?.some(
                (entry) =>
                  entry.actorKey === actorKey(callOptions!.actor!) &&
                  entry.idempotencyKey === args.idempotencyKey,
              ) ?? false,
          };
        });
        guidedBinding = prepared.binding;
        if (!prepared.replay) {
          if (!options.authorizeGuidedReviewSource)
            throw new TrackerWriteRefused(
              "source_authority_required",
              "Guided review source authority is unavailable",
            );
          guidedSourceFence = await options.authorizeGuidedReviewSource(
            prepared.issue,
            args.source as GuidedReviewSource,
            callOptions!.actor!,
          );
          guidedSourceFence();
          guidedReviewCapture = await captureGuidedReview(args as unknown as CreateGuidedReviewInput);
          guidedSourceFence();
        }
      }
      return withTrackerStoreLock(path, async (assertHeld) => {
        const writing = /^(?:save|create|post)_/u.test(name);
        const captureRead =
          operation !== undefined &&
          !writing &&
          callOptions?.beforeRead !== undefined &&
          callOptions.onReadPrepared !== undefined;
        let { store, clock, initialized, readIdentity } = await load({ mutable: writing, captureRead });
        // Scope checks also fence receipt replay after issue moves or authority changes.
        if (GUIDED_REVIEW_TOOLS.has(name)) {
          const issue = findIssue(store, args.issueId as string);
          if (
            guidedBinding &&
            (guidedBinding.storeId !== (store.storeId ?? store.team.id) ||
              guidedBinding.issueId !== issue.id ||
              guidedBinding.projectId !== issue.projectId)
          )
            throw new TrackerWriteRefused(
              "source_authority_changed",
              "Guided review issue source binding changed during inspection",
            );
          options.assertIssueWrite?.(issueView(store, issue));
          guidedSourceFence?.();
          if (
            name === "get_guided_review" ||
            name === "post_guided_finding" ||
            name === "post_retire_guided_review"
          )
            guidedReviewForIssue(store, args, options);
        }
        const rolloverDue = cyclesDue(store, clock);
        if (
          captureRead &&
          !initialized &&
          !rolloverDue &&
          (store.storeId ?? store.team.id).length > 0 &&
          readIdentity !== undefined
        ) {
          const fence = await callOptions!.beforeRead!();
          assertHeld();
          fence?.();
          assertReadIdentity(directory, path, readIdentity);
          assertHeld();
          callOptions!.onReadPrepared!(
            Object.freeze({
              version: 1,
              classification: "READ",
              contract: "builtin-strict-no-effect/v1",
              operation: operation!,
              target: Object.freeze({
                kind: "builtin",
                canonicalDirectory: readIdentity.canonicalDirectory,
                storeId: store.storeId ?? store.team.id,
                directoryIdentity: Object.freeze({
                  dev: readIdentity.directory.dev.toString(),
                  ino: readIdentity.directory.ino.toString(),
                  birthTimeNs: readIdentity.directory.birthtimeNs.toString(),
                }),
              }),
            }),
          );
        }
        // Cycles roll over on the first access after one ends, as Clankie's own write.
        if (rolloverDue) {
          if (!writing) store = draftOf(store);
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
        }
        // Also fence receipt replays: a saved result never survives a store replacement.
        if (SAVED_ISSUE_VIEW_TOOLS.has(name)) issueViewProject(store, args);
        const actor = callOptions?.actor ?? localActor(store);
        if (!writing) {
          const result = await read(store, name, args, options, actor, clock, receiptResult);
          if (initialized) await commit(store, assertHeld);
          // Callers cannot mutate objects subsequently reused by another backend call.
          return structuredClone(result);
        }
        const key = args.idempotencyKey as string | undefined;
        // Cloned: committed records are frozen and shared, never the caller's own objects.
        const request = structuredClone(
          Object.fromEntries(Object.entries(args).filter(([field]) => field !== "idempotencyKey")),
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
          return structuredClone(replayGuidedReviewReceipt(store, await receiptResult(prior)));
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
          (target, now, context) => {
            if (guidedSourceFence) context.closureFences?.push(guidedSourceFence);
            return dispatch(target, name, request, options, now, {
              ...context,
              ...(guidedReviewCapture === undefined ? {} : { guidedReviewCapture }),
            });
          },
        );
      });
    },
  };
  return backend;
}

/** What a cutover plan reads from a store (VUH-1987), without opening it for writes. */
export interface TrackerStoreSummary {
  readonly exists: boolean;
  readonly storeId?: string;
  readonly team?: { readonly id: string; readonly key: string; readonly name: string };
  /** Native record counts by collection. */
  readonly counts: Readonly<Record<string, number>>;
  /**
   * No record anyone wrote or imported: only the seeded team, user and statuses, and
   * releases, which are derived from repository tags (`syncReleases`), not authored.
   */
  readonly empty: boolean;
  readonly mirror?: {
    readonly workspaceId: string;
    readonly cutover?: { readonly at: string; readonly linearProjectId: string; readonly scratch: string };
    readonly projects: readonly { readonly id: string; readonly name: string }[];
    /** Provider records by type, with Linear's own updatedAt, for drift comparison. */
    readonly records: Readonly<
      Record<string, readonly { readonly id: string; readonly updatedAt?: string }[]>
    >;
  };
  /** Applied writes that did not come from Linear (import, mirror or the cutover itself). */
  readonly localWrites: number;
}

const LINEAR_SOURCED_TOOLS = new Set(["import_linear", "mirror_linear", "cutover_linear"]);

function summarizeStore(store: Store | undefined): TrackerStoreSummary {
  if (store === undefined) return { exists: false, counts: {}, empty: true, localWrites: 0 };
  const counts: Record<string, number> = {
    issueViews: store.issueViews?.length ?? 0,
    issues: store.issues.length,
    projects: store.projects.length,
    comments: store.comments.length,
    statusUpdates: store.statusUpdates.length,
    labels: store.labels.length,
    milestones: store.milestones?.length ?? 0,
    documents: store.documents?.length ?? 0,
    cycles: store.cycles?.length ?? 0,
    releases: store.releases?.length ?? 0,
    runs: store.runs?.length ?? 0,
    bundles: store.bundles?.length ?? 0,
    events: store.events?.length ?? 0,
  };
  return {
    exists: true,
    storeId: store.storeId ?? store.team.id,
    team: { id: store.team.id, key: store.team.key, name: store.team.name },
    counts,
    empty: Object.entries(counts).every(([type, count]) => type === "releases" || count === 0),
    ...(store.linearMirror === undefined
      ? {}
      : {
          mirror: {
            workspaceId: store.linearMirror.workspaceId,
            ...(store.linearMirror.cutover === undefined ? {} : { cutover: store.linearMirror.cutover }),
            projects: store.projects.map((project) => ({ id: project.id, name: project.name })),
            records: Object.fromEntries(
              Object.entries(store.linearMirror.records).map(([type, records]) => [
                type,
                records.map((record) => ({
                  id: record.id,
                  ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
                })),
              ]),
            ),
          },
        }),
    localWrites: (store.audit ?? []).filter(
      (event) => event.outcome === "applied" && !LINEAR_SOURCED_TOOLS.has(event.tool),
    ).length,
  };
}

async function readStoreText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The committed store in a directory, read without the lock and never written: the single file,
 * or the checkpoint plus its journal tail. With `history`, every sync commit and every receipt
 * result comes back from the journal too, and `text` is the whole store as one legacy file.
 */
async function readCommittedStore(
  directory: string,
  history = false,
): Promise<{ store: Store; text: string } | undefined> {
  const text = await readStoreText(join(directory, "tracker.json"));
  if (text === undefined) return undefined;
  const parsed = parseStore(text);
  const header = parsed.journal;
  if (header === undefined) return { store: parsed, text };
  delete parsed.journal;
  const tail = await readJournalTail(directory, header, { verified: false });
  const store = replayVerified(parsed, tail.records);
  if (!history) return { store, text };
  const commits: NonNullable<Store["syncLog"]> = [];
  const results = new Map<string, unknown>();
  for await (const record of journalRecords(directory)) {
    commits.push(record.commit as NonNullable<Store["syncLog"]>[number]);
    for (const receipt of (record.append?.receipts ?? []) as WriteReceipt[])
      results.set(`${receipt.actorKey}\n${receipt.idempotencyKey}`, receipt.result);
  }
  const { syncBase: _base, ...rest } = store;
  const whole: Store = {
    ...rest,
    syncLog: commits,
    ...(store.receipts === undefined
      ? {}
      : {
          receipts: store.receipts.map(({ resultInJournal, ...receipt }) =>
            resultInJournal
              ? { ...receipt, result: results.get(`${receipt.actorKey}\n${receipt.idempotencyKey}`) }
              : receipt,
          ),
        }),
  };
  return { store: whole, text: `${JSON.stringify(whole, null, 2)}\n` };
}

/**
 * Host-only rollback (LOCAL-VUH-42): writes the whole committed store, every sync commit and
 * receipt result included, to `out` as one legacy `tracker.json`, which a build without the
 * journal opens. Never changes the store; false when there is none.
 */
export async function exportTrackerStore(directory: string, out: string): Promise<boolean> {
  const path = join(resolve(directory), "tracker.json");
  if (!existsSync(path)) return false;
  return withTrackerStoreLock(path, async () => {
    const committed = await readCommittedStore(resolve(directory), true);
    if (committed === undefined) return false;
    await writeExclusive(out, committed.text);
    return true;
  });
}

/**
 * Host-only: a store's records for routing a call to it, without the store's validation, so a
 * broken store is still found and the tracker itself refuses the call. The checkpoint plus as
 * much of its journal tail as reads; a malformed file throws. Never seeds or writes.
 */
export async function readTrackerStoreRecords(
  directory: string,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const text = await readStoreText(join(resolve(directory), "tracker.json"));
  if (text === undefined) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object") throw new Error("Not a tracker store");
  const header = (parsed as Record<string, unknown>).journal as JournalHeader | undefined;
  if (header === undefined) return parsed as Record<string, unknown>;
  try {
    return replayJournal(
      parsed as Record<string, unknown>,
      (await readJournalTail(resolve(directory), header, { verified: false })).records,
    );
  } catch {
    return parsed as Record<string, unknown>;
  }
}

/**
 * Host-only: the committed store with its journal tail, read without the lock and checked with
 * the store's own validation, so corrupt or unsupported bytes throw exactly as they would for the
 * tracker itself. Never seeds or writes.
 */
export async function readTrackerStoreSnapshot(
  directory: string,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  return (await readCommittedStore(resolve(directory)))?.store as unknown as
    | Readonly<Record<string, unknown>>
    | undefined;
}

/** Host-only: changes whenever a commit lands in that store directory, by any process. */
export function trackerStoreVersion(directory: string): string {
  const file = statSync(join(resolve(directory), "tracker.json"), { bigint: true });
  return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}|${journalVersion(resolve(directory))}`;
}

/** Host-only read of a store directory's `tracker.json`; never seeds or writes one. */
export async function readTrackerStoreSummary(directory: string): Promise<TrackerStoreSummary> {
  return summarizeStore((await readCommittedStore(resolve(directory)))?.store);
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Mirror 3 (VUH-1987): the owner's imported, mirrored copy becomes the live store.
 * Under both store locks the live store's exact bytes go to `backup`, then the copy
 * replaces it, marked cut over: writable, authoritative, its Linear records kept as
 * provenance. The copy keeps its own storeId, so clients rebootstrap (VUH-1971).
 * Releases are derived from repository tags, so the live store's carry over, each
 * item relinked to the copy's built-in issues as a sync would; nothing authored merges.
 */
export async function promoteLinearImport(options: {
  readonly source: string;
  readonly target: string;
  readonly backup: string;
  readonly linearProjectId: string;
  readonly scratch: string;
  readonly actor: TrackerActor;
  readonly clock?: () => Date;
  /** Re-checked under both locks, immediately before the swap. */
  readonly verify: (source: TrackerStoreSummary, target: TrackerStoreSummary) => Promise<void> | void;
}): Promise<{ storeId: string; previousStoreId: string | undefined; backedUp: boolean }> {
  const targetPath = join(resolve(options.target), "tracker.json");
  const sourcePath = join(resolve(options.source), "tracker.json");
  if (targetPath === sourcePath) throw new Error("A store cannot be promoted onto itself");
  return withTrackerStoreLock(targetPath, (targetHeld) =>
    withTrackerStoreLock(sourcePath, async (sourceHeld) => {
      // Whole stores, sync history included: the promoted copy and the backup are single files.
      const [source, target] = await Promise.all([
        readCommittedStore(resolve(options.source), true),
        readCommittedStore(resolve(options.target), true),
      ]);
      if (source === undefined) throw new Error("No imported store to promote");
      const store = source.store;
      const previous = target?.store;
      const targetText = target?.text;
      await options.verify(summarizeStore(store), summarizeStore(previous));
      if (!store.linearMirror) throw new Error("Only a Linear import can be promoted");
      if (store.linearMirror.cutover) throw new Error("That import was already cut over");
      if (!store.projects.some((project) => project.id === options.linearProjectId))
        throw new Error("That import does not hold the Linear project");
      const before = structuredClone(store);
      const now = nextWriteTime(store, (options.clock ?? (() => new Date()))().toISOString());
      store.linearMirror.cutover = {
        at: now,
        linearProjectId: options.linearProjectId,
        scratch: options.scratch,
      };
      store.lastWriteAt = now;
      const carried = (previous?.releases ?? []).filter(
        (release) => !store.releases?.some((entry) => entry.id === release.id),
      );
      for (const release of carried)
        (store.releases ??= []).push({
          ...release,
          items: release.items.map((item) => {
            const issue = store.issues.find((entry) => norm(entry.identifier) === norm(item.key));
            return {
              key: item.key,
              ...(issue === undefined ? {} : { issueId: issue.id }),
              commits: item.commits,
            };
          }),
        });
      appendAudit(store, {
        at: now,
        tool: "cutover_linear",
        outcome: "applied",
        actor: options.actor,
        fields: carried.length ? ["linearMirror", "releases"] : ["linearMirror"],
        entities: [{ type: "projects", id: options.linearProjectId }],
        target: `scratch:${options.scratch}`,
      });
      appendSync(before, store, options.actor, "cutover_linear", now);
      parseStore(JSON.stringify(store));
      if (targetText !== undefined) await writeExclusive(options.backup, targetText);
      sourceHeld();
      await persist(targetPath, store, targetHeld);
      // The replaced store's journal belongs to no checkpoint now; keep it beside the backup.
      await setJournalAside(resolve(options.target), "replaced");
      return {
        storeId: store.storeId ?? store.team.id,
        previousStoreId: previous === undefined ? undefined : (previous.storeId ?? previous.team.id),
        backedUp: targetText !== undefined,
      };
    }),
  );
}

/**
 * Switch-back (VUH-1987): the live store's exact bytes go to `keep`, then the
 * pre-cutover bytes come back unchanged (or the file is removed if there was none).
 */
export async function restoreTrackerStore(options: {
  readonly target: string;
  readonly backup: string | undefined;
  readonly keep: string;
  readonly verify?: (current: TrackerStoreSummary) => Promise<void> | void;
}): Promise<{ storeId: string | undefined; restoredStoreId: string | undefined }> {
  const targetPath = join(resolve(options.target), "tracker.json");
  return withTrackerStoreLock(targetPath, async (assertHeld) => {
    const committed = await readCommittedStore(resolve(options.target), true);
    const currentText = committed?.text;
    const current = committed?.store;
    await options.verify?.(summarizeStore(current));
    const backupText = options.backup === undefined ? undefined : await readFile(options.backup, "utf8");
    const restored = backupText === undefined ? undefined : parseStore(backupText);
    if (currentText !== undefined) await writeExclusive(options.keep, currentText);
    assertHeld();
    if (backupText === undefined) await rm(targetPath, { force: true });
    else {
      const temp = `${targetPath}.${randomUUID()}.tmp`;
      try {
        await writeExclusive(temp, backupText);
        assertHeld();
        await rename(temp, targetPath);
      } finally {
        await rm(temp, { force: true });
      }
    }
    // The restored single file owns the directory again; the journal it replaced stays aside.
    await setJournalAside(resolve(options.target), "replaced");
    return {
      storeId: current === undefined ? undefined : (current.storeId ?? current.team.id),
      restoredStoreId: restored === undefined ? undefined : (restored.storeId ?? restored.team.id),
    };
  });
}
