import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  OPERATOR_DELIVERED_FILE_BYTES_MAX,
  OperatorDeliveredFileSchema,
  type OperatorDeliveredFile,
} from "@clankie/protocol";

export interface PublishedDeliveredFile extends OperatorDeliveredFile {
  readonly artifactRef: string;
}

/** Durable, hash-bound files chosen for delivery from one conversation. */
export class DeliveredFileStore {
  private readonly attachmentRoot: string;

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
    if (containment.startsWith("..") || isAbsolute(containment)) {
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
    const artifactId = createHash("sha256")
      .update(input.conversationId)
      .update("\0")
      .update(filename)
      .update("\0")
      .update(sha256)
      .digest("hex")
      .slice(0, 48);
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

  public removeConversation(conversationId: string): Promise<void> {
    return rm(join(this.attachmentRoot, "delivered", conversationStorageKey(conversationId)), {
      recursive: true,
      force: true,
    });
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
  const pending = `${path}.${process.pid}.pending`;
  await writeFile(pending, data, { mode: 0o600 });
  await rename(pending, path);
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
