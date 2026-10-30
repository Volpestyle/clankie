import {
  FEED_BODY_MAX,
  FEED_CHECK_LINE_READ_MAX,
  FEED_LIST_LIMIT_DEFAULT,
  FeedItemSchema,
  FeedLinkSchema,
  FeedListResultSchema,
  FeedMediaSchema,
  FeedUrlSchema,
  type FeedItem,
  type FeedLink,
  type FeedListRequest,
  type FeedListResult,
  type FeedMedia,
  type OperatorConversation,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
} from "@clankie/protocol";
import type { Project } from "@clankie/protocol/projects";
import type { WorkProjectDetails, WorkRepo } from "@clankie/protocol/work-items";
import type { ClankieSettings } from "@clankie/settings";
import type { TrackerToolBackend } from "@clankie/work-items";
import type { WorkItemsService } from "./work-items.ts";
import type { createFeedDrops } from "./feed-drops.ts";
import { evidenceHash, evidenceMedia, withEvidenceTypes, type EvidenceTypes } from "./feed-media.ts";

/** One read of the existing stores, carrying the caller's owner authority. */
type FeedServe = (request: OperatorConversationServiceRequest) => Promise<OperatorConversationServiceResult>;

type ProjectUpdates = { repo: WorkRepo; updates: WorkProjectDetails["updates"] };
/** Project status updates come from a tracker; paging re-reads the feed, so a short cache spares it. */
const PROJECT_UPDATES_TTL_MS = 30_000;
const PROJECT_UPDATE_READS = 4;
const UNREADABLE = "This project’s updates can’t be read here right now.";

/**
 * The owner's feed (step 5, slices C1, C3 and C4): a newest-first join of pending
 * owner asks, mailed owner updates, project status updates, the owner's open
 * drops and finished built-in items waiting on his verdict. It keeps no store of
 * its own: asks are answered with `input_answer`, mail dismissed with
 * `owner_update_dismiss`, drops are the projects' own issue files, and proofs get
 * the paired app's `post_owner_verdict`. Check lines, status updates and refined
 * drops are model-written text, shown only.
 */
