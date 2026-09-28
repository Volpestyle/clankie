import { describe, expect, it } from "vitest";
import {
  operatorConversationWindow,
  ReplayOperatorConversationRequestSchema,
  OperatorConversationReplayPageSchema,
  type OperatorConversationStreamEvent,
  type OperatorConversationEventBody,
} from "../src/index.ts";

function events(bodies: OperatorConversationEventBody[]): OperatorConversationStreamEvent[] {
  return bodies.map((body, index) => ({
    ...body,
    schemaVersion: 1,
    conversationId: "test",
    cursor: String(index + 1).padStart(12, "0"),
    revision: 0,
    occurredAt: "2026-09-28T00:00:00.000Z",
  }));
}
const message = (text: string): OperatorConversationEventBody => ({
  type: "message",
  role: "external",
  text,
  streaming: false,
});

describe("recent conversation window", () => {
  it("selects newest turns and pages backwards without overlap or gaps", () => {
    const source = events(Array.from({ length: 53 }, (_, index) => message(String(index))));
    const newest = operatorConversationWindow(source);
    expect(newest.events).toEqual(source.slice(33));
    expect(newest.hasOlder).toBe(true);
    const middle = operatorConversationWindow(source, { before: newest.events[0]!.cursor });
    const oldest = operatorConversationWindow(source, { before: middle.events[0]!.cursor });
    expect([...oldest.events, ...middle.events, ...newest.events]).toEqual(source);
    expect(oldest.hasOlder).toBe(false);
    expect(operatorConversationWindow(source, { before: source[0]!.cursor })).toEqual({
      events: [],
      hasOlder: false,
    });
  });

  it("counts the operator and accepted assistant separately, without counting captain prose twice", () => {
    const source = events([
      message("old"),
      { type: "message", role: "operator", text: "question", streaming: false },
      { type: "turn", phase: "accepted", runId: "run-1" },
      { type: "message", role: "captain", text: "first", streaming: false },
      { type: "activity", phase: "waiting" },
      { type: "tool", name: "read", toolCallId: "tool-1", phase: "completed" },
      { type: "message", role: "captain", text: "answer", streaming: false },
      { type: "turn", phase: "completed", runId: "run-1" },
    ]);
    expect(operatorConversationWindow(source, { turnLimit: 2 }).events).toEqual(source.slice(1));
    expect(operatorConversationWindow(source, { turnLimit: 1 }).events).toEqual(source.slice(2));
  });

  it("counts bare agents and external messages as independent turns", () => {
    const source = events([
      { type: "message", role: "agent", text: "first", streaming: false },
      message("notice"),
      { type: "message", role: "agent", text: "next", streaming: true },
      { type: "message", role: "agent", text: "next settled", streaming: false },
    ]);
    expect(operatorConversationWindow(source, { turnLimit: 2 }).events).toEqual(source.slice(1));
    expect(operatorConversationWindow(source, { turnLimit: 1 }).events).toEqual(source.slice(2));
  });

  it("budgets an assistant continuation when an external message splits a run", () => {
    const source = events([
      { type: "turn", phase: "accepted", runId: "run-1" },
      { type: "message", role: "captain", text: "before", streaming: false },
      message("external notice"),
      { type: "message", role: "captain", text: "after", streaming: false },
      { type: "turn", phase: "completed", runId: "run-1" },
    ]);
    expect(operatorConversationWindow(source, { turnLimit: 1 }).events).toEqual(source.slice(3));
    expect(operatorConversationWindow(source, { turnLimit: 2 }).events).toEqual(source.slice(2));
  });

  it("caps a single large turn at 500 events without scanning the old prefix", () => {
    const source = events([
      { type: "turn", phase: "accepted", runId: "huge" },
      ...Array.from(
        { length: 620 },
        (): OperatorConversationEventBody => ({ type: "reasoning", text: "detail", streaming: false }),
      ),
    ]);
    expect(operatorConversationWindow(source).events).toEqual(source.slice(-500));
    expect(operatorConversationWindow(source).hasOlder).toBe(true);
    expect(operatorConversationWindow(source, { limit: 5 }).events).toHaveLength(5);
  });

  it("preserves old schema compatibility while bounding the new request", () => {
    const request = { schemaVersion: 1, conversationId: "test", surfaceClientId: "test" };
    expect(ReplayOperatorConversationRequestSchema.parse(request)).toEqual(request);
    expect(
      ReplayOperatorConversationRequestSchema.safeParse({ ...request, direction: "backward", turnLimit: 41 })
        .success,
    ).toBe(false);
    expect(
      ReplayOperatorConversationRequestSchema.safeParse({
        ...request,
        direction: "backward",
        turnLimit: 20,
        limit: 500,
      }).success,
    ).toBe(true);
    const page = {
      ...request,
      status: "page",
      events: [],
      retainedFromCursor: "0",
      nextCursor: "0",
      safeCursor: "0",
      hasMore: false,
    };
    expect(OperatorConversationReplayPageSchema.parse(page)).toEqual(page);
  });
});
