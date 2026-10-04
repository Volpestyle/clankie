import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createOperatorConversationServiceClient,
  type ConversationQuestion,
  type ConversationQuestionResult,
} from "@clankie/protocol";
import { questionConsoleCommand } from "../src/question-commands.ts";
import { runConversationsCommand } from "../src/command/conversations.ts";
const q: ConversationQuestion = {
  requestId: randomUUID(),
  incarnationId: randomUUID(),
  conversationId: "workspace",
  workspace: "/fixture",
  purpose: "preference",
  kind: "choice",
  prompt: "Choose",
  options: [
    { optionId: randomUUID(), label: "Small" },
    { optionId: randomUUID(), label: "Large" },
  ],
  allowFreeform: true,
  originRunId: "run-origin",
  createdAt: "2026-10-04T00:00:00.000Z",
  status: "pending",
};
it("TUI answers displayed option ID and refuses stale displayed state after conflict or conversation switch", async () => {
  let conversation = q.conversationId;
  const writes: unknown[] = [];
  const client = createOperatorConversationServiceClient(async (request) => {
    if (request.op === "input_get")
      return {
        op: request.op,
        schemaVersion: 1,
        result: { status: "ready", conversationId: q.conversationId, revision: 3, question: q },
      };
    if (request.op !== "input_answer") throw new Error("unexpected");
    writes.push(request);
    return {
      op: request.op,
      schemaVersion: 1,
      result: { status: "revision_conflict", conversationId: q.conversationId, revision: 4, question: q },
    };
  });
  const command = questionConsoleCommand(client, () => conversation);
  await expect(command("answer 1")).rejects.toThrow("Read the current question");
  expect(await command("")).toContain("1. Small");
  await expect(command("answer 1")).rejects.toThrow("conversation changed");
  expect(writes[0]).toMatchObject({
    requestId: q.requestId,
    expectedRevision: 3,
    answer: { optionId: q.options[0]!.optionId },
  });
  await expect(command("answer 1")).rejects.toThrow("Read the current question");
  await command("");
  conversation = "different";
  await expect(command("cancel")).rejects.toThrow("Read the current question");
  expect(writes).toHaveLength(1);
});
it("CLI carries explicit revision/incarnation/option using operator credential and never retries refusal", async () => {
  const calls: { body: unknown; authorization: string | null }[] = [],
    output: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ body, authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({
      op: "input_answer",
      schemaVersion: 1,
      result: {
        status: "refused",
        conversationId: q.conversationId,
        reason: "invalid_answer",
      } satisfies ConversationQuestionResult,
    });
  };
  expect(
    await runConversationsCommand(
      [
        "answer",
        q.conversationId,
        q.requestId,
        "--incarnation",
        q.incarnationId,
        "--revision",
        "3",
        "--option",
        q.options[0]!.optionId,
      ],
      {
        env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
        fetchImpl,
        stdout: { write: (v) => output.push(v) },
      },
    ),
  ).toBe(1);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    authorization: "Bearer fixture-owner",
    body: { expectedRevision: 3, requestId: q.requestId, answer: { optionId: q.options[0]!.optionId } },
  });
  expect(output.join("")).toContain("invalid_answer");
});
it("CLI refuses ambiguous text/option inputs before a write", async () => {
  const fetchImpl = vi.fn();
  await expect(
    runConversationsCommand(
      [
        "answer",
        q.conversationId,
        q.requestId,
        "--incarnation",
        q.incarnationId,
        "--revision",
        "3",
        "--option",
        q.options[0]!.optionId,
        "--text",
        "yes",
      ],
      { env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" }, fetchImpl },
    ),
  ).rejects.toThrow("exactly one");
  expect(fetchImpl).not.toHaveBeenCalled();
});
