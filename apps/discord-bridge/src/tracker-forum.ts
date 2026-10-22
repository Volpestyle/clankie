import type { DiscordForumEventRequest, DiscordTrackerForum } from "@clankie/protocol";

/**
 * Gateway events from forums bound as views of built-in tracker projects
 * (VUH-2531). The body reports what happened and who did it; the service
 * decides whether that person is an owner and what the tracker does.
 */
interface ForumThread {
  readonly id: string;
  readonly guildId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly ownerId: string | null;
  readonly appliedTags: readonly string[];
}
interface ForumAuthor {
  readonly id: string;
  readonly bot: boolean;
  readonly username: string;
  readonly globalName?: string | null;
}
interface ForumMessage {
  readonly id: string;
  readonly content: string;
  readonly author: ForumAuthor;
}
/** A guild audit-log entry for a thread update, as discord.js reports it. */
export interface ForumAuditEntry {
  readonly id: string;
  readonly targetId: string | null;
  readonly createdTimestamp: number;
  readonly executor: ForumAuthor | null;
  /** discord.js reports each change's new value as `new`. */
  readonly changes: readonly { readonly key: string; readonly new?: unknown }[];
}
export interface TrackerForumBody {
  readonly botUserId: () => string | undefined;
  forums(): Promise<readonly DiscordTrackerForum[]>;
  submit(event: DiscordForumEventRequest): Promise<unknown>;
  /** Recent thread-update entries; throws an error with code 50013 without View Audit Log. */
  threadUpdates(guildId: string): Promise<readonly ForumAuditEntry[]>;
  readonly wait?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const name = (author: ForumAuthor) => (author.globalName ?? author.username).slice(0, 100) || author.id;
const MISSING_PERMISSIONS = 50013;
const AUDIT_WINDOW_MS = 60_000;
const AUDIT_ATTEMPTS = 3;

async function bound(body: TrackerForumBody, thread: Pick<ForumThread, "guildId" | "parentId">) {
  if (thread.parentId === null) return undefined;
  return (await body.forums()).find(
    (forum) => forum.forumId === thread.parentId && forum.serverId === thread.guildId,
  );
}

/** A new post: its starter message is the description. */
export async function reportForumPost(
  body: TrackerForumBody,
  thread: ForumThread,
  starter: ForumMessage | null,
): Promise<void> {
  if (!starter || starter.author.bot || starter.author.id === body.botUserId()) return;
  const forum = await bound(body, thread);
  if (!forum) return;
  await body.submit({
    schemaVersion: 1,
    kind: "post",
    guildId: thread.guildId,
    forumId: forum.forumId,
    threadId: thread.id,
    title: thread.name.slice(0, 100),
    content: starter.content.slice(0, 4000),
    author: { userId: starter.author.id, name: name(starter.author) },
    appliedTags: thread.appliedTags.slice(0, 5),
  });
}

/** A reply in a post. The starter message shares the thread's id and arrives as the post. */
export async function reportForumReply(
  body: TrackerForumBody,
  thread: ForumThread,
  message: ForumMessage,
): Promise<void> {
  if (message.id === thread.id || message.author.bot || message.author.id === body.botUserId()) return;
  const forum = await bound(body, thread);
  if (!forum) return;
  await body.submit({
    schemaVersion: 1,
    kind: "reply",
    guildId: thread.guildId,
    forumId: forum.forumId,
    threadId: thread.id,
    messageId: message.id,
    content: message.content.slice(0, 4000),
    author: { userId: message.author.id, name: name(message.author) },
  });
}

/**
 * A tag change, credited only to an audit-log entry for this thread that
 * records applied_tags. THREAD_UPDATE names no actor, and a nearby rename by
 * someone else must never lend its author to the tags.
 */
export async function reportForumTags(
  body: TrackerForumBody,
  before: ForumThread,
  after: ForumThread,
): Promise<void> {
  const same =
    before.appliedTags.length === after.appliedTags.length &&
    before.appliedTags.every((tag) => after.appliedTags.includes(tag));
  if (same) return;
  const forum = await bound(body, after);
  if (!forum) return;
  const wait = body.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = body.now ?? Date.now;
  let attribution: Extract<DiscordForumEventRequest, { kind: "tags" }>["attribution"] = { kind: "not_found" };
  for (let attempt = 0; attempt < AUDIT_ATTEMPTS; attempt++) {
    let entries: readonly ForumAuditEntry[];
    try {
      entries = await body.threadUpdates(after.guildId);
    } catch (error) {
      if ((error as { code?: unknown }).code !== MISSING_PERMISSIONS) throw error;
      attribution = { kind: "no_audit_permission" };
      break;
    }
    const entry = entries
      .filter(
        (candidate) =>
          candidate.targetId === after.id &&
          now() - candidate.createdTimestamp <= AUDIT_WINDOW_MS &&
          // Only an edit that produced exactly these tags speaks for them; a later unrecorded
          // change by someone else must never borrow an earlier owner's entry.
          candidate.changes.some(
            (change) =>
              change.key === "applied_tags" &&
              Array.isArray(change.new) &&
              change.new.length === after.appliedTags.length &&
              change.new.every((tag) => after.appliedTags.includes(tag as string)),
          ),
      )
      .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0];
    if (entry?.executor) {
      // The view's own edits are its echo.
      if (entry.executor.id === body.botUserId()) return;
      attribution = {
        kind: "audit_log",
        entryId: entry.id,
        by: { userId: entry.executor.id, name: name(entry.executor) },
      };
      break;
    }
    // The audit log can trail the gateway event briefly.
    if (attempt < AUDIT_ATTEMPTS - 1) await wait(1000);
  }
  await body.submit({
    schemaVersion: 1,
    kind: "tags",
    guildId: after.guildId,
    forumId: forum.forumId,
    threadId: after.id,
    appliedTags: after.appliedTags.slice(0, 5),
    attribution,
  });
}
