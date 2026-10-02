import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  open as openFile,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  OPERATOR_ATTACHMENT_CHUNK_BYTES_MAX,
  OPERATOR_DELIVERED_FILE_BYTES_MAX,
  OperatorConversationAttachmentSchema,
  OperatorDeliveredFileSchema,
  operatorAttachmentBytesMax,
  type BeginOperatorAttachmentUpload,
  type OperatorAttachmentChunk,
  type OperatorAttachmentUploadRefusalReason,
  type OperatorAttachmentUploadResult,
  type OperatorConversationAttachment,
  type OperatorDeliveredFile,
} from "@clankie/protocol";

/** An idle upload is discarded after this long. */
const UPLOAD_IDLE_MS = 60 * 60_000;
/** Open uploads across every conversation; bounds staged disk at roughly this many videos. */
const OPEN_UPLOADS_MAX = 16;

interface OpenUpload {
  readonly conversationId: string;
  readonly upload: BeginOperatorAttachmentUpload;
  readonly directory: string;
  receivedBytes: number;
  expiresAt: number;
  /** Serializes chunk writes so two retries never interleave bytes. */
  chain: Promise<unknown>;
}

/** An owner attachment ready to hand to a session: its record and its stored bytes. */
export interface StoredOwnerAttachment {
  readonly file: OperatorConversationAttachment;
  readonly path: string;
}

export interface PublishedDeliveredFile extends OperatorDeliveredFile {
  readonly artifactRef: string;
}

const DELIVERED_IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/iu;

export function isDeliveredImagePath(path: string): boolean {
  return DELIVERED_IMAGE_EXTENSION.test(path);
}

/** Durable, hash-bound files chosen for delivery from one conversation. */
export class DeliveredFileStore {
  private readonly attachmentRoot: string;
  private readonly uploads = new Map<string, OpenUpload>();

  public constructor(attachmentRoot: string) {
    this.attachmentRoot = attachmentRoot;
  }

  public async publish(input: {
    readonly conversationId: string;
    readonly sourceRoot: string;
    readonly path: string;
    readonly filename?: string;
    readonly mediaType?: string;
  }): Promise<PublishedDeliveredFile> {
    const root = await realpath(input.sourceRoot);
    const source = await realpath(resolve(root, input.path));
    const containment = relative(root, source);
    if (containment === ".." || containment.startsWith(`..${sep}`) || isAbsolute(containment)) {
      throw new Error("delivered_file_outside_conversation_workspace");
    }
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new Error("delivered_file_must_be_a_regular_file");
    if (sourceStat.size > OPERATOR_DELIVERED_FILE_BYTES_MAX) {
      throw new Error("delivered_file_too_large");
    }

    const data = await readFile(source);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const filename = safeFilename(input.filename ?? basename(source));
    const artifactId = artifactIdFor(input.conversationId, filename, sha256);
    const file = OperatorDeliveredFileSchema.parse({
      artifactId,
      filename,
      mediaType: input.mediaType ?? contentTypeFor(filename),
      byteCount: data.byteLength,
      sha256,
    });
    const conversationKey = conversationStorageKey(input.conversationId);
    const directory = join(this.attachmentRoot, "delivered", conversationKey, artifactId);
    await mkdir(directory, { recursive: true });
    await atomicWrite(join(directory, "content"), data);
    await atomicWrite(
      join(directory, "meta.json"),
      Buffer.from(JSON.stringify({ schemaVersion: 1, conversationId: input.conversationId, file })),
    );
    return {
      ...file,
      artifactRef: `sha256:${sha256}:delivered/${conversationKey}/${artifactId}/content`,
    };
  }

