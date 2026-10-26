import { S3Client } from "@aws-sdk/client-s3";
import { EVIDENCE_SIGNED_URL_MAX_MS } from "@clankie/protocol/evidence";
import { EvidenceSettingsSchema, type EvidenceSettings } from "@clankie/settings";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { chmod, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceCredentialProvider } from "./evidence-credentials.ts";
import { S3EvidenceBlobs } from "./evidence-s3.ts";
import {
  EvidenceRefusal,
  type EvidenceBlobStore,
  type EvidenceMetadataStore,
  type EvidenceUploadRow,
} from "./evidence-store.ts";

/** Private identity only. Local always means the service-owned metadata root's blobs directory. */
export type EvidenceDestination =
  | { readonly backend: "local" }
  | Extract<EvidenceSettings, { backend: "s3" }>;
export type EvidenceLegacyItem =
  | { readonly recordId: string }
  | { readonly actorKey: string; readonly idempotencyKey: string };
export interface EvidenceResolverOptions {
  /** Trusted SDK binding for a disposable S3-compatible fixture; never stored or accepted over HTTP. */
  readonly s3Client?: S3Client;
  readonly evidenceCredentials?: EvidenceCredentialProvider;
  readonly managedEvidence?: boolean;
}

/** One factory binds both active writes and historical reads. Managed mode never reaches ambient credentials. */
export function evidenceS3Client(
  destination: Extract<EvidenceDestination, { backend: "s3" }>,
  purpose: "read" | "write",
  options: EvidenceResolverOptions = {},
): S3Client {
  const fixture = options.s3Client?.config;
  const scoped = options.evidenceCredentials?.credentials(destination, purpose);
  const credentials =
    scoped || options.managedEvidence
      ? Object.assign(
          scoped ??
            (async () => {
              throw new EvidenceRefusal(503, "evidence_session_unavailable");
            }),
          { memoized: true },
        )
      : fixture?.credentials;
  const client = new S3Client({
    region: destination.region,
    ...(credentials ? { credentials } : {}),
    ...(fixture
      ? {
          forcePathStyle: fixture.forcePathStyle,
          useFipsEndpoint: fixture.useFipsEndpoint,
          useDualstackEndpoint: fixture.useDualstackEndpoint,
          ...(fixture.endpoint ? { endpoint: fixture.endpoint } : {}),
        }
      : {}),
  });
  // `memoized` tells the SDK that the broker owns caching and refresh. Its
  // default five-minute cache would otherwise hide half-life and revocation.
  return client;
}

export function parseEvidenceDestination(value: unknown): EvidenceDestination {
  const parsed = EvidenceSettingsSchema.safeParse(value);
  if (!parsed.success) throw new EvidenceRefusal(503, "evidence_destination_invalid");
  return Object.freeze(parsed.data);
}

function key(destination: EvidenceDestination) {
  return destination.backend === "local"
    ? "local"
    : JSON.stringify([destination.backend, destination.bucket, destination.region, destination.prefix]);
}

