import type { DiscordServerAction, DiscordServerActionResult } from "@clankie/protocol";

/**
 * A stateful fake of the slice of Discord's REST API a tracker forum view uses
 * (VUH-2531). It enforces the documented caps (20 forum tags with names up to
 * 20 characters, 5 per post, 100-character titles, 2000-character messages)
 * and the archived and locked thread rules. Live Discord is the slice 4 trial.
 */
export const GUILD = "500000000000000009";
export const FORUM = "500000000000000001";
export interface FakeThread {
  id: string;
  type: 11;
  guild_id: string;
  parent_id: string;
  name: string;
  owner_id?: string;
  applied_tags: string[];
  thread_metadata: { archived: boolean; locked: boolean };
}
class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`${status} ${message}`);
    this.status = status;
  }
}
export class FakeDiscord {
  private next = 600000000000000000n;
  readonly forum = {
    id: FORUM,
    type: 15,
    guild_id: GUILD,
    available_tags: [] as { id: string; name: string; moderated: boolean }[],
  };
  readonly threads = new Map<string, FakeThread>();
  readonly messages = new Map<string, { id: string; content: string }[]>();
  readonly requests: DiscordServerAction[] = [];
  /** Member id to role ids, for role-based owner proofs. */
  readonly members = new Map<string, string[]>();
  hang: ((action: DiscordServerAction) => boolean) | undefined;
  refuse: ((action: DiscordServerAction) => boolean) | undefined;
  private id = () => String(this.next++);

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

  thread(id: string, name: string, tags: string[] = [], ownerId?: string): FakeThread {
    const thread: FakeThread = {
      id,
      type: 11,
      guild_id: GUILD,
      parent_id: FORUM,
      name,
      ...(ownerId ? { owner_id: ownerId } : {}),
      applied_tags: tags,
      thread_metadata: { archived: false, locked: false },
    };
    this.threads.set(id, thread);
    this.messages.set(id, [{ id, content: name }]);
    return thread;
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

  private handle(action: DiscordServerAction): unknown {
    const body = (action.body ?? {}) as Record<string, unknown>;
    const parts = action.path.split("/").slice(1);
    if (parts[0] === "guilds" && parts[2] === "members" && action.method === "GET") {
      const roles = this.members.get(parts[3]!);
      if (!roles) throw new Refused(404, "Unknown Member");
      return { user: { id: parts[3] }, roles };
    }
    if (parts[0] !== "channels") throw new Refused(405, "Method Not Allowed");
    const [, id, sub] = parts;
    const validTags = (tags: unknown) =>
      Array.isArray(tags) &&
      tags.length <= 5 &&
      tags.every((tag) => this.forum.available_tags.some((known) => known.id === tag));
    if (id === FORUM) {
      if (action.method === "GET" && sub === undefined) return this.forum;
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
        const thread = this.thread(this.id(), String(body.name), [...(body.applied_tags as string[])]);
        this.messages.set(thread.id, [{ id: thread.id, content: message.content }]);
        return thread;
      }
    }
    const thread = this.threads.get(id!);
    if (!thread) throw new Refused(404, "Unknown Channel");
    if (action.method === "GET" && sub === undefined) return thread;
    if (action.method === "PATCH" && sub === undefined) {
      if (thread.thread_metadata.locked) throw new Refused(403, "Missing Permissions");
      if (thread.thread_metadata.archived && !(Object.keys(body).length === 1 && body.archived === false))
        throw new Refused(400, "Thread is archived");
      if ("applied_tags" in body) {
        if (!validTags(body.applied_tags)) throw new Refused(400, "Invalid Form Body");
        thread.applied_tags = [...(body.applied_tags as string[])];
      }
      if ("archived" in body) thread.thread_metadata.archived = body.archived === true;
      return thread;
    }
    if (action.method === "POST" && sub === "messages") {
      if (thread.thread_metadata.locked) throw new Refused(403, "Missing Permissions");
      if (String(body.content).length > 2000) throw new Refused(400, "Invalid Form Body");
      // Discord unarchives a thread when a message is sent in it.
      thread.thread_metadata.archived = false;
      const message = { id: this.id(), content: String(body.content) };
      this.messages.get(thread.id)!.push(message);
      return message;
    }
    throw new Refused(405, "Method Not Allowed");
  }
}
