import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperatorConversation } from "@clankie/protocol";
import { runSendCommand } from "../src/command/send.ts";

const DEFAULT: OperatorConversation = {
  schemaVersion: 1,
  conversationId: "global-default",
  scope: { kind: "global" },
  title: "Clankie",
  isDefault: true,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
  sessionState: "active",
  revision: 7,
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("clankie send --attach", () => {
  it("uploads each file in verified chunks, then sends the message naming them", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-send-attach-"));
    roots.push(root);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(600 * 1024, 3),
    ]);
    await writeFile(join(root, "screen.png"), png);
    const sha256 = createHash("sha256").update(png).digest("hex");
    const received: Buffer[] = [];
    const requests: Array<Record<string, unknown>> = [];
    const upload = `upload-${"a".repeat(32)}`;
    const state = (receivedBytes: number) => ({
      status: "uploading",
      conversationId: DEFAULT.conversationId,
      uploadId: upload,
      byteCount: png.byteLength,
      receivedBytes,
      chunkBytes: 512 * 1024,
      expiresAt: "2026-07-12T01:00:00.000Z",
    });
    const fetchImpl = (async (_url: URL, init: { body: string }) => {
      const request = JSON.parse(init.body) as Record<string, any>;
      requests.push(request);
      switch (request.op) {
        case "get":
          return Response.json({ op: "get", schemaVersion: 1, conversation: DEFAULT });
        case "upload_begin":
          return Response.json({ op: "upload_begin", schemaVersion: 1, result: state(0) });
        case "upload_chunk": {
          received.push(Buffer.from(request.chunk.dataBase64, "base64"));
          const total = received.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          return Response.json({ op: "upload_chunk", schemaVersion: 1, result: state(total) });
        }
        case "upload_commit":
          return Response.json({
            op: "upload_commit",
            schemaVersion: 1,
            result: {
              status: "committed",
              conversationId: DEFAULT.conversationId,
              file: {
                artifactId: "b".repeat(48),
                filename: "screen.png",
                mediaType: "image/png",
                byteCount: png.byteLength,
                sha256,
              },
            },
          });
        default:
          return Response.json({
            op: "send",
            schemaVersion: 1,
            result: {
              schemaVersion: 1,
              status: "accepted",
              conversationId: DEFAULT.conversationId,
              runId: "run:test",
              revision: DEFAULT.revision + 1,
              safeCursor: "000000000001",
            },
          });
      }
    }) as unknown as typeof fetch;

    const exitCode = await runSendCommand(
      ["--conversation", DEFAULT.conversationId, "--attach", join(root, "screen.png")],
      { env: { CLANKIE_CAPTAIN_TOKEN: "test-captain" }, stdout: { write: () => true }, fetchImpl },
    );

    expect(exitCode).toBe(0);
    expect(Buffer.concat(received)).toEqual(png);
    expect(requests.map((request) => request.op)).toEqual([
      "upload_begin",
      "upload_chunk",
      "upload_chunk",
      "upload_commit",
      "get",
      "send",
    ]);
    expect(requests[0]).toMatchObject({ upload: { filename: "screen.png", mediaType: "image/png", sha256 } });
    expect(requests.at(-1)).toMatchObject({
      turn: {
        message: "",
        attachments: [{ artifactId: "b".repeat(48) }],
        expectedRevision: DEFAULT.revision,
      },
    });
  });

  it("refuses a file type it cannot attach before contacting Clankie", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-send-attach-"));
    roots.push(root);
    await writeFile(join(root, "notes.pdf"), "%PDF");
    const fetchImpl = vi.fn();
    await expect(
      runSendCommand(
        ["--conversation", DEFAULT.conversationId, "--attach", join(root, "notes.pdf"), "read this"],
        {
          env: { CLANKIE_CAPTAIN_TOKEN: "test-captain" },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/attach png, jpeg/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
