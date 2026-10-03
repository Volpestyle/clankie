import { describe, expect, it } from "vitest";
import { BodyLeaseRequestSchema, BodyLeaseResultSchema, BodyLeaseViewSchema } from "../src/body-leases.ts";

describe("conversation body lease contract", () => {
  it("requires exact incarnation for held mutations and rejects unrelated action fields", () => {
    const common = { resource: "voice", conversationId: "thread-a" };
    expect(BodyLeaseRequestSchema.safeParse({ ...common, action: "release" }).success).toBe(false);
    expect(BodyLeaseRequestSchema.safeParse({ ...common, action: "renew", ttlMs: 1000 }).success).toBe(false);
    expect(
      BodyLeaseRequestSchema.safeParse({ ...common, action: "acquire", ttlMs: 1000, text: "extra" }).success,
    ).toBe(false);
    expect(
      BodyLeaseRequestSchema.safeParse({ ...common, action: "queue", ttlMs: 300001, request: "next" })
        .success,
    ).toBe(false);
    expect(
      BodyLeaseRequestSchema.safeParse({ ...common, action: "ask", ttlMs: 1000, request: "next" }).success,
    ).toBe(true);
  });

  it("public busy status carries attribution but rejects private incarnation tokens", () => {
    const lease = { resource: "browser", conversationId: "thread-a", state: "active", expiresAt: 1000 };
    expect(
      BodyLeaseResultSchema.safeParse({ outcome: "busy", lease, actions: ["queue", "ask"] }).success,
    ).toBe(true);
    expect(BodyLeaseViewSchema.safeParse({ ...lease, token: "hidden" }).success).toBe(false);
    expect(
      BodyLeaseResultSchema.safeParse({ outcome: "busy", lease, token: "hidden", actions: [] }).success,
    ).toBe(false);
  });
});
