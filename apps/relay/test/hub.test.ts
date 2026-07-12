import { describe, expect, it } from "vitest";
import { RelayEnvelopeSchema, RelayHelloSchema } from "../src/protocol.ts";

describe("relay protocol", () => {
  it("separates terminal and semantic control planes", () => {
    const hello = RelayHelloSchema.parse({
      type: "hello",
      role: "client",
      workspaceId: "w1",
      deviceId: "d1",
      token: "0123456789abcdef",
    });
    const envelope = RelayEnvelopeSchema.parse({
      type: "relay",
      plane: "terminal",
      workspaceId: "w1",
      sequence: 1,
      payload: { terminalId: "t1" },
    });
    expect(hello.workspaceId).toBe(envelope.workspaceId);
    expect(envelope.plane).toBe("terminal");
  });
});
