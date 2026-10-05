import { connectPiWorker } from "./worker-connection.mjs";
import { createPiWorkerRuntime } from "./worker-runtime.mjs";

export default function clankiePiWorker(pi) {
  const port = Number(process.env.CLANKIE_PI_WORKER_PORT);
  const token = process.env.CLANKIE_PI_WORKER_TOKEN;
  if (!port || !token) return;
  delete process.env.CLANKIE_PI_WORKER_PORT;
  delete process.env.CLANKIE_PI_WORKER_TOKEN;
  connectPiWorker({ port, token }, (controller) => createPiWorkerRuntime(pi, controller));
}
