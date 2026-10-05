// Bounded unrelated ordinary processes. No agents, sockets, credentials or live services.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [journal] = process.argv.slice(2);
const children = new Set();
const records = [];
let interval;
let limit;
let started;
let stopping = false;
let sequence = 0;
function finish() {
  if (!stopping || children.size !== 0) return;
  writeFileSync(
    journal,
    JSON.stringify(
      {
        pid: process.pid,
        command: "/usr/bin/true",
        rate: 20,
        maxInFlight: 4,
        started,
        ended: Date.now(),
        records,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(JSON.stringify({ stopped: true, records: records.length }) + "\n", () =>
    process.exit(0),
  );
}
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  clearTimeout(limit);
  for (const child of children) child.kill();
  finish();
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.stop) {
    stop();
    return;
  }
  if (
    started ||
    stopping ||
    !Number.isInteger(message.durationMs) ||
    message.durationMs < 60_000 ||
    message.durationMs > 360_000
  )
    throw new Error("Invalid bounded churn request");
  started = Date.now();
  interval = setInterval(() => {
    if (children.size >= 4) return;
    const record = { id: ++sequence, requestedAt: Date.now() };
    records.push(record);
    const child = spawn("/usr/bin/true", [], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
    children.add(child);
    child.once("spawn", () => Object.assign(record, { pid: child.pid, startedAt: Date.now() }));
    child.once("error", (error) => Object.assign(record, { error: error.code ?? error.name }));
    child.once("close", (code, signal) => {
      Object.assign(record, { code, signal, closedAt: Date.now() });
      children.delete(child);
      finish();
    });
  }, 50);
  limit = setTimeout(stop, message.durationMs);
  process.stdout.write(JSON.stringify({ started: true, pid: process.pid, rate: 20 }) + "\n");
});
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + "\n");
