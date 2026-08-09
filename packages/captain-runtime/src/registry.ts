import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CaptainLane } from "@clankie/protocol";
import {
  captainLaneKey,
  parseCaptainLaneAddress,
  validateCaptainIdentity,
  type CaptainIdentity,
  type CaptainLaneAddress,
  type CaptainLaneResumeState,
  type CaptainLaneSessionState,
  type CaptainLaneSnapshot,
  type CaptainRuntimeEventSink,
} from "./types.ts";

interface LaneRow {
  lane_key: string;
  character_id: string;
  lane: CaptainLane;
  target_id: string;
  session_id: string | null;
  continuation_token: string | null;
  state: CaptainLaneSessionState;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface LaneSessionRow {
  session_id: string;
  lane_key: string;
  bound_at: string;
  last_seen_at: string;
}

/**
 * How many past sessions one room keeps. A Discord text room mints a fresh Eve
 * session per message, so the current session is only ever the latest turn;
 * without this history the room has no readable past at all.
 */
export const CAPTAIN_LANE_SESSION_HISTORY_MAX = 64;

/** One Eve session a room has run, for reading that room's past back. */
export interface CaptainLaneSessionRecord {
  readonly sessionId: string;
  readonly boundAt: string;
  readonly lastSeenAt: string;
}

export interface CaptainLaneRegistryOptions {
  readonly identity: CaptainIdentity;
  readonly clock?: () => Date;
  readonly events?: CaptainRuntimeEventSink;
}

export class CaptainContinuationOwnershipError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CaptainContinuationOwnershipError";
  }
}

export class CaptainLaneSessionConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CaptainLaneSessionConflictError";
  }
}

export class CaptainLaneRegistry {
  public readonly identity: CaptainIdentity;
  private readonly database: DatabaseSync;
  private readonly clock: () => Date;
  private readonly eventSink: CaptainRuntimeEventSink;
  private readonly observedKeys = new Set<string>();

  public constructor(database: DatabaseSync, options: CaptainLaneRegistryOptions) {
    this.database = database;
    this.identity = validateCaptainIdentity(options.identity);
    this.clock = options.clock ?? (() => new Date());
    this.eventSink = options.events ?? (() => undefined);
    this.initialize();
  }

  public async register(addressInput: CaptainLaneAddress): Promise<CaptainLaneSnapshot> {
    const address = parseCaptainLaneAddress(addressInput);
    this.assertCharacter(address.characterId);
    const key = captainLaneKey(address);
    const existing = this.row(key);
    if (existing !== undefined) {
      if (!this.observedKeys.has(key)) {
        this.observedKeys.add(key);
        await this.emit("lane.restored", existing);
      }
      return snapshot(existing);
    }
    const now = this.clock().toISOString();
    this.database
      .prepare(
        `INSERT INTO captain_lanes (
          lane_key, character_id, lane, target_id, state, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)`,
      )
      .run(key, address.characterId, address.lane, address.targetId, now, now);
    const created = this.requiredRow(key);
    this.observedKeys.add(key);
    await this.emit("lane.registered", created);
    return snapshot(created);
  }

  public async bindSession(
    addressInput: CaptainLaneAddress,
    input: {
      readonly sessionId: string;
      readonly continuationToken?: string;
      readonly state?: CaptainLaneSessionState;
    },
  ): Promise<CaptainLaneSnapshot> {
    const address = parseCaptainLaneAddress(addressInput);
    const key = captainLaneKey(address);
    await this.register(address);
    const current = this.requiredRow(key);
    const sessionId = requiredSecret(input.sessionId, "Session id");
    const continuationToken = optionalSecret(input.continuationToken, "Continuation token");
    this.assertSessionOwnership(key, sessionId);
    if (continuationToken !== undefined) this.assertContinuationOwnership(key, continuationToken);
    const rotating = current.session_id !== null && current.session_id !== sessionId;
    // A room parked on `waiting` is between turns, and a lane that mints a fresh
    // Eve session per message (Discord text) arrives here with a new id every
    // time. Refusing that stranded such a room on its first session forever —
    // the registry, `/captain/v1/lanes`, and anything reading the room's past
    // all kept pointing at a session that had already been replaced. Only a
    // genuinely in-flight turn still refuses to be displaced.
    if (rotating && current.state === "active") {
      throw new CaptainLaneSessionConflictError(
        `Lane ${key} still owns active session ${String(current.session_id)}; it cannot adopt ${sessionId}`,
      );
    }
    if (
      current.session_id === sessionId &&
      current.continuation_token !== null &&
      continuationToken === undefined
    ) {
      throw new CaptainContinuationOwnershipError(`Lane ${key} omitted its already-bound continuation token`);
    }
    // A continuation token resumes the session that issued it. Carrying the old
    // one onto a rotated session id would hand the new session a resume handle
    // for a conversation it is not.
    const token = rotating ? (continuationToken ?? null) : (continuationToken ?? current.continuation_token);
    const state = input.state ?? "active";
    const changed =
      current.session_id !== sessionId || current.continuation_token !== token || current.state !== state;
    if (!changed) {
      this.recordSession(key, sessionId);
      return snapshot(current);
    }
    const updatedAt = this.clock().toISOString();
    this.database
      .prepare(
        `UPDATE captain_lanes
         SET session_id = ?, continuation_token = ?, state = ?, revision = revision + 1,
             updated_at = ?
         WHERE lane_key = ?`,
      )
      .run(sessionId, token, state, updatedAt, key);
    this.recordSession(key, sessionId);
    const updated = this.requiredRow(key);
    await this.emit("lane.session.bound", updated);
    return snapshot(updated);
  }

