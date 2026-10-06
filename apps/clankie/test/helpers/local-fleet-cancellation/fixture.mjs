// Scripted native observation replies over the real production child transport.
// These records test cancellation and schema boundaries, not kernel membership.
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const log = (record) =>
  appendFileSync(join(root, "journal.jsonl"), JSON.stringify({ ...record, pid: process.pid }) + "\n");
log({ kind: "start" });
const birth = ["1791190000", "123456"];
const snapshot = {
  schemaVersion: 1,
  owner: { pid: 55, uid: process.getuid(), birth, socket: "1:2:3" },
  ancestors: [
    { pid: 55, ppid: 33, birth },
    { pid: 33, ppid: 1, birth },
  ],
};
for await (const line of createInterface({ input: process.stdin })) {
  const [rawId, mode] = line.split(" ");
  const id = Number(rawId);
  const proof = /^\d+$/u.test(mode);
  log({ kind: "request", mode: proof ? "proof" : mode });
  if (mode === "hold" || (proof && existsSync(join(root, "hold-proofs")))) {
    while (!existsSync(join(root, "release"))) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const result = proof ? snapshot : { pid: process.pid, mode };
  process.stdout.write(JSON.stringify({ id, ok: true, result, stderr: "" }) + "\n");
}
