import { z } from "zod";
import { MailIssueReferenceSchema } from "./mail-reference.ts";
import { DevicePlatformSchema } from "./devices.ts";
import {
  ConversationQuestionSchema,
  EvidenceLinkSchema,
  OPERATOR_CONVERSATION_ATTACHMENTS_MAX,
  OperatorConversationAttachmentRefSchema,
  OperatorConversationIdSchema,
  OwnerCheckLineSchema,
} from "./operator-conversations.ts";
import { ProjectIdSchema } from "./projects.ts";
import { additiveEnum } from "./response.ts";
import { WorkItemStatusSchema, WorkRepoSchema } from "./work-items.ts";

/**
 * The owner's feed: one newest-first read joined by the host from the stores
 * that already exist. Pending owner asks are checks; mailed owner updates and
 * project status updates are updates. Drops are what the owner threw at
 * Clankie (`feed_drop`): a screenshot of a bug, an idea, a note, each filed as a
 * private issue file labelled `drop` that the project's lead refines. Proofs
 * are finished built-in tracker items the lead marked with an owner check
 * (ADR 0299), waiting on the owner's verdict.
 *
 * The feed is display only. A check is answered with `input_answer`, an owner
 * update dismissed with `owner_update_dismiss`, and a proof given its verdict
 * with `post_owner_verdict` from the owner's paired app, against the ids each
 * item carries; the feed adds no second answer or dismiss path and grants nothing.
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

/**
 * A check line as the feed shows it. New lines are at most `OWNER_CHECK_LINE_MAX`
 * (140) characters; a built-in owner check saved before that limit may run to 160.
 */
export const FEED_CHECK_LINE_READ_MAX = 160;
const FeedCheckLineSchema = z.string().trim().min(1).max(FEED_CHECK_LINE_READ_MAX);

/**
 * A pending owner ask. `question` and `revision` form the exact `input_answer` target.
 *
 * `line` is what to look at: the ask's own check line, or the owner check of the
 * built-in item a verify ask names. `longer` says the asker marked it as taking
 * longer than a ten-second look. `media` is the one thing to look at: the ask's
 * evidence, or the named item's current proof (a clip before a screenshot), as a
 * `clankie://evidence` link with its type. All three are absent from older hosts.
 */
export const FeedCheckSchema = z
  .object({
    question: ConversationQuestionSchema,
    revision: z.number().int().nonnegative(),
    line: FeedCheckLineSchema.optional(),
    longer: z.literal(true).optional(),
    media: z.array(FeedMediaSchema).max(1).optional(),
  })
  .strict();
export type FeedCheck = z.infer<typeof FeedCheckSchema>;

/**
 * A finished built-in tracker item the lead marked with an owner check (ADR 0299):
 * landed or delivered, not Done, with a current evidence bundle and no pending
 * verify ask (that ask is the item's check instead). Only the owner's paired app
 * answers it: `post_owner_verdict {issueId, bundleId, verdict, note?}` on the
 * built-in tracker (`tracker_sync` or `POST /v1/tracker/call`), naming this
 * `bundleId` so the verdict covers exactly the proof shown. `media` is the
 * bundle's clips, then its screenshots.
 */
export const FeedProofSchema = z
  .object({
    issueId: z.string().trim().min(1).max(256),
    key: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(500),
    line: FeedCheckLineSchema,
    bundleId: z.string().trim().min(1).max(256),
    stage: z.enum(["landed", "delivered"]),
    url: FeedUrlSchema.optional(),
    media: z.array(FeedMediaSchema).max(16).optional(),
  })
  .strict();
export type FeedProof = z.infer<typeof FeedProofSchema>;

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

/**
 * Where a drop came from: one of the owner's paired devices (by the name the
 * owner gave it) or this machine itself (the CLI or console). The host records
 * it from the caller's authority, never from the request.
 */
export const FeedDropSourceSchema = z
  .object({
    kind: additiveEnum(["device", "machine"]),
    name: z.string().trim().min(1).max(64).optional(),
    platform: DevicePlatformSchema.optional(),
  })
  .strict();
