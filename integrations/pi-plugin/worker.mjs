import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { connectPiWorker } from "./worker-connection.mjs";
import { createPiWorkerRuntime } from "./worker-runtime.mjs";
import { createPiWorkerFleet } from "../../apps/clankie/src/captain/pi-worker-fleet.mjs";

// Herdr records a Pi pane's native session only from a report sent inside that
// pane, as its own Pi integration sends it; the service's report from outside
// is ignored. Send the startup session here, so a hire does not depend on that
// integration being installed. The service still proves the same file itself.
function reportHerdrSession(ctx) {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  const file = ctx.sessionManager.getSessionFile();
  if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId || typeof file !== "string")
    return Promise.resolve();
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(done, 2_000);
    socket.on("error", done);
    socket.on("data", done);
    socket.on("end", done);
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({
          id: `clankie:pi:session:${randomUUID()}`,
          method: "pane.report_agent_session",
          params: {
            pane_id: paneId,
            source: "herdr:pi",
            agent: "pi",
            seq: Date.now() * 1000,
            session_start_source: "startup",
            agent_session_path: file,
          },
        })}\n`,
      ),
    );
  });
}

export default function clankiePiWorker(pi) {
  const port = Number(process.env.CLANKIE_PI_WORKER_PORT);
  const token = process.env.CLANKIE_PI_WORKER_TOKEN;
  if (!port || !token) return;
  delete process.env.CLANKIE_PI_WORKER_PORT;
  delete process.env.CLANKIE_PI_WORKER_TOKEN;
  let herdrSession = Promise.resolve();
  pi.on("session_start", (event, ctx) => {
    if (event.reason === "startup" && ctx.mode === "tui") herdrSession = reportHerdrSession(ctx);
  });
  connectPiWorker({ port, token }, (controller) => {
    const runtime = createPiWorkerRuntime(pi, controller);
    const fleet = createPiWorkerFleet(pi, { beforeCall: () => controller.authorize("history") });
    return {
      ...runtime,
      async initialize(input) {
        const identity = await runtime.initialize(input);
        // The service checks Herdr's record right after this returns.
        await herdrSession;
        return identity;
      },
      close() {
        void fleet.close();
        runtime.close();
      },
    };
  });
}
