import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BeginOperatorAttachmentUploadSchema,
  createOperatorConversationServiceClient,
  OperatorConversationServiceResultSchema,
  OperatorConversationStreamEventSchema,
  SubmitOperatorConversationTurnSchema,
  type OperatorConversationAttachment,
} from "@clankie/protocol";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationStore, type OwnerAttachmentHost } from "../src/captain/conversations.ts";
import { DeliveredFileStore, type StoredOwnerAttachment } from "../src/delivered-files.ts";
import { materializeOwnerAttachments, type MediaTools } from "../src/owner-attachments.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-owner-attachments-"));
  roots.push(root);
  return root;
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(700 * 1024, 7),
]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(64, 1)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(64, 2)]);
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function inProcess(store: ConversationStore) {
  return createOperatorConversationServiceClient(async (request) =>
    OperatorConversationServiceResultSchema.parse(
      await store.serve(request as Parameters<ConversationStore["serve"]>[0]),
    ),
  );
}

function hostFor(files: DeliveredFileStore, forSeat?: OwnerAttachmentHost["forSeat"]): OwnerAttachmentHost {
  return {
    beginUpload: (upload) => files.beginUpload(upload),
    appendUpload: (chunk) => files.appendUpload(chunk),
    commitUpload: (conversationId, uploadId) => files.commitUpload(conversationId, uploadId),
    attachment: (conversationId, artifactId) => files.attachment(conversationId, artifactId),
    ...(forSeat === undefined ? {} : { forSeat }),
  };
}

