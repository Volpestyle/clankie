// Times built-in tracker writes on a scratch copy of a store (LOCAL-VUH-42).
//
//   node bench-writes.ts --store DIR_WITH_tracker.json --scratch EMPTY_DIR [--writes 40] [--hire] [--pollers N]
//
// Copies the store into --scratch first and never opens --store itself. Each run is
// one process, so the first call is a cold open: parse, validation, chain checks and
// any one-time migration. It then times single `save_issue` updates (one write each:
// lock, load, apply, receipt, audit, sync commit and durable commit) and a burst of
// 17 sequential creates, the 2026-10-03 burst. With --hire, each timed write goes through a
// fresh scoped instance, as production opens one per hired worker's call, and the long-lived
// service instance's next read is timed too. With --pollers, N `sync` subscribe long-polls wait on
// the store throughout the timed writes, each re-subscribing after every commit it receives, as
// list_changes readers do. Prints one JSON line.
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as work from "../../../../packages/work-items/src/index.ts";

const { values } = parseArgs({
  options: {
    store: { type: "string" },
    scratch: { type: "string" },
    writes: { type: "string" },
    hire: { type: "boolean" },
    pollers: { type: "string" },
  },
});
if (!values.store || !values.scratch) throw new Error("--store and --scratch are required");
const scratch = resolve(values.scratch);
if (existsSync(scratch) && readdirSync(scratch).length) throw new Error("--scratch must be empty");
cpSync(resolve(values.store), scratch, { recursive: true });

const tracker = work.createLocalTracker({ directory: scratch });
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
let start = process.hrtime.bigint();
const listed = (await tracker.call("list_issues", { limit: 1 })) as { issues: { id: string }[] };
const coldOpen = ms(start);
const target = listed.issues[0]!.id;
const abort = new AbortController();
let wakeups = 0;
const storeId = await tracker.storeId();
// Pollers follow the timed issue's sync group, as a list_changes reader of its project would.
// Builds before the journal have only the single file.
const snapshot = (work as { readTrackerStoreSnapshot?: (directory: string) => Promise<unknown> })
  .readTrackerStoreSnapshot;
const raw = (
  values.pollers
    ? snapshot
      ? await snapshot(scratch)
      : JSON.parse(readFileSync(join(scratch, "tracker.json"), "utf8"))
    : undefined
) as Record<string, unknown> | undefined;
const head = (raw?.syncId ?? 0) as number;
const group =
  (raw?.issues as { id: string; projectId?: string }[] | undefined)?.find((issue) => issue.id === target)
    ?.projectId ?? "unprojected";
const pollers = Array.from({ length: Number(values.pollers ?? 0) }, async () => {
  let cursor = head;
  while (!abort.signal.aborted) {
    const page = await tracker
      .sync(
        { action: "subscribe", projects: [group], storeId, lastSyncId: cursor, waitMs: 20_000, limit: 100 },
        undefined,
        abort.signal,
      )
      .catch((error: unknown) => {
        if (abort.signal.aborted) return undefined;
        throw error;
      });
    if (page?.outcome !== "deltas") return;
    wakeups += 1;
    cursor = page.lastSyncId;
  }
});
const writes = Number(values.writes ?? 40);
const single: number[] = [];
const serviceReads: number[] = [];
for (let index = 0; index < writes + 3; index++) {
  const writer = values.hire
    ? work.createLocalTracker({ directory: scratch, assertIssueWrite: () => {} })
    : tracker;
  start = process.hrtime.bigint();
  await writer.call("save_issue", {
    id: target,
    title: `bench write ${index}`,
    idempotencyKey: randomUUID(),
  });
  // The first writes warm the JIT and any post-open state; they are not reported.
  if (index >= 3) single.push(ms(start));
  if (!values.hire) continue;
  start = process.hrtime.bigint();
  await tracker.call("list_issues", { limit: 1 });
  if (index >= 3) serviceReads.push(ms(start));
}
abort.abort();
await Promise.all(pollers);
start = process.hrtime.bigint();
for (let index = 0; index < 17; index++)
  await tracker.call("save_issue", { title: `burst ${index}`, team: "VUH", idempotencyKey: randomUUID() });
const burst = ms(start);
single.sort((a, b) => a - b);
serviceReads.sort((a, b) => a - b);
const quantile = (q: number) =>
  Number(single[Math.min(single.length - 1, Math.ceil(q * single.length) - 1)]!.toFixed(1));
console.log(
  JSON.stringify({
    store: values.store,
    coldOpenMs: Number(coldOpen.toFixed(1)),
    writes: single.length,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    maxMs: quantile(1),
    burst17Ms: Number(burst.toFixed(1)),
    ...(values.pollers ? { pollers: Number(values.pollers), pollerWakeups: wakeups } : {}),
    ...(values.hire
      ? { hire: true, serviceReadAfterP50Ms: Number(serviceReads[serviceReads.length >> 1]!.toFixed(1)) }
      : {}),
    files: readdirSync(scratch).sort(),
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
  }),
);
