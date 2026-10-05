import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderAccount } from "@clankie/credential-broker";
import { z } from "zod";
import { canonicalJson } from "@clankie/play";
import {
  ConversationOwnerSchema,
  LinearRecipientSchema,
  type ConversationOwner,
  type LinearRecipient,
} from "./captain/conversation-owner.ts";

// Signed Linear activity supplies context, never operator instructions.
// Verify the raw bytes before parsing: serialization changes the signature.

/** Linear's own tolerance for replayed deliveries; the timestamp is inside the signed body. */
const TIMESTAMP_SKEW_MS = 60_000;

type LinearWebhookRejection = "bad_signature" | "stale" | "malformed";

/** Authenticated deliveries we pass over still receive 200 so Linear does not retry. */
export type LinearWebhookOutcome =
  | { readonly kind: "activity"; readonly activity: LinearActivityEvent }
  | {
      readonly kind: "ignored";
      readonly reason: "other_event" | "self_echo";
      readonly activity?: LinearActivityEvent;
    }
  | { readonly kind: "rejected"; readonly reason: LinearWebhookRejection };

// The envelope is stable; each resource owns its data shape. New fields and
// resource types must not break ingestion. Deleted actors can be null.
const LinearActivityPayloadSchema = z.looseObject({
  action: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  webhookTimestamp: z.number().int().positive(),
  createdAt: z.string().max(64).optional(),
  url: z.string().max(2_048).optional(),
  actor: z
    .looseObject({
      id: z.string().max(256).nullish(),
      type: z.string().max(64).nullish(),
      name: z.string().max(256).nullish(),
      email: z.string().max(320).nullish(),
    })
    .nullish(),
  data: z.record(z.string(), z.unknown()).optional(),
  updatedFrom: z.record(z.string(), z.unknown()).optional(),
  organizationId: z.string().max(256).optional(),
});

export interface LinearActivityEvent {
  readonly eventId?: string;
  /** True only for the connected account’s notification inbox, never a webhook. */
  readonly notification?: boolean;
  readonly deliveryId: string | undefined;
  readonly type: string;
  readonly action: string;
  readonly actorId?: string | undefined;
  readonly actorType?: string | undefined;
  readonly organizationId?: string | undefined;
  /** Canonical issue UUID from signed resource data or its retained signed URL mapping. */
  readonly issueId?: string | undefined;
  /** Context read from the verified connection; never actor, routing, or wake-rule authority. */
  readonly issueContext?: { readonly id: string; readonly identifier?: string; readonly title: string };
  /** Host admission retained by an exact write receipt, never a provider-supplied owner. */
  readonly conversationOwner?: ConversationOwner | undefined;
  /** When the host admitted this saved revision; delayed echoes cannot renew ownership. */
  readonly conversationOwnerRecordedAt?: number | undefined;
  readonly writeRecipient?: LinearRecipient | undefined;
  readonly writeRecipientRecordedAt?: number | undefined;
  /** Exact parent update's host-stamped author recipient, correlated from a retained write. */
  readonly replyRecipient?: LinearReplyRecipient | undefined;
  readonly worker?: { grantId: string; principalId: string; workId: string } | undefined;
  /** Set when another actor comments on content his verified account posted (ADR 0191). */
  readonly replyTo?: LinearReplyTo | undefined;
  readonly actorName: string | undefined;
  readonly actorEmail: string | undefined;
  readonly createdAt: string | undefined;
  readonly url: string | undefined;
  readonly data: Record<string, unknown>;
  readonly updatedFrom: Record<string, unknown> | undefined;
}

/** The post of his a comment answers, and the worker who wrote it when a receipt says so. */
export interface LinearReplyTo {
  readonly type: string;
  readonly id: string;
  readonly personaId?: string;
  readonly worker?: { grantId: string; principalId: string; workId: string } | undefined;
}

