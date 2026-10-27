import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { JOURNAL_DIRECTORY } from "../src/tracker-journal.ts";
import { createLocalTracker } from "../src/tracker-local.ts";

// LOCAL-VUH-47: each journal line names its length. A power cut can persist an unacknowledged
// final line's length and newline but not all of its pages; an open skips that line, and still
// refuses the same damage anywhere else. Real store on disk, fresh processes.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

const source = fileURLToPath(new URL("../src/index.ts", import.meta.url));
/** Runs a script in a fresh Node process: no in-memory store, every record proven again. */
async function inChild(directory: string, body: string): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `const { createLocalTracker, readTrackerStoreSnapshot } = await import(${JSON.stringify(source)});
     const directory = ${JSON.stringify(directory)};
     ${body}`,
  ]);
  return stdout;
}
const opened = async (directory: string) =>
  JSON.parse(
    await inChild(
      directory,
      `const tracker = createLocalTracker({ directory });
       await tracker.storeId();
       const store = await readTrackerStoreSnapshot(directory);
       process.stdout.write(JSON.stringify({ titles: store.issues.map((issue) => issue.title).sort(), syncId: store.syncId }));`,
    ),
  ) as { titles: string[]; syncId: number };

/** A page a power cut never wrote, newline included, over a line's bytes: its length is unchanged. */
function unwritten(line: Buffer): Buffer {
  const damaged = Buffer.from(line);
  damaged.fill(0, 40, damaged.length - 1);
  damaged[Math.floor(damaged.length / 2)] = 0x0a;
  return damaged;
}

it("skips a final journal line with its full length but unwritten bytes, and refuses one before it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tracker-journal-damage-"));
  roots.push(directory);
  const tracker = createLocalTracker({ directory });
  for (let index = 0; !existsSync(join(directory, JOURNAL_DIRECTORY)); index++)
    await tracker.call("save_issue", {
      team: "LOCAL",
      title: `large ${String(index)}`,
      description: "x".repeat(300 * 1024),
    });
  for (let index = 0; index < 3; index++)
    await tracker.call("save_issue", { team: "LOCAL", title: `kept ${String(index)}` });
  const committed = await opened(directory);
  const names = (await readdir(join(directory, JOURNAL_DIRECTORY))).filter((name) => name.endsWith(".jsonl"));
  const live = join(directory, JOURNAL_DIRECTORY, names.sort().at(-1)!);
  const original = await readFile(live);
  const end = original.lastIndexOf(0x0a, original.length - 2) + 1;
  const final = original.subarray(end);
  expect(final.toString()).toMatch(/^\{"syncId":\d+,"length":\d+,/u);

  // The unacknowledged final record is left out, in a fresh process.
  await writeFile(live, Buffer.concat([original.subarray(0, end), unwritten(final)]));
  expect((await readFile(live)).length).toBe(original.length);
  const skipped = await opened(directory);
  expect(skipped.syncId).toBe(committed.syncId - 1);
  expect(skipped.titles).toEqual(committed.titles.filter((title) => title !== "kept 2"));

  // The process that acknowledged it refuses to lose it rather than skip it.
  await expect(tracker.storeId()).rejects.toThrow(/not intact/u);

  // The next commit, from another process, cuts it off; every line is a record again.
  await inChild(
    directory,
    `await createLocalTracker({ directory }).call("save_issue", { team: "LOCAL", title: "after damage" });`,
  );
  const after = await readFile(live, "utf8");
  for (const line of after.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  expect((await opened(directory)).titles).toEqual([...skipped.titles, "after damage"].sort());

  // The same damage to a record before the last is refused.
  const bytes = await readFile(live);
  const last = bytes.lastIndexOf(0x0a, bytes.length - 2) + 1;
  const previous = bytes.lastIndexOf(0x0a, last - 2) + 1;
  await writeFile(
    live,
    Buffer.concat([
      bytes.subarray(0, previous),
      unwritten(bytes.subarray(previous, last)),
      bytes.subarray(last),
    ]),
  );
  await expect(opened(directory)).rejects.toThrow(/torn before its end|not intact/u);
}, 120_000);
