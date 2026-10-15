import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DriftCorrection } from "@clankie/protocol/auto-rounds";
import {
  assertConversationAuthority,
  captureConversationAuthority,
  type ConversationAuthority,
} from "./conversation-owner.ts";
import { toolJson, type TurnContext } from "./tools.ts";

export interface DriftCorrectionInput {
  readonly projectId: string;
  readonly roundId: string;
  readonly issue: string;
  readonly reason: string;
}
export type RecordDriftCorrection = (
  authority: ConversationAuthority,
  input: DriftCorrectionInput,
) => Promise<DriftCorrection>;

/** One authored tool for service turns, native seats and delegated remote leads. */
export function driftCorrectionTools(turn: TurnContext): ToolDefinition[] {
  const record = turn.recordDriftCorrection;
  if (!record) return [];
  return [
    defineTool({
      name: "record_drift_correction",
      label: "Record Auto drift correction",
      description:
        "Record your chosen milestone feature issue and one-line reason against a drift section in an Auto round. Use its projectId and roundId. Only Auto projects currently owned by this conversation qualify. This records your decision; use the tracker and hiring tools to start and staff it. The next round independently checks issue started state and product churn after this response. Exact retries return the existing choice; a different choice needs a later drift round.",
      parameters: Type.Object({
        projectId: Type.String({ minLength: 1, maxLength: 256 }),
        roundId: Type.String({ minLength: 1, maxLength: 256 }),
        issue: Type.String({
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z][A-Za-z0-9_-]*-[0-9]+$",
          description: "Chosen issue identifier in this project's tracker.",
        }),
        reason: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\r\\n]+$" }),
      }),
      executionMode: "sequential",
      execute: async (_id, input) => {
        const authority = captureConversationAuthority(turn.conversationAuthority);
        await assertConversationAuthority(authority);
        if (!input.reason.trim()) throw new Error("A one-line reason is required");
        return toolJson(
          await record(authority, { ...input, issue: input.issue.trim(), reason: input.reason.trim() }),
        );
      },
    }),
  ];
}
