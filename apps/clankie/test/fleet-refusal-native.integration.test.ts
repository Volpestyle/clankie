// Real loopback admission, native socket/process reads and an isolated Herdr.
// The private app-server registration and persisted hiring record are explicit
// disposable host fixtures. No model, provider, screen or existing pane is used.
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Server as HttpServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { FleetHealthMetrics, proofAlertCallerSummary } from "../src/fleet-health-metrics.ts";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { localFleetAdmissionProof } from "../src/local-fleet-proof.ts";
import { fleetProcessHelper } from "../src/local-fleet-process.ts";
import { closeNativeProcessObservers } from "../src/native-process-transport.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { linearMcp } from "../src/linear-mcp.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";
// allow-no-sandbox -- imports the fixed production worker admission formatter, a standalone ESM file, by its file URL
const { checkFleetMembership } = await import(
  new URL("../../../integrations/claude-plugin/worker/bin/admission.mjs", import.meta.url).href
);

it.skipIf(process.platform !== "darwin")(
  "keeps native refusal reasons through MCP and the bridge, and never pages for a closed connection",
  async () => {
    const sourceRoot = resolve(import.meta.dirname, "../../..");
    await promisify(execFile)(process.execPath, [join(sourceRoot, "scripts/build-fleet-proof.mjs")], {
      timeout: 120_000,
    });
    const logs = join(sourceRoot, ".local/fleet-refusals", String(Date.now()));
    await mkdir(logs, { recursive: true });
    const herdr = await isolatedHerdr(logs);
    let now = Date.parse("2026-11-04T00:00:00Z");
    const ownersPath = join(herdr.root, "owners.json");
    const owners = new HireOwners(ownersPath);
    owners.bind(
      herdr.pane,
      { conversationId: "fixture-lead" },
      "fixture-private-seat",
      undefined,
      "fixture-occupant",
    );
    const alerts: string[] = [];
    const metrics = new FleetHealthMetrics({
      now: () => now,
      caller: (pane) => new HireOwners(ownersPath).paneHire(pane),
      onAggregateProofAlert: (_rates, callers) => {
        alerts.push(proofAlertCallerSummary(callers));
        return true;
      },
    });
    const binding = { runtime: "external" as const, session: "default", socketPath: herdr.socketPath };
    let admitted = true;
    const reasons: string[] = [];
    const prove = localFleetAdmissionProof({
      binding: async () => binding,
      herdrBinary: "herdr",
      processHelper: fleetProcessHelper(sourceRoot),
      privateSeat: async (chain, pane) => admitted && pane === herdr.pane && chain.includes(process.pid),
      diagnostics: (event, pane) => {
        metrics.observeProof("fleet", event, pane);
        if (event.source === "proof") reasons.push(event.reason);
      },
    });
    const settings = new SettingsStore(join(herdr.root, "settings.json"));
    const credentials = new FileCredentialStore(join(herdr.root, "credentials.json"));
    const host = createMcpHost({
      trackerMcp: linearMcp,
      settings,
      credentials,
      curated: [],
      logger: { info() {}, warn() {} },
    });
    const worker = new WorkerMcp({
      directory: join(herdr.root, "grants"),
      host,
      credentials,
      fleetTools: async () => "connected",
    });
    const link = new LocalFleetLink({
      directory: join(herdr.root, "links"),
      binding: async () => binding,
      prove,
    });
    let socket: Socket | undefined;
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: link.fetch((request) => worker.handleLocalFleet(request, link.identity(request)!)),
    });
    server.on("connection", (current: Socket) => {
      socket = current;
    });
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing native test listener");
    const rpc = (pane = herdr.pane) =>
      fetch(`http://127.0.0.1:${address.port}/v1/fleet/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-clankie-pane": pane,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "private-fixture", version: "1" },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    try {
      const accepted = await rpc();
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      await accepted.arrayBuffer();
      const closedSocket = socket!;
      const closed = once(closedSocket, "close");
      closedSocket.destroy();
      await closed;
      // The actual client process still lives; only its connection ended. These
      // are real proof refusals, not replayed/injected metric events.
      for (let count = 0; count < 100; count++)
        await expect(prove(closedSocket, herdr.pane)).rejects.toMatchObject({ code: "closed_socket" });
      now += 60_001;
      await expect(prove(closedSocket, herdr.pane)).rejects.toMatchObject({ code: "closed_socket" });
      expect(metrics.snapshot().totals.proof.byReason.closed_socket).toBe(101);
      expect(alerts).toEqual([]);

      admitted = false; // revoke only the disposable host registration
      const [nonmember, malformed, missing] = await Promise.all([
        rpc(),
        rpc("invalid/private-PID-SECRET"),
        rpc("w999999:p999999"),
      ]);
      for (const [response, reason, explanation] of [
        [nonmember, "not_member", "native lineage"],
        [malformed, "invalid_pane", "pane address"],
        [missing, "pane_unavailable", "no longer reports"],
      ] as const) {
        expect(response.status, await response.clone().text()).toBe(403);
        const body = await response.clone().json();
        expect(body).toMatchObject({
          error: "local_process_membership_required",
          refusal: reason,
          reason: expect.stringContaining(explanation),
        });
        expect(body.reason).toContain("clankie fleet status");
        expect(JSON.stringify(body)).not.toMatch(/private-PID-SECRET|\/tmp|birth|argv/u);
        // Real production bridge formatter on the actual admission response, so
        // the reason survives into worker/load evidence rather than disappearing.
        await expect(checkFleetMembership(response)).rejects.toThrow(`Native proof reason: ${reason}`);
      }
      expect(reasons).toEqual(
        expect.arrayContaining(["closed_socket", "not_member", "invalid_pane", "pane_unavailable"]),
      );
      // A real fleet dependency failure still pages; the earlier closed socket
      // must not enter the counted refusal window or affected-worker attribution.
      const unavailable = localFleetAdmissionProof({
        binding: async () => undefined,
        herdrBinary: "herdr",
        diagnostics: (event, pane) => metrics.observeProof("fleet", event, pane),
      });
      const live = socket!;
      for (let count = 0; count < 100; count++)
        await expect(unavailable(live, herdr.pane)).rejects.toMatchObject({ code: "missing_binding" });
      now += 60_001;
      await expect(unavailable(live, herdr.pane)).rejects.toMatchObject({ code: "missing_binding" });
      expect(alerts).toEqual([herdr.pane]);
    } finally {
      await link.close();
      await worker.close();
      await host.close();
      if (server instanceof HttpServer) server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await closeNativeProcessObservers();
      await herdr.close();
    }
  },
  120_000,
);
