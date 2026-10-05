import { serve } from "@hono/node-server";
import { createLogger } from "@clankie/observability";
import { localFleetProof } from "../../../src/local-fleet-proof.ts";
import { localProofDiagnostics } from "../../../src/local-fleet-proof-log.ts";
import { LocalFleetLink } from "../../../src/local-fleet-link.ts";
import { once } from "node:events";
const logger = createLogger({ service: "proof-log-fixture" });
const link = new LocalFleetLink({
  directory: "/not-used",
  binding: async () => undefined,
  prove: localFleetProof({
    binding: async () => undefined,
    herdrBinary: "herdr",
    platform: "darwin",
    diagnostics: localProofDiagnostics(logger, "fleet"),
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
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/fleet/seats/${encodeURIComponent(pane)}/events`,
      { headers: { "x-clankie-pane": pane }, signal: AbortSignal.timeout(2000) },
    );
    if (response.status !== 403 || effects !== 0) throw new Error("Refusal boundary failed");
    await response.arrayBuffer();
  }
} finally {
  await link.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
