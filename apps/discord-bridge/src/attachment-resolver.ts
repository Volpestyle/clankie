import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const HASH_BOUND_REF = /^sha256:([0-9a-f]{64}):(.+)$/u;

export function createFilesystemAttachmentResolver(root: string | undefined) {
  return async (artifactRef: string): Promise<{ data: Buffer; contentType?: string }> => {
    if (!root) throw new Error("discord_presence_attachment_root_unavailable");
    const match = HASH_BOUND_REF.exec(artifactRef);
    if (!match) throw new Error("discord_presence_attachment_ref_invalid");
    const [, expectedHex, relativePath] = match;
    if (!expectedHex || !relativePath || isAbsolute(relativePath)) {
      throw new Error("discord_presence_attachment_ref_invalid");
    }
    const rootPath = await realpath(root);
    const filePath = await realpath(resolve(rootPath, relativePath));
    const containment = relative(rootPath, filePath);
    if (containment.startsWith("..") || isAbsolute(containment)) {
      throw new Error("discord_presence_attachment_outside_root");
    }
    const data = await readFile(filePath);
    if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("discord_presence_attachment_too_large");
    const actual = createHash("sha256").update(data).digest();
    if (!timingSafeEqual(Buffer.from(expectedHex, "hex"), actual)) {
      throw new Error("discord_presence_attachment_hash_mismatch");
    }
    const contentType = contentTypeFor(filePath);
    return { data, ...(contentType === undefined ? {} : { contentType }) };
  };
}

function contentTypeFor(path: string): string | undefined {
  const types: Record<string, string> = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return types[extname(path).toLowerCase()];
}
