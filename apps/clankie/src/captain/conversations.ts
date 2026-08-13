import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  OperatorConversation,
  OperatorConversationEventBody,
  OperatorConversationScope,
  OperatorConversationServiceRequest,
  OperatorConversationServiceResult,
  OperatorConversationStreamEvent,
  ReplayOperatorConversationRequest,
  ReplayOperatorConversationResult,
  SubmitOperatorConversationTurn,
  SubmitOperatorConversationTurnResult,
} from "@clankie/protocol";

const CURSOR_WIDTH = 12;
const ZERO_CURSOR = "0".repeat(CURSOR_WIDTH);

interface ConversationMeta {
  readonly conversationId: string;
  readonly scope: OperatorConversationScope;
  readonly title: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
  updatedAt: string;
  revision: number;
  sessionState: OperatorConversation["sessionState"];
}

/** Runs one accepted operator turn against the captain's model session. */
export type ConversationRunner = (
  conversationId: string,
  message: string,
  publish: (event: OperatorConversationEventBody) => void,
) => Promise<void>;

/**
 * File-backed conversation registry: `meta.json` + append-only `events.jsonl`
 * per conversation. The wire contract (list/get/create/replay/tail/send with
 * revision fencing and cursored pages) is the one the TUI and relay already
 * speak; the captain-runtime package that used to serve it is gone, so this is
 * its lazy successor. Cursors are zero-padded line counts.
 */
export class ConversationStore {
  private readonly metas = new Map<string, ConversationMeta>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, Promise<void>>();

  private readonly root: string;
  private readonly runner: ConversationRunner;

  public constructor(root: string, runner: ConversationRunner) {
    this.root = root;
    this.runner = runner;
    mkdirSync(root, { recursive: true });
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = JSON.parse(readFileSync(join(root, entry.name, "meta.json"), "utf8")) as ConversationMeta;
        // A crash mid-run leaves "active"; on boot nothing is running.
        if (meta.sessionState === "active") meta.sessionState = "waiting";
        this.metas.set(meta.conversationId, meta);
      } catch {
        // An unreadable conversation is skipped, never fatal to boot.
      }
    }
  }

  public async serve(request: OperatorConversationServiceRequest): Promise<OperatorConversationServiceResult> {
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
      case "replay":
        return { op: "replay", schemaVersion: 1, result: this.replay(request.replay) };
      case "tail":
        return { op: "tail", schemaVersion: 1, result: this.replay(request.tail) };
      case "send":
        return { op: "send", schemaVersion: 1, result: this.send(request.turn) };
      default: {
        const exhaustive: never = request;
        throw new Error(`Unknown operator conversation op ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /** Keeps an accepted detached run alive for the transport's waitUntil. */
  public awaitRun(runId: string): Promise<void> {
    return this.runs.get(runId) ?? Promise.resolve();
  }

  public async close(): Promise<void> {
    await Promise.allSettled([...this.runs.values()]);
  }

  private create(scope: OperatorConversationScope, title: string): OperatorConversation {
    const now = new Date().toISOString();
    const meta: ConversationMeta = {
      conversationId: `conv-${randomUUID()}`,
      scope,
      title,
      isDefault: this.metas.size === 0,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      sessionState: "unbound",
    };
    mkdirSync(join(this.root, meta.conversationId), { recursive: true });
    this.metas.set(meta.conversationId, meta);
    this.saveMeta(meta);
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
    const safeCursor = events.length === 0 ? ZERO_CURSOR : events[events.length - 1]!.cursor;
    const from = request.cursor ?? ZERO_CURSOR;
    if (!/^\d+$/u.test(from) || from.length > CURSOR_WIDTH) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: meta.conversationId,
        code: "cursor_invalid",
        recoverable: true,
        resetCursor: ZERO_CURSOR,
        message: "That cursor is not from this conversation; replay from the start.",
      };
    }
    const limit = request.limit ?? 200;
    const page = events.filter((event) => event.cursor > from).slice(0, limit);
    return {
      schemaVersion: 1,
      status: "page",
      conversationId: meta.conversationId,
      surfaceClientId: request.surfaceClientId,
      events: page,
      retainedFromCursor: ZERO_CURSOR,
      nextCursor: page.length === 0 ? from : page[page.length - 1]!.cursor,
      safeCursor,
      hasMore: page.length < events.filter((event) => event.cursor > from).length,
    };
  }

  private send(turn: SubmitOperatorConversationTurn): SubmitOperatorConversationTurnResult {
    const meta = this.metas.get(turn.conversationId);
    if (meta === undefined) {
      throw new Error(`Unknown conversation ${turn.conversationId}`);
    }
    const safeCursor = this.lastCursor(meta.conversationId);
    if (turn.kind !== "message") {
      return {
        schemaVersion: 1,
        status: "unsupported",
        conversationId: meta.conversationId,
        submitKind: turn.kind,
        reason:
          turn.kind === "worker_steer"
            ? "Workers are herdr panes now; steer them in herdr."
            : "Typed input responses are not wired to the pi captain.",
      };
    }
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
    meta.revision += 1;
    meta.sessionState = "active";
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    const runId = `run-${randomUUID()}`;
    this.append(meta, { type: "message", role: "operator", text: turn.message, streaming: false });
    this.append(meta, { type: "turn", runId, phase: "accepted" });

    const previous = this.chains.get(meta.conversationId) ?? Promise.resolve();
    const run = previous
      .then(() =>
        this.runner(meta.conversationId, turn.message, (event) => {
          this.append(meta, event);
        }),
      )
      .then(() => {
        this.append(meta, { type: "turn", runId, phase: "completed" });
        meta.sessionState = "waiting";
      })
      .catch((error: unknown) => {
        this.append(meta, {
          type: "turn",
          runId,
          phase: "failed",
          reasonCode: error instanceof Error ? error.constructor.name : "run_failed",
        });
        meta.sessionState = "failed";
      })
      .finally(() => {
        meta.updatedAt = new Date().toISOString();
        this.saveMeta(meta);
        this.runs.delete(runId);
      });
    this.chains.set(meta.conversationId, run);
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
    const cursor = String(this.eventCount(meta.conversationId) + 1).padStart(CURSOR_WIDTH, "0");
    const event: OperatorConversationStreamEvent = {
      schemaVersion: 1,
      conversationId: meta.conversationId,
      cursor,
      revision: meta.revision,
      occurredAt: new Date().toISOString(),
      ...body,
    } as OperatorConversationStreamEvent;
    appendFileSync(this.eventsPath(meta.conversationId), `${JSON.stringify(event)}\n`, "utf8");
    this.counts.set(meta.conversationId, this.eventCount(meta.conversationId) + 1);
  }

  private readonly counts = new Map<string, number>();

  private eventCount(conversationId: string): number {
    const cached = this.counts.get(conversationId);
    if (cached !== undefined) return cached;
    const count = this.readEvents(conversationId).length;
    this.counts.set(conversationId, count);
    return count;
  }

  private lastCursor(conversationId: string): string {
    const count = this.eventCount(conversationId);
    return count === 0 ? ZERO_CURSOR : String(count).padStart(CURSOR_WIDTH, "0");
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
}

function sameScope(a: OperatorConversationScope, b: OperatorConversationScope): boolean {
  return a.kind === b.kind && (a.kind !== "workspace" || b.kind !== "workspace" || a.workspaceId === b.workspaceId);
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
  };
}
