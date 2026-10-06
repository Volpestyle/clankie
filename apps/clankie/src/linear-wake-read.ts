import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { LinearAttributionJournal } from "./linear-attribution.ts";
import type { McpHost } from "./mcp-host.ts";

const ReceiverSchema = z.object({ userId: z.string().uuid(), workspaceId: z.string().uuid() });
const ReferenceSchema = z.object({
  eventId: z.string().min(1),
  receiver: ReceiverSchema,
  notificationTypes: z.array(z.string()),
  receivedAt: z.number(),
  retryUntil: z.number(),
});
export interface LinearWakeNotificationReference {
  readonly eventId: string;
  readonly receiver: z.infer<typeof ReceiverSchema>;
  readonly notificationTypes: readonly string[];
}
const ClaimSchema = z.object({
  eventId: z.string(),
  receiver: ReceiverSchema,
  state: z.enum(["uncertain", "read"]),
  at: z.number(),
});
const StateSchema = z.object({
  received: z.record(z.string(), ReferenceSchema),
  claims: z.record(z.string(), ClaimSchema),
});
const NotificationSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  createdAt: z.string(),
  url: z.string().optional(),
  readAt: z.string().nullable().optional(),
});
const PageSchema = z.object({
  notifications: z.array(NotificationSchema),
  hasNextPage: z.boolean(),
  cursor: z.string().nullable().optional(),
});
const RETENTION = 7 * 24 * 60 * 60 * 1_000;
const RETRY_WINDOW = 10 * 60 * 1_000;
const MAX = 4_096;

/** Only chat-confirmed, signed events are eligible. Uncertain read writes are retained, never replayed. */
export class LinearWakeReadReceipts {
  private state: z.infer<typeof StateSchema> = { received: {}, claims: {} };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private work: Promise<void> | undefined;
  private closed = false;
  private readAfter = 0;
  private readonly options: {
    path: string;
    attribution: Pick<LinearAttributionJournal, "notificationEvent">;
    host: Pick<McpHost, "call">;
    ownAccount(): Promise<{ userId: string; workspaceId: string } | undefined>;
    retryMs?: number;
  };

  constructor(options: {
    path: string;
    attribution: Pick<LinearAttributionJournal, "notificationEvent">;
    host: Pick<McpHost, "call">;
    ownAccount(): Promise<{ userId: string; workspaceId: string } | undefined>;
    retryMs?: number;
  }) {
    this.options = options;
    try {
      this.state = StateSchema.parse(JSON.parse(readFileSync(options.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.schedule();
  }

  async received(references: readonly LinearWakeNotificationReference[]) {
    const now = Date.now();
    // Expiring signed evidence can no longer justify a new provider mutation.
    this.state.received = Object.fromEntries(
      Object.entries(this.state.received).filter(([, item]) => item.receivedAt > now - RETENTION),
    );
    this.state.claims = Object.fromEntries(
      Object.entries(this.state.claims).filter(
        ([, claim]) => claim.state === "uncertain" || claim.at > now - RETENTION,
      ),
    );
    for (const reference of references) {
      if (!this.state.received[reference.eventId] && Object.keys(this.state.received).length >= MAX)
        throw new Error("Linear read receipt capacity reached; notifications remain unread");
      this.state.received[reference.eventId] = ReferenceSchema.parse({
        ...reference,
        receivedAt: this.state.received[reference.eventId]?.receivedAt ?? now,
        retryUntil: now + RETRY_WINDOW,
      });
    }
    this.save();
    await this.reconcile();
    this.schedule();
    return this.report(references.map((item) => item.eventId));
  }

  report(eventIds?: readonly string[]) {
    return {
      receipts: Object.values(this.state.received)
        .filter((item) => !eventIds || eventIds.includes(item.eventId))
        .map((item) => ({
          eventId: item.eventId,
          notifications: Object.entries(this.state.claims)
            .filter(([, claim]) => claim.eventId === item.eventId)
            .map(([id, claim]) => ({ id, state: claim.state })),
        })),
    };
  }

  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.work)
      this.work = this.scan().finally(() => {
        this.work = undefined;
      });
    return this.work;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private save() {
    mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.options.path + ".tmp", JSON.stringify(this.state), { mode: 0o600 });
    renameSync(this.options.path + ".tmp", this.options.path);
  }

  private schedule() {
    if (
      this.closed ||
      this.timer ||
      !Object.values(this.state.received).some((item) => item.retryUntil > Date.now())
    )
      return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.reconcile()
          .catch(() => undefined)
          .finally(() => this.schedule());
      },
      Math.max(this.options.retryMs ?? 30_000, this.readAfter - Date.now()),
    );
    this.timer.unref();
  }

  private async scan() {
    if (Date.now() < this.readAfter) return;
    if (!Object.keys(this.state.received).length) return;
    const own = await this.options.ownAccount().catch(() => undefined);
    if (!own) return;
    const eligible = Object.values(this.state.received).filter(
      (item) =>
        item.receiver.userId === own.userId &&
        item.receiver.workspaceId === own.workspaceId &&
        item.receivedAt > Date.now() - RETENTION,
    );
    if (!eligible.length) return;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 20 && !this.closed; page += 1) {
      const result = await this.options.host.call({
        lane: "operator",
        server: "linear",
        tool: "get_notifications",
        arguments: { limit: 250, unreadOnly: false, ...(cursor ? { cursor } : {}) },
        requestPriority: "background",
        resultMode: "data",
        timeoutMs: 10_000,
      });
      if (result.outcome !== "ok") {
        if (result.retryAt !== undefined) this.readAfter = Math.max(this.readAfter, result.retryAt);
        return;
      }
      if (result.isError) return;
      const parsed = PageSchema.safeParse(JSON.parse(result.content));
      if (!parsed.success) return;
      for (const notification of parsed.data.notifications) {
        const original = this.state.claims[notification.id];
        if (original) {
          if (
            original.receiver.userId === own.userId &&
            original.receiver.workspaceId === own.workspaceId &&
            notification.readAt
          ) {
            original.state = "read";
            this.save();
          }
          continue; // Includes uncertain originals: never repeat mark_notification.
        }
        if (notification.readAt) continue;
        const eventId = this.options.attribution.notificationEvent(notification, own.workspaceId);
        const received = eligible.find(
          (item) => item.eventId === eventId && item.notificationTypes.includes(notification.type),
        );
        if (!received) continue;
        // Fresh account proof and the host's dispatch fence prevent an account switch during a page read.
        const guard = async () => {
          const latest = await this.options.ownAccount();
          if (this.closed || latest?.userId !== own.userId || latest.workspaceId !== own.workspaceId)
            throw new Error("Linear wake notification receiver changed");
        };
        await guard();
        if (Object.keys(this.state.claims).length >= MAX) return;
        this.state.claims[notification.id] = {
          eventId: received.eventId,
          receiver: own,
          state: "uncertain",
          at: Date.now(),
        };
        this.save(); // Claim BEFORE dispatch, including the crash/lost-response window.
        await this.options.host
          .call({
            lane: "operator",
            server: "linear",
            tool: "mark_notification",
            arguments: { id: notification.id, read: true },
            resultMode: "data",
            timeoutMs: 10_000,
            fence: guard,
          })
          .catch(() => undefined);
        // A read-only inbox observation settles even a successful response; wrappers may contain errors.
      }
      if (!parsed.data.hasNextPage) return;
      if (!parsed.data.cursor || cursors.has(parsed.data.cursor)) return;
      cursor = parsed.data.cursor;
      cursors.add(cursor);
    }
  }
}