export type FeedDropSource = z.infer<typeof FeedDropSourceSchema>;

/**
 * Something the owner dropped, filed as a private issue file (`.clankie/work/`)
 * labelled `drop`. `itemId` and `repoId` read it with the work ops; `title` and
 * `body` follow the file as its lead refines it, and it leaves the feed once
 * it is done or canceled. `source` and `status` are absent from older hosts.
 */
export const FeedDropSchema = z
  .object({
    itemId: z.string().trim().min(1).max(256),
    repoId: WorkRepoSchema.shape.id,
    title: z.string().trim().min(1).max(500),
    ...body,
    issue: MailIssueReferenceSchema.optional(),
    media: z.array(FeedMediaSchema).max(16).optional(),
    status: WorkItemStatusSchema.optional(),
    source: FeedDropSourceSchema.optional(),
  })
  .strict();
export type FeedDrop = z.infer<typeof FeedDropSchema>;

/**
 * A newer host may add a kind: a reader using `parseProtocolResponse` drops
 * that entry and keeps the rest. The payload key matches `kind`.
 */
export const FeedItemKindSchema = additiveEnum(["check", "update", "drop", "proof"]);
export type FeedItemKind = z.infer<typeof FeedItemKindSchema>;
export const FeedItemSchema = z
  .object({
    kind: FeedItemKindSchema,
    /**
     * Stable across reads: `check:<requestId>`, `owner-update:<id>`,
     * `project-update:<id>`, `drop:<repoId>/<itemId>`, `proof:<issueId>`.
     */
    id: z.string().min(1).max(600),
    at: z.string().datetime(),
    /** The owner's project the item belongs to, when the host can tell. */
    projectId: ProjectIdSchema.optional(),
    check: FeedCheckSchema.optional(),
    update: FeedUpdateSchema.optional(),
    drop: FeedDropSchema.optional(),
    proof: FeedProofSchema.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    for (const kind of ["check", "update", "drop", "proof"] as const)
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
export type FeedProofItem = FeedItemFields & { kind: "proof"; proof: FeedProof };
export type FeedItem = FeedCheckItem | FeedUpdateItem | FeedDropItem | FeedProofItem;

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

/** The owner's own words in one drop; the issue file holds them whole. */
export const FEED_DROP_BODY_MAX = 20_000;
export const FEED_DROP_TITLE_MAX = 200;

/**
 * `feed_drop`: the owner throws something at Clankie. The host files it as a
 * stub issue in the project's private `.clankie/work/` (main checkout), so it is
 * kept even when no agent runs, then wakes the project's lead once to refine it.
 *
 * Attachments are owner uploads (ADR 0209: `upload_begin`/`upload_chunk`/
 * `upload_commit`) committed to any conversation the owner can upload to; the
 * host copies each into the evidence store (ADR 0258) and links it from the
 * file's `## Evidence` section. Image bytes never enter `.clankie/work`.
 *
 * `idempotencyKey` is the client's: a retry with the same key and request
 * answers with the same item and never files or wakes twice. The same key with
 * a different request is refused.
 */
export const FeedDropRequestSchema = z
  .object({
    projectId: ProjectIdSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
    title: z.string().trim().min(1).max(FEED_DROP_TITLE_MAX).optional(),
    body: z.string().max(FEED_DROP_BODY_MAX).optional(),
    attachments: z
      .array(
        OperatorConversationAttachmentRefSchema.extend({
          conversationId: OperatorConversationIdSchema,
        }).strict(),
      )
      .max(OPERATOR_CONVERSATION_ATTACHMENTS_MAX)
      .optional(),
  })
  .strict();
export type FeedDropRequest = z.infer<typeof FeedDropRequestSchema>;
export const FEED_DROP_EMPTY = "A drop needs a title, some text or an attachment";
/** A drop says something: a title, some text or an attachment. */
export function feedDropHasContent(drop: Pick<FeedDropRequest, "title" | "body" | "attachments">): boolean {
  return (
    (drop.body !== undefined && drop.body.trim() !== "") ||
    drop.title !== undefined ||
    (drop.attachments?.length ?? 0) > 0
  );
}

/**
 * `woken`: the lead's conversation took the wake (now or on an earlier try).
 * `not_woken`: no lead could take it; the file waits, and a retry tries again.
 * `uncertain`: an earlier try may have woken it, so it is never woken again.
 */
export const FeedDropWakeSchema = z.enum(["woken", "not_woken", "uncertain"]);
export type FeedDropWake = z.infer<typeof FeedDropWakeSchema>;

export const FeedDropResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("filed"),
      /** The drop as `feed_list` shows it. */
      item: FeedItemSchema,
      /** The issue file, relative to the project's main checkout. */
      file: z.string().min(1).max(1024),
      /** True when this key was already filed: nothing was written again. */
      duplicate: z.boolean(),
      wake: FeedDropWakeSchema,
      leadConversationId: OperatorConversationIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reason: z.enum(["unknown_project", "not_file_backed", "attachment_missing", "idempotency_conflict"]),
      message: z.string().min(1).max(1000),
    })
    .strict(),
  z.object({ outcome: z.literal("unavailable"), message: z.string().min(1).max(1000) }).strict(),
]);
type FeedDropResultFields = z.infer<typeof FeedDropResultSchema>;
/** A drop answer whose filed item is narrowed to a drop, as the host guarantees. */
export type FeedDropResult =
  | Exclude<FeedDropResultFields, { outcome: "filed" }>
  | (Omit<Extract<FeedDropResultFields, { outcome: "filed" }>, "item"> & { item: FeedDropItem });

