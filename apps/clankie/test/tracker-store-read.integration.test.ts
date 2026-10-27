import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createLocalTracker } from "@clankie/work-items";

it("keeps repeated tracker reads fresh across process writes and refuses same-size corrupted history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tracker-read-boundary-"));
  try {
    const tracker = createLocalTracker({ directory });
    const issue = (await tracker.call("save_issue", { team: "LOCAL", title: "Original" })) as {
      id: string;
    };
    const read = () => tracker.call("get_issue", { id: issue.id });
    const original = await read();
    expect(await read()).toEqual(original);
    (original as { title: string }).title = "Caller mutation";
    expect(await read()).toMatchObject({ title: "Original" });

    const child = join(directory, "writer.mjs");
    await writeFile(
      child,
      `const { createLocalTracker } = await import(process.argv[2]);
const tracker = createLocalTracker({ directory: process.argv[3] });
await tracker.call("save_issue", { id: process.argv[4], title: "External" });
`,
    );
    await promisify(execFile)(process.execPath, [
      "--import",
      import.meta.resolve("tsx/esm"),
      child,
      new URL("../../../packages/work-items/src/tracker-local.ts", import.meta.url).href,
      directory,
      issue.id,
    ]);
    expect(await read()).toMatchObject({ title: "External" });
    const events: unknown[] = [];
    const unsubscribe = await tracker.subscribe((event) => events.push(event));
    unsubscribe();
    expect(events.length).toBeGreaterThan(0);

    const path = join(directory, "tracker.json");
    const valid = await readFile(path, "utf8");
    const before = await stat(path);
    const corrupt = valid.replace(
      /"hash": "([a-f0-9])/u,
      (prefix, digit: string) => prefix.slice(0, -1) + (digit === "0" ? "1" : "0"),
    );
    expect(corrupt).not.toBe(valid);
    expect(Buffer.byteLength(corrupt)).toBe(Buffer.byteLength(valid));
    await writeFile(path, corrupt);
    await utimes(path, before.atime, before.mtime);
    await expect(read()).rejects.toThrow(/not intact/u);
    await expect(tracker.storeId()).rejects.toThrow(/not intact/u);
    await expect(tracker.subscribe(() => undefined)).rejects.toThrow(/not intact/u);
    await expect(tracker.call("save_issue", { id: issue.id, title: "Forbidden" })).rejects.toThrow(
      /not intact/u,
    );
    expect(await readFile(path, "utf8")).toBe(corrupt);
    await writeFile(path, valid);
    expect(await read()).toMatchObject({ title: "External" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// VUH-2379: the service re-read its 10 MB store about twice a second, and each
// read's buffer pushed V8 into a full collection of its whole heap.
it("answers repeated reads of an unchanged store without loading it again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tracker-read-unchanged-"));
  try {
    const tracker = createLocalTracker({ directory });
    for (let index = 0; index < 4; index++)
      await tracker.call("save_issue", {
        team: "LOCAL",
        title: `Bulk ${index}`,
        description: "x".repeat(1 << 20),
      });
    // A store this size keeps its writes in a journal beside the checkpoint (LOCAL-VUH-42).
    const journal = join(directory, "tracker.journal");
    let storeBytes = (await stat(join(directory, "tracker.json"))).size;
    for (const name of await readdir(journal).catch(() => []))
      storeBytes += (await stat(join(journal, name))).size;
    expect(storeBytes).toBeGreaterThan(4 << 20);
    await tracker.storeId();

    // A read buffer stays allocated until the next collection, so a reload
    // shows here as growth of about the store's size.
    const baseline = process.memoryUsage().arrayBuffers;
    let growth = 0;
    for (let read = 0; read < 20; read++) {
      await tracker.storeId();
      growth = Math.max(growth, process.memoryUsage().arrayBuffers - baseline);
    }
    expect(growth).toBeLessThan(storeBytes / 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
