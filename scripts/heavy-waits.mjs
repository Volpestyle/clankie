#!/usr/bin/env node
// Wait times of `clankie heavy` permits from the job log (#599), by lane:
// count, median, p95 and max, so a scheduler change can be compared with the
// window before it. Read-only.
//   node scripts/heavy-waits.mjs [--dir DIR] [--since ISO|--hours N] [--until ISO] [--json]
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const dir = flag("--dir") ?? join(userInfo().homedir, ".clankie", "fleet-resources");
const hours = flag("--hours");
const since = hours ? Date.now() - Number(hours) * 3_600_000 : Date.parse(flag("--since") ?? "1970-01-01");
const until = Date.parse(flag("--until") ?? "9999-01-01");
if (!Number.isFinite(since) || !Number.isFinite(until)) {
  console.error("Usage: heavy-waits.mjs [--dir DIR] [--since ISO|--hours N] [--until ISO] [--json]");
  process.exit(2);
}

const admitted = [];
for (const file of ["leases.jsonl.1", "leases.jsonl"]) {
  let text = "";
  try {
    text = readFileSync(join(dir, file), "utf8");
  } catch {
    continue;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (
        record.event === "admitted" &&
        typeof record.waitedMs === "number" &&
        record.atMs >= since &&
        record.atMs < until
      )
        admitted.push(record);
    } catch {
      // A torn final line from a concurrent writer is skipped.
    }
  }
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
const stats = (records) => {
  const waits = records.map((record) => record.waitedMs).sort((a, b) => a - b);
  return waits.length === 0
    ? { count: 0 }
    : {
        count: waits.length,
        medianS: quantile(waits, 0.5) / 1000,
        p95S: quantile(waits, 0.95) / 1000,
        maxS: waits.at(-1) / 1000,
      };
};
const lanes = [...new Set(admitted.map((record) => record.lane))].sort();
const span = admitted.length
  ? {
      from: new Date(Math.min(...admitted.map((r) => r.atMs))).toISOString(),
      to: new Date(Math.max(...admitted.map((r) => r.atMs))).toISOString(),
    }
  : undefined;
const report = {
  dir,
  ...(span ? { span } : {}),
  all: stats(admitted),
  lanes: Object.fromEntries(
    lanes.map((lane) => [lane, stats(admitted.filter((record) => record.lane === lane))]),
  ),
};
if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`${dir}${span ? ` ${span.from} → ${span.to}` : " (no admitted permits in range)"}`);
  for (const [name, value] of [["all", report.all], ...Object.entries(report.lanes)])
    console.log(
      value.count
        ? `${name.padEnd(7)} n=${value.count} median=${value.medianS.toFixed(1)}s p95=${value.p95S.toFixed(1)}s max=${value.maxS.toFixed(1)}s`
        : `${name.padEnd(7)} n=0`,
    );
}