/**
 * `feed_check`: an agent asks the owner to check something, as a pending owner
 * ask (ADR 0245, purpose `verify`) with the answers "It works" and "Send it back"
 * and room for a note. It shows in the feed as a `check`.
 *
 * `check` is the one line the owner reads: exactly what to look at, answerable in
 * about ten seconds, at most `OWNER_CHECK_LINE_MAX` (140) characters; a longer
 * line is refused with 400. Set `longer` when it takes more than a ten-second
 * look: it still shows, marked. `evidence` is one evidence-store record to look
 * at. The answer wakes the source conversation: `conversationId` when given,
 * otherwise the lead chat of `projectId`, otherwise the main chat.
 *
 * `idempotencyKey` is the caller's: a retry with the same key and request answers
 * with the same check and never asks twice; the same key with another request is
 * refused. The check line is the asker's words, shown to the owner, never run.
 */
export const FeedCheckRequestSchema = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
    check: OwnerCheckLineSchema,
    longer: z.boolean().optional(),
    projectId: ProjectIdSchema.optional(),
    conversationId: OperatorConversationIdSchema.optional(),
    evidence: EvidenceLinkSchema.optional(),
    issue: MailIssueReferenceSchema.optional(),
    waitingOn: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type FeedCheckRequest = z.infer<typeof FeedCheckRequestSchema>;
export const FEED_CHECK_ONE_SOURCE = "Name a project or a conversation for the answer, not both";
export function feedCheckHasOneSource(request: Pick<FeedCheckRequest, "projectId" | "conversationId">) {
  return request.projectId === undefined || request.conversationId === undefined;
}

export const FeedCheckResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("raised"),
      /** The check as `feed_list` shows it; its question is already answered when `duplicate` found it so. */
      item: FeedItemSchema,
      /** True when this key, or the same pending check, was already asked: nothing new was asked. */
      duplicate: z.boolean(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reason: z.enum(["unknown_project", "unknown_conversation", "evidence_missing", "idempotency_conflict"]),
      message: z.string().min(1).max(1000),
    })
    .strict(),
  z.object({ outcome: z.literal("unavailable"), message: z.string().min(1).max(1000) }).strict(),
]);
type FeedCheckResultFields = z.infer<typeof FeedCheckResultSchema>;
/** A check answer whose raised item is narrowed to a check, as the host guarantees. */
export type FeedCheckResult =
  | Exclude<FeedCheckResultFields, { outcome: "raised" }>
  | (Omit<Extract<FeedCheckResultFields, { outcome: "raised" }>, "item"> & { item: FeedCheckItem });
