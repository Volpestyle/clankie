import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConversationStore,
  type ConversationRunner,
  type ConversationTurnContext,
} from "../src/captain/conversations.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store(runner: ConversationRunner = () => Promise.resolve()): Promise<ConversationStore> {
  const root = await mkdtemp(join(tmpdir(), "clankie-head-conversation-"));
  roots.push(root);
  return new ConversationStore(root, runner);
}

async function events(conversations: ConversationStore, conversationId: string) {
  const replay = await conversations.serve({
    op: "replay",
    schemaVersion: 1,
    replay: { schemaVersion: 1, conversationId, surfaceClientId: "test", limit: 200 },
  });
  if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("page expected");
  return replay.result.events;
}

/** The seated harness's transcript is his own thread: the default global conversation the app pins (ADR 0152). */
describe("the seat's head conversation", () => {
  it("folds the seat transcript into the default global conversation as his own words, appending to pi history", async () => {
    const conversations = await store();
    const head = conversations.defaultGlobalConversationId();
    expect(head).toBe("global-default");
    conversations.publishHeadEvent({
      type: "message",
      role: "captain",
      text: "said from pi",
      streaming: false,
    });

    conversations.syncHeadTranscript("term-seat", {
      sessionKey: "herdr:claude:id:abc",
      entries: [
        { type: "message", id: "claude:1", role: "operator", text: "who are you?" },
        { type: "message", id: "claude:2", role: "agent", text: "Clankie, sitting in Claude Code." },
        {
          type: "tool",
          id: "claude:3",
          toolCallId: "t1",
          name: "Bash",
          phase: "started",
          detail: "clankie status",
        },
      ],
    });
    const folded = await events(conversations, head);
    expect(
      folded.map((event) => (event.type === "message" ? `${event.role}:${event.text}` : event.type)),
    ).toEqual([
      "captain:said from pi",
      "operator:who are you?",
      "captain:Clankie, sitting in Claude Code.",
      "tool",
    ]);

    // A re-read while the pane works publishes only what is new.
    conversations.syncHeadTranscript("term-seat", {
      sessionKey: "herdr:claude:id:abc",
      entries: [
        { type: "message", id: "claude:1", role: "operator", text: "who are you?" },
        { type: "message", id: "claude:2", role: "agent", text: "Clankie, sitting in Claude Code." },
        {
          type: "tool",
          id: "claude:3",
          toolCallId: "t1",
          name: "Bash",
          phase: "started",
          detail: "clankie status",
        },
        { type: "message", id: "claude:4", role: "agent", text: "Everything is up." },
      ],
    });
    const again = await events(conversations, head);
    expect(again).toHaveLength(5);
    expect(again.at(-1)).toMatchObject({ type: "message", role: "captain", text: "Everything is up." });

    // Reopening the seat is a new Claude session on the same thread.
    conversations.syncHeadTranscript("term-seat", {
      sessionKey: "herdr:claude:id:def",
      entries: [{ type: "message", id: "claude:9", role: "agent", text: "Back in the seat." }],
    });
    expect((await events(conversations, head)).at(-1)).toMatchObject({
      role: "captain",
      text: "Back in the seat.",
    });
  });

  it("carries a turn's provenance to the runner: origin for internal turns, surface for sends", async () => {
    const contexts: ConversationTurnContext[] = [];
    const conversations = await store((_id, _message, _publish, context) => {
      contexts.push(context);
      return Promise.resolve();
    });
    const head = conversations.defaultGlobalConversationId();
    const wake = conversations.submitInternal(head, "wake up", "wake");
    if (wake.status !== "accepted") throw new Error("accepted expected");
    await conversations.awaitRun(wake.runId);
    const sent = await conversations.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: head,
        surfaceClientId: "clankie-menu-bar-voice",
        expectedRevision: 1,
        message: "can you check the build?",
      },
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("accepted expected");
    await conversations.awaitRun(sent.result.runId);
    expect(contexts.map((context) => [context.internal, context.origin, context.surfaceClientId])).toEqual([
      [true, "wake", undefined],
      [undefined, undefined, "clankie-menu-bar-voice"],
    ]);
  });
});

it("pins native sessions to a project and deduplicates retries, resumed sessions and Herdr observation across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-native-conversation-"));
  roots.push(root);
  let conversations = new ConversationStore(root, async () => {});
  const created = await conversations.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: root },
    title: "Project",
  });
  if (created.op !== "create") throw new Error("create failed");
  const id = created.conversation.conversationId;
  const entry = {
    type: "message" as const,
    id: "claude:project-entry",
    role: "agent" as const,
    text: "Project response",
  };
  expect(conversations.syncNativeSeatTranscript(id, "session-1", [entry])).toBe(true);
  expect(conversations.syncNativeSeatTranscript("global-default", "session-1", [entry])).toBe(false);
  conversations.syncNativeSeatTranscript(id, "session-2", [
    { ...entry, id: "claude:second-entry", text: "Next session" },
  ]);
  await conversations.close();
  conversations = new ConversationStore(root, async () => {});
  expect(conversations.syncNativeSeatTranscript(id, "session-1", [entry])).toBe(true);
  expect(await events(conversations, id)).toHaveLength(2);
  expect(await events(conversations, "global-default")).toHaveLength(0);
  expect(conversations.syncNativeSeatTranscript("global-default", "session-1", [entry])).toBe(false);
  conversations.syncHeadTranscript("head", {
    sessionKey: "herdr-head",
    entries: [{ ...entry, id: "claude:head-entry" }],
  });
  conversations.syncNativeSeatTranscript("global-default", "session-head", [
    { ...entry, id: "claude:head-entry" },
  ]);
  expect(await events(conversations, "global-default")).toHaveLength(1);
  const conversation = conversations.conversation(id)!;
  await conversations.serve({
    op: "reset",
    schemaVersion: 1,
    conversationId: id,
    expectedRevision: conversation.revision,
  });
  expect(conversations.syncNativeSeatTranscript(id, "session-1", [entry])).toBe(false);
  expect(conversations.syncNativeSeatTranscript("global-default", "session-1", [entry])).toBe(false);
  expect(conversations.syncNativeSeatTranscript(id, "new-after-reset", [{ ...entry, id: "fresh-id" }])).toBe(
    true,
  );
  expect((await readFile(join(root, id, "events.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  await conversations.close();
});

it("settles native display records without ending a service run, and deduplicates hook retries", async () => {
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const conversations = await store(async () => {
    entered();
    await pending;
  });
  const id = conversations.defaultGlobalConversationId();
  const entry = {
    type: "message" as const,
    id: "native-final",
    role: "agent" as const,
    text: "Checked result",
  };
  try {
    conversations.syncNativeSeatTranscript(id, "native-session", [], "responding");
    conversations.syncNativeSeatTranscript(id, "native-session", [entry], "waiting");
    const settled = await events(conversations, id);
    expect(settled.at(-1)).toMatchObject({ type: "activity", phase: "waiting" });
    conversations.syncNativeSeatTranscript(id, "native-session", [entry], "waiting");
    expect(await events(conversations, id)).toEqual(settled);
    const sent = await conversations.serve({
      schemaVersion: 1,
      op: "send",
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: id,
        surfaceClientId: "test",
        expectedRevision: 0,
        message: "New service work",
      },
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("send refused");
    await started;
    conversations.syncNativeSeatTranscript(id, "native-session", [], "waiting");
    expect(conversations.conversation(id)?.sessionState).toBe("active");
    finish();
    await conversations.awaitRun(sent.result.runId);
  } finally {
    finish();
    await conversations.close();
  }
});
