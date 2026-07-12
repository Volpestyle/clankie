import { compileDoctrine, projectCaptainCeremony } from "@clankie/doctrine";
import type { TrackerIssueDraft } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  countSummarySentences,
  hasProseBeforeFirstHeading,
  validateIssueDraft,
} from "../src/issue-draft.ts";

function baseProjection(overrides?: {
  requireProductImpact?: boolean;
  maxSummarySentences?: number;
  heading?: string;
  sectionPlacement?: "first" | "after_summary" | "last";
  enabled?: boolean;
}) {
  const compiled = compileDoctrine([
    {
      schemaVersion: "1",
      id: "test-ceremony",
      description: "test",
      ceremony: {
        externalConnectors: "optional",
        integrationFlow: "pull_request",
        tracker: {
          issueDraft: {
            enabled: overrides?.enabled ?? true,
            requireProductImpact: overrides?.requireProductImpact ?? true,
            heading: overrides?.heading ?? "Product impact",
            sectionPlacement: overrides?.sectionPlacement ?? "first",
            maxSummarySentences: overrides?.maxSummarySentences ?? 3,
          },
          humanAttention: {
            enabled: true,
            defaultTargetRole: "operator",
            defaultRequestKind: "decision_needed",
            notifyWhenBlocking: true,
            notificationSurfaces: ["operator_inbox"],
            blockingUrgency: "elevated",
            directNotification: "required",
            waitForAuthoritativeResponse: true,
          },
        },
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
  ]);
  return projectCaptainCeremony(compiled);
}

function draft(overrides?: Partial<TrackerIssueDraft>): TrackerIssueDraft {
  return {
    schemaVersion: 1,
    draftId: "draft-1",
    missionId: "mission-1",
    correlationId: "corr-1",
    title: "Ship ceremony validation",
    objective: "Validate drafts before connector writes",
    productImpact: {
      schemaVersion: 1,
      summary: "Operators see clearer product impact on tracker drafts.",
      userVisibleChange: true,
      risk: "low",
      authorityImpact: "none",
    },
    acceptanceCriteria: ["Drafts without impact are rejected when required."],
    writeScope: [],
    createdAt: "2026-07-12T12:00:00.000Z",
    ...overrides,
  };
}

const productBody = "## Product impact\n\nUsers benefit from clearer impact.\n";

describe("countSummarySentences", () => {
  it("counts space-separated sentences", () => {
    expect(countSummarySentences("One. Two. Three. Four.")).toBe(4);
  });

  it("does not let HTML <br> separators compress four sentences into one", () => {
    expect(countSummarySentences("One.<br>Two.<br>Three.<br>Four.")).toBe(4);
    expect(countSummarySentences("One.<br/>Two.<br />Three.<BR>Four.")).toBe(4);
  });
});

describe("validateIssueDraft", () => {
  it("accepts a valid draft under default projection rules with body", () => {
    const result = validateIssueDraft({
      draft: draft(),
      projection: baseProjection(),
      bodyMarkdown: productBody,
    });
    expect(result.ok).toBe(true);
    expect(result.draft?.draftId).toBe("draft-1");
  });

  it("rejects overlong product-impact summaries using maxSummarySentences", () => {
    const result = validateIssueDraft({
      draft: draft({
        productImpact: {
          schemaVersion: 1,
          summary: "One. Two. Three. Four.",
          userVisibleChange: true,
          risk: "medium",
          authorityImpact: "narrow",
        },
      }),
      projection: baseProjection({ maxSummarySentences: 3 }),
      bodyMarkdown: productBody,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "product_impact_summary_too_long")).toBe(true);
  });

  it("rejects overlong summaries even when sentences are separated only by HTML br", () => {
    const result = validateIssueDraft({
      draft: draft({
        productImpact: {
          schemaVersion: 1,
          summary: "One.<br>Two.<br>Three.<br>Four.",
          userVisibleChange: true,
          risk: "medium",
          authorityImpact: "narrow",
        },
      }),
      projection: baseProjection({ maxSummarySentences: 3 }),
      bodyMarkdown: productBody,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "product_impact_summary_too_long")).toBe(true);
  });

  it("rejects omitted or empty bodyMarkdown when ceremony requires Product impact", () => {
    const omitted = validateIssueDraft({
      draft: draft(),
      projection: baseProjection({ requireProductImpact: true }),
    });
    expect(omitted.ok).toBe(false);
    expect(omitted.diagnostics.some((d) => d.code === "body_required")).toBe(true);

    const empty = validateIssueDraft({
      draft: draft(),
      projection: baseProjection({ requireProductImpact: true }),
      bodyMarkdown: "   \n  ",
    });
    expect(empty.ok).toBe(false);
    expect(empty.diagnostics.some((d) => d.code === "body_required")).toBe(true);
  });

  it("rejects any prose/content before the first required heading", () => {
    expect(hasProseBeforeFirstHeading("Intro text\n\n## Product impact\n\nBody")).toBe(true);
    expect(hasProseBeforeFirstHeading("## Product impact\n\nBody")).toBe(false);

    const result = validateIssueDraft({
      draft: draft(),
      projection: baseProjection({ heading: "Product impact", sectionPlacement: "first" }),
      bodyMarkdown: "Please review this draft first.\n\n## Product impact\n\nImpact text.",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "prose_before_heading")).toBe(true);
  });

  it("skips structural rules when issue-draft ceremony is disabled", () => {
    const result = validateIssueDraft({
      draft: { not: "a draft" },
      projection: baseProjection({ enabled: false }),
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics[0]?.code).toBe("ceremony_disabled");
  });

  it("enforces configurable heading and first placement on rendered body", () => {
    const projection = baseProjection({
      heading: "Why this matters",
      sectionPlacement: "first",
    });
    const missing = validateIssueDraft({
      draft: draft(),
      projection,
      bodyMarkdown: "## Summary\n\nHello\n\n## Why this matters\n\nImpact",
    });
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics.some((d) => d.code === "section_placement")).toBe(true);

    const ok = validateIssueDraft({
      draft: draft(),
      projection,
      bodyMarkdown: "## Why this matters\n\nImpact\n\n## Summary\n\nHello",
    });
    expect(ok.ok).toBe(true);
  });

  it("rejects schema-invalid drafts", () => {
    const result = validateIssueDraft({
      draft: { schemaVersion: 1, title: "" },
      projection: baseProjection(),
      bodyMarkdown: productBody,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "schema_invalid")).toBe(true);
  });
});
