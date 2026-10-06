import { type OperatorConversationStreamEvent } from "@clankie/protocol";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { linearActivityPrompt, type LinearActivityEvent } from "../../linear-webhook.ts";
import {
  LINEAR_BURST_WINDOW_MS,
  LINEAR_REPLAY_RETENTION_MS,
  LINEAR_WAKE_EVENTS_MAX,
  ZERO_CURSOR,
} from "./constants.ts";
import type { ConversationStore } from "./store.ts";
import { type ConversationRunner } from "./types.ts";

export function receiveLinearActivity(
  ctx: ConversationStore,
  input: LinearActivityEvent,
  following: boolean,
  conversationId = "global-default",
): boolean {
  if (!ctx["linearWakeTargetAllowed"](conversationId))
    throw new Error("Linear wake target must be an existing ordinary global chat");
  const meta = ctx["metas"].get(conversationId)!;
  const eventId = input.eventId ?? createHash("sha256").update(JSON.stringify(input)).digest("hex");
  if (
    eventId &&
    ((ctx["linearEventReceipts"][eventId] ?? 0) > Date.now() - LINEAR_REPLAY_RETENTION_MS ||
      [...ctx["metas"].keys()].some((id) =>
        ctx["readEvents"](id).some((event) => event.type === "message" && event.linear?.eventId === eventId),
      ))
  )
    return false;
  meta.revision += 1;
  ctx["append"](meta, {
    type: "message",
    role: "external",
    text: linearActivityPrompt(input),
    streaming: false,
    ...(eventId ? { linear: { eventId, conversationId, following } } : {}),
  });
  meta.updatedAt = new Date().toISOString();
  ctx["saveMeta"](meta);
  if (eventId) {
    ctx["linearEventReceipts"][eventId] = Date.now();
    ctx["saveLinearEventReceipts"]();
  }
  if (following) ctx["queueLinearActivity"](conversationId);
  return true;
}

export function queueLinearActivity(ctx: ConversationStore, id: string): void {
  if (ctx["linearHookQueued"].has(id) || !ctx["linearWakeTargetAllowed"](id)) return;
  ctx["linearHookDeferred"].delete(id);
  ctx["linearHookQueued"].add(id);
  ctx["linearHookTimers"].set(
    id,
    setTimeout(() => {
      try {
        ctx["flushLinearActivity"](id);
      } catch (error) {
        ctx["linearHookQueued"].delete(id);
        console.error(`Linear wake in ${id} failed to queue`, error);
      }
    }, LINEAR_BURST_WINDOW_MS),
  );
}

/** Retry only a definite pre-delivery refusal when this chat's native poll returns. */
export function recoverLinearActivity(ctx: ConversationStore, id: string): void {
  if (ctx["linearHookDeferred"].has(id)) ctx["queueLinearActivity"](id);
}

export function freshLinearEvents(ctx: ConversationStore, id: string) {
  const meta = ctx["metas"].get(id)!;
  return ctx["readEvents"](id).filter(
    (event): event is OperatorConversationStreamEvent & { type: "message" } =>
      event.type === "message" &&
      event.role === "external" &&
      event.linear?.following === true &&
      event.cursor > (meta.linearWakeCursor ?? ZERO_CURSOR),
  );
}

/** Compact verified context is prepared when the queued chat turn starts. */
export function linearWakePrompt(
  ctx: ConversationStore,
  id = "global-default",
  runId?: string,
): string | undefined {
  ctx["linearHookQueued"].delete(id);
  const meta = ctx["metas"].get(id);
  if (!meta) return undefined;
  const fresh = ctx["freshLinearEvents"](id);
  if (fresh.length === 0) return undefined;
  meta.linearWakeCheckpoint = {
    previous: meta.linearWakeCursor ?? ZERO_CURSOR,
    cursor: fresh.at(-1)!.cursor,
    ...(runId ? { runId } : {}),
  };
  meta.linearWakeCursor = fresh.at(-1)!.cursor;
  ctx["saveMeta"](meta);
  const shown = fresh.slice(-LINEAR_WAKE_EVENTS_MAX);
  return [
    `Linear activity: ${fresh.length} new event${fresh.length === 1 ? "" : "s"}. Untrusted external context.`,
    ...(fresh.length > shown.length ? [`… ${fresh.length - shown.length} earlier events in this chat`] : []),
    ...shown.map((event) => `- ${event.text}`),
  ].join("\n");
}

