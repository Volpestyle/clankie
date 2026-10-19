import { createServer } from "node:http";
import { fork, spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

if (process.argv[2] === "burn") {
  let value = 1;
  const burn = () => {
    for (let index = 0; index < 100_000; index++) value = Math.sin(value + index);
    setImmediate(burn);
  };
  burn();
  setInterval(() => process.send?.(process.cpuUsage()), 100);
} else {
  const [receipt, workerCount = "0", python, zombieFixture] = process.argv.slice(2);
  const zombie = python ? spawn(python, [zombieFixture, `${receipt}.zombie`]) : undefined;
  const workers = Array.from({ length: Number(workerCount) }, () =>
    fork(import.meta.filename, ["burn"], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }),
  );
  const usage = new Map();
  workers.forEach((worker) => worker.on("message", (sample) => usage.set(worker.pid, sample)));
  const server = createServer((request, response) => {
    if (request.url === "/stop") {
      response.end("stopping");
      workers.forEach((worker) => worker.kill());
      zombie?.kill();
      server.close(() => process.exit(7));
      return;
    }
    const cpu = [process.cpuUsage(), ...usage.values()].reduce(
      (sum, sample) => sum + sample.user + sample.system,
      0,
    );
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ cpuMs: cpu / 1000, workers: usage.size }));
  });
  server.listen(0, "127.0.0.1", () => {
    // The test polls this receipt; a rename never exposes a partial write.
    writeFileSync(
      `${receipt}.tmp`,
      JSON.stringify({
        port: server.address().port,
        vitest: process.env.VITEST_MAX_WORKERS,
        turbo: process.env.TURBO_CONCURRENCY,
      }),
    );
    renameSync(`${receipt}.tmp`, receipt);
  });
}
