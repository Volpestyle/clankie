import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { LinearActivityEvent } from "./linear-webhook.ts";

const EntrySchema = z.object({
  eventId: z.string(),
  organizationId: z.string(),
  resource: z.string(),
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

function subject(raw: string | undefined): { resource: string; comment?: string } | undefined {
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (url.hostname !== "linear.app" || url.protocol !== "https:") return;
    // Issue slugs may change; identifiers and comment anchors do not.
    const issue = /^(.*\/issue\/[^/]+)/u.exec(url.pathname)?.[1];
    const comment = /^#comment-(.+)$/u.exec(url.hash)?.[1];
    return { resource: issue ?? url.pathname.replace(/\/$/u, ""), ...(comment ? { comment } : {}) };
  } catch {
    return;
  }
}

/** A bounded structured index of the signed journal, independent of truncated inbox prose.
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
    const entry = EntrySchema.parse({
      eventId: activity.eventId,
      organizationId: activity.organizationId,
      ...target,
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

  attribute(
    notification: { type: string; createdAt: string; url?: string | undefined },
    organizationId: string,
  ): Entry["actor"] {
    const target = subject(notification.url);
    if (!target) return;
    const at = Date.parse(notification.createdAt);
    const commentType = ["issueNewComment", "issueCommentMention"].includes(notification.type);
    const candidates = this.entries.filter((entry) => {
      if (entry.organizationId !== organizationId || entry.resource !== target.resource) return false;
      // Use the action timestamp, never delivery time or notification updatedAt/readAt.
      if (entry.at > at + 1_000 || entry.at < at - 5_000) return false;
      if (target.comment && entry.comment !== target.comment) return false;
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
    const first = candidates[0]?.actor;
    // Never choose the nearest actor when simultaneous events disagree or lack identity.
    if (first && candidates.every((entry) => JSON.stringify(entry.actor) === JSON.stringify(first)))
      return first;
  }
}
