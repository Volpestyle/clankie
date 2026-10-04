import { z } from "zod";

/** A receipt for one operator MCP dispatch; native receipts retain their own identities. */
export const SEAT_CALL_META = "clankie/seat-call";
export const RECONCILE_SEAT_CALL = "reconcile_seat_call";
export const SeatCallToolSchema = z.enum(["message_seat", "hire_agent"]);
export type SeatCallTool = z.infer<typeof SeatCallToolSchema>;
export const SeatCallIdSchema = z.string().uuid();
export const SeatCallRequestSchema = z.object({ id: SeatCallIdSchema }).passthrough();

export function seatCallMeta(id: string, tool: SeatCallTool, state: "settled" | "uncertain") {
  return {
    id,
    tool,
    state,
    ...(tool === "message_seat" ? { deliveryId: id } : { hireId: id }),
  };
}

export function uncertainSeatCall(id: string, tool: SeatCallTool, detail: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          schemaVersion: 1,
          outcome: "uncertain",
          deliveryStage: "uncertain",
          ...(tool === "message_seat" ? { deliveryId: id } : { hireId: id }),
          tool,
          detail,
          reconcileTool: RECONCILE_SEAT_CALL,
        }),
      },
    ],
    isError: true,
    _meta: { [SEAT_CALL_META]: seatCallMeta(id, tool, "uncertain") },
  };
}
