import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

interface DurableReceipt {
  id: string;
  createdAt: number;
  state: "uncertain" | "settled";
  result?: unknown;
}

const SETTLED_BODY_LIMIT = 1_000;

/** Flat receipt journals retain admission tombstones and never dispatch or retry work. */
export class DurableReceiptStore<Record extends DurableReceipt> {
  private records = new Map<string, Record>();
  private validated: { version: string; records: Map<string, Record> } | undefined;
  private readonly path: string | undefined;
  private readonly schema: z.ZodType<Record[]>;
  private readonly unreadableMessage: string;
  private readonly trimSettled: ((record: Record) => void) | undefined;

  public constructor(options: {
    path?: string;
    schema: z.ZodType<Record>;
    unreadableMessage: string;
    /** Drops further optional detail from a settled record whose body is trimmed. */
    trimSettled?: (record: Record) => void;
  }) {
    this.path = options.path;
    this.schema = z.array(options.schema);
    this.unreadableMessage = options.unreadableMessage;
    this.trimSettled = options.trimSettled;
  }

  /** Check each durable generation; callers always own their mutable records. */
  public load(): Map<string, Record> {
    if (this.path === undefined) return this.records;
    this.records = copyRecords(this.snapshot());
    return this.records;
  }

  /** A lookup owns only its record, rather than copying every retained tombstone/result. */
  public read(id: string): Record | undefined {
    const record = this.snapshot().get(id);
    return record === undefined ? undefined : copyJson(record);
  }

  private snapshot(): Map<string, Record> {
    if (this.path === undefined) return this.records;
    try {
      const info = statSync(this.path, { bigint: true });
      const version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      if (this.validated?.version === version) {
        return this.validated.records;
      }
      this.validated = undefined;
      const records = this.schema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      // Sample metadata before reading: a racing replacement is checked again next load.
      // Never retain the map handed to a caller, which may mutate it before save().
      this.validated = { version, records: new Map(records.map((record) => [record.id, record])) };
      return this.validated.records;
    } catch (error) {
      this.validated = undefined;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(this.unreadableMessage, { cause: error });
      this.records.clear();
      return this.records;
    }
  }

  public save(): void {
    // Even a failed write must not leave an earlier validation covering caller edits.
    this.validated = undefined;
    // Keep identity tombstones and every uncertain record; bound only settled result bodies.
    const settled = [...this.records.values()]
      .filter((record) => record.state === "settled" && record.result !== undefined)
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const record of settled.slice(SETTLED_BODY_LIMIT)) {
      delete record.result;
      this.trimSettled?.(record);
    }
    if (this.path === undefined) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify([...this.records.values()])}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

function copyRecords<Record>(records: Map<string, Record>): Map<string, Record> {
  return new Map([...records].map(([id, record]) => [id, copyJson(record)]));
}

/** Validated journal records contain JSON values; strings can remain shared immutable values. */
function copyJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((child: unknown) => copyJson(child)) as T;
  if (value === null || typeof value !== "object") return value;
  const copy = { ...value };
  for (const key of Object.keys(copy) as (keyof T)[]) {
    const child = copy[key];
    if (child !== null && typeof child === "object") copy[key] = copyJson(child);
  }
  return copy;
}