  public async read(
    conversationId: string,
    artifactId: string,
  ): Promise<{ readonly file: OperatorDeliveredFile; readonly data: Buffer } | undefined> {
    if (!/^[a-f0-9]{48}$/u.test(artifactId)) return undefined;
    const directory = join(
      this.attachmentRoot,
      "delivered",
      conversationStorageKey(conversationId),
      artifactId,
    );
    try {
      const manifest = JSON.parse(await readFile(join(directory, "meta.json"), "utf8")) as {
        readonly schemaVersion?: unknown;
        readonly conversationId?: unknown;
        readonly file?: unknown;
      };
      if (manifest.schemaVersion !== 1 || manifest.conversationId !== conversationId) return undefined;
      // An owner attachment is downloadable while it fits the same bound as a
      // delivered file; a larger video stays on the host (ADR 0209).
      const file = OperatorDeliveredFileSchema.parse(manifest.file);
      if (file.artifactId !== artifactId) return undefined;
      const data = await readFile(join(directory, "content"));
      if (data.byteLength !== file.byteCount) return undefined;
      const actual = createHash("sha256").update(data).digest();
      if (!timingSafeEqual(Buffer.from(file.sha256, "hex"), actual)) return undefined;
      return { file, data };
    } catch {
      return undefined;
    }
  }

