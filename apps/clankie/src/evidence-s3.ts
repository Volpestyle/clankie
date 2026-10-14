import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { EVIDENCE_SIGNED_URL_MAX_MS, EvidenceSha256Schema } from "@clankie/protocol/evidence";
import { EvidenceSettingsSchema, type EvidenceSettings } from "@clankie/settings";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { EvidenceBlobStore } from "./evidence-store.ts";
import { EvidenceRefusal } from "./evidence-store.ts";

/**
 * S3-compatible blobs behind the service's existing upload/receipt API.
 * The default SDK provider chain refreshes its renewable AWS credentials;
 * broker-backed tenant credential delivery remains separate hosted plumbing.
 * No credentials or signed URLs appear in status or settings.
 */
export class S3EvidenceBlobs implements EvidenceBlobStore {
  readonly backend = "s3";
  readonly location: string;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(settings: Extract<EvidenceSettings, { backend: "s3" }>, client?: S3Client) {
    const config = EvidenceSettingsSchema.parse(settings);
    if (config.backend !== "s3") throw new Error("evidence_s3_configuration_required");
    this.bucket = config.bucket;
    this.prefix = config.prefix;
    this.location = `s3://${this.bucket}/${this.prefix}`;
    this.client = client ?? new S3Client({ region: config.region });
  }

  private key(sha256: string) {
    const hash = EvidenceSha256Schema.parse(sha256);
    return `${this.prefix ? `${this.prefix}/` : ""}sha256/${hash.slice(0, 2)}/${hash}`;
  }

  private static missing(error: unknown) {
    // An access, transport or provider failure must never look like a missing blob.
    return error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey");
  }

