import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BODY_TELEMETRY_SPOOL_BYTES_MAX,
  bodyTelemetryFromEnv,
  createBodyTelemetry,
  parseBodyTelemetryLine,
  pruneSpool,
  spoolFileName,
  turnTelemetry,
  type BodyTelemetryInput,
} from "../src/body-telemetry.ts";

const PROMPT = "Refactor the billing module in acme-private-repo and email the diff to dana@example.com";
const FAKE_KEY = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE-telemetry-marker";
const NOW = Date.parse("2026-09-26T06:00:00.000Z");

function spool() {
  const dir = mkdtempSync(join(tmpdir(), "body-telemetry-"));
  const telemetry = createBodyTelemetry({ dir, writer: "service", clock: () => NOW });
  const lines = () =>
    readdirSync(dir)
      .sort()
      .flatMap((name) =>
        readFileSync(join(dir, name), "utf8")
          .split("\n")
          .filter((line) => line.length > 0),
      );
  return { dir, telemetry, lines };
}

describe("body telemetry redaction boundary", () => {
  it("never writes a prompt or a model key, whatever a caller hands the emitter", () => {
    const { telemetry, lines } = spool();
    // Content smuggled beside valid fields: the strict schema drops the whole event.
    const smuggled = [
      { event: "body.turn", outcome: "completed", toolCalls: 1, mutatingCalls: 0, prompt: PROMPT },
      { event: "body.turn", outcome: "failed", toolCalls: 0, mutatingCalls: 0, apiKey: FAKE_KEY },
      { event: "body.service", service: "clankie", state: "crashed", reason: PROMPT },
      { event: "body.service", service: "clankie", state: "crashed", reason: FAKE_KEY },
      { event: "body.service", service: "clankie", state: "crashed", signal: "sk-live-abcdef" },
      { event: "body.shutdown", reason: "sigterm", text: PROMPT },
      { event: "body.gateway", state: "disconnected", error: FAKE_KEY },
      { event: "body.turn", outcome: "completed", toolCalls: 1, mutatingCalls: 0, requestId: PROMPT },
      { event: "body.support", grantId: FAKE_KEY, action: "granted", scope: "shell" },
      { event: "body.prompt", text: PROMPT },
    ];
    for (const event of smuggled) telemetry.emit(event as unknown as BodyTelemetryInput);

    // A real settled turn whose tool names were chosen by the owner (an MCP
    // server named after a key) still ships counts only.
    telemetry.emit(
      turnTelemetry({
        outcome: "completed",
        acceptedAt: "2026-09-26T05:59:00.000Z",
        completedAt: "2026-09-26T05:59:42.500Z",
        toolCount: { bash: 3, [`mcp__${FAKE_KEY}__read`]: 2, [PROMPT]: 1 },
        mutatingCount: 1,
      }),
    );
    telemetry.emit({ event: "body.shutdown", reason: "sigterm" });

    const written = lines();
    const text = written.join("\n");
    for (const needle of [
      PROMPT,
      FAKE_KEY,
      "acme-private-repo",
      "dana@example.com",
      "sk-ant",
      "sk-live",
      "FAKEFAKE",
    ]) {
      expect(text).not.toContain(needle);
    }
    expect(written.map((line) => JSON.parse(line))).toEqual([
      {
        v: 1,
        atMs: Date.parse("2026-09-26T05:59:42.500Z"),
        event: "body.turn",
        outcome: "completed",
        durationMs: 42_500,
        toolCalls: 6,
        mutatingCalls: 1,
      },
      { v: 1, atMs: NOW, event: "body.shutdown", reason: "sigterm" },
    ]);
  });

  it("parses only lines that match an event schema exactly", () => {
    expect(
      parseBodyTelemetryLine(JSON.stringify({ v: 1, atMs: NOW, event: "body.shutdown", reason: "sigterm" })),
    ).toBeDefined();
    expect(
      parseBodyTelemetryLine(
        JSON.stringify({ v: 1, atMs: NOW, event: "body.shutdown", reason: "sigterm", tenantId: "tn_other" }),
      ),
    ).toBeUndefined();
    expect(parseBodyTelemetryLine(PROMPT)).toBeUndefined();
    expect(
      parseBodyTelemetryLine(`{"v":1,"atMs":${NOW},"event":"body.shutdown","reason":"${"x".repeat(3000)}"}`),
    ).toBeUndefined();
  });
});

describe("the spool", () => {
  it("is off unless the body names a directory", () => {
    expect(bodyTelemetryFromEnv({}, "service")).toBeUndefined();
    expect(bodyTelemetryFromEnv({ CLANKIE_BODY_TELEMETRY_DIR: "" }, "service")).toBeUndefined();
    expect(bodyTelemetryFromEnv({ CLANKIE_BODY_TELEMETRY_DIR: tmpdir() }, "service")).toBeDefined();
  });

  it("writes hourly files named by writer, and never throws", () => {
    const { dir, telemetry } = spool();
    telemetry.emit({ event: "body.boot", phase: "clankie-healthy", sinceStartMs: 1200 });
    expect(readdirSync(dir)).toEqual(["2026092606-service.jsonl"]);
    const broken = createBodyTelemetry({ dir: "/proc/not-writable/telemetry", writer: "service" });
    expect(() => broken.emit({ event: "body.shutdown", reason: "sigterm" })).not.toThrow();
  });

  it("drops the oldest hours past the age or byte bound", () => {
    const dir = mkdtempSync(join(tmpdir(), "body-telemetry-prune-"));
    const hour = 3_600_000;
    writeFileSync(join(dir, spoolFileName(NOW - 72 * hour, "service")), "x\n");
    writeFileSync(
      join(dir, spoolFileName(NOW - 3 * hour, "body")),
      "x".repeat(BODY_TELEMETRY_SPOOL_BYTES_MAX),
    );
    writeFileSync(join(dir, spoolFileName(NOW - 2 * hour, "service")), "y\n");
    writeFileSync(join(dir, spoolFileName(NOW, "service")), "z\n");
    pruneSpool(dir, NOW);
    expect(readdirSync(dir).sort()).toEqual([
      spoolFileName(NOW - 2 * hour, "service"),
      spoolFileName(NOW, "service"),
    ]);
  });
});
