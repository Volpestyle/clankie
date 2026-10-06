import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  OPERATOR_CONVERSATION_REPLAY_LIMIT_MAX,
  OPERATOR_CONVERSATION_REPLAY_LIMIT_DEFAULT,
  OPERATOR_CONVERSATION_TAIL_WAIT_MS_MAX,
  type OperatorConversationReplayPage,
  type OperatorConversationServiceDispatch,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
  type OperatorConversationStreamEvent,
} from "../../../packages/protocol/src/index.ts";

type TailRequest = Extract<OperatorConversationServiceRequest, { op: "tail" }>;
type TailResult = Extract<OperatorConversationServiceResult, { op: "tail" }>;
const UPSTREAM_WAIT_MS = OPERATOR_CONVERSATION_TAIL_WAIT_MS_MAX;
const CACHE_EVENTS = 1_000;
const CACHE_BYTES = 1024 * 1024;
const CACHE_IDLE_MS = 60_000;
const CACHE_CONVERSATIONS = 256;

interface Entry {
  readonly conversationId: string;
  readonly surfaceClientId: string;
  readonly changed: Set<() => void>;
  subscribers: number;
  lastUsed: number;
  generation: number;
  anchor?: string | undefined;
  startsAtBeginning: boolean;
  events: OperatorConversationStreamEvent[];
  bytes: number;
  page?: OperatorConversationReplayPage | undefined;
  recovery?: { cursor: string | undefined; result: TailResult } | undefined;
  error?: unknown;
  controller?: AbortController | undefined;
  pump?: Promise<void> | undefined;
  ready?: Promise<void> | undefined;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
}

/**
 * One parked captain read per conversation, shared by JSON long polls and
 * NDJSON streams. Callers retain their own deadlines, cursors and authority.
 * Only already validated/redacted public results may enter this cache.
 */
export class ConversationTailHub {
  private readonly dispatch: OperatorConversationServiceDispatch;
  constructor(dispatch: OperatorConversationServiceDispatch) {
    this.dispatch = dispatch;
  }
  private readonly entries = new Map<string, Entry>();

