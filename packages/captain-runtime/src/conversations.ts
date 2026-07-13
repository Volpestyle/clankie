import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  CreateOperatorConversationRequestSchema,
  OperatorConversationIdSchema,
  OperatorConversationSchema,
  OperatorConversationStreamEventSchema,
  OPERATOR_CONVERSATION_REPLAY_LIMIT_DEFAULT,
  OPERATOR_CONVERSATION_REPLAY_LIMIT_MAX,
  ReplayOperatorConversationRequestSchema,
  SubmitOperatorConversationTurnSchema,
  type OperatorConversation,
  type OperatorConversationEventBody,
  type OperatorConversationScope,
  type OperatorConversationStreamEvent,
  type OperatorConversationTailItem,
  type ReplayOperatorConversationRequest,
  type ReplayOperatorConversationResult,
  type SubmitOperatorConversationTurn,
  type SubmitOperatorConversationTurnResult,
} from "@clankie/protocol";
import type { CaptainIdentity } from "./types.ts";
import { CaptainProviderPressureError, type CaptainAdmissionController } from "./admission.ts";

interface ConversationRow {
  conversation_id: string;
  scope_kind: "global" | "workspace";
  workspace_id: string | null;
  title: string;
  is_default: 0 | 1;
  created_at: string;
  updated_at: string;
  session_state: "unbound" | "active" | "waiting" | "completed" | "failed";
  revision: number;
  session_id: string | null;
  continuation_token: string | null;
  eve_stream_index: number;
}

interface EventRow {
  sequence: number;
  conversation_id: string;
  revision: number;
  type: string;
  occurred_at: string;
  body_json: string;
}

export interface OperatorConversationRegistryOptions {
  readonly identity: CaptainIdentity;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  /** Durable run identity factory (distinct from conversation ids). */
  readonly runIdFactory?: () => string;
}

export class OperatorConversationOwnershipError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OperatorConversationOwnershipError";
  }
}

export class OperatorConversationMigrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OperatorConversationMigrationError";
  }
}

/** A message-kind submit — the only kind the local service executes today. */
export type OperatorConversationMessageTurn = Extract<SubmitOperatorConversationTurn, { kind: "message" }>;

export interface OperatorConversationTurnContext {
  /** Aborts only on provider preemption, never on caller disconnect/cancellation. */
  readonly signal: AbortSignal;
  readonly runId: string;
  /** Publish a redacted, bounded session event into the durable log/tail. */
  publish(body: OperatorConversationEventBody): void;
}

export type OperatorConversationTurnExecutor = (
  turn: OperatorConversationMessageTurn,
  context: OperatorConversationTurnContext,
) => Promise<void>;

export class OperatorConversationRegistry {
  private readonly database: DatabaseSync;
  private readonly identity: CaptainIdentity;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly runIdFactory: () => string;

  public constructor(database: DatabaseSync, options: OperatorConversationRegistryOptions) {
    this.database = database;
    this.identity = options.identity;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.runIdFactory = options.runIdFactory ?? (() => `run:${randomUUID()}`);
    this.initialize();
  }

