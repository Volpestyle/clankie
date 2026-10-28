import { stat } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { createLocalTracker, readTrackerStoreSnapshot } from "../../../../packages/work-items/src/index.ts";
const directory = process.argv[2]!;
const start = performance.now();
try {
  const tracker = createLocalTracker({ directory });
  const result = (await tracker.call("list_issues", { limit: 1 })) as { issues: { id: string }[] };
  const coldOpenMs = performance.now() - start;
  let writeMs;
  if (process.argv.includes("--write")) {
    const before = performance.now();
    await tracker.call("save_comment", {
      issueId: result.issues[0]!.id,
      body: "fresh-process write beyond old limit",
      idempotencyKey: "vuh49-large-fresh-write",
    });
    writeMs = performance.now() - before;
  }
  let sealMs;
  if (process.argv.includes("--seal")) {
    const before = performance.now();
    await tracker.checkpoint();
    sealMs = performance.now() - before;
  }
  const store = await readTrackerStoreSnapshot(directory);
  console.log(
    JSON.stringify({
      ok: true,
      coldOpenMs,
      writeMs,
      sealMs,
      checkpointBytes: (await stat(join(directory, "tracker.json"))).size,
      syncId: store!.syncId,
      rss: process.memoryUsage().rss,
      load: loadavg(),
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({ ok: false, ms: performance.now() - start, error: String(error), load: loadavg() }),
  );
  process.exitCode = 1;
}
