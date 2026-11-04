import { isDeliveredImagePath, namedImagePaths } from "../../delivered-files.ts";
import type { OperatorConversationStreamEvent } from "@clankie/protocol";
import type {
  HerdrSeatTranscript,
  HerdrTranscriptEntry,
  HerdrTranscriptMessage,
} from "../herdr-transcript.ts";
import { CURSOR_WIDTH } from "./constants.ts";
import { messageKey, transcriptEventBody, transcriptImageKey } from "./helpers.ts";
import { resolveSeatReply } from "./channel-projection.ts";
import { noteNativeTranscript } from "./service-handoff.ts";
import type { ConversationStore } from "./store.ts";
import { type ConversationMeta } from "./types.ts";
/** Per store: transcript images being published, and how many times each was tried. */
const imagePublishes = new WeakMap<
  ConversationStore,
  { readonly pending: Set<string>; readonly attempts: Map<string, number> }
>();
function transcriptImages(ctx: ConversationStore) {
  let held = imagePublishes.get(ctx);
  if (!held) imagePublishes.set(ctx, (held = { pending: new Set(), attempts: new Map() }));
  return held;
}

export function syncConversationTranscript(
  ctx: ConversationStore,
  conversationId: string | undefined,
  seatId: string,
  transcript: HerdrSeatTranscript,
  agentRole: "agent" | "captain" = "agent",
  workingDirectory?: string,
): void {
  const meta = conversationId === undefined ? undefined : ctx["metas"].get(conversationId);
  if (meta === undefined) return;
  if (agentRole === "captain" && meta.nativeSeatSessionKey !== transcript.sessionKey) {
    ctx["currentActivities"].clear(meta.conversationId);
    meta.nativeSeatSessionKey = transcript.sessionKey;
    ctx["saveMeta"](meta);
  }
  if (transcript.entries.length === 0) return;
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
    replaceSeatEntries(ctx, meta, transcript.entries);
    meta.seatTranscript = {
      sessionKey: transcript.sessionKey,
      entryIds: transcript.entries.flatMap((entry) =>
        entry.type === "viewed_image" && isDeliveredImagePath(entry.path) ? [] : [entry.id],
      ),
    };
    ctx["saveMeta"](meta);
    publishTranscriptImages(ctx, meta, transcript, workingDirectory);
    return;
  }

  // ponytail: legacy checkpoints append their newly typed historical tools once;
  // add a cursor/reaction-remapping migration only if pre-upgrade ordering matters.
  const checkpointIds = checkpoint?.entryIds ?? checkpoint?.messageIds ?? [];
  // Native IDs are unique across sessions. Captain history keeps their IDs when
  // a seat resumes or both the native hook and Herdr observe the same record.
  const captainThread = meta.scope.kind === "global" || meta.scope.kind === "workspace";
  const index = captainThread ? ctx["transcriptCheckpoint"](meta, transcript.sessionKey) : undefined;
  if (captainThread && checkpoint?.index === undefined) ctx["saveMeta"](meta);
  const seen = new Set(
    index === undefined && checkpoint?.sessionKey === transcript.sessionKey ? checkpointIds : [],
  );
  let latestAgentReply: string | undefined;
  const added: HerdrTranscriptEntry[] = [];
  // A tailing seat re-publishes the same transcript while it works; without
  // this the checkpoint would be rewritten to disk on every quiet pass.
  let advanced = false;
  for (const entry of transcript.entries) {
    if (seen.has(entry.id) || index?.has(entry.id)) continue;
    if (entry.type === "viewed_image") {
      if (!isDeliveredImagePath(entry.path)) {
        advanced = true;
        seen.add(entry.id);
        continue;
      }
      if (workingDirectory === undefined) continue;
      if (transcriptImages(ctx).pending.has(transcriptImageKey(meta, transcript.sessionKey, entry.id))) {
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
    if (entry.type !== "message" || entry.role !== "operator" || !matchesRecentSeatSend(ctx, meta, entry)) {
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
  resettle(ctx, meta);
  index?.add(seen);
  const nextCheckpoint = {
    sessionKey: transcript.sessionKey,
    ...(index === undefined ? { entryIds: [...seen] } : { index: "sqlite-v1" as const }),
  };
  if (room) (meta.roomTranscripts ??= {})[transcript.sessionKey] = nextCheckpoint;
  else meta.seatTranscript = nextCheckpoint;
  meta.updatedAt = room ? (added.at(-1)?.occurredAt ?? meta.updatedAt) : new Date().toISOString();
  ctx["saveMeta"](meta);
  publishTranscriptImages(ctx, meta, { sessionKey: transcript.sessionKey, entries: added }, workingDirectory);
  if (latestAgentReply !== undefined) resolveSeatReply(ctx, seatId, latestAgentReply);
}

function resettle(ctx: ConversationStore, meta: ConversationMeta): void {
  const events = ctx["readEvents"](meta.conversationId);
  const settled = events.findLastIndex((event) => event.type === "activity");
  if (settled === events.length - 1) return;
  const last = events[settled];
  if (last?.type === "activity" && last.phase === "waiting") {
    ctx["append"](meta, { type: "activity", phase: "waiting" });
  }
}

function publishTranscriptImages(
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
      if (transcriptImages(ctx).pending.has(key)) continue;
      transcriptImages(ctx).pending.add(key);
      const attempts = (transcriptImages(ctx).attempts.get(key) ?? 0) + 1;
      transcriptImages(ctx).attempts.set(key, attempts);
      void queueDeliveredImages(ctx, meta, [entry.path], workingDirectory).then((published) => {
        transcriptImages(ctx).pending.delete(key);
        if (published || attempts >= 2) {
          transcriptImages(ctx).attempts.delete(key);
          completeTranscriptImage(ctx, meta, transcript.sessionKey, entry.id);
        }
      });
    } else if (entry.type === "message" && entry.role === "agent") {
      publishNamedImages(ctx, meta, entry.text, workingDirectory);
    }
  }
}

function publishNamedImages(
  ctx: ConversationStore,
  meta: ConversationMeta,
  text: string,
  workingDirectory: string,
): void {
  // ponytail: four per message, the visual cap a Discord turn uses; raise it if seats show more at once.
  void queueDeliveredImages(ctx, meta, namedImagePaths(text).slice(0, 4), workingDirectory);
}

function queueDeliveredImages(
  ctx: ConversationStore,
  meta: ConversationMeta,
  paths: readonly string[],
  workingDirectory: string,
): Promise<boolean> {
  if (ctx["publishDeliveredFile"] === undefined || paths.length === 0) return Promise.resolve(false);
  const conversationId = meta.conversationId;
  const previous = ctx["deliveredFilePublishes"].get(conversationId) ?? Promise.resolve();
  const result = previous.then(() => publishImages(ctx, meta, paths, workingDirectory));
  const queued = result.then(() => undefined);
  ctx["deliveredFilePublishes"].set(conversationId, queued);
  void queued.finally(() => {
    if (ctx["deliveredFilePublishes"].get(conversationId) === queued) {
      ctx["deliveredFilePublishes"].delete(conversationId);
    }
  });
  return result;
}

async function publishImages(
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
      resettle(ctx, meta);
      published = true;
    } catch {
      // Named, but not deliverable from here.
    }
  }
  return published;
}