  /**
   * Open an owner upload (ADR 0209). The bytes are staged inside the
   * conversation's own delivered directory, so reset, close and retention
   * remove a half-finished upload together with everything else.
   */
  public async beginUpload(
    upload: BeginOperatorAttachmentUpload,
    now = Date.now(),
  ): Promise<OperatorAttachmentUploadResult> {
    this.expireUploads(now);
    if (upload.byteCount > operatorAttachmentBytesMax(upload.mediaType)) {
      return refusal(
        upload.conversationId,
        "too_large",
        `${upload.mediaType.startsWith("video/") ? "Videos" : "Images"} are limited to ${String(
          operatorAttachmentBytesMax(upload.mediaType) / (1024 * 1024),
        )} MiB.`,
      );
    }
    if (this.uploads.size >= OPEN_UPLOADS_MAX) {
      return refusal(
        upload.conversationId,
        "busy",
        "Too many uploads are open; finish or wait for one first.",
      );
    }
    try {
      safeFilename(upload.filename);
    } catch {
      return refusal(upload.conversationId, "unavailable", "That filename cannot be stored.");
    }
    const uploadsRoot = join(this.conversationDirectory(upload.conversationId), "uploads");
    await this.sweepOrphanUploads(uploadsRoot);
    const uploadId = `upload-${randomBytes(16).toString("hex")}`;
    const directory = join(uploadsRoot, uploadId);
    // Registered before its directory exists, so a concurrent sweep keeps it.
    const open: OpenUpload = {
      conversationId: upload.conversationId,
      upload,
      directory,
      receivedBytes: 0,
      expiresAt: now + UPLOAD_IDLE_MS,
      chain: Promise.resolve(),
    };
    this.uploads.set(uploadId, open);
    const created = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "data"), new Uint8Array(), { mode: 0o600 });
    })();
    open.chain = created;
    try {
      await created;
    } catch (error) {
      this.uploads.delete(uploadId);
      throw error;
    }
    return uploading(uploadId, open);
  }

  public appendUpload(
    chunk: OperatorAttachmentChunk,
    now = Date.now(),
  ): Promise<OperatorAttachmentUploadResult> {
    this.expireUploads(now);
    const open = this.uploads.get(chunk.uploadId);
    if (open === undefined || open.conversationId !== chunk.conversationId) {
      return Promise.resolve(
        refusal(chunk.conversationId, "unknown_upload", "That upload is not open; begin it again."),
      );
    }
    const run = open.chain.then(async (): Promise<OperatorAttachmentUploadResult> => {
      const data = Buffer.from(chunk.dataBase64, "base64");
      if (data.byteLength === 0 || data.byteLength > OPERATOR_ATTACHMENT_CHUNK_BYTES_MAX) {
        return refusal(chunk.conversationId, "too_large", "A chunk must hold 1 byte to 512 KiB.");
      }
      // A retried chunk whose acknowledgement was lost is the one case where
      // the offset is behind: its bytes are already here, so say so again.
      if (chunk.offset !== open.receivedBytes) {
        if (chunk.offset + data.byteLength === open.receivedBytes) {
          open.expiresAt = now + UPLOAD_IDLE_MS;
          return uploading(chunk.uploadId, open);
        }
        return {
          ...refusal(chunk.conversationId, "offset_mismatch", "Resume from receivedBytes."),
          receivedBytes: open.receivedBytes,
        };
      }
      if (open.receivedBytes + data.byteLength > open.upload.byteCount) {
        return refusal(chunk.conversationId, "too_large", "More bytes than the upload declared.");
      }
      await appendFile(join(open.directory, "data"), data);
      open.receivedBytes += data.byteLength;
      open.expiresAt = now + UPLOAD_IDLE_MS;
      return uploading(chunk.uploadId, open);
    });
    open.chain = run.catch(() => undefined);
    return run;
  }

  /** Verify size, hash and content type, then store the file as a conversation attachment. */
  public commitUpload(conversationId: string, uploadId: string): Promise<OperatorAttachmentUploadResult> {
    this.expireUploads(Date.now());
    const open = this.uploads.get(uploadId);
    if (open === undefined || open.conversationId !== conversationId) {
      return Promise.resolve(
        refusal(conversationId, "unknown_upload", "That upload is not open; begin it again."),
      );
    }
    const run = open.chain.then(async (): Promise<OperatorAttachmentUploadResult> => {
      const { upload } = open;
      if (open.receivedBytes !== upload.byteCount) {
        return {
          ...refusal(conversationId, "incomplete", "Not every byte has arrived yet."),
          receivedBytes: open.receivedBytes,
        };
      }
      this.uploads.delete(uploadId);
      const source = join(open.directory, "data");
      try {
        const sha256 = await hashFile(source);
        if (sha256 !== upload.sha256) {
          return refusal(conversationId, "hash_mismatch", "The bytes do not match the declared SHA-256.");
        }
        if (!(await contentMatches(source, upload.mediaType))) {
          return refusal(conversationId, "content_mismatch", `The bytes are not ${upload.mediaType}.`);
        }
        const filename = safeFilename(upload.filename);
        const artifactId = artifactIdFor(conversationId, filename, sha256);
        const file = OperatorConversationAttachmentSchema.parse({
          artifactId,
          filename,
          mediaType: upload.mediaType,
          byteCount: upload.byteCount,
          sha256,
        });
        const directory = join(this.conversationDirectory(conversationId), artifactId);
        await mkdir(directory, { recursive: true });
        await rename(source, join(directory, "content"));
        await atomicWrite(
          join(directory, "meta.json"),
          Buffer.from(JSON.stringify({ schemaVersion: 1, conversationId, origin: "owner", file })),
        );
        return { status: "committed", conversationId, file };
      } finally {
        await rm(open.directory, { recursive: true, force: true });
      }
    });
    open.chain = run.catch(() => undefined);
    return run;
  }

  /** A committed owner attachment of this conversation, or undefined. */
  public async attachment(
    conversationId: string,
    artifactId: string,
  ): Promise<StoredOwnerAttachment | undefined> {
    if (!/^[a-f0-9]{48}$/u.test(artifactId)) return undefined;
    const directory = join(this.conversationDirectory(conversationId), artifactId);
    try {
      const manifest = JSON.parse(await readFile(join(directory, "meta.json"), "utf8")) as {
        readonly schemaVersion?: unknown;
        readonly conversationId?: unknown;
        readonly origin?: unknown;
        readonly file?: unknown;
      };
      if (manifest.schemaVersion !== 1 || manifest.conversationId !== conversationId) return undefined;
      if (manifest.origin !== "owner") return undefined;
      const file = OperatorConversationAttachmentSchema.parse(manifest.file);
      if (file.artifactId !== artifactId) return undefined;
      const path = join(directory, "content");
      if ((await stat(path)).size !== file.byteCount) return undefined;
      return { file, path };
    } catch {
      return undefined;
    }
  }

  private conversationDirectory(conversationId: string): string {
    return join(this.attachmentRoot, "delivered", conversationStorageKey(conversationId));
  }

  private expireUploads(now: number): void {
    for (const [uploadId, open] of this.uploads) {
      if (open.expiresAt > now) continue;
      this.uploads.delete(uploadId);
      void open.chain.then(() => rm(open.directory, { recursive: true, force: true })).catch(() => undefined);
    }
  }

  /** Staged bytes a restart orphaned: nothing can append to them again. */
  private async sweepOrphanUploads(uploadsRoot: string): Promise<void> {
    const entries = await readdir(uploadsRoot).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((entry) => !this.uploads.has(entry))
        .map((entry) => rm(join(uploadsRoot, entry), { recursive: true, force: true })),
    );
  }

  public removeConversation(conversationId: string): Promise<void> {
    return rm(join(this.attachmentRoot, "delivered", conversationStorageKey(conversationId)), {
      recursive: true,
      force: true,
    });
  }
}

