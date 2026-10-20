import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { IntegrationBatch } from "@clankie/protocol/integrate";
import { IntegrationQueue } from "../src/integrate.ts";

it("refreshes retained integration status on every file generation and keeps returned records private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "integration-record-cache-"));
  try {
    const queue = new IntegrationQueue({ directory, core: directory });
    const id = randomUUID();
    const path = join(directory, "batches", id, "record.json");
    const batch: IntegrationBatch = {
      schemaVersion: 1,
      id,
      request: { action: "run", id, core: ["8bf44b375"], push: false },
      state: "failed",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      evidence: path,
      repos: [],
      error: "first",
    };
    await mkdir(join(directory, "batches", id), { recursive: true });
    await writeFile(path, JSON.stringify(batch));
    expect((await queue.snapshot()).lastResult?.error).toBe("first");
    const returned = await queue.status(id);
    returned.request.core.push("d17b471f8");
    returned.error = "changed by a reader";
    expect(await queue.status(id)).toMatchObject({ error: "first", request: { core: ["8bf44b375"] } });

    // In-place writes can preserve both size and mtime; ctime must invalidate.
    const before = await stat(path);
    await writeFile(path, (await readFile(path, "utf8")).replace("first", "other"));
    await utimes(path, before.atime, before.mtime);
    expect((await queue.snapshot()).lastResult?.error).toBe("other");

    // Atomic replacement is how service transitions are persisted.
    await writeFile(`${path}.next`, JSON.stringify({ ...batch, state: "passed", error: undefined }));
    await rename(`${path}.next`, path);
    expect((await queue.snapshot()).lastResult?.state).toBe("passed");
    await writeFile(path, "{broken");
    await expect(queue.status(id)).rejects.toThrow();
    await writeFile(path, JSON.stringify({ ...batch, state: "cancelled" }));
    expect((await queue.snapshot()).lastResult?.state).toBe("cancelled");
    await rm(path);
    await expect(queue.status(id)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await queue.snapshot()).lastResult).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("projects a cached request from the current shared batch without persisting display state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "integration-shared-cache-"));
  try {
    const queue = new IntegrationQueue({ directory, core: directory });
    const headId = randomUUID();
    const memberId = randomUUID();
    const path = (id: string) => join(directory, "batches", id, "record.json");
    const record = (id: string): IntegrationBatch => ({
      schemaVersion: 1,
      id,
      request: { action: "run", id, core: ["8bf44b375"], push: true },
      state: "queued",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      evidence: path(id),
      repos: [],
    });
    const head = record(headId);
    const member = { ...record(memberId), batchId: headId };
    for (const batch of [head, member]) {
      await mkdir(join(directory, "batches", batch.id), { recursive: true });
      await writeFile(path(batch.id), JSON.stringify(batch));
    }
    expect((await queue.status(memberId)).state).toBe("interrupted");
    expect((await queue.status(memberId)).state).toBe("interrupted");
    expect(JSON.parse(await readFile(path(headId), "utf8")).state).toBe("queued");
    await writeFile(path(headId), JSON.stringify({ ...head, state: "pushed" }));
    expect((await queue.status(memberId)).state).toBe("pushed");
    expect((await queue.snapshot()).lastResult?.id).toBe(headId);
    await writeFile(path(memberId), JSON.stringify({ ...member, state: "cancelled" }));
    expect((await queue.status(memberId)).state).toBe("cancelled");
    expect((await queue.status(headId)).state).toBe("pushed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
