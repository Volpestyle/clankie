import { describe, expect, it } from "vitest";
import { writeCheckReport } from "../src/check-report.ts";

describe("writeCheckReport", () => {
  it("prints PASS/FAIL lines, remediation, and the title outcome", () => {
    let out = "";
    writeCheckReport({
      checks: [
        { name: "gateway", ok: true, detail: "ready" },
        { name: "voice", ok: false, detail: "missing", remediation: "set the token" },
      ],
      json: false,
      jsonPayload: {},
      title: "Discord text readiness",
      outcome: "NOT READY",
      write: (text) => {
        out += text;
      },
    });
    const width = Math.max("gateway".length, "voice".length);
    expect(out).toBe(
      [
        `PASS  ${"gateway".padEnd(width)}  ready`,
        `FAIL  ${"voice".padEnd(width)}  missing`,
        `      ${"".padEnd(width)}  set the token`,
        "",
        "Discord text readiness: NOT READY",
        "",
      ].join("\n"),
    );
  });

  it("dumps JSON when requested and skips the text layout", () => {
    let out = "";
    writeCheckReport({
      checks: [{ name: "gateway", ok: true, detail: "ready" }],
      json: true,
      jsonPayload: { ready: false },
      title: "ignored",
      outcome: "ignored",
      preamble: "should not print",
      write: (text) => {
        out += text;
      },
    });
    expect(out).toBe(`${JSON.stringify({ ready: false }, null, 2)}\n`);
  });
});
