import { serve } from "@hono/node-server";
import { once } from "node:events";
import { mkdtemp, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRuntimeUpdateRoutes } from "../src/runtime-update-routes.ts";
import { createWorkerToolRefresh } from "../src/worker-tool-refresh.ts";
import { RemoteCodexSeats } from "../src/remote-codex-seats.ts";
import type { CaptainPort } from "../src/captain/port.ts";
import type { WorkerMcp } from "../src/worker-mcp.ts";
import type { createLocalCodexCatalogCoordinator } from "../src/captain/local-codex-catalog-coordinator.ts";
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
            detail: "Loaded native threads: original root and active child",
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
        detail: "Loaded native threads: original root and active child",
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

// The native observations are a declared surrogate. Real coordinator, HTTP,
// CLI and response schema exercise refusal even with apparently healthy root
// evidence; this does not launch Claude or prove native descendant adoption.
it("remote Claude root health cannot certify replacement of its imported bridge", async () => {
  const token = `clankie_op_${"c".repeat(43)}`;
  let status = "working",
    requested: string | undefined;
  const signals: string[] = [];
  const sessionId = "original-pc-claude-session";
  const coordinator = createWorkerToolRefresh({
    captain: {
      workerCatalogSeats: async () => [
        {
          paneId: "pc/w1:p1",
          seatId: "original-pc-seat",
          harness: "claude",
          sessionId,
          status,
        },
      ],
      toolCatalogHealth: async () => ({
        schemaVersion: 1,
        seats: [
          {
            paneId: "pc/w1:p1",
            seatId: "original-pc-seat",
            toolCatalog: {
              status: "matched",
              harness: "claude",
              bridge: "worker",
              sessionId,
              detail: "Root-only fixture observation",
              missing: [],
              checkedAt: new Date().toISOString(),
            },
          },
        ],
      }),
    } as unknown as CaptainPort,
    local: { close() {} } as ReturnType<typeof createLocalCodexCatalogCoordinator>,
    remote: new RemoteCodexSeats(async () => undefined),
    workerMcp: {
      requestCatalogRefresh(_fleet: string, _pane: string, revision: string) {
        requested = revision;
        signals.push(revision);
      },
      bridgeStatus: () => ({ runtimeRevision: requested, behind: false }),
    } as unknown as WorkerMcp,
    revision: "fixture-service",
    intervalMs: 60_000,
  });
  const app = createRuntimeUpdateRoutes({
    authorize: async (request) =>
      request.headers.get("authorization") === `Bearer ${token}`
        ? { current: () => true, guard: async () => {} }
        : undefined,
    refreshWorkerCatalogs: coordinator.refresh,
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No refresh fixture port");
  const options = { host: `http://127.0.0.1:${address.port}`, env: { CLANKIE_OPERATOR_TOKEN: token } };
  try {
    const busy = await runWorkerToolRefreshCommand(["refresh-tools", "--pane", "pc/w1:p1"], options);
    expect(busy.seats[0]).toMatchObject({ outcome: "skipped-busy", reason: "original_native_session_busy" });
    expect(signals).toEqual([]);
    status = "idle";
    const idle = await runWorkerToolRefreshCommand(["refresh-tools", "--pane", "pc/w1:p1"], options);
    expect(idle.seats[0]).toMatchObject({
      paneId: "pc/w1:p1",
      seatId: "original-pc-seat",
      outcome: "failed",
      reason: "original_remote_claude_imported_bridge_refresh_unsupported",
    });
    expect(signals).toEqual([]);
  } finally {
    coordinator.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