export function createOwnerFeed(options: {
  readonly workItems?: Pick<WorkItemsService, "handle">;
  readonly settings?: { load(): Promise<ClankieSettings> };
  readonly drops?: Pick<ReturnType<typeof createFeedDrops>, "items">;
  /** The built-in tracker, for finished items the lead marked with an owner check. */
  readonly tracker?: Pick<TrackerToolBackend, "call">;
  /** The evidence store, for the content type of each `clankie://evidence` link. */
  readonly evidence?: EvidenceTypes;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { readAt: number; read: Promise<ProjectUpdates> }>();
  const projectUpdates = (repo: WorkRepo): Promise<ProjectUpdates> => {
    const cached = cache.get(repo.id);
    if (cached && now() - cached.readAt < PROJECT_UPDATES_TTL_MS) return cached.read;
    const read = (async () => {
      const result = await options.workItems!.handle({ action: "project-details", repo: repo.id }, false);
      if (!("updates" in result)) throw new Error("Unexpected project details result");
      return { repo, updates: result.updates };
    })();
    cache.set(repo.id, { readAt: now(), read });
    // A failed read is not kept: the next feed read tries the tracker again.
    read.catch(() => {
      if (cache.get(repo.id)?.read === read) cache.delete(repo.id);
    });
    return read;
  };

  return {
    async list(request: FeedListRequest, serve: FeedServe): Promise<FeedListResult> {
      const settings = await options.settings?.load();
      const projects = settings?.projects.projects ?? [];
      const projectChats = settings?.linearWebhook.projectChats ?? [];
      const [asks, mail, conversations] = await Promise.all([
        serve({ op: "input_list", schemaVersion: 1 }),
        serve({ op: "owner_update_list", schemaVersion: 1 }),
        serve({ op: "list", schemaVersion: 1 }),
      ]);
      if (asks.op !== "input_list" || mail.op !== "owner_update_list" || conversations.op !== "list")
        throw new Error("Unexpected owner feed source");
      const scopes = new Map<string, OperatorConversation>(
        conversations.conversations.map((conversation) => [conversation.conversationId, conversation]),
      );
      const projectForPath = (path: string | undefined) => projectContaining(projects, path);
      // A lead chat the owner bound to exactly one project speaks for that project.
      const projectForConversation = (conversationId: string) => {
        const scope = scopes.get(conversationId)?.scope;
        const byPath =
          scope?.kind === "workspace" && scope.machineId === undefined
            ? projectForPath(scope.workspaceId)
            : undefined;
        if (byPath) return byPath;
        const bound = projectChats
          .filter((route) => route.conversationId === conversationId)
          .flatMap((route) =>
            projects.filter(
              (project) =>
                project.trackerProjectId === route.projectId ||
                project.linearProjectBinding?.projectId === route.projectId,
            ),
          );
        return new Set(bound.map((project) => project.id)).size === 1 ? bound[0]!.id : undefined;
      };

      // Finished built-in items with an owner check: a pending verify ask on one is its check.
      const marked = await ownerChecks(options.tracker, projects);
      const asked = new Set<string>();

      const items: FeedItem[] = [];
      for (const ask of asks.result.questions) {
        const question = ask.question;
        if (question?.status !== "pending" || ask.revision === undefined) continue;
        const named =
          question.purpose === "verify" && question.issue?.tracker === "clankie-work"
            ? marked.get(question.issue.key)
            : undefined;
        // A check that stands in for a proof keeps the proof's project, wherever the ask was raised.
        const projectId =
          (question.projectId !== undefined && projects.some((project) => project.id === question.projectId)
            ? question.projectId
            : undefined) ??
          projectForPath(question.workspace) ??
          projectForConversation(question.conversationId) ??
          named?.projectId;
        if (named) asked.add(named.key);
        const media = question.evidence
          ? [evidenceMedia(evidenceHash(question.evidence)!)]
          : named?.media.slice(0, 1);
        const line = question.check ?? named?.line;
        items.push({
          kind: "check",
          id: `check:${question.requestId}`,
          at: iso(question.createdAt)!,
          ...(projectId ? { projectId } : {}),
          check: {
            question,
            revision: ask.revision,
            ...(line ? { line } : {}),
            ...(question.longer ? { longer: true as const } : {}),
            ...(media?.length ? { media } : {}),
          },
        });
      }
      for (const proof of marked.values())
        if (!asked.has(proof.key))
          items.push({
            kind: "proof",
            id: `proof:${proof.issueId}`,
            at: proof.at,
            ...(proof.projectId ? { projectId: proof.projectId } : {}),
            proof: {
              issueId: proof.issueId,
              key: proof.key,
              title: proof.title,
              line: proof.line,
              bundleId: proof.bundleId,
              stage: proof.stage,
              ...(proof.url ? { url: proof.url } : {}),
              ...(proof.media.length ? { media: proof.media } : {}),
            },
          });
      for (const update of mail.result.updates) {
        if (update.state === "dismissed") continue;
        const projectId = projectForConversation(update.conversationId);
        items.push({
          kind: "update",
          id: `owner-update:${update.id}`,
          at: iso(update.at)!,
          ...(projectId ? { projectId } : {}),
          update: {
            title: update.title,
            body: update.body,
            ...(update.issue ? { issue: update.issue } : {}),
            ...(update.links?.length ? { links: update.links } : {}),
            ...(update.media?.length ? { media: update.media } : {}),
            ownerUpdate: {
              id: update.id,
              conversationId: update.conversationId,
              state: update.state,
              ...(update.source.seatId ? { seatId: update.source.seatId } : {}),
            },
          },
        });
      }

      // Project status updates: only trackers that belong to one of the owner's projects.
      const unreadable: { repoId: string; projectId?: string; message: string }[] = [];
      if (options.workItems) {
        const listed = await options.workItems.handle({ action: "repos" }, false);
        const sources = ("repos" in listed ? listed.repos : []).flatMap((repo) => {
          const projectId = repo.projectId ?? projectForPath(repo.root);
          if (projectId === undefined || (request.projectId && projectId !== request.projectId)) return [];
          if (repo.backend !== undefined && repo.backend !== "builtin" && repo.backend !== "linear")
            return [];
          if (repo.needsDecision) return [];
          if (repo.unavailable) {
            unreadable.push({ repoId: repo.id, projectId, message: repo.unavailable });
            return [];
          }
          return [{ repo, projectId }];
        });
        const seen = new Set<string>();
        let next = 0;
        const reads: { repo: WorkRepo; projectId: string; read?: ProjectUpdates }[] = sources;
        await Promise.all(
          Array.from({ length: Math.min(PROJECT_UPDATE_READS, reads.length) }, async () => {
            while (next < reads.length) {
              const source = reads[next++]!;
              try {
                source.read = await projectUpdates(source.repo);
              } catch {
                unreadable.push({ repoId: source.repo.id, projectId: source.projectId, message: UNREADABLE });
              }
            }
          }),
        );
        for (const { repo, projectId, read } of reads) {
          for (const update of read?.updates ?? []) {
            const at = iso(update.createdAt);
            // A project read through two trackers (a repo and its Linear project) shows each update once.
            if (at === undefined || seen.has(update.id)) continue;
            seen.add(update.id);
            items.push(projectUpdateItem(update, at, repo.id, projectId));
          }
        }
      }

      // Drops: the open stub and refined issue files of each file-backed project.
      if (options.drops) {
        const dropped = await options.drops.items(
          projects.filter((project) => !request.projectId || project.id === request.projectId),
        );
        items.push(...dropped.items);
        unreadable.push(...dropped.unreadable);
      }

      const ordered = items
        .filter((item) => !request.projectId || item.projectId === request.projectId)
        .sort((a, b) => compare(b, a));
      const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor);
      const remaining = after ? ordered.filter((item) => compare(item, after) < 0) : ordered;
      const sliced = remaining.slice(0, request.limit ?? FEED_LIST_LIMIT_DEFAULT);
      const page = await withEvidenceTypes(sliced, options.evidence);
      const last = page.at(-1);
      return FeedListResultSchema.parse({
        outcome: "ready",
        items: page.map((item) => FeedItemSchema.parse(item)),
        ...(last && remaining.length > page.length ? { nextCursor: encodeCursor(last) } : {}),
        ...(unreadable.length ? { unreadable: unreadable.slice(0, 64) } : {}),
      });
    },
  };
}

