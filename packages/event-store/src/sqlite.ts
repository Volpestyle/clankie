import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DomainEventSchema, type DomainEvent } from "@sapling/protocol";
import {
  GENESIS_HASH,
  seal,
  verifyChain,
  type ChainVerification,
  type EventStore,
  type StoredEvent,
} from "./contract.ts";

/**
 * Schema migrations, applied in order inside a transaction. The current schema
 * version is tracked with `PRAGMA user_version`; a database at version N has had
 * MIGRATIONS[0..N-1] applied. Never edit a shipped migration — append a new one.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE events (
    sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
    event_id TEXT NOT NULL UNIQUE,
    mission_id TEXT NOT NULL,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    previous_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    event TEXT NOT NULL
  ) STRICT;
  CREATE INDEX events_by_mission ON events (mission_id, sequence);`,
];

interface EventRow {
  sequence: number;
  previous_hash: string;
  hash: string;
  event: string;
}

/**
 * Durable, hash-chained SQLite event store (ADR 0001 local-first, ADR 0002
 * event-sourced state). Uses WAL journaling with `synchronous=FULL`, so an
 * append that has resolved is committed and survives an abrupt process kill.
 * Appends are idempotent on event id: re-appending an identical event returns
 * the original stored envelope; appending a different event under an existing
 * id is rejected.
 */
export class SqliteEventStore implements EventStore {
  private readonly database: DatabaseSync;

  // No TS parameter properties here: this module stays erasable so plain
  // `node` can execute it directly (strip-only type stripping).
  public constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.migrate();
  }

  public append(event: DomainEvent): Promise<StoredEvent> {
    try {
      return Promise.resolve(this.appendSync(event));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public readAll(): Promise<StoredEvent[]> {
    const rows = this.database
      .prepare("SELECT sequence, previous_hash, hash, event FROM events ORDER BY sequence")
      .all() as unknown as EventRow[];
    return Promise.resolve(rows.map(rowToStoredEvent));
  }

  public readMission(missionId: string): Promise<StoredEvent[]> {
    const rows = this.database
      .prepare(
        "SELECT sequence, previous_hash, hash, event FROM events WHERE mission_id = ? ORDER BY sequence",
      )
      .all(missionId) as unknown as EventRow[];
    return Promise.resolve(rows.map(rowToStoredEvent));
  }

  public async verify(): Promise<ChainVerification> {
    return verifyChain(await this.readAll());
  }

  public close(): void {
    this.database.close();
  }

  private appendSync(event: DomainEvent): StoredEvent {
    const parsed = DomainEventSchema.parse(event);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare("SELECT sequence, previous_hash, hash, event FROM events WHERE event_id = ?")
        .get(parsed.id) as unknown as EventRow | undefined;
      if (existing) {
        const stored = rowToStoredEvent(existing);
        if (JSON.stringify(stored.event) !== JSON.stringify(parsed)) {
          throw new Error(`Event ${parsed.id} already exists with different content`);
        }
        this.database.exec("COMMIT");
        return stored;
      }

      const last = this.database
        .prepare("SELECT sequence, hash FROM events ORDER BY sequence DESC LIMIT 1")
        .get() as unknown as { sequence: number; hash: string } | undefined;
      const stored = seal(parsed, (last?.sequence ?? 0) + 1, last?.hash ?? GENESIS_HASH);
      this.database
        .prepare(
          `INSERT INTO events (sequence, event_id, mission_id, type, occurred_at, previous_hash, hash, event)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stored.sequence,
          parsed.id,
          parsed.missionId,
          parsed.type,
          parsed.occurredAt,
          stored.previousHash,
          stored.hash,
          JSON.stringify(stored.event),
        );
      this.database.exec("COMMIT");
      return stored;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    const current = (
      this.database.prepare("PRAGMA user_version").get() as unknown as { user_version: number }
    ).user_version;
    if (current > MIGRATIONS.length) {
      throw new Error(
        `Event store schema version ${String(current)} is newer than this build supports (${String(MIGRATIONS.length)})`,
      );
    }
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const migration = MIGRATIONS[version];
        if (migration) this.database.exec(migration);
        this.database.exec(`PRAGMA user_version = ${String(version + 1)}`);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

function rowToStoredEvent(row: EventRow): StoredEvent {
  return {
    sequence: row.sequence,
    previousHash: row.previous_hash,
    hash: row.hash,
    event: DomainEventSchema.parse(JSON.parse(row.event)),
  };
}
