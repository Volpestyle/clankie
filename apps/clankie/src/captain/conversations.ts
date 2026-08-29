import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  OPERATOR_CONVERSATION_TEXT_MAX,
  type OperatorConversation,
  type OperatorConversationContextUsage,
  type OperatorConversationEventBody,
  type OperatorConversationLiveDraft,
  type OperatorConversationScope,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
  type OperatorConversationStreamEvent,
  type ReplayOperatorConversationRequest,
  type ReplayOperatorConversationResult,
  type SubmitOperatorConversationTurn,
  type SubmitOperatorConversationTurnResult,
} from "@clankie/protocol";

type ConversationServiceRequest = Exclude<
  OperatorConversationServiceRequest,
  { op: "autonomy" } | { op: "roster" } | { op: "terminal_tail" }
>;
type ConversationServiceResult = Exclude<
  OperatorConversationServiceResult,
  { op: "autonomy" } | { op: "roster" } | { op: "terminal_tail" }
>;

const CURSOR_WIDTH = 12;
const ZERO_CURSOR = "0".repeat(CURSOR_WIDTH);
/** Under the relay's 30s upstream dispatch timeout, with headroom. */
const DEFAULT_TAIL_WAIT_MS = 25_000;
export const OPERATOR_CONVERSATION_RETAINED_MAX = 64;
export const OPERATOR_CONVERSATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const OPERATOR_CONVERSATION_RETAINED_BYTES_MAX = 256 * 1024 * 1024;
export const OPERATOR_CONVERSATION_RETAINED_EVENTS_MAX = 500;
const OPERATOR_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM = 400;

interface ConversationMeta {
  readonly conversationId: string;
  readonly scope: OperatorConversationScope;
  readonly title: string;
  isDefault: boolean;
  readonly createdAt: string;
  updatedAt: string;
  revision: number;
  sessionState: OperatorConversation["sessionState"];
  contextUsage?: OperatorConversationContextUsage;
  readonly parentConversationId?: string;
  /** Exclusive replay boundary immediately before the oldest retained event. */
  retainedFromCursor?: string;
}

/** Optional seat for a turn that arrived from a herdr-hosted console. */
interface ConversationTurnSeat {
  readonly herdrPaneId: string;
}

/** Where a turn runs and who it arrived from. */
export interface ConversationTurnContext {
  /**
   * Absolute directory the conversation's session works in, from a workspace
   * scope. Absent for a global conversation, which works in the service repo.
   */
  readonly workspace?: string;
  readonly seat?: ConversationTurnSeat;
  readonly internal?: true;
  /** Side conversations inherit a Pi branch but never continue their parent's active task. */
  readonly side?: true;
  /** Conversation-store run id; one metrics line uses this, including absorbed steers. */
  readonly runId: string;
  readonly acceptedAt: string;
  /** Aborts when the operator interrupts this run (`cancel` op); the runner stops the live model turn. */
  readonly signal: AbortSignal;
  /**
   * Show the message being typed, or `undefined` to take it down. Volatile: it
   * reaches watching surfaces through the tail's `live` field and never becomes
   * a durable event. The runner throttles; the store just holds the latest.
   */
  readonly draft: (text: string | undefined) => void;
}

/** Runs one accepted operator turn against the captain's model session. */
export type ConversationRunner = (
  conversationId: string,
  message: string,
  publish: (event: OperatorConversationEventBody) => void,
  context: ConversationTurnContext,
) => Promise<void>;

type SeatSender = (seatId: string, message: string) => Promise<boolean>;
type ConversationForker = (input: {
  readonly parentConversationId: string;
  readonly conversationId: string;
  readonly workspace?: string;
}) => Promise<void>;

/**
 * A workspace scope names the directory the conversation's session works in.
 * That directory becomes the cwd of an unsandboxed shell, so the registry
 * refuses anything but an absolute path that already resolves to a directory —
 * a conversation is never created pointing at a path the caller invented.
 */
function workspaceOf(scope: OperatorConversationScope): string | undefined {
  if (scope.kind !== "workspace") return undefined;
  const workspace = scope.workspaceId;
  if (!isAbsolute(workspace)) {
    throw new Error(`Workspace ${workspace} is not an absolute path`);
  }
  return workspace;
}

