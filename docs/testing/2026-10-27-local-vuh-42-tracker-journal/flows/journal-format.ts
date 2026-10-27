// Compares the two journal formats LOCAL-VUH-42 considered, on real journal records.
//
//   node journal-format.ts --segment SEGMENT.jsonl --scratch EMPTY_DIR [--commits 500]
//
// --segment is a journal segment from a migrated scratch copy (its lines are the payloads).
// For each format, every commit appends one record and makes it durable, as a tracker commit
// does: JSONL writes the line at the known end and fsyncs; node:sqlite inserts one row in WAL
// mode with synchronous=FULL. On macOS Node's fsync is F_FULLFSYNC (a disk cache flush), and
// SQLite's matches it only with fullfsync on, so SQLite runs both ways; without it a commit
// survives a process crash but not a power loss. Then each reads every record back in order,
// as an open replays a tail. Prints one JSON line.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { segment: { type: "string" }, scratch: { type: "string" }, commits: { type: "string" } },
});
if (!values.segment || !values.scratch) throw new Error("--segment and --scratch are required");
const scratch = resolve(values.scratch);
if (existsSync(scratch) && readdirSync(scratch).length) throw new Error("--scratch must be empty");
mkdirSync(scratch, { recursive: true });
const lines = readFileSync(values.segment, "utf8").split("\n").filter(Boolean);
const commits = Number(values.commits ?? 500);
const payload = (index: number) => `${lines[index % lines.length]!}\n`;
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
const summary = (times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number) =>
    Number(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!.toFixed(2));
  return { p50Ms: at(0.5), p95Ms: at(0.95) };
};

const jsonlPath = join(scratch, "segment.jsonl");
closeSync(openSync(jsonlPath, "wx", 0o600));
const jsonl: number[] = [];
let size = 0;
for (let index = 0; index < commits; index++) {
  const start = process.hrtime.bigint();
  const handle = openSync(jsonlPath, "r+");
  const bytes = Buffer.from(payload(index));
  writeSync(handle, bytes, 0, bytes.length, size);
  fsyncSync(handle);
  closeSync(handle);
  size += bytes.length;
  jsonl.push(ms(start));
}
const start = process.hrtime.bigint();
const replayed = readFileSync(jsonlPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as unknown);
const jsonlReplayMs = ms(start);

function sqliteRun(name: string, pragmas: string) {
  const database = new DatabaseSync(join(scratch, `${name}.sqlite`));
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; ${pragmas}`);
  database.exec("CREATE TABLE journal (sync_id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
  const insert = database.prepare("INSERT INTO journal (sync_id, record) VALUES (?, ?)");
  const times: number[] = [];
  for (let index = 0; index < commits; index++) {
    const begin = process.hrtime.bigint();
    insert.run(index + 1, payload(index));
    times.push(ms(begin));
  }
  const begin = process.hrtime.bigint();
  const rows = database
    .prepare("SELECT record FROM journal ORDER BY sync_id")
    .all()
    .map((row) => JSON.parse(row.record as string) as unknown);
  const replayMs = ms(begin);
  database.close();
  const bytes = readdirSync(scratch)
    .filter((file) => file.startsWith(`${name}.sqlite`))
    .reduce((total, file) => total + statSync(join(scratch, file)).size, 0);
  return { ...summary(times), replayMs: Number(replayMs.toFixed(1)), bytes, records: rows.length };
}

console.log(
  JSON.stringify({
    commits,
    meanRecordBytes: Math.round(size / commits),
    jsonl: {
      ...summary(jsonl),
      replayMs: Number(jsonlReplayMs.toFixed(1)),
      bytes: size,
      records: replayed.length,
    },
    sqliteFullfsync: sqliteRun("full", "PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;"),
    sqliteFsync: sqliteRun("plain", ""),
  }),
);
