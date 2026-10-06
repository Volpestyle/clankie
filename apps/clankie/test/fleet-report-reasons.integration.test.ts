import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { WorkerReportBridgeReasonSchema, WorkerReportBridgeStatusSchema } from "@clankie/protocol";
import {
  createInboundSender,
  hasPendingInboundClaim,
} from "../../../integrations/claude-plugin/worker/bin/inbound-receipt.mjs";
import { ConversationStore } from "../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { FleetHealthMetrics } from "../src/fleet-health-metrics.ts";
import { registerFleetHealthMetricsRoutes } from "../src/app/fleet-health-metrics-routes.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { runMetricsCommand } from "../../tui/src/command/metrics.ts";

it("counts every worker receipt failure from real TCP/filesystem failures without replaying retained originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-report-reasons-"));
  const metrics = new FleetHealthMetrics();
  const reports: Record<string, string[]> = {};
  try {
    for (const reason of WorkerReportBridgeReasonSchema.options) {
      const directory = join(root, reason);
      const conversations = new ConversationStore(join(root, `conversation-${reason}`), async () => {});
      const receiver = new InboundSeatReceipts(join(root, `fence-${reason}.json`), conversations);
      const binding = createHash("sha256").update(directory).digest("hex");
      const pane = `w1:p${reason}`;
      let posts = 0;
      let lastDelivery: { id: string; binding: string } | undefined;
      const server = createServer(async (request, response) => {
        if (reason === "binding_timeout" && request.method === "GET") {
          await delay(250);
          response.end();
          return;
        }
        if (request.method === "GET" && request.url !== "/") {
          const url = new URL(request.url!, "http://localhost");
          const delivery = {
            id: url.pathname.split("/").filter(Boolean)[0]!,
            binding: url.searchParams.get("binding")!,
          };
          response.setHeader("content-type", "application/json");
          if (reason === "receipt_unresolved") {
            response.statusCode = 503;
            response.end();
            return;
          }
          response.end(JSON.stringify(receiver.lookup(pane, delivery, url.searchParams.get("fingerprint")!)));
          return;
        }
        if (request.method === "GET") {
          response.setHeader("content-type", "application/json");
          response.statusCode =
            reason === "binding_rejected" ? 403 : reason === "binding_unavailable" ? 503 : 200;
          response.end(JSON.stringify({ binding }));
          return;
        }
        posts++;
        let bytes = "";
        for await (const chunk of request) bytes += chunk;
        const { text, delivery } = JSON.parse(bytes);
        lastDelivery = delivery;
        if (reason === "receipt_timeout") {
          await delay(250);
          response.end();
          return;
        }
        if (reason === "receipt_unresolved") {
          response.statusCode = 503;
          response.end();
          return;
        }
        const receipt = receiver.accept(pane, delivery, text, text);
        expect(receipt.deliveryStage).toBe("stored");
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            reason === "receipt_invalid" ? { ...receipt, fingerprint: "0".repeat(64) } : receipt,
          ),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing TCP listener");
      const host = `http://127.0.0.1:${address.port}`;
      if (reason === "local_receipt_unavailable") await writeFile(directory, "not a directory");
      reports[reason] = [];
      const sender = createInboundSender({
        directory,
        scope: reason,
        onObservation: (raw) => {
          const report = WorkerReportBridgeStatusSchema.parse(raw);
          reports[reason]!.push(report.reason);
          metrics.observeReport("default", pane, report);
          metrics.observeReport("default", pane, report); // Polling the same observation adds no attempt.
        },
        request: async (suffix, init) => {
          const response = await fetch(`${host}${suffix || "/"}`, {
            ...init,
            signal: AbortSignal.timeout(100),
          });
          if (reason === "connection_refused" && !init) {
            await response.clone().text();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
          return response;
        },
      });
      try {
        const receipt = await sender("REPORT_BODY_PRIVATE_SENTINEL");
        expect(reports[reason]).toEqual(reason === "local_receipt_unavailable" ? [reason, reason] : [reason]);
        expect(receipt.deliveryStage).toBe(
          reason === "stored"
            ? "stored"
            : reason === "binding_rejected"
              ? "rejected"
              : ["binding_unavailable", "connection_refused"].includes(reason)
                ? "unavailable"
                : "uncertain",
        );
        expect(posts).toBe(
          ["stored", "receipt_timeout", "receipt_unresolved", "receipt_invalid"].includes(reason) ? 1 : 0,
        );
        if (["receipt_timeout", "receipt_unresolved", "receipt_invalid"].includes(reason)) {
          const claim = (await readdir(directory)).find((name) => name.endsWith(".json"));
          expect(claim).toBeDefined();
          expect(JSON.parse(await readFile(join(directory, claim!), "utf8")).deliveryId).toBe(
            lastDelivery!.id,
          );
          // A retained original is never sent again, even when receipt lookup is unavailable.
          expect(hasPendingInboundClaim(directory, reason)).toBe(true);
          const before = posts;
          if (reason === "receipt_unresolved") {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await delay(2);
          }
          await sender.reconcilePending();
          expect(posts).toBe(before);
          if (reason === "receipt_unresolved") expect(reports[reason]).toEqual([reason, reason]);
          if (reason === "receipt_invalid") {
            expect(reports[reason]).toEqual([reason, "stored"]);
            expect(hasPendingInboundClaim(directory, reason)).toBe(false);
          }
        }
        if (reason === "stored") {
          expect(await readdir(directory)).toEqual([]);
          expect(hasPendingInboundClaim(directory, reason)).toBe(false);
          expect(conversations.inboundAcceptance(lastDelivery!.id)?.text).toBe(
            "REPORT_BODY_PRIVATE_SENTINEL",
          );
        }
      } finally {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        await conversations.close();
      }
    }
    const app = new Hono();
    registerFleetHealthMetricsRoutes(app, {
      captain: createStubCaptain(),
      authenticateOperator: createBearerAuthenticator("reason-test", { operatorId: "owner" }),
      fleetHealthMetrics: metrics,
    });
    const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing metrics listener");
    try {
      const result = await runMetricsCommand(["--fleet"], {
        host: `http://127.0.0.1:${address.port}`,
        env: { CLANKIE_OPERATOR_TOKEN: "reason-test" },
      });
      if (!("fleet" in result)) throw new Error("No fleet metrics");
      for (const reason of WorkerReportBridgeReasonSchema.options.filter((value) => value !== "stored"))
        expect(result.fleet.totals.reports.byReason[reason]).toBeGreaterThanOrEqual(1);
      expect(result.fleet.totals.reports.failures).toBe(result.fleet.totals.reports.attempts - 2);
      expect(result.fleet.windows[0].reports).toEqual(result.fleet.totals.reports);
      expect(result.fleet.windows[1].reports).toEqual(result.fleet.totals.reports);
      expect(JSON.stringify(result.fleet)).not.toMatch(
        /REPORT_BODY_PRIVATE_SENTINEL|fingerprint|"binding":|deliveryId|\/private\/|argv|\bpid\b/u,
      );
    } finally {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
