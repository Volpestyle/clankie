import { describe, expect, it } from "vitest";
import { CapabilityTokenIssuer } from "../src/index.ts";

describe("CapabilityTokenIssuer", () => {
  it("issues bounded, expiring grants", () => {
    const issuer = new CapabilityTokenIssuer(Buffer.alloc(32, 7));
    const token = issuer.issue({
      version: 1,
      grantId: "g1",
      principalId: "worker-1",
      missionId: "m1",
      profileHash: "profile-1",
      capabilities: ["github.pr.comment"],
      resources: ["acme/repo#12"],
      obligations: [],
      issuedAt: 100,
      expiresAt: 200,
      nonce: "12345678",
    });
    const verified = issuer.verify(token, 150);
    expect(verified.allows("github.pr.comment", "acme/repo#12")).toBe(true);
    expect(verified.allows("github.pr.merge", "acme/repo#12")).toBe(false);
    expect(() => issuer.verify(token, 201)).toThrow(/expired/);
  });
});
