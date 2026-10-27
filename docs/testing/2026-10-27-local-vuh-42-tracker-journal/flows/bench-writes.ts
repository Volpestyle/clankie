// Times built-in tracker writes on a scratch copy of a store (LOCAL-VUH-42).
//
//   node bench-writes.ts --store DIR_WITH_tracker.json --scratch EMPTY_DIR [--writes 40] [--hire]
//
// Copies the store into --scratch first and never opens --store itself. Each run is
// one process, so the first call is a cold open: parse, validation, chain checks and
// any one-time migration. It then times single `save_issue` updates (one write each:
// lock, load, apply, receipt, audit, sync commit and durable commit) and a burst of
// 17 sequential creates, the 2026-10-03 burst. With --hire, each timed write goes through a
// fresh scoped instance, as production opens one per hired worker's call, and the long-lived
// service instance's next read is timed too. Prints one JSON line.
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLocalTracker } from "../../../../packages/work-items/src/index.ts";

const { values } = parseArgs({
  options: {
    store: { type: "string" },
    scratch: { type: "string" },
    writes: { type: "string" },
    hire: { type: "boolean" },
  },
});
if (!values.store || !values.scratch) throw new Error("--store and --scratch are required");
const scratch = resolve(values.scratch);
if (existsSync(scratch) && readdirSync(scratch).length) throw new Error("--scratch must be empty");
cpSync(resolve(values.store), scratch, { recursive: true });

const tracker = createLocalTracker({ directory: scratch });
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
let start = process.hrtime.bigint();
const listed = (await tracker.call("list_issues", { limit: 1 })) as { issues: { id: string }[] };
const coldOpen = ms(start);
const target = listed.issues[0]!.id;
const writes = Number(values.writes ?? 40);
const single: number[] = [];
const serviceReads: number[] = [];
for (let index = 0; index < writes + 3; index++) {
  const writer = values.hire
    ? createLocalTracker({ directory: scratch, assertIssueWrite: () => {} })
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
    ...(values.hire
      ? { hire: true, serviceReadAfterP50Ms: Number(serviceReads[serviceReads.length >> 1]!.toFixed(1)) }
      : {}),
    files: readdirSync(scratch).sort(),
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
  }),
);
