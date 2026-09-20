import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH } from "@clankie/protocol";
import { afterEach, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DeliveredFileStore } from "../src/delivered-files.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("publishes a workspace file into the transcript and downloads its exact bytes with captain auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-delivered-file-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const expected = Buffer.from("quarter,total\nQ1,42\n", "utf8");
  await writeFile(join(workspace, "report.csv"), expected);
  await writeFile(join(root, "outside.txt"), "private");

  const deliveredFiles = new DeliveredFileStore(join(root, "attachments"));
  const conversations = new ConversationStore(
    join(root, "conversations"),
    async () => undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (input) => deliveredFiles.publish(input),
    workspace,
  );
  try {
    const published = await conversations.serve({
      op: "publish_file",
      schemaVersion: 1,
      conversationId: "global-default",
      path: "report.csv",
    });
    expect(published).toMatchObject({
      op: "publish_file",
      file: { filename: "report.csv", mediaType: "text/csv; charset=utf-8", byteCount: expected.length },
    });
    if (published.op !== "publish_file") throw new Error("file was not published");

    const replay = await conversations.serve({
      op: "replay",
      schemaVersion: 1,
      replay: { schemaVersion: 1, conversationId: "global-default", surfaceClientId: "test" },
    });
    expect(replay.op === "replay" && replay.result.status === "page" ? replay.result.events : []).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "file", file: published.file })]),
    );
    await expect(
      conversations.serve({
        op: "publish_file",
        schemaVersion: 1,
        conversationId: "global-default",
        path: "../outside.txt",
      }),
    ).rejects.toThrow("delivered_file_outside_conversation_workspace");

    const clankie = await createClankieApp({
      captain: createStubCaptain(),
      deliveredFiles,
      authenticateCaptain: async (request) =>
        request.headers.get("authorization") === "Bearer captain"
          ? { captainId: "captain", steerSourceLane: "api" }
          : undefined,
    });
    try {
      const body = JSON.stringify({
        schemaVersion: 1,
        conversationId: "global-default",
        artifactId: published.file.artifactId,
      });
      expect(
        (
          await clankie.app.request(OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          })
        ).status,
      ).toBe(401);
      const response = await clankie.app.request(OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH, {
        method: "POST",
        headers: { authorization: "Bearer captain", "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
    } finally {
      clankie.close();
    }
    expect(await readFile(join(workspace, "report.csv"))).toEqual(expected);
  } finally {
    await conversations.close();
  }
});

it("allows dotdot-prefixed filenames and concurrent publication of the same artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-delivered-file-concurrent-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "..notes.txt"), "same bytes");
  const deliveredFiles = new DeliveredFileStore(join(root, "attachments"));

  const input = {
    conversationId: "global-default",
    sourceRoot: workspace,
    path: "..notes.txt",
  } as const;
  const [first, second] = await Promise.all([deliveredFiles.publish(input), deliveredFiles.publish(input)]);

  expect(second).toEqual(first);
  expect((await deliveredFiles.read("global-default", first.artifactId))?.data.toString()).toBe("same bytes");
});