/** Streams the complete original; never mutates, relocates, or buffers it. */
async function verifyBytes(blobs: EvidenceBlobStore, sha256: string, size: number, deadline?: number) {
  let expired = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const opened = await blobs.open(sha256);
    if (expired) {
      await opened?.body.cancel();
      return "time_limit" as const;
    }
    if (!opened) return "source_missing" as const;
    if (opened.size !== size) {
      await opened.body.cancel();
      return "identity_mismatch" as const;
    }
    reader = opened.body.getReader();
    const hash = createHash("sha256");
    let received = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (expired) return "time_limit" as const;
        if (part.done) break;
        received += part.value.byteLength;
        if (received > size) return "identity_mismatch" as const;
        hash.update(part.value);
      }
      return received === size && hash.digest("hex") === sha256
        ? ("verified" as const)
        : ("identity_mismatch" as const);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  };
  try {
    if (deadline === undefined) return await work();
    const timeout = new Promise<"time_limit">((resolve) => {
      timer = setTimeout(
        () => {
          expired = true;
          void reader?.cancel().catch(() => {});
          resolve("time_limit");
        },
        Math.max(0, deadline - Date.now()),
      );
    });
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Cached descriptors retain no owned sockets. Each historical operation releases its SDK client;
 * an open stream retains that client until EOF or cancellation. Fixture SDK settings are copied only in memory.
 */
class RecordedS3Blobs implements EvidenceBlobStore {
  readonly backend = "s3";
  readonly location: string;
  readonly destination: Extract<EvidenceDestination, { backend: "s3" }>;
  private readonly options: EvidenceResolverOptions;

  constructor(
    destination: Extract<EvidenceDestination, { backend: "s3" }>,
    options: EvidenceResolverOptions,
  ) {
    this.destination = destination;
    this.options = options;
    this.location = `s3://${destination.bucket}/${destination.prefix}`;
  }

  private binding() {
    const client = evidenceS3Client(this.destination, "read", this.options);
    return { blobs: new S3EvidenceBlobs(this.destination, client), release: () => client.destroy() };
  }

  private async run<T>(operation: (blobs: S3EvidenceBlobs) => Promise<T>) {
    const binding = this.binding();
    try {
      return await operation(binding.blobs);
    } finally {
      binding.release();
    }
  }

  has(sha256: string) {
    return this.run((blobs) => blobs.has(sha256));
  }
  async write(sha256: string, size: number, body: AsyncIterable<Uint8Array>) {
    if (this.options.managedEvidence || this.options.evidenceCredentials)
      throw new EvidenceRefusal(503, "evidence_destination_read_only");
    return this.run((blobs) => blobs.write(sha256, size, body));
  }
  signedFetch(sha256: string, expiresInSeconds: number) {
    return this.run((blobs) => blobs.signedFetch(sha256, expiresInSeconds));
  }
  readRange(sha256: string, offset: number, length: number) {
    return this.run((blobs) => blobs.readRange(sha256, offset, length));
  }
  async open(sha256: string) {
    const binding = this.binding();
    try {
      const opened = await binding.blobs.open(sha256);
      if (!opened) {
        binding.release();
        return undefined;
      }
      const reader = opened.body.getReader();
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          reader.releaseLock();
          binding.release();
        }
      };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (part.done) {
              controller.close();
              release();
            } else controller.enqueue(part.value);
          } catch (error) {
            controller.error(error);
            release();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            release();
          }
        },
      });
      return { size: opened.size, body };
    } catch (error) {
      binding.release();
      throw error;
    }
  }
}

/** A bounded resolver, not a destination selector or an endpoint/path control plane. */
export class EvidenceDestinationResolver {
  readonly activeDestination: EvidenceDestination;
  private readonly adapters = new Map<string, EvidenceBlobStore>();
  private readonly active: EvidenceBlobStore;
  private readonly local: EvidenceBlobStore;
  private readonly options: EvidenceResolverOptions;

  constructor(active: EvidenceBlobStore, local: EvidenceBlobStore, options: EvidenceResolverOptions = {}) {
    this.active = active;
    this.local = local;
    this.options = options;
    this.activeDestination =
      active === local || (active.backend === "local-disk" && active.location === local.location)
        ? Object.freeze({ backend: "local" })
        : parseEvidenceDestination(active.destination);
  }

  assertStartup(metadata: EvidenceMetadataStore) {
    // Unknown historical S3 locations cannot be reconstructed from today's settings.
    if (this.activeDestination.backend !== "local" && metadata.hasUnknownDestinations())
      throw new EvidenceRefusal(503, "evidence_legacy_preparation_required");
  }

  resolve(destination: EvidenceDestination): EvidenceBlobStore {
    const parsed = parseEvidenceDestination(destination);
    const id = key(parsed);
    if (parsed.backend === "local") return this.local;
    if (id === key(this.activeDestination)) return this.active;
    const existing = this.adapters.get(id);
    if (existing) {
      this.adapters.delete(id);
      this.adapters.set(id, existing);
      return existing;
    }
    const blobs = new RecordedS3Blobs(parsed, this.options);
    if (this.adapters.size >= 32) this.adapters.delete(this.adapters.keys().next().value!);
    this.adapters.set(id, blobs);
    return blobs;
  }

  pending(row: EvidenceUploadRow) {
    if (!row.destination) throw new EvidenceRefusal(503, "evidence_legacy_preparation_required");
    return this.resolve(row.destination);
  }

