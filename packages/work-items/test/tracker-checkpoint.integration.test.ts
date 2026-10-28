import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  createLocalTracker,
  readTrackerStoreRecords,
  readTrackerStoreSnapshot,
} from "../src/tracker-local.ts";
import {
  readCheckpointBytes,
  readCheckpointFile,
  STREAM_CHECKPOINT_BYTES,
} from "../src/tracker-checkpoint.ts";
import { writeCheckpointFile } from "../src/tracker-journal.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10 });
});
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "tracker-stream-"));
  roots.push(root);
  return root;
}

it("opens and writes a streamed checkpoint in a fresh process and keeps all records through sealing", async () => {
  const directory = await scratch();
  const tracker = createLocalTracker({ directory });
  const issue = (await tracker.call("save_issue", { team: "LOCAL", title: "streamed" })) as { id: string };
  const body = 'é 😺 \\"\n[]{}:,'.repeat(19000);
  for (let i = 0; i < 32; i++) await tracker.call("save_comment", { issueId: issue.id, body: body + i });
  await tracker.checkpoint();
  const file = join(directory, "tracker.json");
  const before = await readCheckpointFile(file);
  expect(before.bytes).toBeGreaterThan(STREAM_CHECKPOINT_BYTES);
  const original = JSON.parse(await readFile(file, "utf8"));
  expect(before.value).toEqual(original);
  expect(before.digest).toBe(
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  );
  const source = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const {createLocalTracker,readTrackerStoreSnapshot}=await import(${JSON.stringify(source)});
    const tracker=createLocalTracker({directory:${JSON.stringify(directory)}});
    await tracker.call("save_comment",{issueId:${JSON.stringify(issue.id)},body:"fresh process",idempotencyKey:"stream-fresh-process"});
    await tracker.checkpoint();
    const store=await readTrackerStoreSnapshot(${JSON.stringify(directory)});
    console.log(JSON.stringify({comments:store.comments.length,body:store.comments.at(-1).body}));
  `,
    ],
    { timeout: 20000 },
  );
  expect(JSON.parse(stdout)).toEqual({ comments: 33, body: "fresh process" });
  const reopened = await readTrackerStoreSnapshot(directory);
  expect(reopened!.comments).toHaveLength(33);
  expect((await readTrackerStoreRecords(directory))!.comments).toEqual(reopened!.comments);
  expect((reopened!.comments as { body: string }[])[0]!.body).toBe(body + "0");
}, 30000);

it("keeps JSON grammar and unknown-field semantics across chunks, refusing damage before a write", async () => {
  const directory = await scratch();
  const tracker = createLocalTracker({ directory });
  await tracker.call("save_issue", { team: "LOCAL", title: "syntax" });
  // This remains a real single-file store; unknown fields exercise nested arrays, scalars,
  // duplicate keys and __proto__ without changing any event/audit/sync hash.
  const file = join(directory, "tracker.json");
  const original = JSON.parse(await readFile(file, "utf8"));
  const padding = "x".repeat(STREAM_CHECKPOINT_BYTES);
  const prefix = JSON.stringify({
    ...original,
    padding: [padding],
    nested: { x: [null, true, false, 1.2e-3, 'escaped \\" 😺'] },
  }).slice(0, -1);
  const valid = prefix + ',"duplicate":1,"duplicate":2,"__proto__":{"safe":true}}';
  await writeFile(file, valid);
  expect((await readCheckpointFile(file)).value).toEqual(JSON.parse(valid));
  expect((await readCheckpointBytes(Buffer.from(valid))).value).toEqual(JSON.parse(valid));
  for (const damaged of [
    valid + "false",
    valid.slice(0, -1),
    prefix + ",}",
    prefix + ',"bad":[1,]}',
    prefix + ',"bad":tru}',
    prefix + ',"bad":{"x":1,}}',
  ]) {
    await writeFile(file, damaged);
    await expect(
      createLocalTracker({ directory }).call("save_issue", { team: "LOCAL", title: "must refuse" }),
    ).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(damaged);
  }
  // Syntax can be valid while the store is damaged: streaming must keep chain validation.
  const broken = JSON.parse(valid);
  broken.audit[0].hash = "wrong";
  await writeCheckpointFile(broken, file + ".next");
  await writeFile(file, await readFile(file + ".next"));
  await expect(readTrackerStoreSnapshot(directory)).rejects.toThrow("audit log is not intact");
}, 30000);
