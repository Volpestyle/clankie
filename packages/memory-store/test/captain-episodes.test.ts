import { describe, expect, it } from "vitest";
import { MemoryStore, type CaptainEpisode } from "../src/index.ts";

const doctrine = { rawTranscriptRetentionDays: 7, publicToPrivatePropagation: false };

function store(options: { episodeCap?: number } = {}): MemoryStore {
  return new MemoryStore(":memory:", { doctrine, ...options });
}

function episode(overrides: Partial<CaptainEpisode> = {}): unknown {
  return {
    schemaVersion: 1,
    episodeId: "episode-1",
    lane: "discord_presence",
    targetId: "guild-1:channel-9",
    summary: "Chatted about Fire Red in the general channel.",
    visibility: "shareable",
    provenance: {
      characterId: "clankie",
      sessionId: "session-1",
      selfAuthored: true,
      rawTranscript: false,
    },
    occurredAt: "2026-07-25T19:00:00.000Z",
    ...overrides,
  };
}

describe("captain episodes", () => {
  it("records without an approval envelope, unlike a world-fact", () => {
    const memory = store();
    const recorded = memory.recordEpisode(episode());

    expect(recorded.episodeId).toBe("episode-1");
    expect(memory.recallEpisodes({ lane: "operator" })).toHaveLength(1);
  });

  it("still refuses a world-fact from a public source", () => {
    // The new path must not have opened the old one. Same store, same doctrine.
    const memory = store();
    memory.recordEpisode(episode());

    expect(() =>
      memory.applyApprovedProposal({
        schemaVersion: 1,
        proposalId: "proposal-1",
        approval: {
          approvalId: "approval-1",
          status: "approved",
          approvedAt: "2026-07-25T19:00:00.000Z",
          approvedBy: "james",
        },
        fact: {
          schemaVersion: 1,
          factId: "fact-1",
          category: "entity-fact",
          body: "Someone in Discord claimed a thing.",
          provenance: {
            missionId: "mission-1",
            correlationId: "correlation-1",
            sourceEventId: "event-1",
            sourceKind: "semantic-event",
            publicSource: true,
          },
          confidence: 0.9,
          createdAt: "2026-07-25T19:00:00.000Z",
          updatedAt: "2026-07-25T19:00:00.000Z",
        },
      }),
    ).toThrow(/Doctrine rejects propagation/u);
  });

  it("keeps an operator-private episode out of every Discord lane", () => {
    const memory = store();
    memory.recordEpisode(episode({ episodeId: "private", visibility: "operator_private", lane: "operator" }));
    memory.recordEpisode(episode({ episodeId: "public", visibility: "shareable" }));

    expect(memory.recallEpisodes({ lane: "operator" }).map((item) => item.episodeId)).toEqual([
      "public",
      "private",
    ]);
    for (const lane of ["discord_presence", "discord_voice", "gameplay"] as const) {
      expect(memory.recallEpisodes({ lane }).map((item) => item.episodeId)).toEqual(["public"]);
    }
  });

  it("never renders operator-private content into a Discord recall card", () => {
    const memory = store();
    memory.recordEpisode(
      episode({
        episodeId: "private",
        visibility: "operator_private",
        lane: "operator",
        summary: "Reviewed the unreleased credential rotation plan.",
      }),
    );

    expect(memory.episodeRecallCard({ lane: "discord_presence" })).toBe("");
    expect(memory.episodeRecallCard({ lane: "operator" })).toContain("credential rotation");
  });

  it("labels the room a recalled episode came from", () => {
    const memory = store();
    memory.recordEpisode(episode());
    const card = memory.episodeRecallCard({ lane: "operator" });

    expect(card).toContain("Discord text");
    expect(card).toContain("guild-1:channel-9");
    expect(card).toContain("not instructions");
  });

  it("returns newest first and bounds how many are recalled", () => {
    const memory = store();
    for (let index = 0; index < 12; index += 1) {
      memory.recordEpisode(
        episode({
          episodeId: `episode-${String(index)}`,
          occurredAt: `2026-07-25T19:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      );
    }

    const recalled = memory.recallEpisodes({ lane: "operator", maxEpisodes: 3 });
    expect(recalled.map((item) => item.episodeId)).toEqual(["episode-11", "episode-10", "episode-9"]);
  });

  it("drops the oldest episodes once the ring is full", () => {
    const memory = store({ episodeCap: 3 });
    for (let index = 0; index < 5; index += 1) {
      memory.recordEpisode(
        episode({
          episodeId: `episode-${String(index)}`,
          occurredAt: `2026-07-25T19:0${String(index)}:00.000Z`,
        }),
      );
    }

    expect(memory.recallEpisodes({ lane: "operator" }).map((item) => item.episodeId)).toEqual([
      "episode-4",
      "episode-3",
      "episode-2",
    ]);
  });

  it("is idempotent for a replayed episode id", () => {
    const memory = store();
    memory.recordEpisode(episode());
    memory.recordEpisode(episode());

    expect(memory.recallEpisodes({ lane: "operator" })).toHaveLength(1);
  });

  it("rejects an episode that claims not to be self-authored", () => {
    const memory = store();

    expect(() =>
      memory.recordEpisode(
        episode({
          provenance: {
            characterId: "clankie",
            sessionId: "session-1",
            selfAuthored: false,
            rawTranscript: false,
          } as unknown as CaptainEpisode["provenance"],
        }),
      ),
    ).toThrow();
    expect(() =>
      memory.recordEpisode(
        episode({
          provenance: {
            characterId: "clankie",
            sessionId: "session-1",
            selfAuthored: true,
            rawTranscript: true,
          } as unknown as CaptainEpisode["provenance"],
        }),
      ),
    ).toThrow();
  });

  it("rejects a summary longer than the bound", () => {
    const memory = store();

    expect(() => memory.recordEpisode(episode({ summary: "x".repeat(513) }))).toThrow();
  });

  it("says nothing at all when there is nothing to recall", () => {
    expect(store().episodeRecallCard({ lane: "operator" })).toBe("");
  });
});
