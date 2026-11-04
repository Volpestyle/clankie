// Portable Windows-relay protocol fixture. It executes no PowerShell and makes
// no SSH connection; native proof facts come from the checked-in PC golden.
import { createConnection, createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
const [returnPort, goldenPath, repeatDelay, proofDelay] = process.argv.slice(2);
const golden = await readFile(goldenPath, "utf8");
const frame = (kind, id, bytes) => {
  const data = Buffer.alloc(9 + bytes.length);
  data[0] = kind;
  data.writeUInt32LE(id, 1);
  data.writeUInt32LE(bytes.length, 5);
  bytes.copy(data, 9);
  process.stdout.write(data);
};
const listener = createServer((socket) => socket.destroy());
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const nonce = randomBytes(32);
frame(5, 0, nonce);
const control = createConnection({ host: "127.0.0.1", port: Number(returnPort) });
await new Promise((resolve) => control.once("connect", resolve));
control.write(nonce);
const ports = Buffer.alloc(4);
ports.writeUInt32LE(listener.address().port);
frame(0, 0, ports);
let released = false,
  release;
const gate = new Promise((resolve) => {
  release = resolve;
});
process.on("message", (message) => {
  if (message === "release") {
    released = true;
    release();
  }
});
const counts = new Map();
const queue = [];
let running = false,
  buffer = Buffer.alloc(0);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    const queueMs = performance.now() - job.enqueued;
    const start = performance.now();
    const load = /fixture-load:(\d+)/u.exec(job.script)?.[1];
    const run = (counts.get(load) ?? 0) + 1;
    if (load !== undefined) {
      counts.set(load, run);
      if (run === 1 && !released) await gate;
      if (run > 1) await pause(Number(repeatDelay));
    } else await pause(Number(proofDelay));
    const executionMs = performance.now() - start;
    const timing = Buffer.alloc(17);
    timing.writeDoubleLE(queueMs, 0);
    timing.writeDoubleLE(executionMs, 8);
    timing[16] = 1;
    frame(6, job.id, timing);
    frame(4, job.id, Buffer.from(load === undefined ? golden : "load complete"));
    process.send?.({
      id: job.id,
      kind: load === undefined ? "proof" : "load",
      load,
      run,
      queueMs,
      executionMs,
    });
  }
  running = false;
}
control.on("data", (data) => {
  buffer = Buffer.concat([buffer, data]);
  while (buffer.length >= 9) {
    const kind = buffer[0],
      id = buffer.readUInt32LE(1),
      size = buffer.readUInt32LE(5);
    if (size > 65536 || kind !== 4) throw Error("Unexpected fixture frame");
    if (buffer.length < 9 + size) return;
    queue.push({ id, script: buffer.subarray(9, 9 + size).toString("utf8"), enqueued: performance.now() });
    buffer = buffer.subarray(9 + size);
  }
  void drain();
});
control.on("error", () => process.exit(0));
control.on("close", () => process.exit(0));
