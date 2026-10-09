import {
  type OperatorChannelMember,
  type OperatorConversation,
  type OperatorConversationEventBody,
  type OperatorConversationStreamEvent,
} from "@clankie/protocol";
import { nativeSessionId } from "../native-session-resume.ts";
import { createHash } from "node:crypto";
import { ConversationServiceRun, waitForConversationRun } from "../conversation-run.ts";
import type { HerdrSeatTranscript } from "../herdr-transcript.ts";
import type { HerdrAgentSnapshot } from "../herdr-watch.ts";
import { publicConversation } from "./helpers.ts";
import { recoverLinearActivity } from "./linear-wakes.ts";
import type { ConversationStore } from "./store.ts";
import { type ConversationDriver, type ConversationMeta } from "./types.ts";

export function conversationIdForSeat(ctx: ConversationStore, seatId: string): string | undefined {
  return [...ctx["metas"].values()].find((meta) => meta.scope.kind === "seat" && meta.scope.seatId === seatId)
    ?.conversationId;
}

export function metaForPersona(ctx: ConversationStore, personaId: string): ConversationMeta | undefined {
  return [...ctx["metas"].values()].find(
    (meta) => meta.scope.kind === "persona" && meta.scope.personaId === personaId,
  );
}

export function conversationIdForPersona(ctx: ConversationStore, personaId: string): string | undefined {
  return ctx["metaForPersona"](personaId)?.conversationId;
}

/**
 * The persona's durable thread, for surfaces that order an inbox by what
 * happened last. `updatedAt` is the whole record's last activity — an
 * operator turn, a run settling, or a folded seat transcript all move it —
 * so it says when this thread last had something to show.
 */
export function conversationForPersona(
  ctx: ConversationStore,
  personaId: string,
): OperatorConversation | undefined {
  const meta = ctx["metaForPersona"](personaId);
  return meta === undefined ? undefined : publicConversation(meta);
}

export function renamePersona(ctx: ConversationStore, personaId: string, title: string): void {
  const conversationId = ctx["conversationIdForPersona"](personaId);
  const meta = conversationId === undefined ? undefined : ctx["metas"].get(conversationId);
  if (meta === undefined || meta.title === title) return;
  meta.title = title;
  meta.updatedAt = new Date().toISOString();
  ctx["saveMeta"](meta);
}

/**
 * Bind a durable character to its current seat and carry any legacy seat DM
 * and channel membership forward without copying or splitting transcripts.
 */
export function bindPersona(
  ctx: ConversationStore,
  personaId: string,
  seatId: string,
  title: string,
): string {
  const current = ctx["conversationIdForPersona"](personaId);
  if (current !== undefined) ctx["renamePersona"](personaId, title);
  const legacy =
    current === undefined
      ? [...ctx["metas"].values()].find((meta) => meta.scope.kind === "seat" && meta.scope.seatId === seatId)
      : undefined;
  if (legacy !== undefined && current === undefined) {
    legacy.scope = { kind: "persona", personaId };
    legacy.title = title;
    legacy.updatedAt = new Date().toISOString();
    ctx["saveMeta"](legacy);
  }
  for (const channel of ctx["metas"].values()) {
    if (channel.scope.kind !== "channel" || channel.channelMembers === undefined) continue;
    let changed = false;
    channel.channelMembers = channel.channelMembers.map((member) => {
      const raw = member as OperatorChannelMember & { readonly seatId?: string };
      if (raw.seatId !== seatId) return member;
      changed = true;
      return { personaId, position: member.position, joinedAt: member.joinedAt };
    });
    if (changed) ctx["saveMeta"](channel);
  }
  return (
    current ?? legacy?.conversationId ?? ctx["create"]({ kind: "persona", personaId }, title).conversationId
  );
}

export function seatIds(ctx: ConversationStore): readonly string[] {
  return [...ctx["metas"].values()].flatMap((meta) =>
    meta.scope.kind === "seat" ? [meta.scope.seatId] : [],
  );
}

export function publishPersonaEvent(
  ctx: ConversationStore,
  personaId: string,
  seatId: string,
  body: OperatorConversationEventBody,
): void {
  // Before the seat's own thread, and regardless of whether it has one: a
  // channel round offered this seat a turn and is waiting on exactly this.
  if (body.type === "message" && body.role === "agent") ctx["resolveSeatReply"](seatId, body.text);
  const conversationId = ctx["conversationIdForPersona"](personaId);
  ctx["publishConversationEvent"](conversationId, body);
}

/** Legacy test/API path while persisted seat scopes migrate on discovery. */
export function publishSeatEvent(
  ctx: ConversationStore,
  seatId: string,
  body: OperatorConversationEventBody,
): void {
  if (body.type === "message" && body.role === "agent") ctx["resolveSeatReply"](seatId, body.text);
  ctx["publishConversationEvent"](ctx["conversationIdForSeat"](seatId), body);
}

