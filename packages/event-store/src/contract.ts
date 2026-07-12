import { createHash } from "node:crypto";
import { DomainEventSchema, type DomainEvent } from "@clankie/protocol";

export interface StoredEvent {
  sequence: number;
  previousHash: string;
  hash: string;
  event: DomainEvent;
}

export interface ChainVerification {
  valid: boolean;
  count: number;
  error?: string;
}

export interface EventStore {
  append(event: DomainEvent): Promise<StoredEvent>;
  readAll(): Promise<StoredEvent[]>;
  verify(): Promise<ChainVerification>;
}

export interface ExpectedStreamAppend {
  readonly streamId: string;
  readonly expectedRevision: number;
}

export class OptimisticConcurrencyError extends Error {
  public readonly streamId: string;
  public readonly expectedRevision: number;
  public readonly actualRevision: number;

  public constructor(streamId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Stream ${streamId} expected revision ${String(expectedRevision)} but is at ${String(actualRevision)}`,
    );
    this.name = "OptimisticConcurrencyError";
    this.streamId = streamId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class EventStoreContentionError extends Error {
  public constructor(message = "Event store remained busy after bounded retries") {
    super(message);
    this.name = "EventStoreContentionError";
  }
}

/**
 * Event store boundary for deterministic projections that need an atomic
 * compare-and-append. Exact event-id replays remain idempotent even after the
 * stream advances; a different event under the same id still fails loudly.
 */
export interface ProjectionEventStore extends EventStore {
  appendExpected(event: DomainEvent, expected: ExpectedStreamAppend): Promise<StoredEvent>;
  readStream(streamId: string): Promise<StoredEvent[]>;
}

export const GENESIS_HASH = "GENESIS";

export function seal(event: DomainEvent, sequence: number, previousHash: string): StoredEvent {
  const parsed = DomainEventSchema.parse(event);
  const canonical = JSON.stringify({ sequence, previousHash, event: parsed });
  return {
    sequence,
    previousHash,
    hash: createHash("sha256").update(canonical).digest("hex"),
    event: parsed,
  };
}

export function parseStoredEvent(value: unknown): StoredEvent {
  if (!value || typeof value !== "object") throw new Error("Invalid stored event");
  const record = value as Record<string, unknown>;
  if (
    typeof record.sequence !== "number" ||
    typeof record.previousHash !== "string" ||
    typeof record.hash !== "string"
  ) {
    throw new Error("Invalid stored event envelope");
  }
  return {
    sequence: record.sequence,
    previousHash: record.previousHash,
    hash: record.hash,
    event: DomainEventSchema.parse(record.event),
  };
}

export function verifyChain(entries: readonly StoredEvent[]): ChainVerification {
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const expected = seal(entry.event, index + 1, previousHash);
    if (
      entry.sequence !== expected.sequence ||
      entry.previousHash !== expected.previousHash ||
      entry.hash !== expected.hash
    ) {
      return {
        valid: false,
        count: entries.length,
        error: `Hash-chain mismatch at sequence ${String(index + 1)}`,
      };
    }
    previousHash = entry.hash;
  }
  return { valid: true, count: entries.length };
}
