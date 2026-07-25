import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  type DiscordPersonMemoryFact,
  type DiscordPersonMemoryVisibility,
} from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("governed Discord person memory", () => {
  it("commits only approved facts and keeps stable user identity isolated by guild", async () => {
    const store = await createStore();
    const first = fact("fact-1", "guild-1", "user-1", "Prefers doubles battles");

    expect(() =>
      store.applyApprovedDiscordPersonProposal({
        schemaVersion: 1,
        proposalId: "proposal-unapproved",
        fact: first,
      }),
    ).toThrow();

    const committed = store.applyApprovedDiscordPersonProposal(approved("proposal-1", first));
    expect(committed.fact).toEqual(first);
    expect(store.applyApprovedDiscordPersonProposal(approved("proposal-1", first))).toMatchObject({
      fact: first,
      evictedFactIds: [],
    });
    expect(store.listDiscordPerson({ guildId: "guild-1", userId: "user-1" })).toHaveLength(1);
    expect(store.listDiscordPerson({ guildId: "guild-2", userId: "user-1" })).toEqual([]);

    // Display-name changes are deliberately absent from the durable key.
    expect(JSON.stringify(store.exportDiscordPerson({ guildId: "guild-1", userId: "user-1" }))).not.toContain(
      "displayName",
    );
    store.close();
  });

  it("enforces channel/private visibility and expiry without persisting raw transcripts", async () => {
    const store = await createStore();
    const guildFact = fact("guild", "guild-1", "user-1", "Enjoys cooperative games");
    const channelFact = fact("channel", "guild-1", "user-1", "Uses this channel for project planning", {
      scope: "channel",
      channelId: "channel-1",
    });
    const privateFact = fact("private", "guild-1", "user-1", "Operator-only relationship context", {
      scope: "operator_private",
    });
    const expiring = {
      ...fact("expiring", "guild-1", "user-1", "Temporary preference"),
      expiresAt: "2026-07-26T00:00:00.000Z",
    };
    for (const item of [guildFact, channelFact, privateFact, expiring]) {
      store.applyApprovedDiscordPersonProposal(approved(`proposal-${item.factId}`, item));
    }

    expect(
      store
        .listDiscordPerson(
          { guildId: "guild-1", userId: "user-1" },
          { channelId: "channel-1", now: new Date("2026-07-25T00:00:00.000Z") },
        )
        .map((item) => item.factId),
    ).toEqual(["channel", "expiring", "guild"]);
    expect(
      store
        .listDiscordPerson(
          { guildId: "guild-1", userId: "user-1" },
          { includeOperatorPrivate: true, now: new Date("2026-07-25T00:00:00.000Z") },
        )
        .map((item) => item.factId),
    ).toEqual(["expiring", "guild", "private"]);
    expect(store.pruneRetention(new Date("2026-07-27T00:00:00.000Z"))).toContain("expiring");
    expect(JSON.stringify(store.exportDiscordPerson({ guildId: "guild-1", userId: "user-1" }))).not.toContain(
      "raw transcript",
    );
    store.close();
  });

  it("corrects, recalls, exports, and deletes one identity with explicit receipts", async () => {
    const store = await createStore();
    const original = fact("original", "guild-1", "user-1", "Favorite starter is Squirtle");
    store.applyApprovedDiscordPersonProposal(approved("proposal-original", original));
    const corrected: DiscordPersonMemoryFact = {
      ...fact("corrected", "guild-1", "user-1", "Favorite starter is Bulbasaur"),
      supersedesFactId: "original",
      updatedAt: "2026-07-25T01:00:00.000Z",
    };

    expect(store.applyApprovedDiscordPersonProposal(approved("proposal-corrected", corrected))).toMatchObject(
      {
        supersededFactId: "original",
        fact: { factId: "corrected" },
      },
    );
    expect(
      store.recallDiscordPersonCard(
        { guildId: "guild-1", userId: "user-1" },
        { query: "starter Bulbasaur", now: new Date("2026-07-25T02:00:00.000Z") },
      ),
    ).toContain("Favorite starter is Bulbasaur");
    expect(store.exportDiscordPerson({ guildId: "guild-1", userId: "user-1" }).facts).toHaveLength(1);
    expect(store.deleteDiscordPerson({ guildId: "guild-1", userId: "user-1" })).toEqual(["corrected"]);
    expect(store.listDiscordPerson({ guildId: "guild-1", userId: "user-1" })).toEqual([]);
    store.close();
  });

  it("refuses a correction that crosses a guild-scoped Discord identity", async () => {
    const store = await createStore();
    store.applyApprovedDiscordPersonProposal(
      approved("proposal-original", fact("original", "guild-1", "user-1", "Original fact")),
    );
    const crossing = {
      ...fact("crossing", "guild-2", "user-1", "Cross-guild overwrite"),
      supersedesFactId: "original",
    };
    expect(() => store.applyApprovedDiscordPersonProposal(approved("proposal-crossing", crossing))).toThrow(
      "cannot cross Discord identities or guilds",
    );
    store.close();
  });
});

async function createStore(): Promise<MemoryStore> {
  const root = await mkdtemp(join(tmpdir(), "clankie-person-memory-"));
  roots.push(root);
  return new MemoryStore(join(root, "memory.db"), {
    doctrine: { rawTranscriptRetentionDays: 0, publicToPrivatePropagation: false },
  });
}

function fact(
  factId: string,
  guildId: string,
  userId: string,
  body: string,
  visibility: DiscordPersonMemoryVisibility = { scope: "guild" },
): DiscordPersonMemoryFact {
  return {
    schemaVersion: 1,
    factId,
    subject: { guildId, userId },
    kind: "preference",
    body,
    visibility,
    provenance: {
      correlationId: `correlation-${factId}`,
      sourceEventId: `event-${factId}`,
      sourceSurface: "discord_text",
      rawTranscript: false,
    },
    confidence: 0.9,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
}

function approved(proposalId: string, memoryFact: DiscordPersonMemoryFact) {
  return {
    schemaVersion: 1 as const,
    proposalId,
    approval: {
      approvalId: `approval-${proposalId}`,
      status: "approved" as const,
      approvedAt: "2026-07-25T02:00:00.000Z",
      approvedBy: "operator-james",
    },
    fact: memoryFact,
  };
}
