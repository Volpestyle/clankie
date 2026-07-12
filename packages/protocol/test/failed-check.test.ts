import { describe, expect, it } from "vitest";
import { FailedCheckSchema, WorkerResultSchema } from "../src/index.ts";

// VUH-828: additive structured failed-check carrier on WorkerResult.

describe("VUH-828 WorkerResult.failedCheck", () => {
  it("accepts a valid structured failed-check on WorkerResult", () => {
    const result = WorkerResultSchema.parse({
      status: "failed",
      summary: "Trusted runner verification checks did not pass.",
      diagnosis: "unit exited 1",
      failedCheck: { command: "unit", exitCode: 1 },
    });
    expect(result.failedCheck).toEqual({ command: "unit", exitCode: 1 });
  });

  it("keeps failedCheck optional so existing WorkerResult fixtures stay valid", () => {
    const result = WorkerResultSchema.parse({
      status: "succeeded",
      summary: "ok",
    });
    expect(result.failedCheck).toBeUndefined();
    expect(result.evidence).toEqual([]);
    expect(result.outputs).toEqual({});
  });

  it("rejects malformed failedCheck payloads", () => {
    expect(() => FailedCheckSchema.parse({ command: "", exitCode: 1 })).toThrow();
    expect(() => FailedCheckSchema.parse({ command: "unit", exitCode: 1.5 })).toThrow();
    expect(() =>
      WorkerResultSchema.parse({
        status: "failed",
        summary: "nope",
        failedCheck: { command: "unit", exitCode: "1" },
      }),
    ).toThrow();
  });
});
