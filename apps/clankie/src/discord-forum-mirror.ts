import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  DiscordForumEventRequest,
  DiscordServerAction,
  DiscordServerActionResult,
} from "@clankie/protocol";
import {
  TRACKER_OWNER,
  TrackerWriteRefused,
  type LocalTrackerBackend,
  type TrackerActor,
  type TrackerItemEvent,
} from "@clankie/work-items";

/**
 * A Discord forum as a two-way view of one built-in tracker project (VUH-2531,
 * docs/proposals/2026-10-21-discord-forum-tracker-view.md). The tracker stays the
 * only store: a post is an item, moderated tags carry its status, replies are
 * comments. Limits below are Discord's documented caps, read 2026-10-21.
 */
const DISCORD_FORUM_VIA = "discord_forum";
const STATUS_TAGS = ["Later", "Next", "Now", "Review", "Done", "Closed"] as const;
type StatusTag = (typeof STATUS_TAGS)[number];
const TAG_STATUS: Record<StatusTag, string> = {
  Later: "Backlog",
  Next: "Todo",
  Now: "In Progress",
  Review: "In Review",
  Done: "Done",
  Closed: "Canceled",
};
const FORUM_TAGS = 20;
const TAG_NAME = 20;
const POST_TAGS = 5;
const POST_TITLE = 100;
const MESSAGE = 2000;
const COMMENT_MESSAGES = 3;
const OUTBOUND = new Set<TrackerItemEvent["type"]>(["created", "state", "stage", "comment", "reopened"]);

export interface DiscordForumBinding {
  readonly projectId: string;
  readonly team: string;
  readonly serverId: string;
  readonly forumId: string;
  /** auto: a member's post becomes an untrusted Backlog item; owner_tag: it waits for an owner's status tag. */
  readonly memberPosts: "auto" | "owner_tag";
  /** Member posts and replies imported per forum per UTC day; the rest wait, so a busy server cannot flood the tracker. */
  readonly memberDailyLimit: number;
}
export interface DiscordForumAuthor {
  readonly userId: string;
  readonly name: string;
  /** The host's owner verdict for this guild (ADR 0251), never a display name. */
  readonly owner: boolean;
}
/** Gateway events for a bound forum, normalized by the body. */
export type DiscordForumEvent =
  | {
      readonly kind: "post";
      readonly forumId: string;
      readonly threadId: string;
      readonly title: string;
      readonly content: string;
      readonly author: DiscordForumAuthor;
      readonly appliedTags: readonly string[];
    }
  | {
      readonly kind: "reply";
      readonly forumId: string;
      readonly threadId: string;
      readonly messageId: string;
      readonly content: string;
      readonly author: DiscordForumAuthor;
    }
  | {
      readonly kind: "tags";
      readonly forumId: string;
      readonly threadId: string;
      readonly appliedTags: readonly string[];
      /** Who changed the tags, from the guild audit log; THREAD_UPDATE itself names no one. */
      readonly attribution:
        | { readonly kind: "audit_log"; readonly entryId: string; readonly by: DiscordForumAuthor }
        | { readonly kind: "no_audit_permission" }
        | { readonly kind: "not_found" };
    };
export interface DiscordForumNotice {
  readonly forumId: string;
  readonly reason: "display_only_status" | "member_limit" | "post_locked" | "post_uncertain" | "write_failed";
  /** What the notice is about: an item, a post, a day or the whole forum. One notice per subject and reason. */
  readonly subject: string;
  readonly detail: string;
}
export interface DiscordForumMirrorOptions {
  readonly path: string;
  readonly tracker: Pick<LocalTrackerBackend, "call" | "subscribe" | "storeId">;
  bindings(): Promise<readonly DiscordForumBinding[]>;
  serverAction(action: DiscordServerAction): Promise<DiscordServerActionResult>;
  /** The body's own Discord user id; its messages never import. The body also drops its own events. */
  readonly botUserId?: string;
  /** The host's owner verdict (ADR 0251), for activity the catch-up finds. Without it, nobody is an owner. */
  owns?(guildId: string, userId: string): Promise<boolean>;
  /** How often to reconcile forum activity the gateway did not deliver; the first pass runs at start. */
  readonly catchUpIntervalMs?: number;
  onNotice?(notice: DiscordForumNotice): void;
  onError?(error: unknown): void;
  clock?(): Date;
}