function completeTranscriptImage(
  ctx: ConversationStore,
  meta: ConversationMeta,
  sessionKey: string,
  entryId: string,
): void {
  if (ctx["metas"].get(meta.conversationId) !== meta || meta.seatTranscript?.sessionKey !== sessionKey) {
    return;
  }
  if (meta.seatTranscript.index !== undefined) {
    ctx["transcriptCheckpoint"](meta, sessionKey).add([entryId]);
    return;
  }
  const entryIds = meta.seatTranscript.entryIds ?? meta.seatTranscript.messageIds ?? [];
  if (entryIds.includes(entryId)) return;
  meta.seatTranscript = { sessionKey, entryIds: [...entryIds, entryId] };
  ctx["saveMeta"](meta);
}

function matchesRecentSeatSend(
  ctx: ConversationStore,
  meta: ConversationMeta,
  message: HerdrTranscriptMessage,
): boolean {
  const previous = ctx["readEvents"](meta.conversationId).findLast(
    (event) => event.type === "message" && event.role === "operator",
  );
  if (previous?.type !== "message" || previous.role !== "operator" || previous.text !== message.text) {
    return false;
  }
  const nativeAt = Date.parse(message.occurredAt ?? "");
  return !Number.isFinite(nativeAt) || Math.abs(Date.parse(previous.occurredAt) - nativeAt) < 60_000;
}

/** One-time migration from the old last-answer projection to the native ordered transcript. */
function replaceSeatEntries(
  ctx: ConversationStore,
  meta: ConversationMeta,
  transcript: readonly HerdrTranscriptEntry[],
): void {
  const events = ctx["readEvents"](meta.conversationId);
  const covered = new Map<string, number>();
  for (const message of transcript) {
    if (message.type !== "message") continue;
    const key = messageKey(message.role, message.text);
    covered.set(key, (covered.get(key) ?? 0) + 1);
  }
  const preserved = events.flatMap((event) => {
    if (event.type !== "message") return [];
    const role = event.role === "agent" ? "agent" : event.role === "operator" ? "operator" : undefined;
    if (role === undefined) return [];
    const key = messageKey(role, event.text);
    const remaining = covered.get(key) ?? 0;
    if (remaining > 0) {
      covered.set(key, remaining - 1);
      return [];
    }
    return [
      {
        body: { type: "message" as const, role, text: event.text, streaming: false as const },
        occurredAt: event.occurredAt,
      },
    ];
  });
  const projected = transcript.flatMap((entry) =>
    entry.type === "viewed_image"
      ? []
      : [
          {
            body: transcriptEventBody(entry, "agent"),
            occurredAt: entry.occurredAt ?? new Date().toISOString(),
          },
        ],
  );
  const previousSequence = ctx["eventSequence"](meta);
  let sequence = previousSequence + 1;
  meta.retainedFromCursor = String(sequence).padStart(CURSOR_WIDTH, "0");
  const rebuilt = [...preserved, ...projected].map(({ body, occurredAt }) => {
    sequence += 1;
    return {
      schemaVersion: 1 as const,
      conversationId: meta.conversationId,
      cursor: String(sequence).padStart(CURSOR_WIDTH, "0"),
      revision: meta.revision,
      occurredAt,
      ...body,
    } as OperatorConversationStreamEvent;
  });
  ctx["journal"].rewrite(meta.conversationId, rebuilt);
  ctx["counts"].set(meta.conversationId, rebuilt.length);
  ctx["sequences"].set(meta.conversationId, sequence);
  ctx["wakeTails"](meta.conversationId);
}
