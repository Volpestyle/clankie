import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { toolJson } from "../src/captain/tools.ts";

describe("tool JSON previews", () => {
  it("preserves small results and the original details", () => {
    const value = { outcome: "ok", content: "A useful page\nwith two lines." };
    const result = toolJson(value);
    expect(result.content[0].text).toBe(JSON.stringify(value, null, 2));
    expect(result.details).toBe(value);
  });

  it.each(["é", "界", "🧙"])("does not split a UTF-8 character (%s)", (character) => {
    const value = character.repeat(DEFAULT_MAX_BYTES);
    const text = toolJson(value).content[0].text;
    const preview = text.split("\n\n[Output truncated")[0] ?? "";
    expect(preview).toContain(character);
    expect(preview).not.toContain("\uFFFD");
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(Buffer.byteLength(preview)).toBeGreaterThan(DEFAULT_MAX_BYTES - 4);
    expect(JSON.stringify(value).startsWith(preview)).toBe(true);
    expect(text).toContain(`truncated to ${Buffer.byteLength(preview)} of `);
  });

  it("still limits many short lines", () => {
    const value = Array.from({ length: DEFAULT_MAX_LINES + 10 }, () => 1);
    const serialized = JSON.stringify(value, null, 2);
    const preview = serialized.split("\n").slice(0, DEFAULT_MAX_LINES).join("\n");
    expect(toolJson(value).content[0].text).toBe(
      `${preview}\n\n[Output truncated to ${Buffer.byteLength(preview)} of ${Buffer.byteLength(serialized)} bytes; request a narrower result.]`,
    );
  });
});