const Snowflake = z.string().regex(/^\d{5,32}$/u);
const EffectSchema = z.object({
  state: z.enum(["dispatching", "done", "uncertain", "failed"]),
  detail: z.string().max(500).optional(),
});
const HeldSchema = z.object({
  forumId: Snowflake,
  title: z.string(),
  content: z.string(),
  author: z.object({ userId: Snowflake, name: z.string(), owner: z.boolean() }),
  reason: z.enum(["owner_tag", "member_limit"]),
});
const JournalSchema = z.object({
  schemaVersion: z.literal(1),
  storeId: z.string().optional(),
  cursor: z.number().int().nonnegative().default(0),
  /** Forum id to tag name to tag id. */
  tags: z.record(Snowflake, z.record(z.string(), Snowflake)).default({}),
  threads: z
    .record(Snowflake, z.object({ issueId: z.string(), forumId: Snowflake, tags: z.array(Snowflake) }))
    .default({}),
  issues: z.record(z.string(), Snowflake).default({}),
  messages: z.record(Snowflake, z.string()).default({}),
  comments: z.record(z.string(), Snowflake).default({}),
  effects: z.record(z.string(), EffectSchema).default({}),
  held: z.record(Snowflake, HeldSchema).default({}),
  intake: z.record(Snowflake, z.object({ day: z.string(), count: z.number().int() })).default({}),
  notices: z.record(z.string(), z.string()).default({}),
  /** Newest message id the view has seen per post, so catch-up reads only what came after. */
  seen: z.record(Snowflake, Snowflake).default({}),
  /** When the view first saw each forum; posts older than that are the forum's own history. */
  boundAt: z.record(Snowflake, z.string()).default({}),
  /** The last completed catch-up per forum. */
  caughtUp: z.record(Snowflake, z.string()).default({}),
  /** Posts whose starter Discord refused to read (e.g. deleted); catch-up never imports them. */
  skipped: z.record(Snowflake, z.string()).default({}),
  /** Posts whose catch-up failed partway; the next pass reads them directly. */
  retry: z.record(Snowflake, Snowflake).default({}),
});
type Journal = z.infer<typeof JournalSchema>;
interface Issue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description?: string | null;
  readonly projectId: string | null;
  readonly status: string;
  readonly statusType: string;
  readonly labels: readonly string[];
  readonly priority: number;
  readonly updatedAt?: string;
}
interface ForumThread {
  readonly id: string;
  readonly parent_id?: string;
  readonly name: string;
  readonly applied_tags?: string[];
  readonly last_message_id?: string | null;
  readonly thread_metadata?: { readonly archive_timestamp?: string };
}
interface ForumMessage {
  readonly id: string;
  readonly content?: string;
  readonly author: {
    readonly id: string;
    readonly username?: string;
    readonly global_name?: string | null;
    readonly bot?: boolean;
  };
}
interface AuditEntry {
  readonly id: string;
  readonly user_id: string | null;
  readonly target_id: string | null;
  readonly changes?: readonly { readonly key: string; readonly new_value?: unknown }[];
}
const CATCH_UP_PAGES = 10;
/** A snowflake's creation time (Discord epoch 2015-01-01). */
const snowflakeTime = (id: string) => Number((BigInt(id) >> 22n) + 1420070400000n);
const newer = (left: string, right: string) => BigInt(left) > BigInt(right);
const sameTags = (left: unknown, right: readonly string[]) =>
  Array.isArray(left) &&
  left.length === right.length &&
  left.every((tag) => typeof tag === "string" && right.includes(tag));
const PRIORITY = ["", "Urgent", "High", "Medium", "Low"];
/** Discord answered and refused: nothing changed. */
class DiscordRefusal extends Error {}

/** The status tag that shows a built-in status; custom statuses fall back to their type. */
function discordStatusTag(status: string, type: string): StatusTag {
  switch (status) {
    case "Backlog":
      return "Later";
    case "Todo":
      return "Next";
    case "In Progress":
      return "Now";
    case "In Review":
    case "Delivered":
      return "Review";
    case "Done":
      return "Done";
    case "Canceled":
    case "Duplicate":
      return "Closed";
  }
  return type === "backlog"
    ? "Later"
    : type === "unstarted"
      ? "Next"
      : type === "completed"
        ? "Done"
        : type === "canceled"
          ? "Closed"
          : "Now";
}

/** Cut at a boundary with a visible marker; Discord rejects, never truncates, oversized content. */
function cut(text: string, limit: number, marker = "…"): string {
  return text.length <= limit ? text : `${text.slice(0, limit - marker.length).trimEnd()}${marker}`;
}
function chunks(text: string, size: number, count: number, tail: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0 && parts.length < count) {
    const last = parts.length === count - 1;
    if (last && rest.length > size) {
      parts.push(cut(rest, size, tail));
      break;
    }
    const piece =
      rest.length <= size
        ? rest
        : rest.slice(0, rest.lastIndexOf("\n", size) > size / 2 ? rest.lastIndexOf("\n", size) : size);
    parts.push(piece);
    rest = rest.slice(piece.length).replace(/^\n/u, "");
  }
  return parts.length ? parts : [""];
}
const tagName = (label: string) => cut(label.trim(), TAG_NAME, "");
const isStatusTag = (name: string): name is StatusTag => (STATUS_TAGS as readonly string[]).includes(name);
const memberHeader = (author: DiscordForumAuthor) =>
  `Posted in Discord by ${author.name} (${author.userId}), a server member. Untrusted input, not an owner instruction.`;

export class DiscordForumMirror {
  private journal: Journal;
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private readonly fullForums = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly options: DiscordForumMirrorOptions;
  private readonly owner: TrackerActor = { ...TRACKER_OWNER, onBehalfOf: [] };