type MarkedItem = {
  readonly issueId: string;
  readonly key: string;
  readonly title: string;
  readonly line: string;
  readonly bundleId: string;
  readonly stage: "landed" | "delivered";
  readonly at: string;
  readonly url?: string;
  readonly projectId?: string;
  readonly media: FeedMedia[];
};
const PROOF_FIELDS = ["title", "ownerCheck", "stage", "bundle", "projectId", "url", "updatedAt"];
const PROOF_PAGE = 250;
const PROOF_PAGES = 40;

/**
 * The built-in items the lead marked with an owner check (ADR 0299) that wait on
 * the owner: landed or delivered, not Done, with a current bundle for a verdict
 * to name, by identifier. A tracker that cannot be read gives none; the feed
 * still shows everything else.
 */
async function ownerChecks(
  tracker: Pick<TrackerToolBackend, "call"> | undefined,
  projects: readonly Project[],
): Promise<Map<string, MarkedItem>> {
  const found = new Map<string, MarkedItem>();
  if (tracker === undefined) return found;
  const projectFor = (trackerProjectId: unknown) =>
    typeof trackerProjectId === "string"
      ? projects.find((project) => project.trackerProjectId?.toLowerCase() === trackerProjectId.toLowerCase())
          ?.id
      : undefined;
  let cursor: string | undefined;
  try {
    for (let read = 0; read < PROOF_PAGES; read++) {
      const listed = (await tracker.call("list_issues", {
        state: "open",
        limit: PROOF_PAGE,
        fields: PROOF_FIELDS,
        ...(cursor === undefined ? {} : { cursor }),
      })) as { issues?: Record<string, unknown>[]; hasNextPage?: boolean; cursor?: string };
      for (const issue of listed.issues ?? []) {
        const marked = markedItem(issue, projectFor(issue.projectId));
        if (marked) found.set(marked.key, marked);
      }
      if (listed.hasNextPage !== true || typeof listed.cursor !== "string") break;
      cursor = listed.cursor;
    }
  } catch {
    // The deck's items are left out of this read; asks, mail, updates and drops still show.
  }
  return found;
}

