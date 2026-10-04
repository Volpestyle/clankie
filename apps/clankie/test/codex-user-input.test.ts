import { expect, it } from "vitest";
import {
  codexQuestion,
  recordedCodexAnswer,
  SeatQuestionAnswerSchema,
} from "../src/captain/codex-user-input.ts";

const params = {
  threadId: "thread",
  turnId: "turn",
  itemId: "call1",
  questions: [{ id: "scope", header: "Scope", question: "Which package?", options: null }],
};
const question = codexQuestion(7, params)!;
const answers = { scope: { answers: ["core"] } };
const item = {
  type: "functionCallOutput",
  id: "call1",
  name: "request_user_input",
  output: JSON.stringify({ answers }),
};
const record = (change: Record<string, unknown> = {}) => ({
  thread: { id: "thread", turns: [{ id: "turn", items: [{ ...item, ...change }] }] },
});

it("retains native request ID type and question text, and rejects unattributed or duplicate questions", () => {
  expect(question).toMatchObject({
    requestId: 7,
    isBlocking: true,
    questions: [expect.objectContaining({ question: "Which package?" })],
  });
  expect(codexQuestion("7", params)?.requestId).toBe("7");
  expect(codexQuestion(undefined, params)).toBeUndefined();
  expect(codexQuestion(7, { ...params, threadId: undefined })).toBeUndefined();
  expect(
    codexQuestion(7, { ...params, questions: [params.questions[0], params.questions[0]] }),
  ).toBeUndefined();
});

it("requires answers from the exact thread, turn, call, and request_user_input tool output", () => {
  expect(recordedCodexAnswer(record(), question, "thread")).toEqual(answers);
  expect(recordedCodexAnswer(record(), question, "other")).toBeUndefined();
  expect(recordedCodexAnswer(record(), { ...question, turnId: "other" }, "thread")).toBeUndefined();
  for (const change of [
    { id: "other" },
    { name: "exec_command" },
    { type: "agentMessage" },
    { output: "not JSON" },
    { output: JSON.stringify({ answers: {} }) },
  ])
    expect(recordedCodexAnswer(record(change), question, "thread")).toBeUndefined();
  expect(SeatQuestionAnswerSchema.safeParse({ requestId: 7, answers }).success).toBe(true);
  expect(SeatQuestionAnswerSchema.safeParse({ requestId: 7, answers: {}, message: "fallback" }).success).toBe(
    false,
  );
});