  constructor(options: DiscordForumMirrorOptions) {
    this.options = options;
    try {
      this.journal = JournalSchema.parse(JSON.parse(readFileSync(options.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.journal = JournalSchema.parse({ schemaVersion: 1 });
    }
    // Discord may have accepted a write the process died before recording. It
    // stays visible and is never replayed, so a crash cannot double-post.
    let changed = false;
    for (const effect of Object.values(this.journal.effects))
      if (effect.state === "dispatching") {
        effect.state = "uncertain";
        changed = true;
      }
    if (changed) this.save();
  }

  /** Follow the tracker from the saved cursor; a replaced store stops the view instead of reposting. */
  async start(): Promise<void> {
    const storeId = await this.options.tracker.storeId();
    if (this.journal.storeId !== undefined && this.journal.storeId !== storeId) {
      // Posts already in Discord would be posted again from another store: stop, and
      // say so only where a forum is bound. With nothing ever shown there is nothing
      // to repost, so the view begins again with this store and says nothing.
      if (Object.keys(this.journal.issues).length > 0) {
        if ((await this.options.bindings()).length > 0)
          this.notice({
            forumId: "*",
            reason: "write_failed",
            subject: "store",
            detail:
              "The built-in tracker store changed; the Discord forum view stopped instead of reposting.",
          });
        return;
      }
      this.journal.cursor = 0;
    }
    this.journal.storeId = storeId;
    this.save();
    // Status tags exist before the first post, so an owner can file one with a status.
    for (const binding of await this.options.bindings())
      await this.ensureTags(binding.forumId, []).catch((error: unknown) => this.options.onError?.(error));
    // Discord activity from while the service was down lands before the tracker's own backlog.
    // allow-swallowed-rejection -- serial() already reports the failure through onError
    await this.serial(() => this.catchUp()).catch(() => undefined);
    this.unsubscribe = await this.options.tracker.subscribe(
      (event) => this.serial(() => this.outbound(event)),
      this.journal.cursor,
    );
    if (this.options.catchUpIntervalMs !== undefined) {
      this.timer = setInterval(() => {
        // allow-swallowed-rejection -- serial() already reports the failure through onError
        void this.serial(() => this.catchUp()).catch(() => undefined);
      }, this.options.catchUpIntervalMs);
      this.timer.unref?.();
    }
  }

  /**
   * Reconcile what the gateway did not deliver: new posts, replies and tag
   * changes in bound forums since the last pass. Every write keeps its
   * Discord-keyed idempotency, so a repeated pass changes nothing.
   */
  async catchUp(): Promise<void> {
    for (const binding of await this.options.bindings()) {
      try {
        await this.catchUpForum(binding);
        this.recovered(binding.forumId, "catch-up");
      } catch (error) {
        this.notice({
          forumId: binding.forumId,
          reason: "write_failed",
          subject: "catch-up",
          detail: `Clankie could not catch up on the Discord forum: ${cut(error instanceof Error ? error.message : String(error), 300)}`,
        });
        this.options.onError?.(error);
      }
    }
  }

  /** Apply one normalized gateway event from a bound forum. */
  receive(event: DiscordForumEvent): Promise<void> {
    return this.serial(() => this.inbound(event));
  }

  /**
   * A body-reported event: only a forum bound in its own guild is accepted, and
   * every author's standing is the host's verdict (ADR 0251), never the body's.
   */
  async accept(
    wire: DiscordForumEventRequest,
    owns: (guildId: string, userId: string) => Promise<boolean>,
  ): Promise<"accepted" | "not_bound"> {
    const binding = await this.binding({ forumId: wire.forumId });
    if (!binding || binding.serverId !== wire.guildId) return "not_bound";
    const author = async (person: { userId: string; name: string }) => ({
      ...person,
      owner: await owns(wire.guildId, person.userId),
    });
    const base = { forumId: wire.forumId, threadId: wire.threadId };
    await this.receive(
      wire.kind === "post"
        ? {
            ...base,
            kind: "post",
            title: wire.title,
            content: wire.content,
            author: await author(wire.author),
            appliedTags: wire.appliedTags,
          }
        : wire.kind === "reply"
          ? {
              ...base,
              kind: "reply",
              messageId: wire.messageId,
              content: wire.content,
              author: await author(wire.author),
            }
          : {
              ...base,
              kind: "tags",
              appliedTags: wire.appliedTags,
              attribution:
                wire.attribution.kind === "audit_log"
                  ? { ...wire.attribution, by: await author(wire.attribution.by) }
                  : wire.attribution,
            },
    );
    return "accepted";
  }

  /** Resolves once queued work, and the work it queued, has finished. */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.queue;
      await seen;
    } while (seen !== this.queue);
  }

  snapshot(): Journal {
    return structuredClone(this.journal);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.unsubscribe?.();
    await this.queue;
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(() => (this.closed ? undefined : work()));
    this.queue = next.catch((error: unknown) => this.options.onError?.(error));
    return next;
  }

  private save(): void {
    mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
    const temp = `${this.options.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.journal)}\n`, { mode: 0o600 });
    renameSync(temp, this.options.path);
  }

  /** At most one notice per subject and reason until that subject recovers. */
  private notice(notice: DiscordForumNotice): void {
    const key = `${notice.forumId}:${notice.reason}:${notice.subject}`;
    if (this.journal.notices[key] !== undefined) return;
    this.journal.notices[key] = notice.detail;
    this.save();
    this.options.onNotice?.(notice);
  }

  private recovered(forumId: string, subject: string): void {
    const key = `${forumId}:write_failed:${subject}`;
    if (this.journal.notices[key] === undefined) return;
    delete this.journal.notices[key];
    this.save();
  }

  private async binding(where: { projectId?: string | null; forumId?: string }) {
    return (await this.options.bindings()).find(
      (binding) =>
        (where.forumId === undefined || binding.forumId === where.forumId) &&
        (where.projectId === undefined || binding.projectId === where.projectId),
    );
  }

