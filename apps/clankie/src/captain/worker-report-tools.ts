import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkerReportPage } from "@clankie/protocol";
import {
  assertConversationAuthority,
  captureConversationAuthority,
  type ConversationAuthority,
} from "./conversation-owner.ts";
import { toolJson, type TurnContext } from "./tools.ts";

export interface WorkerReportAcknowledgment {
  acknowledged: boolean;
  appliedDeliveryIds: string[];
  refused: { deliveryId: string; reason: "not_offered" | "unknown" | "already_acknowledged" }[];
  /** Acknowledged reports whose worker has had no reply from this conversation (VUH-2065). */
  unanswered: string[];
}

/** Shown to the lead whenever it acknowledges a report it has not replied to. */
export const UNANSWERED_REPORTS_INSTRUCTION =
  "No message from you has reached these workers since they reported, so any question or blocker in those reports is still open. Answer with message_seat; an answer elsewhere, such as the owner's chat, does not reach them.";

export interface WorkerReportActions {
  read(authority: ConversationAuthority, limit?: number): Promise<WorkerReportPage>;
  acknowledge(
    authority: ConversationAuthority,
    ids: readonly string[],
    receipt?: { summary?: string | undefined; links?: string[] | undefined },
  ): Promise<WorkerReportAcknowledgment>;
}

export function workerReportTools(actions: WorkerReportActions, turn: TurnContext): ToolDefinition[] {
  return [
    {
      name: "worker_reports",
      label: "Read retained worker reports",
      description:
        "Read this conversation's oldest unread worker reports, including results retained during a service restart or a missing native receiver. Reading offers full bounded reports without marking them read. After reviewing every offered report, acknowledge its exact deliveryId with acknowledge_worker_reports. A transport receipt never proves the lead read it.",
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      execute: async (_id, input: { limit?: number }) => {
        const authority = captureConversationAuthority(turn.conversationAuthority);
        await assertConversationAuthority(authority);
        return toolJson(await actions.read(authority, input.limit));
      },
    },
    {
      name: "acknowledge_worker_reports",
      label: "Acknowledge reviewed worker reports",
      description:
        "Mark only fully reviewed reports offered by worker_reports as read. Supply their exact deliveryIds. This automatically sends the original sender a short acknowledgment receipt. Include a summary and any resulting chat or issue URLs in receipt; the worker sees the summary only if a message_seat reply from this conversation reached it after the report, and otherwise is told its question is still open. The result lists applied IDs, refusals, and unanswered IDs whose worker has had no reply; call worker_reports first for IDs not yet offered. This clears their unread roster warning; receiving a native message alone does not.",
      parameters: Type.Object({
        deliveryIds: Type.Array(Type.String({ format: "uuid" }), { minItems: 1, maxItems: 100 }),
        receipt: Type.Optional(
          Type.Object({
            summary: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
            links: Type.Optional(
              Type.Array(Type.String({ format: "uri", maxLength: 2048 }), { maxItems: 10 }),
            ),
          }),
        ),
      }),
      executionMode: "sequential",
      execute: async (
        _id,
        input: {
          deliveryIds: string[];
          receipt?: { summary?: string | undefined; links?: string[] | undefined };
        },
      ) => {
        const authority = captureConversationAuthority(turn.conversationAuthority);
        await assertConversationAuthority(authority);
        const result = await actions.acknowledge(authority, input.deliveryIds, input.receipt);
        return toolJson({
          ...result,
          ...(result.refused.length === 0
            ? {}
            : {
                instruction:
                  "Call worker_reports first, review the reports, then acknowledge only its offered deliveryIds.",
              }),
          ...(result.unanswered.length === 0
            ? {}
            : { unansweredInstruction: UNANSWERED_REPORTS_INSTRUCTION }),
        });
      },
    },
  ];
}
