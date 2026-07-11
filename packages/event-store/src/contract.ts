import { createHash } from "node:crypto";
import { DomainEventSchema, type DomainEvent } from "@sapling/protocol";

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
