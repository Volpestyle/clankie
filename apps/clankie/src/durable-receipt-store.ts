import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

interface DurableReceipt {
  id: string;
  createdAt: number;
  state: "uncertain" | "settled";
  result?: unknown;
}

const SETTLED_BODY_LIMIT = 1_000;
const ShardsSchema = z.strictObject({
  format: z.literal("clankie-receipts-v1"),
  shards: z.record(z.string().regex(/^[a-f0-9]{2}$/u), z.string().regex(/^[a-f0-9]{2}-[a-f0-9]{64}\.json$/u)),
});
type Shards = z.infer<typeof ShardsSchema>;
type Bucket<Record> = { file: string; version: string; records: Map<string, Record> };
function generation(path: string): string {
  const info = statSync(path, { bigint: true });
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}
function prefix(id: string): string {
  // Connected calls use random UUIDs. Their first byte already distributes the
  // ledger evenly, without hashing every retained identity on each save.
  return /^[a-f0-9]{8}-[a-f0-9-]{27}$/iu.test(id)
    ? id.slice(0, 2).toLowerCase()
    : createHash("sha256").update(id).digest("hex").slice(0, 2);
}
function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function writeDurable(path: string, body: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, body);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Receipt journals retain admission tombstones and never dispatch or retry work. */
export class DurableReceiptStore<Record extends DurableReceipt> {
  private records = new Map<string, Record>();
  private readonly sharded: boolean;
  private buckets = new Map<string, Bucket<Record>>();
  private manifest: Shards | undefined;
  private validated: { version: string; records: Map<string, Record> } | undefined;
  private readonly path: string | undefined;
  private readonly schema: z.ZodType<Record[]>;
  private readonly unreadableMessage: string;
  private readonly trimSettled: ((record: Record) => void) | undefined;

  public constructor(options: {
    path?: string;
    /** Immutable buckets behind one atomic manifest; reads also accept legacy arrays. */
    sharded?: boolean;
    schema: z.ZodType<Record>;
    unreadableMessage: string;
    /** Drops further optional detail from a settled record whose body is trimmed. */
    trimSettled?: (record: Record) => void;
  }) {
    this.path = options.path;
    this.sharded = options.sharded ?? false;
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
    if (this.sharded && this.path && this.manifest && this.validated) {
      try {
        if (generation(this.path) === this.validated.version) {
          const bucket = this.buckets.get(prefix(id));
          if (!bucket) return undefined;
          if (generation(join(`${this.path}.d`, bucket.file)) === bucket.version) {
            const record = bucket.records.get(id);
            return record === undefined ? undefined : copyJson(record);
          }
        }
      } catch (error) {
        this.validated = undefined;
        // snapshot() distinguishes a missing root from a missing committed shard.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error(this.unreadableMessage, { cause: error });
      }
    }
    const record = this.snapshot().get(id);
    return record === undefined ? undefined : copyJson(record);
  }

  private snapshot(): Map<string, Record> {
    if (this.path === undefined) return this.records;
    try {
      const version = generation(this.path);
      // Immutable shard names are not permission to trust changed disk contents.
      if (this.validated?.version === version && this.shardsCurrent()) return this.validated.records;
      this.validated = undefined;
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      let records: Map<string, Record>;
      if (this.sharded && !Array.isArray(value)) {
        const manifest = ShardsSchema.parse(value);
        const buckets = new Map<string, Bucket<Record>>();
        records = new Map();
        for (const [key, file] of Object.entries(manifest.shards)) {
          if (!file.startsWith(`${key}-`)) throw new Error("Receipt shard reference mismatch");
          const path = join(`${this.path}.d`, file);
          const shardVersion = generation(path);
          let bucket = this.buckets.get(key);
          if (bucket?.file !== file || bucket.version !== shardVersion) {
            const body = readFileSync(path);
            if (createHash("sha256").update(body).digest("hex") !== file.slice(3, -5))
              throw new Error("Receipt shard digest changed");
            const values = this.schema.parse(JSON.parse(body.toString("utf8")));
            const entries = new Map(values.map((record) => [record.id, record]));
            if (entries.size !== values.length || values.some((record) => prefix(record.id) !== key))
              throw new Error("Receipt shard identity mismatch");
            bucket = { file, version: shardVersion, records: entries };
          }
          buckets.set(key, bucket);
          for (const [id, record] of bucket.records) records.set(id, record);
        }
        this.buckets = buckets;
        this.manifest = manifest;
      } else {
        const values = this.schema.parse(value);
        records = new Map(values.map((record) => [record.id, record]));
        this.buckets.clear();
        this.manifest = undefined;
      }
      // Never retain the map handed to a caller, which may mutate it before save().
      this.validated = { version, records };
      return records;
    } catch (error) {
      this.validated = undefined;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(this.unreadableMessage, { cause: error });
      // A missing committed shard is corruption, never an empty journal.
      if (this.path !== undefined) {
        try {
          statSync(this.path);
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === "ENOENT") {
            this.records.clear();
            this.buckets.clear();
            this.manifest = undefined;
            return this.records;
          }
        }
      }
      throw new Error(this.unreadableMessage, { cause: error });
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
    if (this.sharded) {
      this.saveShards();
      return;
    }
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify([...this.records.values()])}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private shardsCurrent(): boolean {
    if (!this.manifest || !this.path) return true;
    for (const bucket of this.buckets.values())
      if (generation(join(`${this.path}.d`, bucket.file)) !== bucket.version) return false;
    return true;
  }

  private saveShards(): void {
    const path = this.path!;
    const directory = `${path}.d`;
    const grouped = new Map<string, Map<string, Record>>();
    for (const [id, record] of this.records) {
      const key = prefix(id);
      const records = grouped.get(key) ?? new Map<string, Record>();
      records.set(id, record);
      grouped.set(key, records);
    }
    const next = new Map<string, Bucket<Record>>();
    const shards: Shards["shards"] = {};
    let changed = false;
    for (const [key, records] of grouped) {
      let bucket = this.buckets.get(key);
      if (!bucket || !isDeepStrictEqual(bucket.records, records)) {
        const body = `${JSON.stringify([...records.values()])}\n`;
        const file = `${key}-${createHash("sha256").update(body).digest("hex")}.json`;
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeDurable(join(directory, file), body);
        bucket = { file, version: generation(join(directory, file)), records: copyRecords(records) };
        changed = true;
      }
      next.set(key, bucket);
      shards[key] = bucket.file;
    }
    const manifest: Shards = { format: "clankie-receipts-v1", shards };
    if (changed) syncDirectory(directory);
    if (!isDeepStrictEqual(this.manifest, manifest)) {
      // All shards reach disk before admission can become visible in the root.
      writeDurable(path, `${JSON.stringify(manifest)}\n`);
      syncDirectory(dirname(path));
    }
    const old = this.buckets;
    this.buckets = next;
    this.manifest = manifest;
    this.validated = {
      version: generation(path),
      records: new Map([...next.values()].flatMap((bucket) => [...bucket.records])),
    };
    // Only obsolete shards of our previously committed generation are collected.
    // Failed preparations remain unreferenced and cannot admit or replay a call.
    const retained = new Set(Object.values(shards));
    for (const bucket of old.values())
      if (!retained.has(bucket.file)) {
        try {
          rmSync(join(directory, bucket.file), { force: true });
        } catch (error) {
          console.warn("Receipt shard cleanup unavailable", error);
        }
      }
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