  private async issue(id: string): Promise<Issue> {
    return (await this.options.tracker.call("get_issue", { id })) as Issue;
  }

  private async rest(action: DiscordServerAction): Promise<DiscordServerActionResult> {
    const result = await this.options.serverAction(action);
    if (!result.ok) throw new DiscordRefusal(`Discord ${action.method} ${action.path}: ${result.message}`);
    return result;
  }

  /**
   * Run a write once. A refusal changed nothing and may be tried again; a transport
   * failure or a crash mid-write may have reached Discord, so it is never repeated.
   */
  private async once<T>(key: string, write: () => Promise<T>): Promise<T | undefined> {
    if (this.journal.effects[key] !== undefined) return undefined;
    this.journal.effects[key] = { state: "dispatching" };
    this.save();
    try {
      const result = await write();
      this.journal.effects[key] = { state: "done" };
      this.save();
      return result;
    } catch (error) {
      this.journal.effects[key] = {
        state: error instanceof DiscordRefusal ? "failed" : "uncertain",
        detail: cut(error instanceof Error ? error.message : String(error), 500),
      };
      this.save();
      throw error;
    }
  }

  // Outbound: the tracker is the source of truth.

  private async outbound(event: TrackerItemEvent): Promise<void> {
    if (event.seq <= this.journal.cursor) return;
    try {
      if (event.via !== DISCORD_FORUM_VIA && OUTBOUND.has(event.type)) await this.project(event);
    } catch (error) {
      this.options.onError?.(error);
    }
    this.journal.cursor = event.seq;
    this.save();
  }

  private async project(event: TrackerItemEvent): Promise<void> {
    const issue = await this.issue(event.issueId);
    const binding = await this.binding({ projectId: issue.projectId });
    if (!binding) return;
    try {
      const threadId = await this.ensurePost(binding, issue);
      if (threadId === undefined) return;
      await this.syncTags(binding, threadId, issue);
      if (event.type === "comment" && event.commentId !== undefined && event.body !== undefined)
        await this.postComment(threadId, event);
      this.recovered(binding.forumId, issue.id);
    } catch (error) {
      // Not retried: the owner hears once per post, and the next change to it tries again.
      this.notice({
        forumId: binding.forumId,
        reason: "write_failed",
        subject: issue.id,
        detail: `${issue.identifier} did not fully reach Discord: ${cut(error instanceof Error ? error.message : String(error), 300)}. Its post and tags are tried again on its next change; a failed comment is not.`,
      });
      throw error;
    }
  }

  private async ensurePost(binding: DiscordForumBinding, issue: Issue): Promise<string | undefined> {
    const known = this.journal.issues[issue.id];
    if (known !== undefined) return known;
    const key = `post:${issue.id}`;
    if (this.journal.effects[key]?.state === "failed") delete this.journal.effects[key];
    const effect = this.journal.effects[key];
    if (effect !== undefined) {
      if (effect.state === "uncertain")
        this.notice({
          forumId: binding.forumId,
          reason: "post_uncertain",
          subject: issue.id,
          detail: `${issue.identifier} may already have a post; Clankie did not post it again.`,
        });
      return undefined;
    }
    const tags = await this.canonicalTags(binding, issue);
    const priority = PRIORITY[issue.priority] ?? "";
    const footer = `\n\n-# ${[issue.identifier, priority, issue.labels.length > tags.length - 1 ? `labels: ${issue.labels.join(", ")}` : ""].filter(Boolean).join(" · ")}`;
    const description = issue.description?.trim() || "No description.";
    const content = `${cut(description, MESSAGE - footer.length, "… (full text in Clankie's tracker)")}${footer}`;
    const created = await this.once(key, () =>
      this.rest({
        method: "POST",
        path: `/channels/${binding.forumId}/threads`,
        body: {
          name: cut(`${issue.identifier} ${issue.title}`, POST_TITLE),
          message: { content, allowed_mentions: { parse: [] } },
          applied_tags: tags,
        },
      }),
    );
    const threadId = created?.resourceId;
    if (threadId === undefined) return undefined;
    this.journal.issues[issue.id] = threadId;
    this.journal.threads[threadId] = { issueId: issue.id, forumId: binding.forumId, tags };
    this.markSeen(threadId, threadId);
    this.save();
    return threadId;
  }

  /** Status first, then labels while the post and the forum's tag cap allow. */
  private async canonicalTags(binding: DiscordForumBinding, issue: Issue): Promise<string[]> {
    const status = discordStatusTag(issue.status, issue.statusType);
    const labels = issue.labels.map(tagName).filter((name) => name && !isStatusTag(name));
    const ids = await this.ensureTags(binding.forumId, [status, ...labels]);
    return [ids[status]!, ...labels.map((name) => ids[name]).filter((id) => id !== undefined)].slice(
      0,
      POST_TAGS,
    );
  }

