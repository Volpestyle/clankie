import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DomainEvent } from "@clankie/protocol";
import {
  GENESIS_HASH,
  parseStoredEvent,
  seal,
  verifyChain,
  type ChainVerification,
  type EventStore,
  type StoredEvent,
} from "./contract.ts";

/** Append-only, hash-chained JSONL audit store suitable for local development and replay. */
export class JsonlEventStore implements EventStore {
  private queue: Promise<unknown> = Promise.resolve();

  private readonly path: string;

  public constructor(path: string) {
    this.path = path;
  }

  public append(event: DomainEvent): Promise<StoredEvent> {
    const operation = this.queue.then(async () => {
      const entries = await this.readAll();
      const previous = entries.at(-1);
      const stored = seal(event, entries.length + 1, previous?.hash ?? GENESIS_HASH);
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

  public async verify(): Promise<ChainVerification> {
    return verifyChain(await this.readAll());
  }
}
