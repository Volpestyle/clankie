import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { DiscordServerAction, DiscordServerActionResult } from "@clankie/protocol";
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
  readonly detail: string;
}
export interface DiscordForumMirrorOptions {
  readonly path: string;
  readonly tracker: Pick<LocalTrackerBackend, "call" | "subscribe" | "storeId">;
  bindings(): Promise<readonly DiscordForumBinding[]>;
  serverAction(action: DiscordServerAction): Promise<DiscordServerActionResult>;
  /** The body's own Discord user id; its messages never import. */
  readonly botUserId: string;
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
}
const PRIORITY = ["", "Urgent", "High", "Medium", "Low"];

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
      this.notice({
        forumId: "*",
        reason: "write_failed",
        detail: "The built-in tracker store changed; the Discord forum view stopped instead of reposting.",
      });
      return;
    }
    this.journal.storeId = storeId;
    this.save();
    // Status tags exist before the first post, so an owner can file one with a status.
    for (const binding of await this.options.bindings())
      await this.ensureTags(binding.forumId, []).catch((error: unknown) => this.options.onError?.(error));
    this.unsubscribe = await this.options.tracker.subscribe(
      (event) => this.serial(() => this.outbound(event)),
      this.journal.cursor,
    );
  }

  /** Apply one normalized gateway event from a bound forum. */
  receive(event: DiscordForumEvent): Promise<void> {
    return this.serial(() => this.inbound(event));
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

  private notice(notice: DiscordForumNotice): void {
    const key = `${notice.forumId}:${notice.reason}`;
    if (this.journal.notices[key] === notice.detail) return;
    this.journal.notices[key] = notice.detail;
    this.save();
    this.options.onNotice?.(notice);
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
    if (!result.ok) throw new Error(`Discord ${action.method} ${action.path}: ${result.message}`);
    return result;
  }

  /** Run a write once: a recorded key never dispatches again, and a crash mid-write leaves it uncertain. */
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
        state: "failed",
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
    const threadId = await this.ensurePost(binding, issue);
    if (threadId === undefined) return;
    await this.syncTags(binding, threadId, issue);
    if (event.type === "comment" && event.commentId !== undefined && event.body !== undefined)
      await this.postComment(threadId, event);
  }

  private async ensurePost(binding: DiscordForumBinding, issue: Issue): Promise<string | undefined> {
    const known = this.journal.issues[issue.id];
    if (known !== undefined) return known;
    const key = `post:${issue.id}`;
    const effect = this.journal.effects[key];
    if (effect !== undefined) {
      if (effect.state === "uncertain")
        this.notice({
          forumId: binding.forumId,
          reason: "post_uncertain",
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
        if (sent.resourceId) this.journal.messages[sent.resourceId] = commentId;
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
        detail: `${issue.identifier}: ${error.message}. Clankie restored its tags.`,
      });
    }
    // A missing or doubled status tag is not a status; show the tracker's again.
    await this.syncTags(binding, event.threadId, await this.issue(issue.id), true);
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
