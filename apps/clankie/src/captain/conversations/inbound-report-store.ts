import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { InboundAcceptanceSchema } from "./constants.ts";
import type { InboundAcceptance } from "./types.ts";

const filename = /^[a-f0-9]{2}-[a-f0-9]{64}\.json$/u;
export const InboundReportReferenceSchema = z
  .object({
    version: z.literal(1),
    shards: z.record(z.string().regex(/^[a-f0-9]{2}$/u), z.string().regex(filename)),
  })
  .strict();
export type InboundReportReference = z.infer<typeof InboundReportReferenceSchema>;
type Entries = Record<string, InboundAcceptance>;
interface Bucket {
  readonly file: string;
  readonly version: string;
  readonly entries: Entries;
}

/** Missing or corrupt retained reports must never become a fresh empty inbox. */
export class InboundReportStorageError extends Error {}

/**
 * Immutable acceptance shards; meta.json is the sole commit manifest. Preparing
 * files cannot admit a report. The caller commits the manifest after fsyncing
 * these files, and calls committed() only after that metadata commit is durable.
 */
export class InboundReportStore {
  private readonly directory: string;
  /** False never unlinks a shard: unrecognized storage may still reference it (VUH-2831). */
  private readonly collect: boolean;
  private buckets = new Map<string, Bucket>();
  private sweep = true;

  public constructor(conversationDirectory: string, options: { readonly collect?: boolean } = {}) {
    this.directory = join(conversationDirectory, "inbound-reports");
    this.collect = options.collect ?? true;
  }

  public load(reference: InboundReportReference | undefined): Entries {
    if (reference === undefined) return {};
    try {
      const checked = InboundReportReferenceSchema.parse(reference);
      const entries: Entries = {};
      const buckets = new Map<string, Bucket>();
      for (const [prefix, file] of Object.entries(checked.shards)) {
        const version = this.version(file);
        const records = this.readBucket(prefix, file);
        Object.assign(entries, records);
        buckets.set(prefix, { file, version, entries: structuredClone(records) });
      }
      this.buckets = buckets;
      return entries;
    } catch (error) {
      throw new InboundReportStorageError(
        "Retained inbound reports are unreadable; the inbox was not replaced",
        { cause: error },
      );
    }
  }

  /** Exact durable lookup: reread the committed shard, never an in-memory success. */
  public read(reference: InboundReportReference, id: string): InboundAcceptance | undefined {
    try {
      const checked = InboundReportReferenceSchema.parse(reference);
      const prefix = id.slice(0, 2).toLowerCase();
      const file = checked.shards[prefix];
      return file === undefined ? undefined : this.readBucket(prefix, file)[id];
    } catch (error) {
      throw new InboundReportStorageError("Retained inbound report is unreadable", { cause: error });
    }
  }

