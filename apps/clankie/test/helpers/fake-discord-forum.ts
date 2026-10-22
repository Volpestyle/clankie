import type { DiscordServerAction, DiscordServerActionResult } from "@clankie/protocol";

/**
 * A stateful fake of the slice of Discord's REST API a tracker forum view uses
 * (VUH-2531). It enforces the documented caps (20 forum tags with names up to
 * 20 characters, 5 per post, 100-character titles, 2000-character messages),
 * the archived and locked thread rules, and the catch-up reads: active and
 * archived posts, messages after an id, and the guild audit log. Ids are real
 * time-based snowflakes. Live Discord is the slice 4 trial.
 */
export const GUILD = "500000000000000009";
export const FORUM = "500000000000000001";
export const BOT = "500000000000000002";
const DISCORD_EPOCH = 1420070400000n;
export interface FakeThread {
  id: string;
  type: 11;
  guild_id: string;
  parent_id: string;
  name: string;
  owner_id?: string;
  applied_tags: string[];
  last_message_id: string;
  thread_metadata: { archived: boolean; locked: boolean; archive_timestamp?: string };
}
export interface FakeMessage {
  id: string;
  content: string;
  author: { id: string; username: string; bot: boolean };
}
interface FakeAuditEntry {
  id: string;
  user_id: string;
  target_id: string;
  action_type: 111;
  changes: { key: string; new_value: string[] }[];
}
class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`${status} ${message}`);
    this.status = status;
  }
}
export class FakeDiscord {
  private sequence = 0n;
  readonly forum = {
    id: FORUM,
    type: 15,
    guild_id: GUILD,
    available_tags: [] as { id: string; name: string; moderated: boolean }[],
  };
  readonly threads = new Map<string, FakeThread>();
  readonly messages = new Map<string, FakeMessage[]>();
  readonly audit: FakeAuditEntry[] = [];
  readonly requests: DiscordServerAction[] = [];
  /** Member id to role ids, for role-based owner proofs. */
  readonly members = new Map<string, string[]>();
  hang: ((action: DiscordServerAction) => boolean) | undefined;
  refuse: ((action: DiscordServerAction) => boolean) | undefined;
  /** Without View Audit Log, the audit log answers 403. */
  auditDenied = false;

  /** A snowflake for now (or `at`), increasing within the same millisecond. */
  id(at = Date.now()): string {
    return String(((BigInt(at) - DISCORD_EPOCH) << 22n) + (this.sequence++ % 4096n));
  }

  /** Raw REST, as the body's credentialed transport sees it: data, or a thrown error. */
  rest = async (action: DiscordServerAction): Promise<unknown> => {
    this.requests.push(structuredClone(action));
    if (this.hang?.(action)) return new Promise(() => {});
    if (this.refuse?.(action)) throw new Refused(403, "Missing Permissions");
    return structuredClone(this.handle(action));
  };

