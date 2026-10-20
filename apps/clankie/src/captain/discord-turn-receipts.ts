import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CaptainChannelTurnResultSchema,
  DiscordPresenceWriteResultSchema,
  DiscordPresenceChannelTurnRequestSchema,
  type DiscordPresenceWriteResult,
  type CaptainChannelTurnResult,
  type DiscordRoomEvidence,
} from "@clankie/protocol";
import { z } from "zod";

const ReceiptSchema = z
  .object({
    fingerprint: z.string().min(1),
    requiredGuard: z.boolean().optional(),
    /** The service process that began the turn, so a successor can tell it is gone. */
    beganBy: z.strictObject({ instanceId: z.string().min(1), pid: z.number().int() }).optional(),
    lane: z.enum(["discord_text", "discord_voice"]),
    settled: CaptainChannelTurnResultSchema.optional(),
    /** Only the explicitly selected durable Pi prototype lane retains its input. */
    recoveryRequest: DiscordPresenceChannelTurnRequestSchema.optional(),
    bodyConversationId: z.string().optional(),
    writeResult: DiscordPresenceWriteResultSchema.optional(),
    writeAbsent: z.boolean().optional(),
    origin: z
      .strictObject({
        baseSessionKey: z.string().optional(),
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
  private readonly guards = new Map<string, () => Promise<void>>();
  private readonly instanceId = randomUUID();

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

  public recoverable(now: Date): Receipt[] {
    if (this.unreadable) throw new Error("Discord delivery receipts unavailable");
    return [...this.records.values()].filter(
      (receipt) => receipt.recoveryRequest !== undefined && this.abandoned(receipt, now),
    );
  }

  /** Repair the content-free room projection from durable service outcomes. */
  public roomEvidence(receiptId?: string): DiscordRoomEvidence[] {
    if (this.unreadable) return [];
    const evidence: DiscordRoomEvidence[] = [];
    const records = receiptId === undefined ? this.records : new Map([[receiptId, this.get(receiptId)]]);
    for (const [id, receipt] of records) {
      if (receipt === undefined) continue;
      const origin = receipt.origin;
      if (origin === undefined || receipt.lane !== "discord_text" || !/^\d+$/u.test(origin.messageId))
        continue;
      const result = receipt.settled;
      const outcome =
        id === `write:${origin.messageId}:reply` && receipt.writeResult?.messageId !== undefined
          ? "settled"
          : id.startsWith("write:")
            ? undefined
            : result?.state === "failed"
              ? "failed"
              : result?.state === "silent"
                ? "declined"
                : result?.state === "absorbed"
                  ? "absorbed"
                  : "accepted";
      if (outcome === undefined) continue;
      evidence.push({
        id: `${origin.messageId}:${outcome}`,
        deliveryId: origin.messageId,
        presenceSessionId: origin.presenceSessionId,
        transportKind: origin.transportKind,
        ...(origin.guildId === undefined ? {} : { guildId: origin.guildId }),
        channelId: origin.channelId,
        actorId: origin.actorId,
        outcome,
        ...(result?.state === "failed" ? { reason: result.code } : {}),
        ...(result?.state === "absorbed" && result.replyDeliveryId !== undefined
          ? { replyDeliveryId: result.replyDeliveryId.replace(/:recovery$/u, "") }
          : {}),
      });
    }
    return evidence;
  }

  public begin(id: string, receipt: Receipt): void {
    if (this.get(id) !== undefined && this.get(id)?.writeAbsent !== true)
      throw new Error("Discord delivery already recorded");
    this.records.set(
      id,
      ReceiptSchema.parse({ ...receipt, beganBy: { instanceId: this.instanceId, pid: process.pid } }),
    );
    this.save(); // No dispatch unless this durable write succeeds.
  }

  public settle(id: string, fingerprint: string, result: CaptainChannelTurnResult): void {
    const receipt = this.get(id);
    if (receipt === undefined || receipt.fingerprint !== fingerprint)
      throw new Error("Discord receipt mismatch");
    this.records.set(id, { ...receipt, settled: CaptainChannelTurnResultSchema.parse(result) });
    this.save();
  }

  /**
   * Whether an unsettled turn's run can no longer report: it was begun by another
   * service process that has exited. Receipts from before that was recorded use
   * the Discord message's own age instead. Unknown stays unknown.
   */
  public abandoned(receipt: Receipt, now: Date): boolean {
    if (receipt.settled !== undefined) return false;
    if (receipt.beganBy !== undefined)
      return receipt.beganBy.instanceId !== this.instanceId && !processAlive(receipt.beganBy.pid);
    const sentAt = receipt.origin === undefined ? undefined : snowflakeTime(receipt.origin.messageId);
    return sentAt !== undefined && now.getTime() - sentAt > LEGACY_ABANDONED_AFTER_MS;
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

  /** Only a completed local dispatch or an exited predecessor can be reconciled. */
  public writeRecoverable(receipt: Receipt): boolean {
    return (
      receipt.beganBy !== undefined &&
      (receipt.beganBy.instanceId === this.instanceId || !processAlive(receipt.beganBy.pid))
    );
  }

  public confirmWriteAbsent(id: string, fingerprint: string): void {
    const receipt = this.get(id);
    if (receipt?.fingerprint !== fingerprint || !this.writeRecoverable(receipt))
      throw new Error("Discord write receipt mismatch");
    this.records.set(id, { ...receipt, writeAbsent: true });
    this.save();
  }

  public requireGuard(key: string, fingerprint: string, guard: () => Promise<void>): void {
    const id = `guard:${key}`;
    const existing = this.get(id);
    if (existing !== undefined && existing.fingerprint !== fingerprint)
      throw new Error("Discord guard binding conflict");
    if (existing === undefined) this.begin(id, { fingerprint, lane: "discord_text", requiredGuard: true });
    this.guards.set(key, guard);
  }

  public async enforceGuard(key: string): Promise<void> {
    if (this.get(`guard:${key}`)?.requiredGuard !== true) return;
    const guard = this.guards.get(key);
    if (guard === undefined) throw new Error("Original Discord delivery authority unavailable");
    await guard();
  }

  public writesSettled(conversationId: string): boolean {
    if (this.unreadable) return false;
    return [...this.records.values()].every(
      (receipt) =>
        receipt.bodyConversationId !== conversationId ||
        receipt.writeResult !== undefined ||
        receipt.writeAbsent === true,
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

/** Longer than any room turn runs; only used for receipts that predate `beganBy`. */
const LEGACY_ABANDONED_AFTER_MS = 6 * 60 * 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function snowflakeTime(id: string): number | undefined {
  if (!/^[0-9]{15,20}$/u.test(id)) return undefined;
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}
