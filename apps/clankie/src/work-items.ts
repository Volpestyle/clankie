import { WATCH_REFUSAL } from "./watch.ts";
import { createLinearWorkProjects } from "./linear-work-projects.ts";
import { createGuidedReviewSourceAuthorizer } from "./guided-review-source.ts";
import { projectWorkRepoId } from "./project-work-items.ts";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  WorkInitSettingsSchema,
  WorkEvidenceSchema,
  WorkItemStatusSchema,
  WorkItemPrioritySchema,
  type WorkProjectDetailsResult,
  type WorkProjectResult,
  type WorkConvention,
  type WorkItem,
  type WorkActivityEntry,
  type WorkRepo,
  type WorkSignal,
} from "@clankie/protocol/work-items";
import {
  CONVENTION_FILE,
  conventionWorkDirectory,
  ConventionNeededError,
  isPrivateWorkDirectory,
  DEFAULT_WORK_DIRECTORY,
  exportedIssueIds,
  blockerReferences,
  exportIssueFromTracker,
  exportIssuesToFiles,
  fileDrop,
  readDrops,
  recordDropWake,
  type DropDraft,
  type DropWake,
  trackerIssueStatus,
  type ExportIssue,
  type FilesExportResult,
  discoverConvention,
  readConvention,
  resolveTracker,
  readProjectDetails,
  readProjectWork,
  readReleaseHistory,
  type ReleaseHistory,
  backendFor,
  trackerToolsFor,
  type WorkItemPatch,
  initializeConvention,
  WorkInitDecisionRequired,
  WorkInitInvalid,
  type CommandRunner,
  githubRestApi,
  ghCliApi,
  type GhRunner,
  type LinearToolCall,
  type TrackerDeps,
  type TrackerToolCallOptions,
  type TrackerToolBackend,
  createLocalTracker,
  type LocalTrackerBackend,
  TRACKER_LEAD,
  SAVED_ISSUE_VIEW_TOOLS,
  INBOX_TOOLS,
  type InboxPendingFence,
  readTrackerStoreRecords,
  refuseBuiltInTrackerFeatures,
  trackerArgumentReferences,
  TRACKER_OWNER,
  TrackerReadRejected,
  trackerStoreVersion,
  type TrackerActor,
} from "@clankie/work-items";
import type { McpHost, TrackerRouteFence } from "./mcp-host.ts";
import type { CaptainPort } from "./captain/port.ts";
import type { QuestionAuthority } from "./captain/conversation-questions.ts";
import type { Project, ProjectsSettings } from "@clankie/protocol/projects";
import { WORK_REPO_LIST_MAX } from "@clankie/protocol/work-items";
import { createProjectWorkReader } from "./project-work-items.ts";
import {
  WorkItemWriteRequestSchema,
  WorkItemWriteReceiptRequestSchema,
  type WorkItemWriteRequest,
  type WorkItemWriteReceipt,
  type WorkItemWriteReceiptRequest,
} from "@clankie/protocol/work-item-write";
import { WorkWriteReceipts } from "./work-write-receipts.ts";
import {
  prepareWorkWriteTarget,
  type WorkWriteAuthority,
  type WorkProjectFence,
} from "./work-write-target.ts";
import { deliveryFingerprint } from "./captain/delivery-fence.ts";
import {
  assertAdmitted,
  CONNECTED_APP_ACTOR_PREFIX,
  isTrackerWriteTool,
  TRACKER_POSTING_ADMITTED,
  type PostingAsker,
  type TrackerPostingGate,
} from "./tracker-posting.ts";

/**
 * The work-item layer every agent and the app go through (ADR 0191). It owns
 * which repos are readable over the device contract; the backends own storage.
 */

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30_000;
/** Clankie (the lead) acting for the owner: how operator-bearer tracker writes are attributed. */
const CLANKIE_FOR_OWNER: TrackerActor = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };

/** The owner speaking as himself, or his own app: his writes are never held (ADR 0302). */
function ownerActor(actor: TrackerActor | undefined): boolean {
  return actor?.type === TRACKER_OWNER.type || actor?.type === "app";
}
/** Who asks to post: a connected app, a hired worker by its principal, otherwise Clankie himself. */
function postingAsker(actor: TrackerActor | undefined): PostingAsker {
  if (actor?.type === "agent-worker" && actor.id.startsWith(CONNECTED_APP_ACTOR_PREFIX))
    return {
      kind: "app",
      deviceId: actor.id.slice(CONNECTED_APP_ACTOR_PREFIX.length),
      name: actor.name ?? "A connected app",
    };
  return actor?.type === "agent-worker" && actor.id !== TRACKER_LEAD.id
    ? { kind: "worker", principalId: actor.id, ...(actor.name === undefined ? {} : { name: actor.name }) }
    : { kind: "lead" };
}

/** A provider's settled tool error. On a read it is that provider's definite answer. */
function providerToolError(tool: string, content: string): Error {
  const message = `Tracker ${tool}: ${content.slice(0, 500)}`;
  return /^(?:get|list|search)_/u.test(tool) ? new TrackerReadRejected(message) : new Error(message);
}

export const WorkRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("repos") }).strict(),
  z.object({ action: z.literal("project-details"), repo: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal("project"), repo: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal("discover"), repo: z.string().min(1).max(4096) }).strict(),
  WorkInitSettingsSchema.extend({ action: z.literal("init"), repo: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      action: z.literal("list"),
      repo: z.string().min(1).max(4096),
      status: z.array(WorkItemStatusSchema).max(6).optional(),
      owner: z.string().min(1).max(128).optional(),
      label: z.string().trim().min(1).max(64).optional(),
      limit: z.number().int().min(1).max(250).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("show"),
      repo: z.string().min(1).max(4096),
      id: z.string().min(1).max(64),
      // A built-in tracker project UUID or name, as `work ready --project` takes it (VUH-2805).
      project: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("activity"),
      repo: z.string().min(1).max(4096),
      id: z.string().min(1).max(64),
      // A built-in tracker project UUID or name, as `work ready --project` takes it (VUH-2805).
      project: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("create"),
      repo: z.string().min(1).max(4096),
      title: z.string().trim().min(1).max(200),
      // Match canonical save_issue descriptions; this is not a display-size limit.
      summary: z.string().optional(),
      owner: z.string().trim().min(1).max(128).optional(),
      criteria: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
      dependsOn: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
      status: WorkItemStatusSchema.optional(),
      priority: WorkItemPrioritySchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      repo: z.string().min(1).max(4096),
      id: z.string().min(1).max(64),
      // A built-in tracker project UUID or name, as `work ready --project` takes it (VUH-2805).
      project: z.string().trim().min(1).max(200).optional(),
      status: WorkItemStatusSchema.optional(),
      priority: WorkItemPrioritySchema.optional(),
      owner: z.string().trim().min(1).max(128).nullable().optional(),
      title: z.string().trim().min(1).max(200).optional(),
      dependsOn: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
      addDependsOn: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
      addLabels: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
      removeLabels: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
      check: z.array(z.number().int().min(1).max(50)).max(50).optional(),
      uncheck: z.array(z.number().int().min(1).max(50)).max(50).optional(),
      addCriteria: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("attach"),
      repo: z.string().min(1).max(4096),
      id: z.string().min(1).max(64),
      // A built-in tracker project UUID or name, as `work ready --project` takes it (VUH-2805).
      project: z.string().trim().min(1).max(200).optional(),
      evidence: WorkEvidenceSchema,
    })
    .strict(),
]);
export type WorkRequest = z.infer<typeof WorkRequestSchema>;
/** Owner HTTP commands stay separate from the existing agent tool schema. */
export const WorkHttpRequestSchema = z.union([
  WorkRequestSchema,
  z.object({ action: z.literal("write"), request: WorkItemWriteRequestSchema }).strict(),
  z.object({ action: z.literal("write_receipt"), request: WorkItemWriteReceiptRequestSchema }).strict(),
]);

/** `clankie work export` (step 5, C2): open items move into the repo's private issue files. */
export const WORK_EXPORT_PATH = "/v1/work/export";
export const WorkExportRequestSchema = z
  .object({
    project: z.string().trim().min(1).max(64),
    to: z.literal("markdown"),
    dryRun: z.boolean().default(false),
  })
  .strict();
export type WorkExportRequest = z.infer<typeof WorkExportRequestSchema>;
/** Where a project's drops go, or why they can't. */
/**
 * Where a convention's outward writes land (ADR 0302). A held post records it and goes only
 * while it is unchanged, so an approval never sends the write somewhere it was not asked for.
 */
function postingDestination(convention: WorkConvention | undefined): string | undefined {
  if (convention?.backend === "github") return `github:${convention.github?.repo ?? ""}`;
  if (convention?.backend === "linear")
    return `linear:${convention.linear?.team ?? ""}/${convention.linear?.project ?? ""}`;
  return undefined;
}

const assertDestination = (convention: WorkConvention, destination: string | undefined) => {
  if (destination !== undefined && postingDestination(convention) !== destination)
    throw new WorkRequestError(
      "posting_refused",
      "This project's tracker changed after the post was asked for, so it would land somewhere else. Nothing was posted; ask again.",
    );
};

export type DropTarget =
  | {
      readonly ready: true;
      readonly project: { readonly id: string; readonly name: string };
      /** The tracker workspace; its private folder resolves to the main checkout. */
      readonly root: string;
      readonly repoId: string;
      /**
       * The project's outward tracker, when it has one (ADR 0302): the drop is kept as a
       * private issue file here first, then posted there as the project's posting setting says.
       */
      readonly tracker?: "linear" | "github";
      /**
       * Where that tracker's writes land (`postingDestination`), while they leave this Mac:
       * without it (Linear disconnected) the drop is only kept here.
       */
      readonly destination?: string;
    }
  | {
      readonly ready: false;
      readonly reason: "unknown_project" | "not_file_backed";
      readonly message: string;
    };

export type WorkExportResult = {
  readonly action: "export";
  readonly to: "markdown";
  readonly dryRun: boolean;
  readonly ready: boolean;
  readonly refusals: string[];
  readonly project?: { readonly id: string; readonly name: string };
  readonly source?: Record<string, unknown>;
  readonly next?: string[];
} & Partial<FilesExportResult>;

const RegistrySchema = z.object({
  repos: z.array(z.object({ id: z.string(), path: z.string(), name: z.string() }).strict()).max(50),
});

/** Inbox reads need the caller's existing owner capability and the live question fence; neither is minted here. */
export interface WorkInboxContext {
  readonly authority: QuestionAuthority;
  readonly captain: Pick<CaptainPort, "prepareInboxQuestions">;
  /**
   * Host-only, set by the inbox call and read by its route after the route's last await.
   * It rechecks the live question, project and link fences; it is never serialized.
   */
  finalCheck?: () => void;
  effect?: "uncertain" | "applied";
  idempotencyKey?: string;
}
export const INBOX_PENDING_QUESTIONS_TOOL = "inbox_pending_questions";

export interface WorkItemsServiceOptions {
  readonly projects?: () => Promise<ProjectsSettings>;
  readonly projectsFence?: () => Promise<WorkProjectFence>;
  readonly localMachineId?: string;
  /** Where the registry of readable repos lives. */
  readonly stateDirectory: string;
  /** The shared local tracker, when it lives outside the service's normal state root. */
  readonly globalTrackerDirectory?: string;
  /**
   * Opens the service's built-in tracker, optionally scoped to one project's issues,
   * for repos whose convention is `builtin` (VUH-1987). Defaults to the shared store.
   */
  readonly builtInTracker?: (
    assertIssueWrite?: (issue: Readonly<Record<string, unknown>>) => void,
  ) => TrackerToolBackend & Partial<Pick<LocalTrackerBackend, "referenceProjects">>;
  /** The captain's working directory, always readable as `workspace`. */
  readonly workspace?: () => string | undefined;
  readonly mcpHost?: Pick<McpHost, "call"> & Partial<Pick<McpHost, "account" | "binding" | "trackerStatus">>;
  /**
   * The body's GitHub account connection token (ADR 0196). When present it is
   * used instead of `gh`. Without it, writes from devices and connected apps use the
   * owner's `gh` login on this machine (ADR 0191, #98); a hosted body has none.
   */
  readonly githubToken?: () => Promise<string | undefined>;
  readonly hosted?: boolean;
  /** Test seams; production shells out to git and gh and calls api.github.com. */
  readonly run?: CommandRunner;
  readonly gh?: GhRunner;
  readonly fetch?: typeof fetch;
  readonly githubApiBase?: string;
  readonly clock?: () => Date;
  /** The check every outward tracker write passes (ADR 0302); absent, writes are not checked. */
  readonly posting?: Pick<TrackerPostingGate, "admit"> & Partial<Pick<TrackerPostingGate, "watching">>;
}

