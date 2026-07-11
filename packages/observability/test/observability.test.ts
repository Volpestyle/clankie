import { describe, expect, it } from "vitest";
import { sanitizeForSupportBundle } from "../src/index.ts";

describe("support bundle redaction", () => {
  it("redacts nested secrets", () => {
    expect(sanitizeForSupportBundle({ nested: { apiKey: "secret", safe: "ok" } })).toEqual({
      nested: { apiKey: "[REDACTED]", safe: "ok" },
    });
  });
});