  public async markSessionState(
    addressInput: CaptainLaneAddress,
    sessionId: string,
    state: CaptainLaneSessionState,
  ): Promise<CaptainLaneSnapshot> {
    const address = parseCaptainLaneAddress(addressInput);
    const key = captainLaneKey(address);
    const current = this.requiredRow(key);
    if (current.session_id !== requiredSecret(sessionId, "Session id")) {
      throw new CaptainLaneSessionConflictError(`Session ${sessionId} does not own lane ${key}`);
    }
    if (current.state === state) return snapshot(current);
    const updatedAt = this.clock().toISOString();
    this.database
      .prepare(
        `UPDATE captain_lanes SET state = ?, revision = revision + 1, updated_at = ? WHERE lane_key = ?`,
      )
      .run(state, updatedAt, key);
    const updated = this.requiredRow(key);
    await this.emit("lane.session.state_changed", updated, state);
    return snapshot(updated);
  }

  public lane(address: CaptainLaneAddress): CaptainLaneSnapshot | undefined {
    const row = this.row(captainLaneKey(parseCaptainLaneAddress(address)));
    return row === undefined ? undefined : snapshot(row);
  }

  public resumeState(address: CaptainLaneAddress): CaptainLaneResumeState | undefined {
    const row = this.row(captainLaneKey(parseCaptainLaneAddress(address)));
    return row === undefined ? undefined : resumeState(row);
  }

  public list(): CaptainLaneSnapshot[] {
    const rows = this.database
      .prepare("SELECT * FROM captain_lanes ORDER BY lane_key")
      .all() as unknown as LaneRow[];
    return rows.map(snapshot);
  }

  /**
   * The Eve sessions this room has run, newest first — the readable past of a
   * room whose current session is only its latest turn. Identity only: no
   * continuation token is stored against a historical session, so reading a
   * room's past can never become resuming it.
   */
  public sessions(
    addressInput: CaptainLaneAddress,
    limit: number = CAPTAIN_LANE_SESSION_HISTORY_MAX,
  ): CaptainLaneSessionRecord[] {
    const key = captainLaneKey(parseCaptainLaneAddress(addressInput));
    return this.sessionsForKey(key, limit);
  }