export type WorkResult =
  | WorkProjectDetailsResult
  | WorkProjectResult
  | { readonly repos: WorkRepo[] }
  | {
      readonly repo: WorkRepo;
      readonly signals: WorkSignal[];
      readonly convention?: WorkConvention;
      readonly question?: string;
    }
  | { readonly repo: WorkRepo; readonly convention: WorkConvention }
  | { readonly repo: WorkRepo; readonly items: WorkItem[] }
  | { readonly repo: WorkRepo; readonly item: WorkItem }
  | { readonly repo: WorkRepo; readonly itemId: string; readonly entries: WorkActivityEntry[] };

const workPatch = (request: Extract<WorkRequest, { action: "update" }>): WorkItemPatch => ({
  ...(request.status === undefined ? {} : { status: request.status }),
  ...(request.priority === undefined ? {} : { priority: request.priority }),
  ...(request.owner === undefined ? {} : { owner: request.owner }),
  ...(request.title === undefined ? {} : { title: request.title }),
  ...(request.dependsOn === undefined ? {} : { dependsOn: request.dependsOn }),
  ...(request.addDependsOn === undefined ? {} : { addDependsOn: request.addDependsOn }),
  ...(request.addLabels === undefined ? {} : { addLabels: request.addLabels }),
  ...(request.removeLabels === undefined ? {} : { removeLabels: request.removeLabels }),
  ...(request.check === undefined ? {} : { check: request.check }),
  ...(request.uncheck === undefined ? {} : { uncheck: request.uncheck }),
  ...(request.addCriteria === undefined ? {} : { addCriteria: request.addCriteria }),
});

export class WorkRequestError extends Error {
  readonly code:
    | "unknown_repo"
    | "not_found"
    | "needs_decision"
    | "backend_unavailable"
    | "invalid"
    | "result_too_large"
    /** Posting to the project's tracker stopped this write (ADR 0302); nothing was written. */
    | "posting_refused"
    | "posting_held";
  readonly question: string | undefined;
  readonly signals: WorkSignal[] | undefined;
  constructor(
    code: WorkRequestError["code"],
    message: string,
    extra: { question?: string; signals?: WorkSignal[] } = {},
  ) {
    super(message);
    this.name = "WorkRequestError";
    this.code = code;
    this.question = extra.question;
    this.signals = extra.signals;
  }
}

export const defaultRun: CommandRunner = async (command, args, cwd) =>
  (await execFileAsync(command, [...args], { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }))
    .stdout;

const defaultGh =
  (cwd: string): GhRunner =>
  async (args, stdin) =>
    new Promise((resolvePromise, reject) => {
      const child = execFile(
        "gh",
        [...args],
        { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) =>
          error ? reject(new Error(`${error.message}\n${String(stderr)}`)) : resolvePromise(String(stdout)),
      );
      if (stdin !== undefined) child.stdin?.end(stdin);
    });

function repoId(path: string): string {
  const name = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return `${name || "repo"}-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`;
}

