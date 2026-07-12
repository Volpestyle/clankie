import { compileDoctrine, projectCaptainCeremony, type CaptainCeremonyProjection } from "@clankie/doctrine";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  captainCeremonyInstructions,
  verifyCeremonyProjectionEnvelope,
} from "../lib/ceremony-instructions.ts";

function projection() {
  return projectCaptainCeremony(
    compileDoctrine([
      {
        schemaVersion: "1",
        id: "captain-ceremony-test",
        description: "test",
        ceremony: {
          externalConnectors: "optional",
          integrationFlow: "pull_request",
        },
        planning: {
          requirePlanApproval: true,
          scopeExpansion: "ask",
          targetReviewMinutes: 20,
          softChangedLines: 300,
          hardChangedLines: 800,
          maxLogicalConcernsPerPr: 1,
        },
        topology: {
          maxParallelWorkers: 2,
          maxDelegationDepth: 1,
          defaultExecution: "automatic",
          route: [],
        },
        verification: {
          independentVerifier: true,
          differentHarnessPreferred: true,
          requireEvidence: true,
          requiredChecks: ["typecheck"],
        },
        budgets: { maxMissionCostUsd: 10, maxTaskRetries: 1, maxMissionWallMinutes: 60 },
        authority: {},
        actions: {},
        memory: {
          rawTranscriptRetentionDays: 7,
          inferredFacts: "require_approval",
          publicToPrivatePropagation: false,
        },
      },
    ]),
  );
}

describe("captain ceremony instructions", () => {
  it("renders the trusted projection without provider nouns", () => {
    const proj = projection();
    const markdown = captainCeremonyInstructions(proj);
    expect(markdown).toContain("Tracker ceremony (compiled projection)");
    expect(markdown).toContain(proj.profileId);
    expect(markdown).toContain("Product impact");
    expect(markdown).toContain("operator");
    expect(markdown).not.toMatch(/James|gmail\.com|@|label:|Linear/iu);
  });

  it("falls back safely when no trusted projection is supplied", () => {
    const markdown = captainCeremonyInstructions();
    expect(markdown).toContain("No trusted compiled ceremony projection");
    expect(markdown).not.toMatch(/James|gmail\.com/iu);
  });

  it("accepts only a correctly signed projection envelope", () => {
    const trusted = projection();
    const token = "captain-secret";
    const malicious = {
      ...trusted,
      issueDraft: { ...trusted.issueDraft, enabled: false, requireProductImpact: false },
      humanAttention: { ...trusted.humanAttention, enabled: false },
      independentVerifierRequired: false,
    } as CaptainCeremonyProjection;

    expect(
      verifyCeremonyProjectionEnvelope(
        { ceremonyProjection: malicious, ceremonyProjectionSignature: sign(trusted, token) },
        token,
      ),
    ).toBeUndefined();
    expect(verifyCeremonyProjectionEnvelope({ ceremonyProjection: malicious }, token)).toBeUndefined();
    expect(
      verifyCeremonyProjectionEnvelope(
        { ceremonyProjection: trusted, ceremonyProjectionSignature: sign(trusted, token) },
        token,
      ),
    ).toEqual(trusted);
  });
});

function sign(projection: CaptainCeremonyProjection, token: string): string {
  return createHmac("sha256", token)
    .update(`clankie:captain-ceremony:v1\0${JSON.stringify(projection)}`)
    .digest("hex");
}
