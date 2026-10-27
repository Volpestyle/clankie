// Moves a scratch copy of a single-file store onto the journal and proves nothing was lost
// (LOCAL-VUH-42).
//
//   node migrate-store.ts --store DIR_WITH_tracker.json --scratch EMPTY_DIR
//
// Copies the store into --scratch first and never opens --store itself. Times the host's
// start-up checkpoint, which performs the move. It then compares, against the original file:
// every top-level record collection and field the checkpoint plus journal tail now hold, and
// every sync commit in the sealed history segment. Prints one JSON line; `lost` must be empty.
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLocalTracker, readTrackerStoreSnapshot } from "../../../../packages/work-items/src/index.ts";

const { values } = parseArgs({ options: { store: { type: "string" }, scratch: { type: "string" } } });
if (!values.store || !values.scratch) throw new Error("--store and --scratch are required");
const scratch = resolve(values.scratch);
if (existsSync(scratch) && readdirSync(scratch).length) throw new Error("--scratch must be empty");
cpSync(resolve(values.store), scratch, { recursive: true });
const original = JSON.parse(readFileSync(join(scratch, "tracker.json"), "utf8")) as Record<string, unknown>;
const originalBytes = statSync(join(scratch, "tracker.json")).size;

const start = process.hrtime.bigint();
await createLocalTracker({ directory: scratch }).checkpoint();
const migrateMs = Number(process.hrtime.bigint() - start) / 1e6;
const migrateRssMb = Math.round(process.memoryUsage().rss / 1e6);

const migrated = (await readTrackerStoreSnapshot(scratch)) as Record<string, unknown>;
const lost: string[] = [];
for (const key of Object.keys(original)) {
  if (key === "syncLog") continue;
  if (JSON.stringify(migrated[key]) !== JSON.stringify(original[key])) lost.push(key);
}
const journal = join(scratch, "tracker.journal");
const segments = readdirSync(journal).sort();
const history = readFileSync(join(journal, segments[0]!), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => (JSON.parse(line) as { commit: unknown }).commit);
if (JSON.stringify(history) !== JSON.stringify(original.syncLog ?? [])) lost.push("syncLog");
const checkpoint = JSON.parse(readFileSync(join(scratch, "tracker.json"), "utf8")) as Record<string, unknown>;
const count = (key: string) => (Array.isArray(original[key]) ? (original[key] as unknown[]).length : 0);
console.log(
  JSON.stringify({
    store: values.store,
    originalMb: Number((originalBytes / 1e6).toFixed(1)),
    checkpointMb: Number((statSync(join(scratch, "tracker.json")).size / 1e6).toFixed(1)),
    historyMb: Number((statSync(join(journal, segments[0]!)).size / 1e6).toFixed(1)),
    migrateMs: Math.round(migrateMs),
    migrateRssMb,
    checked: {
      issues: count("issues"),
      comments: count("comments"),
      events: count("events"),
      audit: count("audit"),
      receipts: count("receipts"),
      syncCommits: history.length,
    },
    checkpointHasSyncLog: "syncLog" in checkpoint,
    backup: readdirSync(scratch).filter((name) => name.startsWith("tracker.pre-journal-")),
    lost,
  }),
);