export const LinearReplyRecipientSchema = z
  .object({
    parentType: z.enum(["ProjectUpdate", "InitiativeUpdate"]),
    parentId: z.string().uuid(),
    recipient: LinearRecipientSchema,
    recordedAt: z.number().int().nonnegative(),
  })
  .strict();
export type LinearReplyRecipient = z.infer<typeof LinearReplyRecipientSchema>;

export interface LinearWebhookHeaders {
  readonly signature: string | undefined;
  readonly delivery: string | undefined;
  readonly event: string | undefined;
}

const WRITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WRITE_MAX = 500;
const WRITE_TYPES: Record<string, string> = {
  issue: "Issue",
  comment: "Comment",
  project: "Project",
  project_update: "ProjectUpdate",
  initiative_update: "InitiativeUpdate",
  document: "Document",
};
const REVISION_FIELDS = [
  "body",
  "title",
  "description",
  "stateId",
  "assigneeId",
  "projectId",
  "teamId",
  "archivedAt",
] as const;
const fieldHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const WorkerProvenanceSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    principalId: z.string().min(1).max(256),
    workId: z.string().min(1).max(256),
  })
  .strict();
const WriteReceiptSchema = z
  .object({
    organizationId: z.string().min(1).max(256),
    actorId: z.string().min(1).max(256),
    connectionId: z.string().min(1).max(256),
    type: z.string().min(1).max(64),
    id: z.string().uuid(),
    updatedAt: z.string().datetime({ offset: true }),
    recordedAt: z.number().int().nonnegative(),
    fields: z
      .partialRecord(z.enum(REVISION_FIELDS), z.string().regex(/^[a-f0-9]{64}$/u))
      .refine((fields) => Object.keys(fields).length > 0),
    worker: WorkerProvenanceSchema.optional(),
    owner: ConversationOwnerSchema.optional(),
    recipient: LinearRecipientSchema.optional(),
    personaId: z.string().min(1).max(256).optional(),
  })
  .strict();
type WriteReceipt = z.infer<typeof WriteReceiptSchema>;
const ReturnedRevisionSchema = z.looseObject({
  id: z.string().uuid(),
  updatedAt: z.string().datetime({ offset: true }),
});
const ReturnedIssueRevisionSchema = ReturnedRevisionSchema.extend({
  id: z.string().min(1).max(256),
  uuid: z.string().uuid().optional(),
});

/** Canonical resource identity only; display identifiers and URL slugs cannot supply UUID proof. */
export function linearActivityIssueId(
  activity: Pick<LinearActivityEvent, "type" | "data">,
): string | undefined {
  if (activity.type === "Issue") return consistentUuid([activity.data.id]);
  if (activity.type === "Comment")
    return consistentUuid([activity.data.issueId, record(activity.data.issue).id]);
}

/** A signed comment's full parent UUID, never a title or abbreviated URL fragment. */
export function linearActivityUpdateParent(
  activity: Pick<LinearActivityEvent, "type" | "data">,
): Pick<LinearReplyRecipient, "parentType" | "parentId"> | undefined {
  if (activity.type !== "Comment") return;
  const projectValues = [activity.data.projectUpdateId, record(activity.data.projectUpdate).id];
  const initiativeValues = [activity.data.initiativeUpdateId, record(activity.data.initiativeUpdate).id];
  const projectPresent = projectValues.some((value) => value !== undefined && value !== null);
  const initiativePresent = initiativeValues.some((value) => value !== undefined && value !== null);
  if (projectPresent === initiativePresent) return;
  const parentId = consistentUuid(projectPresent ? projectValues : initiativeValues);
  if (parentId) return { parentType: projectPresent ? "ProjectUpdate" : "InitiativeUpdate", parentId };
}

