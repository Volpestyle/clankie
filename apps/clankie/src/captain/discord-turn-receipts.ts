import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CaptainChannelTurnResultSchema, type CaptainChannelTurnResult } from "@clankie/protocol";
import { z } from "zod";

const ReceiptSchema = z
  .object({
    fingerprint: z.string().min(1),
    lane: z.enum(["discord_text", "discord_voice"]),
    settled: CaptainChannelTurnResultSchema.optional(),
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

  private save(): void {
    if (this.path === undefined) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(this.records))}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      this.unreadable = true;
      throw error;
    }
  }
}
