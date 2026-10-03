import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const ReceiptSchema = z
  .object({
    messageId: z.string().min(1),
    fingerprint: z.string(),
    sessionId: z.string().optional(),
    /** Original native occupant observed by the host, never inferred from pane/name. */
    occupantId: z.string().optional(),
    paneId: z.string().optional(),
    agentName: z.string().optional(),
    beforeIds: z.array(z.string()).optional(),
  })
  .strict();
export type UncertainReceipt = z.infer<typeof ReceiptSchema>;

/** Only unresolved receipts, not a delivery queue. Nothing here dispatches or retries. */
export class DeliveryFence {
  private readonly records = new Map<string, UncertainReceipt>();
  private unreadable = false;
  private readonly path: string | undefined;
  public constructor(path?: string) {
    this.path = path;
    if (path === undefined) return;
    try {
      const saved = z.record(z.string(), ReceiptSchema).parse(JSON.parse(readFileSync(path, "utf8")));
      for (const [key, receipt] of Object.entries(saved)) this.records.set(key, receipt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = true;
    }
  }

  public pending(key: string): UncertainReceipt | undefined {
    return this.unreadable ? { messageId: "unreadable-receipts", fingerprint: "" } : this.records.get(key);
  }

  public entries(): readonly (readonly [string, UncertainReceipt])[] {
    return this.unreadable
      ? [["unreadable-receipts", { messageId: "unreadable-receipts", fingerprint: "" }]]
      : [...this.records.entries()];
  }

  /** Persist before crossing the uncertain boundary. A persistence failure sends nothing. */
  public begin(
    key: string,
    receipt: Omit<UncertainReceipt, "messageId"> & { messageId?: string },
  ): UncertainReceipt {
    if (this.pending(key))
      throw new Error("Delivery is uncertain; reconcile its original receipt before any retry");
    const value = { ...receipt, messageId: receipt.messageId ?? randomUUID() };
    this.records.set(key, value);
    this.save();
    return value;
  }

  public update(key: string, messageId: string, fields: Partial<Omit<UncertainReceipt, "messageId">>): void {
    const previous = this.records.get(key);
    if (this.unreadable || previous?.messageId !== messageId)
      throw new Error("Missing original delivery receipt");
    this.records.set(key, { ...previous, ...fields });
    this.save();
  }

  /** Only the mechanism calls this after matching an acknowledgment or proving no dispatch. */
  public reconcile(key: string, messageId: string): boolean {
    if (this.unreadable || this.records.get(key)?.messageId !== messageId) return false;
    const previous = this.records.get(key)!;
    this.records.delete(key);
    try {
      this.save();
    } catch (error) {
      this.records.set(key, previous);
      throw error;
    }
    return true;
  }

  private save(): void {
    if (this.path === undefined) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(this.records))}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export function deliveryFingerprint(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n?/gu, "\n").trim()).digest("hex");
}
