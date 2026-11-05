import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
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
const ShardRecord = z.record(
  z.string().regex(/^[a-f0-9]{2}$/u),
  z.string().regex(/^[a-f0-9]{2}-[a-f0-9]{64}\.json$/u),
);
/**
 * v1 is immutable shards behind an atomic manifest. v2 adds an append-only log of
 * changes since those shards, so a transition costs one fsync rather than four.
 */
const ShardsSchema = z.union([
  z.strictObject({ format: z.literal("clankie-receipts-v1"), shards: ShardRecord }),
  z.strictObject({
    format: z.literal("clankie-receipts-v2"),
    shards: ShardRecord,
    log: z.string().regex(/^log-[a-f0-9-]{36}\.jsonl$/u),
  }),
]);
/** Fold the log back into shards past either bound, so boot replay stays short. */
const LOG_LINES_MAX = 768;
const LOG_BYTES_MAX = 8 * 1024 * 1024;
const LogLine = z.strictObject({ d: z.string().regex(/^[a-f0-9]{64}$/u), r: z.unknown() });
function chain(previous: string, line: string): string {
  return createHash("sha256").update(previous).update("\n").update(line).digest("hex");
}
type Shards = z.infer<typeof ShardsSchema>;
type Bucket<Record> = { file: string; version: string; records: Map<string, Record> };
/** The committed log: its file, last chained digest, size and length. */
type Log = { file: string; digest: string; bytes: number; lines: number };
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
  private log: Log | undefined;
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
        if (this.version() === this.validated.version) {
          const bucket = this.buckets.get(prefix(id));
          if (!bucket || generation(join(`${this.path}.d`, bucket.file)) === bucket.version) {
            const record = this.validated.records.get(id);
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
      // Immutable shard names are not permission to trust changed disk contents.
      if (this.validated !== undefined && this.validated.version === this.version() && this.shardsCurrent())
        return this.validated.records;
      let version = generation(this.path);
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
        this.log = manifest.format === "clankie-receipts-v2" ? this.replay(manifest.log, records) : undefined;
        version = this.version();
      } else {
        const values = this.schema.parse(value);
        records = new Map(values.map((record) => [record.id, record]));
        this.buckets.clear();
        this.manifest = undefined;
        this.log = undefined;
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
            this.log = undefined;
            return this.records;
          }
        }
      }
      throw new Error(this.unreadableMessage, { cause: error });
    }
  }

  public save(): void {
    const committed = this.validated?.records;
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
      if (!this.append(committed)) this.saveShards();
      return;
    }
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify([...this.records.values()])}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  /** Rewrite loaded records atomically, including sanitized legacy data, rather than appending. */
  public checkpoint(): void {
    this.validated = undefined;
    this.save();
  }

  /** Only this journal's obsolete generation files; never records or other state. */
  public pruneObsolete(): void {
    if (!this.sharded || !this.path || !this.manifest) return;
    const retained = new Set([...Object.values(this.manifest.shards), ...(this.log ? [this.log.file] : [])]);
    const directory = `${this.path}.d`;
    for (const file of readdirSync(directory)) {
      if (!retained.has(file) && /^(?:[a-f0-9]{2}-[a-f0-9]{64}\.json|log-[a-f0-9-]{36}\.jsonl)$/u.test(file))
        rmSync(join(directory, file));
    }
  }

  /** The root manifest's generation and, when it names one, its log's. */
  private version(): string {
    const root = generation(this.path!);
    return this.log === undefined ? root : `${root}|${generation(join(`${this.path}.d`, this.log.file))}`;
  }

  /**
   * Apply the committed log over its shards. Every line chains the previous one's
   * digest, so an edited, reordered or missing line refuses the journal. Only a
   * final line without its newline is a torn append whose fsync never returned:
   * its caller never proceeded, so it is dropped and cut before the next append.
   */
  private replay(file: string, records: Map<string, Record>): Log {
    const path = join(`${this.path}.d`, file);
    const body = readFileSync(path);
    let digest = file;
    let offset = 0;
    let lines = 0;
    while (offset < body.length) {
      const end = body.indexOf(0x0a, offset);
      if (end === -1) {
        const descriptor = openSync(path, "r+");
        try {
          ftruncateSync(descriptor, offset);
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        break;
      }
      const line = LogLine.parse(JSON.parse(body.subarray(offset, end).toString("utf8")));
      const changed = this.schema.parse(line.r);
      if (chain(digest, JSON.stringify(line.r)) !== line.d) throw new Error("Receipt log digest changed");
      for (const record of changed) records.set(record.id, record);
      digest = line.d;
      lines += 1;
      offset = end + 1;
    }
    return { file, digest, bytes: offset, lines };
  }

  /**
   * One transition is one appended line and one fsync. Returns false when a
   * checkpoint is needed instead: no log yet (a new or v1 journal), a removed
   * record, an unknown committed state, or a log past its bounds.
   */
  private append(committed: Map<string, Record> | undefined): boolean {
    const log = this.log;
    if (
      log === undefined ||
      committed === undefined ||
      this.manifest?.format !== "clankie-receipts-v2" ||
      log.lines >= LOG_LINES_MAX ||
      log.bytes >= LOG_BYTES_MAX
    )
      return false;
    for (const id of committed.keys()) if (!this.records.has(id)) return false;
    const changed = [...this.records.values()].filter(
      (record) => !isDeepStrictEqual(committed.get(record.id), record),
    );
    if (changed.length === 0) {
      this.validated = { version: this.version(), records: committed };
      return true;
    }
    const payload = JSON.stringify(changed);
    const digest = chain(log.digest, payload);
    const line = `${JSON.stringify({ d: digest, r: changed })}\n`;
    const descriptor = openSync(join(`${this.path}.d`, log.file), "a", 0o600);
    try {
      // Bytes this store did not commit (a torn write it never replayed) would glue
      // onto the new line: start a fresh log at a checkpoint instead.
      if (fstatSync(descriptor).size !== log.bytes) return false;
      writeSync(descriptor, line);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.log = { file: log.file, digest, bytes: log.bytes + Buffer.byteLength(line), lines: log.lines + 1 };
    const records = new Map(committed);
    for (const record of changed) records.set(record.id, copyJson(record));
    this.validated = { version: this.version(), records };
    return true;
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
    // Every checkpoint starts an empty log, durable before the manifest names it.
    const log = `log-${randomUUID()}.jsonl`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeDurable(join(directory, log), "");
    changed = true;
    const manifest: Shards = { format: "clankie-receipts-v2", shards, log };
    if (changed) syncDirectory(directory);
    if (!isDeepStrictEqual(this.manifest, manifest)) {
      // All shards reach disk before admission can become visible in the root.
      writeDurable(path, `${JSON.stringify(manifest)}\n`);
      syncDirectory(dirname(path));
    }
    const old = this.buckets;
    const oldLog = this.log;
    this.buckets = next;
    this.manifest = manifest;
    this.log = { file: log, digest: log, bytes: 0, lines: 0 };
    this.validated = {
      version: this.version(),
      records: new Map([...next.values()].flatMap((bucket) => [...bucket.records])),
    };
    // Only obsolete shards of our previously committed generation are collected.
    // Failed preparations remain unreferenced and cannot admit or replay a call.
    if (oldLog !== undefined)
      try {
        rmSync(join(directory, oldLog.file), { force: true });
      } catch (error) {
        console.warn("Receipt log cleanup unavailable", error);
      }
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
