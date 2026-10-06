import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  linearActivityIssueId,
  linearActivityUpdateParent,
  LinearReplyRecipientSchema,
  type LinearActivityEvent,
  type LinearReplyRecipient,
} from "./linear-webhook.ts";
import type { McpHost } from "./mcp-host.ts";

const EntrySchema = z.object({
  eventId: z.string(),
  organizationId: z.string(),
  resource: z.string(),
  issueId: z.string().uuid().optional(),
  issueIdentifier: z.string().max(256).optional(),
  issueTitle: z.string().max(2048).optional(),
  parent: LinearReplyRecipientSchema.pick({ parentType: true, parentId: true }).optional(),
  replyRecipient: LinearReplyRecipientSchema.optional(),
  comment: z.string().optional(),
  type: z.string(),
  action: z.string(),
  changed: z.array(z.string()),
  at: z.number(),
  actor: z
    .object({
      id: z.string(),
      type: z.string().optional(),
      name: z.string().optional(),
      email: z.string().optional(),
      worker: z.object({ grantId: z.string(), principalId: z.string(), workId: z.string() }).optional(),
    })
    .optional(),
});
type Entry = z.infer<typeof EntrySchema>;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2_000;
const STATUS_REPLY_NOTIFICATIONS = [
  "projectUpdateNewComment",
  "projectUpdateCommentMention",
  "initiativeUpdateNewComment",
  "initiativeUpdateCommentMention",
];

