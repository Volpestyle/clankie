import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileDoctrine,
  defaultTrackerCeremony,
  DoctrineOverlaySchema,
  projectCaptainCeremony,
  type OrchestrationProfile,
} from "../src/index.ts";

function basePreset(overrides: Partial<OrchestrationProfile> = {}): OrchestrationProfile {
  return {
    schemaVersion: "1",
    id: "ceremony-test",
    description: "Tracker ceremony unit fixture",
    kind: "preset",
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
      defaultExecution: "runner_visible",
      route: [],
    },
    verification: {
      independentVerifier: true,
      differentHarnessPreferred: true,
      requireEvidence: true,
      requiredChecks: ["typecheck", "unit"],
    },
    budgets: {
      maxMissionCostUsd: 5,
      maxTaskRetries: 1,
      maxMissionWallMinutes: 30,
    },
    authority: {},
    actions: {
      "test.integrity.weaken": { default: "deny", rules: [] },
    },
    memory: {
      rawTranscriptRetentionDays: 7,
      inferredFacts: "require_approval",
      publicToPrivatePropagation: false,
    },
    ...overrides,
  };
}

describe("VUH-845 doctrine tracker ceremony", () => {
  it("compiles deterministic captain projection defaults from a base ceremony", () => {
    const compiled = compileDoctrine([basePreset()]);
    const projection = projectCaptainCeremony(compiled);
    expect(projection.profileId).toBe("ceremony-test");
    expect(projection.profileHash).toMatch(/^[0-9a-f]{16}$/);
    expect(projection.externalConnectors).toBe("optional");
    expect(projection.integrationFlow).toBe("pull_request");
    // Five VUH-844 controls with stated defaults when unset
    expect(projection.issueDraft).toEqual({
      enabled: true,
      requireProductImpact: true,
      heading: "Product impact",
      sectionPlacement: "first",
      maxSummarySentences: 3,
    });
    expect(projection.humanAttention.defaultTargetRole).toBe("operator");
    expect(projection.humanAttention.notificationSurfaces).toEqual(["captain_lane", "operator_inbox"]);
    expect(projection.humanAttention.directNotification).toBe("required");
    expect(projection.humanAttention.waitForAuthoritativeResponse).toBe(true);
    expect(projection.independentVerifierRequired).toBe(true);

    // Determinism: same profile → same projection
    const again = projectCaptainCeremony(compileDoctrine([basePreset()]));
    expect(again).toEqual(projection);
  });

  it("applies non-overlay ceremony.tracker overrides via layer merge", () => {
    const base = basePreset();
    const overrideLayer: Partial<OrchestrationProfile> = {
      schemaVersion: "1",
      id: "ceremony-override",
      description: "Override tracker ceremony only",
      ceremony: {
        externalConnectors: "optional",
        integrationFlow: "pull_request",
        tracker: {
          issueDraft: {
            enabled: false,
            requireProductImpact: false,
            heading: "Impact",
            sectionPlacement: "last",
            maxSummarySentences: 1,
          },
          humanAttention: {
            enabled: true,
            defaultTargetRole: "reviewer",
            defaultRequestKind: "review_needed",
            notifyWhenBlocking: false,
            notificationSurfaces: ["workspace_surface"],
            blockingUrgency: "routine",
            directNotification: "best_effort",
            waitForAuthoritativeResponse: false,
          },
        },
      },
    };
    const compiled = compileDoctrine([base, overrideLayer]);
    const projection = projectCaptainCeremony(compiled);
    expect(projection.issueDraft.enabled).toBe(false);
    expect(projection.issueDraft.heading).toBe("Impact");
    expect(projection.issueDraft.sectionPlacement).toBe("last");
    expect(projection.issueDraft.maxSummarySentences).toBe(1);
    expect(projection.humanAttention.defaultTargetRole).toBe("reviewer");
    expect(projection.humanAttention.notificationSurfaces).toEqual(["workspace_surface"]);
    expect(projection.humanAttention.notifyWhenBlocking).toBe(false);
    expect(projection.humanAttention.directNotification).toBe("best_effort");
    expect(projection.humanAttention.waitForAuthoritativeResponse).toBe(false);
    // Overlay floor: independent verifier still required
    expect(compiled.profile.verification.independentVerifier).toBe(true);
  });

  it("rejects overlay layers that attempt to carry ceremony", () => {
    expect(() =>
      DoctrineOverlaySchema.parse({
        schemaVersion: "1",
        id: "bad-overlay",
        description: "must not set ceremony",
        kind: "overlay",
        ceremony: {
          externalConnectors: "none",
          integrationFlow: "direct_main",
        },
      }),
    ).toThrow();
  });

  it("strips overlay ceremony at merge and preserves base ceremony + deny floor", () => {
    const base = basePreset({
      ceremony: {
        externalConnectors: "required",
        integrationFlow: "review_gate",
      },
      actions: {
        "test.integrity.weaken": { default: "deny", rules: [] },
        "shell.destructive": { default: "require_approval", rules: [] },
      },
    });
    // Pass a layer shaped like an overlay after DoctrineOverlaySchema strip would
    // have run; compileDoctrine applyLayer drops ceremony/authority on kind=overlay.
    const overlay = {
      schemaVersion: "1" as const,
      id: "tighten",
      description: "tighten budgets only",
      kind: "overlay" as const,
      budgets: {
        maxMissionCostUsd: 1,
        maxTaskRetries: 0,
        maxMissionWallMinutes: 10,
      },
      actions: {
        "test.integrity.weaken": { default: "allow" as const, rules: [] },
      },
    };
    const compiled = compileDoctrine([base, overlay]);
    expect(compiled.profile.ceremony).toEqual({
      externalConnectors: "required",
      integrationFlow: "review_gate",
    });
    // preserveHigherScopeDenies keeps the base deny
    expect(compiled.profile.actions["test.integrity.weaken"]?.default).toBe("deny");
    expect(compiled.profile.verification.independentVerifier).toBe(true);
    const projection = projectCaptainCeremony(compiled);
    // required + review_gate defaults including the five ceremony controls
    expect(projection.issueDraft.requireProductImpact).toBe(true);
    expect(projection.issueDraft.heading).toBe("Product impact");
    expect(projection.issueDraft.sectionPlacement).toBe("first");
    expect(projection.issueDraft.maxSummarySentences).toBe(3);
    expect(projection.humanAttention.defaultTargetRole).toBe("product_steward");
    expect(projection.humanAttention.directNotification).toBe("required");
    expect(projection.humanAttention.waitForAuthoritativeResponse).toBe(true);
  });

  it("rejects compilation that weakens the independent-verifier floor", () => {
    expect(() =>
      compileDoctrine([
        basePreset({
          verification: {
            independentVerifier: false,
            differentHarnessPreferred: true,
            requireEvidence: true,
            requiredChecks: ["unit"],
          },
        }),
      ]),
    ).toThrow(/independent verifier/i);
  });

  it("selects distinct defaults for none/direct, optional/pr, and required/review ceremonies", () => {
    expect(
      defaultTrackerCeremony({ externalConnectors: "none", integrationFlow: "direct_main" }).issueDraft
        .enabled,
    ).toBe(false);
    expect(
      defaultTrackerCeremony({ externalConnectors: "optional", integrationFlow: "pull_request" })
        .humanAttention.blockingUrgency,
    ).toBe("elevated");
    expect(
      defaultTrackerCeremony({ externalConnectors: "required", integrationFlow: "review_gate" })
        .humanAttention.notificationSurfaces,
    ).toContain("workspace_surface");
  });

  it("keeps doctrine ceremony source free of forbidden provider/user nouns", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../src/index.ts"), "utf8");
    // Scope to the captain ceremony projection block (VUH-845) only.
    const start = source.indexOf("/** Five VUH-844/845 ceremony controls");
    const end = source.indexOf("// Re-export ceremony field schemas");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const ceremonySource = source
      .slice(start, end)
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/u, "").replace(/\/\*[\s\S]*?\*\//gu, ""))
      .join("\n")
      .toLowerCase();
    for (const noun of ["linear", "github", "jira", "email", "mention", "assignment", "label", "james"]) {
      expect(ceremonySource).not.toContain(noun);
    }
  });
});
