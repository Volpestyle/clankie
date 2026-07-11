import { describe, expect, it } from "vitest";
import { StrictJsonlDecoder } from "../src/index.ts";

describe("StrictJsonlDecoder", () => {
  it("splits only on LF and preserves Unicode separators inside strings", () => {
    const decoder = new StrictJsonlDecoder();
    const input = Buffer.from('{"text":"a\\u2028b"}\n{"ok":true}\r\n');
    expect(decoder.push(input)).toEqual([{ text: "a\u2028b" }, { ok: true }]);
  });

  it("handles fragmented records", () => {
    const decoder = new StrictJsonlDecoder();
    expect(decoder.push(Buffer.from('{"a"'))).toEqual([]);
    expect(decoder.push(Buffer.from(":1}\n"))).toEqual([{ a: 1 }]);
  });
});