/** The exact issue addressed by a successful structured write in the connected Linear workspace. */
export function linearWriteIssue(call: {
  readonly server: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly content: string;
  readonly isError: boolean;
  readonly account?: ProviderAccount | undefined;
}): { organizationId: string; issueId: string } | undefined {
  const type = /^(?:create|update|save)_(?:worker_)?(issue|comment)$/u.exec(call.tool)?.[1];
  if (call.server !== "linear" || call.isError || !type || call.account?.provider !== "linear") return;
  const organizationId = consistentUuid([call.account.workspaceId]);
  if (organizationId === undefined) return;
  let result: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    result = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (result.success === false || result.ok === false) return;
  const issue = record(result.issue);
  const issueId =
    type === "issue"
      ? consistentUuid([result.uuid, result.id])
      : consistentUuid([result.issueId, issue.uuid, issue.id, call.arguments.issueId]);
  return issueId === undefined ? undefined : { organizationId, issueId };
}

function consistentUuid(values: readonly unknown[]): string | undefined {
  const ids = values.flatMap((value) => {
    const parsed = z.string().uuid().safeParse(value);
    return parsed.success ? [parsed.data.toLowerCase()] : [];
  });
  return ids.length && ids.every((id) => id === ids[0]) ? ids[0] : undefined;
}

function isWorkerPersonaResult(
  tool: string,
  result: Record<string, unknown>,
): result is Record<string, unknown> & { personaId: string } {
  return (
    (tool === "create_worker_issue" || tool === "create_worker_comment") &&
    typeof result.personaId === "string" &&
    result.personaId.length > 0 &&
    result.personaId.length <= 256
  );
}

/** Exact returned revisions, never every UUID mentioned in a tool response.
 * Captain and worker writes retain provenance and never wake themselves.
 * Missing identity/revision evidence admits the event rather than guessing. */
export class LinearWriteReceipts {
  private written: WriteReceipt[] = [];
  private readonly path: string | undefined;
  constructor(path?: string) {
    this.path = path;
    if (path === undefined) return;
    try {
      this.written = z
        .array(WriteReceiptSchema)
        .max(WRITE_MAX)
        .parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  public record(
    call: {
      readonly server: string;
      readonly tool: string;
      readonly content: string;
      readonly isError: boolean;
      readonly arguments?: Record<string, unknown> | undefined;
      readonly account?: ProviderAccount | undefined;
      readonly worker?: WriteReceipt["worker"];
      readonly owner?: ConversationOwner | undefined;
      readonly recipient?: LinearRecipient | undefined;
    },
    now: Date,
  ): void {
    const match = /^(?:create|update|save)_(.+)$/u.exec(call.tool);
    const resource = match?.[1]?.replace(/^worker_/u, "");
    let type = resource && WRITE_TYPES[resource];
    if (
      call.server !== "linear" ||
      call.isError ||
      (!type && resource !== "status_update") ||
      call.account?.provider !== "linear"
    )
      return;
    let result: z.infer<typeof ReturnedRevisionSchema>;
    try {
      const returned = (type === "Issue" ? ReturnedIssueRevisionSchema : ReturnedRevisionSchema).parse(
        JSON.parse(call.content),
      );
      // Issue MCP results can use a display id; only agreeing returned UUIDs
      // prove receipt identity. Webhook data keeps its UUID-id-only schema.
      const id = type === "Issue" ? consistentUuid([returned.uuid, returned.id]) : returned.id;
      if (id === undefined) return;
      result = { ...returned, id };
    } catch {
      return; // An ambiguous or unstructured response cannot prove a particular echo.
    }
    if (resource === "status_update") {
      const kind = result.type ?? call.arguments?.type;
      type = kind === "project" ? "ProjectUpdate" : kind === "initiative" ? "InitiativeUpdate" : undefined;
      if (
        !type ||
        (result.type !== undefined &&
          call.arguments?.type !== undefined &&
          call.arguments.type !== result.type) ||
        result.success === false ||
        result.ok === false
      )
        return;
    }
    const fields = Object.fromEntries(
      REVISION_FIELDS.filter(
        (key) =>
          Object.hasOwn(result, key) &&
          (result[key] === null || ["string", "number", "boolean"].includes(typeof result[key])),
      ).map((key) => [key, fieldHash(result[key])]),
    );
    if (!Object.keys(fields).length) return;
    const receipt = WriteReceiptSchema.parse({
      organizationId: call.account.workspaceId,
      actorId: call.account.userId,
      connectionId: call.account.connectionId,
      type,
      fields,
      id: result.id.toLowerCase(),
      updatedAt: new Date(result.updatedAt).toISOString(),
      recordedAt: now.getTime(),
      ...(call.worker ? { worker: call.worker } : {}),
      ...(call.owner ? { owner: call.owner } : {}),
      ...(call.recipient ? { recipient: call.recipient } : {}),
      ...(isWorkerPersonaResult(call.tool, result) ? { personaId: result.personaId } : {}),
    });
    const next = this.written.filter((entry) => now.getTime() - entry.recordedAt <= WRITE_TTL_MS);
    next.push(receipt);
    const retained = next.slice(-WRITE_MAX);
    if (this.path !== undefined) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path + ".tmp", JSON.stringify(retained), { mode: 0o600 });
      renameSync(this.path + ".tmp", this.path);
    }
    this.written = retained;
  }