  /** Adopt or add forum tags. Status tags are moderated: only MANAGE_THREADS holders can set them. */
  private async ensureTags(forumId: string, names: readonly string[]): Promise<Record<string, string>> {
    const known = (this.journal.tags[forumId] ??= {});
    if (
      STATUS_TAGS.every((name) => known[name] !== undefined) &&
      (this.fullForums.has(forumId) || names.every((name) => known[name] !== undefined))
    )
      return known;
    type Tag = { id?: string; name: string; moderated: boolean };
    const read = (result: DiscordServerActionResult) =>
      ((result.data as { available_tags?: Tag[] } | undefined)?.available_tags ?? []) as Tag[];
    const existing = read(await this.rest({ method: "GET", path: `/channels/${forumId}` }));
    const byName = (name: string) => existing.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
    const next = existing.map((tag) => (isStatusTag(tag.name) ? { ...tag, moderated: true } : tag));
    for (const name of new Set([...STATUS_TAGS, ...names]))
      if (!byName(name) && next.length < FORUM_TAGS) next.push({ name, moderated: isStatusTag(name) });
    if (STATUS_TAGS.some((name) => !next.some((tag) => tag.name.toLowerCase() === name.toLowerCase())))
      throw new Error(`Forum ${forumId} has no room for Clankie's ${STATUS_TAGS.length} status tags.`);
    const changed =
      next.length !== existing.length ||
      next.some((tag, index) => tag.moderated !== existing[index]?.moderated);
    const tags = changed
      ? read(
          await this.rest({ method: "PATCH", path: `/channels/${forumId}`, body: { available_tags: next } }),
        )
      : existing;
    for (const tag of tags)
      if (tag.id !== undefined)
        known[STATUS_TAGS.find((name) => name.toLowerCase() === tag.name.toLowerCase()) ?? tag.name] = tag.id;
    // Labels past Discord's tag cap stay in the starter message; stop asking for them.
    if (tags.length >= FORUM_TAGS) this.fullForums.add(forumId);
    this.save();
    return known;
  }

  private async syncTags(binding: DiscordForumBinding, threadId: string, issue: Issue, force = false) {
    const thread = this.journal.threads[threadId]!;
    const tags = await this.canonicalTags(binding, issue);
    const closed = ["Done", "Closed"].includes(discordStatusTag(issue.status, issue.statusType));
    if (
      !force &&
      tags.length === thread.tags.length &&
      tags.every((id) => thread.tags.includes(id)) &&
      !closed
    )
      return;
    const current = (await this.rest({ method: "GET", path: `/channels/${threadId}` })).data as {
      applied_tags?: string[];
      thread_metadata?: { archived?: boolean; locked?: boolean };
    };
    const same =
      (current.applied_tags ?? []).length === tags.length &&
      tags.every((id) => current.applied_tags?.includes(id));
    if (same && current.thread_metadata?.archived === closed) {
      thread.tags = tags;
      this.save();
      return;
    }
    if (current.thread_metadata?.locked) {
      this.notice({
        forumId: binding.forumId,
        reason: "post_locked",
        subject: issue.id,
        detail: `${issue.identifier}'s post is locked; Clankie left its tags as they are.`,
      });
      return;
    }
    // An archived thread accepts no edit but unarchiving.
    if (current.thread_metadata?.archived)
      await this.rest({ method: "PATCH", path: `/channels/${threadId}`, body: { archived: false } });
    if (!same)
      await this.rest({ method: "PATCH", path: `/channels/${threadId}`, body: { applied_tags: tags } });
    if (closed) await this.rest({ method: "PATCH", path: `/channels/${threadId}`, body: { archived: true } });
    thread.tags = tags;
    this.save();
  }

  private async postComment(threadId: string, event: TrackerItemEvent): Promise<void> {
    const commentId = event.commentId!;
    if (this.journal.comments[commentId] !== undefined) return;
    const author = event.actor.name ?? (event.actor.type === "human" ? "Owner" : "Clankie");
    const parts = chunks(
      `**${author}**\n${event.body!}`,
      MESSAGE,
      COMMENT_MESSAGES,
      "… (continues in Clankie's tracker)",
    );
    const first = await this.once(`comment:${commentId}`, async () => {
      let firstId: string | undefined;
      // A message also unarchives its thread.
      for (const content of parts) {
        const sent = await this.rest({
          method: "POST",
          path: `/channels/${threadId}/messages`,
          body: { content, allowed_mentions: { parse: [] } },
        });
        firstId ??= sent.resourceId;
        if (sent.resourceId) {
          this.journal.messages[sent.resourceId] = commentId;
          this.markSeen(threadId, sent.resourceId);
        }
      }
      return firstId;
    });
    if (first !== undefined) {
      this.journal.comments[commentId] = first;
      this.save();
    }
  }

  // Inbound: Discord edits become tracker writes, under the owner's authority or as untrusted data.

  private async inbound(event: DiscordForumEvent): Promise<void> {
    const binding = await this.binding({ forumId: event.forumId });
    if (!binding) return;
    if (event.kind === "post") return this.post(binding, event);
    if (event.kind === "reply") return this.reply(binding, event);
    return this.tags(binding, event);
  }

  private admitMember(binding: DiscordForumBinding): boolean {
    const day = (this.options.clock?.() ?? new Date()).toISOString().slice(0, 10);
    const intake = this.journal.intake[binding.forumId];
    const count = intake?.day === day ? intake.count : 0;
    if (count >= binding.memberDailyLimit) {
      this.notice({
        forumId: binding.forumId,
        reason: "member_limit",
        subject: day,
        detail: `Members reached today's limit of ${binding.memberDailyLimit} posts and replies. Later member posts wait for an owner's status tag; later replies stay in Discord only.`,
      });
      return false;
    }
    this.journal.intake[binding.forumId] = { day, count: count + 1 };
    this.save();
    return true;
  }

