import { chmodSync, mkdirSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type DiscordTextIngress, type DiscordTextIngressPort } from "@clankie/discord-presence-core";
import type { Message, TextBasedChannel } from "discord.js";
import {
  CaptainChannelTurnResultSchema,
  DiscordPresenceChannelTurnRequestSchema,
  DiscordPresenceWriteResultSchema,
  type DiscordCaptainActionResult,
} from "@clankie/protocol";

interface Delivery {
  id: string;
  channel_id: string;
  guild_id: string | null;
  request: string | null;
  result: string | null;
  reply: string | null;
  outgoing: string | null;
  done: number;
  retries: number;
  /** Permanent service refusals of this delivery's reply or reply reconciliation. */
  refusals: number;
  /** Why recovery stopped for good, never answered and never acknowledged. */
  terminal: string | null;
}

/** Permanent refusals a delivery may meet before recovery stops retrying it. */
const RECOVERY_REFUSALS_MAX = 3;
/** A transiently failed delivery waits from one round, doubling, up to this cap. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

/** A completed model turn is not a delivered reply. Attention metadata survives restarts too. */
export class DiscordTextInbox {
  private readonly db: DatabaseSync;
  private readonly running = new Set<string>();
  /** Per-process, so a restarted bridge retries everything once at once. */
  private readonly backoff = new Map<string, { attempts: number; at: number }>();