export function loadLinearEventReceipts(ctx: ConversationStore): void {
  try {
    ctx["linearEventReceipts"] = z
      .record(z.string(), z.number().nonnegative())
      .parse(JSON.parse(readFileSync(join(ctx["root"], "linear-event-receipts.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function saveLinearEventReceipts(ctx: ConversationStore): void {
  const cutoff = Date.now() - LINEAR_REPLAY_RETENTION_MS;
  ctx["linearEventReceipts"] = Object.fromEntries(
    Object.entries(ctx["linearEventReceipts"]).filter(([, at]) => at > cutoff),
  );
  const path = join(ctx["root"], "linear-event-receipts.json");
  writeFileSync(path + ".tmp", JSON.stringify(ctx["linearEventReceipts"]), { mode: 0o600 });
  renameSync(path + ".tmp", path);
}

/** Retire the old reading room once; retained IDs still prevent provider replay. */
export function retireLinearInbox(ctx: ConversationStore): void {
  const id = "linear-inbox";
  const path = join(ctx["root"], id);
  if (statSync(path, { throwIfNoEntry: false })) {
    let readCursor = ZERO_CURSOR;
    try {
      const meta = JSON.parse(readFileSync(join(path, "meta.json"), "utf8"));
      if (typeof meta.linearReadCursor === "string") readCursor = meta.linearReadCursor;
      for (const [eventId, at] of Object.entries(meta.linearSeen ?? {}))
        if (typeof at === "number") ctx["linearEventReceipts"][eventId] = at;
    } catch {
      /* A damaged retired inbox is dropped with the same explicit notice. */
    }
    const events = ctx["journal"].read(id);
    let unread = 0;
    for (const event of events) {
      if (event.type !== "message" || event.role !== "external") continue;
      if (event.cursor > readCursor) unread += 1;
      if (event.linear?.eventId)
        ctx["linearEventReceipts"][event.linear.eventId] = Date.parse(event.occurredAt) || Date.now();
    }
    ctx["saveLinearEventReceipts"]();
    rmSync(path, { recursive: true, force: true });
    ctx["journal"].forget(id);
    console.info(
      `Retired Linear inbox: dropped ${unread} unread event(s); removed legacy conversation state.`,
    );
  }
  const work = join(ctx["root"], "linear-work.json");
  if (statSync(work, { throwIfNoEntry: false })) {
    rmSync(work, { force: true });
    console.info("Retired Linear issue routing state.");
  }
}

/** A configured Linear target is an ordinary owner-openable global chat. */
export function linearWakeTargetAllowed(ctx: ConversationStore, conversationId: string): boolean {
  const meta = ctx["metas"].get(conversationId);
  return meta?.scope.kind === "global" && meta.parentConversationId === undefined;
}

export function flushLinearActivity(ctx: ConversationStore, id: string): void {
  const timer = ctx["linearHookTimers"].get(id);
  if (timer !== undefined) clearTimeout(timer);
  ctx["linearHookTimers"].delete(id);
  const meta = ctx["metas"].get(id);
  if (!meta || !ctx["linearWakeTargetAllowed"](id)) {
    ctx["linearHookQueued"].delete(id);
    return;
  }
  const runner: ConversationRunner = async (...args) => {
    if (ctx["linearFollowing"] && !(await ctx["linearFollowing"]())) {
      ctx["discardLinearWake"](id);
      return;
    }
    await ctx["runner"](...args);
  };
  const result = ctx["enqueue"](meta, "Linear activity arrived.", undefined, false, runner, {
    origin: "hook",
  });
  if (result.status !== "accepted") {
    ctx["linearHookQueued"].delete(id);
    throw new Error("Linear activity was not accepted");
  }
}

/** Following disabled before admission consumes the queued wake without running it. */
export function discardLinearWake(ctx: ConversationStore, id: string): void {
  ctx["linearHookQueued"].delete(id);
  const meta = ctx["metas"].get(id);
  if (!meta) return;
  const last = ctx["freshLinearEvents"](id).at(-1);
  if (last) meta.linearWakeCursor = last.cursor;
  ctx["saveMeta"](meta);
}