  private async post(binding: DiscordForumBinding, event: Extract<DiscordForumEvent, { kind: "post" }>) {
    if (event.author.userId === this.options.botUserId || this.journal.threads[event.threadId]) return;
    if (!event.author.owner) {
      if (binding.memberPosts === "owner_tag" || !this.admitMember(binding)) {
        this.journal.held[event.threadId] = {
          forumId: event.forumId,
          title: event.title,
          content: event.content,
          author: event.author,
          reason: binding.memberPosts === "owner_tag" ? "owner_tag" : "member_limit",
        };
        this.save();
        return;
      }
      return this.create(binding, event.threadId, event, "Backlog", []);
    }
    const tags = this.tagNames(event.forumId, event.appliedTags);
    const status = tags.filter(isStatusTag);
    await this.create(
      binding,
      event.threadId,
      event,
      status.length === 1 ? TAG_STATUS[status[0]!] : "Backlog",
      tags.filter((name) => !isStatusTag(name)),
    );
  }

  private async create(
    binding: DiscordForumBinding,
    threadId: string,
    post: { title: string; content: string; author: DiscordForumAuthor },
    state: string,
    labels: readonly string[],
  ): Promise<void> {
    const member = !post.author.owner;
    for (const label of labels) await this.ensureLabel(label);
    const save = (status: string, key: string) =>
      this.options.tracker.call(
        "save_issue",
        {
          team: binding.team,
          project: binding.projectId,
          title: cut(post.title.trim() || "Untitled post", 255),
          description: member ? `${memberHeader(post.author)}\n\n${post.content}` : post.content,
          state: status,
          ...(labels.length ? { labels: [...labels] } : {}),
          idempotencyKey: key,
        },
        { actor: this.actorFor(post.author), via: DISCORD_FORUM_VIA },
      ) as Promise<{ id: string }>;
    let issue: { id: string };
    try {
      issue = await save(state, `discord:${threadId}`);
    } catch (error) {
      // A refused status (Done needs evidence) changed nothing; file the post in Backlog.
      if (!(error instanceof TrackerWriteRefused) || state === "Backlog") throw error;
      this.notice({
        forumId: binding.forumId,
        reason: "write_failed",
        subject: threadId,
        detail: `"${cut(post.title, 80)}": ${error.message}. Clankie filed it in Backlog.`,
      });
      issue = await save("Backlog", `discord:${threadId}:backlog`);
    }
    delete this.journal.held[threadId];
    this.journal.issues[issue.id] = threadId;
    this.journal.threads[threadId] = { issueId: issue.id, forumId: binding.forumId, tags: [] };
    this.save();
    // Show the canonical status and drop tags the tracker did not accept.
    await this.syncTags(binding, threadId, await this.issue(issue.id), true);
  }

  private async reply(binding: DiscordForumBinding, event: Extract<DiscordForumEvent, { kind: "reply" }>) {
    this.markSeen(event.threadId, event.messageId);
    if (event.author.userId === this.options.botUserId || this.journal.messages[event.messageId]) return;
    const thread = this.journal.threads[event.threadId];
    if (!thread || (!event.author.owner && !this.admitMember(binding))) return;
    const comment = (await this.options.tracker.call(
      "save_comment",
      {
        issueId: thread.issueId,
        body: event.author.owner ? event.content : `${memberHeader(event.author)}\n\n${event.content}`,
        idempotencyKey: `discord:${event.messageId}`,
      },
      { actor: this.actorFor(event.author), via: DISCORD_FORUM_VIA },
    )) as { id: string };
    this.journal.messages[event.messageId] = comment.id;
    this.journal.comments[comment.id] = event.messageId;
    this.save();
  }

  private async tags(binding: DiscordForumBinding, event: Extract<DiscordForumEvent, { kind: "tags" }>) {
    const thread = this.journal.threads[event.threadId];
    const by = event.attribution.kind === "audit_log" ? event.attribution.by : undefined;
    if (!thread) {
      // An owner's status tag admits a held member post.
      const held = this.journal.held[event.threadId];
      const status = this.tagNames(event.forumId, event.appliedTags).filter(isStatusTag);
      if (held && by?.owner && status.length === 1)
        await this.create(binding, event.threadId, held, TAG_STATUS[status[0]!], []);
      return;
    }
    const applied = [...event.appliedTags].sort().join(",");
    if (applied === [...thread.tags].sort().join(",")) return;
    const issue = await this.issue(thread.issueId);
    if (event.attribution.kind !== "audit_log" || by?.owner !== true) {
      if (event.attribution.kind === "no_audit_permission")
        this.notice({
          forumId: binding.forumId,
          reason: "display_only_status",
          subject: "forum",
          detail:
            "Status tags are display-only in this forum: Clankie cannot read the audit log to tell who changed them. Give his bot View Audit Log, or change status in Clankie.",
        });
      await this.syncTags(binding, event.threadId, issue, true);
      return;
    }
    const names = this.tagNames(event.forumId, event.appliedTags);
    const status = names.filter(isStatusTag);
    const labels = names.filter((name) => !isStatusTag(name));
    // Labels that never fit a tag stay; labels shown as tags follow the owner's edit.
    const shown = new Set(Object.keys(this.journal.tags[event.forumId] ?? {}));
    const kept = issue.labels.filter((label) => !shown.has(tagName(label)));
    for (const label of labels) await this.ensureLabel(label);
    try {
      await this.options.tracker.call(
        "save_issue",
        {
          id: issue.id,
          ...(status.length === 1 ? { state: TAG_STATUS[status[0]!] } : {}),
          labels: [...new Set([...kept, ...labels])],
          idempotencyKey: `discord:audit:${event.attribution.entryId}`,
        },
        { actor: this.owner, via: DISCORD_FORUM_VIA },
      );
    } catch (error) {
      // The tracker's own rules still hold, e.g. Done needs an evidence bundle.
      if (!(error instanceof TrackerWriteRefused)) throw error;
      this.notice({
        forumId: binding.forumId,
        reason: "write_failed",
        subject: `${event.threadId}:${event.attribution.entryId}`,
        detail: `${issue.identifier}: ${error.message}. Clankie restored its tags.`,
      });
    }
    // A missing or doubled status tag is not a status; show the tracker's again.
    await this.syncTags(binding, event.threadId, await this.issue(issue.id), true);
  }

