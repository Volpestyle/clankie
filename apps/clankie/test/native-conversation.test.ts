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

it("opens a bounded recent native window and pages backward by opaque cursor identity", async () => {
  const source: HerdrSeatTranscript = {
    sessionKey: "long-native-chat",
    entries: Array.from({ length: 53 }, (_, index) => ({
      type: "message",
      id: `m${index}`,
      role: "agent",
      text: `reply ${index}`,
    })),
  };
  const backward = { ...request, direction: "backward" as const, turnLimit: 20, limit: 500 };
  const latest = await nativeConversationPage(conversation, source, "idle", backward);
  if (latest.status !== "page") throw new Error("page expected");
  expect(latest.hasOlder).toBe(true);
  expect(latest.events.filter((event) => event.type === "message")).toHaveLength(20);
  expect(latest.events.at(-1)).toMatchObject({ type: "activity", phase: "waiting" });
  const middle = await nativeConversationPage(conversation, source, "idle", {
    ...backward,
    cursor: latest.previousCursor,
  });
  if (middle.status !== "page") throw new Error("page expected");
  const oldest = await nativeConversationPage(conversation, source, "idle", {
    ...backward,
    cursor: middle.previousCursor,
  });
  if (oldest.status !== "page") throw new Error("page expected");
  expect(oldest.hasOlder).toBe(false);
  expect(
    [...oldest.events, ...middle.events, ...latest.events]
      .filter((event) => event.type === "message")
      .map((event) => event.text),
  ).toEqual(source.entries.map((entry) => (entry.type === "message" ? entry.text : "")));
  expect(
    await nativeConversationPage(conversation, source, "idle", {
      ...backward,
      cursor: latest.retainedFromCursor,
    }),
  ).toMatchObject({ status: "page", events: [], hasOlder: false });
  expect(
    await nativeConversationPage(conversation, source, "idle", { ...backward, cursor: latest.safeCursor }),
  ).toMatchObject({ status: "page", hasOlder: true });
  expect(
    await nativeConversationPage(conversation, { ...source, sessionKey: "replacement" }, "idle", {
      ...backward,
      cursor: latest.previousCursor,
    }),
  ).toMatchObject({ status: "recover", code: "cursor_reset" });
});

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

it("never emits a seat reply twice when a surface replays or resumes (VUH-1027)", async () => {
  const messages = (result: Awaited<ReturnType<typeof nativeConversationPage>>) => {
    if (result.status !== "page") throw new Error("page expected");
    return result.events.flatMap((event) =>
      event.type === "message" ? [`${event.cursor} ${event.role}: ${event.text}`] : [],
    );
  };
  // Two cold replays of one settled turn name the reply by the same cursor, so
  // a surface that dedups by cursor shows one bubble.
  const first = await nativeConversationPage(conversation, transcript, "idle", request);
  const again = await nativeConversationPage(conversation, transcript, "idle", request);
  expect(messages(again)).toEqual(messages(first));
  expect(messages(first).filter((line) => line.endsWith("agent: Reply"))).toHaveLength(1);
  if (first.status !== "page") throw new Error("page expected");

  // Resuming while the pane was still working, then after it settled and
  // answered again, yields only the new reply.
  const working = await nativeConversationPage(conversation, transcript, "working", request);
  if (working.status !== "page") throw new Error("page expected");
  const next = {
    ...transcript,
    entries: [
      ...transcript.entries,
      { type: "message" as const, id: "u2", role: "operator" as const, text: "Again" },
      { type: "message" as const, id: "a2", role: "agent" as const, text: "Second reply" },
    ],
  };
  for (const from of [first.nextCursor, working.nextCursor]) {
    const resumed = await nativeConversationPage(conversation, next, "idle", { ...request, cursor: from });
    expect(messages(resumed).map((line) => line.replace(/^\S+ /u, ""))).toEqual([
      "operator: Again",
      "agent: Second reply",
    ]);
  }
});
