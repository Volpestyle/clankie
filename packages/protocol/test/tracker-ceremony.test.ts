import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CeremonyTargetRoleSchema,
  HumanAttentionRequestSchema,
  HumanAttentionResponseSchema,
  ProductImpactSchema,
  TrackerIssueDraftSchema,
} from "../src/index.ts";

const validImpact = {
  schemaVersion: 1 as const,
  summary: "Operators see a deterministic ceremony projection without a connector.",
  userVisibleChange: true,
  risk: "low" as const,
  authorityImpact: "narrow" as const,
};

const validDraft = {
  schemaVersion: 1 as const,
  draftId: "draft-ceremony-1",
  missionId: "mission-ceremony",
  correlationId: "corr-ceremony-1",
  title: "Configurable tracker ceremony",
  objective: "Define connector-neutral draft and human-attention contracts.",
  productImpact: validImpact,
  acceptanceCriteria: [
    "Schemas validate required ceremony fields",
    "No provider nouns appear in the protocol surface",
  ],
  writeScope: ["packages/protocol/**"],
  createdAt: "2026-07-12T12:00:00.000Z",
};

const validAttentionRequest = {
  schemaVersion: 1 as const,
  requestId: "attn-1",
  missionId: "mission-ceremony",
  correlationId: "corr-ceremony-1",
  targetRole: "operator" as const,
  requestKind: "decision_needed" as const,
  actionableAsk: "Confirm the ceremony defaults for the structured preset.",
  blocking: true,
  authorityImpact: "narrow" as const,
  notificationSurfaces: ["captain_lane" as const, "operator_inbox" as const],
  trackerRef: { correlationId: "corr-ceremony-1", externalRef: "opaque-ref-1" },
  createdAt: "2026-07-12T12:05:00.000Z",
};

