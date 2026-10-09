import { describe, expect, it } from "vitest";
import { writeCheckReport } from "../src/check-report.ts";

describe("writeCheckReport", () => {
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