  /** The executor's result shape, for tests that bypass the body's fences. */
  serverAction = async (action: DiscordServerAction): Promise<DiscordServerActionResult> => {
    try {
      const data = (await this.rest(action)) as { id?: string };
      return { ok: true, message: "ok", data: data as never, ...(data?.id ? { resourceId: data.id } : {}) };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  };

  /** A post as a person makes it in Discord, with its starter message. */
  thread(id: string, name: string, tags: string[] = [], ownerId?: string, content = name): FakeThread {
    const thread: FakeThread = {
      id,
      type: 11,
      guild_id: GUILD,
      parent_id: FORUM,
      name,
      ...(ownerId ? { owner_id: ownerId } : {}),
      applied_tags: tags,
      last_message_id: id,
      thread_metadata: { archived: false, locked: false },
    };
    this.threads.set(id, thread);
    this.messages.set(id, [{ id, content, author: this.user(ownerId ?? BOT) }]);
    return thread;
  }
  /** A reply someone sends; like Discord, it unarchives the post. */
  reply(threadId: string, authorId: string, content: string, at?: number): FakeMessage {
    const thread = this.threads.get(threadId)!;
    const message = { id: this.id(at), content, author: this.user(authorId) };
    this.messages.get(threadId)!.push(message);
    thread.last_message_id = message.id;
    thread.thread_metadata.archived = false;
    return message;
  }
  /** Someone changes a post's tags; the audit log records who, unless `recorded` is false. */
  retag(threadId: string, names: string[], byUserId: string, at?: number, recorded = true): void {
    const tags = names.map((name) => this.tagId(name));
    this.threads.get(threadId)!.applied_tags = tags;
    if (recorded)
      this.audit.push({
        id: this.id(at),
        user_id: byUserId,
        target_id: threadId,
        action_type: 111,
        changes: [{ key: "applied_tags", new_value: tags }],
      });
  }
  archive(threadId: string): void {
    const thread = this.threads.get(threadId)!;
    thread.thread_metadata.archived = true;
    thread.thread_metadata.archive_timestamp = new Date().toISOString();
  }
  tagId(name: string): string {
    return this.forum.available_tags.find((tag) => tag.name === name)!.id;
  }
  tagNames(thread: FakeThread): string[] {
    return thread.applied_tags.map((id) => this.forum.available_tags.find((tag) => tag.id === id)!.name);
  }
  post(issueTitle: string): FakeThread {
    return [...this.threads.values()].find((thread) => thread.name.endsWith(issueTitle))!;
  }

  private user(id: string) {
    return { id, username: id === BOT ? "clankie" : `user-${id.slice(-4)}`, bot: id === BOT };
  }

  private handle(action: DiscordServerAction): unknown {
    const body = (action.body ?? {}) as Record<string, unknown>;
    const query = action.query ?? {};
    const parts = action.path.split("/").slice(1);
    if (parts[0] === "guilds" && action.method === "GET") {
      if (parts[2] === "members") {
        const roles = this.members.get(parts[3]!);
        if (!roles) throw new Refused(404, "Unknown Member");
        return { user: { id: parts[3] }, roles };
      }
      if (parts.slice(2).join("/") === "threads/active")
        return { threads: [...this.threads.values()].filter((thread) => !thread.thread_metadata.archived) };
      if (parts[2] === "audit-logs") {
        if (this.auditDenied) throw new Refused(403, "Missing Permissions");
        const entries = [...this.audit].reverse().slice(0, Number(query.limit ?? 50));
        return {
          audit_log_entries: entries,
          users: [...new Set(entries.map((entry) => entry.user_id))].map((id) => this.user(id)),
        };
      }
    }
    if (parts[0] !== "channels") throw new Refused(405, "Method Not Allowed");
    const [, id, sub] = parts;
    const validTags = (tags: unknown) =>
      Array.isArray(tags) &&
      tags.length <= 5 &&
      tags.every((tag) => this.forum.available_tags.some((known) => known.id === tag));
    if (id === FORUM) {
      if (action.method === "GET" && sub === undefined) return this.forum;
      if (action.method === "GET" && parts.slice(2).join("/") === "threads/archived/public") {
        const archived = [...this.threads.values()]
          .filter((thread) => thread.thread_metadata.archived)
          .filter((thread) => !query.before || thread.thread_metadata.archive_timestamp! < query.before)
          .sort((left, right) =>
            right.thread_metadata.archive_timestamp!.localeCompare(left.thread_metadata.archive_timestamp!),
          );
        const limit = Number(query.limit ?? 50);
        return { threads: archived.slice(0, limit), has_more: archived.length > limit };
      }
      if (action.method === "PATCH" && sub === undefined) {
        const tags = body.available_tags as { id?: string; name: string; moderated?: boolean }[];
        if (tags.length > 20 || tags.some((tag) => tag.name.length > 20))
          throw new Refused(400, "Invalid Form Body");
        this.forum.available_tags = tags.map((tag) => ({
          id: tag.id ?? this.id(),
          name: tag.name,
          moderated: tag.moderated === true,
        }));
        return this.forum;
      }
      if (action.method === "POST" && sub === "threads") {
        const message = body.message as { content: string };
        if (String(body.name).length > 100 || message.content.length > 2000 || !validTags(body.applied_tags))
          throw new Refused(400, "Invalid Form Body");
        return this.thread(
          this.id(),
          String(body.name),
          [...(body.applied_tags as string[])],
          BOT,
          message.content,
        );
      }
    }
    const thread = this.threads.get(id!);
    if (!thread) throw new Refused(404, "Unknown Channel");
    if (action.method === "GET" && sub === undefined) return thread;
    if (action.method === "GET" && sub === "messages") {
      const messages = this.messages.get(thread.id)!;
      if (parts[3] !== undefined) {
        const message = messages.find((candidate) => candidate.id === parts[3]);
        if (!message) throw new Refused(404, "Unknown Message");
        return message;
      }
      // Discord lists newest first; callers order them.
      return messages
        .filter((message) => !query.after || BigInt(message.id) > BigInt(query.after))
        .slice(0, Number(query.limit ?? 50))
        .reverse();
    }
    if (action.method === "PATCH" && sub === undefined) {
      if (thread.thread_metadata.locked) throw new Refused(403, "Missing Permissions");
      if (thread.thread_metadata.archived && !(Object.keys(body).length === 1 && body.archived === false))
        throw new Refused(400, "Thread is archived");
      if ("applied_tags" in body) {
        if (!validTags(body.applied_tags)) throw new Refused(400, "Invalid Form Body");
        thread.applied_tags = [...(body.applied_tags as string[])];
      }
      if ("archived" in body) {
        thread.thread_metadata.archived = body.archived === true;
        if (body.archived === true) thread.thread_metadata.archive_timestamp = new Date().toISOString();
      }
      return thread;
    }
    if (action.method === "POST" && sub === "messages") {
      if (thread.thread_metadata.locked) throw new Refused(403, "Missing Permissions");
      if (String(body.content).length > 2000) throw new Refused(400, "Invalid Form Body");
      return this.reply(thread.id, BOT, String(body.content));
    }
    throw new Refused(405, "Method Not Allowed");
  }
}
