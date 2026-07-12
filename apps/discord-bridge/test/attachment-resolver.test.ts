import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFilesystemAttachmentResolver } from "../src/attachment-resolver.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("filesystem attachment resolver", () => {
  it("resolves hash-bound refs and rejects hash drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-attachments-"));
    roots.push(root);
    const data = Buffer.from("image-bytes");
    await writeFile(join(root, "shot.png"), data);
    const digest = createHash("sha256").update(data).digest("hex");
    const resolver = createFilesystemAttachmentResolver(root);
    await expect(resolver(`sha256:${digest}:shot.png`)).resolves.toEqual({ data, contentType: "image/png" });
    await expect(resolver(`sha256:${"0".repeat(64)}:shot.png`)).rejects.toThrow(/hash_mismatch/);
  });

  it("rejects traversal through symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-attachments-"));
    const outside = await mkdtemp(join(tmpdir(), "clankie-attachment-outside-"));
    roots.push(root, outside);
    const data = Buffer.from("private");
    await writeFile(join(outside, "private.png"), data);
    await symlink(join(outside, "private.png"), join(root, "escape.png"));
    const digest = createHash("sha256").update(data).digest("hex");
    await expect(createFilesystemAttachmentResolver(root)(`sha256:${digest}:escape.png`)).rejects.toThrow(/outside_root/);
  });
});
