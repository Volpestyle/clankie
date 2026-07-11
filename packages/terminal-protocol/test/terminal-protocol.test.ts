import { describe, expect, it } from "vitest";
import { decodeTerminalBytes, encodeTerminalBytes } from "../src/index.ts";

describe("terminal protocol", () => {
  it("round-trips raw terminal bytes", () => {
    const bytes = new TextEncoder().encode("hello\u001b[31m");
    expect(decodeTerminalBytes(encodeTerminalBytes(bytes))).toEqual(bytes);
  });
});