/** A file's identity and timestamps, or `absent`; any write replaces or touches it. */
function fileVersion(path: string): string {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

/** A built-in store's version, `absent` without one: a commit may touch only its journal. */
function trackerVersion(path: string): string {
  try {
    return trackerStoreVersion(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

/** Fences one route input. Its version is taken before the read, so a racing write fails the fence. */
function fenceRouteFile(fence: TrackerRouteFence | undefined, path: string, version = fileVersion) {
  if (!fence) return;
  const before = version(path);
  fence(() => {
    if (version(path) !== before) throw new Error("The tracker route changed");
  });
}

export function createWorkItemsService(options: WorkItemsServiceOptions) {
  const projectReader =
    options.projects && options.localMachineId
      ? createProjectWorkReader({
          projects: options.projects,
          localMachineId: options.localMachineId,
          trackerProject: async (id) => {
            const tracker = openBuiltIn();
            if (!("storeId" in tracker) || typeof tracker.storeId !== "function")
              throw new Error("Built-in tracker store cannot be verified");
            const readStoreId = tracker.storeId.bind(tracker);
            const storeId: unknown = await readStoreId();
            if (typeof storeId !== "string" || !storeId)
              throw new Error("Built-in tracker store is unavailable");
            const project = (await tracker.call("get_project", { query: id })) as { id?: unknown };
            if (project.id !== id) throw new Error("Built-in tracker project or store changed");
            const validate = async () => {
              // Publication already holds the store lock; tool calls would wait on that same lock.
              if (!("projectStoreId" in tracker) || typeof tracker.projectStoreId !== "function")
                throw new Error("Built-in tracker project cannot be verified");
              if ((await tracker.projectStoreId(id)) !== storeId)
                throw new Error("Built-in tracker project or store changed");
            };
            await validate();
            return validate;
          },
        })
      : undefined;
  const registryPath = join(options.stateDirectory, "work-repos.json");
  const writeReceipts = new WorkWriteReceipts(join(options.stateDirectory, "work-write-receipts.json"));
  const writeLocks = new Map<string, Promise<unknown>>();
  // Shared GitHub collection reads, including the existing issue poller. Token
  // fingerprints isolate bindings; rejected pages cool down instead of retrying per device.
  const githubReads = new Map<string, { expires: number; promise: Promise<unknown[]> }>();
  const cacheGithub = (
    api: NonNullable<TrackerDeps["github"]>,
    binding: string,
  ): NonNullable<TrackerDeps["github"]> => ({
    async request(method, path, body) {
      try {
        return await api.request(method, path, body);
      } finally {
        if (method !== "GET") githubReads.clear();
      }
    },
    async list(path) {
      const key = `${binding}:${path}`;
      const now = clock().getTime();
      for (const [key, entry] of githubReads) if (entry.expires <= now) githubReads.delete(key);
      let entry = githubReads.get(key);
      if (!entry) {
        if (githubReads.size >= 128)
          throw new Error("GitHub work reads are busy; retry after a snapshot expires");
        entry = { expires: Number.POSITIVE_INFINITY, promise: Promise.resolve([]) };
        const selected = entry;
        entry.promise = api.list(path).then(
          (value) => {
            selected.expires = clock().getTime() + 60_000;
            return value;
          },
          (error) => {
            selected.expires = clock().getTime() + 30_000;
            throw error;
          },
        );
        githubReads.set(key, entry);
      }
      const result = await entry.promise;
      if (githubReads.get(key) !== entry)
        throw new Error("GitHub work snapshot changed. Read the work again.");
      return structuredClone(result);
    },
  });
  const run = options.run ?? defaultRun;
  const clock = options.clock ?? (() => new Date());

  const linear: LinearToolCall | undefined =
    options.mcpHost === undefined
      ? undefined
      : async (tool, args) => {
          const result = await options.mcpHost!.call({
            lane: "operator",
            server: "linear",
            tool,
            arguments: args,
            resultMode: "data",
            // `handle` checks posting before any write reaches here (ADR 0302).
            posting: TRACKER_POSTING_ADMITTED,
          });
          if (result.outcome === "refused" && result.reason === "result_too_large")
            throw new WorkRequestError("result_too_large", `Linear ${tool}: ${result.detail}`);
          if (result.outcome !== "ok") throw new Error(`Linear ${tool}: ${result.detail}`);
          if (result.isError) throw new Error(`Linear ${tool}: ${result.content.slice(0, 500)}`);
          return result.content.trim().length === 0 ? undefined : (JSON.parse(result.content) as unknown);
        };

  const readRegistry = async () => {
    try {
      return RegistrySchema.parse(JSON.parse(await readFile(registryPath, "utf8"))).repos;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  const writeRegistry = async (repos: { id: string; path: string; name: string }[]) => {
    await mkdir(options.stateDirectory, { recursive: true });
    const temporary = `${registryPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ repos }, null, 2)}\n`, "utf8");
    await rename(temporary, registryPath);
  };

  const known = async () => {
    const repos = await readRegistry();
    const workspace = options.workspace?.();
    return workspace === undefined || repos.some((repo) => repo.path === resolve(workspace))
      ? repos
      : [{ id: "workspace", path: resolve(workspace), name: basename(workspace) }, ...repos];
  };

  /**
   * A linked Git worktree's main checkout, or undefined for a main checkout
   * or a folder Git doesn't know. A hire's worktree, or Claude Code's
   * `.claude/worktrees/agent-…`, is that checkout's repo, not one named after
   * its folder (VUH-2848). Read once per path.
   */
  const checkouts = new Map<string, Promise<string | undefined>>();
  const mainCheckout = (path: string): Promise<string | undefined> => {
    let main = checkouts.get(path);
    if (main === undefined) {
      main = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], path).then(
        (output) => {
          const [common, own] = output.trim().split("\n");
          return common && own && common !== own && basename(common) === ".git" ? dirname(common) : undefined;
        },
        () => undefined,
      );
      checkouts.set(path, main);
    }
    return main;
  };

  /**
   * The repos to offer, named for people. A worktree whose checkout is listed
   * and reads the same remote tracker (Linear or GitHub, bound alike), or the
   * checkout's private issue files (`.clankie/work/` lives once, in the main
   * checkout), is that checkout, so it is not offered twice. A worktree with
   * its own committed file-backed work stays offered, so its items stay
   * discoverable, as "<checkout> (worktree)" rather than by its folder (VUH-2848).
   */
  const listed = async () => {
    const repos = await known();
    const byPath = new Map(repos.map((repo) => [repo.path, repo]));
    const shown: typeof repos = [];
    for (const repo of repos) {
      const main = await mainCheckout(repo.path);
      if (main === undefined) {
        shown.push(repo);
        continue;
      }
      const checkout = byPath.get(main);
      if (checkout !== undefined && (await sameRemoteTracker(repo.path, checkout.path))) continue;
      shown.push({ ...repo, name: checkout === undefined ? basename(main) : `${basename(main)} (worktree)` });
    }
    return shown;
  };
  /**
   * Both read one remote tracker binding, or the one private issue folder in the main
   * checkout. Committed file-backed work (`docs/tasks`) lives in each worktree and is never the same.
   */
  const sameRemoteTracker = async (left: string, right: string) => {
    const [a, b] = await Promise.all(
      // allow-swallowed-rejection -- an unreadable convention can't prove a shared tracker, so the worktree stays listed.
      [left, right].map((path) => readConvention(path).catch(() => undefined)),
    );
    // The private folder both read, normalized, so `.clankie/work/a` never matches `.clankie/work/b`.
    const privateFiles = (convention: typeof a) => {
      const directory = convention === undefined ? undefined : conventionWorkDirectory(convention);
      if (directory === undefined || !isPrivateWorkDirectory(directory)) return undefined;
      return posix.normalize(directory.replace(/\\/gu, "/")).replace(/\/+$/u, "");
    };
    const folder = privateFiles(a);
    // The checkout with no saved choice yet discovers the default folder its worktree writes.
    if (folder !== undefined)
      return b === undefined ? folder === DEFAULT_WORK_DIRECTORY : privateFiles(b) === folder;
    if (a === undefined || b === undefined || a.backend !== b.backend) return false;
    // A built-in binding lives in host settings, not here, so it is never proven shared.
    if (a.backend !== "linear" && a.backend !== "github") return false;
    const binding = (convention: typeof a) =>
      JSON.stringify((convention as unknown as Record<string, unknown>)[convention.backend] ?? null);
    return binding(a) === binding(b);
  };

  /** Registers a local path the operator or an agent named, so the app can read it later. */
  const register = async (path: string) => {
    const repos = await readRegistry();
    const absolute = resolve(path);
    const existing = (await known()).find((repo) => repo.path === absolute);
    if (existing !== undefined) return existing;
    // A worktree keeps its own path, so committed file-backed work is written where its agent
    // commits (private issue files resolve to the checkout's); it is named after its checkout,
    // and the repo list offers the checkout (see `listed`).
    const main = await mainCheckout(absolute);
    const entry = { id: repoId(absolute), path: absolute, name: basename(main ?? absolute) };
    await writeRegistry([...repos.filter((repo) => repo.path !== absolute), entry].slice(-50));
    return entry;
  };

  /**
   * A device may only name a registered repo id. A local caller (the CLI, the
   * captain, a hire on this machine) may also name a path, which registers it.
   */
  const locate = async (ref: string, local: boolean) => {
    const repos = await known();
    const byId = repos.find((repo) => repo.id === ref);
    if (byId !== undefined) return byId;
    if (local && isAbsolute(ref)) return register(ref);
    // Only a registered id addresses a repo here. Name it, so a caller that
    // gave a registered path can correct the call itself (VUH-2244).
    const byPath = isAbsolute(ref) ? repos.find((repo) => repo.path === resolve(ref)) : undefined;
    throw new WorkRequestError(
      "unknown_repo",
      byPath === undefined
        ? `No registered repo ${ref}`
        : `Name repo ${ref} by its registered id ${byPath.id}; a path is accepted only from this machine's own CLI and Clankie.`,
    );
  };

  const describe = async (entry: { id: string; path: string; name: string }): Promise<WorkRepo> => {
    const convention = await readConvention(entry.path).catch(() => undefined);
    return {
      id: entry.id,
      name: entry.name,
      root: entry.path,
      ...(convention === undefined ? {} : { backend: convention.backend }),
      needsDecision: convention === undefined,
    };
  };

  const openBuiltIn =
    options.builtInTracker ??
    ((assertIssueWrite?: (issue: Readonly<Record<string, unknown>>) => void) =>
      createLocalTracker({
        directory: options.globalTrackerDirectory ?? join(options.stateDirectory, "tracker"),
        ...(options.projects === undefined
          ? {}
          : {
              authorizeGuidedReviewSource: createGuidedReviewSourceAuthorizer({
                projects: options.projects,
                ...(options.projectsFence === undefined ? {} : { projectsFence: options.projectsFence }),
                ...(options.localMachineId === undefined ? {} : { localMachineId: options.localMachineId }),
              }),
            }),
        ...(assertIssueWrite === undefined ? {} : { assertIssueWrite }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      }));
  const routingTracker = openBuiltIn();
  const referenceProjects =
    typeof routingTracker.referenceProjects === "function"
      ? routingTracker.referenceProjects.bind(routingTracker)
      : undefined;
  const builtInRecordProjects = async (references: readonly string[]) => {
    try {
      if (referenceProjects === undefined) throw new Error("Built-in tracker lacks referenceProjects");
      return await referenceProjects(references);
    } catch {
      // A missing, damaged or replaced store must never become "no cut-over item".
      throw new WorkRequestError(
        "backend_unavailable",
        "The built-in tracker that holds cut-over projects cannot be read, so this tracker call has nowhere safe to go.",
      );
    }
  };
  /**
   * The tracker project the owner bound this workspace's settings project to, if any.
   * A caller acting for one settings project names it, since projects may share a path.
   */
  const builtInBinding = async (path: string, projectId?: string): Promise<TrackerDeps["builtIn"]> => {
    const machine = options.localMachineId ?? "local";
    const project = (await options.projects?.())?.projects.find(
      (entry) =>
        (projectId === undefined || entry.id === projectId) &&
        entry.trackerProjectId !== undefined &&
        entry.workspaces.some(
          (workspace) => workspace.machineId === machine && resolve(workspace.path) === resolve(path),
        ),
    );
    if (project?.trackerProjectId === undefined) return undefined;
    const view = (await openBuiltIn()
      .call("get_project", { query: project.trackerProjectId })
      .catch(() => undefined)) as { id?: unknown; leadTeam?: { id?: unknown } } | undefined;
    const teamId = view?.leadTeam?.id;
    if (view?.id !== project.trackerProjectId || typeof teamId !== "string") return undefined;
    return { projectId: project.trackerProjectId, teamId, open: openBuiltIn };
  };

  /**
   * The tracker a convention's writes reach off this Mac (ADR 0302): GitHub issues, or
   * Linear while it is connected. A disconnected Linear repo writes to the local
   * compatibility store, which stays here like issue files.
   */
  const outwardTracker = async (
    convention: WorkConvention | undefined,
  ): Promise<"linear" | "github" | undefined> => {
    if (convention?.backend === "github") return "github";
    if (convention?.backend !== "linear" || linear === undefined) return undefined;
    return (await options.mcpHost?.trackerStatus?.())?.backend === "local" ? undefined : "linear";
  };

  const destinationOf = (convention: WorkConvention) => {
    const destination = postingDestination(convention);
    return destination === undefined ? {} : { destination };
  };

  const deps = async (path: string, local = true, projectId?: string): Promise<TrackerDeps> => {
    const token = await options.githubToken?.();
    const builtIn = await builtInBinding(path, projectId);
    const localTracker = (await options.mcpHost?.trackerStatus?.())?.backend === "local";
    return {
      run,
      // A delegated call uses the connected account when there is one, else the owner's gh login.
      ...(options.hosted === true || (!local && token !== undefined)
        ? {}
        : { gh: options.gh ?? defaultGh(path) }),
      ...(token === undefined
        ? {}
        : {
            github: cacheGithub(
              githubRestApi({
                token,
                ...(options.githubApiBase === undefined ? {} : { baseUrl: options.githubApiBase }),
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
              }),
              createHash("sha256").update(token).digest("hex"),
            ),
          }),
      ...(linear === undefined || localTracker ? {} : { linear }),
      clock,
      trackerDirectory: join(options.stateDirectory, "repo-trackers", repoId(path)),
      ...(builtIn === undefined ? {} : { builtIn }),
      // The operator bearer is a local caller (the CLI, the lead seat, a hire), not proof
      // of the human: its writes are Clankie's, for the owner. Callers that know better
      // (a worker's grant, the owner's own route, an app device) replace it (LOCAL-VUH-1).
      actor: CLANKIE_FOR_OWNER,
    };
  };

  const tracker = async (
    path: string,
    record: boolean,
    requireRecorded = false,
    local = true,
    beforeWrite?: () => Promise<void>,
  ) => {
    try {
      return await resolveTracker(
        path,
        { ...(await deps(path, local)), ...(beforeWrite === undefined ? {} : { beforeWrite }) },
        { record, requireRecorded },
      );
    } catch (error) {
      if (error instanceof ConventionNeededError)
        throw new WorkRequestError("needs_decision", error.message, {
          ...(error.discovery.question === undefined ? {} : { question: error.discovery.question }),
          signals: error.discovery.signals,
        });
      if (error instanceof Error && error.name === "BackendUnavailableError")
        throw new WorkRequestError("backend_unavailable", error.message);
      throw error;
    }
  };

  /**
   * A built-in tracker item named with its project, as `work ready --project` lists it
   * (VUH-2805): the shared store scoped to that project, whatever repo the caller stands in.
   * An item outside the project is not found there; writes are scope-checked again.
   */
  const builtInProjectItem = async (project: string, id: string, beforeWrite?: () => Promise<void>) => {
    const store = openBuiltIn();
    // The store's own lookup misses are answers; any other failure propagates.
    const lookup = async (name: string, args: Record<string, unknown>, missing: string) => {
      try {
        return await store.call(name, args);
      } catch (error) {
        if (error instanceof Error && /^(?:Issue|Project) not found:/u.test(error.message))
          throw new WorkRequestError("not_found", missing);
        if (error instanceof Error && error.message.startsWith("Project name is ambiguous:"))
          throw new WorkRequestError("invalid", error.message);
        throw error;
      }
    };
    const view = (await lookup(
      "get_project",
      { query: project },
      `No built-in tracker project ${project}`,
    )) as { id?: unknown; name?: unknown; leadTeam?: { id?: unknown } } | undefined;
    if (typeof view?.id !== "string" || typeof view.leadTeam?.id !== "string")
      throw new WorkRequestError("not_found", `No built-in tracker project ${project}`);
    const issue = (await lookup(
      "get_issue",
      { id },
      `No work item ${id} in built-in tracker project ${project}`,
    )) as { projectId?: unknown } | undefined;
    if (issue?.projectId !== view.id)
      throw new WorkRequestError("not_found", `No work item ${id} in built-in tracker project ${project}`);
    const builtIn = { projectId: view.id, teamId: view.leadTeam.id, open: openBuiltIn };
    const convention: WorkConvention = {
      schemaVersion: 1,
      backend: "builtin",
      decidedBy: "owner",
      decidedAt: clock().toISOString(),
    };
    const repo: WorkRepo = {
      id: "builtin",
      name: typeof view.name === "string" ? view.name.slice(0, 200) : "Built-in tracker",
      trackerProjectId: view.id,
      backend: "builtin",
      needsDecision: false,
    };
    return {
      repo,
      backend: backendFor(options.stateDirectory, convention, {
        run,
        clock,
        builtIn,
        actor: CLANKIE_FOR_OWNER,
        scopedWrites: true,
        ...(beforeWrite === undefined ? {} : { beforeWrite }),
      }),
    };
  };

  /**
   * The cut-over project whose built-in tracker holds what a tracker call names (VUH-2829):
   * an imported `TEAM-n`, a `LOCAL-TEAM-n`, a record UUID, or the project's own id or name.
   * A cut-over project is bound to a built-in tracker project and its saved convention is
   * not `linear` (an unreadable one counts, so nothing falls back to Linear). Undefined
   * when the references name none; refuses when they name two, when a reference another
   * project shares could name one, or when the store cannot be read. With `fence`, the
   * conventions it read are fenced; the default store is not, as in resolveTrackerRepo.
   */
  const cutoverRepoForReferences = async (
    references: readonly string[],
    fence?: TrackerRouteFence,
  ): Promise<{ repo: string; project: string; trackerProjectId: string } | undefined> => {
    if (references.length === 0) return undefined;
    const machine = options.localMachineId ?? "local";
    const cutover = new Map<string, { repo: string; project: string; trackerProjectId: string }>();
    for (const project of (await options.projects?.())?.projects ?? []) {
      if (project.trackerProjectId === undefined) continue;
      const workspace = project.workspaces.find((entry) => entry.id === project.trackerRef?.workspaceId);
      let backend: string | undefined;
      if (workspace?.machineId === machine) {
        fenceRouteFile(fence, join(workspace.path, CONVENTION_FILE));
        // allow-swallowed-rejection -- an unreadable convention counts as cut over, never as Linear.
        backend = (await readConvention(workspace.path).catch(() => undefined))?.backend;
      }
      if (backend !== "linear")
        cutover.set(project.trackerProjectId, {
          repo: projectWorkRepoId(project.id),
          project: project.name,
          trackerProjectId: project.trackerProjectId,
        });
    }
    if (cutover.size === 0) return undefined;
    const index = await builtInRecordProjects(references);
    const matched = new Set<string>();
    for (const reference of references) {
      const owners = [...(index.get(reference.toLowerCase()) ?? [])];
      const cutOver = owners.filter((owner) => cutover.has(owner));
      if (cutOver.length === 0) continue;
      // A name another project shares never decides the route: guessing could reach Linear.
      if (owners.length > 1)
        throw new WorkRequestError(
          "invalid",
          `${reference} names more than one tracker project's record, one of them cut over to the built-in tracker. Name it by its UUID.`,
        );
      matched.add(cutOver[0]!);
    }
    if (matched.size > 1)
      throw new WorkRequestError(
        "invalid",
        "This call names items of more than one cut-over project. Make one call per project.",
      );
    return matched.size === 1 ? cutover.get([...matched][0]!) : undefined;
  };
  const authorizeWrite = async (authority: WorkWriteAuthority) => {
    if (!authority.current() || !(await authority.authorize()) || !authority.current())
      throw new Error("Owner authority expired or was revoked. Read the work again.");
  };
  const prepareWrite = async (repoId: string, authority: WorkWriteAuthority) => {
    await authorizeWrite(authority);
    return prepareWorkWriteTarget({
      repoId,
      ...(options.localMachineId === undefined ? {} : { localMachineId: options.localMachineId }),
      ...(options.projectsFence === undefined ? {} : { projectsFence: options.projectsFence }),
      locate: async () => {
        const entry = await locate(repoId, false);
        const registry = () => {
          try {
            return readFileSync(registryPath, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          }
        };
        const saved = registry();
        const workspace = options.workspace?.();
        // Close the await between registry lookup and capturing its generation.
        if (!(await known()).some((repo) => repo.id === repoId && repo.path === entry.path))
          throw new Error("Saved work repository changed.");
        return {
          path: entry.path,
          assertCurrent: () => {
            if (registry() !== saved || options.workspace?.() !== workspace)
              throw new Error("Saved work repository changed.");
          },
        };
      },
    });
  };
  const receipt = (
    requestId: string,
    outcome: WorkItemWriteReceipt["outcome"],
    message: string,
  ): WorkItemWriteReceipt => ({ requestId, outcome, message });
  /** The GitHub login gh is signed in as on this machine, or undefined when it isn't. */
  const ghLogin = async (): Promise<string | undefined> => {
    try {
      const login = (await (options.gh ?? defaultGh(homedir()))(["api", "user", "--jq", ".login"])).trim();
      return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(login) ? login : undefined;
    } catch {
      return undefined;
    }
  };
  const accountBinding = async (kind: WorkConvention["backend"]) => {
    if (kind === "linear") {
      if (options.mcpHost?.binding) return (await options.mcpHost.binding("linear", "operator")).binding;
      if (!options.mcpHost?.account) throw new Error("Connected Linear account cannot be checked.");
      return (await options.mcpHost.account("linear", "operator")).binding;
    }
    if (kind === "github") {
      const token = await options.githubToken?.();
      // Owner writes use the connected account, else the owner's gh login on this machine.
      if (token) return deliveryFingerprint(token);
      const login = options.hosted === true ? undefined : await ghLogin();
      if (login === undefined)
        throw new Error(
          "Sign in to GitHub on this machine with `gh auth login`, or connect GitHub to Clankie, to write work from a device.",
        );
      return deliveryFingerprint(`gh:${login}`);
    }
    return "files";
  };
  const linearProjects = linear
    ? createLinearWorkProjects({
        call: linear,
        binding: async () => {
          if ((await options.mcpHost?.trackerStatus?.())?.backend === "local")
            throw new Error("Linear is not connected.");
          return accountBinding("linear");
        },
        ...(options.projects ? { projects: options.projects } : {}),
        builtInRepos: async () => (await projectReader?.repos()) ?? [],
        root: options.stateDirectory,
      })
    : undefined;
  const writeScope = async (request: WorkItemWriteReceiptRequest, authority: WorkWriteAuthority) => {
    const target = await prepareWrite(request.repoId, authority);
    const account = await accountBinding(target.convention.backend);
    await authorizeWrite(authority);
    target.assertCurrent();
    return {
      target,
      account,
      scope: {
        owner: authority.principal,
        repoId: request.repoId,
        itemId: request.itemId,
        binding: deliveryFingerprint(JSON.stringify([target.binding, account])),
      },
    };
  };
  const handleOwnerWrite = async (
    request: WorkItemWriteRequest,
    authority: WorkWriteAuthority,
    prepareFree?: (
      intent: import("@clankie/protocol").FreeAgentIntent,
    ) => Promise<{ assertCurrent(): void; guard(): Promise<void>; ownerName: string | undefined }>,
    prepareWorkHandoff?: (
      intent: import("@clankie/protocol").WorkHandoffIntent,
    ) => Promise<{ assertCurrent(): void; guard(): Promise<void>; ownerName: string | undefined }>,
  ): Promise<WorkItemWriteReceipt> => {
    // A cut-over project's item named from a Linear repo is written in its built-in tracker, as
    // `work update` is; the receipt binds to that project's repo (VUH-2829). An unknown or
    // unreadable repo keeps its own write path and its own refusal.
    const backend = /^project-[a-f0-9]{48}$/u.test(request.repoId)
      ? // allow-swallowed-rejection -- the write path below refuses an unreadable project itself.
        (await projectReader?.prepare(request.repoId).catch(() => undefined))?.convention.backend
      : await locate(request.repoId, false).then(
          (entry) => readConvention(entry.path).then((convention) => convention?.backend),
          // allow-swallowed-rejection -- the write path below refuses an unknown repo itself.
          () => undefined,
        );
    const cutover = backend === "linear" ? await cutoverRepoForReferences([request.itemId]) : undefined;
    if (cutover) request = { ...request, repoId: cutover.repo };
    const key = JSON.stringify([request.repoId, request.itemId]);
    const operation = async (): Promise<WorkItemWriteReceipt> => {
      let begun = false;
      let dispatched = false;
      let confirmed = false;
      try {
        const { target, account, scope } = await writeScope(request, authority);
        const intent = request.freeAgent ?? request.workHandoff;
        if (
          intent &&
          (request.command.action !== "assign" ||
            request.freeAgent?.helpTarget ||
            request.repoId !== projectWorkRepoId(intent.projectId))
        )
          throw new Error("This drop does not match the original project's work tracker.");
        const free = request.freeAgent
          ? await prepareFree?.(request.freeAgent)
          : request.workHandoff
            ? await prepareWorkHandoff?.(request.workHandoff)
            : undefined;
        if (intent && !free)
          throw new Error(
            request.workHandoff
              ? "Work handoffs are unavailable on this host."
              : "Free-agent drops are unavailable on this host.",
          );
        if (
          free &&
          (request.command.action !== "assign" ||
            free.ownerName === undefined ||
            request.command.owner !== free.ownerName)
        )
          throw new Error("This drop changed the original agent assigned to the work.");
        const previous = writeReceipts.begin(
          request.requestId,
          scope,
          request.command,
          request.freeAgent,
          request.workHandoff,
        );
        if (previous) return previous;
        begun = true;
        // The operator bearer is any local caller, so on an outward tracker this is Clankie
        // posting: it meets the project's setting, and a held write goes later as this same
        // `work update` (ADR 0302). The owner's own app is exempt.
        if (authority.principal.kind !== "device")
          await checkWorkPosting(
            {
              action: "update",
              // Its local checkout: a project's reference is read-only to `work update`.
              repo: target.path,
              id: request.itemId,
              ...(request.command.action === "assign"
                ? { owner: request.command.owner }
                : request.command.action === "add_label"
                  ? { addLabels: [request.command.label] }
                  : request.command.action === "remove_label"
                    ? { removeLabels: [request.command.label] }
                    : { addDependsOn: [request.command.id] }),
            },
            target.convention,
            target.path,
            undefined,
            undefined,
          );
        const beforeWrite = () => {
          free?.assertCurrent();
          if (!authority.current()) throw new Error("Owner authority expired or was revoked.");
          target.assertCurrent();
        };
        const fence = async () => {
          await authorizeWrite(authority);
          await free?.guard();
          beforeWrite();
          return beforeWrite;
        };
        const onDispatch = () => {
          dispatched = true;
        };
        const effectConfirmed = () => {
          confirmed = true;
        };
        const dependencies = await deps(target.path);
        // No inferred backend on the owner-authorized path. GitHub goes through the connected
        // account, else through the gh login that accountBinding bound above.
        const writeDeps: { -readonly [K in keyof TrackerDeps]: TrackerDeps[K] } = {
          ...dependencies,
          scopedWrites: true,
          // The authenticated principal: an enrolled app device is the owner's app. The
          // operator bearer is any local caller (CLI, lead seat, hire), so Clankie writes for the owner.
          actor:
            authority.principal.kind === "device"
              ? { type: "app", id: `device:${authority.principal.id}`, onBehalfOf: [TRACKER_OWNER] }
              : CLANKIE_FOR_OWNER,
          beforeWrite: async () => {
            await free?.guard();
            beforeWrite();
          },
          effectConfirmed,
          ...(target.convention.backend === "default" ||
          target.convention.backend === "markdown" ||
          target.convention.backend === "builtin" ||
          (target.convention.backend === "linear" && dependencies.linear === undefined)
            ? { onDispatch }
            : {}),
        };
        if (target.convention.backend === "linear" && dependencies.linear !== undefined) {
          writeDeps.linear = async (tool, args) => {
            const writing = tool === "save_issue";
            if (!options.mcpHost) throw new Error("Linear is unavailable.");
            if ((await accountBinding("linear")) !== account)
              throw new Error("Connected Linear account changed.");
            const result = await options.mcpHost.call({
              lane: "operator",
              server: "linear",
              tool,
              arguments: args,
              resultMode: "data",
              // The owner's own write is his (ADR 0302).
              posting: TRACKER_POSTING_ADMITTED,
              fence,
              ...(writing
                ? {
                    onDispatch,
                    onSettled: (settled: { isError: boolean }) => {
                      if (!settled.isError) effectConfirmed();
                    },
                  }
                : {}),
            });
            if (result.outcome !== "ok") {
              if (writing) dispatched = result.possiblyDispatched === true;
              throw new Error("Connected provider did not return a settled result.");
            }
            if (result.isError) throw new Error("Connected provider refused the write.");
            return result.content.trim() ? (JSON.parse(result.content) as unknown) : undefined;
          };
        }
        if (target.convention.backend === "linear" && dependencies.linear === undefined) {
          writeDeps.beforeWrite = async () => {
            await authorizeWrite(authority);
            await free?.guard();
            if ((await accountBinding("linear")) !== account)
              throw new Error("Connected Linear account or local tracker changed.");
            beforeWrite();
          };
        }
        if (target.convention.backend === "github") {
          const api =
            dependencies.github ?? (dependencies.gh === undefined ? undefined : ghCliApi(dependencies.gh));
          if (!api) throw new Error("GitHub is unavailable.");
          writeDeps.github = {
            ...api,
            request: async (method, path, body) => {
              if (method !== "GET") {
                await authorizeWrite(authority);
                await free?.guard();
                if ((await accountBinding("github")) !== account)
                  throw new Error("Connected GitHub account changed.");
                beforeWrite();
                onDispatch();
              }
              return api.request(method, path, body);
            },
          };
          delete writeDeps.gh;
        }
        // Files have no credential await; authorization is renewed before preparation and checked at rename.
        await authorizeWrite(authority);
        beforeWrite();
        const backend = backendFor(target.path, target.convention, writeDeps);
        const command = request.command;
        let patch: WorkItemPatch;
        switch (command.action) {
          case "assign":
            patch = { owner: command.owner };
            break;
          case "add_label":
            patch = { addLabels: [command.label] };
            break;
          case "remove_label":
            patch = { removeLabels: [command.label] };
            break;
          case "add_dependency":
            if (command.id === request.itemId) throw new Error("An item cannot block itself.");
            patch = { addDependsOn: [command.id] };
            break;
        }
        const item = await backend.update(request.itemId, patch);
        return writeReceipts.settle(request.requestId, {
          ...receipt(request.requestId, "applied", "Work item updated."),
          item,
        });
      } catch (error) {
        const result = confirmed
          ? receipt(
              request.requestId,
              "applied",
              "The tracker accepted the write. Refresh the item to read its current state.",
            )
          : dispatched
            ? receipt(
                request.requestId,
                "uncertain",
                "The write may have happened. Read this receipt and the tracker; this request will never be replayed.",
              )
            : receipt(
                request.requestId,
                "refused",
                (error instanceof WorkRequestError &&
                  (error.code === "posting_refused" || error.code === "posting_held")) ||
                  (error instanceof Error &&
                    (error.name === "WorkItemScopeError" ||
                      /^(Owner authority|Saved work|Connected .* account|An item cannot|No work item|Work item .*outside|Role label|This project|Project work|Connect GitHub)/u.test(
                        error.message,
                      )))
                  ? error.message
                  : "This saved work tracker cannot accept the write. Read the work again and check its connection.",
              );
        if (!begun) return result;
        try {
          return writeReceipts.settle(request.requestId, result);
        } catch {
          return receipt(
            request.requestId,
            "uncertain",
            "The receipt could not be settled. The write may have happened; inspect the tracker and never resend it.",
          );
        }
      }
    };
    const pending = (writeLocks.get(key) ?? Promise.resolve()).then(operation, operation);
    writeLocks.set(key, pending);
    try {
      return await pending;
    } finally {
      if (writeLocks.get(key) === pending) writeLocks.delete(key);
    }
  };

  /**
   * Pending, tracker-linked owner questions for one bound built-in project. Read only: the
   * rows name questions; they grant no right to answer, cancel or approve them.
   */
  const inboxPendingQuestions = async (
    repo: string,
    local: boolean,
    toolArgs: Record<string, unknown>,
    inbox: WorkInboxContext | undefined,
    name: string,
    callbacks: TrackerToolCallOptions,
  ) => {
    const prepareInboxQuestions = inbox?.captain.prepareInboxQuestions?.bind(inbox.captain);
    // Native MCP and other routes without the owner mailbox capability refuse; there is no fallback.
    if (!inbox || !prepareInboxQuestions)
      throw new Error("Inbox questions need the owner's authenticated mailbox capability");
    const parsed = z.object({ project: z.string().uuid() }).passthrough().safeParse(toolArgs);
    if (!parsed.success) throw new Error("Invalid inbox scope");
    if (!callbacks.actor) throw new Error("Authenticated inbox actor is unavailable");
    if (!options.projectsFence) throw new Error("Current project authority is unavailable");
    const snapshot = await options.projectsFence();
    snapshot.assertCurrent();
    const target = await prepareWorkWriteTarget({
      repoId: repo,
      localMachineId: options.localMachineId ?? "local",
      projectsFence: async () => snapshot,
      locate: async () => {
        const entry = await locate(repo, local);
        snapshot.assertCurrent();
        return { path: entry.path, assertCurrent: snapshot.assertCurrent };
      },
    });
    if (target.convention.backend !== "builtin")
      throw new Error("Inbox questions are only available on the built-in tracker");
    const projects = snapshot.projects.projects.filter(
      (project) =>
        project.trackerRef !== undefined &&
        project.workspaces.some(
          (workspace) =>
            workspace.id === project.trackerRef?.workspaceId &&
            workspace.machineId === (options.localMachineId ?? "local") &&
            workspace.platform === (process.platform === "win32" ? "windows" : "posix") &&
            resolve(workspace.path) === target.path,
        ),
    );
    const project = projects.length === 1 ? projects[0] : undefined;
    if (
      !project?.trackerProjectId ||
      project.trackerProjectId !== parsed.data.project ||
      snapshot.projects.projects.filter((entry) => entry.trackerProjectId === project.trackerProjectId)
        .length !== 1
    )
      throw new Error("Inbox project does not match this repo's current built-in tracker binding");
    const tracker = openBuiltIn() as Partial<LocalTrackerBackend>;
    if (!tracker.inboxAttention) throw new Error("This tracker backend does not support inbox attention");
    const validate = () => {
      snapshot.assertCurrent();
      target.assertCurrent();
      if (!inbox.authority.current()) throw new Error("Owner authority expired");
    };
    validate();
    const result = await tracker.inboxAttention(name, toolArgs, {
      ...callbacks,
      actor: callbacks.actor,
      beforeWrite: async () => {
        await callbacks.beforeWrite?.();
        if (!(await inbox.authority.authorize())) throw new Error("Owner authority expired");
        validate();
      },
      onDispatch: () => {
        validate();
        callbacks.onDispatch?.();
        inbox.effect = "uncertain";
        inbox.idempotencyKey = toolArgs.idempotencyKey as string;
      },
      effectConfirmed: () => {
        inbox.effect = "applied";
        callbacks.effectConfirmed?.();
      },
      prepare: async (links): Promise<InboxPendingFence> => {
        const fences: Awaited<ReturnType<typeof prepareInboxQuestions>>[] = [];
        const rows: InboxPendingFence["rows"][number][] = [];
        const assertCurrent = () => {
          validate();
          for (const fence of fences) fence.assertCurrent();
        };
        // Use the existing bounded live-question read; no capped input_list or second inbox store.
        for (let offset = 0; offset < links.length; offset += 250) {
          const batch = links.slice(offset, offset + 250);
          const fence = await prepareInboxQuestions(
            batch.map((link) => link.requestId),
            inbox.authority,
          );
          fences.push(fence);
          assertCurrent();
          const byRequest = new Map(batch.map((link) => [link.requestId, link]));
          for (const row of fence.rows) {
            const link = byRequest.get(row.target.requestId)!;
            if (row.purpose !== link.purpose)
              throw new Error("Inbox link does not match the live question purpose");
            rows.push({ ...row, target: { ...row.target, issueId: link.issueId, eventId: link.eventId } });
          }
        }
        return {
          rows,
          assertCurrent,
          async recheck() {
            for (const fence of fences) {
              await fence.recheck();
              assertCurrent();
            }
            assertCurrent();
          },
        };
      },
    });
    validate();
    inbox.finalCheck = () => {
      validate();
      result.assertCurrent();
    };
    inbox.finalCheck();
    return result.value;
  };

  /** The projects whose workspaces or worktree roots on this machine hold this checkout (ADR 0302). */
  const projectIdsAt = async (path: string): Promise<string[]> => {
    const machine = options.localMachineId ?? "local";
    const at = resolve(path);
    const within = (root: string) => at === resolve(root) || at.startsWith(`${resolve(root)}/`);
    return ((await options.projects?.())?.projects ?? [])
      .filter(
        (project) =>
          project.workspaces.some(
            (workspace) => workspace.machineId === machine && resolve(workspace.path) === at,
          ) || project.worktreeRoots.some((root) => root.machineId === machine && within(root.path)),
      )
      .map((project) => project.id);
  };

  const refuseWhileWatching = async () => {
    if ((await options.posting?.watching?.()) === true)
      throw new WorkRequestError("posting_refused", WATCH_REFUSAL);
  };
  /**
   * Watch asked again as a work-item write commits, so a write waiting on the tracker's
   * lock when Watch is chosen changes nothing (ADR 0308). An owner-approved write is his.
   */
  const watchedWrite = (posting: typeof TRACKER_POSTING_ADMITTED | undefined) =>
    posting === TRACKER_POSTING_ADMITTED ? undefined : refuseWhileWatching;

  /** `clankie work create|update|attach` on an outward tracker is Clankie posting (ADR 0302). */
  const checkWorkPosting = async (
    request: WorkRequest,
    convention: WorkConvention,
    path: string,
    posting: typeof TRACKER_POSTING_ADMITTED | undefined,
    destination: string | undefined,
  ) => {
    if (posting === TRACKER_POSTING_ADMITTED) return assertDestination(convention, destination);
    if (!options.posting) return;
    const tracker = await outwardTracker(convention);
    // Watch refuses every tracker write that is not the owner's (ADR 0308). An outward
    // tracker's admission already refuses it; a local tracker has no admission, so ask here.
    if (tracker === undefined) return await refuseWhileWatching();
    const admission = await options.posting.admit({
      tracker,
      ...destinationOf(convention),
      route: { kind: "work", request: structuredClone(request) as Record<string, unknown> },
      asker: { kind: "lead" },
      projectIds: await projectIdsAt(path),
    });
    if (admission.outcome === "refused") throw new WorkRequestError("posting_refused", admission.message);
    if (admission.outcome !== "post") throw new WorkRequestError("posting_held", admission.message);
  };

  /**
   * Where a settings project keeps its work on this machine: its tracker workspace
   * (`trackerRef`), or else the one local workspace with a saved convention.
   * `work export` and drops both go by it.
   */
  const projectTracker = async (
    project: Project,
  ): Promise<
    | { readonly workspace: Project["workspaces"][number]; readonly convention: WorkConvention }
    | { readonly missing: "remote" | "unreadable" | "ambiguous" | "none" }
  > => {
    const machine = options.localMachineId ?? "local";
    const tracking =
      project.trackerRef === undefined
        ? undefined
        : project.workspaces.find((workspace) => workspace.id === project.trackerRef!.workspaceId);
    if (project.trackerRef !== undefined && tracking?.machineId !== machine) return { missing: "remote" };
    if (tracking !== undefined) {
      try {
        const convention = await readConvention(tracking.path);
        return convention === undefined ? { missing: "none" } : { workspace: tracking, convention };
      } catch {
        return { missing: "unreadable" };
      }
    }
    const saved = (
      await Promise.all(
        project.workspaces
          .filter((workspace) => workspace.machineId === machine)
          .map(async (entry) => ({
            entry,
            // allow-swallowed-rejection -- an unreadable convention is no saved tracker; the count below refuses.
            convention: await readConvention(entry.path).catch(() => undefined),
          })),
      )
    ).filter((entry) => entry.convention !== undefined);
    if (saved.length > 1) return { missing: "ambiguous" };
    return saved.length === 1
      ? { workspace: saved[0]!.entry, convention: saved[0]!.convention! }
      : { missing: "none" };
  };

  /**
   * Where a project's drops go (step 5, C3): its private `.clankie/work/` issue
   * files, in the main checkout of its local tracker workspace. Anything else is
   * refused in words that name the way there, and nothing is written.
   */
  const dropTarget = async (projectId: string): Promise<DropTarget> => {
    const project = (await options.projects?.())?.projects.find((entry) => entry.id === projectId);
    if (project === undefined)
      return { ready: false, reason: "unknown_project", message: `No project ${projectId}.` };
    const files = `'${JSON.stringify({ backend: "markdown", directory: DEFAULT_WORK_DIRECTORY })}'`;
    const select = `clankie project settings ${project.id} tracker ${files}`;
    const refused = (message: string): DropTarget => ({ ready: false, reason: "not_file_backed", message });
    // Decision 3 of step 5: a project Clankie runs by himself keeps the built-in tracker for now.
    if (project.auto === true)
      return refused(
        `${project.name} is on Auto, so its work stays in the built-in tracker and a drop has no issue file to go to. To drop into it, turn Auto off (clankie project settings ${project.id} --auto off), move its work with clankie work export --project ${project.id} --to markdown, then select the files with ${select}.`,
      );
    const located = await projectTracker(project);
    if (!("workspace" in located))
      return refused(
        located.missing === "remote"
          ? `${project.name}'s tracker workspace is on another machine, and drops are filed on this one.`
          : located.missing === "unreadable"
            ? `${project.name}'s saved work tracker (.clankie/tracking.json) can't be read, so the drop was not filed.`
            : located.missing === "ambiguous"
              ? `${project.name} has a saved tracker in more than one workspace here; choose one with clankie project settings ${project.id} tracker.`
              : `${project.name} has no saved work tracker on this machine. Drops are filed as private issue files: select them with ${select}.`,
      );
    const { workspace, convention } = located;
    // Linear or GitHub (ADR 0302): kept as a private issue file in the checkout first, which
    // the drop creates if needed (it ignores itself), then posted under the posting setting.
    if (convention.backend === "linear" || convention.backend === "github") {
      const repo = await register(workspace.path);
      // A disconnected Linear keeps the drop here: there is nowhere outward to post it.
      const outward =
        (await outwardTracker(convention)) === undefined ? undefined : postingDestination(convention);
      return {
        ready: true,
        project: { id: project.id, name: project.name },
        root: workspace.path,
        repoId: repo.id,
        tracker: convention.backend,
        ...(outward === undefined ? {} : { destination: outward }),
      };
    }
    const directory = conventionWorkDirectory(convention);
    if (directory === undefined)
      return refused(
        `${project.name} tracks work in the built-in tracker, and drops are filed only as private issue files. Move its open work with clankie work export --project ${project.id} --to markdown, then select the files with ${select}.`,
      );
    if (!isPrivateWorkDirectory(directory))
      return refused(
        `${project.name} keeps its work in committed files (${directory}), and drops are private: they go only to ${DEFAULT_WORK_DIRECTORY}. Select that folder with ${select}.`,
      );
    // Drops are filed and read in the private folder itself, never a folder inside it.
    if (posix.normalize(directory.replace(/\\/gu, "/")).replace(/\/+$/u, "") !== DEFAULT_WORK_DIRECTORY)
      return refused(
        `${project.name} keeps its issue files in ${directory}, and drops go only to ${DEFAULT_WORK_DIRECTORY} itself. Select that folder with ${select}.`,
      );
    const repo = await register(workspace.path);
    return {
      ready: true,
      project: { id: project.id, name: project.name },
      root: workspace.path,
      repoId: repo.id,
    };
  };

  return {
    handleOwnerWrite,
    /**
     * Resolve existing local identities without enrolling a repo or opening a tracker backend.
     * With `fence`, every file the answer depends on is fenced: the registry, conventions and
     * other repos' stores. The default store itself is not: a reference it gains or loses
     * cannot move the answer unless another store changes too, and its own writers hold the
     * lock a fenced read commits under. Project settings belong to the caller's settings fence.
     */
    async resolveTrackerRepo(
      _name: string,
      args: Record<string, unknown>,
      fence?: TrackerRouteFence,
    ): Promise<string | undefined> {
      const isReference = (value: unknown): value is string =>
        typeof value === "string" &&
        (/^(?:P-)?LOCAL(?:-[A-Z0-9]+)*-\d+$/iu.test(value) ||
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value));
      const references = new Set(
        trackerArgumentReferences(args)
          .filter(isReference)
          .map((value) => value.toLowerCase()),
      );
      fenceRouteFile(fence, registryPath);
      const fencedWorkspace = options.workspace?.();
      fence?.(() => {
        if (options.workspace?.() !== fencedWorkspace) throw new Error("The tracker route changed");
      });
      const registered = await known();
      if (references.size === 0) {
        const workspace = options.workspace?.();
        const entry =
          workspace === undefined
            ? undefined
            : registered.find((candidate) => candidate.path === resolve(workspace));
        if (entry) fenceRouteFile(fence, join(entry.path, CONVENTION_FILE));
        const backend = entry === undefined ? undefined : (await readConvention(entry.path))?.backend;
        if (entry && (backend === "linear" || backend === "builtin")) return entry.id;
        return undefined;
      }
      const candidates = new Map<string, string | undefined>([
        [
          join(options.globalTrackerDirectory ?? join(options.stateDirectory, "tracker"), "tracker.json"),
          undefined,
        ],
      ]);
      if (fence)
        // A project workspace's convention decides whether its repo is a candidate at all.
        for (const project of (await options.projects?.())?.projects ?? [])
          for (const workspace of project.workspaces)
            if (workspace.id === project.trackerRef?.workspaceId)
              fenceRouteFile(fence, join(workspace.path, CONVENTION_FILE));
      const projectRepos = (await projectReader?.repos()) ?? [];
      const existing = [
        ...registered,
        ...projectRepos
          .filter((entry) => entry.root !== undefined && entry.unavailable === undefined)
          .map((entry) => ({ id: entry.id, path: entry.root!, name: entry.name })),
      ];
      for (const entry of existing) {
        fenceRouteFile(fence, join(entry.path, CONVENTION_FILE));
        const convention = await readConvention(entry.path);
        if (!convention) continue;
        const directory = join(options.stateDirectory, "repo-trackers", repoId(entry.path));
        for (const file of [join(directory, "tracker.json"), join(directory, "ancillary", "tracker.json")])
          if (!candidates.has(file)) candidates.set(file, entry.id);
      }
      const matches = new Set<string | undefined>();
      for (const [path, repo] of candidates) {
        if (repo !== undefined) fenceRouteFile(fence, path, trackerVersion);
        let store: Readonly<Record<string, unknown>> | undefined;
        try {
          store = await readTrackerStoreRecords(dirname(path));
        } catch {
          throw new WorkRequestError(
            "backend_unavailable",
            "An existing local tracker cannot be read. Choose its repo explicitly.",
          );
        }
        if (store === undefined) continue;
        if (store.version !== 1)
          throw new WorkRequestError(
            "backend_unavailable",
            "An existing local tracker cannot be read. Choose its repo explicitly.",
          );
        const records: unknown[] = [store.team, store.user];
        for (const collection of [
          "issues",
          "projects",
          "comments",
          "statusUpdates",
          "labels",
          "issueStatuses",
          "projectStatuses",
        ])
          if (Array.isArray(store[collection])) records.push(...store[collection]);
        if (
          records.some((record) => {
            if (record === null || typeof record !== "object") return false;
            const resource = record as { id?: unknown; identifier?: unknown };
            return [resource.id, resource.identifier].some(
              (value) => typeof value === "string" && references.has(value.toLowerCase()),
            );
          })
        )
          matches.add(repo);
      }
      if (matches.size > 1)
        throw new WorkRequestError(
          "invalid",
          "The local tracker reference is ambiguous. Pass the saved repo ID explicitly.",
        );
      return matches.size === 1 ? [...matches][0] : undefined;
    },
    /**
     * The tracker repo a worker hired for this registered project routes to when its call
     * names none (VUH-2014). A `linear` convention returns undefined, so the call reaches
     * Linear as before; any other convention returns the project's repo. A project that is
     * gone, has no saved convention, or cannot be read here refuses instead of guessing.
     * With `fence`, the conventions it read are fenced; the project settings belong to the
     * caller's settings fence.
     */
    async trackerRepoForProject(projectId: string, fence?: TrackerRouteFence): Promise<string | undefined> {
      const project = (await options.projects?.())?.projects.find((entry) => entry.id === projectId);
      if (project === undefined)
        throw new WorkRequestError(
          "unknown_repo",
          "This worker's hire names a project that no longer exists. Pass repo explicitly.",
        );
      if (project.trackerRef === undefined) {
        // An unbound project's saved conventions live in its local workspaces. All `linear`:
        // Linear, as before. No local convention but a saved Linear project binding (a
        // project whose workspaces are all remote): Linear too (VUH-2257). None, or
        // another backend, needs a trackerRef to say which.
        const machine = options.localMachineId ?? "local";
        const backends = await Promise.all(
          project.workspaces
            .filter((workspace) => workspace.machineId === machine)
            .map(async (workspace) => {
              fenceRouteFile(fence, join(workspace.path, CONVENTION_FILE));
              // An unreadable convention counts as none: without a trackerRef the project then refuses.
              // allow-swallowed-rejection -- treated as no saved convention, never as a route
              return (await readConvention(workspace.path).catch(() => undefined))?.backend;
            }),
        );
        const saved = backends.filter((backend) => backend !== undefined);
        if (
          (saved.length > 0 || project.linearProjectBinding !== undefined) &&
          saved.every((backend) => backend === "linear")
        )
          return undefined;
      }
      if (project.trackerRef === undefined || !projectReader)
        throw new WorkRequestError(
          "needs_decision",
          `${project.name} has no saved work tracker, so this worker's tracker call has nowhere safe to go. Choose one with clankie project update, or pass repo explicitly.`,
        );
      const repo = projectWorkRepoId(project.id);
      const tracking = project.workspaces.find(
        (workspace) => workspace.id === project.trackerRef?.workspaceId,
      );
      if (tracking) fenceRouteFile(fence, join(tracking.path, CONVENTION_FILE));
      const read = await projectReader.prepare(repo).catch(() => {
        throw new WorkRequestError(
          "backend_unavailable",
          `${project.name}'s saved work tracker can't be read here. Pass repo explicitly.`,
        );
      });
      return read.convention.backend === "linear" ? undefined : repo;
    },
    cutoverRepoForReferences,
    /** Host-private retirement route: current saved scope, with delegated write fences. */
    async prepareSeatIssueTracker(
      projectId: string,
      validateHire: () => Promise<void>,
    ): Promise<import("./captain/seat-issue-status.ts").SeatIssueTrackerScope> {
      await validateHire();
      const project = (await options.projects?.())?.projects.find((entry) => entry.id === projectId);
      if (!project) throw new WorkRequestError("unknown_repo", "The hire's project no longer exists.");
      let path: string;
      let convention: WorkConvention;
      let validate: () => Promise<void>;
      let repo: string | undefined;
      if (project.trackerRef !== undefined && projectReader) {
        repo = projectWorkRepoId(projectId);
        const prepared = await projectReader.prepare(repo);
        path = prepared.path;
        convention = prepared.convention;
        validate = prepared.validate;
      } else {
        // Only a single unambiguous saved Linear scope retains the legacy route.
        // No lead cwd, inferred issue suffix, default convention or missing binding.
        const saved = await Promise.all(
          project.workspaces
            .filter((workspace) => workspace.machineId === (options.localMachineId ?? "local"))
            .map(async (workspace) => ({
              path: workspace.path,
              convention: await readConvention(workspace.path),
            })),
        );
        if (
          !saved.length ||
          saved.some((entry) => entry.convention?.backend !== "linear") ||
          // Decision provenance and repo docs differ across workspaces sharing
          // one tracker. Only the Linear routing scope must agree.
          new Set(saved.map((entry) => JSON.stringify(entry.convention?.linear))).size !== 1
        )
          throw new WorkRequestError("needs_decision", "No unambiguous saved hire tracker scope.");
        path = saved[0]!.path;
        convention = saved[0]!.convention!;
        validate = async () => {
          const current = (await options.projects?.())?.projects.find((entry) => entry.id === projectId);
          if (
            JSON.stringify(current) !== JSON.stringify(project) ||
            (
              await Promise.all(saved.map(async (entry) => JSON.stringify(await readConvention(entry.path))))
            ).some((value, index) => value !== JSON.stringify(saved[index]!.convention))
          )
            throw new Error("Saved hire tracker scope changed.");
        };
      }
      const validateOverlap = async () => {
        const overlapping =
          (await options.projects?.())?.projects.filter(
            (entry) =>
              entry.trackerProjectId !== undefined &&
              entry.workspaces.some(
                (workspace) =>
                  workspace.machineId === (options.localMachineId ?? "local") &&
                  resolve(workspace.path) === resolve(path),
              ),
          ) ?? [];
        if (
          convention.backend === "builtin" &&
          (overlapping.length !== 1 || overlapping[0]?.id !== projectId)
        )
          throw new WorkRequestError("needs_decision", "Ambiguous built-in tracker project attribution.");
      };
      const target =
        repo !== undefined && options.projectsFence
          ? await prepareWorkWriteTarget({
              repoId: repo,
              localMachineId: options.localMachineId ?? "local",
              projectsFence: options.projectsFence,
              locate: async () => {
                throw new Error("A hire tracker must use its project binding");
              },
            })
          : undefined;
      const dependencies = await deps(path, false);
      // Pin the actual connected resource once. A later disconnect must refuse,
      // never cause the canonical adapter to select its local compatibility store.
      const linearBinding =
        convention.backend === "linear" && dependencies.linear && options.mcpHost
          ? await (options.mcpHost.binding?.("linear", "operator") ??
              options.mcpHost.account?.("linear", "operator"))
          : undefined;
      if (
        convention.backend === "linear" &&
        (!linearBinding || ("backend" in linearBinding && linearBinding.backend === "local"))
      )
        throw new WorkRequestError("backend_unavailable", "Saved Linear tracker is not connected.");
      const assertLinear = async () => {
        if (!linearBinding || !options.mcpHost) return;
        const current = await (options.mcpHost.binding?.("linear", "operator") ??
          options.mcpHost.account?.("linear", "operator"));
        if (
          !current ||
          current.binding !== linearBinding.binding ||
          ("backend" in current && current.backend === "local")
        )
          throw new WorkRequestError("backend_unavailable", "Saved Linear tracker connection changed.");
      };
      // Resolve the requested project's UUID explicitly, rather than the first
      // project sharing its workspace in the compatibility dependency lookup.
      const builtIn =
        convention.backend === "builtin"
          ? await (async () => {
              if (!project.trackerProjectId)
                throw new WorkRequestError("needs_decision", "No saved built-in tracker project.");
              const view = (await openBuiltIn().call("get_project", { query: project.trackerProjectId })) as {
                leadTeam?: { id?: string };
              };
              if (!view.leadTeam?.id)
                throw new WorkRequestError(
                  "backend_unavailable",
                  "Saved built-in tracker project is unavailable.",
                );
              return { projectId: project.trackerProjectId, teamId: view.leadTeam.id, open: openBuiltIn };
            })()
          : dependencies.builtIn;
      const identity = JSON.stringify([
        projectId,
        path,
        convention,
        project.trackerProjectId,
        linearBinding?.binding,
      ]);
      const beforeWrite = async () => {
        await validateHire();
        await validate();
        await validateOverlap();
        target?.assertCurrent();
      };
      await beforeWrite();
      await assertLinear();
      return {
        identity,
        backend: convention.backend,
        call: async (
          name: string,
          args: Record<string, unknown>,
          requestPriority: import("./linear-request-budget.ts").LinearRequestPriority,
        ) => {
          await beforeWrite();
          await assertLinear();
          // A seat's own issue status is Clankie writing for this project (ADR 0302).
          const tracker =
            options.posting && isTrackerWriteTool(name) ? await outwardTracker(convention) : undefined;
          // Watch (ADR 0308): a local tracker has no admission to refuse it, so ask here.
          if (options.posting && isTrackerWriteTool(name) && tracker === undefined)
            await refuseWhileWatching();
          // Asked again as the write commits, so bookkeeping that waited on the tracker's lock
          // when Watch was chosen changes nothing (ADR 0308).
          const writing = async () => {
            await beforeWrite();
            if (options.posting && isTrackerWriteTool(name)) await refuseWhileWatching();
          };
          if (options.posting && tracker !== undefined)
            assertAdmitted(
              await options.posting.admit({
                tracker,
                ...destinationOf(convention),
                route:
                  convention.backend === "linear" || repo === undefined
                    ? { kind: "linear", tool: name, arguments: structuredClone(args) }
                    : { kind: "repo", repo, local: false, tool: name, arguments: structuredClone(args) },
                asker: { kind: "lead" },
                projectIds: [projectId],
              }),
            );
          const tools = trackerToolsFor(path, convention, {
            ...dependencies,
            ...(builtIn ? { builtIn } : {}),
            scopedWrites: true,
            actor: CLANKIE_FOR_OWNER,
            beforeWrite: writing,
            ...(convention.backend !== "linear"
              ? {}
              : {
                  linear: async (tool: string, arguments_: Record<string, unknown>) => {
                    const result = await options.mcpHost!.call({
                      lane: "operator",
                      server: "linear",
                      tool,
                      arguments: arguments_,
                      resultMode: "data",
                      requestPriority,
                      // `call` below checked posting for this project first (ADR 0302).
                      posting: TRACKER_POSTING_ADMITTED,
                      fence: async () => {
                        await writing();
                        await assertLinear();
                        return () => target?.assertCurrent();
                      },
                    });
                    if (result.outcome !== "ok") throw new Error(`Tracker ${tool}: ${result.detail}`);
                    if (result.isError) throw providerToolError(tool, result.content);
                    return JSON.parse(result.content) as unknown;
                  },
                }),
          });
          const result = await tools.call(name, args, { beforeWrite: writing, actor: CLANKIE_FOR_OWNER });
          await beforeWrite();
          await assertLinear();
          return result;
        },
      };
    },

    dropTarget,
    /**
     * A registered repo's outward tracker and the projects that hold it (ADR 0302), or
     * undefined when its work stays on this Mac (issue files, the built-in tracker).
     */
    async postingTarget(
      repo: string,
    ): Promise<{ tracker: "linear" | "github"; projectIds: string[] } | undefined> {
      let path: string;
      let convention: WorkConvention | undefined;
      if (/^project-[a-f0-9]{48}$/u.test(repo)) {
        if (!projectReader) return undefined;
        const read = await projectReader.prepare(repo);
        path = read.path;
        convention = read.convention;
      } else {
        // allow-swallowed-rejection -- an unknown repo is refused by the call itself; nothing posts.
        const entry = await locate(repo, true).catch(() => undefined);
        if (entry === undefined) return undefined;
        path = entry.path;
        convention =
          (await readConvention(path)) ??
          ((await discoverConvention(path, run)).suggestion as WorkConvention | undefined);
      }
      const tracker = await outwardTracker(convention);
      if (tracker === undefined) return undefined;
      return { tracker, projectIds: await projectIdsAt(path) };
    },
    /** The Linear team a registered repo's issues live in, so a status lands in that team's own state. */
    async linearTeam(repo: string): Promise<string | undefined> {
      if (/^project-[a-f0-9]{48}$/u.test(repo))
        return projectReader ? (await projectReader.prepare(repo)).convention.linear?.team : undefined;
      return (await readConvention((await locate(repo, true)).path))?.linear?.team;
    },
    /** Files one drop in a target `dropTarget` returned ready; see `fileDrop`. */
    fileDrop: (
      target: Extract<DropTarget, { ready: true }>,
      draft: DropDraft,
      beforeWrite?: () => Promise<void>,
    ) =>
      fileDrop(target.root, draft, {
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(beforeWrite === undefined ? {} : { beforeWrite }),
      }),
    recordDropWake: (
      target: Extract<DropTarget, { ready: true }>,
      key: string,
      wake: DropWake,
      lead?: string,
    ) => recordDropWake(target.root, key, wake, lead),
    readDrops: (target: Extract<DropTarget, { ready: true }>) => readDrops(target.root),

    /**
     * `clankie work export` (step 5, C2): a project's open items, read from its built-in
     * or Linear tracker, become issue files in its repo's private `.clankie/work/`, in the
     * main checkout. The tracker is only read, and the project's tracker selection is left
     * as it is: choosing the files is the owner's separate `project settings … tracker`.
     */
    async exportProject(request: WorkExportRequest): Promise<WorkExportResult> {
      const refusals: string[] = [];
      const project = (await options.projects?.())?.projects.find((entry) => entry.id === request.project);
      const refused = (message: string, extra: Partial<WorkExportResult> = {}): WorkExportResult => ({
        action: "export",
        to: request.to,
        dryRun: request.dryRun,
        ready: false,
        refusals: [...refusals, message],
        ...(project === undefined ? {} : { project: { id: project.id, name: project.name } }),
        ...extra,
      });
      if (project === undefined) return refused(`No project ${request.project}.`);
      // Decision 3: a project Clankie runs by himself keeps the built-in tracker for now.
      if (project.auto === true)
        return refused(
          `${project.name} is on Auto: Clankie works its backlog by himself there (rounds, the work queue, runs and leases), and that needs the built-in tracker for now. Turn Auto off first (clankie project settings ${project.id} --auto off), or leave its work where it is.`,
        );
      const located = await projectTracker(project);
      if (!("workspace" in located))
        return refused(
          located.missing === "remote"
            ? `${project.name}'s tracker workspace is on another machine; export it there.`
            : located.missing === "unreadable"
              ? `${project.name}'s saved work tracker (.clankie/tracking.json) can't be read.`
              : located.missing === "ambiguous"
                ? `${project.name} has a saved tracker in more than one workspace here; choose one with clankie project settings ${project.id} tracker.`
                : `${project.name} has no saved work tracker on this machine, so there is nothing to export.`,
        );
      const { workspace, convention } = located;
      if (convention.backend !== "builtin" && convention.backend !== "linear")
        return refused(
          convention.backend === "github"
            ? `${project.name} tracks work in GitHub issues; export reads the built-in tracker or Linear.`
            : `${project.name} already keeps its work in files (${conventionWorkDirectory(convention) ?? ""}).`,
        );
      const source = {
        backend: convention.backend,
        ...(convention.backend === "builtin" && project.trackerProjectId !== undefined
          ? { trackerProjectId: project.trackerProjectId }
          : {}),
        ...(convention.backend === "linear" && convention.linear !== undefined
          ? { linear: convention.linear }
          : {}),
      };
      // The requested project's own binding: another project may share this workspace.
      const dependencies = await deps(workspace.path, true, project.id);
      if (convention.backend === "builtin" && dependencies.builtIn === undefined)
        return refused(
          `${project.name} tracks work in the built-in tracker, but it is not bound to a tracker project (trackerProjectId).`,
          { source },
        );
      const tools = trackerToolsFor(workspace.path, convention, dependencies);
      let rows: Record<string, unknown>[];
      let issues: ExportIssue[];
      try {
        rows = [];
        const cursors = new Set<string>();
        for (let cursor: string | undefined; ;) {
          const page = (await tools.call("list_issues", {
            limit: 100,
            fields: ["title", "status", "statusType", "parentId", "updatedAt"],
            ...(cursor === undefined ? {} : { cursor }),
          })) as { issues?: Record<string, unknown>[]; hasNextPage?: boolean; cursor?: string };
          rows.push(...(page.issues ?? []));
          if (page.hasNextPage !== true) break;
          if (typeof page.cursor !== "string" || cursors.has(page.cursor))
            throw new Error("The tracker returned another page without a new cursor");
          cursor = page.cursor;
          cursors.add(cursor);
        }
        const identifiers = new Map<string, string>();
        const remember = (row: Record<string, unknown>) => {
          const identifier = typeof row.identifier === "string" ? row.identifier : undefined;
          if (identifier === undefined) return;
          for (const key of [row.id, row.uuid, identifier])
            if (typeof key === "string") identifiers.set(key.toLowerCase(), identifier);
        };
        rows.forEach(remember);
        const existing = await exportedIssueIds(workspace.path);
        const wanted = rows.filter((row) => {
          const status = trackerIssueStatus(row);
          const key = String(row.identifier ?? row.id).toLowerCase();
          return (status !== "done" && status !== "canceled") || existing.has(key);
        });
        const full: Record<string, unknown>[] = [];
        for (const row of wanted)
          full.push(
            (await tools.call("get_issue", {
              id: String(row.identifier ?? row.id),
              // Connected Linear names blockers only among an issue's relations.
              includeRelations: true,
            })) as Record<string, unknown>,
          );
        // A parent or blocker outside the project is named by its own read.
        const unknown = new Set<string>();
        for (const issue of full)
          for (const related of [issue.parentId, ...blockerReferences(issue)]) {
            // A related issue read without its identifier is looked up by its id.
            const reference =
              related !== null && typeof related === "object"
                ? typeof (related as Record<string, unknown>).identifier === "string"
                  ? undefined
                  : (related as Record<string, unknown>).id
                : related;
            if (typeof reference === "string" && !identifiers.has(reference.toLowerCase()))
              unknown.add(reference);
          }
        for (const reference of unknown) {
          // allow-swallowed-rejection -- an unreadable related issue is left out of the file, never guessed.
          const related = (await tools.call("get_issue", { id: reference }).catch(() => undefined)) as
            | Record<string, unknown>
            | undefined;
          if (related !== undefined) {
            remember(related);
            if (typeof related.identifier === "string")
              identifiers.set(reference.toLowerCase(), related.identifier);
          }
        }
        issues = full.map((issue) =>
          exportIssueFromTracker(issue, (reference) => identifiers.get(reference.toLowerCase())),
        );
      } catch (error) {
        return refused(
          `${project.name}'s ${convention.backend === "builtin" ? "built-in tracker" : "Linear project"} could not be read: ${error instanceof Error ? error.message : String(error)}`,
          { source },
        );
      }
      const written = await exportIssuesToFiles({
        root: workspace.path,
        issues,
        dryRun: request.dryRun,
        closedSkipped: rows.length - issues.length,
      });
      const selection = JSON.stringify({ backend: "markdown", directory: DEFAULT_WORK_DIRECTORY });
      return {
        action: "export",
        to: request.to,
        ready: true,
        refusals,
        project: { id: project.id, name: project.name },
        source,
        ...written,
        next: [
          `Nothing was written to the ${convention.backend === "builtin" ? "built-in tracker" : "Linear project"}; it stays as the record.`,
          `To work from these files, select them for ${project.id}: clankie project settings ${project.id} tracker '${selection}', then apply that preview with --revision REVISION --confirm-retain-items.`,
        ],
      };
    },
    /**
     * A repository's shipped versions and the item keys each one's commits name
     * (VUH-1930), for the built-in tracker's release sync. Read-only: git only.
     */
    async releaseHistory(ref: string, local: boolean): Promise<ReleaseHistory> {
      const entry = await locate(ref, local);
      const { convention } = await tracker(entry.path, false, false, local);
      return readReleaseHistory(entry.path, convention, run);
    },
    /** Canonical tool requests select the repo's backend without introducing another vocabulary. */
    async callTracker(
      name: string,
      args: Record<string, unknown>,
      callOptions: {
        readonly repo: string;
        readonly local: boolean;
        readonly inbox?: WorkInboxContext;
        /** Host-only: the caller's own check already let this write through (ADR 0302). */
        readonly posting?: typeof TRACKER_POSTING_ADMITTED;
        /** With `posting`: where the write was let through to; it goes only while unchanged. */
        readonly destination?: string;
      } & TrackerToolCallOptions,
    ): Promise<unknown> {
      const { repo, local, inbox, posting, destination, ...callbacks } = callOptions;
      const { repo: _repo, ...toolArgs } = args;
      if (INBOX_TOOLS.has(name)) return inboxPendingQuestions(repo, local, toolArgs, inbox, name, callbacks);
      if (SAVED_ISSUE_VIEW_TOOLS.has(name)) {
        // Saved views use a fresh canonical project fence, never discovery's
        // frozen options.projects snapshot as authority. Other tools retain
        // their existing routing below.
        if (!options.projectsFence) throw new Error("Current project authority is unavailable");
        const snapshot = await options.projectsFence();
        snapshot.assertCurrent();
        const target = await prepareWorkWriteTarget({
          repoId: repo,
          localMachineId: options.localMachineId ?? "local",
          projectsFence: async () => snapshot,
          locate: async () => {
            const entry = await locate(repo, local);
            snapshot.assertCurrent();
            return { path: entry.path, assertCurrent: snapshot.assertCurrent };
          },
        });
        if (target.convention.backend !== "builtin") refuseBuiltInTrackerFeatures(name, toolArgs);
        const projects = snapshot.projects.projects.filter(
          (project) =>
            project.trackerRef !== undefined &&
            project.workspaces.some(
              (workspace) =>
                workspace.id === project.trackerRef?.workspaceId &&
                workspace.machineId === (options.localMachineId ?? "local") &&
                workspace.platform === (process.platform === "win32" ? "windows" : "posix") &&
                resolve(workspace.path) === target.path,
            ),
        );
        const project = projects.length === 1 ? projects[0] : undefined;
        if (
          !project?.trackerProjectId ||
          project.trackerProjectId !== toolArgs.project ||
          snapshot.projects.projects.filter((entry) => entry.trackerProjectId === project.trackerProjectId)
            .length !== 1
        )
          throw new Error("Saved view project does not match this repo's current built-in tracker binding");
        const tracker = openBuiltIn();
        const view = (await tracker.call("get_project", { query: project.trackerProjectId })) as {
          id?: unknown;
          leadTeam?: { id?: unknown };
        };
        target.assertCurrent();
        if (view.id !== project.trackerProjectId || typeof view.leadTeam?.id !== "string")
          throw new Error("Saved view tracker project is unavailable");
        const validate = () => {
          snapshot.assertCurrent();
          target.assertCurrent();
        };
        const result = await trackerToolsFor(target.path, target.convention, {
          ...callbacks,
          builtIn: { projectId: project.trackerProjectId, teamId: view.leadTeam.id, open: () => tracker },
        }).call(name, toolArgs, {
          ...callbacks,
          beforeWrite: async () => {
            await callbacks.beforeWrite?.();
            // A saved view is a tracker write too: Watch refuses it unless it is the owner's (ADR 0308).
            if (posting !== TRACKER_POSTING_ADMITTED && !ownerActor(callbacks.actor))
              await refuseWhileWatching();
            validate();
          },
          onDispatch: () => {
            validate();
            callbacks.onDispatch?.();
            validate();
          },
        });
        validate();
        return result;
      }
      let path: string;
      let convention: WorkConvention;
      let validate: (() => Promise<void>) | undefined;
      if (/^project-[a-f0-9]{48}$/u.test(repo)) {
        if (!projectReader) throw new WorkRequestError("unknown_repo", "No registered project work");
        const read = await projectReader.prepare(repo);
        path = read.path;
        convention = read.convention;
        validate = read.validate;
      } else {
        const entry = await locate(repo, local);
        path = entry.path;
        const resolved = await tracker(path, local && /^(?:save_|create_)/u.test(name), !local, local);
        convention = resolved.convention;
        const savedConvention = JSON.stringify(await readConvention(path));
        const savedRegistry = JSON.stringify(await readRegistry());
        const savedWorkspace = options.workspace?.();
        validate = async () => {
          if (
            JSON.stringify(await readConvention(path)) !== savedConvention ||
            JSON.stringify(await readRegistry()) !== savedRegistry ||
            options.workspace?.() !== savedWorkspace
          )
            throw new Error("Saved work repository or tracker changed. Read the work again.");
        };
      }
      if (posting === TRACKER_POSTING_ADMITTED) assertDestination(convention, destination);
      // "Posting to your tracker" (ADR 0302): Clankie's and his workers' writes to an
      // outward tracker pass the project's setting; the owner's own writes are his.
      const outward =
        options.posting &&
        posting !== TRACKER_POSTING_ADMITTED &&
        isTrackerWriteTool(name) &&
        !ownerActor(callbacks.actor)
          ? await outwardTracker(convention)
          : undefined;
      // Watch refuses every tracker write that is not the owner's (ADR 0308). An outward
      // tracker's admission already refuses it; a local tracker has no admission, so ask here.
      const watchApplies =
        posting !== TRACKER_POSTING_ADMITTED && isTrackerWriteTool(name) && !ownerActor(callbacks.actor);
      const refuseWatching = async () => {
        if (watchApplies && (await options.posting?.watching?.()) === true)
          assertAdmitted({ outcome: "refused", message: WATCH_REFUSAL });
      };
      if (outward === undefined) await refuseWatching();
      if (options.posting && outward !== undefined)
        assertAdmitted(
          await options.posting.admit({
            tracker: outward,
            ...destinationOf(convention),
            route: { kind: "repo", repo, local, tool: name, arguments: structuredClone(toolArgs) },
            asker: postingAsker(callbacks.actor),
            projectIds: await projectIdsAt(path),
          }),
        );
      // Delegated tools use the connected account, else the owner's gh login on this
      // machine, bound for the whole call so a switched account stops the write.
      const account = !local && convention.backend === "github" ? await accountBinding("github") : undefined;
      const assertAccountCurrent = async () => {
        if (account !== undefined && (await accountBinding("github")) !== account)
          throw new Error("Connected GitHub account changed.");
      };
      const dependencies = await deps(path, local);
      const beforeWrite = async () => {
        await validate?.();
        await callbacks.beforeWrite?.();
        // Asked again at the write itself, so a write waiting on the tracker's lock when Watch
        // is chosen changes nothing.
        await refuseWatching();
        await assertAccountCurrent();
      };
      const scopedDependencies: TrackerDeps = {
        ...dependencies,
        ...callbacks,
        beforeWrite,
        scopedWrites: !local,
        ...(!local ? { linearWriteScope: "team" as const } : {}),
        ...(convention.backend !== "linear" ||
        options.mcpHost === undefined ||
        dependencies.linear === undefined
          ? {}
          : {
              linear: async (tool: string, arguments_: Record<string, unknown>) => {
                const result = await options.mcpHost!.call({
                  lane: "operator",
                  server: "linear",
                  tool,
                  arguments: arguments_,
                  resultMode: "data",
                  // This call already passed posting above (ADR 0302).
                  posting: TRACKER_POSTING_ADMITTED,
                  fence: async () => {
                    await beforeWrite();
                    return () => {};
                  },
                  ...(callbacks.onDispatch === undefined ? {} : { onDispatch: callbacks.onDispatch }),
                  ...(callbacks.effectConfirmed === undefined
                    ? {}
                    : {
                        onSettled: (settled: { isError: boolean }) => {
                          if (!settled.isError) callbacks.effectConfirmed?.();
                        },
                      }),
                });
                if (result.outcome !== "ok") throw new Error(`Tracker ${tool}: ${result.detail}`);
                if (result.isError) throw providerToolError(tool, result.content);
                return result.content.trim() ? (JSON.parse(result.content) as unknown) : undefined;
              },
            }),
      };
      await validate?.();
      await assertAccountCurrent();
      const result = await trackerToolsFor(path, convention, scopedDependencies).call(name, toolArgs, {
        ...callbacks,
        beforeWrite,
      });
      await validate?.();
      await assertAccountCurrent();
      return result;
    },
    async readOwnerReceipt(
      request: WorkItemWriteReceiptRequest,
      authority: WorkWriteAuthority,
    ): Promise<WorkItemWriteReceipt> {
      try {
        const { scope } = await writeScope(request, authority);
        return writeReceipts.read(request.requestId, scope);
      } catch {
        return receipt(
          request.requestId,
          "refused",
          "No receipt is available for this owner and current work tracker.",
        );
      }
    },
    async handle(
      request: WorkRequest,
      local: boolean,
      /** Host-only: posting already let this write through (ADR 0302). */
      posting?: typeof TRACKER_POSTING_ADMITTED,
      /** With `posting`: where it was let through to; it goes only while unchanged. */
      destination?: string,
    ): Promise<WorkResult> {
      if (request.action === "repos") {
        const repos = [
          ...((await projectReader?.repos()) ?? []),
          ...((await linearProjects?.repos().catch(() => [])) ?? []),
          ...(await Promise.all((await listed()).map(describe))),
        ];
        if (repos.length > WORK_REPO_LIST_MAX)
          throw new WorkRequestError("result_too_large", "There are too many work trackers to list at once.");
        return { repos };
      }
      const itemRequest =
        request.action === "show" ||
        request.action === "activity" ||
        request.action === "update" ||
        request.action === "attach";
      // A cut-over project's item is read and moved in its built-in tracker, whatever repo the
      // caller runs from: a Linear repo would otherwise reach the frozen copy (VUH-2829).
      const itemProject = !itemRequest
        ? undefined
        : (request.project ??
          (local ? (await cutoverRepoForReferences([request.id]))?.trackerProjectId : undefined));
      if (itemRequest && itemProject !== undefined) {
        // An explicit project wins over whatever repo, or repo reference, the caller names.
        if (!local) throw new WorkRequestError("invalid", "Devices read work items through their repo");
        const { repo, backend } = await builtInProjectItem(
          itemProject,
          request.id,
          request.action === "update" || request.action === "attach" ? watchedWrite(posting) : undefined,
        );
        if (
          (request.action === "update" || request.action === "attach") &&
          posting !== TRACKER_POSTING_ADMITTED
        )
          await refuseWhileWatching();
        try {
          switch (request.action) {
            case "show": {
              const item = await backend.get(request.id);
              if (item === undefined) throw new WorkRequestError("not_found", `No work item ${request.id}`);
              return { repo, item };
            }
            case "activity":
              return { repo, itemId: request.id, entries: await backend.activity!(request.id) };
            case "update":
              return { repo, item: await backend.update(request.id, workPatch(request)) };
            case "attach":
              return { repo, item: await backend.attach(request.id, request.evidence) };
          }
        } catch (error) {
          if (error instanceof Error && error.name === "WorkItemNotFoundError")
            throw new WorkRequestError("not_found", error.message);
          throw error;
        }
      }
      if (/^linear-[a-f0-9-]{36}$/u.test(request.repo)) {
        if (
          !linearProjects ||
          !["list", "show", "activity", "project", "project-details"].includes(request.action)
        )
          throw new WorkRequestError("invalid", "Linear project references are read-only");
        try {
          return await linearProjects.read(
            request as Extract<
              WorkRequest,
              { action: "list" | "show" | "activity" | "project" | "project-details" }
            >,
          );
        } catch {
          throw new WorkRequestError(
            "backend_unavailable",
            "This Linear project can’t be read from the connected account. Read the work again.",
          );
        }
      }
      if (/^project-[a-f0-9]{48}$/u.test(request.repo)) {
        if (
          request.action !== "list" &&
          request.action !== "show" &&
          request.action !== "project-details" &&
          request.action !== "project" &&
          request.action !== "activity"
        )
          throw new WorkRequestError("invalid", "Project tracker references are read-only");
        try {
          if (!projectReader) throw new Error("Project settings unavailable");
          const read = await projectReader.prepare(request.repo);
          if (request.action === "project" || request.action === "project-details") {
            const binding = await accountBinding(read.convention.backend);
            const facts = await (request.action === "project-details" ? readProjectDetails : readProjectWork)(
              read.path,
              read.convention,
              await deps(read.path, false),
            );
            await read.validate();
            if ((await accountBinding(read.convention.backend)) !== binding)
              throw new Error("Connected tracker account changed. Read the work again.");
            return { repo: read.repo, ...facts };
          }
          const { backend } = await tracker(read.path, false, true);
          await read.validate();
          if (request.action === "list") {
            const items = await backend.list({
              ...(request.status === undefined ? {} : { status: request.status }),
              ...(request.owner === undefined ? {} : { owner: request.owner }),
              ...(request.label === undefined ? {} : { label: request.label }),
              limit: request.limit ?? 250,
            });
            await read.validate();
            return { repo: read.repo, items };
          }
          if (request.action === "activity") {
            if (backend.activity === undefined) throw new Error("This tracker keeps no activity");
            const entries = await backend.activity(request.id);
            await read.validate();
            return { repo: read.repo, itemId: request.id, entries };
          }
          const item = await backend.get(request.id);
          await read.validate();
          if (!item) throw new WorkRequestError("not_found", `No work item ${request.id}`);
          return { repo: read.repo, item };
        } catch (error) {
          if (error instanceof WorkRequestError && error.code === "not_found") throw error;
          if (error instanceof WorkRequestError && error.code === "result_too_large")
            throw new WorkRequestError(
              "result_too_large",
              "This project’s work is too large to read at once.",
            );
          throw new WorkRequestError(
            "backend_unavailable",
            "This project’s workspace or saved work tracker can’t be read here. Read the work again.",
          );
        }
      }
      const entry = await locate(request.repo, local);
      switch (request.action) {
        case "project-details":
        case "project": {
          const { convention } = await tracker(entry.path, false, false, local);
          const saved = JSON.stringify(await readConvention(entry.path));
          const binding =
            (convention.backend === "linear" && !options.mcpHost?.binding && !options.mcpHost?.account) ||
            (convention.backend === "github" && local && !options.githubToken)
              ? undefined
              : await accountBinding(convention.backend);
          const facts = await (request.action === "project-details" ? readProjectDetails : readProjectWork)(
            entry.path,
            convention,
            await deps(entry.path, local),
          );
          if (
            JSON.stringify(await readConvention(entry.path)) !== saved ||
            (binding !== undefined && (await accountBinding(convention.backend)) !== binding)
          )
            throw new WorkRequestError("invalid", "Saved work tracker changed. Read the work again.");
          return { repo: await describe(entry), ...facts };
        }
        case "discover": {
          const discovery = await discoverConvention(entry.path, run);
          const recorded = await readConvention(entry.path);
          return {
            repo: await describe(entry),
            signals: discovery.signals,
            ...(recorded === undefined ? {} : { convention: recorded }),
            ...(recorded === undefined && discovery.question !== undefined
              ? { question: discovery.question }
              : {}),
          };
        }
        case "init": {
          if (!local) throw new WorkRequestError("invalid", "Only this machine records a convention");
          let convention: WorkConvention;
          try {
            const { action: _action, repo: _repo, ...inputs } = request;
            convention = await initializeConvention(entry.path, inputs, { run, clock });
          } catch (error) {
            if (error instanceof WorkInitDecisionRequired)
              throw new WorkRequestError("needs_decision", error.message, {
                question: error.message,
                signals: error.signals,
              });
            if (error instanceof WorkInitInvalid) throw new WorkRequestError("invalid", error.message);
            throw error;
          }

          return { repo: await describe(entry), convention };
        }
        case "list": {
          const { backend } = await tracker(entry.path, false);
          return {
            repo: await describe(entry),
            items: await backend.list({
              ...(request.status === undefined ? {} : { status: request.status }),
              ...(request.owner === undefined ? {} : { owner: request.owner }),
              ...(request.label === undefined ? {} : { label: request.label }),
              limit: request.limit ?? 250,
            }),
          };
        }
        case "show": {
          const { backend } = await tracker(entry.path, false);
          const item = await backend.get(request.id);
          if (item === undefined) throw new WorkRequestError("not_found", `No work item ${request.id}`);
          return { repo: await describe(entry), item };
        }
        case "activity": {
          const { backend } = await tracker(entry.path, false);
          if (backend.activity === undefined)
            throw new WorkRequestError(
              "backend_unavailable",
              "This repo’s tracker doesn’t keep comments Clankie can read.",
            );
          try {
            return {
              repo: await describe(entry),
              itemId: request.id,
              entries: await backend.activity(request.id),
            };
          } catch (error) {
            if (error instanceof Error && error.name === "WorkItemNotFoundError")
              throw new WorkRequestError("not_found", `No work item ${request.id}`);
            throw error;
          }
        }
        case "create": {
          if (!local) throw new WorkRequestError("invalid", "Devices read work items; agents write them");
          const { backend, convention } = await tracker(entry.path, true, false, true, watchedWrite(posting));
          await checkWorkPosting(request, convention, entry.path, posting, destination);
          const item = await backend.create({
            title: request.title,
            ...(request.summary === undefined ? {} : { summary: request.summary }),
            ...(request.owner === undefined ? {} : { owner: request.owner }),
            ...(request.criteria === undefined ? {} : { criteria: request.criteria }),
            ...(request.dependsOn === undefined ? {} : { dependsOn: request.dependsOn }),
            ...(request.status === undefined ? {} : { status: request.status }),
            ...(request.priority === undefined ? {} : { priority: request.priority }),
          });
          return { repo: await describe(entry), item };
        }
        case "update": {
          if (!local) throw new WorkRequestError("invalid", "Devices read work items; agents write them");
          const { backend, convention } = await tracker(entry.path, true, false, true, watchedWrite(posting));
          await checkWorkPosting(request, convention, entry.path, posting, destination);
          try {
            return {
              repo: await describe(entry),
              item: await backend.update(request.id, workPatch(request)),
            };
          } catch (error) {
            if (error instanceof Error && error.name === "WorkItemNotFoundError")
              throw new WorkRequestError("not_found", error.message);
            throw error;
          }
        }
        case "attach": {
          if (!local) throw new WorkRequestError("invalid", "Devices read work items; agents write them");
          const { backend, convention } = await tracker(entry.path, true, false, true, watchedWrite(posting));
          await checkWorkPosting(request, convention, entry.path, posting, destination);
          try {
            return { repo: await describe(entry), item: await backend.attach(request.id, request.evidence) };
          } catch (error) {
            if (error instanceof Error && error.name === "WorkItemNotFoundError")
              throw new WorkRequestError("not_found", error.message);
            throw error;
          }
        }
      }
    },
  };
}

export type WorkItemsService = ReturnType<typeof createWorkItemsService>;
