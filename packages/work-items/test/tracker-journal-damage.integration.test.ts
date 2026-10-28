import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { appendJournal, JOURNAL_DIRECTORY, TORN_TAIL_LIMIT_BYTES } from "../src/tracker-journal.ts";
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

// LOCAL-VUH-47 review: a rollback to a journal build from before framing (f59461d17) appends
// unframed lines after framed ones. They are records, not damage.
it("keeps unframed records a rolled-back build appended after framed ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tracker-journal-rollback-"));
  roots.push(directory);
  const tracker = createLocalTracker({ directory });
  for (let index = 0; !existsSync(join(directory, JOURNAL_DIRECTORY)); index++)
    await tracker.call("save_issue", {
      team: "LOCAL",
      title: `large ${String(index)}`,
      description: "x".repeat(300 * 1024),
    });
  for (const title of ["framed 0", "framed 1", "older build 0", "older build 1"])
    await tracker.call("save_issue", { team: "LOCAL", title });
  const committed = await opened(directory);
  const names = (await readdir(join(directory, JOURNAL_DIRECTORY))).filter((name) => name.endsWith(".jsonl"));
  const live = join(directory, JOURNAL_DIRECTORY, names.sort().at(-1)!);

  // The last two records as the older build's appendCommit wrote them: JSON.stringify(record).
  const lines = (await readFile(live, "utf8")).split("\n");
  for (const at of [lines.length - 3, lines.length - 2]) {
    const { length, ...record } = JSON.parse(lines[at]!) as Record<string, unknown>;
    expect(typeof length).toBe("number");
    lines[at] = JSON.stringify(record);
  }
  expect(lines.at(-4)).toMatch(/^\{"syncId":\d+,"length":/u);
  await writeFile(live, lines.join("\n"));
  expect(await opened(directory)).toEqual(committed);

  // The next framed append, from another process, keeps them.
  await inChild(
    directory,
    `await createLocalTracker({ directory }).call("save_issue", { team: "LOCAL", title: "after rollback" });`,
  );
  const after = await opened(directory);
  expect(after.titles).toEqual([...committed.titles, "after rollback"].sort());
  expect(after.syncId).toBe(committed.syncId + 1);

  // An unframed final line that does not parse is still an unacknowledged tail.
  await writeFile(
    live,
    `${await readFile(live, "utf8")}{"syncId":${String(after.syncId + 1)},"commit":\0\0\0\n`,
  );
  expect(await opened(directory)).toEqual(after);
}, 120_000);

/** A store already on the journal, and its live segment. */
async function journalStore(prefix: string): Promise<{ directory: string; live: string }> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  roots.push(directory);
  const tracker = createLocalTracker({ directory });
  for (let index = 0; !existsSync(join(directory, JOURNAL_DIRECTORY)); index++)
    await tracker.call("save_issue", {
      team: "LOCAL",
      title: `large ${String(index)}`,
      description: "x".repeat(300 * 1024),
    });
  await tracker.call("save_issue", { team: "LOCAL", title: "kept" });
  const names = (await readdir(join(directory, JOURNAL_DIRECTORY))).filter((name) => name.endsWith(".jsonl"));
  return { directory, live: join(directory, JOURNAL_DIRECTORY, names.sort().at(-1)!) };
}
const saveInChild = (directory: string, title: string) =>
  inChild(
    directory,
    `await createLocalTracker({ directory }).call("save_issue", { team: "LOCAL", title: ${JSON.stringify(title)} });`,
  );
/** The line as a journal build from before framing wrote it. */
const unframed = (line: string) => {
  const { length, ...record } = JSON.parse(line) as Record<string, unknown>;
  expect(typeof length).toBe("number");
  return JSON.stringify(record);
};

