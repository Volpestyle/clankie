import { expect, it } from "vitest";
import { nativeConversationPage } from "../src/captain/native-conversation.ts";
import type { OperatorConversation, ReplayOperatorConversationRequest } from "@clankie/protocol";
import type { HerdrSeatTranscript } from "../src/captain/herdr-transcript.ts";

const conversation: OperatorConversation = {
  schemaVersion: 1,
  conversationId: "native-chat",
  scope: { kind: "persona", personaId: "agent" },
  title: "Native agent",
  isDefault: false,
  createdAt: "2026-09-25T00:00:00Z",
  updatedAt: "2026-09-25T00:00:00Z",
  revision: 0,
  sessionState: "waiting",
};
const request: ReplayOperatorConversationRequest = {
  schemaVersion: 1,
  conversationId: "native-chat",
  surfaceClientId: "app",
};
const transcript: HerdrSeatTranscript = {
  sessionKey: "codex:session",
  entries: [
    { type: "message", id: "u1", role: "operator", text: "Private Codex prompt" },
    { type: "tool", id: "t1", toolCallId: "call", name: "bash", phase: "completed", detail: "result" },
    { type: "message", id: "a1", role: "agent", text: "Reply" },
  ],
};

it("pages native chat, follows appends and status, and recovers after a branch or session changes", async () => {
  const first = await nativeConversationPage(conversation, transcript, "working", { ...request, limit: 2 });
  if (first.status !== "page") throw new Error("page expected");
  expect(first.events.map((event) => event.type)).toEqual(["message", "tool"]);
  expect(first.hasMore).toBe(true);
  const rest = await nativeConversationPage(conversation, transcript, "working", {
    ...request,
    cursor: first.nextCursor,
  });
  if (rest.status !== "page") throw new Error("page expected");
  expect(rest.events.map((event) => event.type)).toEqual(["message", "activity"]);
  const unchanged = await nativeConversationPage(conversation, transcript, "working", {
    ...request,
    cursor: rest.nextCursor,
  });
  expect(unchanged).toMatchObject({ status: "page", events: [] });
  const settled = await nativeConversationPage(conversation, transcript, "idle", {
    ...request,
    cursor: rest.nextCursor,
  });
  expect(settled).toMatchObject({ status: "page", events: [{ type: "activity", phase: "waiting" }] });
  const appended = {
    ...transcript,
    entries: [
      ...transcript.entries,
      { type: "message" as const, id: "a2", role: "agent" as const, text: "More" },
    ],
  };
  const update = await nativeConversationPage(conversation, appended, "idle", {
    ...request,
    cursor: rest.nextCursor,
  });
  expect(update).toMatchObject({
    status: "page",
    events: [{ type: "message", text: "More" }, { type: "activity" }],
  });
  for (const changed of [
    { ...transcript, sessionKey: "other" },
    { ...transcript, entries: transcript.entries.slice(1) },
  ]) {
    const recovery = await nativeConversationPage(conversation, changed, "idle", {
      ...request,
      cursor: rest.nextCursor,
    });
    expect(recovery).toMatchObject({ status: "recover", code: "cursor_reset" });
    if (recovery.status !== "recover") throw new Error("recover expected");
    expect(
      await nativeConversationPage(conversation, changed, "idle", {
        ...request,
        cursor: recovery.resetCursor,
      }),
    ).toMatchObject({ status: "page" });
  }
});

it("delivers images only on the requested page and advances past unavailable files", async () => {
  const calls: string[] = [];
  const images: HerdrSeatTranscript = {
    sessionKey: "images",
    entries: [
      { type: "message", id: "reply", role: "agent", text: "See `after.png`" },
      { type: "viewed_image", id: "image", path: "missing.png" },
    ],
  };
  const publish = async (path: string) => {
    calls.push(path);
    if (path === "missing.png") throw new Error("missing");
    return {
      artifactId: "artifact",
      filename: path,
      mediaType: "image/png",
      byteCount: 10,
      sha256: "a".repeat(64),
    };
  };
  const first = await nativeConversationPage(conversation, images, "idle", { ...request, limit: 1 }, publish);
  expect(calls).toEqual([]);
  if (first.status !== "page") throw new Error("page expected");
  const rest = await nativeConversationPage(
    conversation,
    images,
    "idle",
    { ...request, cursor: first.nextCursor },
    publish,
  );
  expect(rest).toMatchObject({
    status: "page",
    events: [{ type: "file", file: { filename: "after.png" } }, { type: "activity" }],
  });
  expect(calls).toEqual(["after.png", "missing.png"]);
});

it("hides channel envelopes and retains explicit reactions without persisting native messages", async () => {
  const source: HerdrSeatTranscript = {
    ...transcript,
    entries: [
      {
        type: "message",
        id: "channel",
        role: "operator",
        internal: true,
        text: "<channel>Internal prompt</channel>",
      },
      ...transcript.entries,
    ],
  };
  const first = await nativeConversationPage(conversation, source, "idle", request);
  if (first.status !== "page") throw new Error("page expected");
  expect(JSON.stringify(first)).not.toContain("Internal prompt");
  const reaction = {
    schemaVersion: 1 as const,
    conversationId: conversation.conversationId,
    revision: 0,
    cursor: "000000000001",
    occurredAt: conversation.createdAt,
    type: "reaction" as const,
    entryRef: first.events[0]!.cursor,
    emoji: "👍",
    reactor: { kind: "operator" as const },
    removed: false,
  };
  const reacted = await nativeConversationPage(
    conversation,
    source,
    "idle",
    { ...request, cursor: first.nextCursor },
    undefined,
    [reaction],
  );
  expect(reacted).toMatchObject({
    status: "page",
    events: [{ type: "reaction", emoji: "👍" }, { type: "activity" }],
  });
});
