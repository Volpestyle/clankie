import { z } from "zod";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OperatorFleetSeat } from "@clankie/protocol";
import {
  assertConversationAuthority,
  captureConversationAuthority,
  type ConversationAuthority,
} from "./conversation-owner.ts";
import { toolJson, type TurnContext } from "./tools.ts";

export const FleetEfficiencyReviewSchema = z.strictObject({
  seatId: z.string().trim().min(1).max(512),
  offScope: z.boolean().optional(),
  assignmentStatus: z.enum(["active", "paused", "canceled", "done"]).optional(),
  deliverable: z.string().trim().min(1).max(512).optional(),
  progressAt: z.string().datetime().optional(),
  evidence: z.string().trim().min(1).max(2048),
});
export type FleetEfficiencyReview = z.infer<typeof FleetEfficiencyReviewSchema>;
export const FleetEfficiencyRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("show"), conversationId: z.string().min(1).max(256) }),
  FleetEfficiencyReviewSchema.extend({
    action: z.literal("review"),
    conversationId: z.string().min(1).max(256),
  }),
]);
export interface FleetEfficiencyActions {
  run(
    authority: ConversationAuthority,
    review?: FleetEfficiencyReview,
  ): Promise<{ conversationId: string; seats: readonly OperatorFleetSeat[] }>;
}

export function fleetEfficiencyTools(actions: FleetEfficiencyActions, turn: TurnContext): ToolDefinition[] {
  return [
    {
      name: "fleet_efficiency",
      label: "Review the agents you lead",
      description:
        "Show every seat this conversation leads with assignment, native effort/context and reporting/progress flags. " +
        "Load the lead skill for review and intervention guidance. Review records inspected scope/tracker status or " +
        "a substantive finding/commit time for one exact owned native session; include its evidence. " +
        "It does not change the tracker, issue state, harness effort, ownership or delivery receipts. " +
        "Unknown telemetry is omitted, not healthy. Use existing native message/hire/readopt/tidy tools to act.",
      parameters: Type.Union([
        Type.Object({ action: Type.Literal("show") }),
        Type.Object({
          action: Type.Literal("review"),
          seatId: Type.String({ minLength: 1, maxLength: 512 }),
          offScope: Type.Optional(Type.Boolean()),
          assignmentStatus: Type.Optional(
            Type.Union(["active", "paused", "canceled", "done"].map((value) => Type.Literal(value))),
          ),
          deliverable: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
          progressAt: Type.Optional(Type.String({ format: "date-time" })),
          evidence: Type.String({ minLength: 1, maxLength: 2048 }),
        }),
      ]),
      executionMode: "sequential",
      execute: async (_id, input: { action: "show" | "review" } & Partial<FleetEfficiencyReview>) => {
        const authority = captureConversationAuthority(turn.conversationAuthority);
        await assertConversationAuthority(authority);
        const { action, ...review } = input;
        return toolJson(
          await actions.run(
            authority,
            action === "review" ? FleetEfficiencyReviewSchema.parse(review) : undefined,
          ),
        );
      },
    },
  ];
}
