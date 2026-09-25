import { createHash } from "node:crypto";
import type {
  OperatorConversation,
  OperatorConversationEventBody,
  OperatorConversationStreamEvent,
  OperatorDeliveredFile,
  ReplayOperatorConversationRequest,
  ReplayOperatorConversationResult,
} from "@clankie/protocol";
import { isDeliveredImagePath, namedImagePaths } from "../delivered-files.ts";
import type { HerdrSeatTranscript } from "./herdr-transcript.ts";

/** A read-through view. Native history never enters Clankie's durable event log. */
export async function nativeConversationPage(
  conversation: OperatorConversation,
  transcript: HerdrSeatTranscript,
  status: string,
  request: ReplayOperatorConversationRequest,
  publishImage?: (path: string) => Promise<OperatorDeliveredFile>,
  annotations: readonly OperatorConversationStreamEvent[] = [],
): Promise<ReplayOperatorConversationResult> {
  const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
  const start = `native:${hash(transcript.sessionKey)}`;
  let cursor = start;
  const entries: {
    cursor: string;
    occurredAt: string;
    body?: OperatorConversationEventBody;
    path?: string;
  }[] = [];
  const add = (key: string, occurredAt: string, body?: OperatorConversationEventBody, path?: string) => {
    // Chained identities invalidate a resume after a native branch/rewrite, too.
    cursor = `native:${hash(`${cursor}:${key}`)}`;
    entries.push({
      cursor,
      occurredAt,
      ...(body === undefined ? {} : { body }),
      ...(path === undefined ? {} : { path }),
    });
  };
  for (const entry of transcript.entries) {
    if (entry.type === "message" && entry.internal) continue;
    const at = entry.occurredAt ?? conversation.createdAt;
    if (entry.type === "viewed_image") {
      if (isDeliveredImagePath(entry.path)) add(JSON.stringify(entry), at, undefined, entry.path);
      continue;
    }
    const body: OperatorConversationEventBody =
      entry.type === "message"
        ? { type: "message", role: entry.role, text: entry.text, streaming: false }
        : {
            type: "tool",
            toolCallId: entry.toolCallId,
            name: entry.name,
            phase: entry.phase,
            ...(entry.detail === undefined ? {} : { detail: entry.detail }),
          };
    add(JSON.stringify(entry), at, body);
    if (entry.type === "message" && entry.role === "agent")
      for (const path of namedImagePaths(entry.text).slice(0, 4))
        add(`${entry.id}:${path}`, at, undefined, path);
  }
  const nativeCursors = new Set(entries.map((entry) => entry.cursor));
  for (const event of annotations) {
    if (event.type === "reaction" && nativeCursors.has(event.entryRef))
      add(`annotation:${event.cursor}`, event.occurredAt, {
        type: "reaction",
        entryRef: event.entryRef,
        emoji: event.emoji,
        reactor: event.reactor,
        removed: event.removed,
      });
    else if (event.type === "file")
      add(`annotation:${event.cursor}`, event.occurredAt, { type: "file", file: event.file });
  }
  const phase = status === "working" ? "responding" : "waiting";
  const safeCursor = `${cursor}:${phase}`;
  const from = request.cursor;
  // Activity cursors retain their native entry anchor as later entries arrive.
  const anchor = from?.replace(/:(responding|waiting)$/u, "");
  const index =
    anchor === start || from === undefined || /^0+$/u.test(from)
      ? -1
      : entries.findIndex((entry) => entry.cursor === anchor);
  if (index < 0 && anchor !== start && from !== undefined && !/^0+$/u.test(from)) {
    return {
      schemaVersion: 1,
      status: "recover",
      conversationId: conversation.conversationId,
      code: "cursor_reset",
      recoverable: true,
      resetCursor: start,
      message: "The native session changed or its retained history moved; reload this chat.",
    };
  }
  if (from !== safeCursor)
    entries.push({
      cursor: safeCursor,
      occurredAt: entries.at(-1)?.occurredAt ?? conversation.createdAt,
      body: { type: "activity", phase },
    });
  const remaining = from === safeCursor ? [] : entries.slice(index + 1);
  const page = remaining.slice(0, request.limit ?? 200);
  const events: OperatorConversationStreamEvent[] = [];
  for (const entry of page) {
    let body = entry.body;
    if (entry.path !== undefined && publishImage !== undefined) {
      try {
        const { artifactId, filename, mediaType, byteCount, sha256 } = await publishImage(entry.path);
        body = { type: "file", file: { artifactId, filename, mediaType, byteCount, sha256 } };
      } catch {
        /* Missing or out-of-workspace images remain text, never an unrestricted file read. */
      }
    }
    if (body !== undefined)
      events.push({
        schemaVersion: 1,
        conversationId: conversation.conversationId,
        revision: conversation.revision,
        cursor: entry.cursor,
        occurredAt: entry.occurredAt,
        ...body,
      });
  }
  return {
    schemaVersion: 1,
    status: "page",
    conversationId: conversation.conversationId,
    surfaceClientId: request.surfaceClientId,
    events,
    retainedFromCursor: start,
    nextCursor: page.at(-1)?.cursor ?? from ?? start,
    safeCursor,
    hasMore: page.length < remaining.length,
  };
}
