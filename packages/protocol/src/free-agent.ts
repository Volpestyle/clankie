import { z } from "zod";

const Ref = z.string().trim().min(1).max(256).regex(/^\S+$/u);
const Target = z.object({ seatId: Ref, occupantId: Ref, personaId: Ref }).strict();
/** An additional owner-write precondition, never authority or a display-name address. */
export const FreeAgentIntentSchema = Target.extend({
  projectId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  /** Exact teammate for a catalog-authored co-w invocation, in the same native session. */
  helpTarget: Target.extend({ paneId: Ref }).strict().optional(),
}).strict();
export type FreeAgentIntent = z.infer<typeof FreeAgentIntentSchema>;

import type { OperatorFleetSeat } from "./operator-conversations.ts";
/** Native observations, never a UI caption or an idle-looking sprite. */
export function freeAgentEligibility(seat: OperatorFleetSeat): "free" | "busy" | "unobserved_children" {
  const idle =
    /^(idle|resting)$/u.test(seat.status) &&
    (seat.stance === undefined || seat.stance.pose === "resting") &&
    seat.activity === undefined &&
    seat.assignment === undefined &&
    (seat.goal === undefined || seat.goal.status === "complete");
  if (!idle) return "busy";
  if (seat.subagents === undefined) return "unobserved_children";
  return seat.subagents.running === 0 ? "free" : "busy";
}

export function freeFleetAgent(seat: OperatorFleetSeat): boolean {
  return freeAgentEligibility(seat) === "free";
}
