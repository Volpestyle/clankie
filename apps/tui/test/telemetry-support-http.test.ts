import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBodyTelemetry } from "@clankie/observability/body-telemetry";
import { expect, it } from "vitest";
import { runTelemetryCommand } from "../src/command/telemetry.ts";

it("the host CLI sends mandatory support audit to both groups without diagnostic consent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "support-ship-cli-"));
  const telemetry = createBodyTelemetry({ dir, writer: "service" });
  telemetry.audit?.({
    event: "body.support",
    grantId: "grant_cli123",
    scope: "read-state",
    action: "revoked",
  });
  telemetry.emit({ event: "body.shutdown", reason: "sigterm" });
  const puts: { group: string; events: { message: string }[] }[] = [];
  const metadata: Record<string, string> = {
    "/latest/meta-data/tags/instance/clankie:tenant-id": "tn_cli123",
    "/latest/meta-data/placement/region": "us-east-1",
    "/latest/meta-data/instance-id": "i-cli123",
    "/latest/meta-data/iam/security-credentials/": "body-role",
    "/latest/meta-data/iam/security-credentials/body-role": JSON.stringify({
      AccessKeyId: "ASIATEST",
      SecretAccessKey: "fixture-only",
      Expiration: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  };
  const server = createServer(async (request, response) => {
    if (request.url === "/latest/api/token") {
      expect(request.method).toBe("PUT");
      response.end("token");
    } else if (request.url !== "/") {
      expect(request.headers["x-aws-ec2-metadata-token"]).toBe("token");
      const value = metadata[request.url ?? ""];
      response.statusCode = value === undefined ? 404 : 200;
      response.end(value);
    } else {
      expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /u);
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
        logGroupName: string;
        logEvents: { message: string }[];
      };
      if (request.headers["x-amz-target"] === "Logs_20140328.PutLogEvents")
        puts.push({ group: payload.logGroupName, events: payload.logEvents });
      response.setHeader("content-type", "application/json");
      response.end("{}");
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  let stdout = "";
  let stderr = "";
  try {
    const result = await runTelemetryCommand(
      [
        "ship",
        "--spool",
        dir,
        "--cursor",
        join(dir, "cursor.json"),
        "--log-group",
        "clankie-obs-dev-body",
        "--audit-log-group",
        "clankie-obs-dev-audit",
        "--once",
      ],
      {
        stdout: {
          write: (chunk) => {
            stdout += chunk;
          },
        },
        stderr: {
          write: (chunk) => {
            stderr += chunk;
          },
        },
        fetchImpl: (url, init) =>
          fetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, init),
      },
    );
    expect(result).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, shipped: 2, dropped: 1 });
    expect(puts.map((put) => put.group).sort()).toEqual(["clankie-obs-dev-audit", "clankie-obs-dev-body"]);
    expect(
      puts.every(
        (put) =>
          put.events.length === 1 && JSON.parse(put.events[0]?.message ?? "{}").event === "body.support",
      ),
    ).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
});
