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
it("owner mailbox schema preserves room source, native question identity and multi-question answers", () => {
  const questions = [
    {
      status: "ready",
      conversationId: "room:discord:123",
      revision: 7,
      question: {
        requestId: target.requestId,
        incarnationId: target.incarnationId,
        conversationId: "room:discord:123",
        purpose: "decision",
        kind: "text",
        prompt: "Choose the worker's next step",
        options: [],
        allowFreeform: true,
        recommendation: "Keep the current API",
        waitingOn: "Worker's implementation",
        originRunId: "source-run",
        createdAt: "2026-10-07T00:00:00.000Z",
        status: "pending",
        workerQuestion: {
          seatId: "worker-seat",
          sessionId: "native-session",
          requestId: 42,
          questions: [{ id: "strategy", question: "Which strategy?", options: [{ label: "Keep" }] }],
        },
      },
    },
  ];
  const result = OperatorConversationServiceResultSchema.parse({
    op: "input_list",
    schemaVersion: 1,
    result: { questions },
  });
  expect(result).toMatchObject({ result: { questions } });
  const answer = OperatorConversationServiceRequestSchema.parse({
    op: "input_answer",
    schemaVersion: 1,
    ...target,
    answer: { kind: "worker", answers: { strategy: { answers: ["Keep"] } } },
  });
  expect(answer).toMatchObject({ answer: { answers: { strategy: { answers: ["Keep"] } } } });
  expect(
    hostedOperatorAllows(
      "POST",
      "/operator/v1/dispatch",
      JSON.stringify({
        op: "input_list",
        schemaVersion: 1,
        status: "pending",
      }),
    ),
  ).toBe(true);
});
