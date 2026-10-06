import { isDeliveredImagePath, namedImagePaths } from "../../delivered-files.ts";
import type { HerdrSeatTranscript, HerdrTranscriptEntry } from "../herdr-transcript.ts";
import { transcriptEventBody, transcriptImageKey } from "./helpers.ts";
import { noteNativeTranscript } from "./service-handoff.ts";
import type { ConversationStore } from "./store.ts";
import { type ConversationMeta } from "./types.ts";
export function syncConversationTranscript(
  ctx: ConversationStore,
  conversationId: string | undefined,
  seatId: string,
  transcript: HerdrSeatTranscript,
  agentRole: "agent" | "captain" = "agent",
  workingDirectory?: string,
): void {
  const meta = conversationId === undefined ? undefined : ctx["metas"].get(conversationId);
  if (meta === undefined || transcript.entries.length === 0) return;
  transcript = {
    ...transcript,
    entries: transcript.entries.filter((entry) => entry.type !== "message" || !entry.internal),
  };
  const room = meta.scope.kind === "room";
  const checkpoint = room ? meta.roomTranscripts?.[transcript.sessionKey] : meta.seatTranscript;
  // A persona thread seeded before native transcripts existed is rebuilt
  // from the transcript once; the head thread is his own history and only
  // ever grows.
  if (
    agentRole === "agent" &&
    checkpoint === undefined &&
    ctx["retainedEventCount"](meta.conversationId) > 0
  ) {
    ctx["replaceSeatEntries"](meta, transcript.entries);
    meta.seatTranscript = {
      sessionKey: transcript.sessionKey,
      entryIds: transcript.entries.flatMap((entry) =>
        entry.type === "viewed_image" && isDeliveredImagePath(entry.path) ? [] : [entry.id],
      ),
    };
    ctx["saveMeta"](meta);
    ctx["publishTranscriptImages"](meta, transcript, workingDirectory);
    return;
  }

  // ponytail: legacy checkpoints append their newly typed historical tools once;
  // add a cursor/reaction-remapping migration only if pre-upgrade ordering matters.
  const checkpointIds = checkpoint?.entryIds ?? checkpoint?.messageIds ?? [];
  // Native IDs are unique across sessions. Captain history keeps their IDs when
  // a seat resumes or both the native hook and Herdr observe the same record.
  const captainThread = meta.scope.kind === "global" || meta.scope.kind === "workspace";
  const seen = new Set(
    captainThread || checkpoint?.sessionKey === transcript.sessionKey ? checkpointIds : [],
  );
  let latestAgentReply: string | undefined;
  const added: HerdrTranscriptEntry[] = [];
  // A tailing seat re-publishes the same transcript while it works; without
  // this the checkpoint would be rewritten to disk on every quiet pass.
  let advanced = false;
  for (const entry of transcript.entries) {
    if (seen.has(entry.id)) continue;
    if (entry.type === "viewed_image") {
      if (!isDeliveredImagePath(entry.path)) {
        advanced = true;
        seen.add(entry.id);
        continue;
      }
      if (workingDirectory === undefined) continue;
      if (ctx["pendingTranscriptImages"].has(transcriptImageKey(meta, transcript.sessionKey, entry.id))) {
        continue;
      }
    }
    advanced = true;
    added.push(entry);
    if (entry.type === "message" && entry.role === "agent") {
      latestAgentReply = entry.text;
    }
    if (entry.type === "viewed_image") {
      continue;
    }
    if (entry.type !== "message" || entry.role !== "operator" || !ctx["matchesRecentSeatSend"](meta, entry)) {
      const body = transcriptEventBody(entry, agentRole);
      ctx["append"](
        meta,
        room && body.type === "message" && body.role === "operator" ? { ...body, role: "external" } : body,
        entry.occurredAt,
        captainThread && checkpoint?.sessionKey === transcript.sessionKey,
      );
    }
    seen.add(entry.id);
  }
  if (!advanced) return;
  noteNativeTranscript(meta, ctx["lastCursor"](meta));
  ctx["resettle"](meta);
  const nextCheckpoint = { sessionKey: transcript.sessionKey, entryIds: [...seen] };
  if (room) (meta.roomTranscripts ??= {})[transcript.sessionKey] = nextCheckpoint;
  else meta.seatTranscript = nextCheckpoint;
  meta.updatedAt = room ? (added.at(-1)?.occurredAt ?? meta.updatedAt) : new Date().toISOString();
  ctx["saveMeta"](meta);
  ctx["publishTranscriptImages"](
    meta,
    { sessionKey: transcript.sessionKey, entries: added },
    workingDirectory,
  );
  if (latestAgentReply !== undefined) ctx["resolveSeatReply"](seatId, latestAgentReply);
}

