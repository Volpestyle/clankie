// Builds a built-in tracker store at N days of fleet volume from a template store
// (LOCAL-VUH-42). One day is 600 sync commits; the template's own proportions set
// everything else, so issues, comments, events, receipts and audit keep today's mix.
// The template is copied whole, then repeated with every per-item UUID remapped and
// every hash chain rebuilt, so the result opens through the tracker's own validation.
//
//   node generate-store.ts --template COPY_OF_tracker.json --days 60 --out DIR
//
// Never point --template at the live store: copy it first. The output is a legacy
// single-file `tracker.json` (the pre-journal format), written in pieces so it can
// exceed V8's maximum string length.
import { createHash } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import {
  writeCheckpointFile,
  writeSegment,
  startSegment,
  journalLine,
} from "../../../../packages/work-items/src/tracker-journal.ts";
import { parseArgs } from "node:util";

const COMMITS_PER_DAY = 600;
const { values } = parseArgs({
  options: {
    template: { type: "string" },
    days: { type: "string" },
    out: { type: "string" },
    checkpoint: { type: "boolean" },
  },
});
if (!values.template || !values.days || !values.out)
  throw new Error("--template, --days and --out are required");
const days = Number(values.days);
const template = JSON.parse(readFileSync(values.template, "utf8"));
const copies = (days * COMMITS_PER_DAY) / template.syncLog.length;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const chainHash = (entry: object) =>
  createHash("sha256")
    .update(canonical({ ...entry, hash: undefined }))
    .digest("hex");

// Workspace records are shared by every copy; only per-item records repeat.
const shared = new Set<string>([template.team.id, template.user.id, template.storeId].filter(Boolean));
for (const key of [
  "issueStatuses",
  "projectStatuses",
  "labels",
  "projects",
  "actors",
  "milestones",
  "documents",
  "cycles",
])
  for (const entry of template[key] ?? []) shared.add(entry.id);
const PER_ITEM = [
  "issues",
  "comments",
  "statusUpdates",
  "runs",
  "bundles",
  "ownerAsks",
  "events",
  "audit",
  "syncLog",
  "receipts",
];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const remap = (copy: number, uuid: string) => {
  if (copy === 0 || shared.has(uuid)) return uuid;
  const hex = createHash("sha256").update(`${copy}:${uuid}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const out: Record<string, unknown[]> = Object.fromEntries(PER_ITEM.map((key) => [key, []]));
const prefix = template.team.key;
let issueNumber = 0;
for (let copy = 0; copy < Math.ceil(copies); copy++) {
  const fraction = Math.min(1, copies - copy);
  const text = JSON.stringify(Object.fromEntries(PER_ITEM.map((key) => [key, template[key] ?? []])));
  const records = JSON.parse(text.replace(UUID, (uuid) => remap(copy, uuid)));
  for (const key of PER_ITEM) {
    const entries = records[key] as Record<string, unknown>[];
    for (const entry of entries.slice(0, Math.round(entries.length * fraction))) {
      if (key === "issues") entry.identifier = `${prefix}-${++issueNumber}`;
      if (key === "receipts" && copy > 0) entry.idempotencyKey = `${String(entry.idempotencyKey)}#${copy}`;
      out[key].push(entry);
    }
  }
}
// Rebuild each chain in order, exactly as the tracker appends it.
for (const [key, sequence] of [
  ["events", "seq"],
  ["audit", "seq"],
  ["syncLog", "syncId"],
] as const) {
  let previous = "";
  out[key].forEach((entry, index) => {
    const record = entry as Record<string, unknown>;
    record[sequence] = index + 1;
    record.prevHash = previous;
    delete record.hash;
    record.hash = previous = chainHash(record);
  });
}

const store: Record<string, unknown> = {
  ...template,
  ...out,
  nextIssue: issueNumber + 1,
  syncId: out.syncLog.length,
};
mkdirSync(values.out, { recursive: true, mode: 0o700 });
if (values.checkpoint) {
  const history = store.syncLog as { syncId: number; hash: string }[];
  const sealed = await writeSegment(
    values.out,
    1,
    history.map((commit) => journalLine({ syncId: commit.syncId, commit })),
  );
  const head = history.at(-1)!;
  delete store.syncLog;
  delete store.syncBase;
  store.journal = {
    version: 1,
    syncId: head.syncId,
    syncHash: head.hash,
    since: head.syncId,
    sealed: [sealed],
  };
  await startSegment(values.out, head.syncId + 1);
  console.log(
    JSON.stringify({ days, ...(await writeCheckpointFile(store, join(values.out, "tracker.json"))) }),
  );
  process.exit(0);
}
const file = openSync(join(values.out, "tracker.json"), "w", 0o600);
writeSync(file, "{");
Object.entries(store).forEach(([key, value], index) => {
  writeSync(file, `${index ? "," : ""}\n  ${JSON.stringify(key)}: `);
  if (!Array.isArray(value)) return void writeSync(file, JSON.stringify(value));
  writeSync(file, "[");
  value.forEach((entry, at) => writeSync(file, `${at ? "," : ""}${JSON.stringify(entry)}`));
  writeSync(file, "]");
});
writeSync(file, "\n}\n");
fsyncSync(file);
closeSync(file);
console.log(
  JSON.stringify({
    days,
    copies: Number(copies.toFixed(3)),
    counts: Object.fromEntries(PER_ITEM.map((key) => [key, out[key].length])),
  }),
);