/** Peer exchanges are visible context, never inbound owner turns or seat replies. */
export function publishFleetPeerExchange(ctx: ConversationStore, text: string): void {
  ctx["publishConversationEvent"](ctx["defaultGlobalConversationId"](), {
    type: "message",
    role: "agent",
    text,
    streaming: false,
  });
}

export function publishConversationEvent(
  ctx: ConversationStore,
  conversationId: string | undefined,
  body: OperatorConversationEventBody,
): void {
  const meta = conversationId === undefined ? undefined : ctx["metas"].get(conversationId);
  if (meta === undefined) return;
  const events = ctx["readEvents"](meta.conversationId);
  if (body.type === "activity") {
    const previous = events.findLast((event) => event.type === "activity");
    if (previous?.type === "activity" && previous.phase === body.phase) return;
  }
  if (body.type === "message" && body.role === "agent") {
    const previous = events.findLast((event) => event.type === "message" && event.role === "agent");
    if (previous?.type === "message" && previous.role === "agent" && previous.text === body.text) return;
  }
  ctx["append"](meta, body);
  meta.updatedAt = new Date().toISOString();
  ctx["saveMeta"](meta);
}

export function nativeAnnotations(
  ctx: ConversationStore,
  conversationId: string,
): readonly OperatorConversationStreamEvent[] {
  return ctx["readEvents"](conversationId).filter(
    (event) => event.type === "reaction" || event.type === "file",
  );
}

export function reactToNativeEntry(
  ctx: ConversationStore,
  conversationId: string,
  entryRef: string,
  emoji: string,
  remove: boolean,
): boolean {
  const meta = ctx["metas"].get(conversationId);
  if (meta === undefined) return false;
  ctx["append"](meta, { type: "reaction", entryRef, emoji, reactor: { kind: "operator" }, removed: remove });
  meta.updatedAt = new Date().toISOString();
  ctx["saveMeta"](meta);
  return true;
}

export function nativeSource(ctx: ConversationStore, conversationId: string): HerdrAgentSnapshot | undefined {
  return ctx["metas"].get(conversationId)?.nativeSource;
}

/** Reuse the current persona thread after legacy seat-scope migration. */
export function nativeConversationForSeat(
  ctx: ConversationStore,
  source: HerdrAgentSnapshot,
): OperatorConversation | undefined {
  const matches = [...ctx["metas"].values()].filter((meta) => {
    if (meta.scope.kind === "seat") return meta.scope.seatId === source.terminalId;
    if (meta.scope.kind !== "persona") return false;
    if (ctx["seatForPersona"]?.(meta.scope.personaId) === source.terminalId) return true;
    const native = meta.nativeSource;
    return (
      native?.paneId === source.paneId &&
      native.terminalId === source.terminalId &&
      JSON.stringify(native.session) === JSON.stringify(source.session)
    );
  });
  if (matches.length > 1) throw new Error("Native lead has ambiguous existing conversation threads");
  return matches[0] === undefined ? undefined : publicConversation(matches[0]);
}

/** Existing authenticated transcript attachment, never a pane/title guess. */
export function attachedConversationForNative(
  ctx: ConversationStore,
  source: HerdrAgentSnapshot,
): string | undefined {
  if (!source.session) return undefined;
  const sessionId =
    nativeSessionId(source) ??
    source.session.value
      .split(/[\\/]/u)
      .at(-1)
      ?.replace(/\.jsonl$/u, "");
  const matches = [...ctx["metas"].values()].filter((meta) => {
    if (meta.scope.kind !== "global" && meta.scope.kind !== "workspace" && meta.scope.kind !== "room")
      return false;
    const native = meta.nativeSource;
    if (
      native &&
      (native.paneId !== source.paneId ||
        native.terminalId !== source.terminalId ||
        JSON.stringify(native.session) !== JSON.stringify(source.session))
    )
      return false;
    return (
      native !== undefined || (sessionId !== undefined && meta.nativeSeatSessions?.[sessionId] === "current")
    );
  });
  if (matches.length > 1) throw new Error("Native parent has ambiguous conversation attachment");
  return matches[0]?.conversationId;
}

export function rememberNativeSource(
  ctx: ConversationStore,
  conversationId: string,
  source: HerdrAgentSnapshot,
): void {
  const meta = ctx["metas"].get(conversationId);
  if (meta === undefined || JSON.stringify(meta.nativeSource) === JSON.stringify(source)) return;
  // Driver attachment does not resolve an unanswered owner question.
  meta.nativeSource = source;
  ctx["saveMeta"](meta);
}