// LOCAL-VUH-54: an append from a stale base must not cut another writer's acknowledged record
// as if it were a torn tail. The tracker's own generation guard is bypassed by calling
// appendJournal with the base's size, as the rejected LOCAL-VUH-51 head did.
it("refuses to cut a whole record past a stale base's size and keeps it across a fresh open", async () => {
  const { directory, live } = await journalStore("tracker-journal-stale-base-");
  const stale = { name: live.split("/").at(-1)!, size: (await stat(live)).size };
  // The stale writer's own next record: a copy of the store commits from the same base.
  const fork = await mkdtemp(join(tmpdir(), "tracker-journal-stale-fork-"));
  roots.push(fork);
  await cp(directory, fork, { recursive: true });
  await saveInChild(fork, "Local");
  const line = (await readFile(join(fork, JOURNAL_DIRECTORY, stale.name))).subarray(stale.size).toString();
  expect(line).toMatch(/^\{"syncId":\d+,"length":\d+,.*\n$/su);

  await saveInChild(directory, "ExternalX"); // acknowledged by another process
  const committed = await opened(directory);
  expect(committed.titles).toContain("ExternalX");
  const original = await readFile(live);
  const external = original.subarray(stale.size).toString();
  const tails: Record<string, string> = {
    framed: external,
    unframed: `${unframed(external.slice(0, -1))}\n`,
    "after damage": `{"syncId":\0\0\0\n${external}`,
  };
  for (const [kind, tail] of Object.entries(tails)) {
    const bytes = Buffer.concat([original.subarray(0, stale.size), Buffer.from(tail)]);
    await writeFile(live, bytes);
    await expect(
      appendJournal(directory, stale, line, () => {}),
      kind,
    ).rejects.toThrow(/holds a record this backend has not read/u);
    expect((await readFile(live)).equals(bytes), kind).toBe(true);
    if (kind !== "after damage") expect(await opened(directory), kind).toEqual(committed);
  }

  // An unexpected tail too large to be one interrupted append is refused unread.
  await writeFile(live, original);
  await truncate(live, stale.size + TORN_TAIL_LIMIT_BYTES + 1);
  await expect(appendJournal(directory, stale, line, () => {})).rejects.toThrow(/refusing to cut them/u);
  expect((await stat(live)).size).toBe(stale.size + TORN_TAIL_LIMIT_BYTES + 1);
  await writeFile(live, original);
  expect(await opened(directory)).toEqual(committed);
}, 120_000);

it("still cuts torn final lines, framed or unframed, including after a rollback", async () => {
  const { directory, live } = await journalStore("tracker-journal-torn-tails-");
  const next = async () => {
    const lines = (await readFile(live, "utf8")).split("\n").filter(Boolean);
    return lines
      .at(-1)!
      .replace(/^\{"syncId":(\d+),/u, (_, id: string) => `{"syncId":${String(Number(id) + 1)},`);
  };
  const tails: Record<string, (line: string) => string> = {
    // Interrupted framed append: a prefix of the line, no newline.
    "framed prefix": (line) => line.slice(0, Math.floor(line.length / 2)),
    // A newline before the stated length: it parses, but its frame does not match.
    "framed length mismatch": (line) =>
      `${line.replace(/"length":(\d+),/u, (_, length: string) => `"length":${String(Number(length) + 1)},`)}\n`,
    // An older build's whole record that never got its newline.
    "unframed without newline": (line) => unframed(line),
  };
  // The mixed rollback case: an older build appended unframed lines, then a framed append tore.
  const rollback = async () => {
    const lines = (await readFile(live, "utf8")).split("\n");
    for (const at of [lines.length - 3, lines.length - 2]) lines[at] = unframed(lines[at]!);
    await writeFile(live, lines.join("\n"));
  };
  for (const kind of [...Object.keys(tails), "framed after unframed"]) {
    if (kind === "framed after unframed") {
      await saveInChild(directory, "older build");
      await rollback();
    }
    const before = await opened(directory);
    const tail = (tails[kind] ?? tails["framed prefix"]!)(await next());
    await writeFile(live, `${await readFile(live, "utf8")}${tail}`);
    expect(await opened(directory), kind).toEqual(before);
    await saveInChild(directory, `after ${kind}`);
    for (const line of (await readFile(live, "utf8")).split("\n").filter(Boolean))
      expect(() => JSON.parse(line), kind).not.toThrow();
    const after = await opened(directory);
    expect(after.titles, kind).toEqual([...before.titles, `after ${kind}`].sort());
    expect(after.syncId, kind).toBe(before.syncId + 1);
  }
  // Both rollback records survived the repair.
  const lines = (await readFile(live, "utf8")).split("\n").filter(Boolean);
  expect(lines.filter((line) => !/^\{"syncId":\d+,"length":/u.test(line))).toHaveLength(2);
}, 120_000);
