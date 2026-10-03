import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CaptainChannelTurnResultSchema,
  DiscordPresenceWriteResultSchema,
  type DiscordPresenceWriteResult,
  type CaptainChannelTurnResult,
} from "@clankie/protocol";
import { z } from "zod";

const ReceiptSchema = z
  .object({
    fingerprint: z.string().min(1),
    lane: z.enum(["discord_text", "discord_voice"]),
    settled: CaptainChannelTurnResultSchema.optional(),
    bodyConversationId: z.string().optional(),
    writeResult: DiscordPresenceWriteResultSchema.optional(),
    origin: z
      .strictObject({
        presenceSessionId: z.string(),
        characterId: z.string(),
        credentialRef: z.string(),
        transportKind: z.enum(["bot", "user_session"]),
        guildId: z.string().optional(),
        channelId: z.string(),
        messageId: z.string(),
        actorId: z.string(),
      })
      .optional(),
  })
  .strict();
type Receipt = z.infer<typeof ReceiptSchema>;

/** Exact Discord delivery receipts, never a retry queue. Terminal IDs remain deduplicated. */
export class DiscordTurnReceipts {
  private readonly records = new Map<string, Receipt>();
  private readonly path: string | undefined;
  private unreadable = false;

  public constructor(path?: string) {
    this.path = path;
    if (path === undefined) return;
    try {
      const records = z.record(z.string(), ReceiptSchema).parse(JSON.parse(readFileSync(path, "utf8")));
      for (const [id, receipt] of Object.entries(records)) this.records.set(id, receipt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = true;
    }
  }

  public get(id: string): Receipt | undefined {
    if (this.unreadable) throw new Error("Discord delivery receipts unavailable");
    return this.records.get(id);
  }

  public begin(id: string, receipt: Receipt): void {
    if (this.get(id) !== undefined) throw new Error("Discord delivery already recorded");
    this.records.set(id, ReceiptSchema.parse(receipt));
    this.save(); // No dispatch unless this durable write succeeds.
  }

  public settle(id: string, fingerprint: string, result: CaptainChannelTurnResult): void {
    const receipt = this.get(id);
    if (receipt === undefined || receipt.fingerprint !== fingerprint)
      throw new Error("Discord receipt mismatch");
    this.records.set(id, { ...receipt, settled: CaptainChannelTurnResultSchema.parse(result) });
    this.save();
  }

  public settleWrite(id: string, fingerprint: string, result: DiscordPresenceWriteResult): void {
    const receipt = this.get(id);
    if (
      receipt === undefined ||
      receipt.fingerprint !== fingerprint ||
      receipt.bodyConversationId === undefined
    )
      throw new Error("Discord write receipt mismatch");
    this.records.set(id, { ...receipt, writeResult: DiscordPresenceWriteResultSchema.parse(result) });
    this.save();
  }

  public writesSettled(conversationId: string): boolean {
    if (this.unreadable) return false;
    return [...this.records.values()].every(
      (receipt) => receipt.bodyConversationId !== conversationId || receipt.writeResult !== undefined,
    );
  }

  private save(): void {
    if (this.path === undefined) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      const file = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(file, `${JSON.stringify(Object.fromEntries(this.records))}\n`);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, this.path);
      const directory = openSync(dirname(this.path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      this.unreadable = true;
      throw error;
    }
  }
}
