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
    if (
      current.session_id !== null &&
      current.session_id !== sessionId &&
      !["completed", "failed"].includes(current.state)
    ) {
      throw new CaptainLaneSessionConflictError(
        `Lane ${key} still owns active session ${current.session_id}; it cannot adopt ${sessionId}`,
      );
    }
    if (
      current.session_id === sessionId &&
      current.continuation_token !== null &&
      continuationToken === undefined
    ) {
      throw new CaptainContinuationOwnershipError(`Lane ${key} omitted its already-bound continuation token`);
    }
    const token = continuationToken ?? current.continuation_token;
    const state = input.state ?? "active";
    const changed =
      current.session_id !== sessionId || current.continuation_token !== token || current.state !== state;
    if (!changed) return snapshot(current);
    const updatedAt = this.clock().toISOString();
    this.database
      .prepare(
        `UPDATE captain_lanes
         SET session_id = ?, continuation_token = ?, state = ?, revision = revision + 1,
             updated_at = ?
         WHERE lane_key = ?`,
      )
      .run(sessionId, token, state, updatedAt, key);
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
    const owner = this.database
      .prepare("SELECT lane_key FROM captain_lanes WHERE session_id = ? AND lane_key <> ?")
      .get(sessionId, key) as { lane_key: string } | undefined;
    if (owner !== undefined) {
      throw new CaptainLaneSessionConflictError(
        `Session ${sessionId} is already owned by lane ${owner.lane_key}`,
      );
    }
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
