import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { LinearActivityEvent } from "./linear-webhook.ts";
import type { McpHost } from "./mcp-host.ts";

const NotificationSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  title: z.string().optional(),
  url: z.string().optional(),
  actor: z.object({ id: z.string() }).nullish(),
});
const PageSchema = z.object({
  notifications: z.array(NotificationSchema),
  hasNextPage: z.boolean(),
  cursor: z.string().nullish(),
});
const CheckpointSchema = z.object({
  account: z.string(),
  since: z.string().datetime({ offset: true }),
  ids: z.array(z.string()).default([]),
});
interface LinearNotificationOptions {
  path: string;
  host: Pick<McpHost, "account" | "call">;
  following(): Promise<boolean>;
  receive(activity: LinearActivityEvent, following: boolean): unknown;
  onError(): void;
  now?: () => Date;
}

/** Read the connected account's inbox through its MCP audience, never an inherited connector
 * or an OAuth token sent to GraphQL. Notification identity, not readAt/updatedAt,
 * drives wakes. The webhook remains a separate passive activity journal.
 */
export class LinearNotifications {
  private checkpoint: z.infer<typeof CheckpointSchema> | undefined;
  private pending: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  private readonly options: LinearNotificationOptions;
  constructor(options: LinearNotificationOptions) {
    this.options = options;
    try {
      this.checkpoint = CheckpointSchema.parse(JSON.parse(readFileSync(options.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  start(): void {
    if (this.timer || this.closed) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 30_000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }

  poll(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.pending ??= this.read()
      .catch(() => this.options.onError())
      .finally(() => {
        this.pending = undefined;
      }));
  }

  private save(checkpoint: z.infer<typeof CheckpointSchema>): void {
    mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.options.path + ".tmp", JSON.stringify(checkpoint), { mode: 0o600 });
    renameSync(this.options.path + ".tmp", this.options.path);
    this.checkpoint = checkpoint;
  }

  private async read(): Promise<void> {
    const own = await this.options.host.account("linear", "operator").catch(() => undefined);
    if (!own) return;
    const account = `${own.account.workspaceId}:${own.account.userId}`;
    if (this.checkpoint?.account !== account) {
      // First connection / account switch starts now, without waking on old
      // notifications. Raw webhook history remains available for catch-up.
      this.save({ account, since: (this.options.now?.() ?? new Date()).toISOString(), ids: [] });
    }
    const { since, ids } = this.checkpoint!;
    const following = await this.options.following();
    const notifications: z.infer<typeof NotificationSchema>[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    // Linear get_notifications returns newest-created first. Include equality
    // so notifications sharing a timestamp cannot disappear at page boundaries.
    do {
      const result = await this.options.host.call({
        lane: "operator",
        server: "linear",
        tool: "get_notifications",
        arguments: { limit: 50, unreadOnly: false, ...(cursor ? { cursor } : {}) },
        resultMode: "data",
      });
      if (result.outcome !== "ok" || result.isError) throw new Error("Linear notifications unavailable");
      const page = PageSchema.parse(JSON.parse(result.content));
      notifications.push(
        ...page.notifications.filter((item) => Date.parse(item.createdAt) >= Date.parse(since)),
      );
      if (
        !page.hasNextPage ||
        page.notifications.some((item) => Date.parse(item.createdAt) < Date.parse(since))
      )
        break;
      if (!page.cursor || cursors.has(page.cursor)) throw new Error("Invalid Linear notification cursor");
      cursors.add(page.cursor);
      cursor = page.cursor;
    } while (cursor);
    // Credential rotation during pagination cannot relabel somebody else's inbox.
    if ((await this.options.host.account("linear", "operator")).binding !== own.binding) return;
    if (this.closed) return;
    const wake = following && (await this.options.following());
    for (const item of notifications.reverse()) {
      if (item.createdAt === since && ids.includes(item.id)) continue;
      this.options.receive(
        {
          eventId: createHash("sha256").update(`linear-notification:${account}:${item.id}`).digest("hex"),
          notification: true,
          deliveryId: undefined,
          type: "Notification",
          action: item.type,
          actorId: item.actor?.id,
          actorName: undefined,
          actorEmail: undefined,
          organizationId: own.account.workspaceId,
          createdAt: item.createdAt,
          url: item.url,
          updatedFrom: undefined,
          data: item,
        },
        wake && item.actor?.id !== own.account.userId,
      );
    }
    const newest = notifications.reduce(
      (latest, item) => (Date.parse(item.createdAt) > Date.parse(latest) ? item.createdAt : latest),
      since,
    );
    // Commit only after every inbox append succeeds. A crash replays stable IDs;
    // the conversation store owns durable dedup and cursor acknowledgment.
    this.save({
      account,
      since: newest,
      ids: [
        ...new Set([
          ...(newest === since ? ids : []),
          ...notifications.filter((item) => item.createdAt === newest).map((item) => item.id),
        ]),
      ],
    });
  }
}