/**
 * File-backed conversation registry: `meta.json` + append-only `events.jsonl`
 * per conversation. The wire contract (list/get/create/close/replay/tail/send with
 * revision fencing and cursored pages) is the one the TUI and relay speak.
 * Cursors are zero-padded line counts.
 */
export class ConversationStore {
  private readonly metas = new Map<string, ConversationMeta>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, Promise<boolean>>();
  /** Live (accepted, unsettled) runs an operator `cancel` can interrupt. */
  private readonly runControllers = new Map<
    string,
    { readonly conversationId: string; readonly controller: AbortController }
  >();
  private readonly cancelRequests = new Set<string>();
  private readonly seatSends = new Map<string, Promise<void>>();
  private readonly runCounts = new Map<string, number>();
  /** Internal turns whose `invoke()` has begun and not yet settled — not merely queued. */
  private readonly internalRuns = new Map<string, number>();

  private readonly root: string;
  private readonly runner: ConversationRunner;
  private readonly onPrune: ((conversationId: string, scope: OperatorConversationScope) => void) | undefined;
  private readonly sendToSeat: SeatSender | undefined;
  private readonly forkConversation: ConversationForker | undefined;
  /** Longest a parked tail may wait here, whatever a caller asks for. */
  private readonly tailWaitMs: number;
  /** Per-conversation parked tails, woken by `append` and by a live draft. */
  private readonly tailListeners = new Map<string, Set<() => void>>();
  /** The message the captain is typing right now, per conversation. Never durable. */
  private readonly drafts = new Map<string, OperatorConversationLiveDraft>();
  private draftSequence = 0;