  private markSeen(threadId: string, messageId: string): void {
    const seen = this.journal.seen[threadId];
    if (seen === undefined || newer(messageId, seen)) this.journal.seen[threadId] = messageId;
  }

  private async person(
    binding: DiscordForumBinding,
    user: ForumMessage["author"],
  ): Promise<DiscordForumAuthor> {
    return {
      userId: user.id,
      name: (user.global_name ?? user.username ?? user.id).slice(0, 100),
      owner: (await this.options.owns?.(binding.serverId, user.id)) ?? false,
    };
  }

  private async catchUpForum(binding: DiscordForumBinding): Promise<void> {
    const now = (this.options.clock?.() ?? new Date()).toISOString();
    // The first pass only marks where the view begins: binding never imports the forum's history.
    const boundAt = this.journal.boundAt[binding.forumId];
    if (boundAt === undefined) {
      this.journal.boundAt[binding.forumId] = now;
      this.journal.caughtUp[binding.forumId] = now;
      this.save();
      return;
    }
    const since = this.journal.caughtUp[binding.forumId] ?? boundAt;
    const threads = new Map<string, ForumThread>();
    const active = (await this.rest({ method: "GET", path: `/guilds/${binding.serverId}/threads/active` }))
      .data as { threads?: ForumThread[] } | undefined;
    for (const thread of active?.threads ?? [])
      if (thread.parent_id === binding.forumId) threads.set(thread.id, thread);
    let before: string | undefined;
    for (let page = 0; page < CATCH_UP_PAGES; page++) {
      const archived = (
        await this.rest({
          method: "GET",
          path: `/channels/${binding.forumId}/threads/archived/public`,
          query: { limit: "50", ...(before === undefined ? {} : { before }) },
        })
      ).data as { threads?: ForumThread[]; has_more?: boolean } | undefined;
      const list = archived?.threads ?? [];
      for (const thread of list) if (!threads.has(thread.id)) threads.set(thread.id, thread);
      const oldest = list.at(-1)?.thread_metadata?.archive_timestamp;
      if (!archived?.has_more || oldest === undefined || oldest < since) break;
      before = oldest;
    }
    // Posts that failed partway last time are read directly, even when archived before `since`.
    for (const [threadId] of Object.entries(this.journal.retry))
      if (!threads.has(threadId))
        try {
          threads.set(
            threadId,
            (await this.rest({ method: "GET", path: `/channels/${threadId}` }))
              .data as unknown as ForumThread,
          );
        } catch (error) {
          if (!(error instanceof DiscordRefusal)) throw error;
          delete this.journal.retry[threadId];
        }
    const people = new Map<string, Promise<DiscordForumAuthor>>();
    const who = (user: ForumMessage["author"]) => {
      let person = people.get(user.id);
      if (person === undefined) {
        person = this.person(binding, user);
        people.set(user.id, person);
      }
      return person;
    };
    let audit: { entries: AuditEntry[]; users: ForumMessage["author"][] } | "no_permission" | undefined;
    const attribution = async (threadId: string, applied: readonly string[], issueId?: string) => {
      audit ??= await this.rest({
        method: "GET",
        path: `/guilds/${binding.serverId}/audit-logs`,
        query: { action_type: "111", limit: "100" },
      }).then(
        (result) => {
          const data = result.data as { audit_log_entries?: AuditEntry[]; users?: ForumMessage["author"][] };
          return { entries: data.audit_log_entries ?? [], users: data.users ?? [] };
        },
        (error: unknown) => {
          if (error instanceof DiscordRefusal) return "no_permission" as const;
          throw error;
        },
      );
      if (audit === "no_permission") return { kind: "no_audit_permission" as const };
      // Only an edit that produced exactly the post's current tags speaks for them: a later
      // unrecorded change by someone else must never borrow an earlier owner's entry.
      const entry = audit.entries
        .filter(
          (candidate) =>
            candidate.target_id === threadId &&
            candidate.changes?.some(
              (change) => change.key === "applied_tags" && sameTags(change.new_value, applied),
            ),
        )
        .sort((left, right) => (newer(left.id, right.id) ? -1 : 1))[0];
      if (!entry?.user_id || entry.user_id === this.options.botUserId) return { kind: "not_found" as const };
      // The tracker changed the item after this edit, so the newer side wins.
      const updatedAt = issueId === undefined ? undefined : (await this.issue(issueId)).updatedAt;
      if (updatedAt !== undefined && Date.parse(updatedAt) > snowflakeTime(entry.id))
        return { kind: "not_found" as const };
      const user = audit.users.find((candidate) => candidate.id === entry.user_id) ?? { id: entry.user_id };
      return { kind: "audit_log" as const, entryId: entry.id, by: await who(user) };
    };
    for (const thread of threads.values()) {
      if (this.journal.skipped[thread.id] !== undefined) continue;
      // One post that fails never holds back the rest of the forum.
      try {
        await this.catchUpThread(binding, thread, boundAt, who, attribution);
        delete this.journal.retry[thread.id];
      } catch (error) {
        this.journal.retry[thread.id] = binding.forumId;
        this.options.onError?.(error);
      }
    }
    this.journal.caughtUp[binding.forumId] = now;
    this.save();
  }