function markedItem(issue: Record<string, unknown>, projectId: string | undefined): MarkedItem | undefined {
  const line = typeof issue.ownerCheck === "string" ? issue.ownerCheck.trim() : "";
  const stage = issue.stage;
  const bundle = issue.bundle as
    | { id?: unknown; at?: unknown; references?: { type?: unknown; sha256?: unknown }[] }
    | null
    | undefined;
  if (
    line === "" ||
    (stage !== "landed" && stage !== "delivered") ||
    typeof issue.id !== "string" ||
    typeof issue.identifier !== "string" ||
    typeof bundle?.id !== "string"
  )
    return undefined;
  // Clips first, then screenshots, as the deck shows them; logs and diffs stay in the bundle.
  const media: FeedMedia[] = [];
  for (const kind of ["video", "screenshot"])
    for (const reference of bundle.references ?? []) {
      if (reference.type !== kind || typeof reference.sha256 !== "string") continue;
      if (!/^[0-9a-f]{64}$/u.test(reference.sha256)) continue;
      const entry = evidenceMedia(reference.sha256);
      if (!media.some((existing) => existing.url === entry.url)) media.push(entry);
    }
  const url = typeof issue.url === "string" ? FeedUrlSchema.safeParse(issue.url) : undefined;
  const at =
    (typeof bundle.at === "string" ? iso(bundle.at) : undefined) ??
    (typeof issue.updatedAt === "string" ? iso(issue.updatedAt) : undefined) ??
    new Date(0).toISOString();
  return {
    issueId: issue.id,
    key: issue.identifier,
    title: (typeof issue.title === "string" && issue.title.trim()
      ? issue.title.trim()
      : issue.identifier
    ).slice(0, 500),
    line: line.slice(0, FEED_CHECK_LINE_READ_MAX),
    bundleId: bundle.id,
    stage,
    at,
    ...(url?.success ? { url: url.data } : {}),
    ...(projectId ? { projectId } : {}),
    media: media.slice(0, 16),
  };
}

/** The project whose local workspace holds this directory; the deepest root wins, as a nested checkout. */
function projectContaining(projects: readonly Project[], path: string | undefined): string | undefined {
  if (!path) return undefined;
  let best: { id: string; length: number; tied: boolean } | undefined;
  for (const project of projects)
    for (const root of [...project.workspaces, ...project.worktreeRoots]) {
      if (root.machineId !== "local") continue;
      const base = root.path.replace(/\/+$/u, "");
      if (path !== base && !path.startsWith(`${base}/`)) continue;
      if (best === undefined || base.length > best.length)
        best = { id: project.id, length: base.length, tied: false };
      else if (base.length === best.length && best.id !== project.id) best.tied = true;
    }
  return best && !best.tied ? best.id : undefined;
}

function projectUpdateItem(
  update: WorkProjectDetails["updates"][number],
  at: string,
  repoId: string,
  projectId: string,
): FeedItem {
  // Images the body embeds are media; every other attachment is a link.
  const media: FeedMedia[] = [];
  for (const match of update.body.matchAll(/!\[([^\]]*)\]\(<?([^\s)>]+)>?\)/gu)) {
    const entry = FeedMediaSchema.safeParse({
      url: match[2],
      ...(match[1] ? { alt: match[1].slice(0, 500) } : {}),
    });
    if (entry.success && !media.some((existing) => existing.url === entry.data.url)) media.push(entry.data);
  }
  const links: FeedLink[] = [];
  for (const attachment of update.attachments) {
    const link = FeedLinkSchema.safeParse({ label: attachment.title, url: attachment.url });
    if (
      link.success &&
      !media.some((entry) => entry.url === link.data.url) &&
      !links.some((entry) => entry.url === link.data.url)
    )
      links.push(link.data);
  }
  const truncated = update.body.length > FEED_BODY_MAX;
  return {
    kind: "update",
    id: `project-update:${update.id}`,
    at,
    projectId,
    update: {
      body: truncated ? update.body.slice(0, FEED_BODY_MAX) : update.body,
      ...(truncated ? { bodyTruncated: true as const } : {}),
      ...(links.length ? { links: links.slice(0, 32) } : {}),
      ...(media.length ? { media: media.slice(0, 16) } : {}),
      projectUpdate: {
        id: update.id,
        repoId,
        ...(update.health ? { health: update.health.slice(0, 64) } : {}),
        ...(update.author ? { author: update.author.slice(0, 200) } : {}),
      },
    },
  };
}

function iso(value: string): string | undefined {
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

type Position = { readonly at: string; readonly id: string };
function compare(a: Position, b: Position): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function encodeCursor(item: Position): string {
  return Buffer.from(JSON.stringify([item.at, item.id])).toString("base64url");
}
function decodeCursor(cursor: string): Position {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      iso(value[0]) === value[0]
    )
      return { at: value[0], id: value[1] };
  } catch {
    // An unreadable cursor is refused below.
  }
  throw new FeedCursorError();
}

export class FeedCursorError extends Error {
  public constructor() {
    super("That feed cursor isn’t one this host gave. Read the feed from the start.");
  }
}
