import { describe, expect, it } from "vitest";
import { MemoryStore, type MemoryCategory, type MemoryFact } from "../src/index.ts";

const doctrine = { rawTranscriptRetentionDays: 7, publicToPrivatePropagation: false };

function fact(
  factId: string,
  body: string,
  options: {
    category?: MemoryCategory;
    confidence?: number;
    day?: number;
    sourceKind?: "semantic-event" | "raw-transcript";
    publicSource?: boolean;
  } = {},
): MemoryFact {
  const timestamp = new Date(Date.UTC(2026, 6, options.day ?? 10)).toISOString();
  return {
    schemaVersion: 1,
    factId,
    category: options.category ?? "repo-knowledge",
    body,
    provenance: {
      missionId: "mission-1",
      correlationId: "correlation-1",
      sourceEventId: `event-${factId}`,
      sourceKind: options.sourceKind ?? "semantic-event",
      publicSource: options.publicSource ?? false,
    },
    confidence: options.confidence ?? 0.8,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function proposal(memoryFact: MemoryFact, suffix = memoryFact.factId): unknown {
  return {
    schemaVersion: 1,
    proposalId: `proposal-${suffix}`,
    approval: {
      approvalId: `approval-${suffix}`,
      status: "approved",
      approvedAt: "2026-07-12T00:00:00.000Z",
      approvedBy: "operator:james",
    },
    fact: memoryFact,
  };
}

describe("MemoryStore", () => {
  it("requires an approval and exposes no direct fact-write API", () => {
    const store = new MemoryStore(":memory:", { doctrine });
    expect(() => store.applyApprovedProposal({ fact: fact("one", "one") })).toThrow();
    expect("writeFact" in store).toBe(false);
    store.close();
  });

  it("deduplicates normalized facts and makes proposal retries idempotent", () => {
    const store = new MemoryStore(":memory:", { doctrine });
    const first = proposal(fact("first", "SQLite   uses WAL", { confidence: 0.4 }), "first");
    expect(store.applyApprovedProposal(first)).toMatchObject({ merged: false });
    const merged = store.applyApprovedProposal(
      proposal(fact("second", " sqlite uses wal ", { confidence: 0.9, day: 11 }), "second"),
    );
    expect(merged).toMatchObject({ merged: true, fact: { factId: "first", confidence: 0.9 } });
    expect(store.list()).toHaveLength(1);
    expect(store.applyApprovedProposal(first)).toMatchObject({ fact: { factId: "first" } });
    store.close();
  });

  it("enforces independent category caps with deterministic eviction", () => {
    const store = new MemoryStore(":memory:", {
      doctrine,
      categoryCaps: { "repo-knowledge": 2, "entity-fact": 1 },
    });
    store.applyApprovedProposal(proposal(fact("z", "Fact z", { confidence: 0.3, day: 9 })));
    store.applyApprovedProposal(proposal(fact("a", "Fact a", { confidence: 0.3, day: 9 })));
    const result = store.applyApprovedProposal(
      proposal(fact("strong", "Strong fact", { confidence: 0.9, day: 10 })),
    );
    expect(result.evictedFactIds).toEqual(["a"]);
    expect(
      store
        .list("repo-knowledge")
        .map((entry) => entry.factId)
        .sort(),
    ).toEqual(["strong", "z"]);
    store.applyApprovedProposal(
      proposal(fact("entity", "Entity survives", { category: "entity-fact", confidence: 0.1 })),
    );
    expect(store.list("entity-fact")).toHaveLength(1);
    store.close();
  });

  it("prunes only expired raw-transcript facts according to doctrine", () => {
    const store = new MemoryStore(":memory:", { doctrine });
    store.applyApprovedProposal(
      proposal(fact("old-raw", "Old raw-derived fact", { sourceKind: "raw-transcript", day: 1 })),
    );
    store.applyApprovedProposal(
      proposal(fact("recent-raw", "Recent raw-derived fact", { sourceKind: "raw-transcript", day: 10 })),
    );
    store.applyApprovedProposal(proposal(fact("semantic", "Old semantic fact", { day: 1 })));
    expect(store.pruneRetention(new Date("2026-07-12T00:00:00.000Z"))).toEqual(["old-raw"]);
    expect(
      store
        .list()
        .map((entry) => entry.factId)
        .sort(),
    ).toEqual(["recent-raw", "semantic"]);
    store.close();
  });

  it("rejects public-source propagation when doctrine denies it", () => {
    const store = new MemoryStore(":memory:", { doctrine });
    expect(() =>
      store.applyApprovedProposal(proposal(fact("public", "Public claim", { publicSource: true }))),
    ).toThrow(/public source/);
    expect(store.list()).toEqual([]);
    store.close();
  });

  it("orders recall by FTS rank, confidence, recency, and id and bounds markdown", () => {
    const store = new MemoryStore(":memory:", { doctrine });
    store.applyApprovedProposal(proposal(fact("low", "SQLite database", { confidence: 0.4, day: 11 })));
    store.applyApprovedProposal(proposal(fact("high", "SQLite storage", { confidence: 0.9, day: 10 })));
    store.applyApprovedProposal(
      proposal(fact("other", "Unrelated mission lesson", { category: "mission-lesson" })),
    );
    const card = store.recallCard({ query: "SQLite", maxFacts: 2, maxCharacters: 512 });
    expect(card).toMatch(/^## Memory recall/);
    expect(card.indexOf("SQLite storage")).toBeLessThan(card.indexOf("SQLite database"));
    expect(card).not.toContain("Unrelated");
    expect(card.length).toBeLessThanOrEqual(512);
    store.close();
  });
});