/**
 * Image paths a message names, in order, without duplicates. A backticked path
 * may hold spaces; a bare one ends at whitespace or a delimiter. Whether a
 * candidate is a real file inside the working directory is `publish`'s call.
 */
export function namedImagePaths(text: string): string[] {
  const pattern = /`([^`\n]+\.(?:png|jpe?g|gif|webp))`|([^\s`'"()<>[\]]+\.(?:png|jpe?g|gif|webp))\b/giu;
  const paths = [...text.matchAll(pattern)]
    .map((match) => (match[1] ?? match[2] ?? "").trim())
    .filter((path) => path.length > 0 && !path.includes("://"))
    .map((path) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path))
    .filter(isDeliveredImagePath);
  return [...new Set(paths)];
}

function artifactIdFor(conversationId: string, filename: string, sha256: string): string {
  return createHash("sha256")
    .update(conversationId)
    .update("\0")
    .update(filename)
    .update("\0")
    .update(sha256)
    .digest("hex")
    .slice(0, 48);
}

function uploading(uploadId: string, open: OpenUpload): OperatorAttachmentUploadResult {
  return {
    status: "uploading",
    conversationId: open.conversationId,
    uploadId,
    byteCount: open.upload.byteCount,
    receivedBytes: open.receivedBytes,
    chunkBytes: OPERATOR_ATTACHMENT_CHUNK_BYTES_MAX,
    expiresAt: new Date(open.expiresAt).toISOString(),
  };
}

function refusal(
  conversationId: string,
  reason: OperatorAttachmentUploadRefusalReason,
  message: string,
): Extract<OperatorAttachmentUploadResult, { status: "refused" }> {
  return { status: "refused", conversationId, reason, message };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/**
 * Whether the leading bytes are the declared kind. A file is named by what it
 * is, not what a client called it, because a harness opens it by extension.
 */
async function contentMatches(path: string, mediaType: string): Promise<boolean> {
  const handle = await openFile(path, "r");
  const head = Buffer.alloc(16);
  try {
    await handle.read(head, 0, head.byteLength, 0);
  } finally {
    await handle.close();
  }
  const ascii = (start: number, end: number): string => head.subarray(start, end).toString("latin1");
  switch (mediaType) {
    case "image/png":
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "image/gif":
      return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "image/heic":
    case "image/heif":
      return ascii(4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(8, 12));
    case "video/mp4":
    case "video/quicktime":
      // Phones and editors label MP4 and QuickTime interchangeably; both are
      // ISO boxes, so either label accepts either container.
      return (
        ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(ascii(4, 8)) &&
        !HEIF_BRANDS.has(ascii(8, 12))
      );
    default:
      return false;
  }
}

function conversationStorageKey(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 32);
}

function safeFilename(value: string): string {
  const filename = [...basename(value)]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .trim();
  if (filename.length === 0 || filename === "." || filename === "..") {
    throw new Error("delivered_file_name_invalid");
  }
  return filename.slice(0, 256);
}

async function atomicWrite(path: string, data: Buffer): Promise<void> {
  const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
  try {
    await writeFile(pending, data, { mode: 0o600 });
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}

function contentTypeFor(path: string): string {
  const types: Readonly<Record<string, string>> = {
    ".csv": "text/csv; charset=utf-8",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}
