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
      "does not run captain turns",
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

  it("replaces the old last-answer seed with ordered native history and folds new turns once", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-seat-transcript-"));
    roots.push(root);
    const sendToSeat = vi.fn(() => Promise.resolve(true));
    const store = new ConversationStore(root, () => Promise.resolve(), undefined, sendToSeat);
    const created = await store.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "seat", seatId: "term-potato" },
      title: "Worker",
    });
    if (created.op !== "create") throw new Error("create expected");
    const conversationId = created.conversation.conversationId;
    store.publishSeatEvent("term-potato", {
      type: "message",
      role: "agent",
      text: "Latest answer",
      streaming: false,
    });
    const initial = {
      sessionKey: "herdr:codex:id:session-1",
      messages: [
        { id: "u1", role: "operator" as const, text: "First prompt" },
        { id: "a1", role: "agent" as const, text: "First answer" },
        { id: "u2", role: "operator" as const, text: "Latest prompt" },
        { id: "a2", role: "agent" as const, text: "Latest answer" },
      ],
    };
    store.syncSeatTranscript("term-potato", initial);
    store.syncSeatTranscript("term-potato", initial);

    const replayMessages = async () => {
      let result = await store.serve({
        op: "replay" as const,
        schemaVersion: 1 as const,
        replay: { schemaVersion: 1 as const, conversationId, surfaceClientId: "ios" },
      });
      if (result.op !== "replay") throw new Error("replay expected");
      if (result.result.status === "recover") {
        result = await store.serve({
          op: "replay",
          schemaVersion: 1,
          replay: {
            schemaVersion: 1,
            conversationId,
            surfaceClientId: "ios",
            cursor: result.result.resetCursor,
          },
        });
      }
      if (result.op !== "replay" || result.result.status !== "page") throw new Error("page expected");
      return result.result.events.flatMap((event) =>
        event.type === "message" ? [{ role: event.role, text: event.text }] : [],
      );
    };
    expect(await replayMessages()).toEqual(initial.messages.map(({ role, text }) => ({ role, text })));

    const sentAt = new Date().toISOString();
    await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId,
        surfaceClientId: "ios",
        expectedRevision: 0,
        message: "One more",
      },
    });
    store.syncSeatTranscript("term-potato", {
      ...initial,
      messages: [
        ...initial.messages,
        { id: "u3", role: "operator", text: "One more", occurredAt: sentAt },
        { id: "a3", role: "agent", text: "Done", occurredAt: sentAt },
      ],
    });
    expect((await replayMessages()).slice(-2)).toEqual([
      { role: "operator", text: "One more" },
      { role: "agent", text: "Done" },
    ]);
    await store.close();
  });
});
