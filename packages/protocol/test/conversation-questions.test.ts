import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  createOperatorConversationServiceClient,
} from "../src/index.ts";
import { hostedOperatorAllows } from "../src/hosted-operator.ts";
const target = {
  conversationId: "workspace",
  incarnationId: randomUUID(),
  requestId: randomUUID(),
  expectedRevision: 4,
};
it("strict answer DTO carries immutable IDs and refuses authority or second answer fields", () => {
  const request = {
    schemaVersion: 1,
    op: "input_answer",
    ...target,
    answer: { kind: "choice", optionId: randomUUID() },
  };
  expect(OperatorConversationServiceRequestSchema.safeParse(request).success).toBe(true);
  for (const bad of [
    { ...request, principal: "owner" },
    { ...request, workspace: "/fake" },
    { ...request, answer: { ...request.answer, label: "Small" } },
    { ...request, answer: { kind: "approval", text: "yes" } },
    { ...request, answer: { kind: "text", text: "x".repeat(4001) } },
    { ...request, answer: { kind: "text", text: " " } },
  ])
    expect(OperatorConversationServiceRequestSchema.safeParse(bad).success).toBe(false);
  expect(hostedOperatorAllows("POST", "/operator/v1/dispatch", JSON.stringify(request))).toBe(true);
});
it("shared client has explicit read/answer/cancel operations with no transport retry", async () => {
  const seen: unknown[] = [];
  const client = createOperatorConversationServiceClient(async (request) => {
    seen.push(request);
    if (request.op !== "input_get" && request.op !== "input_answer" && request.op !== "input_cancel")
      throw new Error("unexpected");
    return OperatorConversationServiceResultSchema.parse({
      op: request.op,
      schemaVersion: 1,
      result: { status: "refused", conversationId: "workspace", reason: "stale_request" },
    });
  });
  await client.inputGet!(target.conversationId, target.requestId);
  await client.inputAnswer!({ ...target, answer: { kind: "text", text: "preference" } });
  await client.inputCancel!(target);
  expect(seen).toHaveLength(3);
  expect(seen[1]).toEqual({
    op: "input_answer",
    schemaVersion: 1,
    ...target,
    answer: { kind: "text", text: "preference" },
  });
});
