import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spoolFileName } from "../src/body-telemetry.ts";
import {
  createCloudWatchLogSink,
  createInstanceMetadata,
  shipSpool,
  type LogSink,
  type ShippedEvent,
} from "../src/body-telemetry-shipper.ts";

const NOW = Date.parse("2026-09-26T06:00:00.000Z");
const IDENTITY = { region: "us-east-1", instanceId: "i-0abc123", tenantId: "tn_abcdefghijklmnopqrst" };

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, atMs: NOW - 1_000, ...event })}\n`;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ship-"));
  const spoolDir = join(dir, "spool");
  const cursorPath = join(dir, "cursor", "cursor.json");
  const puts: { stream: string; events: readonly ShippedEvent[] }[] = [];
  let failing = false;
  const sink: LogSink = {
    put: async (stream, events) => {
      if (failing) throw new Error("PutLogEvents: ThrottlingException");
      puts.push({ stream, events });
    },
  };
  const ship = () => shipSpool({ spoolDir, cursorPath, identity: IDENTITY, sink, now: () => NOW });
  return { spoolDir, puts, ship, fail: (value: boolean) => (failing = value), mkdir: () => spoolDir };
}

describe("shipping the spool", () => {
  it("stamps the host's ids, drops anything else, and ships each line once", async () => {
    const { spoolDir, puts, ship } = fixture();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(spoolDir);
    const file = join(spoolDir, spoolFileName(NOW, "service"));
    writeFileSync(
      file,
      [
        line({ event: "body.boot", phase: "clankie-healthy", sinceStartMs: 800 }),
        // A body claiming another tenant's id is refused outright.
        line({ event: "body.shutdown", reason: "sigterm", tenantId: "tn_someoneelseentirely" }),
        "not json\n",
        line({
          event: "body.turn",
          outcome: "failed",
          toolCalls: 2,
          mutatingCalls: 0,
          atMs: NOW - 20 * 24 * 3_600_000,
        }),
      ].join(""),
    );
    appendFileSync(file, '{"v":1,"atMs":'); // a writer mid-append

    expect(await ship()).toEqual({ shipped: 1, dropped: 3, files: 1 });
    expect(puts).toEqual([
      {
        stream: "tn_abcdefghijklmnopqrst/i-0abc123",
        events: [
          {
            v: 1,
            atMs: NOW - 1_000,
            event: "body.boot",
            phase: "clankie-healthy",
            sinceStartMs: 800,
            tenantId: IDENTITY.tenantId,
            instanceId: IDENTITY.instanceId,
          },
        ],
      },
    ]);

    // The half line completes; only it ships next time.
    appendFileSync(file, `${NOW - 500},"event":"body.shutdown","reason":"sigterm"}\n`);
    expect(await ship()).toEqual({ shipped: 1, dropped: 0, files: 1 });
    expect(puts[1]?.events.map((event) => event.event)).toEqual(["body.shutdown"]);
    expect(await ship()).toEqual({ shipped: 0, dropped: 0, files: 1 });
  });

  it("keeps the cursor when the sink fails, so nothing is lost", async () => {
    const { spoolDir, puts, ship, fail } = fixture();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(spoolDir);
    writeFileSync(
      join(spoolDir, spoolFileName(NOW, "body")),
      line({ event: "body.shutdown", reason: "sigterm" }),
    );
    fail(true);
    await expect(ship()).rejects.toThrow(/Throttling/u);
    fail(false);
    expect(await ship()).toMatchObject({ shipped: 1 });
    expect(puts).toHaveLength(1);
  });
});

describe("CloudWatch Logs", () => {
  it("creates the stream once and signs every call", async () => {
    const calls: { target: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("https://logs.us-east-1.amazonaws.com/");
      const headers = init?.headers as Record<string, string>;
      calls.push({
        target: headers["x-amz-target"] ?? "",
        headers,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      if (headers["x-amz-target"] === "Logs_20140328.CreateLogStream" && calls.length > 2) {
        return Response.json(
          { __type: "com.amazonaws.logs#ResourceAlreadyExistsException" },
          { status: 400 },
        );
      }
      return Response.json({});
    };
    const sink = createCloudWatchLogSink({
      region: "us-east-1",
      logGroup: "clankie-obs-dev-body",
      credentials: async () => ({
        accessKeyId: "ASIAEXAMPLE",
        secretAccessKey: "secret",
        sessionToken: "session",
      }),
      fetch: fetchImpl,
    });
    const event = {
      v: 1,
      atMs: NOW,
      event: "body.shutdown",
      reason: "sigterm",
      tenantId: "tn_x",
      instanceId: "i-1",
    } as ShippedEvent;
    await sink.put("tn_x/i-1", [event]);
    await sink.put("tn_x/i-1", [event]);
    expect(calls.map((call) => call.target)).toEqual([
      "Logs_20140328.CreateLogStream",
      "Logs_20140328.PutLogEvents",
      "Logs_20140328.PutLogEvents",
    ]);
    expect(calls[1]?.body).toEqual({
      logGroupName: "clankie-obs-dev-body",
      logStreamName: "tn_x/i-1",
      logEvents: [{ timestamp: NOW, message: JSON.stringify(event) }],
    });
    expect(calls[1]?.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/\d{8}\/us-east-1\/logs\/aws4_request, SignedHeaders=[a-z0-9;-]*x-amz-target[a-z0-9;-]*, Signature=[0-9a-f]{64}$/u,
    );
    expect(calls[1]?.headers["x-amz-security-token"]).toBe("session");
  });

  it("surfaces a rejected put", async () => {
    const sink = createCloudWatchLogSink({
      region: "us-east-1",
      logGroup: "g",
      credentials: async () => ({ accessKeyId: "A", secretAccessKey: "s" }),
      fetch: async (_url, init) =>
        ((init?.headers ?? {}) as Record<string, string>)["x-amz-target"]?.endsWith("PutLogEvents")
          ? Response.json({ __type: "com.amazonaws.logs#AccessDeniedException" }, { status: 400 })
          : Response.json({}),
    });
    await expect(sink.put("s", [])).rejects.toThrow("PutLogEvents: AccessDeniedException");
  });
});

describe("instance metadata", () => {
  it("reads the tenant from the instance tag and refuses an untagged instance", async () => {
    const paths: Record<string, string> = {
      "meta-data/tags/instance/clankie:tenant-id": "tn_abcdefghijklmnopqrst",
      "meta-data/placement/region": "us-east-1",
      "meta-data/instance-id": "i-0abc123",
      "meta-data/iam/security-credentials/": "clankie-tenant-dev-body",
      "meta-data/iam/security-credentials/clankie-tenant-dev-body": JSON.stringify({
        AccessKeyId: "ASIA1",
        SecretAccessKey: "s",
        Token: "t",
        Expiration: "2026-09-26T07:00:00Z",
      }),
    };
    const fetchImpl: typeof fetch = async (url, init) => {
      const path = String(url).replace("http://169.254.169.254/latest/", "");
      if (path === "api/token")
        return new Response(init?.method === "PUT" ? "token" : "", {
          status: init?.method === "PUT" ? 200 : 405,
        });
      expect(((init?.headers ?? {}) as Record<string, string>)["x-aws-ec2-metadata-token"]).toBe("token");
      const value = paths[path];
      return value === undefined ? new Response("", { status: 404 }) : new Response(value);
    };
    const imds = createInstanceMetadata(fetchImpl);
    expect(await imds.identity()).toEqual(IDENTITY);
    expect(await imds.credentials()).toEqual({
      accessKeyId: "ASIA1",
      secretAccessKey: "s",
      sessionToken: "t",
      expiresAtMs: Date.parse("2026-09-26T07:00:00Z"),
    });
    delete paths["meta-data/tags/instance/clankie:tenant-id"];
    await expect(imds.identity()).rejects.toThrow();
  });
});