  public match(payload: z.infer<typeof LinearActivityPayloadSchema>, now: Date): WriteReceipt | undefined {
    if (!["create", "update"].includes(payload.action)) return;
    if (payload.action === "update" && !payload.updatedFrom) return;
    const revision = ReturnedRevisionSchema.safeParse(payload.data);
    if (!revision.success) return;
    const matches = this.written.filter(
      (entry) =>
        now.getTime() >= entry.recordedAt &&
        now.getTime() - entry.recordedAt <= WRITE_TTL_MS &&
        entry.organizationId === payload.organizationId &&
        entry.actorId === payload.actor?.id &&
        entry.type === payload.type &&
        entry.id === revision.data.id.toLowerCase() &&
        entry.updatedAt === new Date(revision.data.updatedAt).toISOString() &&
        (payload.action !== "update" ||
          Object.keys(payload.updatedFrom!).every(
            (key) => key === "updatedAt" || Object.hasOwn(entry.fields, key),
          )) &&
        Object.entries(entry.fields).every(
          ([key, digest]) => Object.hasOwn(revision.data, key) && fieldHash(revision.data[key]) === digest,
        ),
    );
    return consistent(matches);
  }

  /** Who wrote a resource through his account, by any retained revision of it. */
  public author(
    organizationId: string | undefined,
    type: string,
    id: string,
    now: Date,
  ): WriteReceipt | undefined {
    return consistent(
      this.written.filter(
        (entry) =>
          now.getTime() - entry.recordedAt <= WRITE_TTL_MS &&
          entry.organizationId === organizationId &&
          entry.type === type &&
          entry.id === id.toLowerCase(),
      ),
    );
  }

  /** Recipient identity is independent of actor provenance: ambiguity stays in the inbox. */
  public recipient(
    organizationId: string | undefined,
    type: string,
    id: string,
    now: Date,
  ): { recipient: LinearRecipient; recordedAt: number } | undefined {
    const canonicalId = consistentUuid([id]);
    if (!canonicalId) return;
    const matches = this.written.filter(
      (entry) =>
        now.getTime() >= entry.recordedAt &&
        now.getTime() - entry.recordedAt <= WRITE_TTL_MS &&
        entry.organizationId === organizationId &&
        entry.type === type &&
        entry.id === canonicalId,
    );
    if (!consistent(matches)) return;
    const recipients = matches.map(
      (entry) =>
        entry.recipient ?? (entry.owner ? { kind: "conversation" as const, owner: entry.owner } : undefined),
    );
    const first = recipients[0];
    if (!first || !recipients.every((item) => JSON.stringify(item) === JSON.stringify(first))) return;
    return { recipient: first, recordedAt: Math.min(...matches.map((entry) => entry.recordedAt)) };
  }
}

