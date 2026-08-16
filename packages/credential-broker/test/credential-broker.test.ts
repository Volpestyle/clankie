import { describe, expect, it } from "vitest";
import {
  CapabilityTokenError,
  CapabilityTokenIssuer,
  MAX_CAPABILITY_TTL_SECONDS,
  type CapabilityGrant,
} from "../src/index.ts";

const grant: CapabilityGrant = {
  version: 1,
  grantId: "g1",
  principalId: "worker-1",
  missionId: "m1",
  profileHash: "profile-1",
  capabilities: ["github.pr.comment"],
  resources: ["acme/repo#12"],
  obligations: ["use_merge_queue"],
  issuedAt: 100,
  expiresAt: 200,
  nonce: "12345678",
};

describe("CapabilityTokenIssuer", () => {
  it("issues bounded, expiring grants", () => {
    const issuer = new CapabilityTokenIssuer(Buffer.alloc(32, 7));
    const token = issuer.issue(grant);
    const verified = issuer.verify(token, 150);
    expect(verified.allows("github.pr.comment", "acme/repo#12")).toBe(true);
    expect(verified.allows("github.pr.merge", "acme/repo#12")).toBe(false);
    expect(() => issuer.verify(token, 201)).toThrow(/expired/);
  });

  it("rejects invalid or overly long windows and tokens used before their issue time", () => {
    const issuer = new CapabilityTokenIssuer(Buffer.alloc(32, 7));
    expect(() => issuer.issue({ ...grant, expiresAt: grant.issuedAt })).toThrow(/expiresAt/);
    expect(() =>
      issuer.issue({ ...grant, expiresAt: grant.issuedAt + MAX_CAPABILITY_TTL_SECONDS + 1 }),
    ).toThrow(/lifetime/);
    const token = issuer.issue(grant);
    expect(() => issuer.verify(token, 99)).toThrow(CapabilityTokenError);
    expect(() => issuer.verify(token, 99)).toThrow(/not yet valid/);
  });

  it("rejects noncanonical token encoding", () => {
    const issuer = new CapabilityTokenIssuer(Buffer.alloc(32, 7));
    const token = issuer.issue(grant);
    expect(() => issuer.verify(`${token}!`, 150)).toThrow(/encoding/);
  });

  it("requires a matching resource when the grant is resource-scoped", () => {
    const issuer = new CapabilityTokenIssuer(Buffer.alloc(32, 7));
    const verified = issuer.verify(issuer.issue(grant), 150);
    expect(verified.allows("github.pr.comment", "acme/repo#12")).toBe(true);
    expect(verified.allows("github.pr.comment")).toBe(false);
    expect(verified.allows("github.pr.comment", "acme/other#12")).toBe(false);
    expect(verified.grant.obligations).toEqual(["use_merge_queue"]);
  });
});