  private async head(sha256: string, abortSignal?: AbortSignal) {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(sha256) }),
        abortSignal ? { abortSignal } : undefined,
      );
      if (
        !Number.isSafeInteger(result.ContentLength) ||
        result.ContentLength! < 0 ||
        result.Metadata?.sha256 !== sha256
      )
        throw new Error("evidence_s3_object_invalid");
      return { size: result.ContentLength! };
    } catch (error) {
      if (S3EvidenceBlobs.missing(error)) return undefined;
      throw error;
    }
  }

  async has(sha256: string) {
    return (await this.head(sha256)) !== undefined;
  }

  async write(sha256: string, size: number, body: AsyncIterable<Uint8Array>) {
    const key = this.key(sha256);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("evidence_s3_size_invalid");
    const directory = await mkdtemp(join(tmpdir(), "clankie-evidence-s3-"));
    const file = join(directory, "blob");
    const hash = createHash("sha256");
    let received = 0;
    let oversize = false;
    try {
      // Validate on private disk before any cloud PUT. Avoid buffering large evidence in RAM.
      const checked = async function* () {
        for await (const chunk of body) {
          received += chunk.byteLength;
          if (received > size) {
            oversize = true;
            break;
          }
          hash.update(chunk);
          yield chunk;
        }
      };
      await pipeline(checked(), createWriteStream(file, { flags: "wx", mode: 0o600 }));
      if (oversize || received !== size) return { ok: false as const, reason: "size_mismatch" as const };
      const digest = hash.digest();
      if (digest.toString("hex") !== sha256)
        return { ok: false as const, reason: "sha256_mismatch" as const };
      for (let attempt = 0; attempt < 2; attempt++) {
        const stream = createReadStream(file);
        try {
          await this.client.send(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: key,
              Body: stream,
              ContentLength: size,
              ContentType: "application/octet-stream",
              ChecksumSHA256: digest.toString("base64"),
              Metadata: { sha256 },
              IfNoneMatch: "*",
            }),
          );
          return { ok: true as const };
        } catch (error) {
          // Only an equivalent completed writer may win the immutable-key race.
          if (
            !(error instanceof Error) ||
            (error.name !== "PreconditionFailed" && error.name !== "ConditionalRequestConflict")
          )
            throw error;
          const existing = await this.head(sha256);
          if (existing) {
            if (existing.size !== size) throw new Error("evidence_s3_object_invalid");
            return { ok: true as const };
          }
          // S3 explicitly permits retry of a conditional 409; stream bodies need reopening.
          if (error.name !== "ConditionalRequestConflict" || attempt === 1) throw error;
        } finally {
          stream.destroy();
        }
      }
      throw new Error("evidence_s3_upload_unsettled");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async signedFetch(sha256: string, expiresInSeconds: number) {
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds <= 0 ||
      expiresInSeconds > EVIDENCE_SIGNED_URL_MAX_MS / 1000
    )
      throw new Error("evidence_s3_expiry_invalid");
    const blob = await this.head(sha256);
    if (!blob) return undefined;
    const credentials = await this.client.config.credentials();
    const signingDate = new Date(Math.floor(Date.now() / 1000) * 1000);
    const expiresIn = credentials.expiration
      ? Math.min(
          expiresInSeconds,
          Math.floor((credentials.expiration.getTime() - signingDate.getTime()) / 1000),
        )
      : expiresInSeconds;
    if (expiresIn <= 0) throw new Error("evidence_s3_credential_expired");
    const expiresAt = new Date(signingDate.getTime() + expiresIn * 1000).toISOString();
    // Keep one credential snapshot for both expiry calculation and signing.
    // The original client retains its renewable provider for later requests.
    const signingClient = new S3Client({
      region: this.client.config.region,
      credentials,
      forcePathStyle: this.client.config.forcePathStyle,
      useFipsEndpoint: this.client.config.useFipsEndpoint,
      useDualstackEndpoint: this.client.config.useDualstackEndpoint,
      ...(this.client.config.endpoint ? { endpoint: this.client.config.endpoint } : {}),
    });
    const url = await getSignedUrl(
      signingClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(sha256),
        ResponseContentType: "application/octet-stream",
        ResponseContentDisposition: "attachment",
        ResponseCacheControl: "no-store",
      }),
      { expiresIn, signingDate },
    );
    return { size: blob.size, url, expiresAt };
  }

  async open(sha256: string, abortSignal?: AbortSignal) {
    try {
      abortSignal?.throwIfAborted();
      const blob = await this.head(sha256, abortSignal);
      abortSignal?.throwIfAborted();
      if (!blob) return undefined;
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(sha256) }),
        abortSignal ? { abortSignal } : undefined,
      );
      if (!result.Body || result.ContentLength !== blob.size) {
        await result.Body?.transformToWebStream().cancel();
        throw new Error("evidence_s3_object_invalid");
      }
      const source = result.Body.transformToWebStream();
      if (!abortSignal) return { size: blob.size, body: source };
      if (abortSignal.aborted) {
        await source.cancel(abortSignal.reason);
        abortSignal.throwIfAborted();
      }
      const reader = source.getReader();
      let finished = false;
      let released = false;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const cleanup = () => {
        if (released) return;
        released = true;
        abortSignal.removeEventListener("abort", onAbort);
        reader.releaseLock();
      };
      const onAbort = () => {
        if (finished) return;
        finished = true;
        controller.error(abortSignal.reason);
        void reader
          .cancel(abortSignal.reason)
          .catch(() => {})
          .finally(cleanup);
      };
      const body = new ReadableStream<Uint8Array>({
        start(output) {
          controller = output;
          abortSignal.addEventListener("abort", onAbort, { once: true });
          if (abortSignal.aborted) onAbort();
        },
        async pull(output) {
          try {
            const part = await reader.read();
            if (finished) return;
            if (part.done) {
              finished = true;
              output.close();
              cleanup();
            } else output.enqueue(part.value);
          } catch (error) {
            if (finished) return;
            finished = true;
            output.error(error);
            cleanup();
          }
        },
        async cancel(reason) {
          if (finished) return;
          finished = true;
          try {
            await reader.cancel(reason);
          } finally {
            cleanup();
          }
        },
      });
      return { size: blob.size, body };
    } catch (error) {
      // Caller cancellation must not be mistaken for a missing object, even with a custom reason.
      abortSignal?.throwIfAborted();
      if (S3EvidenceBlobs.missing(error)) return undefined;
      throw error;
    }
  }

  async readRange(sha256: string, offset: number, length: number) {
    const blob = await this.head(sha256);
    if (!blob) return undefined;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > blob.size ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      throw new EvidenceRefusal(400, "invalid_request");
    const count = Math.min(length, blob.size - offset);
    if (!count) return { size: blob.size, bytes: new Uint8Array() };
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(sha256),
        Range: `bytes=${offset}-${offset + count - 1}`,
      }),
    );
    if (
      !result.Body ||
      result.ContentLength !== count ||
      result.ContentRange !== `bytes ${offset}-${offset + count - 1}/${blob.size}`
    )
      throw new Error("evidence_s3_object_invalid");
    const bytes = await result.Body.transformToByteArray();
    if (bytes.byteLength !== count) throw new Error("evidence_s3_object_invalid");
    return { size: blob.size, bytes };
  }
}