// Repeated responses with conflicting provenance are not proof of authorship.
function consistent(matches: readonly WriteReceipt[]): WriteReceipt | undefined {
  if (
    matches.length &&
    matches.every(
      (entry) =>
        entry.connectionId === matches[0]!.connectionId &&
        JSON.stringify(entry.worker) === JSON.stringify(matches[0]!.worker),
    )
  ) {
    const first = matches[0]!;
    const sameOwner = matches.every((entry) => JSON.stringify(entry.owner) === JSON.stringify(first.owner));
    const sameRecipient = matches.every(
      (entry) => JSON.stringify(entry.recipient) === JSON.stringify(first.recipient),
    );
    // Route ambiguity cannot change existing authorship or echo suppression.
    const { owner: _owner, recipient: _recipient, ...provenance } = first;
    return {
      ...provenance,
      ...(sameOwner && first.owner ? { owner: first.owner } : {}),
      ...(sameRecipient && first.recipient ? { recipient: first.recipient } : {}),
    };
  }
}

function signatureMatches(rawBody: Uint8Array, secret: string, presentedHex: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(presentedHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const presented = Buffer.from(presentedHex, "hex");
  // Compare lengths first: timingSafeEqual throws on a length mismatch.
  return presented.byteLength === expected.byteLength && timingSafeEqual(presented, expected);
}

/** Verify authenticity, freshness and the envelope before admitting a new delivery. */
export function classifyLinearDelivery(input: {
  readonly rawBody: Uint8Array;
  readonly headers: LinearWebhookHeaders;
  readonly secret: string;
  readonly now: Date;
  readonly writes?: LinearWriteReceipts;
  readonly recordActivity?: ((activity: LinearActivityEvent) => void) | undefined;
}): LinearWebhookOutcome {
  const { rawBody, headers, secret, now } = input;
  if (headers.signature === undefined || !signatureMatches(rawBody, secret, headers.signature)) {
    return { kind: "rejected", reason: "bad_signature" };
  }

  if (rawBody.byteLength > 1024 * 1024) return { kind: "rejected", reason: "malformed" };

  let payload: z.infer<typeof LinearActivityPayloadSchema>;
  try {
    payload = LinearActivityPayloadSchema.parse(JSON.parse(Buffer.from(rawBody).toString("utf8")));
  } catch {
    return { kind: "rejected", reason: "malformed" };
  }

  if (Math.abs(now.getTime() - payload.webhookTimestamp) > TIMESTAMP_SKEW_MS) {
    return { kind: "rejected", reason: "stale" };
  }

  const receipt = input.writes?.match(payload, now);

  const { webhookTimestamp: _sentAt, ...event } = payload;
  const issueId = linearActivityIssueId({ type: payload.type, data: payload.data ?? {} });
  let activity: LinearActivityEvent = {
    eventId: createHash("sha256").update(canonicalJson(event)).digest("hex"),
    deliveryId: headers.delivery,
    type: payload.type,
    action: payload.action,
    actorId: payload.actor?.id ?? undefined,
    actorType: payload.actor?.type ?? undefined,
    organizationId: payload.organizationId,
    ...(issueId === undefined ? {} : { issueId }),
    ...(receipt?.owner
      ? { conversationOwner: receipt.owner, conversationOwnerRecordedAt: receipt.recordedAt }
      : {}),
    ...(receipt?.recipient
      ? { writeRecipient: receipt.recipient, writeRecipientRecordedAt: receipt.recordedAt }
      : {}),
    ...(receipt?.worker ? { worker: receipt.worker } : {}),
    actorName: payload.actor?.name ?? undefined,
    actorEmail: payload.actor?.email ?? undefined,
    createdAt: payload.createdAt,
    url: payload.url,
    updatedFrom: payload.updatedFrom,
    data: payload.data ?? {},
  };
  const parent = linearActivityUpdateParent(activity);
  if (parent && activity.action === "create" && z.string().uuid().safeParse(activity.data.id).success) {
    const author = input.writes?.author(activity.organizationId, parent.parentType, parent.parentId, now);
    const recipient = input.writes?.recipient(
      activity.organizationId,
      parent.parentType,
      parent.parentId,
      now,
    );
    if (author && author.actorId !== activity.actorId && recipient)
      activity = {
        ...activity,
        replyTo: {
          type: parent.parentType,
          id: parent.parentId,
          ...(author.worker ? { worker: author.worker } : {}),
          ...(author.personaId ? { personaId: author.personaId } : {}),
        },
        replyRecipient: { ...parent, ...recipient },
      };
  }
  if (!["create", "update", "remove"].includes(payload.action))
    return { kind: "ignored", reason: "other_event", activity };
  input.recordActivity?.(activity);
  if (receipt) return { kind: "ignored", reason: "self_echo", activity };
  return { kind: "activity", activity };
}

const HEADLINE_MAX = 160;

/**
 * One line naming the event, for a transcript that shows the rest folded.
 * Provider strings are untrusted; they are shortened, never interpreted.
 */
export function linearActivityHeadline(activity: LinearActivityEvent): string {
  const line = [
    `Linear ${activity.type} ${activity.action}`,
    linearSubject(activity.type, activity.data),
    activity.replyTo ? LINEAR_REPLY_MARK : undefined,
    activity.actorName,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ")
    .replace(/\s+/gu, " ");
  return line.length > HEADLINE_MAX ? `${line.slice(0, HEADLINE_MAX - 1)}…` : line;
}

/** Marks a headline whose comment answers his own post; the wake routes on it. */
const LINEAR_REPLY_MARK = "reply to your post";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** What the event is about: a comment names its parent, anything else itself. */
function linearSubject(type: string, data: Record<string, unknown>): string | undefined {
  const issue = record(data.issue);
  const update =
    type === "ProjectUpdate" || type === "InitiativeUpdate"
      ? data
      : record(data.projectUpdate ?? data.initiativeUpdate);
  const document = record(data.document ?? record(data.documentContent).document);
  const named = (entity: Record<string, unknown>) =>
    [entity.identifier, entity.title].filter((value): value is string => text(value) !== undefined).join(" ");
  if (Object.keys(issue).length) return named(issue);
  if (Object.keys(update).length)
    return [text(record(update.project ?? update.initiative).name), "update", text(update.id)?.slice(0, 8)]
      .filter(Boolean)
      .join(" ");
  if (Object.keys(document).length) return text(document.title);
  return named(data) || text(record(data.project).name);
}

/**
 * A new comment another actor wrote on content his verified account posted:
 * the embedded author says so, or a retained write receipt of his does.
 * Only signed IDs decide it; names and bodies never do.
 */
export function linearReplyTo(
  activity: LinearActivityEvent,
  own: { readonly userId: string; readonly workspaceId: string } | undefined,
  writes: LinearWriteReceipts | undefined,
  now: Date,
): LinearReplyTo | undefined {
  if (activity.type !== "Comment" || activity.action !== "create") return;
  const data = activity.data;
  const update = record(data.projectUpdate);
  const initiativeUpdate = record(data.initiativeUpdate);
  const document = record(data.document ?? record(data.documentContent).document);
  const parents = [
    { type: "Comment", id: data.parentId, authorId: record(data.parent).userId },
    { type: "ProjectUpdate", id: data.projectUpdateId ?? update.id, authorId: update.userId },
    {
      type: "InitiativeUpdate",
      id: data.initiativeUpdateId ?? initiativeUpdate.id,
      authorId: initiativeUpdate.userId,
    },
    { type: "Document", id: data.documentId ?? document.id, authorId: document.creatorId },
    { type: "Issue", id: data.issueId ?? record(data.issue).id, authorId: record(data.issue).creatorId },
  ];
  for (const parent of parents) {
    if (typeof parent.id !== "string" || parent.id.length === 0) continue;
    const receipt = writes?.author(activity.organizationId, parent.type, parent.id, now);
    const verified =
      own !== undefined && own.workspaceId === activity.organizationId ? own.userId : undefined;
    const authorId =
      receipt?.actorId ?? (verified !== undefined && parent.authorId === verified ? verified : undefined);
    if (authorId === undefined || authorId === activity.actorId) continue;
    return {
      type: parent.type,
      id: parent.id,
      ...(receipt?.worker ? { worker: receipt.worker } : {}),
      ...(receipt?.personaId ? { personaId: receipt.personaId } : {}),
    };
  }
}

/** Map signed resource changes onto the existing wake-rule event vocabulary.
 * Linear represents mentions as resource/profile URLs in Markdown. Only newly
 * added links in a created or changed content field count as a mention.
 */
export function linearActivityWakeTypes(activity: LinearActivityEvent): string[] {
  if (!["create", "update"].includes(activity.action)) return [`${activity.type}${activity.action}`];
  const data = activity.data;
  const resource =
    activity.type === "Comment"
      ? data.projectUpdateId || data.projectUpdate
        ? "projectUpdate"
        : data.initiativeUpdateId || data.initiativeUpdate
          ? "initiativeUpdate"
          : data.documentId || data.document || data.documentContent
            ? "document"
            : "issue"
      : activity.type === "ProjectUpdate"
        ? "projectUpdate"
        : activity.type === "InitiativeUpdate"
          ? "initiativeUpdate"
          : activity.type === "Document"
            ? "document"
            : "issue";
  const types: string[] = [];
  if (activity.type === "Comment" && activity.action === "create") types.push(`${resource}NewComment`);
  const mentions = (value: unknown) =>
    new Set(
      typeof value === "string"
        ? (value.match(
            /https:\/\/linear\.app\/[a-zA-Z0-9_-]+\/(?:profiles|issue|project|initiative|document)\/[a-zA-Z0-9_-]+/gu,
          ) ?? [])
        : [],
    );
  const newMention = ["body", "description", "content"].some((field) => {
    if (activity.action === "update" && !Object.hasOwn(activity.updatedFrom ?? {}, field)) return false;
    const before = mentions(activity.updatedFrom?.[field]);
    return [...mentions(data[field])].some((url) => !before.has(url));
  });
  if (newMention) {
    types.push(`${resource}Mention`);
    if (activity.type === "Comment") types.push(`${resource}CommentMention`);
  }
  if (!types.length) {
    if (activity.type === "Issue" && Object.hasOwn(activity.updatedFrom ?? {}, "stateId"))
      types.push("issueStatusChanged");
    else if (activity.type === "Issue" && Object.hasOwn(activity.updatedFrom ?? {}, "assigneeId"))
      types.push("issueAssignedToYou");
    else types.push(`${activity.type}${activity.action}`);
  }
  return types;
}

/** Compact, quoted context for the normal conversation journal and coalesced wake. */
export function linearActivityPrompt(activity: LinearActivityEvent): string {
  const issue =
    activity.type === "Issue" ? activity.data : { ...activity.issueContext, ...record(activity.data.issue) };
  const compact = (value: unknown, limit = 240): unknown => {
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    if (encoded === undefined) return value;
    return encoded.length > limit ? `${encoded.slice(0, limit - 1)}…` : value;
  };
  const changed = Object.entries(activity.updatedFrom ?? {})
    .slice(0, 12)
    .map(([field, before]) => ({
      field: compact(field, 64),
      before: compact(before, 100),
      after: compact(activity.data[field], 100),
    }));
  const event = {
    headline: linearActivityHeadline(activity),
    issueId: activity.issueId ?? linearActivityIssueId(activity),
    identifier: compact(issue.identifier),
    title: compact(
      issue.title ?? (activity.issueId ? "Title unavailable" : linearSubject(activity.type, activity.data)),
    ),
    resource: activity.type,
    action: activity.action,
    ...(changed.length ? { changed } : {}),
    ...(activity.type === "Comment" ? { comment: compact(activity.data.body, 600) } : {}),
    actor: { id: activity.actorId, name: compact(activity.actorName), email: activity.actorEmail },
    link: compact(activity.url, 2048),
  };
  return ["Untrusted Linear event context:", `> ${JSON.stringify(event)}`].join("\n");
}
