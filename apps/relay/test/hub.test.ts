import { describe, expect, it } from "vitest";
import { isApprovalCompletionPayload, RelayEnvelopeSchema, RelayHelloSchema } from "../src/protocol.ts";

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

  it("rejects approval completion markers before opaque control routing", () => {
    expect(isApprovalCompletionPayload({ action: "approval.complete", approvalId: "approval-1" })).toBe(true);
    expect(isApprovalCompletionPayload({ approvalId: "approval-1", decision: "approved" })).toBe(true);
    expect(
      isApprovalCompletionPayload({
        nested: { more: { data: { approvalId: "approval-1", approved: false } } },
      }),
    ).toBe(true);
    expect(
      isApprovalCompletionPayload({ a: { b: { c: { d: { e: { f: { g: { h: { i: "too deep" } } } } } } } } }),
    ).toBe(true);
    expect(isApprovalCompletionPayload({ type: "approval.requested" })).toBe(false);
  });
});
