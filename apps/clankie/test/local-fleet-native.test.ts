// Manual read-only ABI probe: no Clankie credentials, service or grants involved.
import { it } from "vitest";
import { createServer } from "node:http";
import { localFleetProof } from "../src/local-fleet-proof.ts";
it.skipIf(!process.env.CLANKIE_PROOF_PANE || process.platform !== "darwin")(
  "checks the real local process ABI without credentials or grants",
  async () => {
    const pane = process.env.CLANKIE_PROOF_PANE;
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!pane || !socketPath) throw new Error("Set explicit CLANKIE_PROOF_PANE and HERDR_SOCKET_PATH");
    let registered = true;
    const prove = localFleetProof({
      herdrBinary: "herdr",
      binding: async () => ({ runtime: "external", session: "default", socketPath }),
      // Models the service-owned private app-server registry using this probe's own PID.
      privateSeat: async (chain, selected) => registered && selected === pane && chain.includes(process.pid),
    });
    const server = createServer(async (request, response) => {
      const admitted = await prove(request.socket, String(request.headers["x-clankie-pane"] ?? ""));
      response.writeHead(admitted ? 200 : 403);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    try {
      const check = async (selected: string) =>
        (await fetch(`http://127.0.0.1:${address.port}`, { headers: { "x-clankie-pane": selected } })).status;
      const admitted = await check(pane);
      const forged = await check("w0:p0");
      registered = false;
      const revoked = await check(pane);
      console.log(
        JSON.stringify({ native: "macOS libproc + live Herdr process-info", admitted, forged, revoked }),
      );
      if (admitted !== 200 || forged !== 403 || revoked !== 403) process.exitCode = 1;
    } finally {
      server.closeAllConnections();
      server.close();
    }
  },
);
