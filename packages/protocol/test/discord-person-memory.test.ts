import { describe, expect, it } from "vitest";
import {
  ApprovedDiscordPersonMemoryProposalSchema,
  DiscordPersonMemoryFactSchema,
  DiscordPersonMemoryProjectionSchema,
} from "../src/index.ts";

const fact = {
  schemaVersion: 1,
  factId: "fact-1",
  subject: { guildId: "guild-1", userId: "user-1" },
  kind: "preference",
  body: "Prefers doubles battles.",
  visibility: { scope: "guild" },
  provenance: {
    correlationId: "correlation-1",
    sourceEventId: "event-1",
    sourceSurface: "discord_text",
    rawTranscript: false,
  },
  confidence: 0.9,
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
} as const;

describe("Discord person-memory protocol", () => {
  it("accepts a bounded fact and rejects display-name, transcript, and unknown-field escape paths", () => {
    expect(DiscordPersonMemoryFactSchema.parse(fact)).toEqual(fact);
    expect(() => DiscordPersonMemoryFactSchema.parse({ ...fact, displayName: "James" })).toThrow();
    expect(() =>
      DiscordPersonMemoryFactSchema.parse({
        ...fact,
        provenance: { ...fact.provenance, rawTranscript: true },
      }),
    ).toThrow();
    expect(() => DiscordPersonMemoryFactSchema.parse({ ...fact, body: "x".repeat(2_049) })).toThrow();
  });

  it("enforces correction chronology and identity-safe approved envelopes", () => {
    expect(() =>
      DiscordPersonMemoryFactSchema.parse({
        ...fact,
        supersedesFactId: fact.factId,
      }),
    ).toThrow();
    expect(
      ApprovedDiscordPersonMemoryProposalSchema.parse({
        schemaVersion: 1,
        proposalId: "proposal-1",
        approval: {
          approvalId: "approval-1",
          status: "approved",
          approvedAt: "2026-07-25T00:01:00.000Z",
          approvedBy: "operator",
        },
        fact,
      }).fact.subject,
    ).toEqual(fact.subject);
  });

  it("bounds public projection collections and recall cards", () => {
    expect(
      DiscordPersonMemoryProjectionSchema.parse({
        schemaVersion: 1,
        subject: fact.subject,
        facts: [fact],
        recallCard: "Known preference: doubles battles.",
      }).facts,
    ).toHaveLength(1);
    expect(() =>
      DiscordPersonMemoryProjectionSchema.parse({
        schemaVersion: 1,
        subject: fact.subject,
        facts: Array.from({ length: 129 }, (_, index) => ({ ...fact, factId: `fact-${index}` })),
      }),
    ).toThrow();
  });
});
