import { z } from "zod";

/**
 * Gateway events from a forum bound as a view of a built-in tracker project
 * (VUH-2531). The body reports who acted; the service decides whether that is
 * an owner, so a forum post never carries its own authority.
 */
export const DISCORD_FORUM_EVENT_PATH = "/v1/captain/discord-forum-events";
const Snowflake = z.string().regex(/^\d{5,32}$/u);
const Author = z.object({ userId: Snowflake, name: z.string().min(1).max(100) }).strict();
const Thread = { schemaVersion: z.literal(1), guildId: Snowflake, forumId: Snowflake, threadId: Snowflake };
export const DiscordForumEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...Thread,
      kind: z.literal("post"),
      title: z.string().max(100),
      // Nitro members can send 4000 characters.
      content: z.string().max(4000),
      author: Author,
      appliedTags: z.array(Snowflake).max(5),
    })
    .strict(),
  z
    .object({
      ...Thread,
      kind: z.literal("reply"),
      messageId: Snowflake,
      content: z.string().max(4000),
      author: Author,
    })
    .strict(),
  z
    .object({
      ...Thread,
      kind: z.literal("tags"),
      appliedTags: z.array(Snowflake).max(5),
      /** THREAD_UPDATE names no actor; the guild audit log does, given View Audit Log. */
      attribution: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("audit_log"), entryId: Snowflake, by: Author }).strict(),
        z.object({ kind: z.literal("no_audit_permission") }).strict(),
        z.object({ kind: z.literal("not_found") }).strict(),
      ]),
    })
    .strict(),
]);
export type DiscordForumEventRequest = z.infer<typeof DiscordForumEventSchema>;
export const DiscordForumEventResultSchema = z
  .object({ schemaVersion: z.literal(1), state: z.enum(["accepted", "not_bound"]) })
  .strict();
export type DiscordForumEventResult = z.infer<typeof DiscordForumEventResultSchema>;