function subject(raw: string | undefined):
  | {
      resource: string;
      comment?: string;
      update?: { type: "ProjectUpdate" | "InitiativeUpdate"; id: string };
    }
  | undefined {
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (url.hostname !== "linear.app" || url.protocol !== "https:") return;
    // Issue slugs may change; identifiers and comment anchors do not.
    const issue = /^(.*\/issue\/[^/]+)/u.exec(url.pathname)?.[1];
    const comment = /(?:^#|&)comment-([^&]+)/u.exec(url.hash)?.[1];
    const update = /(?:^#|&)(project|initiative)-update-([^&]+)/u.exec(url.hash);
    const path = /\/(?:project|initiative)\//u.test(url.pathname)
      ? url.pathname.replace(/\/(?:activity|updates)\/?$/u, "")
      : url.pathname;
    const resource = issue ?? path.replace(/\/$/u, "");
    return {
      resource,
      ...(comment ? { comment } : {}),
      ...(update
        ? {
            update: {
              type: update[1] === "project" ? ("ProjectUpdate" as const) : ("InitiativeUpdate" as const),
              id: update[2]!,
            },
          }
        : {}),
    };
  } catch {
    return;
  }
}

/** A bounded structured index of verified activity, independent of compact chat prose.
 * Only the verified webhook path records entries, including exact self echoes.
 */
export class LinearAttributionJournal {
  private entries: Entry[] = [];
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    try {
      this.entries = z
        .array(EntrySchema)
        .max(MAX_ENTRIES)
        .parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  record(activity: LinearActivityEvent, now = new Date()): void {
    const target = subject(activity.url);
    const at = Date.parse(activity.createdAt ?? "");
    if (
      activity.notification ||
      !activity.eventId ||
      !activity.organizationId ||
      !target ||
      !Number.isFinite(at)
    )
      return;
    const issueId = linearActivityIssueId(activity);
    const issue =
      activity.type === "Issue"
        ? activity.data
        : typeof activity.data.issue === "object" && activity.data.issue !== null
          ? (activity.data.issue as Record<string, unknown>)
          : {};
    const parent =
      linearActivityUpdateParent(activity) ??
      ((activity.type === "ProjectUpdate" || activity.type === "InitiativeUpdate") &&
      z.string().uuid().safeParse(activity.data.id).success
        ? { parentType: activity.type, parentId: (activity.data.id as string).toLowerCase() }
        : undefined);
    const replyRecipient = activity.replyRecipient;
    const provenRecipient =
      parent &&
      replyRecipient?.parentType === parent.parentType &&
      replyRecipient.parentId === parent.parentId &&
      z.string().uuid().safeParse(activity.data.id).success
        ? replyRecipient
        : undefined;
    const entry = EntrySchema.parse({
      eventId: activity.eventId,
      organizationId: activity.organizationId,
      ...target,
      ...(issueId === undefined ? {} : { issueId }),
      ...(typeof issue.identifier === "string" ? { issueIdentifier: issue.identifier.slice(0, 256) } : {}),
      ...(typeof issue.title === "string" ? { issueTitle: issue.title.slice(0, 2048) } : {}),
      ...(parent ? { parent } : {}),
      ...(provenRecipient ? { replyRecipient: provenRecipient } : {}),
      ...(activity.type === "Comment" && typeof activity.data.id === "string"
        ? { comment: activity.data.id }
        : {}),
      type: activity.type,
      action: activity.action,
      changed: Object.keys(activity.updatedFrom ?? {}),
      at,
      ...(activity.actorId
        ? {
            actor: {
              id: activity.actorId,
              type: activity.actorType,
              name: activity.actorName,
              email: activity.actorEmail,
              worker: activity.worker,
            },
          }
        : {}),
    });
    const entries = this.entries.filter(
      (item) => item.eventId !== entry.eventId && now.getTime() - item.at <= RETENTION_MS,
    );
    entries.push(entry);
    const retained = entries.slice(-MAX_ENTRIES);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path + ".tmp", JSON.stringify(retained), { mode: 0o600 });
    renameSync(this.path + ".tmp", this.path);
    this.entries = retained;
  }

  /** Issue titles retained from signed resource history; no model-supplied or provider-selected route. */
  context(activity: LinearActivityEvent): LinearActivityEvent["issueContext"] {
    const found = this.entries
      .filter(
        (entry) =>
          entry.organizationId === activity.organizationId &&
          entry.issueId === activity.issueId &&
          entry.issueTitle !== undefined,
      )
      .sort((a, b) => b.at - a.at)[0];
    return found?.issueId && found.issueTitle !== undefined
      ? {
          id: found.issueId,
          title: found.issueTitle,
          ...(found.issueIdentifier ? { identifier: found.issueIdentifier } : {}),
        }
      : undefined;
  }

  /** Sparse Comment deliveries carry issueId only. Read its title through the native verified connection. */
  async issueContext(
    activity: LinearActivityEvent,
    host: Pick<McpHost, "call">,
  ): Promise<LinearActivityEvent["issueContext"]> {
    const retained = this.context(activity);
    if (retained) return retained;
    if (!activity.issueId) return;
    const read = await host.call({
      lane: "operator",
      server: "linear",
      tool: "get_issue",
      requestPriority: "interactive",
      arguments: { id: activity.issueId },
      resultMode: "data",
      timeoutMs: 1_000,
    });
    if (read.outcome !== "ok" || read.isError) return;
    const parsed: unknown = JSON.parse(read.content);
    if (!parsed || typeof parsed !== "object") return;
    const issue = parsed as { id?: unknown; uuid?: unknown; identifier?: unknown; title?: unknown };
    const ids = [issue.id, issue.uuid].filter((id): id is string => z.string().uuid().safeParse(id).success);
    if (
      !ids.length ||
      ids.some((id) => id.toLowerCase() !== activity.issueId) ||
      typeof issue.title !== "string"
    )
      return;
    const identifier =
      typeof issue.identifier === "string"
        ? issue.identifier
        : typeof issue.id === "string" && !ids.includes(issue.id)
          ? issue.id
          : undefined;
    return {
      id: activity.issueId,
      title: issue.title.slice(0, 2048),
      ...(identifier ? { identifier: identifier.slice(0, 256) } : {}),
    };
  }

  /** Resolve an issue independently of actor timing, using only retained signed resource evidence. */
  issue(notification: { url?: string | undefined }, organizationId: string): string | undefined {
    const target = subject(notification.url);
    if (!target) return;
    const ids = this.entries.flatMap((entry) =>
      entry.organizationId === organizationId &&
      entry.resource === target.resource &&
      entry.issueId !== undefined
        ? [entry.issueId.toLowerCase()]
        : [],
    );
    return ids.length && ids.every((id) => id === ids[0]) ? ids[0] : undefined;
  }

  attribute(
    notification: { type: string; createdAt: string; url?: string | undefined },
    organizationId: string,
  ): Entry["actor"] {
    const candidates = this.candidates(notification, organizationId);
    const first = candidates[0]?.actor;
    // Never choose the nearest actor when simultaneous events disagree or lack identity.
    if (first && candidates.every((entry) => JSON.stringify(entry.actor) === JSON.stringify(first)))
      return first;
  }

  /** Notification fragments are aliases of exact signed comment/parent UUIDs, never ownership proof. */
  replyRecipient(
    notification: { type: string; createdAt: string; url?: string | undefined },
    organizationId: string,
  ): LinearReplyRecipient | undefined {
    if (!STATUS_REPLY_NOTIFICATIONS.includes(notification.type)) return;
    const candidates = this.candidates(notification, organizationId);
    const first = candidates[0]?.replyRecipient;
    if (first && candidates.every((entry) => JSON.stringify(entry.replyRecipient) === JSON.stringify(first)))
      return first;
  }

  private candidates(
    notification: { type: string; createdAt: string; url?: string | undefined },
    organizationId: string,
  ): Entry[] {
    const target = subject(notification.url);
    if (!target) return [];
    const at = Date.parse(notification.createdAt);
    const commentType = ["issueNewComment", "issueCommentMention", ...STATUS_REPLY_NOTIFICATIONS].includes(
      notification.type,
    );
    return this.entries.filter((entry) => {
      if (entry.organizationId !== organizationId || entry.resource !== target.resource) return false;
      // Use the action timestamp, never delivery time or notification updatedAt/readAt.
      if (entry.at > at + 1_000 || entry.at < at - 5_000) return false;
      if (target.comment && !aliasMatches(entry.comment, target.comment, target.update !== undefined))
        return false;
      if (
        target.update &&
        (entry.parent?.parentType !== target.update.type ||
          !aliasMatches(entry.parent.parentId, target.update.id, true))
      )
        return false;
      if (commentType && (entry.type !== "Comment" || entry.action !== "create")) return false;
      if (notification.type.startsWith("issue") && !commentType && entry.type !== "Issue") return false;
      if (notification.type === "issueStatusChanged" && !entry.changed.includes("stateId")) return false;
      if (
        notification.type === "issueAssignedToYou" &&
        entry.action !== "create" &&
        !entry.changed.includes("assigneeId")
      )
        return false;
      return true;
    });
  }
}

function aliasMatches(canonical: string | undefined, alias: string, abbreviated: boolean): boolean {
  if (!abbreviated) return canonical === alias;
  if (!canonical || !z.string().uuid().safeParse(canonical).success) return false;
  const normalized = alias.toLowerCase();
  return (
    (normalized.length === 8 &&
      /^[a-f0-9]{8}$/u.test(normalized) &&
      canonical.toLowerCase().startsWith(normalized)) ||
    canonical.toLowerCase() === normalized
  );
}
