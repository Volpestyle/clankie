import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { MemoryStore } from "@clankie/memory-store";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";

let doctrine: ReturnType<typeof compileDoctrine>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
});

describe("Discord person-memory control plane", () => {
  it("requires authenticated approval, recalls by stable guild/user id, and supports operator export/delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-discord-person-memory-"));
    const eventPath = join(root, "events.db");
    const memoryPath = join(root, "memory.db");
    let eventStore = new SqliteEventStore(eventPath);
    let memoryStore = new MemoryStore(memoryPath, { doctrine: doctrine.profile.memory });
    let app = await createApp(eventStore, memoryStore);
    try {
      const submitted = await app.request("/v1/memory/discord-people/proposals", {
        method: "POST",
        headers: { authorization: "Bearer discord", "content-type": "application/json" },
        body: JSON.stringify(proposal()),
      });
      expect(submitted.status).toBe(202);
      const submittedBody = (await submitted.json()) as { approval: { id: string } };
      expect(submittedBody.approval.id).toBe("memory:discord-person:proposal-1");
      expect(memoryStore.listDiscordPerson({ guildId: "guild-1", userId: "user-1" })).toEqual([]);

      const decision = await app.request(
        `/v1/approvals/${encodeURIComponent(submittedBody.approval.id)}/decision`,
        {
          method: "POST",
          headers: { authorization: "Bearer operator", "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve", reason: "Reviewed explicit fact." }),
        },
      );
      expect(decision.status).toBe(200);

      const recalled = await app.request(
        "/v1/memory/discord-people/guild-1/user-1?channelId=channel-1&query=starter",
        { headers: { authorization: "Bearer discord" } },
      );
      expect(recalled.status).toBe(200);
      await expect(recalled.json()).resolves.toMatchObject({
        subject: { guildId: "guild-1", userId: "user-1" },
        facts: [{ body: "Prefers Bulbasaur as a starter" }],
        recallCard: expect.stringContaining("Prefers Bulbasaur"),
      });
      const otherGuild = await app.request("/v1/memory/discord-people/guild-2/user-1", {
        headers: { authorization: "Bearer discord" },
      });
      await expect(otherGuild.json()).resolves.toMatchObject({ facts: [] });

      memoryStore.close();
      eventStore.close();
      eventStore = new SqliteEventStore(eventPath);
      memoryStore = new MemoryStore(memoryPath, { doctrine: doctrine.profile.memory });
      app = await createApp(eventStore, memoryStore);
      expect(memoryStore.listDiscordPerson({ guildId: "guild-1", userId: "user-1" })).toHaveLength(1);

      const ambientExport = await app.request("/v1/memory/discord-people/guild-1/user-1/export", {
        headers: { authorization: "Bearer discord" },
      });
      expect(ambientExport.status).toBe(401);
      const exported = await app.request("/v1/memory/discord-people/guild-1/user-1/export", {
        headers: { authorization: "Bearer operator" },
      });
      await expect(exported.json()).resolves.toMatchObject({
        facts: [{ factId: "fact-1" }],
      });

      const deleted = await app.request("/v1/memory/discord-people/guild-1/user-1", {
        method: "DELETE",
        headers: { authorization: "Bearer operator" },
      });
      await expect(deleted.json()).resolves.toMatchObject({ deletedFactIds: ["fact-1"] });
      expect(memoryStore.listDiscordPerson({ guildId: "guild-1", userId: "user-1" })).toEqual([]);

      const eventTypes = (await eventStore.readAll()).map(({ event }) => event.type);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "discord.person-memory.proposal.submitted",
          "discord.person-memory.proposal.approved",
          "discord.person-memory.proposal.committed",
          "discord.person-memory.exported",
          "discord.person-memory.deleted",
        ]),
      );
    } finally {
      memoryStore.close();
      eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-Discord captain identities for person-memory proposal and recall", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-discord-person-memory-auth-"));
    const eventStore = new SqliteEventStore(join(root, "events.db"));
    const memoryStore = new MemoryStore(join(root, "memory.db"), { doctrine: doctrine.profile.memory });
    try {
      const app = await createControlPlane({
        doctrine,
        eventStore,
        memoryStore,
        authenticateCaptain: () => Promise.resolve({ captainId: "captain-eve", steerSourceLane: "api" }),
      });
      expect(
        (
          await app.request("/v1/memory/discord-people/proposals", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(proposal()),
          })
        ).status,
      ).toBe(403);
      expect((await app.request("/v1/memory/discord-people/guild-1/user-1")).status).toBe(403);
    } finally {
      memoryStore.close();
      eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createApp(eventStore: SqliteEventStore, memoryStore: MemoryStore) {
  return createControlPlane({
    doctrine,
    eventStore,
    memoryStore,
    authenticateCaptain: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer discord"
          ? { captainId: "discord-bridge", steerSourceLane: "discord_text" as const }
          : undefined,
      ),
    authenticateOperator: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer operator"
          ? { operatorId: "operator-james" }
          : undefined,
      ),
    clock: () => new Date("2026-07-25T12:00:00.000Z"),
  });
}

function proposal() {
  return {
    schemaVersion: 1,
    proposalId: "proposal-1",
    fact: {
      schemaVersion: 1,
      factId: "fact-1",
      subject: { guildId: "guild-1", userId: "user-1" },
      kind: "preference",
      body: "Prefers Bulbasaur as a starter",
      visibility: { scope: "guild" },
      provenance: {
        correlationId: "discord-interaction:interaction-1",
        sourceEventId: "interaction-1",
        sourceSurface: "discord_text",
        rawTranscript: false,
      },
      confidence: 1,
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
    },
  };
}
