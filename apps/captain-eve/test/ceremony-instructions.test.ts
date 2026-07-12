import { compileDoctrine, projectCaptainCeremony, type CaptainCeremonyProjection } from "@clankie/doctrine";
import { describe, expect, it } from "vitest";
import {
  captainCeremonyInstructions,
  ceremonyProjectionFromChannel,
  isTrustedCeremonyProjection,
  resolveTrustedCeremonyProjection,
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
    const markdown = captainCeremonyInstructions(
      { metadata: { ceremonyProjection: proj } },
      proj,
    );
    expect(markdown).toContain("Tracker ceremony (compiled projection)");
    expect(markdown).toContain(proj.profileId);
    expect(markdown).toContain("Product impact");
    expect(markdown).toContain("operator");
    expect(markdown).not.toMatch(/James|gmail\.com|@|label:|Linear/iu);
    expect(ceremonyProjectionFromChannel({ metadata: { ceremonyProjection: proj } })?.profileHash).toBe(
      proj.profileHash,
    );
  });

  it("falls back safely when no trusted projection is supplied", () => {
    const markdown = captainCeremonyInstructions({});
    expect(markdown).toContain("No trusted compiled ceremony projection");
    expect(markdown).not.toMatch(/James|gmail\.com/iu);
  });

  it("rejects mismatched/untrusted channel projection that disables ceremony controls", () => {
    const trusted = projection();
    const malicious = {
      ...trusted,
      issueDraft: { ...trusted.issueDraft, enabled: false, requireProductImpact: false },
      humanAttention: { ...trusted.humanAttention, enabled: false },
      independentVerifierRequired: false,
    } as CaptainCeremonyProjection;

    expect(isTrustedCeremonyProjection(malicious, trusted)).toBe(false);
    expect(resolveTrustedCeremonyProjection({ metadata: { ceremonyProjection: malicious } }, trusted)).toEqual(
      { rejected: true, reason: "untrusted_ceremony_projection" },
    );

    const markdown = captainCeremonyInstructions(
      { metadata: { ceremonyProjection: malicious } },
      trusted,
    );
    expect(markdown).toContain("Rejected untrusted ceremony projection");
    expect(markdown).toContain("Using the trusted compiled doctrine projection only");
    // Trusted projection still governs instructions — cannot disable via metadata.
    expect(markdown).toContain("Enabled: yes");
    expect(markdown).toContain(`Independent verifier required: ${trusted.independentVerifierRequired ? "yes" : "no"}`);
  });
});
