import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  SEAT_CALL_META,
  SeatCallIdSchema,
  SeatCallToolSchema,
  seatCallMeta,
  uncertainSeatCall,
  type CaptainSessionLaneV2,
  type SeatCallTool,
} from "@clankie/protocol";
import { z } from "zod";

const RecordSchema = z.object({
  id: SeatCallIdSchema,
  tool: SeatCallToolSchema,
  lane: z.string(),
  conversationId: z.string(),
  fingerprint: z.string(),
  createdAt: z.number(),
  state: z.enum(["uncertain", "settled"]),
  result: CallToolResultSchema.optional(),
});
type ReceiptRecord = z.infer<typeof RecordSchema>;
const RecordsSchema = z.array(RecordSchema);
const SETTLED_BODY_LIMIT = 1_000;

/** Durable dispatch receipts, never a queue. Reading or repeating an ID cannot execute a tool. */
export class SeatCallReceipts {
  private records = new Map<string, ReceiptRecord>();
  private readonly path: string | undefined;
  public constructor(path?: string) {
    this.path = path;
  }

  private load(): void {
    if (this.path === undefined) return;
    try {
      const records = RecordsSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      this.records = new Map(records.map((record) => [record.id, record]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Operator seat-call receipts are unreadable; no action was dispatched", {
          cause: error,
        });
      this.records.clear();
    }
  }

  private save(): void {
    // Keep identity tombstones and every uncertain record; bound only settled result bodies.
    const settled = [...this.records.values()]
      .filter((record) => record.state === "settled" && record.result !== undefined)
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const record of settled.slice(SETTLED_BODY_LIMIT)) delete record.result;
    if (this.path === undefined) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify([...this.records.values()])}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private matches(record: ReceiptRecord, lane: CaptainSessionLaneV2, conversationId?: string): boolean {
    return record.lane === lane && record.conversationId === (conversationId ?? "global-default");
  }

  private result(record: ReceiptRecord): CallToolResult {
    if (record.result !== undefined)
      return {
        ...record.result,
        _meta: {
          ...record.result._meta,
          [SEAT_CALL_META]: seatCallMeta(record.id, record.tool, "settled"),
        },
      };
    return uncertainSeatCall(
      record.id,
      record.tool,
      record.state === "settled"
        ? "The original result body has expired. This ID is settled and cannot dispatch again; inspect native receipts."
        : "The original dispatch has no settled result. It may have happened; inspect this receipt and native history, never resend it.",
    );
  }

  public begin(
    id: string,
    tool: SeatCallTool,
    args: Record<string, unknown>,
    lane: CaptainSessionLaneV2,
    conversationId?: string,
  ): CallToolResult | undefined {
    this.load();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([tool, args]))
      .digest("hex");
    const previous = this.records.get(id);
    if (previous !== undefined) {
      if (!this.matches(previous, lane, conversationId) || previous.fingerprint !== fingerprint)
        throw new Error(
          "Seat-call ID does not match this conversation and original request; nothing dispatched",
        );
      return this.result(previous);
    }
    this.records.set(id, {
      id,
      tool,
      lane,
      conversationId: conversationId ?? "global-default",
      fingerprint,
      createdAt: Date.now(),
      state: "uncertain",
    });
    // This write must finish before entering the native hire/delivery path.
    this.save();
    return undefined;
  }

  public settle(id: string, result: CallToolResult): CallToolResult {
    this.load();
    const record = this.records.get(id);
    if (record === undefined) throw new Error("Missing original seat-call receipt");
    record.state = "settled";
    record.result = result;
    this.save();
    return this.result(record);
  }

  public read(
    id: string,
    tool: SeatCallTool,
    lane: CaptainSessionLaneV2,
    conversationId?: string,
  ): CallToolResult {
    this.load();
    const record = this.records.get(id);
    if (record === undefined || record.tool !== tool || !this.matches(record, lane, conversationId))
      return {
        content: [
          { type: "text", text: "No matching seat-call receipt in this conversation. Nothing dispatched." },
        ],
        isError: true,
      };
    return this.result(record);
  }
}
