import { sendMessage } from "./conversation-requests.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConversationStore,
  OPERATOR_CONVERSATION_RETAINED_EVENTS_MAX,
} from "../src/captain/conversations.ts";
import type { ReplayOperatorConversationRequest } from "@clankie/protocol";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-conversation-window-"));
  roots.push(root);
  const store = new ConversationStore(root, async (_id, _message, publish) => {
    publish({ type: "message", role: "captain", text: "answer", streaming: false });
  });
  const request = { schemaVersion: 1 as const, conversationId: "global-default", surfaceClientId: "test" };
  const replay = async (options: Partial<ReplayOperatorConversationRequest> = {}) => {
    const response = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: { ...request, ...options },
    });
    if (response.op !== "replay") throw new Error("wrong response");
    return response.result;
  };
  const send = async (revision: number) => {
    const response = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: { ...request, kind: "message", expectedRevision: revision, message: `question ${revision}` },
    });
    if (response.op !== "send" || response.result.status !== "accepted") throw new Error("send failed");
    await store.awaitRun(response.result.runId);
    return response.result.revision;
  };
  return { store, request, replay, send };
}

describe("backward operator replay", () => {
  it("opens latest turns, pages backwards and tails new events independently", async () => {
    const { store, request, replay, send } = await fixture();
    let revision = 0;
    for (let index = 0; index < 13; index += 1) revision = await send(revision);
    const all = await replay({ limit: 500 });
    const newest = await replay({ direction: "backward", turnLimit: 4 });
    if (all.status !== "page" || newest.status !== "page") throw new Error("page expected");
    expect(
      newest.events.filter((event) => event.type === "message" && event.role === "operator"),
    ).toHaveLength(2);
    expect(newest).toMatchObject({
      hasOlder: true,
      hasMore: true,
      nextCursor: all.safeCursor,
      safeCursor: all.safeCursor,
    });
    expect(newest.previousCursor).toBe(newest.events[0]!.cursor);
    const accumulated = [...newest.events];
    let cursor = newest.previousCursor;
    for (;;) {
      const page = await replay({ direction: "backward", turnLimit: 4, cursor });
      if (page.status !== "page") throw new Error("page expected");
      accumulated.unshift(...page.events);
      if (!page.hasOlder) break;
      expect(page.previousCursor! < cursor!).toBe(true);
      cursor = page.previousCursor;
    }
    expect(accumulated).toEqual(all.events);
    await send(revision);
    const tail = await store.serve({
      op: "tail",
      schemaVersion: 1,
      tail: { ...request, cursor: newest.nextCursor },
    });
    if (tail.op !== "tail" || tail.result.status !== "page") throw new Error("tail expected");
    expect(tail.result.events.length).toBeGreaterThan(0);
    expect(tail.result.events.every((event) => event.cursor > newest.nextCursor)).toBe(true);
    expect(tail.result.previousCursor).toBeUndefined();
    await store.close();
  });

  it("opens retained newest events without a stale-cursor round trip", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-conversation-window-retained-"));
    roots.push(root);
    const store = new ConversationStore(root, async (_id, _message, publish) => {
      for (let index = 0; index < OPERATOR_CONVERSATION_RETAINED_EVENTS_MAX; index += 1) {
        publish({ type: "activity", phase: "thinking" });
      }
    });
    const sent = await sendMessage(store, {
      conversationId: "global-default",
      surfaceClientId: "test",
      expectedRevision: 0,
      message: "fill retention",
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("send failed");
    await store.awaitRun(sent.result.runId);
    const request = {
      schemaVersion: 1 as const,
      conversationId: "global-default",
      surfaceClientId: "test",
      direction: "backward" as const,
    };
    const latest = await store.serve({ op: "replay", schemaVersion: 1, replay: request });
    if (latest.op !== "replay" || latest.result.status !== "page")
      throw new Error("newest should skip expired origin");
    expect(latest.result.events.length).toBeGreaterThan(0);
    expect(latest.result.retainedFromCursor).not.toBe("000000000000");
    const expired = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: { ...request, cursor: "0" },
    });
    expect(expired.op === "replay" && expired.result).toMatchObject({
      status: "recover",
      code: "cursor_expired",
    });
    await store.close();
  });

  it("keeps typed cursor recovery and handles empty history", async () => {
    const { store, replay, send } = await fixture();
    expect(await replay({ direction: "backward" })).toMatchObject({
      status: "page",
      events: [],
      hasOlder: false,
      hasMore: false,
    });
    await send(0);
    expect(await replay({ direction: "backward", cursor: "invalid" })).toMatchObject({
      status: "recover",
      code: "cursor_invalid",
    });
    expect(await replay({ direction: "backward", cursor: "999999999999" })).toMatchObject({
      status: "recover",
      code: "cursor_reset",
    });
    await store.close();
  });
});
