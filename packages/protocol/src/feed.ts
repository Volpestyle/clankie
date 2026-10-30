import { z } from "zod";
import { MailIssueReferenceSchema } from "./mail-reference.ts";
import { ConversationQuestionSchema, OperatorConversationIdSchema } from "./operator-conversations.ts";
import { ProjectIdSchema } from "./projects.ts";
import { additiveEnum } from "./response.ts";
import { WorkRepoSchema } from "./work-items.ts";

/**
 * The owner's feed: one newest-first read joined by the host from the stores
 * that already exist. Pending owner asks are checks; mailed owner updates and
 * project status updates are updates. Drops (the owner's screenshots, bugs and
 * ideas filed as issue files) have their shape here and no source yet.
 *
 * The feed is display only. A check is answered with `input_answer` and an owner
 * update dismissed with `owner_update_dismiss`, against the ids each item
 * carries; the feed adds no second answer or dismiss path and grants nothing.
 */
export const FEED_LIST_LIMIT_DEFAULT = 20;
export const FEED_LIST_LIMIT_MAX = 50;
/** A longer body is cut here and marked; the project's own details hold the rest. */
export const FEED_BODY_MAX = 4000;

/** A navigable reference: a web page, an evidence record or a built-in tracker record. */
export const FeedUrlSchema = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    try {
      return ["http:", "https:", "clankie:", "clankie-work:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Expected an HTTP, HTTPS, clankie or clankie-work URL");
export const FeedLinkSchema = z
  .object({ label: z.string().trim().min(1).max(500), url: FeedUrlSchema })
  .strict();
export type FeedLink = z.infer<typeof FeedLinkSchema>;
/** `mimeType` is absent when only the link is known, as for an image a project update embeds. */
export const FeedMediaSchema = z
  .object({
    url: FeedUrlSchema,
    mimeType: z.string().trim().min(1).max(100).optional(),
    alt: z.string().max(500).optional(),
  })
  .strict();
export type FeedMedia = z.infer<typeof FeedMediaSchema>;

/** A pending owner ask. `question` and `revision` form the exact `input_answer` target. */
export const FeedCheckSchema = z
  .object({
    question: ConversationQuestionSchema,
    revision: z.number().int().nonnegative(),
    media: z.array(FeedMediaSchema).max(1).optional(),
  })
  .strict();
export type FeedCheck = z.infer<typeof FeedCheckSchema>;

const body = {
  body: z.string().max(FEED_BODY_MAX),
  bodyTruncated: z.literal(true).optional(),
};

/** News: exactly one of `ownerUpdate` (mailed by Clankie) or `projectUpdate` (a project status update). */
export const FeedUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    ...body,
    issue: MailIssueReferenceSchema.optional(),
    links: z.array(FeedLinkSchema).max(32).optional(),
    media: z.array(FeedMediaSchema).max(16).optional(),
    /** Dismiss with `owner_update_dismiss {id}`; dismissed mail leaves the feed. */
    ownerUpdate: z
      .object({
        id: z.string().uuid(),
        conversationId: OperatorConversationIdSchema,
        state: z.enum(["unread", "read"]),
        seatId: z.string().min(1).max(512).optional(),
      })
      .strict()
      .optional(),
    /** Read-only here; `work_project_details {repoId}` holds the full update and its replies. */
    projectUpdate: z
      .object({
        id: z.string().trim().min(1).max(256),
        repoId: WorkRepoSchema.shape.id,
        health: z.string().trim().min(1).max(64).optional(),
        author: z.string().trim().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((update, context) => {
    if ((update.ownerUpdate === undefined) === (update.projectUpdate === undefined))
      context.addIssue({
        code: "custom",
        message: "An update is either an owner update or a project update",
      });
  });
export type FeedUpdate = z.infer<typeof FeedUpdateSchema>;

/** Something the owner dropped, filed as an issue file labelled `drop`. No host emits these yet. */
export const FeedDropSchema = z
  .object({
    itemId: z.string().trim().min(1).max(256),
    repoId: WorkRepoSchema.shape.id,
    title: z.string().trim().min(1).max(500),
    ...body,
    issue: MailIssueReferenceSchema.optional(),
    media: z.array(FeedMediaSchema).max(16).optional(),
  })
  .strict();
export type FeedDrop = z.infer<typeof FeedDropSchema>;

/**
 * A newer host may add a kind: a reader using `parseProtocolResponse` drops
 * that entry and keeps the rest. The payload key matches `kind`.
 */
export const FeedItemKindSchema = additiveEnum(["check", "update", "drop"]);
export type FeedItemKind = z.infer<typeof FeedItemKindSchema>;
export const FeedItemSchema = z
  .object({
    kind: FeedItemKindSchema,
    /** Stable across reads: `check:<requestId>`, `owner-update:<id>`, `project-update:<id>`. */
    id: z.string().min(1).max(600),
    at: z.string().datetime(),
    /** The owner's project the item belongs to, when the host can tell. */
    projectId: ProjectIdSchema.optional(),
    check: FeedCheckSchema.optional(),
    update: FeedUpdateSchema.optional(),
    drop: FeedDropSchema.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    for (const kind of ["check", "update", "drop"] as const)
      if ((item[kind] !== undefined) !== (item.kind === kind))
        context.addIssue({
          code: "custom",
          path: [kind],
          message: `The ${item.kind} item carries only ${item.kind}`,
        });
  });
type FeedItemFields = z.infer<typeof FeedItemSchema>;
export type FeedCheckItem = FeedItemFields & { kind: "check"; check: FeedCheck };
export type FeedUpdateItem = FeedItemFields & { kind: "update"; update: FeedUpdate };
export type FeedDropItem = FeedItemFields & { kind: "drop"; drop: FeedDrop };
export type FeedItem = FeedCheckItem | FeedUpdateItem | FeedDropItem;

/** Opaque; it names the last item of a page, so newer items never shift a later page. */
export const FeedCursorSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const FeedListRequestSchema = z
  .object({
    projectId: ProjectIdSchema.optional(),
    cursor: FeedCursorSchema.optional(),
    limit: z.number().int().min(1).max(FEED_LIST_LIMIT_MAX).optional(),
  })
  .strict();
export type FeedListRequest = z.infer<typeof FeedListRequestSchema>;

export const FeedListResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ready"),
      /** Newest first; equal times order by id, descending. */
      items: z.array(FeedItemSchema).max(FEED_LIST_LIMIT_MAX),
      /** Present while older items remain. */
      nextCursor: FeedCursorSchema.optional(),
      /** Project trackers whose updates this read could not include. */
      unreadable: z
        .array(
          z
            .object({
              repoId: WorkRepoSchema.shape.id,
              projectId: ProjectIdSchema.optional(),
              message: z.string().min(1).max(240),
            })
            .strict(),
        )
        .max(64)
        .optional(),
    })
    .strict(),
  z.object({ outcome: z.literal("unavailable"), message: z.string().min(1).max(1000) }).strict(),
]);
export type FeedListResult = z.infer<typeof FeedListResultSchema>;
/** A feed read whose items are narrowed by kind, as the schema guarantees. */
export type FeedPage =
  | Exclude<FeedListResult, { outcome: "ready" }>
  | (Omit<Extract<FeedListResult, { outcome: "ready" }>, "items"> & { items: FeedItem[] });
