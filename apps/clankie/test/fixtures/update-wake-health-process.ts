/** Real sampled runtime, independent of the Vitest observer's scheduling. */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRuntimeHealthSampler } from "../../src/runtime-health-sample.ts";

const runtime = {
  root: process.argv[2]!,
  commit: "b".repeat(40),
  instanceId: randomUUID(),
  pid: process.pid,
};
const pauseMs = Number(process.argv[3] ?? 0);
let stopped = false;
let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let samples = 0;
const server = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true, service: "clankie", runtime }));
});
const close = () => {
  stopped = true;
  clearTimeout(timer);
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
const send = (message: Record<string, unknown>) => {
  if (process.connected)
    process.send?.(message, (error) => {
      if (error) close();
    });
};
process.once("SIGTERM", close);
process.once("disconnect", close);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const sample = createRuntimeHealthSampler({ healthUrl: `http://127.0.0.1:${port}/health` });
async function collect() {
  if (stopped) return;
  try {
    const reading = await sample(runtime);
    send({ type: "sample", at: performance.now(), reading });
    if (++samples === 1 && pauseMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
  } catch (error) {
    send({ type: "sample", at: performance.now(), error: String(error) });
  }
  if (!stopped) timer = setTimeout(() => void collect(), 100);
}
process.on("message", (message) => {
  if (message === "start" && !started) {
    started = true;
    void collect();
  }
});
send({ type: "ready", runtime });
