import { serve } from "@hono/node-server";
import { once } from "node:events";
import { mkdtemp, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRuntimeUpdateRoutes } from "../src/runtime-update-routes.ts";
import { runWorkerToolRefreshCommand } from "../../tui/src/command/harness.ts";

it("operator CLI crosses real HTTP/schema boundaries and revocation prevents dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-tool-refresh-http-"));
  const journal = join(directory, "requests.jsonl"),
    token = `clankie_op_${"f".repeat(43)}`;
  let live = true,
    revokeOnDispatch = false;
  const app = createRuntimeUpdateRoutes({
    authorize: async (request) =>
      request.headers.get("authorization") === `Bearer ${token}` && live
        ? {
            current: () => live,
            guard: async () => {
              if (!live) throw new Error("revoked");
            },
          }
        : undefined,
    refreshWorkerCatalogs: async (input, authority) => {
      if (revokeOnDispatch) live = false;
      await authority!.guard();
      if (!authority!.current()) throw new Error("revoked");
      await appendFile(journal, `${JSON.stringify(input)}\n`);
      return {
        schemaVersion: 1,
        revision: "fixture-service",
        seats: [
          {
            paneId: input.paneId ?? "w1:p1",
            revision: "fixture-service",
            outcome: "skipped-busy",
            reason: "original_native_session_busy",
          },
        ],
      };
    },
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture TCP server unavailable");
  const host = `http://127.0.0.1:${address.port}`;
  const options = { host, env: { CLANKIE_OPERATOR_TOKEN: token } };
  try {
    const result = await runWorkerToolRefreshCommand(["refresh-tools", "--pane", "w1:p1"], options);
    expect(result.seats).toEqual([
      {
        paneId: "w1:p1",
        revision: "fixture-service",
        outcome: "skipped-busy",
        reason: "original_native_session_busy",
      },
    ]);
    expect(await readFile(journal, "utf8")).toBe('{"paneId":"w1:p1"}\n');
    const denied = await fetch(`${host}/v1/fleet/worker-tool-refresh`, { method: "POST", body: "{}" });
    expect(denied.status).toBe(403);
    const malformed = await fetch(`${host}/v1/fleet/worker-tool-refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ restart: true }),
    });
    expect(malformed.status).toBe(400);
    revokeOnDispatch = true;
    await expect(runWorkerToolRefreshCommand(["refresh-tools"], options)).rejects.toThrow("403");
    expect(await readFile(journal, "utf8")).toBe('{"paneId":"w1:p1"}\n');
  } finally {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