  public prepare(entries: Entries): {
    readonly reference: InboundReportReference;
    readonly changed: boolean;
    committed(): void;
  } {
    // A cached payload cannot bless a missing or changed committed file.
    // Revalidate identities before every commit; changed identities must still
    // match the original content-addressed bytes and schema.
    for (const [prefix, bucket] of this.buckets) {
      const version = this.version(bucket.file);
      if (version !== bucket.version) {
        const current = this.readBucket(prefix, bucket.file);
        if (!isDeepStrictEqual(current, bucket.entries))
          throw new InboundReportStorageError("Retained report shard changed");
        this.buckets.set(prefix, { ...bucket, version });
      }
    }
    const grouped = new Map<string, Entries>();
    for (const [id, receipt] of Object.entries(entries)) {
      const prefix = id.slice(0, 2).toLowerCase();
      if (!/^[a-f0-9]{2}$/u.test(prefix) || id !== receipt.deliveryId)
        throw new InboundReportStorageError("Invalid retained report identity");
      const bucket = grouped.get(prefix) ?? {};
      bucket[id] = receipt;
      grouped.set(prefix, bucket);
    }
    const next = new Map<string, Bucket>();
    const shards: Record<string, string> = {};
    let changed = grouped.size !== this.buckets.size;
    for (const [prefix, records] of grouped) {
      let bucket = this.buckets.get(prefix);
      if (bucket === undefined || !isDeepStrictEqual(bucket.entries, records)) {
        const body = JSON.stringify(records);
        const digest = createHash("sha256").update(body).digest("hex");
        const file = `${prefix}-${digest}.json`;
        this.write(file, body);
        bucket = { file, version: this.version(file), entries: structuredClone(records) };
        changed = true;
      }
      next.set(prefix, bucket);
      shards[prefix] = bucket.file;
    }
    if (changed && next.size) this.syncDirectory();
    return {
      reference: { version: 1, shards },
      changed,
      committed: () => {
        const old = this.buckets;
        this.buckets = next;
        const retained = new Set(Object.values(shards));
        // A failed prepare can leave orphan immutable files. Sweep once after
        // a durable manifest commit; later commits unlink only superseded shards.
        const candidates = !this.collect
          ? []
          : this.sweep && existsSync(this.directory)
            ? readdirSync(this.directory).filter((file) => filename.test(file))
            : [...old.values()].map((bucket) => bucket.file);
        this.sweep = false;
        for (const file of candidates)
          if (!retained.has(file)) {
            try {
              rmSync(join(this.directory, file), { force: true });
            } catch (error) {
              this.sweep = true;
              console.warn("Inbound report shard cleanup unavailable", error);
            }
          }
      },
    };
  }

  private version(file: string): string {
    const info = statSync(join(this.directory, file), { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  }

  private readBucket(prefix: string, file: string): Entries {
    return decodeInboundReportShard(prefix, file, readFileSync(join(this.directory, file)));
  }

  private write(file: string, body: string): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, file);
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== body)
        throw new InboundReportStorageError("Report shard content changed");
      return;
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
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

  private syncDirectory(): void {
    const descriptor = openSync(this.directory, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

const temporaryShard = /^[a-f0-9]{2}-[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/u;
const knownReportFields = new Set(["inboundAcceptances", "inboundReportStore"]);

/**
 * Why a conversation may hold reports this reader cannot see, or undefined when
 * it recognizes all of its report storage. Destructive cleanup treats an answer
 * as possibly unread (VUH-2831). Report storage lives in `inbound*` metadata
 * fields and the `inbound-reports` directory; a later format must stay inside
 * them so this reader retains what it cannot read.
 */
export function unrecognizedInboundReportStorage(
  conversationDirectory: string,
  meta: object,
): string | undefined {
  const field = Object.keys(meta).find((key) => key.startsWith("inbound") && !knownReportFields.has(key));
  if (field !== undefined) return `unrecognized report field ${field}`;
  let entries;
  try {
    entries = readdirSync(join(conversationDirectory, "inbound-reports"), { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? undefined : `report directory unreadable (${code ?? String(error)})`;
  }
  // Prepared shards admit nothing until meta.json references them.
  const unknown = entries.find(
    (entry) => !entry.isFile() || !(filename.test(entry.name) || temporaryShard.test(entry.name)),
  );
  return unknown === undefined ? undefined : `unrecognized report storage ${unknown.name}`;
}

/** Used by bounded diagnostic readers as well as the live conversation store. */
export function decodeInboundReportShard(prefix: string, file: string, body: Buffer | string): Entries {
  if (!filename.test(file) || !file.startsWith(`${prefix}-`))
    throw new Error("Invalid report shard reference");
  if (createHash("sha256").update(body).digest("hex") !== file.slice(3, -5))
    throw new Error("Report shard digest changed");
  const entries = z
    .record(z.string(), InboundAcceptanceSchema)
    .parse(JSON.parse(typeof body === "string" ? body : body.toString("utf8")));
  for (const [id, receipt] of Object.entries(entries))
    if (id.slice(0, 2).toLowerCase() !== prefix || id !== receipt.deliveryId)
      throw new Error("Report shard identity changed");
  return entries;
}
