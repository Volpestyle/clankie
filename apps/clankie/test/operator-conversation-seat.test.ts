import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("seat conversations", () => {
  it("creates one thread per seat, delivers directly, rejects offline, and replays projections", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-seat-conversation-"));
    roots.push(root);
    let online = false;
    const runner = vi.fn(() => Promise.resolve());
    const sendToSeat = vi.fn((_seatId: string, _message: string) => Promise.resolve(online));
    const store = new ConversationStore(root, runner, undefined, sendToSeat);
    const create = () =>
      store.serve({
        op: "create",
        schemaVersion: 1,
        scope: { kind: "seat", seatId: "term-potato" },
        title: "Worker",
      });

    const first = await create();
    const second = await create();
    if (first.op !== "create" || second.op !== "create") throw new Error("create expected");
    expect(second.conversation.conversationId).toBe(first.conversation.conversationId);
    expect(first.conversation.sessionState).toBe("unbound");
    expect(() => store.submitInternal(first.conversation.conversationId, "wake")).toThrow(
      "Seat conversations do not run captain turns",
    );

    const turn = {
      schemaVersion: 1 as const,
      kind: "message" as const,
      conversationId: first.conversation.conversationId,
      surfaceClientId: "ios",
      expectedRevision: 0,
      message: "Please finish the tests",
    };
    const offline = await store.serve({ op: "send", schemaVersion: 1, turn });
    expect(offline.op === "send" ? offline.result : undefined).toMatchObject({
      status: "seat_offline",
      seatId: "term-potato",
      currentRevision: 0,
    });

    online = true;
    const delivered = await store.serve({ op: "send", schemaVersion: 1, turn });
    expect(delivered.op === "send" ? delivered.result : undefined).toMatchObject({
      status: "accepted",
      revision: 1,
    });
    expect(sendToSeat).toHaveBeenLastCalledWith("term-potato", "Please finish the tests");
    expect(runner).not.toHaveBeenCalled();
    const current = await store.serve({
      op: "get",
      schemaVersion: 1,
      conversationId: first.conversation.conversationId,
    });
    expect(current.op === "get" ? current.conversation?.sessionState : undefined).toBe("unbound");
    const [winner, stale] = await Promise.all([
      store.serve({
        op: "send",
        schemaVersion: 1,
        turn: { ...turn, expectedRevision: 1, message: "First concurrent send" },
      }),
      store.serve({
        op: "send",
        schemaVersion: 1,
        turn: { ...turn, expectedRevision: 1, message: "Stale concurrent send" },
      }),
    ]);
    expect(winner.op === "send" ? winner.result.status : undefined).toBe("accepted");
    expect(stale.op === "send" ? stale.result.status : undefined).toBe("revision_conflict");
    expect(sendToSeat).toHaveBeenCalledTimes(3);

    store.publishSeatEvent("term-potato", { type: "activity", phase: "responding" });
    store.publishSeatEvent("term-potato", {
      type: "message",
      role: "agent",
      text: "Tests are green.",
      streaming: false,
    });
    store.publishSeatEvent("term-potato", {
      type: "message",
      role: "agent",
      text: "Tests are green.",
      streaming: false,
    });
    const replay = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: first.conversation.conversationId,
        surfaceClientId: "ios",
      },
    });
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("page expected");
    expect(replay.result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message", role: "operator", text: "Please finish the tests" }),
        expect.objectContaining({ type: "activity", phase: "responding" }),
        expect.objectContaining({ type: "message", role: "agent", text: "Tests are green." }),
      ]),
    );
    expect(
      replay.result.events.filter((event) => event.type === "message" && event.role === "agent"),
    ).toHaveLength(1);
    await store.close();
  });
});
