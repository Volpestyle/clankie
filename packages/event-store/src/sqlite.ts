import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DomainEventSchema, type DomainEvent } from "@clankie/protocol";
import {
  GENESIS_HASH,
  EventStoreContentionError,
  OptimisticConcurrencyError,
  seal,
  verifyChain,
  type ChainVerification,
  type ExpectedStreamAppend,
  type ProjectionEventStore,
  type StoredEvent,
} from "./contract.ts";

const SQLITE_BUSY_TIMEOUT_MS = 1_000;
const SQLITE_BUSY_RETRIES = 4;

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
export class SqliteEventStore implements ProjectionEventStore {
  private readonly database: DatabaseSync;

  // No TS parameter properties here: this module stays erasable so plain
  // `node` can execute it directly (strip-only type stripping).
  public constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`PRAGMA busy_timeout = ${String(SQLITE_BUSY_TIMEOUT_MS)}`);
    this.withBusyRetry(
      () => this.database.exec("PRAGMA journal_mode = WAL"),
      () => new EventStoreContentionError("SQLite remained busy while enabling WAL mode"),
    );
    this.withBusyRetry(
      () => this.database.exec("PRAGMA synchronous = FULL"),
      () => new EventStoreContentionError("SQLite remained busy while configuring durability"),
    );
    this.withBusyRetry(
      () => this.migrate(),
      () => new EventStoreContentionError("SQLite remained busy while applying migrations"),
    );
  }

  public append(event: DomainEvent): Promise<StoredEvent> {
    try {
      return Promise.resolve(
        this.withBusyRetry(
          () => this.appendSync(event),
          () => new EventStoreContentionError(),
        ),
      );
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public appendExpected(event: DomainEvent, expected: ExpectedStreamAppend): Promise<StoredEvent> {
    try {
      return Promise.resolve(
        this.withBusyRetry(
          () => this.appendSync(event, expected),
          () => {
            const current = this.streamRevision(expected.streamId);
            return new OptimisticConcurrencyError(expected.streamId, expected.expectedRevision, current);
          },
        ),
      );
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

  public readStream(streamId: string): Promise<StoredEvent[]> {
    return this.readMission(streamId);
  }

  public async verify(): Promise<ChainVerification> {
    return verifyChain(await this.readAll());
  }

  public close(): void {
    this.database.close();
  }

  private appendSync(event: DomainEvent, expected?: ExpectedStreamAppend): StoredEvent {
    const parsed = DomainEventSchema.parse(event);
    if (expected !== undefined) {
      if (!Number.isSafeInteger(expected.expectedRevision) || expected.expectedRevision < 0) {
        throw new Error("Expected stream revision must be a non-negative safe integer");
      }
      if (parsed.missionId !== expected.streamId) {
        throw new Error("Expected stream id must match the event mission id");
      }
    }
    let transactionStarted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
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

      if (expected !== undefined) {
        const current = this.database
          .prepare("SELECT COUNT(*) AS count FROM events WHERE mission_id = ?")
          .get(expected.streamId) as unknown as { count: number };
        if (current.count !== expected.expectedRevision) {
          throw new OptimisticConcurrencyError(expected.streamId, expected.expectedRevision, current.count);
        }
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
      transactionStarted = false;
      return stored;
    } catch (error) {
      if (transactionStarted) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private streamRevision(streamId: string): number {
    const current = this.database
      .prepare("SELECT COUNT(*) AS count FROM events WHERE mission_id = ?")
      .get(streamId) as unknown as { count: number };
    return current.count;
  }

  private withBusyRetry<T>(operation: () => T, exhausted: () => Error): T {
    for (let attempt = 0; attempt <= SQLITE_BUSY_RETRIES; attempt += 1) {
      try {
        return operation();
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        if (attempt === SQLITE_BUSY_RETRIES) throw exhausted();
        waitForRetry((attempt + 1) * 5);
      }
    }
    throw exhausted();
  }

  private migrate(): void {
    while (true) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const current = (
          this.database.prepare("PRAGMA user_version").get() as unknown as { user_version: number }
        ).user_version;
        if (current > MIGRATIONS.length) {
          throw new Error(
            `Event store schema version ${String(current)} is newer than this build supports (${String(MIGRATIONS.length)})`,
          );
        }
        if (current === MIGRATIONS.length) {
          this.database.exec("COMMIT");
          return;
        }
        const migration = MIGRATIONS[current];
        if (migration) this.database.exec(migration);
        this.database.exec(`PRAGMA user_version = ${String(current + 1)}`);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  const candidate = error as Error & { code?: string; errcode?: number; errstr?: string };
  return (
    candidate?.errcode === 5 ||
    candidate?.errcode === 6 ||
    candidate?.errcode === 261 ||
    /\b(?:database is )?(?:busy|locked)\b|\bSQLITE_(?:BUSY|LOCKED)\b/iu.test(
      candidate?.errstr ?? candidate?.message ?? "",
    )
  );
}

function waitForRetry(milliseconds: number): void {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waiter, 0, 0, milliseconds);
}

function rowToStoredEvent(row: EventRow): StoredEvent {
  return {
    sequence: row.sequence,
    previousHash: row.previous_hash,
    hash: row.hash,
    event: DomainEventSchema.parse(JSON.parse(row.event)),
  };
}