  /** Atomic across processes: the partial unique index is the final arbiter. */
  public ensureDefaultGlobalConversation(): OperatorConversation {
    const now = this.clock().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertIdentity();
      this.migrateLegacyTuiLane(now);
      this.database
        .prepare(
          `INSERT OR IGNORE INTO operator_conversations (
          conversation_id, scope_kind, workspace_id, title, is_default,
          created_at, updated_at, session_state, revision
        ) VALUES ('global-default', 'global', NULL, 'Clankie', 1, ?, ?, 'unbound', 0)`,
        )
        .run(now, now);
      const row = this.database
        .prepare("SELECT * FROM operator_conversations WHERE is_default = 1 AND scope_kind = 'global'")
        .get() as unknown as ConversationRow | undefined;
      if (row === undefined) throw new Error("Default global conversation was not created");
      this.database.exec("COMMIT");
      return publicConversation(row);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public list(scope?: OperatorConversationScope): OperatorConversation[] {
    const rows =
      scope === undefined
        ? this.database
            .prepare(
              "SELECT * FROM operator_conversations ORDER BY is_default DESC, created_at, conversation_id",
            )
            .all()
        : scope.kind === "global"
          ? this.database
              .prepare(
                "SELECT * FROM operator_conversations WHERE scope_kind = 'global' ORDER BY is_default DESC, created_at, conversation_id",
              )
              .all()
          : this.database
              .prepare(
                "SELECT * FROM operator_conversations WHERE scope_kind = 'workspace' AND workspace_id = ? ORDER BY created_at, conversation_id",
              )
              .all(scope.workspaceId);
    return (rows as unknown as ConversationRow[]).map(publicConversation);
  }

  public get(conversationIdInput: string): OperatorConversation | undefined {
    const conversationId = OperatorConversationIdSchema.parse(conversationIdInput);
    const row = this.row(conversationId);
    return row === undefined ? undefined : publicConversation(row);
  }

  public create(input: {
    readonly scope: OperatorConversationScope;
    readonly title: string;
  }): OperatorConversation {
    const parsed = CreateOperatorConversationRequestSchema.parse({ schemaVersion: 1, ...input });
    const conversationId = OperatorConversationIdSchema.parse(this.idFactory());
    const now = this.clock().toISOString();
    this.database
      .prepare(
        `INSERT INTO operator_conversations (
        conversation_id, scope_kind, workspace_id, title, is_default,
        created_at, updated_at, session_state, revision
      ) VALUES (?, ?, ?, ?, 0, ?, ?, 'unbound', 0)`,
      )
      .run(
        conversationId,
        parsed.scope.kind,
        parsed.scope.kind === "workspace" ? parsed.scope.workspaceId : null,
        parsed.title,
        now,
        now,
      );
    return publicConversation(this.requiredRow(conversationId));
  }

  public bindSession(input: {
    readonly conversationId: string;
    readonly sessionId: string;
    readonly continuationToken?: string;
    readonly state?: "active" | "waiting" | "completed" | "failed";
  }): OperatorConversation {
    const conversationId = OperatorConversationIdSchema.parse(input.conversationId);
    const sessionId = privateValue(input.sessionId, "Session id");
    const token =
      input.continuationToken === undefined
        ? undefined
        : privateValue(input.continuationToken, "Continuation token");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.requiredRow(conversationId);
      const sessionOwner = this.database
        .prepare(
          "SELECT conversation_id FROM operator_conversations WHERE session_id = ? AND conversation_id <> ?",
        )
        .get(sessionId, conversationId) as { conversation_id: string } | undefined;
      if (sessionOwner !== undefined) {
        throw new OperatorConversationOwnershipError(
          `Session ${sessionId} is already owned by conversation ${sessionOwner.conversation_id}`,
        );
      }
      if (token !== undefined) {
        const tokenOwner = this.database
          .prepare(
            "SELECT conversation_id FROM operator_conversations WHERE continuation_token = ? AND conversation_id <> ?",
          )
          .get(token, conversationId) as { conversation_id: string } | undefined;
        if (tokenOwner !== undefined) {
          throw new OperatorConversationOwnershipError(
            `Continuation capability is already owned by conversation ${tokenOwner.conversation_id}`,
          );
        }
      }
      if (current.session_id !== null && current.session_id !== sessionId) {
        throw new OperatorConversationOwnershipError(
          `Conversation ${conversationId} already owns session ${current.session_id}`,
        );
      }
      if (current.continuation_token !== null && token === undefined) {
        throw new OperatorConversationOwnershipError(
          `Conversation ${conversationId} omitted its bound continuation capability`,
        );
      }
      // A rotated session id starts a fresh Eve stream, so reset the private
      // stream index; a same-session rebind preserves it (no re-projection).
      const rotated = current.session_id !== null && current.session_id !== sessionId;
      const now = this.clock().toISOString();
      this.database
        .prepare(
          `UPDATE operator_conversations
         SET session_id = ?, continuation_token = ?, session_state = ?, updated_at = ?${rotated ? ", eve_stream_index = 0" : ""}
         WHERE conversation_id = ?`,
        )
        .run(sessionId, token ?? current.continuation_token, input.state ?? "active", now, conversationId);
      this.database.exec("COMMIT");
      return publicConversation(this.requiredRow(conversationId));
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public privateSession(conversationIdInput: string): {
    readonly sessionId?: string;
    readonly continuationToken?: string;
  } {
    const row = this.requiredRow(OperatorConversationIdSchema.parse(conversationIdInput));
    return {
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      ...(row.continuation_token === null ? {} : { continuationToken: row.continuation_token }),
    };
  }

  /**
   * Rebinds a conversation's own durable Eve session, allowing that conversation
   * to rotate its session/continuation across turns (e.g. after a completed
   * boundary). Cross-conversation uniqueness stays fail-closed: a session or
   * continuation owned by a different conversation is still rejected.
   */
  public rebindSession(input: {
    readonly conversationId: string;
    readonly sessionId: string;
    readonly continuationToken?: string;
    readonly state?: "active" | "waiting" | "completed" | "failed";
  }): OperatorConversation {
    const conversationId = OperatorConversationIdSchema.parse(input.conversationId);
    const sessionId = privateValue(input.sessionId, "Session id");
    const token =
      input.continuationToken === undefined
        ? undefined
        : privateValue(input.continuationToken, "Continuation token");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.requiredRow(conversationId);
      const sessionOwner = this.database
        .prepare(
          "SELECT conversation_id FROM operator_conversations WHERE session_id = ? AND conversation_id <> ?",
        )
        .get(sessionId, conversationId) as { conversation_id: string } | undefined;
      if (sessionOwner !== undefined) {
        throw new OperatorConversationOwnershipError(
          `Session ${sessionId} is already owned by conversation ${sessionOwner.conversation_id}`,
        );
      }
      if (token !== undefined) {
        const tokenOwner = this.database
          .prepare(
            "SELECT conversation_id FROM operator_conversations WHERE continuation_token = ? AND conversation_id <> ?",
          )
          .get(token, conversationId) as { conversation_id: string } | undefined;
        if (tokenOwner !== undefined) {
          throw new OperatorConversationOwnershipError(
            `Continuation capability is already owned by conversation ${tokenOwner.conversation_id}`,
          );
        }
      }
      // A rotated session id starts a fresh Eve stream, so reset the private
      // stream index; a same-session rebind preserves it (no re-projection).
      const rotated = current.session_id !== null && current.session_id !== sessionId;
      const now = this.clock().toISOString();
      this.database
        .prepare(
          `UPDATE operator_conversations
         SET session_id = ?, continuation_token = ?, session_state = ?, updated_at = ?${rotated ? ", eve_stream_index = 0" : ""}
         WHERE conversation_id = ?`,
        )
        .run(sessionId, token ?? current.continuation_token, input.state ?? "active", now, conversationId);
      this.database.exec("COMMIT");
      return publicConversation(this.requiredRow(conversationId));
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Resolves the conversation that owns a durable Eve session. Transcript
   * projection uses this so a live captain event lands in the right conversation
   * by its session identity — never a process-global default — which keeps
   * simultaneous conversations independent.
   */
  public conversationForSession(sessionId: string): string | undefined {
    const normalized = sessionId.trim();
    if (normalized.length === 0) return undefined;
    const row = this.database
      .prepare("SELECT conversation_id FROM operator_conversations WHERE session_id = ?")
      .get(normalized) as { conversation_id: string } | undefined;
    return row?.conversation_id;
  }

  /**
   * Private per-conversation Eve stream index. The turn executor consumes
   * `Session.getEventStream(startIndex)` from here and advances it as it projects
   * events, so a resumed turn never re-projects the whole transcript. It resets
   * to 0 when the conversation's Eve session rotates (see {@link rebindSession}).
   */
  public eveStreamIndex(conversationIdInput: string): number {
    const row = this.requiredRow(OperatorConversationIdSchema.parse(conversationIdInput));
    return row.eve_stream_index;
  }

  public advanceEveStreamIndex(conversationIdInput: string, index: number): void {
    if (!Number.isSafeInteger(index) || index < 0)
      throw new Error("Eve stream index must be a non-negative integer");
    const conversationId = OperatorConversationIdSchema.parse(conversationIdInput);
    this.database
      .prepare(
        "UPDATE operator_conversations SET eve_stream_index = MAX(eve_stream_index, ?) WHERE conversation_id = ?",
      )
      .run(index, conversationId);
  }

  /**
   * Revision-fenced admission. A `message` turn advances the revision and durably
   * records a typed `turn.accepted` run event before this returns, so the caller
   * has an acknowledgement independent of whether execution has started. Submit
   * kinds without captain wiring return a typed `unsupported` result — never a
   * false `accepted` — and cause no side effect.
   */
  public acceptTurn(turnInput: SubmitOperatorConversationTurn): SubmitOperatorConversationTurnResult {
    const turn = SubmitOperatorConversationTurnSchema.parse(turnInput);
    if (turn.kind !== "message") {
      return {
        schemaVersion: 1,
        status: "unsupported",
        conversationId: turn.conversationId,
        submitKind: turn.kind,
        reason: unsupportedSubmitReason(turn.kind),
      };
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.requiredRow(turn.conversationId);
      if (current.revision !== turn.expectedRevision) {
        const result: SubmitOperatorConversationTurnResult = {
          schemaVersion: 1,
          status: "revision_conflict",
          conversationId: turn.conversationId,
          expectedRevision: turn.expectedRevision,
          currentRevision: current.revision,
          safeCursor: this.safeCursor(turn.conversationId),
        };
        this.database.exec("COMMIT");
        return result;
      }
      const revision = current.revision + 1;
      const runId = this.runIdFactory();
      const now = this.clock().toISOString();
      this.database
        .prepare("UPDATE operator_conversations SET revision = ?, updated_at = ? WHERE conversation_id = ?")
        .run(revision, now, turn.conversationId);
      // Durably record the operator's own message before the acceptance marker,
      // in the same revision, so replay after restart reconstructs both sides of
      // the transcript (operator message + captain response + lifecycle).
      this.appendEventInTransaction(turn.conversationId, revision, now, {
        type: "message",
        role: "operator",
        text: turn.message,
        streaming: false,
      });
      const acceptedCursor = this.appendEventInTransaction(turn.conversationId, revision, now, {
        type: "turn",
        runId,
        phase: "accepted",
      });
      this.database.exec("COMMIT");
      return {
        schemaVersion: 1,
        status: "accepted",
        conversationId: turn.conversationId,
        runId,
        revision,
        safeCursor: acceptedCursor,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Append a redacted, bounded, typed session event at the current revision. */
  public appendEvent(
    conversationIdInput: string,
    body: OperatorConversationEventBody,
  ): OperatorConversationStreamEvent {
    const conversationId = OperatorConversationIdSchema.parse(conversationIdInput);
    const row = this.requiredRow(conversationId);
    const occurredAt = this.clock().toISOString();
    const cursor = this.appendEventInTransaction(conversationId, row.revision, occurredAt, body);
    return OperatorConversationStreamEventSchema.parse({
      ...body,
      schemaVersion: 1,
      conversationId,
      cursor,
      revision: row.revision,
      occurredAt,
    });
  }

  /**
   * Bounded, pageable replay. Never throws for client recovery: malformed,
   * ahead-of-log, or below-retention cursors and unknown conversations return a
   * typed recovery envelope with a reset cursor.
   */
  public replay(requestInput: ReplayOperatorConversationRequest): ReplayOperatorConversationResult {
    const request = ReplayOperatorConversationRequestSchema.parse(requestInput);
    const row = this.row(request.conversationId);
    if (row === undefined) {
      return this.recover(
        request.conversationId,
        "unknown_conversation",
        false,
        cursor(0, request.conversationId),
      );
    }
    const maxSequence = this.maxSequence(request.conversationId);
    const minSequence = this.minSequence(request.conversationId);
    const retainedFromSequence = minSequence === 0 ? 0 : minSequence - 1;
    const retainedFromCursor = cursor(retainedFromSequence, request.conversationId);

    let after = 0;
    if (request.cursor !== undefined) {
      // A malformed cursor OR a cursor bound to a different conversation both
      // fail closed as cursor_invalid; a conversation-A cursor can never advance
      // conversation B.
      const parsed = tryParseCursorSequence(request.cursor, request.conversationId);
      if (parsed === undefined) {
        return this.recover(request.conversationId, "cursor_invalid", true, retainedFromCursor);
      }
      if (parsed > maxSequence) {
        return this.recover(
          request.conversationId,
          "cursor_reset",
          true,
          cursor(maxSequence, request.conversationId),
        );
      }
      if (parsed < retainedFromSequence) {
        return this.recover(request.conversationId, "cursor_expired", true, retainedFromCursor);
      }
      after = parsed;
    }

    const limit = request.limit ?? OPERATOR_CONVERSATION_REPLAY_LIMIT_DEFAULT;
    const rows = this.database
      .prepare(
        "SELECT * FROM operator_conversation_events WHERE conversation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      )
      .all(request.conversationId, after, limit + 1) as unknown as EventRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const events = page.map(publicEvent);
    const nextSequence = page.length === 0 ? after : (page.at(-1)?.sequence ?? after);
    return {
      schemaVersion: 1,
      status: "page",
      conversationId: request.conversationId,
      surfaceClientId: request.surfaceClientId,
      events,
      retainedFromCursor,
      nextCursor: cursor(nextSequence, request.conversationId),
      safeCursor: cursor(maxSequence, request.conversationId),
      hasMore,
    };
  }

  public safeCursor(conversationIdInput: string): string {
    const conversationId = OperatorConversationIdSchema.parse(conversationIdInput);
    return cursor(this.maxSequence(conversationId), conversationId);
  }

  public close(): void {
    this.database.close();
  }

  private recover(
    conversationId: string,
    code: "cursor_invalid" | "cursor_expired" | "cursor_reset" | "run_conflict" | "unknown_conversation",
    recoverable: boolean,
    resetCursor: string,
  ): ReplayOperatorConversationResult {
    return {
      schemaVersion: 1,
      status: "recover",
      conversationId,
      code,
      recoverable,
      resetCursor,
      message: RECOVERY_MESSAGES[code],
    };
  }

  private maxSequence(conversationId: string): number {
    const result = this.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM operator_conversation_events WHERE conversation_id = ?",
      )
      .get(conversationId) as { sequence: number };
    return result.sequence;
  }

  private minSequence(conversationId: string): number {
    const result = this.database
      .prepare(
        "SELECT COALESCE(MIN(sequence), 0) AS sequence FROM operator_conversation_events WHERE conversation_id = ?",
      )
      .get(conversationId) as { sequence: number };
    return result.sequence;
  }

  private initialize(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS operator_registry_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        agent_definition_id TEXT NOT NULL,
        soul_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        character_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS operator_conversations (
        conversation_id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'workspace')),
        workspace_id TEXT,
        title TEXT NOT NULL,
        is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        session_state TEXT NOT NULL CHECK (session_state IN ('unbound', 'active', 'waiting', 'completed', 'failed')),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        session_id TEXT UNIQUE,
        continuation_token TEXT UNIQUE,
        eve_stream_index INTEGER NOT NULL DEFAULT 0 CHECK (eve_stream_index >= 0),
        CHECK ((scope_kind = 'global' AND workspace_id IS NULL) OR (scope_kind = 'workspace' AND workspace_id IS NOT NULL)),
        CHECK (is_default = 0 OR scope_kind = 'global')
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS operator_default_global
        ON operator_conversations(is_default) WHERE is_default = 1;
      CREATE TABLE IF NOT EXISTS operator_conversation_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES operator_conversations(conversation_id),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        body_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS operator_conversation_events_replay
        ON operator_conversation_events(conversation_id, sequence);
    `);
    // Defensive column add for a registry created before the Eve stream index
    // existed; a duplicate-column error means it is already present.
    try {
      this.database.exec(
        "ALTER TABLE operator_conversations ADD COLUMN eve_stream_index INTEGER NOT NULL DEFAULT 0",
      );
    } catch {
      // Column already exists.
    }
    const stored = this.database
      .prepare("SELECT * FROM operator_registry_identity WHERE singleton = 1")
      .get() as Record<string, unknown> | undefined;
    if (stored === undefined) {
      this.database
        .prepare(
          `INSERT INTO operator_registry_identity
          (singleton, agent_definition_id, soul_id, provider_id, character_id)
         VALUES (1, ?, ?, ?, ?)`,
        )
        .run(
          this.identity.agentDefinitionId,
          this.identity.soulId,
          this.identity.providerId,
          this.identity.characterId,
        );
    }
    this.assertIdentity();
  }

  private assertIdentity(): void {
    const stored = this.database
      .prepare("SELECT * FROM operator_registry_identity WHERE singleton = 1")
      .get() as Record<string, unknown>;
    if (
      stored.agent_definition_id !== this.identity.agentDefinitionId ||
      stored.soul_id !== this.identity.soulId ||
      stored.provider_id !== this.identity.providerId ||
      stored.character_id !== this.identity.characterId
    ) {
      throw new OperatorConversationMigrationError(
        "Operator conversation registry identity changed; explicit captain identity migration is required",
      );
    }
  }

  private migrateLegacyTuiLane(now: string): void {
    const table = this.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'captain_lanes'")
      .get();
    if (table === undefined) return;
    const legacy = this.database.prepare("SELECT * FROM captain_lanes WHERE lane = 'tui'").all() as Array<
      Record<string, unknown>
    >;
    if (legacy.length > 1) {
      throw new OperatorConversationMigrationError(
        "Multiple legacy TUI lanes cannot be migrated without forking identity",
      );
    }
    const row = legacy[0];
    if (row === undefined) return;
    const existingDefault = this.database
      .prepare("SELECT * FROM operator_conversations WHERE is_default = 1")
      .get() as ConversationRow | undefined;
    if (existingDefault !== undefined) {
      if (row.session_id !== null && existingDefault.session_id !== row.session_id) {
        throw new OperatorConversationMigrationError(
          "Legacy TUI session conflicts with the default operator conversation",
        );
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO operator_conversations (
        conversation_id, scope_kind, workspace_id, title, is_default, created_at, updated_at,
        session_state, revision, session_id, continuation_token
      ) VALUES ('global-default', 'global', NULL, 'Clankie', 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        typeof row.created_at === "string" ? row.created_at : now,
        typeof row.updated_at === "string" ? row.updated_at : now,
        typeof row.state === "string" ? row.state : "active",
        Number(row.revision ?? 0),
        typeof row.session_id === "string" ? row.session_id : null,
        typeof row.continuation_token === "string" ? row.continuation_token : null,
      );
  }

  private row(conversationId: string): ConversationRow | undefined {
    return this.database
      .prepare("SELECT * FROM operator_conversations WHERE conversation_id = ?")
      .get(conversationId) as unknown as ConversationRow | undefined;
  }

  private requiredRow(conversationId: string): ConversationRow {
    const row = this.row(conversationId);
    if (row === undefined) throw new Error(`Unknown operator conversation ${conversationId}`);
    return row;
  }

  private appendEventInTransaction(
    conversationId: string,
    revision: number,
    occurredAt: string,
    body: OperatorConversationEventBody,
  ): string {
    // Validate against the strict public schema BEFORE committing the row so a
    // redaction-bypass or over-bound body is rejected and the database is left
    // unchanged, rather than durably persisted and only rejected on read.
    OperatorConversationStreamEventSchema.parse({
      ...body,
      schemaVersion: 1,
      conversationId,
      cursor: cursor(0, conversationId),
      revision,
      occurredAt,
    });
    const result = this.database
      .prepare(
        `INSERT INTO operator_conversation_events
        (conversation_id, revision, type, occurred_at, body_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(conversationId, revision, body.type, occurredAt, JSON.stringify(body));
    return cursor(Number(result.lastInsertRowid), conversationId);
  }
}

export interface OperatorConversationPort {
  list(scope?: OperatorConversationScope): Promise<readonly OperatorConversation[]>;
  get(conversationId: string): Promise<OperatorConversation | undefined>;
  create(input: {
    readonly scope: OperatorConversationScope;
    readonly title: string;
  }): Promise<OperatorConversation>;
  replay(request: ReplayOperatorConversationRequest): Promise<ReplayOperatorConversationResult>;
  /** Yields durable events, then one `recovery` item and STOPS on a typed recovery outcome. */
  tail(
    request: ReplayOperatorConversationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OperatorConversationTailItem>;
  send(input: SubmitOperatorConversationTurn): Promise<SubmitOperatorConversationTurnResult>;
}

export class LocalOperatorConversationService implements OperatorConversationPort {
  private readonly registry: OperatorConversationRegistry;
  private readonly admission: CaptainAdmissionController;
  private readonly executeTurn: OperatorConversationTurnExecutor;
  private readonly tailIdleMs: number;
  private readonly running = new Map<string, Promise<void>>();

  public constructor(
    registry: OperatorConversationRegistry,
    admission: CaptainAdmissionController,
    executeTurn: OperatorConversationTurnExecutor,
    options: { readonly tailIdleMs?: number } = {},
  ) {
    this.registry = registry;
    this.admission = admission;
    this.executeTurn = executeTurn;
    this.tailIdleMs = options.tailIdleMs ?? 25;
  }

  public list(scope?: OperatorConversationScope): Promise<readonly OperatorConversation[]> {
    return Promise.resolve(this.registry.list(scope));
  }
  public get(conversationId: string): Promise<OperatorConversation | undefined> {
    return Promise.resolve(this.registry.get(conversationId));
  }
  public create(input: {
    readonly scope: OperatorConversationScope;
    readonly title: string;
  }): Promise<OperatorConversation> {
    return Promise.resolve(this.registry.create(input));
  }
  public replay(request: ReplayOperatorConversationRequest): Promise<ReplayOperatorConversationResult> {
    return Promise.resolve(this.registry.replay(request));
  }
  public async *tail(
    request: ReplayOperatorConversationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OperatorConversationTailItem> {
    let cursor = request.cursor;
    while (signal?.aborted !== true) {
      const result = this.registry.replay({ ...request, ...(cursor === undefined ? {} : { cursor }) });
      if (result.status === "recover") {
        // Surface the typed recovery and stop; the caller decides whether to
        // reset. Never silently resync past a reset boundary.
        yield { kind: "recovery", recovery: result };
        return;
      }
      for (const event of result.events) yield { kind: "event", event };
      cursor = result.nextCursor;
      if (result.events.length === 0) await sleep(this.tailIdleMs);
    }
  }

  /**
   * Immediate durable acknowledgement. The revision commit and `turn.accepted`
   * run event are returned promptly; the admitted turn then runs detached from
   * the caller — caller disconnect or cancellation cannot cancel accepted work —
   * and publishes a terminal `completed`/`failed`/`cancelled` run event through
   * the tail without rolling back the revision.
   */
  public send(input: SubmitOperatorConversationTurn): Promise<SubmitOperatorConversationTurnResult> {
    const accepted = this.registry.acceptTurn(input);
    if (accepted.status !== "accepted") return Promise.resolve(accepted);
    const turn = input as OperatorConversationMessageTurn;
    const runId = accepted.runId;
    const conversationId = accepted.conversationId;
    const run = this.admission
      .execute(
        {
          requestId: `operator:${conversationId}:${runId}`,
          laneKey: conversationId,
          lane: "operator",
        },
        (signal) =>
          this.executeTurn(turn, {
            signal,
            runId,
            publish: (body) => {
              this.registry.appendEvent(conversationId, body);
            },
          }),
      )
      .then(() => {
        this.registry.appendEvent(conversationId, { type: "turn", runId, phase: "completed" });
      })
      .catch((error: unknown) => {
        const phase = isAbort(error) ? "cancelled" : "failed";
        this.registry.appendEvent(conversationId, {
          type: "turn",
          runId,
          phase,
          reasonCode: reasonCodeFor(error),
        });
      })
      .finally(() => {
        this.running.delete(runId);
      });
    this.running.set(runId, run);
    return Promise.resolve(accepted);
  }

  /** Awaits a detached run's terminal event; resolves immediately if unknown/settled. */
  public awaitRun(runId: string): Promise<void> {
    return this.running.get(runId) ?? Promise.resolve();
  }
}

/**
 * Read-only view of the server-owned registry. Co-located surfaces (the TUI)
 * enumerate/select the same conversations the captain owns without becoming a
 * second writer: it opens the SQLite file read-only and never runs DDL, so the
 * captain remains the singleton owner (ADR 0014). It exposes only reads; writes
 * flow through the captain's callable service or the durable Eve session.
 */
export class OperatorConversationReader {
  private readonly database: DatabaseSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
  }

  public list(scope?: OperatorConversationScope): OperatorConversation[] {
    const rows =
      scope === undefined
        ? this.database
            .prepare(
              "SELECT * FROM operator_conversations ORDER BY is_default DESC, created_at, conversation_id",
            )
            .all()
        : scope.kind === "global"
          ? this.database
              .prepare(
                "SELECT * FROM operator_conversations WHERE scope_kind = 'global' ORDER BY is_default DESC, created_at, conversation_id",
              )
              .all()
          : this.database
              .prepare(
                "SELECT * FROM operator_conversations WHERE scope_kind = 'workspace' AND workspace_id = ? ORDER BY created_at, conversation_id",
              )
              .all(scope.workspaceId);
    return (rows as unknown as ConversationRow[]).map(publicConversation);
  }

  public get(conversationIdInput: string): OperatorConversation | undefined {
    const conversationId = OperatorConversationIdSchema.parse(conversationIdInput);
    const row = this.database
      .prepare("SELECT * FROM operator_conversations WHERE conversation_id = ?")
      .get(conversationId) as unknown as ConversationRow | undefined;
    return row === undefined ? undefined : publicConversation(row);
  }

  public close(): void {
    this.database.close();
  }
}

/**
 * Opens the server-owned registry read-only. Rejects if the captain has not yet
 * created it, so a surface never silently mints a private conversation store.
 */
export async function openOperatorConversationReader(path: string): Promise<OperatorConversationReader> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.prepare("SELECT 1 FROM operator_conversations LIMIT 1").get();
  } catch (error) {
    database.close();
    throw new Error(`Operator conversation registry is not available at ${path}; start the captain first.`, {
      cause: error,
    });
  }
  return new OperatorConversationReader(database);
}

export async function openOperatorConversationRegistry(
  path: string,
  options: OperatorConversationRegistryOptions,
): Promise<OperatorConversationRegistry> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const database = new DatabaseSync(path);
  await chmod(path, 0o600);
  try {
    const registry = new OperatorConversationRegistry(database, options);
    registry.ensureDefaultGlobalConversation();
    return registry;
  } catch (error) {
    database.close();
    throw error;
  }
}

const RECOVERY_MESSAGES: Readonly<
  Record<
    "cursor_invalid" | "cursor_expired" | "cursor_reset" | "run_conflict" | "unknown_conversation",
    string
  >
> = {
  cursor_invalid: "Replay cursor is malformed; reset to the retained lower bound.",
  cursor_expired: "Replay cursor is below the retained lower bound; reset and replay.",
  cursor_reset: "Replay cursor is ahead of the durable log; reset to the latest cursor.",
  run_conflict: "The tailed run was superseded; reset to the latest cursor.",
  unknown_conversation: "The conversation is unknown; select an existing conversation.",
};

function unsupportedSubmitReason(kind: "input_response" | "worker_steer"): string {
  return kind === "input_response"
    ? "Deferred: typed input responses are defined but their captain wiring has not landed (see docs/16-operator-conversations.md)."
    : "Deferred: worker steering over the conversation lane is defined but its captain wiring has not landed (see docs/16-operator-conversations.md).";
}

function reasonCodeFor(error: unknown): string {
  if (error instanceof CaptainProviderPressureError) return "provider_pressure";
  if (isAbort(error)) return "cancelled";
  return "execution_failed";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/iu.test(error.message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicConversation(row: ConversationRow): OperatorConversation {
  return OperatorConversationSchema.parse({
    schemaVersion: 1,
    conversationId: row.conversation_id,
    scope:
      row.scope_kind === "global" ? { kind: "global" } : { kind: "workspace", workspaceId: row.workspace_id },
    title: row.title,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionState: row.session_state,
    revision: row.revision,
  });
}

function publicEvent(row: EventRow): OperatorConversationStreamEvent {
  const body = JSON.parse(row.body_json) as Record<string, unknown>;
  return OperatorConversationStreamEventSchema.parse({
    ...body,
    schemaVersion: 1,
    conversationId: row.conversation_id,
    cursor: cursor(row.sequence, row.conversation_id),
    revision: row.revision,
    occurredAt: row.occurred_at,
  });
}

/**
 * Opaque cursors are conversation-bound: the sequence carries a short binding of
 * its conversation id, so a cursor issued for conversation A is rejected as
 * `cursor_invalid` on conversation B and can never silently advance it. Surfaces
 * remain independent caller-held positions (ADR 0032) — cross-surface reuse
 * within one conversation is allowed and no exclusive/takeover state is stored.
 */
function conversationCursorBinding(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("base64url").slice(0, 12);
}

function cursor(sequence: number, conversationId: string): string {
  return `event:${sequence}:${conversationCursorBinding(conversationId)}`;
}

function tryParseCursorSequence(value: string, conversationId: string): number | undefined {
  const match = /^event:(\d+):([A-Za-z0-9_-]{12})$/u.exec(value.trim());
  if (match === null) return undefined;
  if (match[2] !== conversationCursorBinding(conversationId)) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

function privateValue(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 8192) throw new Error(`${label} is invalid`);
  return normalized;
}

export const OPERATOR_CONVERSATION_MAX_REPLAY_PAGE = OPERATOR_CONVERSATION_REPLAY_LIMIT_MAX;