/**
 * Reserve attachment before awaiting any service work. Polling itself remains
 * the existing mailbox's proof of liveness; a remembered transcript alone is
 * never a driver. A service invocation admitted before this reservation owns
 * its turn through settlement, so its answer cannot race an attached seat.
 */
export async function pollConversationDriver<T>(
  ctx: ConversationStore,
  conversationId: string,
  poll: () => Promise<T>,
  signal?: AbortSignal,
  prepare?: () => Promise<void>,
): Promise<T> {
  if (!ctx["metas"].has(conversationId)) throw new Error(`Unknown conversation ${conversationId}`);
  let ready!: () => void;
  const admission = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const admissions = ctx["driverAdmissions"].get(conversationId) ?? new Set<Promise<void>>();
  admissions.add(admission);
  ctx["driverAdmissions"].set(conversationId, admissions);
  // Capture only work already admitted. Later work waits on this reservation.
  const service = [...(ctx["serviceDrives"].get(conversationId) ?? [])];
  let started: Promise<T>;
  try {
    const ready = Promise.all(service);
    if (signal === undefined) await ready;
    else await waitForConversationRun(ready, signal);
    if (prepare !== undefined) {
      if (signal === undefined) await prepare();
      else await waitForConversationRun(prepare(), signal);
    }
    signal?.throwIfAborted();
    if (!ctx["metas"].has(conversationId)) throw new Error(`Unknown conversation ${conversationId}`);
    // The callback establishes mailbox binding synchronously, before the
    // reservation is released. Never await the parked long poll here.
    started = poll();
    recoverLinearActivity(ctx, conversationId);
  } finally {
    admissions.delete(admission);
    if (admissions.size === 0 && ctx["driverAdmissions"].get(conversationId) === admissions)
      ctx["driverAdmissions"].delete(conversationId);
    ready();
  }
  return started;
}

/** Routing observations must wait for any native proof/policy preparation. */
export async function waitForDriverAdmission(
  ctx: ConversationStore,
  conversationId: string,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    const admissions = ctx["driverAdmissions"].get(conversationId);
    if (admissions === undefined || admissions.size === 0) break;
    const ready = Promise.all(admissions);
    if (signal === undefined) await ready;
    else await waitForConversationRun(ready, signal);
  }
  signal?.throwIfAborted();
}

/**
 * Choose the live execution driver at admission, then pin its exact dispatch.
 * Only a definite pre-delivery refusal may choose again. The selection and
 * service reservation have no await between them, closing the attach race.
 * Both stored operator runs and Discord's existing room turns use this fence.
 */
export async function runWithConversationDriver<T>(
  ctx: ConversationStore,
  conversationId: string,
  driver: () => ConversationDriver<T> | undefined,
  service: (run: ConversationServiceRun) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (;;) {
    // With no pending admission, selection must stay synchronous with its
    // service reservation; yielding here would let an attach race past it.
    for (;;) {
      if (!ctx["driverAdmissions"].get(conversationId)?.size) break;
      await waitForDriverAdmission(ctx, conversationId, signal);
    }
    signal?.throwIfAborted();
    if (!ctx["metas"].has(conversationId)) throw new Error(`Unknown conversation ${conversationId}`);
    const selected = driver();
    if (selected !== undefined) {
      const delivery = await selected.run();
      if (delivery.handled) return delivery.result;
      // A replacement may have attached while the old mailbox refused.
      // Recheck its admission and current liveness before starting service.
      continue;
    }
    let settled!: () => void;
    const invocation = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const serviceRuns = ctx["serviceDrives"].get(conversationId) ?? new Set<Promise<void>>();
    serviceRuns.add(invocation);
    ctx["serviceDrives"].set(conversationId, serviceRuns);
    const run = new ConversationServiceRun(signal);
    try {
      return await waitForConversationRun(service(run), run.signal);
    } finally {
      run.close();
      serviceRuns.delete(invocation);
      if (serviceRuns.size === 0 && ctx["serviceDrives"].get(conversationId) === serviceRuns)
        ctx["serviceDrives"].delete(conversationId);
      settled();
    }
  }
}

/** One inspectable conversation per room, irrespective of its execution authority. */
export function roomConversation(
  ctx: ConversationStore,
  lane: "discord_presence" | "discord_voice",
  targetId: string,
): string {
  const id = `room-${createHash("sha256").update(`${lane}:${targetId}`).digest("hex").slice(0, 24)}`;
  if (!ctx["metas"].has(id)) {
    ctx["create"](
      { kind: "room", lane, targetId },
      `Discord ${lane === "discord_voice" ? "voice" : "text"} · ${targetId}`,
      id,
    );
  }
  return id;
}