  constructor(path: string, initialAfter: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, after_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_activity (id TEXT PRIMARY KEY, since_reply INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, guild_id TEXT,
        request TEXT, result TEXT, reply TEXT, done INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS progress_updates (
        delivery_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS deliveries_request_id
        ON deliveries(json_extract(request, '$.deliveryId'));
    `);
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(deliveries)")
        .all()
        .map((column) => column.name),
    );
    for (const [name, definition] of [
      ["outgoing", "TEXT"],
      ["retries", "INTEGER NOT NULL DEFAULT 0"],
      ["acknowledged", "INTEGER NOT NULL DEFAULT 0"],
      ["refusals", "INTEGER NOT NULL DEFAULT 0"],
      ["terminal", "TEXT"],
    ])
      if (!columns.has(name)) this.db.exec(`ALTER TABLE deliveries ADD COLUMN ${name} ${definition}`);
    // Repair legacy failures closed before the failure notice was confirmed.
    // A terminal failure was closed on purpose and stays closed.
    this.db.exec(
      "UPDATE deliveries SET done = 0 WHERE json_extract(result, '$.state') = 'failed' AND reply IS NULL AND acknowledged = 0 AND terminal IS NULL",
    );
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('initial_after', ?)").run(initialAfter);
    // If the combined answer was never saved, replay its absorbed messages
    // independently. A newly generated answer to the first message may not
    // include the question that had been steered into the lost run.
    for (const row of this.pending()) {
      if (row.result === null) continue;
      const result = CaptainChannelTurnResultSchema.parse(JSON.parse(row.result));
      if (result.state !== "absorbed" || result.replyDeliveryId === undefined) continue;
      if (this.row(result.replyDeliveryId)?.result == null || this.ownerFailed(result.replyDeliveryId)) {
        const { replyDeliveryId: _owner, ...independent } = result;
        this.db
          .prepare("UPDATE deliveries SET result = ? WHERE id = ?")
          .run(JSON.stringify(independent), row.id);
      }
    }
  }

  async seedReceipts(path: string): Promise<void> {
    if (this.db.prepare("SELECT value FROM metadata WHERE key = 'seeded_v3'").get() !== undefined) return;
    try {
      for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        const receipt = JSON.parse(line);
        const { deliveryId, channelId, guildId, outcome } = receipt.data ?? {};
        if (
          receipt.type !== "discord.text.ingress" ||
          typeof deliveryId !== "string" ||
          typeof channelId !== "string"
        )
          continue;
        const initialAfter = String(
          this.db.prepare("SELECT value FROM metadata WHERE key = 'initial_after'").get()!.value,
        );
        if (BigInt(deliveryId) <= BigInt(initialAfter)) continue;
        if (outcome === "accepted")
          this.db
            .prepare("INSERT OR IGNORE INTO deliveries (id, channel_id, guild_id) VALUES (?, ?, ?)")
            .run(deliveryId, channelId, guildId ?? null);
        if (["settled", "declined"].includes(outcome)) this.finish(deliveryId);
        if (outcome === "abandoned")
          this.abandon(
            deliveryId,
            typeof receipt.data.reason === "string" ? receipt.data.reason : "abandoned",
          );
        // Legacy absorbed receipts have no owning-delivery link. Reconsider
        // the message independently after a restart rather than lose it.
        if (outcome === "absorbed")
          this.db
            .prepare("UPDATE deliveries SET done = 0, result = ? WHERE id = ? AND request IS NULL")
            .run(
              JSON.stringify({ state: "absorbed", captainSessionId: "legacy", turnId: "legacy" }),
              deliveryId,
            );
        if (outcome === "failed")
          this.db
            .prepare(
              "UPDATE deliveries SET done = 0, result = ?, retries = 1 WHERE id = ? AND (request IS NULL OR json_type(request, '$.trigger') IS NULL) AND reply IS NULL AND acknowledged = 0 AND terminal IS NULL",
            )
            .run(JSON.stringify({ state: "failed", code: "discord_saved_request_missing" }), deliveryId);
        // Keep accepted failures pending: a returned failure is not a delivered notice.
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.db.prepare("INSERT INTO metadata VALUES ('seeded_v3', '1')").run();
  }

  readonly channelActivity = {
    load: (): { channelId: string; sinceReply: number }[] =>
      this.db
        .prepare("SELECT id, since_reply FROM channel_activity ORDER BY rowid")
        .all()
        .map((row) => ({
          channelId: String(row.id),
          sinceReply: Number(row.since_reply),
        })),
    save: (channels: readonly { channelId: string; sinceReply: number }[]): void => {
      this.db.exec("BEGIN");
      try {
        this.db.exec("DELETE FROM channel_activity");
        const insert = this.db.prepare("INSERT INTO channel_activity VALUES (?, ?)");
        for (const channel of channels) insert.run(channel.channelId, channel.sinceReply);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    },
  };

  after(channelId: string): string {
    const row = this.db.prepare("SELECT after_id FROM channels WHERE id = ?").get(channelId);
    return row === undefined
      ? String(this.db.prepare("SELECT value FROM metadata WHERE key = 'initial_after'").get()!.value)
      : String(row.after_id);
  }

  scanned(channelId: string, after: string): void {
    this.db
      .prepare(
        `INSERT INTO channels VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET after_id = excluded.after_id`,
      )
      .run(channelId, after);
    // Completed deliveries below the scan cursor are now protected by that cursor.
    this.db
      .prepare(
        "DELETE FROM deliveries WHERE channel_id = ? AND done = 1 AND length(id) = length(?) AND id < ? AND id < ? AND NOT EXISTS (SELECT 1 FROM deliveries AS child WHERE child.done = 0 AND json_extract(child.result, '$.replyDeliveryId') = deliveries.id)",
      )
      .run(channelId, after, after, discordSnowflakeAt(Date.now() - 7 * 24 * 60 * 60_000));
    this.db
      .prepare("DELETE FROM progress_updates WHERE channel_id = ? AND delivery_id < ? AND delivery_id < ?")
      .run(channelId, after, discordSnowflakeAt(Date.now() - 7 * 24 * 60 * 60_000));
  }

  channels(): readonly string[] {
    return this.db
      .prepare("SELECT id FROM channels UNION SELECT channel_id AS id FROM deliveries")
      .all()
      .map((row) => String(row.id));
  }

  needsAttentionSeed(channelId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM metadata WHERE key = ?").get(`attention_seed:${channelId}`) === undefined
    );
  }

  attentionSeeded(channelId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES (?, '1')").run(`attention_seed:${channelId}`);
  }

  enqueue(id: string, channelId: string, guildId?: string): void {
    if (BigInt(id) <= BigInt(this.after(channelId))) return;
    this.db
      .prepare("INSERT OR IGNORE INTO deliveries (id, channel_id, guild_id) VALUES (?, ?, ?)")
      .run(id, channelId, guildId ?? null);
  }

  /** At most one optional progress post per Discord message, even if its turn is retried. */
  async postProgressOnce(
    deliveryId: string,
    channelId: string,
    post: () => Promise<DiscordCaptainActionResult>,
  ): Promise<DiscordCaptainActionResult> {
    const claimed = this.db
      .prepare("INSERT OR IGNORE INTO progress_updates (delivery_id, channel_id) VALUES (?, ?)")
      .run(deliveryId, channelId).changes;
    if (claimed === 0) {
      const saved = this.db
        .prepare("SELECT message_id FROM progress_updates WHERE delivery_id = ? AND channel_id = ?")
        .get(deliveryId, channelId);
      if (saved === undefined) return { ok: false, message: "Progress update belongs to another channel." };
      return {
        ok: true,
        message: "A progress update was already attempted for this message; keep working.",
        ...(saved.message_id === null ? {} : { messageId: String(saved.message_id) }),
      };
    }
    // Reserve before writing to Discord. If the write outcome is uncertain, a
    // retry may omit an optional update, but cannot post it twice.
    const result = await post();
    if (result.messageId !== undefined)
      this.db
        .prepare("UPDATE progress_updates SET message_id = ? WHERE delivery_id = ?")
        .run(result.messageId, deliveryId);
    return result;
  }

  finish(id: string): void {
    this.db
      .prepare(
        "UPDATE deliveries SET done = 1, acknowledged = 1 WHERE id = ? OR json_extract(result, '$.replyDeliveryId') IN (?, (SELECT json_extract(request, '$.deliveryId') FROM deliveries WHERE id = ?))",
      )
      .run(id, id, id);
  }

  reconcile(
    id: string,
    content: string,
  ): ReturnType<typeof DiscordPresenceChannelTurnRequestSchema.parse> | undefined {
    const row = this.row(id);
    const outgoing = row?.outgoing;
    const write = outgoing == null ? undefined : JSON.parse(outgoing);
    const expected = write?.payload.content;
    if (
      (write === undefined && content.trim()) ||
      content === expected ||
      (write?.payload.kind === "reply_with_media" && content.startsWith(`${expected}\n\n`))
    ) {
      this.finish(id);
      if (row?.request != null) return DiscordPresenceChannelTurnRequestSchema.parse(JSON.parse(row.request));
    }
    return undefined;
  }

  pending(): readonly Delivery[] {
    return (
      this.db.prepare("SELECT * FROM deliveries WHERE done = 0 ORDER BY id").all() as unknown as Delivery[]
    ).filter((row) => !this.running.has(row.id));
  }

  /** Pending deliveries whose retry backoff has elapsed. */
  due(now = Date.now()): readonly Delivery[] {
    const pending = this.pending();
    const ids = new Set(pending.map((row) => row.id));
    for (const id of this.backoff.keys()) if (!ids.has(id) && !this.running.has(id)) this.backoff.delete(id);
    return pending.filter((row) => (this.backoff.get(row.id)?.at ?? 0) <= now);
  }

  /** A failed attempt that may still succeed: back off, never give up. */
  retryLater(id: string, now = Date.now()): void {
    const row = this.row(id);
    if (row === undefined || row.done === 1) return;
    const attempts = (this.backoff.get(row.id)?.attempts ?? 0) + 1;
    this.backoff.set(row.id, {
      attempts,
      at: now + Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS),
    });
  }

  async handle(id: string, run: () => Promise<void>): Promise<void> {
    const row = this.row(id);
    if (this.running.has(id) || row === undefined || row.done === 1) return;
    this.running.add(id);
    try {
      await run();
    } finally {
      this.running.delete(id);
    }
  }

  /** Replay the exact accepted request, so a surviving captain joins its original run. */
  port(delegate: DiscordTextIngressPort): DiscordTextIngressPort {
    return {
      getHealth: () => delegate.getHealth(),
      deferFailureNotice: (id) => this.row(id)?.reply == null && (this.row(id)?.retries ?? 0) === 0,
      abandoned: (id) => this.row(id)?.terminal ?? undefined,

      submitDiscordCaptainChannelTurn: async (incoming) => {
        this.enqueue(incoming.deliveryId, incoming.trigger.channelId, incoming.trigger.guildId);
        const row = this.row(incoming.deliveryId)!;
        const parsedOriginal =
          row.request === null
            ? undefined
            : DiscordPresenceChannelTurnRequestSchema.safeParse(JSON.parse(row.request));
        const original = parsedOriginal?.success ? parsedOriginal.data : incoming;
        const saved =
          row.result === null ? undefined : CaptainChannelTurnResultSchema.parse(JSON.parse(row.result));
        // A legacy accepted failure with no saved request cannot safely rerun
        // tools from today's edited message. It still owes its original room
        // a notice, using the same reconciled reply key as every other failure.
        if (parsedOriginal?.success !== true && saved?.state === "failed") {
          const missing = { state: "failed" as const, code: "discord_saved_request_missing" };
          // Retain the observed address for history-confirmed reply evidence.
          // The exhausted failure remains durable: this is never a model retry.
          this.db
            .prepare("UPDATE deliveries SET request = ?, result = ?, retries = 1 WHERE id = ?")
            .run(JSON.stringify(incoming), JSON.stringify(missing), incoming.deliveryId);
          return missing;
        }
        if (saved !== undefined && saved.state !== "absorbed" && saved.state !== "failed") return saved;
        if (saved?.state === "failed" && row.retries > 0) return saved;
        if (saved?.state === "failed") {
          // Reachable service and reconciled Discord history precede a durable,
          // single recovery claim. Unknown writes stay pending, never duplicated.
          await delegate.getHealth();
          {
            if (delegate.reconcileDiscordPresenceAction === undefined)
              throw new Error("discord_reply_reconciliation_unavailable");
            const reconcileReply = delegate.reconcileDiscordPresenceAction;
            const reply = await this.refusable(incoming.deliveryId, () =>
              reconcileReply(
                row.outgoing === null
                  ? {
                      schemaVersion: 1,
                      idempotencyKey: `${incoming.deliveryId}:reply`,
                      sourceDeliveryId: incoming.deliveryId,
                      action: "discord.presence.reply",
                      identity: incoming.identity,
                      content: "Reply reconciliation",
                      payload: {
                        kind: "reply",
                        channelId: incoming.trigger.channelId,
                        messageId: incoming.deliveryId,
                        content: "Reply reconciliation",
                      },
                    }
                  : JSON.parse(row.outgoing),
              ),
            );
            if (reply !== null) {
              this.db
                .prepare("UPDATE deliveries SET reply = ?, done = 1 WHERE id = ?")
                .run(JSON.stringify(reply), incoming.deliveryId);
              this.finish(incoming.deliveryId);
              return saved;
            }
          }
          this.db
            .prepare(
              "UPDATE deliveries SET request = ?, retries = 1, result = NULL, outgoing = NULL WHERE id = ?",
            )
            .run(
              JSON.stringify({ ...original, deliveryId: `${incoming.deliveryId}:recovery` }),
              incoming.deliveryId,
            );
        }
        if (
          saved?.state === "absorbed" &&
          saved.replyDeliveryId !== undefined &&
          !this.ownerFailed(saved.replyDeliveryId)
        ) {
          const owner = this.row(saved.replyDeliveryId);
          if (owner?.done === 1) {
            this.finish(incoming.deliveryId);
            return saved;
          }
          // A saved combined answer will acknowledge this message when posted.
          if (owner?.result != null) return saved;
        }
        const request =
          saved?.state === "absorbed" || saved?.state === "failed"
            ? { ...original, deliveryId: `${incoming.deliveryId}:recovery` }
            : original;
        this.db
          .prepare("UPDATE deliveries SET request = ? WHERE id = ?")
          .run(JSON.stringify(request), incoming.deliveryId);
        const result = await delegate.submitDiscordCaptainChannelTurn(request);
        const retained =
          result.state === "absorbed" &&
          result.replyDeliveryId !== undefined &&
          this.ownerFailed(result.replyDeliveryId)
            ? (() => {
                const { replyDeliveryId: _owner, ...independent } = result;
                return independent;
              })()
            : result;
        this.db
          .prepare("UPDATE deliveries SET result = ? WHERE id = ?")
          .run(JSON.stringify(retained), incoming.deliveryId);
        if (result.state === "failed") {
          // Its retry may answer only the saved original request, not messages
          // steered into the lost run. Those children need independent recovery.
          this.db
            .prepare(
              "UPDATE deliveries SET result = json_remove(result, '$.replyDeliveryId'), done = 0, acknowledged = 0 WHERE json_extract(result, '$.state') = 'absorbed' AND json_extract(result, '$.replyDeliveryId') IN (?, ?)",
            )
            .run(incoming.deliveryId, request.deliveryId);
        }
        if (
          result.state === "absorbed" &&
          result.replyDeliveryId !== undefined &&
          !this.ownerFailed(result.replyDeliveryId) &&
          this.row(result.replyDeliveryId)?.done === 1
        )
          this.finish(incoming.deliveryId);
        return result;
      },
      executeDiscordPresenceAction: async (write) => {
        if (
          (write.payload.kind !== "reply" && write.payload.kind !== "reply_with_media") ||
          write.payload.messageId === undefined
        )
          return delegate.executeDiscordPresenceAction(write);
        const id = write.payload.messageId;
        const row = this.row(id);
        const saved = row?.reply;
        if (saved != null) return DiscordPresenceWriteResultSchema.parse(JSON.parse(saved));
        if (row?.outgoing != null) {
          if (delegate.reconcileDiscordPresenceAction === undefined)
            throw new Error("discord_reply_reconciliation_unavailable");
          const reconcileReply = delegate.reconcileDiscordPresenceAction;
          const outgoing = row.outgoing;
          const confirmed = await this.refusable(id, () => reconcileReply(JSON.parse(outgoing)));
          if (confirmed !== null) {
            this.db
              .prepare("UPDATE deliveries SET reply = ?, done = 1 WHERE id = ?")
              .run(JSON.stringify(confirmed), id);
            this.finish(id);
            return confirmed;
          }
        }
        this.db.prepare("UPDATE deliveries SET outgoing = ? WHERE id = ?").run(JSON.stringify(write), id);
        const reply = await this.refusable(id, () => delegate.executeDiscordPresenceAction(write));
        if (reply.messageId !== undefined)
          this.db
            .prepare("UPDATE deliveries SET reply = ?, done = 1 WHERE id = ?")
            .run(JSON.stringify(reply), id);
        if (reply.messageId !== undefined) this.finish(id);
        return reply;
      },
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * The service refuses a reply or its reconciliation before touching Discord
   * when it holds no matching origin for the message. That never changes on
   * retry, so a bounded number of refusals closes the delivery unanswered.
   */
  private async refusable<T>(id: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const code = permanentRefusal(error);
      const row = this.row(id);
      if (code !== undefined && row !== undefined) {
        this.db.prepare("UPDATE deliveries SET refusals = refusals + 1 WHERE id = ?").run(row.id);
        if (row.refusals + 1 >= RECOVERY_REFUSALS_MAX) this.abandon(row.id, code);
      }
      throw error;
    }
  }

  /** Closed without a reply or notice, and never acknowledged: health still counts it. */
  private abandon(id: string, code: string): void {
    this.db
      .prepare(
        "UPDATE deliveries SET done = 1, terminal = ? WHERE done = 0 AND (id = ? OR json_extract(result, '$.replyDeliveryId') IN (?, (SELECT json_extract(request, '$.deliveryId') FROM deliveries WHERE id = ?)))",
      )
      .run(code, id, id, id);
  }

  /** The run a message was folded into settled as failed, so it answered nothing. */
  private ownerFailed(id: string): boolean {
    const result = this.row(id)?.result;
    return result != null && CaptainChannelTurnResultSchema.parse(JSON.parse(result)).state === "failed";
  }

  private row(id: string): Delivery | undefined {
    return this.db
      .prepare("SELECT * FROM deliveries WHERE id = ? OR json_extract(request, '$.deliveryId') = ?")
      .get(id, id) as unknown as Delivery | undefined;
  }
}

/**
 * Origin refusals from `/v1/discord/presence-actions`: the write was rejected
 * before dispatch (`identity_required`) or its reconciliation before any read.
 */
function permanentRefusal(error: unknown): string | undefined {
  const match = /^Clankie API (403|409): (.*)$/su.exec(error instanceof Error ? error.message : "");
  if (match === null) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(match[2]!);
  } catch {
    return undefined;
  }
  if (body === null || typeof body !== "object") return undefined;
  const { error: code, outcome, reason } = body as Record<string, unknown>;
  if (match[1] === "403" && code === "discord_reply_reconciliation_origin_required") return code;
  if (match[1] === "409" && outcome === "rejected" && reason === "identity_required")
    return "discord_reply_identity_required";
  return undefined;
}

export function discordSnowflakeAt(milliseconds: number): string {
  return ((BigInt(milliseconds) - 1420070400000n) << 22n).toString();
}

/** Reconcile posted replies before returning pending work to the captain. */
export async function scanDiscordTextChannel(
  inbox: DiscordTextInbox,
  channel: TextBasedChannel,
  botId: string,
  ingress: DiscordTextIngress,
): Promise<void> {
  let after = inbox.after(channel.id);
  // Upgrade/first discovery: a reply just before the cursor still makes this
  // an active room. Bound the bootstrap to one prior page; later scans persist it.
  if (
    !channel.isDMBased() &&
    !ingress.hasSpokenInChannel(channel.id) &&
    inbox.needsAttentionSeed(channel.id)
  ) {
    const prior = await channel.messages.fetch({ before: (BigInt(after) + 1n).toString(), limit: 100 });
    if ([...prior.values()].some((message) => message.author.id === botId))
      ingress.observeChannelReply(channel.id);
    inbox.attentionSeeded(channel.id);
  }
  for (;;) {
    const page = await channel.messages.fetch({ after, limit: 100 });
    const ordered = [...page.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const message of ordered) {
      if (message.author.id === botId) {
        // Re-reading an already delivered reply must not reset today's live
        // attention counter or clear messages that arrived while scanning.
        if (!ingress.hasSpokenInChannel(channel.id)) ingress.observeChannelReply(channel.id);
        if (message.reference?.messageId) {
          const confirmed = inbox.reconcile(message.reference.messageId, message.content);
          if (confirmed !== undefined) ingress.confirmRecoveredReply(confirmed);
        }
      }
      if (message.author.bot || message.author.id === botId) continue;
      const mentionsBot = await mentionsDiscordBot(message, botId);
      if (
        ingress.admissionRefusal({
          id: message.id,
          channelId: channel.id,
          ...(message.guildId == null ? {} : { guildId: message.guildId }),
          authorId: message.author.id,
          authorIsBot: false,
          mentionsBot,
          body: message.content,
        }) === undefined
      )
        inbox.enqueue(message.id, channel.id, message.guildId ?? undefined);
    }
    const last = ordered.at(-1);
    if (last === undefined) break;
    after = last.id;
    inbox.scanned(channel.id, after);
    if (page.size < 100) break;
  }
}

/** Replies with mention_author disabled still address their referenced author. */
export async function mentionsDiscordBot(message: Message, botId: string): Promise<boolean> {
  if (message.mentions.users.has(botId) || message.mentions.repliedUser?.id === botId) return true;
  if (!message.reference?.messageId) return false;
  const referenced = await message.fetchReference().catch((error: unknown) => {
    // A deleted reference is not addressing evidence. Transient failures must
    // leave the scan cursor in place so the message is reconsidered.
    if ((error as { code?: number }).code === 10008) return undefined;
    throw error;
  });
  return referenced?.author.id === botId;
}
