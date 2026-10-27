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
import { deliveryFingerprint } from "./captain/delivery-fence.ts";
import { DurableReceiptStore } from "./durable-receipt-store.ts";

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

/** Durable dispatch receipts, never a queue. Reading or repeating an ID cannot execute a tool. */
export class SeatCallReceipts {
  private readonly store: DurableReceiptStore<ReceiptRecord>;
  public constructor(path?: string) {
    this.store = new DurableReceiptStore({
      ...(path === undefined ? {} : { path }),
      schema: RecordSchema,
      unreadableMessage: "Operator seat-call receipts are unreadable; no action was dispatched",
    });
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
    const records = this.store.load();
    // JSON has no literal newlines or surrounding whitespace, preserving the original hash bytes.
    const fingerprint = deliveryFingerprint(JSON.stringify([tool, args]));
    const previous = records.get(id);
    if (previous !== undefined) {
      if (!this.matches(previous, lane, conversationId) || previous.fingerprint !== fingerprint)
        throw new Error(
          "Seat-call ID does not match this conversation and original request; nothing dispatched",
        );
      return this.result(previous);
    }
    records.set(id, {
      id,
      tool,
      lane,
      conversationId: conversationId ?? "global-default",
      fingerprint,
      createdAt: Date.now(),
      state: "uncertain",
    });
    // This write must finish before entering the native hire/delivery path.
    this.store.save();
    return undefined;
  }

  public settle(id: string, result: CallToolResult): CallToolResult {
    const record = this.store.load().get(id);
    if (record === undefined) throw new Error("Missing original seat-call receipt");
    record.state = "settled";
    record.result = result;
    this.store.save();
    return this.result(record);
  }

  public read(
    id: string,
    tool: SeatCallTool,
    lane: CaptainSessionLaneV2,
    conversationId?: string,
  ): CallToolResult {
    const record = this.store.read(id) ?? this.fence(id, tool, lane, conversationId);
    if (record.tool !== tool || !this.matches(record, lane, conversationId))
      return {
        content: [
          {
            type: "text",
            text: "This seat-call ID belongs to another conversation or tool. Nothing settled or dispatched here.",
          },
        ],
        isError: true,
      };
    return this.result(record);
  }

  /**
   * An ID with no receipt never began: begin() saves before any dispatch. Settle it as not
   * dispatched so a call still in flight (a timed-out or restart-lost request) is refused
   * when it arrives, which makes "safe to send again" true (VUH-2920).
   */
  private fence(
    id: string,
    tool: SeatCallTool,
    lane: CaptainSessionLaneV2,
    conversationId?: string,
  ): ReceiptRecord {
    const records = this.store.load();
    const existing = records.get(id);
    if (existing !== undefined) return existing;
    const record: ReceiptRecord = {
      id,
      tool,
      lane,
      conversationId: conversationId ?? "global-default",
      // No request hashes to this, so the original's begin() refuses its own ID.
      fingerprint: "reconciled-not-dispatched",
      createdAt: Date.now(),
      state: "settled",
      result: {
        content: [
          {
            type: "text",
            text: "Not dispatched: the service never received this call, and its ID is now closed, so a late arrival cannot run. Safe to send it again as a new call.",
          },
        ],
        isError: true,
      },
    };
    records.set(id, record);
    this.store.save();
    return record;
  }

  /** Inspection only; pending originals retain their IDs and are never redispatched. */
  public pending(conversationId: string): string[] {
    const uncertain = (body: unknown) =>
      typeof body === "object" &&
      body !== null &&
      (("outcome" in body && ["uncertain", "unconfirmed"].includes(String(body.outcome))) ||
        ("deliveryStage" in body && body.deliveryStage === "uncertain"));
    return [...this.store.load().values()]
      .filter(
        (record) =>
          record.conversationId === conversationId &&
          (record.state !== "settled" ||
            record.result === undefined ||
            uncertain(record.result.structuredContent) ||
            (record.result?._meta?.[SEAT_CALL_META] as { state?: string } | undefined)?.state ===
              "uncertain" ||
            record.result?.content.some((block) => {
              if (block.type !== "text") return false;
              try {
                return uncertain(JSON.parse(block.text));
              } catch {
                return false;
              }
            })),
      )
      .map((record) => record.id);
  }
}