/** Host-observed Discord names affect discovery only, never room authority. */
export function nameRoomConversation(ctx: ConversationStore, conversationId: string, title: string): void {
  const meta = ctx["metas"].get(conversationId);
  if (meta?.scope.kind !== "room") throw new Error("Expected a room conversation");
  const name = title.trim();
  if (!name || name.includes("\0") || name.length > 200) throw new Error("Invalid room title");
  if (meta.title === name) return;
  meta.title = name;
  meta.updatedAt = new Date().toISOString();
  ctx["saveMeta"](meta);
}

export function syncRoomTranscript(
  ctx: ConversationStore,
  conversationId: string,
  transcript: HerdrSeatTranscript,
): void {
  if (ctx["metas"].get(conversationId)?.scope.kind !== "room")
    throw new Error("Expected a room conversation");
  ctx["syncConversationTranscript"](conversationId, conversationId, transcript, "captain");
}

export function publishRoomEvent(
  ctx: ConversationStore,
  conversationId: string,
  body: OperatorConversationEventBody,
): void {
  const meta = ctx["metas"].get(conversationId);
  if (meta?.scope.kind !== "room") throw new Error("Expected a room conversation");
  if (body.type === "turn") {
    const count = Math.max(
      0,
      (ctx["runCounts"].get(conversationId) ?? 0) + (body.phase === "accepted" ? 1 : -1),
    );
    ctx["runCounts"].set(conversationId, count);
    meta.sessionState = count > 0 ? "active" : body.phase === "failed" ? "failed" : "waiting";
  }
  meta.updatedAt = new Date().toISOString();
  ctx["append"](meta, body);
  ctx["saveMeta"](meta);
}

/**
 * The seat's head is the default global conversation, the thread the app
 * pins as Clankie (ADR 0152). A seated harness's transcript folds into it
 * as his own words — `captain`, not `agent` — and always appends: this
 * thread already holds his pi turns, so nothing here replaces them.
 */
export function syncHeadTranscript(
  ctx: ConversationStore,
  seatId: string,
  transcript: HerdrSeatTranscript,
  workingDirectory?: string,
): void {
  ctx["syncConversationTranscript"](
    ctx["defaultGlobalConversationId"](),
    seatId,
    transcript,
    "captain",
    workingDirectory,
  );
}

export function syncNativeSeatTranscript(
  ctx: ConversationStore,
  conversationId: string,
  sessionId: string,
  entries: HerdrSeatTranscript["entries"],
  activity?: "responding" | "waiting",
): boolean {
  const meta = ctx["metas"].get(conversationId);
  if (
    !meta ||
    (meta.scope.kind !== "global" && meta.scope.kind !== "workspace" && meta.scope.kind !== "room")
  )
    return false;
  for (const candidate of ctx["metas"].values()) {
    if (
      candidate.conversationId !== conversationId &&
      candidate.nativeSeatSessions?.[sessionId] !== undefined
    )
      return false;
  }
  if (meta.nativeSeatSessions?.[sessionId] === "retired") return false;
  if (meta.nativeSeatSessions?.[sessionId] === undefined) {
    (meta.nativeSeatSessions ??= {})[sessionId] = "current";
    ctx["saveMeta"](meta);
  }
  ctx["syncConversationTranscript"](
    conversationId,
    `native:${sessionId}`,
    { sessionKey: `${sessionId.startsWith("ses_") ? "opencode" : "claude"}:${sessionId}`, entries },
    "captain",
  );
  // Native hooks provide display activity even without a Herdr presence feed.
  // This does not finish or change ownership of a service-managed run.
  if (activity !== undefined)
    ctx["publishConversationEvent"](conversationId, { type: "activity", phase: activity });
  return true;
}

export function publishHeadEvent(ctx: ConversationStore, body: OperatorConversationEventBody): void {
  ctx["publishConversationEvent"](ctx["defaultGlobalConversationId"](), body);
}

/** Legacy test/API path while persisted seat scopes migrate on discovery. */
export function syncSeatTranscript(
  ctx: ConversationStore,
  seatId: string,
  transcript: HerdrSeatTranscript,
): void {
  ctx["syncConversationTranscript"](ctx["conversationIdForSeat"](seatId), seatId, transcript);
}

/** A native head remains native while its channel is offline. */
export function hasNativeSeat(ctx: ConversationStore, conversationId: string): boolean {
  const meta = ctx["metas"].get(conversationId);
  return (
    meta?.nativeSource !== undefined ||
    Object.values(meta?.nativeSeatSessions ?? {}).some((state) => state === "current")
  );
}

/** Retain host-observed head ownership without changing transcript checkpoints. */
export function rememberNativeHead(ctx: ConversationStore, conversationId: string, occupantId: string): void {
  const meta = ctx["metas"].get(conversationId);
  if (meta === undefined || meta.nativeSeatSessions?.[occupantId] === "current") return;
  (meta.nativeSeatSessions ??= {})[occupantId] = "current";
  ctx["saveMeta"](meta);
}
