import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createLogger, sanitizeForSupportBundle } from "../src/index.ts";

describe("support bundle redaction", () => {
  it("redacts nested secrets", () => {
    expect(sanitizeForSupportBundle({ nested: { apiKey: "secret", safe: "ok" } })).toEqual({
      nested: { apiKey: "[REDACTED]", safe: "ok" },
    });
  });

  it("redacts a discord_bot marker through support sanitization and structured logging", () => {
    const marker = "discord-bot-marker-must-not-survive";
    const credential = { providerId: "discord_bot", credential: { type: "api", key: marker } };
    expect(JSON.stringify(sanitizeForSupportBundle(credential))).not.toContain(marker);

    const destination = new PassThrough();
    let output = "";
    destination.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const logger = createLogger({ service: "redaction-fixture" }, { timestamp: false }, destination);
    logger.info(credential, "broker credential fixture");
    expect(output).not.toContain(marker);
    expect(output).toContain("[REDACTED]");
  });
});