export function resettle(ctx: ConversationStore, meta: ConversationMeta): void {
  const events = ctx["readEvents"](meta.conversationId);
  const settled = events.findLastIndex((event) => event.type === "activity");
  if (settled === events.length - 1) return;
  const last = events[settled];
  if (last?.type === "activity" && last.phase === "waiting") {
    ctx["append"](meta, { type: "activity", phase: "waiting" });
  }
}

export function publishTranscriptImages(
  ctx: ConversationStore,
  meta: ConversationMeta,
  transcript: HerdrSeatTranscript,
  workingDirectory: string | undefined,
): void {
  if (workingDirectory === undefined) return;
  for (const entry of transcript.entries) {
    if (entry.type === "viewed_image") {
      if (!isDeliveredImagePath(entry.path)) continue;
      const key = transcriptImageKey(meta, transcript.sessionKey, entry.id);
      if (ctx["pendingTranscriptImages"].has(key)) continue;
      ctx["pendingTranscriptImages"].add(key);
      const attempts = (ctx["transcriptImageAttempts"].get(key) ?? 0) + 1;
      ctx["transcriptImageAttempts"].set(key, attempts);
      void ctx["queueDeliveredImages"](meta, [entry.path], workingDirectory).then((published) => {
        ctx["pendingTranscriptImages"].delete(key);
        if (published || attempts >= 2) {
          ctx["transcriptImageAttempts"].delete(key);
          ctx["completeTranscriptImage"](meta, transcript.sessionKey, entry.id);
        }
      });
    } else if (entry.type === "message" && entry.role === "agent") {
      ctx["publishNamedImages"](meta, entry.text, workingDirectory);
    }
  }
}

export function publishNamedImages(
  ctx: ConversationStore,
  meta: ConversationMeta,
  text: string,
  workingDirectory: string,
): void {
  // ponytail: four per message, the visual cap a Discord turn uses; raise it if seats show more at once.
  void ctx["queueDeliveredImages"](meta, namedImagePaths(text).slice(0, 4), workingDirectory);
}

export function queueDeliveredImages(
  ctx: ConversationStore,
  meta: ConversationMeta,
  paths: readonly string[],
  workingDirectory: string,
): Promise<boolean> {
  if (ctx["publishDeliveredFile"] === undefined || paths.length === 0) return Promise.resolve(false);
  const conversationId = meta.conversationId;
  const previous = ctx["deliveredFilePublishes"].get(conversationId) ?? Promise.resolve();
  const result = previous.then(() => ctx["publishImages"](meta, paths, workingDirectory));
  const queued = result.then(() => undefined);
  ctx["deliveredFilePublishes"].set(conversationId, queued);
  void queued.finally(() => {
    if (ctx["deliveredFilePublishes"].get(conversationId) === queued) {
      ctx["deliveredFilePublishes"].delete(conversationId);
    }
  });
  return result;
}

export async function publishImages(
  ctx: ConversationStore,
  meta: ConversationMeta,
  paths: readonly string[],
  workingDirectory: string,
): Promise<boolean> {
  let published = false;
  for (const path of paths) {
    try {
      const { artifactId, filename, mediaType, byteCount, sha256 } = await ctx["publishDeliveredFile"]!({
        conversationId: meta.conversationId,
        sourceRoot: workingDirectory,
        path,
      });
      if (!ctx["metas"].has(meta.conversationId)) return published;
      const shown = ctx["readEvents"](meta.conversationId).some(
        (event) => event.type === "file" && event.file.artifactId === artifactId,
      );
      if (shown) {
        published = true;
        continue;
      }
      ctx["append"](meta, { type: "file", file: { artifactId, filename, mediaType, byteCount, sha256 } });
      ctx["resettle"](meta);
      published = true;
    } catch {
      // Named, but not deliverable from here.
    }
  }
  return published;
}

export function completeTranscriptImage(
  ctx: ConversationStore,
  meta: ConversationMeta,
  sessionKey: string,
  entryId: string,
): void {
  if (ctx["metas"].get(meta.conversationId) !== meta || meta.seatTranscript?.sessionKey !== sessionKey) {
    return;
  }
  const entryIds = meta.seatTranscript.entryIds ?? meta.seatTranscript.messageIds ?? [];
  if (entryIds.includes(entryId)) return;
  meta.seatTranscript = { sessionKey, entryIds: [...entryIds, entryId] };
  ctx["saveMeta"](meta);
}
