import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DomainEventSchema, type DomainEvent } from "@sapling/protocol";

export interface StoredEvent {
  sequence: number;
  previousHash: string;
  hash: string;
  event: DomainEvent;
}

export interface EventStore {
  append(event: DomainEvent): Promise<StoredEvent>;
  readAll(): Promise<StoredEvent[]>;
  verify(): Promise<{ valid: boolean; count: number; error?: string }>;
}

/** Append-only, hash-chained JSONL audit store suitable for local development and replay. */
export class JsonlEventStore implements EventStore {
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly path: string) {}

  public append(event: DomainEvent): Promise<StoredEvent> {
    const operation = this.queue.then(async () => {
      const entries = await this.readAll();
      const previous = entries.at(-1);
      const stored = seal(event, entries.length + 1, previous?.hash ?? "GENESIS");
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(stored)}\n`, "utf8");
      return stored;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  public async readAll(): Promise<StoredEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => parseStoredEvent(JSON.parse(line)));
  }

  public async verify(): Promise<{ valid: boolean; count: number; error?: string }> {
    const entries = await this.readAll();
    let previousHash = "GENESIS";
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
}

export function replayEvents<T>(
  initial: T,
  events: readonly DomainEvent[],
  reducer: (state: T, event: DomainEvent) => T,
): T {
  return events.reduce(reducer, initial);
}

function seal(event: DomainEvent, sequence: number, previousHash: string): StoredEvent {
  const parsed = DomainEventSchema.parse(event);
  const canonical = JSON.stringify({ sequence, previousHash, event: parsed });
  return {
    sequence,
    previousHash,
    hash: createHash("sha256").update(canonical).digest("hex"),
    event: parsed,
  };
}

function parseStoredEvent(value: unknown): StoredEvent {
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
