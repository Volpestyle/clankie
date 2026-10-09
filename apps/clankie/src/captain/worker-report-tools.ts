import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkerReportPage } from "@clankie/protocol";
import {
  assertConversationAuthority,
  captureConversationAuthority,
  type ConversationAuthority,
} from "./conversation-owner.ts";
import { toolJson, type TurnContext } from "./tools.ts";

export interface WorkerReportActions {
  read(authority: ConversationAuthority, limit?: number): Promise<WorkerReportPage>;
  acknowledge(
    authority: ConversationAuthority,
    ids: readonly string[],
    receipt?: { summary?: string | undefined; links?: string[] | undefined },
  ): Promise<boolean>;
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
        "Mark only fully reviewed reports offered by worker_reports as read. Supply their exact deliveryIds. This automatically sends the original sender a short acknowledgment receipt. Include a summary and any resulting chat or issue URLs in receipt. This clears their unread roster warning; receiving a native message alone does not.",
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
        return toolJson({
          acknowledged: await actions.acknowledge(authority, input.deliveryIds, input.receipt),
        });
      },
    },
  ];
}