  /** Same read, addressed by the lane key `list()` already hands out. */
  public sessionsForKey(
    laneKey: string,
    limit: number = CAPTAIN_LANE_SESSION_HISTORY_MAX,
  ): CaptainLaneSessionRecord[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), CAPTAIN_LANE_SESSION_HISTORY_MAX));
    const rows = this.database
      .prepare(
        `SELECT * FROM captain_lane_sessions WHERE lane_key = ?
         ORDER BY last_seen_at DESC, session_id DESC LIMIT ?`,
      )
      .all(laneKey, bounded) as unknown as LaneSessionRow[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      boundAt: row.bound_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  public close(): void {
    this.database.close();
  }

  private initialize(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS captain_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        agent_definition_id TEXT NOT NULL,
        soul_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        character_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS captain_lanes (
        lane_key TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('tui', 'discord_voice', 'discord_presence', 'gameplay')),
        target_id TEXT NOT NULL,
        session_id TEXT UNIQUE,
        continuation_token TEXT UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('active', 'waiting', 'completed', 'failed')),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(character_id, lane, target_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS captain_lane_sessions (
        session_id TEXT PRIMARY KEY,
        lane_key TEXT NOT NULL,
        bound_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS captain_lane_sessions_by_lane
        ON captain_lane_sessions(lane_key, last_seen_at DESC);
      INSERT OR IGNORE INTO captain_lane_sessions (session_id, lane_key, bound_at, last_seen_at)
        SELECT session_id, lane_key, updated_at, updated_at
        FROM captain_lanes WHERE session_id IS NOT NULL;
    `);
    const stored = this.database.prepare("SELECT * FROM captain_identity WHERE singleton = 1").get() as
      | Record<string, unknown>
      | undefined;
    if (stored === undefined) {
      this.database
        .prepare(
          `INSERT INTO captain_identity (
            singleton, agent_definition_id, soul_id, provider_id, character_id
          ) VALUES (1, ?, ?, ?, ?)`,
        )
        .run(
          this.identity.agentDefinitionId,
          this.identity.soulId,
          this.identity.providerId,
          this.identity.characterId,
        );
      return;
    }
    const restored = {
      agentDefinitionId: stored.agent_definition_id,
      soulId: stored.soul_id,
      providerId: stored.provider_id,
      characterId: stored.character_id,
    };
    if (JSON.stringify(restored) !== JSON.stringify(this.identity)) {
      throw new Error("Captain lane registry identity does not match the configured captain identity");
    }
  }

  private assertCharacter(characterId: string): void {
    if (characterId !== this.identity.characterId) {
      throw new Error(`Lane character ${characterId} does not match captain ${this.identity.characterId}`);
    }
  }

  private assertSessionOwnership(key: string, sessionId: string): void {
    // Both the live binding and the room's session history are checked: a
    // session that has rotated out of `captain_lanes` still belongs to the room
    // that ran it, and must not be adoptable by another one.
    const owner = (this.database
      .prepare("SELECT lane_key FROM captain_lanes WHERE session_id = ? AND lane_key <> ?")
      .get(sessionId, key) ??
      this.database
        .prepare("SELECT lane_key FROM captain_lane_sessions WHERE session_id = ? AND lane_key <> ?")
        .get(sessionId, key)) as { lane_key: string } | undefined;
    if (owner !== undefined) {
      throw new CaptainLaneSessionConflictError(
        `Session ${sessionId} is already owned by lane ${owner.lane_key}`,
      );
    }
  }

  /**
   * Appends the session to the room's history and trims it to the newest
   * {@link CAPTAIN_LANE_SESSION_HISTORY_MAX}. Bounded per room rather than
   * globally, so a busy Discord channel cannot age out a quiet one.
   */
  private recordSession(laneKey: string, sessionId: string): void {
    const now = this.clock().toISOString();
    this.database
      .prepare(
        `INSERT INTO captain_lane_sessions (session_id, lane_key, bound_at, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(sessionId, laneKey, now, now);
    this.database
      .prepare(
        `DELETE FROM captain_lane_sessions WHERE lane_key = ? AND session_id NOT IN (
           SELECT session_id FROM captain_lane_sessions WHERE lane_key = ?
           ORDER BY last_seen_at DESC, session_id DESC LIMIT ?
         )`,
      )
      .run(laneKey, laneKey, CAPTAIN_LANE_SESSION_HISTORY_MAX);
  }

  private assertContinuationOwnership(key: string, token: string): void {
    const owner = this.database
      .prepare("SELECT lane_key FROM captain_lanes WHERE continuation_token = ? AND lane_key <> ?")
      .get(token, key) as { lane_key: string } | undefined;
    if (owner !== undefined) {
      throw new CaptainContinuationOwnershipError(
        `Continuation token is already owned by lane ${owner.lane_key}`,
      );
    }
  }

  private row(key: string): LaneRow | undefined {
    return this.database.prepare("SELECT * FROM captain_lanes WHERE lane_key = ?").get(key) as
      | LaneRow
      | undefined;
  }

  private requiredRow(key: string): LaneRow {
    const row = this.row(key);
    if (row === undefined) throw new Error(`Unknown captain lane ${key}`);
    return row;
  }

  private emit(type: "lane.registered" | "lane.restored" | "lane.session.bound", row: LaneRow): Promise<void>;
  private emit(type: "lane.session.state_changed", row: LaneRow, reason: string): Promise<void>;
  private async emit(
    type: "lane.registered" | "lane.restored" | "lane.session.bound" | "lane.session.state_changed",
    row: LaneRow,
    reason?: string,
  ): Promise<void> {
    await this.eventSink({
      type,
      occurredAt: this.clock().toISOString(),
      laneKey: row.lane_key,
      lane: row.lane,
      ...(reason === undefined ? {} : { reason }),
    });
  }
}

export async function openCaptainLaneRegistry(
  path: string,
  options: CaptainLaneRegistryOptions,
): Promise<CaptainLaneRegistry> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const database = new DatabaseSync(path);
  await chmod(path, 0o600);
  try {
    return new CaptainLaneRegistry(database, options);
  } catch (error) {
    database.close();
    throw error;
  }
}

function snapshot(row: LaneRow): CaptainLaneSnapshot {
  return {
    key: row.lane_key,
    characterId: row.character_id,
    lane: row.lane,
    targetId: row.target_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    state: row.state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resumeState(row: LaneRow): CaptainLaneResumeState {
  return {
    ...snapshot(row),
    ...(row.continuation_token === null ? {} : { continuationToken: row.continuation_token }),
  };
}

function requiredSecret(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 8_192) {
    throw new Error(`${label} must contain 1 to 8192 characters`);
  }
  return normalized;
}

function optionalSecret(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : requiredSecret(value, label);
}
