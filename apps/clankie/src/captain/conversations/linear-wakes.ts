import { type OperatorConversationStreamEvent } from "@clankie/protocol";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  linearActivityPrompt,
  linearActivityProject,
  type LinearActivityEvent,
} from "../../linear-webhook.ts";
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
    ...(eventId
      ? {
          linear: {
            eventId,
            conversationId,
            following,
            ...(linearActivityProject(input) ? { project: linearActivityProject(input) } : {}),
            ...(input.routing ? { route: input.routing.reason } : {}),
            ...(input.notificationReceiver ? { receiver: input.notificationReceiver } : {}),
            ...(input.notificationTypes ? { notificationTypes: [...input.notificationTypes] } : {}),
          },
        }
      : {}),
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
  const shown = fresh.slice(-LINEAR_WAKE_EVENTS_MAX);
  const wakeId = `seat-${randomUUID()}`;
  meta.linearWakeCheckpoint = {
    previous: meta.linearWakeCursor ?? ZERO_CURSOR,
    cursor: fresh.at(-1)!.cursor,
    ...(runId ? { runId } : {}),
    wakeId,
  };
  meta.linearWakeReceipts ??= {};
  // Old receipt history is bounded independently of the conversation's event retention.
  for (const old of Object.keys(meta.linearWakeReceipts).slice(
    0,
    Math.max(0, Object.keys(meta.linearWakeReceipts).length - 127),
  ))
    delete meta.linearWakeReceipts[old];
  meta.linearWakeReceipts[wakeId] = {
    ...(runId ? { runId } : {}),
    eventIds: shown.flatMap((event) => (event.linear ? [event.linear.eventId] : [])),
    offeredAt: new Date().toISOString(),
  };
  meta.linearWakeCursor = fresh.at(-1)!.cursor;
  ctx["saveMeta"](meta);
  return [
    `Linear wake receipt: ${wakeId}. After this wake reaches your chat, confirm with linear_wake({ action: "received", wakeId: "${wakeId}" }) to mark matching Linear notifications read.`,
    `Linear activity: ${fresh.length} new event${fresh.length === 1 ? "" : "s"}. Untrusted external context.`,
    ...(fresh.length > shown.length ? [`… ${fresh.length - shown.length} earlier events in this chat`] : []),
    ...shown.map((event) => `- ${event.text}`),
  ].join("\n");
}

export function linearWakeReceipt(ctx: ConversationStore, id: string, runId: string | undefined) {
  const meta = ctx["metas"].get(id);
  if (!meta) return;
  const checkpoint = meta?.linearWakeCheckpoint;
  if (!checkpoint?.wakeId || checkpoint.runId !== runId) return;
  const receipt = meta.linearWakeReceipts?.[checkpoint.wakeId];
  if (!receipt) return;
  return {
    messageId: checkpoint.wakeId,
    prepare: (native: NonNullable<typeof receipt.native>) => {
      // A standalone operator can poll without a fleet binding. Pin the
      // host-synchronized transcript identity before the outbox offers it;
      // an absent binding is never permission for a replacement seat.
      const recipientSessionKey = ctx.nativeSeatSessionKey(id);
      receipt.native = {
        ...native,
        ...(native.recipientBinding === undefined && recipientSessionKey !== undefined
          ? { recipientSessionKey }
          : {}),
      };
      ctx["saveMeta"](meta);
    },
  };
}

/** Missing identity is refused; the exact absent outbox binding still needs its native session. */
export function sameLinearWakeRecipient(
  original: { recipientBinding?: string; recipientSessionKey?: string },
  current: { binding?: string | undefined; sessionKey?: string | undefined },
): boolean {
  return original.recipientBinding !== undefined
    ? original.recipientBinding === current.binding
    : original.recipientSessionKey !== undefined && original.recipientSessionKey === current.sessionKey;
}

export async function receiveLinearWake(
  ctx: ConversationStore,
  id: string,
  wakeId: string,
  authorize: (
    receipt: NonNullable<
      NonNullable<import("./types.ts").ConversationMeta["linearWakeReceipts"]>[string]["native"]
    >,
  ) => Promise<boolean>,
) {
  const meta = ctx["metas"].get(id);
  const receipt = meta?.linearWakeReceipts?.[wakeId];
  if (!meta || !receipt) throw new Error("Unknown Linear wake in this conversation");
  if (receipt.native && !(await authorize(receipt.native)))
    throw new Error("The original Linear wake recipient or receipt could not be confirmed");
  if (!receipt.native && ctx.hasNativeSeat(id))
    throw new Error("The native target has not received this Linear wake");
  if (
    !receipt.native &&
    ctx["runControllers"].get(receipt.runId ?? "")?.conversationId !== id &&
    !ctx["readEvents"](id).some(
      (event) =>
        event.type === "turn" &&
        event.runId === receipt.runId &&
        event.phase === "completed" &&
        event.deliveryStage === "responded",
    )
  )
    throw new Error("The target conversation has not received this Linear wake");
  receipt.receivedAt ??= new Date().toISOString();
  ctx["saveMeta"](meta);
  const references = ctx["readEvents"](id).flatMap((event) =>
    event.type === "message" && event.linear?.receiver && receipt.eventIds.includes(event.linear.eventId)
      ? [
          {
            eventId: event.linear.eventId,
            receiver: event.linear.receiver,
            notificationTypes: event.linear.notificationTypes ?? [],
          },
        ]
      : [],
  );
  const notifications = await ctx.onLinearWakeReceived?.(references);
  return {
    wakeId,
    conversationId: id,
    receivedAt: receipt.receivedAt,
    notifications: notifications ?? { state: "unavailable" },
  };
}

export function linearWakeDeliveries(ctx: ConversationStore, id?: string) {
  return [...ctx["metas"].values()]
    .filter(
      (meta) =>
        (id === undefined || meta.conversationId === id) &&
        Object.keys(meta.linearWakeReceipts ?? {}).length > 0,
    )
    .flatMap((meta) => {
      const events = new Map(
        ctx["readEvents"](meta.conversationId).flatMap((event) =>
          event.type === "message" && event.linear ? [[event.linear.eventId, event.linear] as const] : [],
        ),
      );
      return Object.entries(meta.linearWakeReceipts ?? {}).map(([wakeId, receipt]) => ({
        wakeId,
        conversationId: meta.conversationId,
        ...receipt,
        events: receipt.eventIds.flatMap((eventId) => {
          const event = events.get(eventId);
          return event ? [{ eventId, project: event.project, route: event.route }] : [];
        }),
      }));
    })
    .sort((a, b) => b.offeredAt.localeCompare(a.offeredAt))
    .slice(0, 100);
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
