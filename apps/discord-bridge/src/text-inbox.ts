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
}

/** A completed model turn is not a delivered reply. Attention metadata survives restarts too. */
export class DiscordTextInbox {
  private readonly db: DatabaseSync;
  private readonly running = new Set<string>();

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
      CREATE INDEX IF NOT EXISTS deliveries_request_id
        ON deliveries(json_extract(request, '$.deliveryId'));
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(deliveries)")
        .all()
        .some((column) => column.name === "outgoing")
    ) {
      this.db.exec("ALTER TABLE deliveries ADD COLUMN outgoing TEXT");
    }
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('initial_after', ?)").run(initialAfter);
    // If the combined answer was never saved, replay its absorbed messages
    // independently. A newly generated answer to the first message may not
    // include the question that had been steered into the lost run.
    for (const row of this.pending()) {
      if (row.result === null) continue;
      const result = CaptainChannelTurnResultSchema.parse(JSON.parse(row.result));
      if (result.state !== "absorbed" || result.replyDeliveryId === undefined) continue;
      if (this.row(result.replyDeliveryId)?.result == null) {
        const { replyDeliveryId: _owner, ...independent } = result;
        this.db
          .prepare("UPDATE deliveries SET result = ? WHERE id = ?")
          .run(JSON.stringify(independent), row.id);
      }
    }
  }

  async seedReceipts(path: string): Promise<void> {
    if (this.db.prepare("SELECT value FROM metadata WHERE key = 'seeded_v2'").get() !== undefined) return;
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
        // Legacy absorbed receipts have no owning-delivery link. Reconsider
        // the message independently after a restart rather than lose it.
        if (outcome === "absorbed")
          this.db
            .prepare("UPDATE deliveries SET done = 0, result = ? WHERE id = ? AND request IS NULL")
            .run(
              JSON.stringify({ state: "absorbed", captainSessionId: "legacy", turnId: "legacy" }),
              deliveryId,
            );
        // Old ambient failures are not an inbox. The history scan re-admits
        // directed messages; only interrupted deliveries migrate unconditionally.
        if (outcome === "failed")
          this.db.prepare("DELETE FROM deliveries WHERE id = ? AND done = 0").run(deliveryId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.db.prepare("INSERT INTO metadata VALUES ('seeded_v2', '1')").run();
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

  finish(id: string): void {
    this.db
      .prepare(
        "UPDATE deliveries SET done = 1 WHERE id = ? OR json_extract(result, '$.replyDeliveryId') IN (?, (SELECT json_extract(request, '$.deliveryId') FROM deliveries WHERE id = ?))",
      )
      .run(id, id, id);
  }

  reconcile(id: string, content: string): void {
    const outgoing = this.row(id)?.outgoing;
    if (outgoing == null) return;
    const write = JSON.parse(outgoing);
    const expected = write.payload.content;
    if (
      content === expected ||
      (write.payload.kind === "reply_with_media" && content.startsWith(`${expected}\n\n`))
    )
      this.finish(id);
  }

  pending(): readonly Delivery[] {
    return (
      this.db.prepare("SELECT * FROM deliveries WHERE done = 0 ORDER BY id").all() as unknown as Delivery[]
    ).filter((row) => !this.running.has(row.id));
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
      submitDiscordCaptainChannelTurn: async (incoming) => {
        this.enqueue(incoming.deliveryId, incoming.trigger.channelId, incoming.trigger.guildId);
        const row = this.row(incoming.deliveryId)!;
        const saved =
          row.result === null ? undefined : CaptainChannelTurnResultSchema.parse(JSON.parse(row.result));
        if (saved !== undefined && saved.state !== "absorbed") return saved;
        if (saved?.state === "absorbed" && saved.replyDeliveryId !== undefined) {
          const owner = this.row(saved.replyDeliveryId);
          if (owner?.done === 1) {
            this.finish(incoming.deliveryId);
            return saved;
          }
          // A saved combined answer will acknowledge this message when posted.
          if (owner?.result != null) return saved;
        }
        const original =
          row.request === null
            ? incoming
            : DiscordPresenceChannelTurnRequestSchema.parse(JSON.parse(row.request));
        const request =
          saved?.state === "absorbed"
            ? { ...original, deliveryId: `${incoming.deliveryId}:recovery` }
            : original;
        this.db
          .prepare("UPDATE deliveries SET request = ? WHERE id = ?")
          .run(JSON.stringify(request), incoming.deliveryId);
        const result = await delegate.submitDiscordCaptainChannelTurn(request);
        if (result.state !== "failed")
          this.db
            .prepare("UPDATE deliveries SET result = ? WHERE id = ?")
            .run(JSON.stringify(result), incoming.deliveryId);
        if (
          result.state === "absorbed" &&
          result.replyDeliveryId !== undefined &&
          this.row(result.replyDeliveryId)?.done === 1
        )
          this.finish(incoming.deliveryId);
        return result;
      },
      executeDiscordPresenceAction: async (write) => {
        if (write.payload.kind !== "reply" && write.payload.kind !== "reply_with_media")
          return delegate.executeDiscordPresenceAction(write);
        const id = write.payload.messageId;
        const saved = this.row(id)?.reply;
        if (saved != null) return DiscordPresenceWriteResultSchema.parse(JSON.parse(saved));
        this.db.prepare("UPDATE deliveries SET outgoing = ? WHERE id = ?").run(JSON.stringify(write), id);
        const reply = await delegate.executeDiscordPresenceAction(write);
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

  private row(id: string): Delivery | undefined {
    return this.db
      .prepare("SELECT * FROM deliveries WHERE id = ? OR json_extract(request, '$.deliveryId') = ?")
      .get(id, id) as unknown as Delivery | undefined;
  }
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
        if (message.reference?.messageId) inbox.reconcile(message.reference.messageId, message.content);
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