  async recorded(binding: { record: { sha256: string; size: number }; destination?: EvidenceDestination }) {
    if (binding.destination) return this.resolve(binding.destination);
    // Preserve unchanged local reads, but never manufacture a tag from active settings.
    if (
      this.activeDestination.backend !== "local" ||
      (await verifyBytes(this.local, binding.record.sha256, binding.record.size)) !== "verified"
    )
      throw new EvidenceRefusal(503, "evidence_legacy_preparation_required");
    return this.local;
  }
}

/** Verify newly supplied bytes in the fixed approved local incoming directory before any CAS.
 * Installation runs synchronously inside SQLite's transaction, uses an exclusive hard link,
 * and never overwrites an original. Neither a CAS loser nor a bad/cancelled body installs bytes.
 */
export async function stageLegacyLocalContinuation(
  local: EvidenceBlobStore,
  row: EvidenceUploadRow,
  body: AsyncIterable<Uint8Array>,
) {
  if (local.backend !== "local-disk") throw new EvidenceRefusal(503, "evidence_destination_invalid");
  const temporary = join(local.location, "incoming", `${randomUUID()}.part`);
  const file = await open(temporary, "wx", 0o600).catch(() => {
    throw new EvidenceRefusal(503, "legacy_continuation_storage_unavailable");
  });
  let closed = false;
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > row.request.size) throw new EvidenceRefusal(422, "size_mismatch");
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    await file.close();
    closed = true;
    if (size !== row.request.size) throw new EvidenceRefusal(422, "size_mismatch");
    if (hash.digest("hex") !== row.request.sha256) throw new EvidenceRefusal(422, "sha256_mismatch");
    await chmod(temporary, 0o400);
    const install = () => {
      try {
        const directory = join(local.location, "sha256", row.request.sha256.slice(0, 2));
        const target = join(directory, row.request.sha256);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        try {
          linkSync(temporary, target);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
          // Existing originals must remain untouched, including an unexpected non-equivalent file.
          const info = statSync(target);
          if (!info.isFile() || info.size !== row.request.size)
            throw new EvidenceRefusal(409, "legacy_continuation_original_conflict");
          const descriptor = openSync(target, "r");
          try {
            const hash = createHash("sha256"),
              buffer = Buffer.alloc(64 * 1024);
            for (;;) {
              const count = readSync(descriptor, buffer, 0, buffer.length, null);
              if (!count) break;
              hash.update(buffer.subarray(0, count));
            }
            if (hash.digest("hex") !== row.request.sha256)
              throw new EvidenceRefusal(409, "legacy_continuation_original_conflict");
          } finally {
            closeSync(descriptor);
          }
        }
      } catch (error) {
        if (error instanceof EvidenceRefusal) throw error;
        throw new EvidenceRefusal(503, "legacy_continuation_storage_unavailable");
      }
    };
    return {
      install,
      cleanup: () =>
        rm(temporary, { force: true }).catch(() => {
          throw new EvidenceRefusal(503, "legacy_continuation_storage_unavailable");
        }),
    };
  } catch (error) {
    try {
      if (!closed) await file.close();
      await rm(temporary, { force: true });
    } catch {
      throw new EvidenceRefusal(503, "legacy_continuation_storage_unavailable");
    }
    if (error instanceof EvidenceRefusal) throw error;
    throw new EvidenceRefusal(422, "upload_incomplete");
  }
}

/** Explicit, process-local permission to supply new bytes for an exact unknown pending upload.
 * This does not tag a destination or infer history; only a later verified transactional CAS can settle it.
 */
