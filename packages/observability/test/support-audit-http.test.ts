import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BODY_SUPPORT_AUDIT_DIR,
  createBodyTelemetry,
  pruneSpool,
  spoolFileName,
} from "../src/body-telemetry.ts";
import { createCloudWatchLogSink, shipBodyTelemetry } from "../src/body-telemetry-shipper.ts";

it("persists support audit with diagnostics off and independently retries two signed HTTP destinations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "support-audit-http-"));
  const start = Date.parse("2026-10-05T10:00:00Z");
  let now = start;
  const telemetry = createBodyTelemetry({ dir, writer: "service", clock: () => now });
  const grantId = "d5bd1d6a-e918-49ec-a4c2-fca1c9a4a209";
  telemetry.audit?.({ event: "body.support", grantId, scope: "read-state", action: "granted" });
  telemetry.audit?.({
    event: "body.support",
    grantId,
    scope: "read-state",
    action: "accessed",
    routeClass: "body-state",
  });
  telemetry.emit({ event: "body.boot", phase: "clankie-healthy" });
  const auditFile = join(dir, BODY_SUPPORT_AUDIT_DIR, spoolFileName(start, "service"));
  // Diagnostic pruning never removes an unacknowledged audit, even weeks later.
  now += 20 * 24 * 3_600_000;
  pruneSpool(dir, now);
  expect(readFileSync(auditFile, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  let failBody = true;
  const accepted: { group: string; events: { timestamp: number; message: string }[] }[] = [];
  const server = createServer(async (request, response) => {
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /u);
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
      logGroupName: string;
      logEvents: { timestamp: number; message: string }[];
    };
    if (request.headers["x-amz-target"] === "Logs_20140328.PutLogEvents") {
      if (payload.logGroupName.endsWith("-body") && failBody) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ __type: "ServiceUnavailableException" }));
        return;
      }
      accepted.push({ group: payload.logGroupName, events: payload.logEvents });
    }
    response.setHeader("content-type", "application/json");
    response.end("{}");
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  const sink = (logGroup: string) =>
    createCloudWatchLogSink({
      region: "us-east-1",
      logGroup,
      now: () => now,
      credentials: async () => ({ accessKeyId: "ASIATEST", secretAccessKey: "test-only" }),
      // Route the signed AWS wire request to a real local HTTP peer; no cloud calls.
      fetch: (_url, init) => fetch(`http://127.0.0.1:${address.port}/`, init),
    });
  const input = {
    spoolDir: dir,
    cursorPath: join(dir, "cursor.json"),
    identity: { tenantId: "tn_testtenant", instanceId: "i-test", region: "us-east-1" },
    sink: sink("clankie-obs-dev-body"),
    auditSink: sink("clankie-obs-dev-audit"),
    diagnosticsEnabled: () => false,
    now: () => now,
    pruneAcknowledgedSupport: true,
  };
  try {
    await expect(shipBodyTelemetry(input)).rejects.toThrow("ServiceUnavailableException");
    expect(accepted.map((put) => put.group)).toEqual(["clankie-obs-dev-audit"]);
    expect(readFileSync(auditFile, "utf8")).toContain(grantId);
    failBody = false;
    await expect(shipBodyTelemetry(input)).resolves.toMatchObject({ shipped: 2 });
    expect(accepted.map((put) => put.group)).toEqual(["clankie-obs-dev-audit", "clankie-obs-dev-body"]);
    expect(readdirSync(join(dir, BODY_SUPPORT_AUDIT_DIR))).toEqual([]);
    for (const put of accepted)
      for (const event of put.events) {
        expect(event.timestamp).toBe(now); // CloudWatch age limit does not discard audit.
        expect(JSON.parse(event.message)).toMatchObject({ event: "body.support", atMs: start });
      }
    await expect(shipBodyTelemetry(input)).resolves.toMatchObject({ shipped: 0 });
    expect(accepted).toHaveLength(2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses invalid or unwritable mandatory audit while ordinary diagnostics stay best effort", () => {
  const dir = mkdtempSync(join(tmpdir(), "support-audit-fail-"));
  writeFileSync(join(dir, BODY_SUPPORT_AUDIT_DIR), "not a directory");
  const telemetry = createBodyTelemetry({ dir, writer: "service" });
  expect(() =>
    telemetry.audit?.({ event: "body.support", grantId: "grant_123456", scope: "shell", action: "granted" }),
  ).toThrow();
  expect(() => telemetry.emit({ event: "body.shutdown", reason: "sigterm" })).not.toThrow();
  rmSync(dir, { recursive: true, force: true });
});