  private async catchUpThread(
    binding: DiscordForumBinding,
    thread: ForumThread,
    boundAt: string,
    who: (user: ForumMessage["author"]) => Promise<DiscordForumAuthor>,
    attribution: (
      threadId: string,
      applied: readonly string[],
      issueId?: string,
    ) => Promise<Extract<DiscordForumEvent, { kind: "tags" }>["attribution"]>,
  ): Promise<void> {
    const known = this.journal.threads[thread.id];
    const held = this.journal.held[thread.id];
    if (!known && !held && snowflakeTime(thread.id) >= Date.parse(boundAt)) {
      let starter: ForumMessage;
      try {
        starter = (await this.rest({ method: "GET", path: `/channels/${thread.id}/messages/${thread.id}` }))
          .data as unknown as ForumMessage;
      } catch (error) {
        if (!(error instanceof DiscordRefusal)) throw error;
        // Discord answered and refused (the starter was deleted): there is no post to import.
        this.journal.skipped[thread.id] = cut(error.message, 300);
        this.notice({
          forumId: binding.forumId,
          reason: "write_failed",
          subject: `skipped:${thread.id}`,
          detail: `Clankie skipped a Discord forum post he could not read ("${cut(thread.name, 80)}"): ${cut(error.message, 200)}`,
        });
        return;
      }
      this.markSeen(thread.id, thread.id);
      if (!starter.author.bot && starter.author.id !== this.options.botUserId)
        await this.post(binding, {
          kind: "post",
          forumId: binding.forumId,
          threadId: thread.id,
          title: thread.name,
          content: starter.content ?? "",
          author: await who(starter.author),
          appliedTags: thread.applied_tags ?? [],
        });
    }
    if (this.journal.threads[thread.id]) await this.catchUpReplies(binding, thread, who);
    const applied = thread.applied_tags ?? [];
    const drifted = known && [...applied].sort().join(",") !== [...known.tags].sort().join(",");
    const tagged = !known && held && this.tagNames(binding.forumId, applied).some(isStatusTag);
    if (drifted || tagged)
      await this.tags(binding, {
        kind: "tags",
        forumId: binding.forumId,
        threadId: thread.id,
        appliedTags: applied,
        attribution: await attribution(thread.id, applied, known?.issueId),
      });
  }

  private async catchUpReplies(
    binding: DiscordForumBinding,
    thread: ForumThread,
    who: (user: ForumMessage["author"]) => Promise<DiscordForumAuthor>,
  ): Promise<void> {
    let after = this.journal.seen[thread.id] ?? thread.id;
    if (!thread.last_message_id || !newer(thread.last_message_id, after)) return;
    for (let page = 0; page < CATCH_UP_PAGES; page++) {
      const messages = (
        ((
          await this.rest({
            method: "GET",
            path: `/channels/${thread.id}/messages`,
            query: { after, limit: "100" },
          })
        ).data as ForumMessage[] | undefined) ?? []
      ).sort((left, right) => (newer(left.id, right.id) ? 1 : -1));
      for (const message of messages) {
        if (message.id !== thread.id && !message.author.bot && message.author.id !== this.options.botUserId)
          await this.reply(binding, {
            kind: "reply",
            forumId: binding.forumId,
            threadId: thread.id,
            messageId: message.id,
            content: message.content ?? "",
            author: await who(message.author),
          });
        this.markSeen(thread.id, message.id);
        after = message.id;
      }
      this.save();
      if (messages.length < 100) return;
    }
  }

  private tagNames(forumId: string, ids: readonly string[]): string[] {
    const known = Object.entries(this.journal.tags[forumId] ?? {});
    return ids.flatMap((id) => known.filter(([, tagId]) => tagId === id).map(([name]) => name));
  }

  private async ensureLabel(name: string): Promise<void> {
    const { labels } = (await this.options.tracker.call("list_issue_labels", {})) as {
      labels: { name: string }[];
    };
    if (!labels.some((label) => label.name === name))
      await this.options.tracker.call(
        "save_issue_label",
        { name },
        { actor: this.owner, via: DISCORD_FORUM_VIA },
      );
  }

  private actorFor(author: DiscordForumAuthor): TrackerActor {
    return author.owner
      ? this.owner
      : { type: "external", id: `discord:${author.userId}`, name: author.name, onBehalfOf: [] };
  }
}