describe("owner attachment protocol", () => {
  it("lets a message be only attachments, never nothing", () => {
    const base = {
      schemaVersion: 1,
      kind: "message",
      conversationId: "c",
      surfaceClientId: "app",
      expectedRevision: 0,
    } as const;
    expect(
      SubmitOperatorConversationTurnSchema.safeParse({
        ...base,
        message: "",
        attachments: [{ artifactId: "a".repeat(48) }],
      }).success,
    ).toBe(true);
    expect(SubmitOperatorConversationTurnSchema.safeParse({ ...base, message: "  " }).success).toBe(false);
    expect(
      SubmitOperatorConversationTurnSchema.safeParse({
        ...base,
        message: "two",
        attachments: [{ artifactId: "a".repeat(48) }, { artifactId: "a".repeat(48) }],
      }).success,
    ).toBe(false);
    expect(
      BeginOperatorAttachmentUploadSchema.safeParse({
        conversationId: "c",
        filename: "a.pdf",
        mediaType: "application/pdf",
        byteCount: 1,
        sha256: "0".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("fits a full chunk inside the relay and gateway 1 MiB bodies, and hosted devices may upload", () => {
    const request = {
      op: "upload_chunk",
      schemaVersion: 1,
      chunk: {
        conversationId: "c".repeat(64),
        uploadId: `upload-${"0".repeat(32)}`,
        offset: 199 * 1024 * 1024,
        dataBase64: Buffer.alloc(512 * 1024, 255).toString("base64"),
      },
    };
    const body = JSON.stringify(request);
    expect(Buffer.byteLength(body)).toBeLessThan(1024 * 1024);
    expect(hostedOperatorAllows("POST", "/operator/v1/dispatch", body)).toBe(true);
  });
});

describe("chunked upload", () => {
  it("commits a hash-verified file, acknowledges a retried chunk, and resumes after a gap", async () => {
    const root = await scratch();
    const files = new DeliveredFileStore(join(root, "attachments"));
    const begun = await files.beginUpload({
      conversationId: "conv",
      filename: "screen.png",
      mediaType: "image/png",
      byteCount: PNG.byteLength,
      sha256: sha(PNG),
    });
    if (begun.status !== "uploading") throw new Error("uploading expected");
    const first = PNG.subarray(0, begun.chunkBytes);
    const chunk = (offset: number, bytes: Buffer) =>
      files.appendUpload({
        conversationId: "conv",
        uploadId: begun.uploadId,
        offset,
        dataBase64: bytes.toString("base64"),
      });
    expect(await chunk(0, first)).toMatchObject({ status: "uploading", receivedBytes: first.byteLength });
    // The acknowledgement was lost and the client sent it again.
    expect(await chunk(0, first)).toMatchObject({ status: "uploading", receivedBytes: first.byteLength });
    expect(await chunk(first.byteLength + 1, Buffer.from([1]))).toMatchObject({
      status: "refused",
      reason: "offset_mismatch",
      receivedBytes: first.byteLength,
    });
    expect(await files.commitUpload("conv", begun.uploadId)).toMatchObject({
      status: "refused",
      reason: "incomplete",
    });
    await chunk(first.byteLength, PNG.subarray(first.byteLength));
    const committed = await files.commitUpload("conv", begun.uploadId);
    expect(committed).toMatchObject({
      status: "committed",
      file: { filename: "screen.png", mediaType: "image/png", byteCount: PNG.byteLength, sha256: sha(PNG) },
    });
    if (committed.status !== "committed") throw new Error("committed expected");
    const stored = await files.attachment("conv", committed.file.artifactId);
    expect(await readFile(stored!.path)).toEqual(PNG);
    // Under the delivered-file bound it downloads like any delivered file.
    expect((await files.read("conv", committed.file.artifactId))?.data).toEqual(PNG);
    expect(await files.attachment("other", committed.file.artifactId)).toBeUndefined();
    await files.removeConversation("conv");
    expect(await files.attachment("conv", committed.file.artifactId)).toBeUndefined();
  });

  it("refuses a wrong hash, bytes that are not the declared type, and oversize declarations", async () => {
    const root = await scratch();
    const files = new DeliveredFileStore(join(root, "attachments"));
    const upload = async (bytes: Buffer, mediaType: "image/png" | "image/jpeg", hash = sha(bytes)) => {
      const begun = await files.beginUpload({
        conversationId: "conv",
        filename: "x",
        mediaType,
        byteCount: bytes.byteLength,
        sha256: hash,
      });
      if (begun.status !== "uploading") throw new Error("uploading expected");
      await files.appendUpload({
        conversationId: "conv",
        uploadId: begun.uploadId,
        offset: 0,
        dataBase64: bytes.subarray(0, 1024).toString("base64"),
      });
      return files.commitUpload("conv", begun.uploadId);
    };
    const small = PNG.subarray(0, 1024);
    expect(await upload(small, "image/png", "f".repeat(64))).toMatchObject({ reason: "hash_mismatch" });
    expect(await upload(small, "image/jpeg")).toMatchObject({ reason: "content_mismatch" });
    expect(
      await files.beginUpload({
        conversationId: "conv",
        filename: "big.png",
        mediaType: "image/png",
        byteCount: 21 * 1024 * 1024,
        sha256: "0".repeat(64),
      }),
    ).toMatchObject({ status: "refused", reason: "too_large" });
  });
});

describe("seat delivery", () => {
  const tools = (options: { ffmpeg: boolean }): MediaTools => ({
    platform: "darwin",
    async run(command, args) {
      if (!options.ffmpeg && (command === "ffmpeg" || command === "ffprobe"))
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (command === "ffprobe") return { stdout: "32.5\n" };
      const output = command === "sips" ? args[args.indexOf("--out") + 1]! : args.at(-1)!;
      await writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      return { stdout: "" };
    },
  });

  async function stored(root: string, file: OperatorConversationAttachment, bytes: Buffer) {
    const path = join(root, `${file.artifactId}.bin`);
    await writeFile(path, bytes);
    return { file, path } satisfies StoredOwnerAttachment;
  }
  const record = (
    filename: string,
    mediaType: OperatorConversationAttachment["mediaType"],
    bytes: Buffer,
  ) => ({
    artifactId: sha(Buffer.from(filename)).slice(0, 48),
    filename,
    mediaType,
    byteCount: bytes.byteLength,
    sha256: sha(bytes),
  });

  it("puts files in a git-ignored inbox inside the workspace, with HEIC copies and video keyframes", async () => {
    const root = await scratch();
    const workspace = join(root, "repo");
    await mkdir(workspace);
    const attachments = [
      await stored(root, record("screen.png", "image/png", PNG), PNG),
      await stored(root, record("IMG_1.HEIC", "image/heic", HEIC), HEIC),
      await stored(root, record("clip", "video/mp4", MP4), MP4),
    ];
    const { directory, note } = await materializeOwnerAttachments({
      workspace,
      messageId: "msg-1",
      attachments,
      tools: tools({ ffmpeg: true }),
    });
    expect(directory).toBe(
      join(await import("node:fs/promises").then((fs) => fs.realpath(workspace)), ".clankie/inbox/msg-1"),
    );
    expect(await readFile(join(directory, "..", ".gitignore"), "utf8")).toContain("*");
    expect((await readdir(directory)).sort()).toEqual([
      "IMG_1.HEIC",
      "IMG_1.jpg",
      "clip.frames",
      "clip.mp4",
      "screen.png",
    ]);
    expect(await readdir(join(directory, "clip.frames"))).toHaveLength(8);
    expect(note).toContain("not an instruction");
    expect(note).toContain(join(directory, "screen.png"));
    expect(note).toContain(`JPEG copy to view: ${join(directory, "IMG_1.jpg")}`);
    expect(note).toContain("0:32");
    expect(note).toContain("8 keyframes");
  });

  it("says when ffmpeg is missing, and refuses an inbox that escapes the workspace", async () => {
    const root = await scratch();
    const workspace = join(root, "repo");
    await mkdir(workspace);
    const video = await stored(root, record("clip.mov", "video/quicktime", MP4), MP4);
    const { note } = await materializeOwnerAttachments({
      workspace,
      messageId: "msg-2",
      attachments: [video],
      tools: tools({ ffmpeg: false }),
    });
    expect(note).toContain("ffmpeg is not installed");

    const escaping = join(root, "escaping");
    await mkdir(escaping);
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), join(escaping, ".clankie"));
    await expect(
      materializeOwnerAttachments({ workspace: escaping, messageId: "msg-3", attachments: [video] }),
    ).rejects.toThrow("attachment_inbox_not_a_directory");
    expect((await lstat(join(root, "elsewhere"))).isDirectory()).toBe(true);
    expect(await readdir(join(root, "elsewhere"))).toEqual([]);
  });
});

describe("sending attachments", () => {
  it("uploads through the client, hands a seat its note, and records the files on the operator message", async () => {
    const root = await scratch();
    const files = new DeliveredFileStore(join(root, "attachments"));
    const sendToSeat = vi.fn(async () => true);
    const forSeat = vi.fn(
      async (_seatId: string, _conversationId: string, attachments: readonly StoredOwnerAttachment[]) => ({
        note: `[note for ${attachments.map((attachment) => attachment.file.filename).join(", ")}]`,
      }),
    );
    const store = new ConversationStore(
      join(root, "conversations"),
      vi.fn(),
      undefined,
      sendToSeat,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      root,
      undefined,
      hostFor(files, forSeat),
    );
    try {
      const client = inProcess(store);
      const conversation = await client.create({
        scope: { kind: "seat", seatId: "term-1" },
        title: "Worker",
      });
      const progress: number[] = [];
      const committed = await client.uploadAttachment!(
        {
          conversationId: conversation.conversationId,
          filename: "screen.png",
          mediaType: "image/png",
          byteCount: PNG.byteLength,
          sha256: sha(PNG),
          bytes: new Uint8Array(PNG),
        },
        { onProgress: (received) => progress.push(received) },
      );
      if (committed.status !== "committed")
        throw new Error(`committed expected: ${JSON.stringify(committed)}`);
      expect(progress).toEqual([512 * 1024, PNG.byteLength]);
      const result = await client.send({
        schemaVersion: 1,
        kind: "message",
        conversationId: conversation.conversationId,
        surfaceClientId: "app",
        expectedRevision: conversation.revision,
        message: "What is wrong here?",
        attachments: [{ artifactId: committed.file.artifactId }],
      });
      expect(result.status).toBe("accepted");
      expect(forSeat).toHaveBeenCalledWith("term-1", conversation.conversationId, [
        expect.objectContaining({ file: committed.file }),
      ]);
      expect(sendToSeat).toHaveBeenCalledWith(
        "term-1",
        "What is wrong here?\n\n[note for screen.png]",
        expect.objectContaining({ source: "operator" }),
      );
      const page = await client.replay({
        schemaVersion: 1,
        conversationId: conversation.conversationId,
        surfaceClientId: "app",
      });
      if (page.status !== "page") throw new Error("page expected");
      const message = page.events.find((event) => event.type === "message");
      expect(OperatorConversationStreamEventSchema.parse(message)).toMatchObject({
        role: "operator",
        text: "What is wrong here?",
        attachments: [committed.file],
      });

      // An attachment of another conversation is not this one's to send.
      const other = await client.create({ scope: { kind: "seat", seatId: "term-2" }, title: "Other" });
      await expect(
        client.send({
          schemaVersion: 1,
          kind: "message",
          conversationId: other.conversationId,
          surfaceClientId: "app",
          expectedRevision: other.revision,
          message: "",
          attachments: [{ artifactId: committed.file.artifactId }],
        }),
      ).rejects.toThrow("not uploaded to this conversation");
    } finally {
      await store.close();
    }
  });

  it("refuses a seat that cannot take files without sending anything", async () => {
    const root = await scratch();
    const files = new DeliveredFileStore(join(root, "attachments"));
    const sendToSeat = vi.fn(async () => true);
    const store = new ConversationStore(
      join(root, "conversations"),
      vi.fn(),
      undefined,
      sendToSeat,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      root,
      undefined,
      hostFor(files, async () => ({ undeliverable: "This agent runs on another machine." })),
    );
    try {
      const client = inProcess(store);
      const conversation = await client.create({
        scope: { kind: "seat", seatId: "remote:term-1" },
        title: "Remote",
      });
      const committed = await client.uploadAttachment!({
        conversationId: conversation.conversationId,
        filename: "clip.mp4",
        mediaType: "video/mp4",
        byteCount: MP4.byteLength,
        sha256: sha(MP4),
        bytes: new Uint8Array(MP4),
      });
      if (committed.status !== "committed") throw new Error("committed expected");
      const result = await client.send({
        schemaVersion: 1,
        kind: "message",
        conversationId: conversation.conversationId,
        surfaceClientId: "app",
        expectedRevision: conversation.revision,
        message: "",
        attachments: [{ artifactId: committed.file.artifactId }],
      });
      expect(result).toMatchObject({
        status: "seat_undelivered",
        detail: "This agent runs on another machine.",
      });
      expect(sendToSeat).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it("hands Clankie's own runner the stored files", async () => {
    const root = await scratch();
    const files = new DeliveredFileStore(join(root, "attachments"));
    const runner = vi.fn(async () => undefined);
    const store = new ConversationStore(
      join(root, "conversations"),
      runner,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      root,
      undefined,
      hostFor(files),
    );
    try {
      const client = inProcess(store);
      const conversation = await client.create({ scope: { kind: "global" }, title: "Clankie" });
      const committed = await client.uploadAttachment!({
        conversationId: conversation.conversationId,
        filename: "screen.png",
        mediaType: "image/png",
        byteCount: PNG.byteLength,
        sha256: sha(PNG),
        bytes: new Uint8Array(PNG),
      });
      if (committed.status !== "committed") throw new Error("committed expected");
      const result = await client.send({
        schemaVersion: 1,
        kind: "message",
        conversationId: conversation.conversationId,
        surfaceClientId: "app",
        expectedRevision: conversation.revision,
        message: "",
        attachments: [{ artifactId: committed.file.artifactId }],
      });
      if (result.status !== "accepted") throw new Error("accepted expected");
      await store.awaitRun(result.runId);
      expect(runner).toHaveBeenCalledWith(
        conversation.conversationId,
        "",
        expect.any(Function),
        expect.objectContaining({ attachments: [expect.objectContaining({ file: committed.file })] }),
      );
    } finally {
      await store.close();
    }
  });
});