describe("VUH-845 tracker ceremony protocol", () => {
  it("accepts a valid issue draft with product impact", () => {
    const draft = TrackerIssueDraftSchema.parse(validDraft);
    expect(draft.draftId).toBe("draft-ceremony-1");
    expect(draft.productImpact.authorityImpact).toBe("narrow");
    expect(draft.writeScope).toEqual(["packages/protocol/**"]);
  });

  it("rejects an issue draft missing product impact or acceptance criteria", () => {
    expect(() => TrackerIssueDraftSchema.parse({ ...validDraft, productImpact: undefined })).toThrow();
    expect(() => TrackerIssueDraftSchema.parse({ ...validDraft, acceptanceCriteria: [] })).toThrow();
    expect(() => ProductImpactSchema.parse({ ...validImpact, summary: "" })).toThrow();
  });

  it("accepts a valid human-attention request and response", () => {
    const request = HumanAttentionRequestSchema.parse(validAttentionRequest);
    expect(request.blocking).toBe(true);
    expect(request.targetRole).toBe("operator");
    expect(request.urgency).toBe("elevated");

    const response = HumanAttentionResponseSchema.parse({
      schemaVersion: 1,
      responseId: "attn-resp-1",
      requestId: request.requestId,
      correlationId: request.correlationId,
      actorRole: "operator",
      decision: "approve",
      rationale: "Structured ceremony defaults are correct for this workspace.",
      createdAt: "2026-07-12T12:10:00.000Z",
    });
    expect(response.decision).toBe("approve");
    expect(response.actorRole).toBe("operator");
  });

  it("rejects human-attention payloads with missing role, ask, or surfaces", () => {
    expect(() =>
      HumanAttentionRequestSchema.parse({ ...validAttentionRequest, targetRole: "owner" }),
    ).toThrow();
    expect(() =>
      HumanAttentionRequestSchema.parse({ ...validAttentionRequest, actionableAsk: "" }),
    ).toThrow();
    expect(() =>
      HumanAttentionRequestSchema.parse({ ...validAttentionRequest, notificationSurfaces: [] }),
    ).toThrow();
    expect(() =>
      HumanAttentionResponseSchema.parse({
        schemaVersion: 1,
        responseId: "r1",
        requestId: "attn-1",
        correlationId: "c1",
        actorRole: "operator",
        decision: "maybe",
        rationale: "no",
        createdAt: "2026-07-12T12:10:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects whitespace-only actionableAsk and authored decision text", () => {
    expect(() =>
      HumanAttentionRequestSchema.parse({ ...validAttentionRequest, actionableAsk: "   \t\n  " }),
    ).toThrow();
    expect(() =>
      HumanAttentionResponseSchema.parse({
        schemaVersion: 1,
        responseId: "attn-resp-ws",
        requestId: "attn-1",
        correlationId: "corr-ceremony-1",
        actorRole: "operator",
        decision: "approve",
        rationale: "   ",
        createdAt: "2026-07-12T12:10:00.000Z",
      }),
    ).toThrow();
    expect(() => ProductImpactSchema.parse({ ...validImpact, summary: " \n " })).toThrow();
  });

  it("rejects expiresAt that is not strictly after createdAt", () => {
    expect(() =>
      HumanAttentionRequestSchema.parse({
        ...validAttentionRequest,
        createdAt: "2026-07-12T12:05:00.000Z",
        expiresAt: "2026-07-12T12:05:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      HumanAttentionRequestSchema.parse({
        ...validAttentionRequest,
        createdAt: "2026-07-12T12:05:00.000Z",
        expiresAt: "2026-07-12T12:00:00.000Z",
      }),
    ).toThrow();
    const ok = HumanAttentionRequestSchema.parse({
      ...validAttentionRequest,
      createdAt: "2026-07-12T12:05:00.000Z",
      expiresAt: "2026-07-12T13:00:00.000Z",
    });
    expect(ok.expiresAt).toBe("2026-07-12T13:00:00.000Z");
  });

  it("rejects conflicting top-level and nested tracker correlationIds", () => {
    expect(() =>
      HumanAttentionRequestSchema.parse({
        ...validAttentionRequest,
        correlationId: "corr-top",
        trackerRef: { correlationId: "corr-nested", externalRef: "opaque" },
      }),
    ).toThrow();
    expect(() =>
      TrackerIssueDraftSchema.parse({
        ...validDraft,
        correlationId: "corr-top",
        trackerRef: { correlationId: "corr-nested" },
      }),
    ).toThrow();
    expect(() =>
      HumanAttentionResponseSchema.parse({
        schemaVersion: 1,
        responseId: "attn-resp-1",
        requestId: "attn-1",
        correlationId: "corr-top",
        actorRole: "operator",
        decision: "approve",
        rationale: "ok",
        trackerRef: { correlationId: "corr-nested" },
        createdAt: "2026-07-12T12:10:00.000Z",
      }),
    ).toThrow();
  });

  it("exposes only semantic target roles (no provider principal nouns)", () => {
    expect(CeremonyTargetRoleSchema.options).toEqual([
      "operator",
      "captain",
      "product_steward",
      "reviewer",
      "verifier",
    ]);
  });

  it("keeps protocol ceremony source free of forbidden provider/user nouns", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../src/index.ts"), "utf8");
    // Slice from the VUH-845 marker so unrelated Discord action names in the
    // rest of the protocol package do not fail this ceremony check. Strip
    // line comments so prose about the ban does not trip the scanner.
    const marker = "// Connector-neutral tracker ceremony (VUH-845)";
    const ceremonySource = source
      .slice(source.indexOf(marker))
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/u, "").replace(/\/\*[\s\S]*?\*\//gu, ""))
      .join("\n")
      .toLowerCase();
    expect(ceremonySource.length).toBeGreaterThan(100);
    for (const noun of ["linear", "github", "jira", "email", "mention", "assignment", "label", "james"]) {
      expect(ceremonySource).not.toContain(noun);
    }
    // No address-like tokens in identifiers or string enums
    expect(ceremonySource).not.toMatch(/@[a-z]/u);
  });
});