export class EvidenceLocalContinuationAdmissions {
  private readonly entries = new Map<
    string,
    { identity: string; size: number; expires: number; active: boolean }
  >();
  private readonly clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }
  private id(row: EvidenceUploadRow) {
    return JSON.stringify([row.actorKey, row.idempotencyKey]);
  }
  private identity(row: EvidenceUploadRow) {
    return JSON.stringify([row.request, row.actor]);
  }
  private prune() {
    for (const [id, entry] of this.entries)
      if (entry.expires + EVIDENCE_SIGNED_URL_MAX_MS <= this.clock()) this.entries.delete(id);
  }
  admit(row: EvidenceUploadRow) {
    this.prune();
    if (row.state !== "pending" || row.destination !== undefined)
      throw new EvidenceRefusal(409, "legacy_continuation_conflict");
    const id = this.id(row),
      identity = this.identity(row);
    const existing = this.entries.get(id);
    if (existing && existing.identity !== identity)
      throw new EvidenceRefusal(409, "legacy_continuation_conflict");
    const bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.size, 0);
    if (
      (!existing && this.entries.size >= 100) ||
      row.request.size > 256 * 1024 * 1024 - bytes + (existing?.size ?? 0)
    )
      throw new EvidenceRefusal(503, "legacy_continuation_limit");
    this.entries.set(id, {
      identity,
      size: row.request.size,
      expires: this.clock() + EVIDENCE_SIGNED_URL_MAX_MS,
      active: true,
    });
  }
  assertCurrent(row: EvidenceUploadRow) {
    this.prune();
    const entry = this.entries.get(this.id(row));
    if (
      entry &&
      (entry.identity !== this.identity(row) || row.state !== "pending" || row.destination !== undefined)
    )
      throw new EvidenceRefusal(409, "legacy_continuation_conflict");
  }
  require(row: EvidenceUploadRow) {
    this.prune();
    const entry = this.entries.get(this.id(row));
    if (!entry || !entry.active || entry.expires <= this.clock() || entry.identity !== this.identity(row))
      throw new EvidenceRefusal(503, "evidence_legacy_preparation_required");
  }
  complete(row: EvidenceUploadRow) {
    const entry = this.entries.get(this.id(row));
    if (entry) entry.active = false;
  }
}

/** Explicit tagging only: <=100 identifiers, <=256 MiB declared bytes, <=30 seconds for association progress per batch.
 * Originals remain intact. Each verified association commits separately; a partial batch is resumable.
 * The progress deadline stops tagging, not an unresolved SDK HEAD/GET; its eventual stream is cancelled.
 * A large legacy object remains readable locally and requires a separately authorized preparation route.
 */
export async function prepareLegacyEvidence(
  metadata: EvidenceMetadataStore,
  storage: EvidenceDestinationResolver,
  source: EvidenceDestination,
  items: readonly EvidenceLegacyItem[],
) {
  if (items.length === 0 || items.length > 100) throw new EvidenceRefusal(400, "invalid_request");
  const destination = parseEvidenceDestination(source);
  const blobs = storage.resolve(destination);
  const deadline = Date.now() + 30_000;
  let remainingBytes = 256 * 1024 * 1024;
  const results: {
    item: EvidenceLegacyItem;
    outcome:
      | "prepared"
      | "already_prepared"
      | "unknown_item"
      | "destination_conflict"
      | "source_missing"
      | "identity_mismatch"
      | "byte_limit"
      | "time_limit"
      | "source_unavailable";
  }[] = [];
  for (const item of items) {
    const row = await metadata.legacyItem(item);
    if (!row) {
      results.push({ item, outcome: "unknown_item" });
      continue;
    }
    if (row.destination) {
      results.push({
        item,
        outcome: key(row.destination) === key(destination) ? "already_prepared" : "destination_conflict",
      });
      continue;
    }
    if (Date.now() >= deadline) {
      results.push({ item, outcome: "time_limit" });
      continue;
    }
    if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > remainingBytes) {
      results.push({ item, outcome: "byte_limit" });
      continue;
    }
    remainingBytes -= row.size;
    try {
      const verified = await verifyBytes(blobs, row.sha256, row.size, deadline);
      if (verified !== "verified") {
        results.push({ item, outcome: verified });
        continue;
      }
      if (Date.now() >= deadline) {
        results.push({ item, outcome: "time_limit" });
        continue;
      }
      const tagged = await metadata.tagLegacy(item, destination);
      const current = tagged ? undefined : await metadata.legacyItem(item);
      results.push({
        item,
        outcome: tagged
          ? "prepared"
          : current?.destination && key(current.destination) === key(destination)
            ? "already_prepared"
            : "destination_conflict",
      });
    } catch {
      // Backend errors can contain URLs or credential details. Preserve only the bounded outcome.
      results.push({ item, outcome: "source_unavailable" });
    }
  }
  return {
    complete: results.every(
      (result) => result.outcome === "prepared" || result.outcome === "already_prepared",
    ),
    results,
  };
}
