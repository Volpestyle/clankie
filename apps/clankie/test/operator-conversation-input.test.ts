import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SubmitOperatorConversationTurnSchema } from "@clankie/protocol";
import { runDurableTurn } from "../src/captain/captain.ts";
import { ConversationStore } from "../src/captain/conversations.ts";

it.each([false, true])("steers past queued work while a human/internal (%s) turn runs", async (internal) => {
  const root = await mkdtemp(join(tmpdir(), "clankie-input-"));
  let finish!: () => void;
  const finishPromise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let streaming!: () => void;
  const streamingPromise = new Promise<void>((resolve) => {
    streaming = resolve;
  });
  const calls: Array<[string, string | undefined]> = [];
  const session = {
    isStreaming: false,
    state: { messages: [] },
    async prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }) {
      calls.push([text, options?.streamingBehavior]);
      if (options?.streamingBehavior === "steer") return;
      if (text === "first") {
        session.isStreaming = true;
        streaming();
        await finishPromise;
        session.isStreaming = false;
      }
    },
  };
  const lane: Parameters<typeof runDurableTurn>[0] = { session, capture: {} };
  const store = new ConversationStore(root, async (_id, message, publish) => {
    if ((await runDurableTurn(lane, message, [])) === "ran") {
      publish({ type: "message", role: "captain", text: `reply to ${message}`, streaming: false });
    }
  });
  let revision = 0;
  const send = async (message: string, delivery: "steer" | "queue") => {
    const result = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: SubmitOperatorConversationTurnSchema.parse({
        schemaVersion: 1,
        kind: "message",
        conversationId: "global-default",
        surfaceClientId: "test",
        expectedRevision: revision++,
        message,
        delivery,
      }),
    });
    if (result.op !== "send" || result.result.status !== "accepted") throw new Error("send failed");
    return result.result.runId;
  };
  try {
    if (internal) {
      store.submitInternal("global-default", "first", "wake");
      revision++;
    } else await send("first", "steer");
    await streamingPromise;
    const queued = await send("later", "queue");
    const steered = await send("correction", "steer");
    expect(calls).toEqual([
      ["first", undefined],
      ["correction", "steer"],
    ]);
    finish();
    await Promise.all([store.awaitRun(queued), store.awaitRun(steered)]);
    expect(calls).toEqual([
      ["first", undefined],
      ["correction", "steer"],
      ["later", undefined],
    ]);
    const replay = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: "global-default",
        surfaceClientId: "test",
        limit: 50,
      },
    });
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("replay failed");
    expect(
      replay.result.events
        .filter((event) => event.type === "message" && event.role === "captain")
        .map((event) => (event.type === "message" ? event.text : "")),
    ).toEqual(["reply to first", "reply to later"]);
  } finally {
    finish();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