  subscribe(request: TailRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.subscribers === 0 && !entry.pump && now - entry.lastUsed >= CACHE_IDLE_MS) {
        clearTimeout(entry.idleTimer);
        this.entries.delete(id);
      }
    }
    let entry = this.entries.get(request.tail.conversationId);
    if (!entry) {
      if (this.entries.size >= CACHE_CONVERSATIONS) {
        const idle = [...this.entries.values()]
          .filter((candidate) => candidate.subscribers === 0 && !candidate.pump)
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!idle) throw new Error("conversation tail capacity reached");
        clearTimeout(idle.idleTimer);
        this.entries.delete(idle.conversationId);
      }
      entry = {
        conversationId: request.tail.conversationId,
        surfaceClientId: `relay-tail-${randomUUID()}`,
        changed: new Set(),
        subscribers: 0,
        lastUsed: now,
        generation: 0,
        anchor: request.tail.cursor,
        startsAtBeginning: request.tail.cursor === undefined,
        events: [],
        bytes: 0,
      };
      this.entries.set(entry.conversationId, entry);
    }
    const selected = entry;
    clearTimeout(selected.idleTimer);
    selected.idleTimer = undefined;
    selected.subscribers += 1;
    selected.lastUsed = now;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", close);
      selected.subscribers -= 1;
      selected.lastUsed = Date.now();
      if (selected.subscribers === 0) {
        selected.controller?.abort();
        selected.idleTimer = setTimeout(() => {
          if (
            selected.subscribers === 0 &&
            !selected.pump &&
            this.entries.get(selected.conversationId) === selected
          )
            this.entries.delete(selected.conversationId);
        }, CACHE_IDLE_MS);
        selected.idleTimer.unref();
      }
    };
    signal.addEventListener("abort", close, { once: true });
    this.start(selected);
    return {
      read: (next: TailRequest) => this.read(selected, next, signal),
      close,
    };
  }

  private start(entry: Entry): void {
    if (entry.pump || entry.subscribers === 0) return;
    entry.error = undefined;
    const controller = new AbortController();
    entry.controller = controller;
    let ready!: () => void;
    entry.ready = new Promise<void>((resolve) => {
      ready = resolve;
    });
    entry.pump = this.poll(entry, controller.signal, ready).finally(() => {
      ready();
      entry.pump = undefined;
      entry.controller = undefined;
      // A new subscriber can arrive while the preceding disconnect is still
      // cancelling HTTP. Wait for that read to settle before starting another.
      if (controller.signal.aborted && entry.subscribers > 0) this.start(entry);
    });
  }

  private async poll(entry: Entry, signal: AbortSignal, ready: () => void): Promise<void> {
    let first = true;
    try {
      while (!signal.aborted && entry.subscribers > 0) {
        const cursor = entry.page?.nextCursor ?? entry.anchor;
        const started = Date.now();
        const value = await this.dispatch(
          {
            schemaVersion: 1,
            op: "tail",
            tail: {
              schemaVersion: 1,
              conversationId: entry.conversationId,
              surfaceClientId: entry.surfaceClientId,
              ...(cursor === undefined ? {} : { cursor }),
              limit: OPERATOR_CONVERSATION_REPLAY_LIMIT_MAX,
              liveSequence: entry.page?.live?.sequence ?? 0,
              waitMs: first || entry.page?.hasMore ? 0 : UPSTREAM_WAIT_MS,
            },
          },
          signal,
        );
        signal.throwIfAborted();
        if (value.op !== "tail" || value.result.conversationId !== entry.conversationId)
          throw new Error("invalid conversation tail response");
        if (value.result.status === "recover") {
          // This cursor may belong to a replaced native run. Drop the cache;
          // each caller obtains its own authoritative recovery via replay.
          entry.page = undefined;
          entry.recovery = { cursor, result: value };
          entry.events = [];
          entry.bytes = 0;
          entry.anchor = value.result.resetCursor;
          entry.startsAtBeginning = false;
          this.notify(entry);
          ready();
          return;
        }
        this.append(entry, value.result, cursor);
        ready();
        const bootstrap = first;
        first = false;
        // Let bootstrap readers consume the snapshot before parking again.
        if (bootstrap) await delay(0, undefined, { signal });
        // Older peers may ignore waitMs. They must not create a busy loop.
        if (!bootstrap && !value.result.hasMore && Date.now() - started < 250)
          await delay(250, undefined, { signal });
      }
    } catch {
      if (!signal.aborted) {
        entry.error = new Error("conversation tail upstream unavailable");
        this.notify(entry);
      }
    }
  }

  private append(entry: Entry, page: OperatorConversationReplayPage, from?: string): void {
    // Native activity cursors can repeat when the same transcript returns to a
    // previous phase (waiting -> responding -> waiting). They are identities,
    // not an append-only sequence. Rebase rather than replay obsolete phases.
    const floorChanged =
      entry.page !== undefined && entry.page.retainedFromCursor !== page.retainedFromCursor;
    if (
      (floorChanged &&
        entry.anchor !== page.retainedFromCursor &&
        !entry.events.some((event) => event.cursor === page.retainedFromCursor)) ||
      page.events.some(
        (event) =>
          event.cursor === entry.anchor || entry.events.some((cached) => cached.cursor === event.cursor),
      )
    ) {
      entry.page = undefined;
      entry.events = [];
      entry.bytes = 0;
    }
    if (!entry.page) {
      entry.anchor = from;
      entry.startsAtBeginning = from === undefined;
    }
    for (const event of page.events) {
      entry.events.push(event);
      entry.bytes += Buffer.byteLength(JSON.stringify(event));
    }
    while (entry.events.length > CACHE_EVENTS || entry.bytes > CACHE_BYTES) {
      const dropped = entry.events.shift()!;
      entry.bytes -= Buffer.byteLength(JSON.stringify(dropped));
      entry.anchor = dropped.cursor;
      entry.startsAtBeginning = false;
    }
    // A provider's retained floor supersedes anything cached before it.
    const floor = entry.events.findIndex((event) => event.cursor === page.retainedFromCursor);
    if (floor >= 0) {
      for (const dropped of entry.events.splice(0, floor + 1))
        entry.bytes -= Buffer.byteLength(JSON.stringify(dropped));
      entry.anchor = page.retainedFromCursor;
      entry.startsAtBeginning = false;
    }
    // The events live only in the bounded buffer, never a second full page.
    entry.page = { ...page, events: [] };
    entry.recovery = undefined;
    this.notify(entry);
  }

  private notify(entry: Entry): void {
    entry.generation += 1;
    for (const changed of entry.changed) changed();
  }

  private page(entry: Entry, request: TailRequest): TailResult | undefined {
    const latest = entry.page;
    if (!latest || request.tail.direction === "backward") return undefined;
    const cursor = request.tail.cursor;
    let start: number;
    if (cursor !== undefined && cursor === latest.nextCursor) start = entry.events.length;
    else if (cursor === undefined && entry.startsAtBeginning) start = 0;
    else if (cursor !== undefined && cursor === entry.anchor) start = 0;
    else {
      const index = entry.events.findIndex((event) => event.cursor === cursor);
      if (index < 0) return undefined;
      start = index + 1;
    }
    const events = entry.events.slice(
      start,
      start + (request.tail.limit ?? OPERATOR_CONVERSATION_REPLAY_LIMIT_DEFAULT),
    );
    return {
      schemaVersion: 1,
      op: "tail",
      result: {
        schemaVersion: 1,
        status: "page",
        conversationId: entry.conversationId,
        surfaceClientId: request.tail.surfaceClientId,
        events,
        retainedFromCursor: latest.retainedFromCursor,
        nextCursor: start + events.length >= entry.events.length ? latest.nextCursor : events.at(-1)!.cursor,
        safeCursor: latest.safeCursor,
        hasMore: start + events.length < entry.events.length || latest.hasMore,
        ...(latest.live === undefined ? {} : { live: latest.live }),
      },
    };
  }

  private async replay(request: TailRequest, signal: AbortSignal): Promise<TailResult> {
    const { waitMs: _waitMs, ...replay } = request.tail;
    const result = await this.dispatch({ schemaVersion: 1, op: "replay", replay }, signal);
    signal.throwIfAborted();
    if (result.op !== "replay" || result.result.conversationId !== request.tail.conversationId)
      throw new Error("invalid conversation replay response");
    return { ...result, op: "tail" };
  }

  private async read(entry: Entry, request: TailRequest, signal: AbortSignal): Promise<TailResult> {
    if (request.tail.conversationId !== entry.conversationId)
      throw new Error("conversation tail subscription mismatch");
    const deadline = Date.now() + (request.tail.waitMs ?? 0);
    // On reuse after idle, refresh before serving cached history. Joining an
    // already active conversation never waits for its parked upstream read.
    while (entry.controller?.signal.aborted) {
      await abortable(entry.pump!, signal);
      this.start(entry);
    }
    if (entry.ready) await abortable(entry.ready, signal);
    while (true) {
      signal.throwIfAborted();
      if (entry.error) throw entry.error;
      const generation = entry.generation;
      const cached = this.page(entry, request);
      const recovery = entry.recovery?.cursor === request.tail.cursor ? entry.recovery?.result : undefined;
      const result = cached ?? recovery ?? (await this.replay(request, signal));
      // Recovery or an evicted cursor is isolated to the caller. A successful
      // read can restart a canonical tail after a native run reset.
      if (
        !entry.pump &&
        !entry.page &&
        result.result.status === "page" &&
        request.tail.direction !== "backward"
      ) {
        this.append(entry, result.result, request.tail.cursor);
        this.start(entry);
      }
      if (
        result.result.status === "recover" ||
        result.result.events.length > 0 ||
        result.result.hasMore ||
        (result.result.live?.sequence ?? 0) !== (request.tail.liveSequence ?? 0) ||
        request.tail.direction === "backward" ||
        Date.now() >= deadline
      )
        return result;
      await changed(entry, generation, Math.max(0, deadline - Date.now()), signal);
    }
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function changed(entry: Entry, generation: number, waitMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (entry.generation !== generation) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      entry.changed.delete(done);
      signal.removeEventListener("abort", aborted);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(done, waitMs);
    entry.changed.add(done);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
