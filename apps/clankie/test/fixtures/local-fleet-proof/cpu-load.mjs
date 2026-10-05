// Two opt-in ordinary processes run this bounded load; never use all cores.
const started = performance.now();
const initialCpu = process.cpuUsage();
console.log(JSON.stringify({ stage: "ready", pid: process.pid }));
while (performance.now() - started < 5_000) {
  // A short manual CPU-contention check, with a fixed wall-clock ceiling.
}
console.log(
  JSON.stringify({
    stage: "done",
    pid: process.pid,
    elapsedMs: performance.now() - started,
    cpuMicros: process.cpuUsage(initialCpu),
  }),
);
