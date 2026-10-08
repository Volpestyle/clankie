import { serve } from "@hono/node-server";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { createLocalCodexCatalogCoordinator } from "../src/captain/local-codex-catalog-coordinator.ts";
import { LocalCodexSeats } from "../src/local-codex-seats.ts";
import { RemoteCodexSeats } from "../src/remote-codex-seats.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { createWorkerToolRefresh } from "../src/worker-tool-refresh.ts";
import { createRuntimeUpdateRoutes } from "../src/runtime-update-routes.ts";
import { runWorkerToolRefreshCommand } from "../../tui/src/command/harness.ts";

// Real ownership persistence, coordinator, MCP signal state, HTTP and CLI/schema.
// No native runtime is launched: this verifies selection/deferral authority,
// not successful tool adoption by Claude/Codex.
it("no-pane refresh uses persisted occupant ownership and skips owner/other-lead seats without signaling them", async () => {
  const root = await mkdtemp(join(tmpdir(), "refresh-ownership-"));
  const path = join(root, "owners.json");
  const owners = new HireOwners(path);
  const rows = [
    { paneId: "pc/w1:p1", seatId: "hired", sessionId: "session-a", harness: "claude", status: "working" },
    { paneId: "pc/w1:p2", seatId: "adopted", sessionId: "session-b", harness: "claude", status: "idle" },
    {
      paneId: "pc/w1:p3",
      seatId: "other-lead",
      sessionId: "session-c",
      harness: "claude",
      status: "working",
    },
    { paneId: "w2:p1", seatId: "owner-pane", sessionId: "session-d", harness: "claude", status: "working" },
  ];
  owners.bind(rows[0]!.paneId, { conversationId: "lead-a" }, rows[0]!.seatId, undefined, rows[0]!.sessionId);
  owners.adopt(rows[1]!.paneId, rows[1]!.seatId, rows[1]!.sessionId, { conversationId: "lead-a" });
  owners.bind(rows[2]!.paneId, { conversationId: "lead-b" }, rows[2]!.seatId, undefined, rows[2]!.sessionId);
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const host = createMcpHost({
    credentials,
    settings: new SettingsStore(join(root, "settings.json")),
    curated: [],
    logger: { info() {}, warn() {} },
  });
  const workerMcp = new WorkerMcp({
    directory: join(root, "mcp"),
    credentials,
    host,
    runtimeRevision: "service",
  });
  const coordinator = createWorkerToolRefresh({
    captain: {
      workerCatalogSeats: async () =>
        rows.map((row) => {
          const owner = new HireOwners(path).owner(row.paneId, row.seatId, row.sessionId);
          return { ...row, ...(owner ? { ownerConversationId: owner.conversationId } : {}) };
        }),
      toolCatalogHealth: async () => ({ schemaVersion: 1, seats: [] }),
    },
    local: createLocalCodexCatalogCoordinator({
      seats: new LocalCodexSeats(() => undefined),
      intervalMs: 60_000,
    }),
    remote: new RemoteCodexSeats(async () => undefined),
    workerMcp,
    revision: "service",
    intervalMs: 60_000,
  });
  let live = true;
  const authority = {
    conversationId: "lead-a",
    current: () => live,
    guard: async () => {
      if (!live) throw new Error("revoked");
    },
  };
  const token = `clankie_op_${"e".repeat(43)}`;
  const app = createRuntimeUpdateRoutes({
    authorize: async (request) =>
      request.headers.get("authorization") === `Bearer ${token}` ? authority : undefined,
    refreshConversationId: () => "lead-a",
    refreshWorkerCatalogs: coordinator.refresh,
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test HTTP port");
  const options = { host: `http://127.0.0.1:${address.port}`, env: { CLANKIE_OPERATOR_TOKEN: token } };
  try {
    const result = await runWorkerToolRefreshCommand(["refresh-tools"], options);
    expect(result.seats.map((seat) => [seat.seatId, seat.outcome])).toEqual([
      ["hired", "skipped-busy"],
      ["adopted", "failed"],
      ["other-lead", "skipped-not-owned"],
      ["owner-pane", "skipped-not-owned"],
    ]);
    expect(result.seats[1]!.reason).toBe("original_remote_claude_imported_bridge_refresh_unsupported");
    expect(result.seats[2]!.reason).toBe("worker_catalog_refresh_not_owned");
    const deniedExplicit = await coordinator.refresh({ paneId: "pc/w1:p3" }, authority);
    expect(deniedExplicit.seats[0]!.outcome).toBe("skipped-not-owned");
    const ownerExplicit = await runWorkerToolRefreshCommand(["refresh-tools", "--pane", "pc/w1:p3"], options);
    expect(ownerExplicit.seats[0]!.outcome).toBe("skipped-busy");
    const spoof = await fetch(`${options.host}/v1/fleet/worker-tool-refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ownerAuthorized: true, conversationId: "lead-b" }),
    });
    expect(spoof.status).toBe(400);
    // A busy request retains its original conversation. Ownership can change
    // in the real journal before idle without permitting its deferred effect.
    owners.adopt(rows[0]!.paneId, rows[0]!.seatId, rows[0]!.sessionId, { conversationId: "lead-b" });
    rows[0]!.status = "idle";
    coordinator.expectRevision("service");
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Replacing the native occupant invalidates even an earlier led/hired claim.
    rows[0]!.sessionId = "replacement-session";
    rows[0]!.status = "idle";
    expect((await coordinator.refresh({ paneId: "pc/w1:p1" }, authority)).seats[0]!.outcome).toBe(
      "skipped-not-owned",
    );
    for (const row of rows) {
      const [fleet, pane] = row.paneId.includes("/") ? row.paneId.split("/") : ["default", row.paneId];
      expect(workerMcp.bridgeStatus(fleet!, pane!).expectedRuntimeRevision).toBe("service");
    }
    live = false;
    await expect(coordinator.refresh({}, authority)).rejects.toThrow("revoked");
  } finally {
    coordinator.close();
    await workerMcp.close();
    await host.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