  public constructor(
    root: string,
    runner: ConversationRunner,
    onPrune?: (conversationId: string, scope: OperatorConversationScope) => void,
    sendToSeat?: SeatSender,
    tailWaitMs = DEFAULT_TAIL_WAIT_MS,
    forkConversation?: ConversationForker,
  ) {
    this.root = root;
    this.runner = runner;
    this.onPrune = onPrune;
    this.sendToSeat = sendToSeat;
    this.tailWaitMs = tailWaitMs;
    this.forkConversation = forkConversation;
    mkdirSync(root, { recursive: true });
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = JSON.parse(
          readFileSync(join(root, entry.name, "meta.json"), "utf8"),
        ) as ConversationMeta;
        // A crash mid-run leaves "active"; on boot nothing is running.
        if (meta.sessionState === "active") {
          meta.sessionState = "waiting";
          this.failOrphanedRuns(meta);
        }
        this.metas.set(meta.conversationId, meta);
      } catch {
        // An unreadable conversation is skipped, never fatal to boot.
      }
    }
    // Side forks have no resumable console owner after a service restart.
    for (const meta of this.metas.values()) {
      if (meta.parentConversationId !== undefined) this.remove(meta);
    }
    this.ensureDefaultGlobalConversation();
    this.prune();
  }

  /**
   * Remote clients may still explicitly select the default global conversation,
   * so the store guarantees exactly one even though each TUI process starts a
   * fresh conversation.
   */
  private ensureDefaultGlobalConversation(): void {
    const defaults = [...this.metas.values()]
      .filter((meta) => meta.scope.kind === "global" && meta.isDefault)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const demoted of defaults.slice(1)) {
      demoted.isDefault = false;
      this.saveMeta(demoted);
    }
    if (defaults.length > 0) return;
    const now = new Date().toISOString();
    const meta: ConversationMeta = {
      conversationId: "global-default",
      scope: { kind: "global" },
      title: "Clankie",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      sessionState: "unbound",
    };
    mkdirSync(join(this.root, meta.conversationId), { recursive: true });
    this.metas.set(meta.conversationId, meta);
    this.saveMeta(meta);
  }

  /**
   * A turn accepted before a crash never got its terminal event, and a client
   * mid-tail would wait on it forever. Close each orphan out as failed.
   */
  private failOrphanedRuns(meta: ConversationMeta): void {
    const terminal = new Set<string>();
    const accepted: string[] = [];
    for (const event of this.readEvents(meta.conversationId)) {
      if (event.type !== "turn") continue;
      if (event.phase === "accepted") accepted.push(event.runId);
      else terminal.add(event.runId);
    }
    for (const runId of accepted.filter((id) => !terminal.has(id))) {
      this.append(meta, { type: "turn", runId, phase: "failed", reasonCode: "service_restarted" });
    }
  }

  public async serve(request: ConversationServiceRequest): Promise<ConversationServiceResult> {
    switch (request.op) {
      case "list": {
        const conversations = [...this.metas.values()]
          .filter((meta) => request.scope === undefined || sameScope(meta.scope, request.scope))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((meta) => publicConversation(meta));
        return { op: "list", schemaVersion: 1, conversations };
      }
      case "get": {
        const meta = this.metas.get(request.conversationId);
        return {
          op: "get",
          schemaVersion: 1,
          ...(meta === undefined ? {} : { conversation: publicConversation(meta) }),
        };
      }
      case "create":
        return { op: "create", schemaVersion: 1, conversation: this.create(request.scope, request.title) };
      case "fork":
        return {
          op: "fork",
          schemaVersion: 1,
          conversation: await this.fork(request.parentConversationId),
        };
      case "close":
        return {
          op: "close",
          schemaVersion: 1,
          conversationId: request.conversationId,
          closed: await this.removeConversation(request.conversationId),
        };
      case "replay":
        return { op: "replay", schemaVersion: 1, result: this.replay(request.replay) };
      case "tail": {
        // Hanging long-poll: a page with no news parks until this conversation
        // changes (or the wait elapses), so an idle tail costs one request per
        // wait window instead of one per client poll interval, and a live draft
        // reaches the surface as fast as the round trip allows. "No news" means
        // no unseen event AND no draft the caller has not already drawn.
        let result = this.replay(request.tail);
        const waitMs = Math.min(request.tail.waitMs ?? 0, this.tailWaitMs);
        if (waitMs > 0 && result.status === "page" && result.events.length === 0 && !result.hasMore) {
          if ((result.live?.sequence ?? 0) === (request.tail.liveSequence ?? 0)) {
            await this.waitForChange(request.tail.conversationId, waitMs);
            result = this.replay(request.tail);
          }
        }
        return { op: "tail", schemaVersion: 1, result };
      }
      case "send":
        return { op: "send", schemaVersion: 1, result: await this.send(request.turn) };
      case "cancel":
        return {
          op: "cancel",
          schemaVersion: 1,
          conversationId: request.conversationId,
          runId: request.runId,
          cancelled: this.cancel(request.conversationId, request.runId),
        };
      default: {
        const exhaustive: never = request;
        throw new Error(`Unknown operator conversation op ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * Interrupt one accepted run. A live run's abort signal fires (the captain
   * stops the model turn); a still-queued run settles as cancelled without ever
   * invoking the runner. Unknown or already settled runs report false.
   */
  public cancel(conversationId: string, runId: string): boolean {
    const entry = this.runControllers.get(runId);
    if (entry === undefined || entry.conversationId !== conversationId) return false;
    this.cancelRequests.add(runId);
    entry.controller.abort();
    return true;
  }

  /** Keeps an accepted detached run alive for the transport's waitUntil. */
  public awaitRun(runId: string): Promise<void> {
    return this.runs.get(runId)?.then(() => undefined) ?? Promise.resolve();
  }

  public awaitRunResult(runId: string): Promise<boolean> {
    return this.runs.get(runId) ?? Promise.resolve(false);
  }

  public has(conversationId: string): boolean {
    return this.metas.has(conversationId);
  }

  public isSeatConversation(conversationId: string): boolean {
    return this.metas.get(conversationId)?.scope.kind === "seat";
  }

  public conversationIdForSeat(seatId: string): string | undefined {
    return [...this.metas.values()].find((meta) => meta.scope.kind === "seat" && meta.scope.seatId === seatId)
      ?.conversationId;
  }

  public seatIds(): readonly string[] {
    return [...this.metas.values()].flatMap((meta) =>
      meta.scope.kind === "seat" ? [meta.scope.seatId] : [],
    );
  }

  public publishSeatEvent(seatId: string, body: OperatorConversationEventBody): void {
    const conversationId = this.conversationIdForSeat(seatId);
    const meta = conversationId === undefined ? undefined : this.metas.get(conversationId);
    if (meta === undefined) return;
    const events = this.readEvents(meta.conversationId);
    if (body.type === "activity") {
      const previous = events.reverse().find((event) => event.type === "activity");
      if (previous?.type === "activity" && previous.phase === body.phase) return;
    }
    if (body.type === "message" && body.role === "agent") {
      const previous = events.reverse().find((event) => event.type === "message" && event.role === "agent");
      if (previous?.type === "message" && previous.role === "agent" && previous.text === body.text) return;
    }
    this.append(meta, body);
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
  }

  /** Queue a host-authored continuation without forging an operator message. */
  public submitInternal(conversationId: string, message: string): SubmitOperatorConversationTurnResult {
    const meta = this.metas.get(conversationId);
    if (meta === undefined) throw new Error(`Unknown conversation ${conversationId}`);
    if (meta.scope.kind === "seat") throw new Error("Seat conversations do not run captain turns");
    return this.enqueue(meta, message, undefined, false);
  }

  public async close(): Promise<void> {
    await Promise.allSettled([...this.runs.values(), ...this.seatSends.values()]);
  }

  private create(scope: OperatorConversationScope, title: string): OperatorConversation {
    if (scope.kind === "seat") {
      const existing = this.conversationIdForSeat(scope.seatId);
      if (existing !== undefined) return publicConversation(this.metas.get(existing)!);
    }
    const workspace = workspaceOf(scope);
    if (workspace !== undefined && !statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Workspace ${workspace} is not a directory on this machine`);
    }
    const now = new Date().toISOString();
    const meta: ConversationMeta = {
      conversationId: `conv-${randomUUID()}`,
      scope,
      title,
      // The boot-seeded global conversation owns default; created ones never do.
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      sessionState: "unbound",
    };
    mkdirSync(join(this.root, meta.conversationId), { recursive: true });
    this.metas.set(meta.conversationId, meta);
    this.saveMeta(meta);
    this.prune(meta.conversationId);
    return publicConversation(meta);
  }

  private async fork(parentConversationId: string): Promise<OperatorConversation> {
    const parent = this.metas.get(parentConversationId);
    if (parent === undefined) throw new Error(`Unknown conversation ${parentConversationId}`);
    if (parent.scope.kind === "seat") throw new Error("Seat conversations cannot be forked");
    if (parent.parentConversationId !== undefined) throw new Error("A side conversation is already open");
    if ([...this.metas.values()].some((meta) => meta.parentConversationId === parentConversationId)) {
      throw new Error("A side conversation is already open");
    }
    if (this.forkConversation === undefined) throw new Error("Side conversations are unavailable");

    const now = new Date().toISOString();
    const meta: ConversationMeta = {
      conversationId: `conv-${randomUUID()}`,
      scope: parent.scope,
      title: "BTW",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      sessionState: "waiting",
      parentConversationId,
      ...(parent.contextUsage === undefined ? {} : { contextUsage: parent.contextUsage }),
    };
    mkdirSync(join(this.root, meta.conversationId), { recursive: true });
    this.metas.set(meta.conversationId, meta);
    this.saveMeta(meta);
    try {
      const workspace = workspaceOf(parent.scope);
      await this.forkConversation({
        parentConversationId,
        conversationId: meta.conversationId,
        ...(workspace === undefined ? {} : { workspace }),
      });
    } catch (error) {
      this.remove(meta);
      throw error;
    }
    this.prune(meta.conversationId);
    return publicConversation(meta);
  }

  private replay(request: ReplayOperatorConversationRequest): ReplayOperatorConversationResult {
    const meta = this.metas.get(request.conversationId);
    if (meta === undefined) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: request.conversationId,
        code: "unknown_conversation",
        recoverable: false,
        resetCursor: ZERO_CURSOR,
        message: "No conversation with that id exists here.",
      };
    }
    const events = this.readEvents(meta.conversationId);
    const retainedFromCursor = meta.retainedFromCursor ?? ZERO_CURSOR;
    const safeCursor = events.length === 0 ? retainedFromCursor : events[events.length - 1]!.cursor;
    const rawFrom = request.cursor ?? ZERO_CURSOR;
    if (!/^\d+$/u.test(rawFrom) || rawFrom.length > CURSOR_WIDTH) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: meta.conversationId,
        code: "cursor_invalid",
        recoverable: true,
        resetCursor: retainedFromCursor,
        message: "That cursor is not from this conversation; replay from the start.",
      };
    }
    // Cursors compare lexically, so a short numeric cursor pads first.
    const from = rawFrom.padStart(CURSOR_WIDTH, "0");
    if (from < retainedFromCursor) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: meta.conversationId,
        code: "cursor_expired",
        recoverable: true,
        resetCursor: retainedFromCursor,
        message: "Older conversation events expired; replay from the retained boundary.",
      };
    }
    if (from > safeCursor) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: meta.conversationId,
        code: "cursor_reset",
        recoverable: true,
        resetCursor: safeCursor,
        message: "That cursor is ahead of this conversation; resume from its latest event.",
      };
    }
    const limit = request.limit ?? 200;
    const remaining = events.filter((event) => event.cursor > from);
    const page = remaining.slice(0, limit);
    return {
      schemaVersion: 1,
      status: "page",
      conversationId: meta.conversationId,
      surfaceClientId: request.surfaceClientId,
      events: page,
      retainedFromCursor,
      nextCursor: page.length === 0 ? from : page[page.length - 1]!.cursor,
      safeCursor,
      hasMore: page.length < remaining.length,
      // The volatile half of the page: what he is typing right now. A surface
      // that ignores it still gets every settled message from `events`.
      ...(this.drafts.has(meta.conversationId) ? { live: this.drafts.get(meta.conversationId)! } : {}),
    };
  }

  private async send(turn: SubmitOperatorConversationTurn): Promise<SubmitOperatorConversationTurnResult> {
    const meta = this.metas.get(turn.conversationId);
    if (meta === undefined) {
      throw new Error(`Unknown conversation ${turn.conversationId}`);
    }
    if (meta.scope.kind === "seat") return this.queueSeatSend(meta, meta.scope.seatId, turn);
    const safeCursor = this.lastCursor(meta);
    if (turn.expectedRevision !== meta.revision) {
      return {
        schemaVersion: 1,
        status: "revision_conflict",
        conversationId: meta.conversationId,
        expectedRevision: turn.expectedRevision,
        currentRevision: meta.revision,
        safeCursor,
      };
    }
    return this.enqueue(meta, turn.message, turn.herdrPaneId, true);
  }

  private queueSeatSend(
    meta: ConversationMeta,
    seatId: string,
    turn: SubmitOperatorConversationTurn,
  ): Promise<SubmitOperatorConversationTurnResult> {
    const previous = this.seatSends.get(meta.conversationId) ?? Promise.resolve();
    const pending = previous.then(() => this.deliverSeatTurn(meta, seatId, turn));
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    this.seatSends.set(meta.conversationId, settled);
    void settled.finally(() => {
      if (this.seatSends.get(meta.conversationId) === settled) this.seatSends.delete(meta.conversationId);
    });
    return pending;
  }

  private async deliverSeatTurn(
    meta: ConversationMeta,
    seatId: string,
    turn: SubmitOperatorConversationTurn,
  ): Promise<SubmitOperatorConversationTurnResult> {
    const safeCursor = this.lastCursor(meta);
    if (turn.expectedRevision !== meta.revision) {
      return {
        schemaVersion: 1,
        status: "revision_conflict",
        conversationId: meta.conversationId,
        expectedRevision: turn.expectedRevision,
        currentRevision: meta.revision,
        safeCursor,
      };
    }
    if (!(await this.sendToSeat?.(seatId, turn.message))) {
      return {
        schemaVersion: 1,
        status: "seat_offline",
        conversationId: meta.conversationId,
        seatId,
        currentRevision: meta.revision,
        safeCursor,
      };
    }
    const runId = `run-${randomUUID()}`;
    meta.revision += 1;
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    this.append(meta, { type: "message", role: "operator", text: turn.message, streaming: false });
    this.append(meta, { type: "turn", runId, phase: "accepted" });
    this.append(meta, { type: "turn", runId, phase: "completed" });
    this.prune(meta.conversationId);
    return {
      schemaVersion: 1,
      status: "accepted",
      conversationId: meta.conversationId,
      runId,
      revision: meta.revision,
      safeCursor,
    };
  }

  private enqueue(
    meta: ConversationMeta,
    message: string,
    herdrPaneId: string | undefined,
    publishOperatorMessage: boolean,
  ): SubmitOperatorConversationTurnResult {
    const workspace = workspaceOf(meta.scope);
    const safeCursor = this.lastCursor(meta);
    meta.revision += 1;
    meta.sessionState = "active";
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    const runId = `run-${randomUUID()}`;
    if (publishOperatorMessage) {
      this.append(meta, { type: "message", role: "operator", text: message, streaming: false });
    }
    this.append(meta, { type: "turn", runId, phase: "accepted" });

    const conversationId = meta.conversationId;
    this.runCounts.set(conversationId, (this.runCounts.get(conversationId) ?? 0) + 1);
    const controller = new AbortController();
    this.runControllers.set(runId, { conversationId, controller });
    // Steer only while an autonomous invoke is in flight. A continuation still
    // sitting on the FIFO must not open the lane — that let a later human send
    // jump an in-flight human turn (ADR 0091 / ADR 0130).
    const joinLiveInternal = publishOperatorMessage && (this.internalRuns.get(conversationId) ?? 0) > 0;

    const previous = this.chains.get(conversationId) ?? Promise.resolve();
    const invoke = (): Promise<void> => {
      // Cancelled while still queued: settle without ever invoking the runner.
      if (controller.signal.aborted) return Promise.resolve();
      if (!publishOperatorMessage) {
        this.internalRuns.set(conversationId, (this.internalRuns.get(conversationId) ?? 0) + 1);
      }
      meta.sessionState = "active";
      this.saveMeta(meta);
      return this.runner(
        conversationId,
        message,
        (event) => {
          this.append(meta, event);
        },
        {
          runId,
          acceptedAt: meta.updatedAt,
          signal: controller.signal,
          draft: (text) => {
            this.setLiveDraft(conversationId, text);
          },
          ...(publishOperatorMessage ? {} : { internal: true as const }),
          ...(meta.parentConversationId === undefined ? {} : { side: true as const }),
          ...(workspace === undefined ? {} : { workspace }),
          ...(herdrPaneId === undefined ? {} : { seat: { herdrPaneId } }),
        },
      );
    };
    // A human send during an in-flight autonomous turn is admitted now so the
    // captain can steer it into the live pi run (ADR 0091). Other pairs stay FIFO.
    const work = joinLiveInternal ? invoke() : previous.then(invoke);
    const run = work
      .then(() => {
        const cancelled = this.cancelRequests.has(runId);
        this.append(
          meta,
          cancelled
            ? { type: "turn", runId, phase: "cancelled", reasonCode: "operator_interrupt" }
            : { type: "turn", runId, phase: "completed" },
        );
        if ((this.runCounts.get(conversationId) ?? 0) <= 1) meta.sessionState = "waiting";
        return !cancelled;
      })
      .catch((error: unknown) => {
        // An interrupt that surfaces as a runner throw is still a cancellation,
        // not a failure.
        if (this.cancelRequests.has(runId)) {
          this.append(meta, { type: "turn", runId, phase: "cancelled", reasonCode: "operator_interrupt" });
          if ((this.runCounts.get(conversationId) ?? 0) <= 1) meta.sessionState = "waiting";
          return false;
        }
        this.append(meta, {
          type: "turn",
          runId,
          phase: "failed",
          reasonCode: error instanceof Error ? error.constructor.name : "run_failed",
        });
        if ((this.runCounts.get(conversationId) ?? 0) <= 1) meta.sessionState = "failed";
        return false;
      })
      .finally(() => {
        meta.updatedAt = new Date().toISOString();
        this.saveMeta(meta);
        this.trimEventLog(meta);
        this.runs.delete(runId);
        this.runControllers.delete(runId);
        this.cancelRequests.delete(runId);
        const remaining = (this.runCounts.get(conversationId) ?? 1) - 1;
        if (remaining <= 0) this.runCounts.delete(conversationId);
        else this.runCounts.set(conversationId, remaining);
        // Nothing is typing here any more: a draft stranded by a failed or
        // interrupted turn comes down with the last run, not on the next one.
        if (remaining <= 0) this.setLiveDraft(conversationId, undefined);
        if (!publishOperatorMessage) {
          const remainingInternal = (this.internalRuns.get(conversationId) ?? 1) - 1;
          if (remainingInternal <= 0) this.internalRuns.delete(conversationId);
          else this.internalRuns.set(conversationId, remainingInternal);
        }
        this.prune(conversationId);
      });
    this.chains.set(
      conversationId,
      joinLiveInternal
        ? Promise.all([previous, run.then(() => undefined)]).then(() => undefined)
        : run.then(() => undefined),
    );
    this.runs.set(runId, run);
    return {
      schemaVersion: 1,
      status: "accepted",
      conversationId: meta.conversationId,
      runId,
      revision: meta.revision,
      safeCursor,
    };
  }

  private append(meta: ConversationMeta, body: OperatorConversationEventBody): void {
    const retainedCount = this.retainedEventCount(meta.conversationId);
    const sequence = this.eventSequence(meta) + 1;
    const cursor = String(sequence).padStart(CURSOR_WIDTH, "0");
    const event: OperatorConversationStreamEvent = {
      schemaVersion: 1,
      conversationId: meta.conversationId,
      cursor,
      revision: meta.revision,
      occurredAt: new Date().toISOString(),
      ...body,
    } as OperatorConversationStreamEvent;
    appendFileSync(this.eventsPath(meta.conversationId), `${JSON.stringify(event)}\n`, "utf8");
    this.counts.set(meta.conversationId, retainedCount + 1);
    this.sequences.set(meta.conversationId, sequence);
    if (body.type === "context") {
      meta.contextUsage = body.usage;
      this.saveMeta(meta);
    }
    if (meta.sessionState !== "active") this.trimEventLog(meta);
    this.wakeTails(meta.conversationId);
  }

  private waitForChange(conversationId: string, waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      let listeners = this.tailListeners.get(conversationId);
      if (listeners === undefined) {
        listeners = new Set();
        this.tailListeners.set(conversationId, listeners);
      }
      const registered = listeners;
      const done = (): void => {
        clearTimeout(timer);
        registered.delete(done);
        if (registered.size === 0) this.tailListeners.delete(conversationId);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      registered.add(done);
    });
  }

  private wakeTails(conversationId: string): void {
    const listeners = this.tailListeners.get(conversationId);
    if (listeners === undefined) return;
    // Each listener removes only itself as it resolves, and a set never
    // revisits an element it has already yielded, so this walks the live set.
    for (const listener of listeners) listener();
  }

  /**
   * The captain's answer as it is being typed ([ADR 0141](../../../../docs/adr/0141-the-console-watches-him-type.md)).
   * A draft is volatile: it lives in memory, never in `events.jsonl`, so replay,
   * retention, cursors, and every surface that only wants the record are
   * untouched by streaming. `undefined` takes the draft down — the durable
   * `message` event that settles it is the record. Callers throttle; every call
   * wakes the parked tails.
   */
  public setLiveDraft(conversationId: string, text: string | undefined): void {
    if (!this.metas.has(conversationId)) return;
    if (text === undefined || text.length === 0) {
      if (this.drafts.delete(conversationId)) this.wakeTails(conversationId);
      return;
    }
    this.draftSequence += 1;
    this.drafts.set(conversationId, {
      sequence: this.draftSequence,
      role: "captain",
      text: text.slice(0, OPERATOR_CONVERSATION_TEXT_MAX),
    });
    this.wakeTails(conversationId);
  }

  private readonly counts = new Map<string, number>();
  private readonly sequences = new Map<string, number>();

  private retainedEventCount(conversationId: string): number {
    const cached = this.counts.get(conversationId);
    if (cached !== undefined) return cached;
    const count = this.readEvents(conversationId).length;
    this.counts.set(conversationId, count);
    return count;
  }

  private eventSequence(meta: ConversationMeta): number {
    const cached = this.sequences.get(meta.conversationId);
    if (cached !== undefined) return cached;
    const events = this.readEvents(meta.conversationId);
    const cursor = events[events.length - 1]?.cursor ?? meta.retainedFromCursor ?? ZERO_CURSOR;
    const sequence = Number.parseInt(cursor, 10);
    this.sequences.set(meta.conversationId, sequence);
    return sequence;
  }

  private lastCursor(meta: ConversationMeta): string {
    return String(this.eventSequence(meta)).padStart(CURSOR_WIDTH, "0");
  }

  private trimEventLog(meta: ConversationMeta): void {
    if (this.retainedEventCount(meta.conversationId) <= OPERATOR_CONVERSATION_RETAINED_EVENTS_MAX) {
      return;
    }
    const events = this.readEvents(meta.conversationId);
    const dropped = events.slice(0, -OPERATOR_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM);
    const retained = events.slice(-OPERATOR_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM);
    meta.retainedFromCursor = dropped[dropped.length - 1]?.cursor ?? meta.retainedFromCursor ?? ZERO_CURSOR;
    const path = this.eventsPath(meta.conversationId);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${retained.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    renameSync(temporary, path);
    this.counts.set(meta.conversationId, retained.length);
    this.saveMeta(meta);
  }

  private readEvents(conversationId: string): OperatorConversationStreamEvent[] {
    let raw: string;
    try {
      raw = readFileSync(this.eventsPath(conversationId), "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as OperatorConversationStreamEvent];
        } catch {
          return [];
        }
      });
  }

  private eventsPath(conversationId: string): string {
    return join(this.root, conversationId, "events.jsonl");
  }

  private saveMeta(meta: ConversationMeta): void {
    writeFileSync(join(this.root, meta.conversationId, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  }

  /**
   * Conversation is the sole session/log lifetime. Recent inactive rooms are
   * retained for explicit `--chat` resume; old rooms leave as one directory,
   * including their public event log and their one Pi session tree.
   */
  private prune(protectedConversationId?: string): void {
    const sideParents = new Set(
      [...this.metas.values()].flatMap((meta) =>
        meta.parentConversationId === undefined ? [] : [meta.parentConversationId],
      ),
    );
    const removable = (): ConversationMeta[] =>
      [...this.metas.values()]
        .filter(
          (meta) =>
            !meta.isDefault &&
            meta.sessionState !== "active" &&
            !this.seatSends.has(meta.conversationId) &&
            !sideParents.has(meta.conversationId) &&
            meta.conversationId !== protectedConversationId,
        )
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const cutoff = Date.now() - OPERATOR_CONVERSATION_RETENTION_MS;
    for (const meta of removable().filter((candidate) => Date.parse(candidate.updatedAt) < cutoff)) {
      this.remove(meta);
    }
    while (this.metas.size > OPERATOR_CONVERSATION_RETAINED_MAX) {
      const oldest = removable()[0];
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    while (this.retainedBytes() > OPERATOR_CONVERSATION_RETAINED_BYTES_MAX) {
      const oldest = removable()[0];
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  private remove(meta: ConversationMeta): void {
    rmSync(join(this.root, meta.conversationId), { recursive: true, force: true });
    this.metas.delete(meta.conversationId);
    this.chains.delete(meta.conversationId);
    this.runCounts.delete(meta.conversationId);
    this.internalRuns.delete(meta.conversationId);
    this.counts.delete(meta.conversationId);
    this.sequences.delete(meta.conversationId);
    this.onPrune?.(meta.conversationId, meta.scope);
  }

  private async removeConversation(conversationId: string): Promise<boolean> {
    const meta = this.metas.get(conversationId);
    if (
      meta === undefined ||
      meta.isDefault ||
      this.seatSends.has(conversationId) ||
      [...this.metas.values()].some((candidate) => candidate.parentConversationId === conversationId)
    ) {
      return false;
    }
    if (meta.sessionState === "active" && meta.parentConversationId === undefined) return false;
    if (meta.parentConversationId !== undefined) {
      const activeRuns = [...this.runControllers.entries()].filter(
        ([, entry]) => entry.conversationId === conversationId,
      );
      for (const [runId, entry] of activeRuns) {
        this.cancelRequests.add(runId);
        entry.controller.abort();
      }
      await Promise.allSettled(
        activeRuns.flatMap(([runId]) => {
          const run = this.runs.get(runId);
          return run === undefined ? [] : [run];
        }),
      );
    }
    this.remove(meta);
    return true;
  }

  private retainedBytes(): number {
    return [...this.metas.keys()].reduce(
      (total, conversationId) => total + directoryBytes(join(this.root, conversationId)),
      0,
    );
  }
}

function directoryBytes(path: string): number {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path, { withFileTypes: true }).reduce(
    (total, entry) => total + (entry.isSymbolicLink() ? 0 : directoryBytes(join(path, entry.name))),
    0,
  );
}

function sameScope(a: OperatorConversationScope, b: OperatorConversationScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "workspace" && b.kind === "workspace") return a.workspaceId === b.workspaceId;
  if (a.kind === "seat" && b.kind === "seat") return a.seatId === b.seatId;
  return true;
}

function publicConversation(meta: ConversationMeta): OperatorConversation {
  return {
    schemaVersion: 1,
    conversationId: meta.conversationId,
    scope: meta.scope,
    title: meta.title,
    isDefault: meta.isDefault,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    sessionState: meta.sessionState,
    revision: meta.revision,
    ...(meta.contextUsage === undefined ? {} : { contextUsage: meta.contextUsage }),
    ...(meta.parentConversationId === undefined ? {} : { parentConversationId: meta.parentConversationId }),
  };
}
