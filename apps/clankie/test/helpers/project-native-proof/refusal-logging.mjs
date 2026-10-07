import { serve } from "@hono/node-server";
import { createLogger } from "@clankie/observability";
import { localFleetProof } from "../../../src/local-fleet-proof.ts";
import { localProofDiagnostics } from "../../../src/local-fleet-proof-log.ts";
import { LocalFleetLink } from "../../../src/local-fleet-link.ts";
import { once } from "node:events";
import { request } from "node:http";
import { buildFleetProof } from "../../../../../scripts/build-fleet-proof.mjs";
await buildFleetProof();
const pendingDiagnostics = [];
const logger = createLogger({ service: "proof-log-fixture" });
const report = localProofDiagnostics(logger, "fleet");
const link = new LocalFleetLink({
  directory: "/not-used",
  binding: async () => undefined,
  prove: localFleetProof({
    binding: async () => undefined,
    herdrBinary: "herdr",
    platform: "darwin",
    diagnostics: (...args) => {
      pendingDiagnostics.push(Promise.resolve(report(...args)));
    },
  }),
});
let effects = 0;
const server = serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: link.fetch(() => {
    effects++;
    return Response.json({ effects });
  }),
});
if (!server.listening) await once(server, "listening");
try {
  const port = server.address().port;
  for (const pane of ["PID_PATH_ARGV_SENTINEL_/private/sensitive", "w1:p1"]) {
    await new Promise((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${port}/v1/fleet/seats/${encodeURIComponent(pane)}/events`,
        {
          headers: {
            "x-clankie-pane": pane,
            "x-clankie-pid": "314159",
            "x-clankie-bridge-id": "PID_PATH_ARGV_SENTINEL_/private/sensitive",
          },
          signal: AbortSignal.timeout(2000),
        },
        (response) => {
          if (response.statusCode !== 403 || effects !== 0)
            return reject(new Error("Refusal boundary failed"));
          response.resume();
          response.once("end", resolve);
        },
      );
      req.once("error", reject);
      req.end();
    });
    await Promise.all(pendingDiagnostics);
  }
} finally {
  await Promise.all(pendingDiagnostics);
  await link.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
