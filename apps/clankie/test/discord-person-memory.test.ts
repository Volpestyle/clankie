import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createFileMemory, type MemoryStores } from "../src/memory.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness(): Promise<{ app: ClankieApp["app"]; memory: MemoryStores; dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "clankie-discord-person-memory-"));
  roots.push(dataDir);
  const memory = createFileMemory({ dataDir });
  const { app } = await createApp(memory);
  return { app, memory, dataDir };
}

function createApp(memory: MemoryStores) {
  return createClankieApp({
    captain: createStubCaptain(),
    memory,
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

describe("Discord person-memory routes", () => {
  it("applies an authenticated proposal directly, recalls by stable guild/user id, and supports operator export/delete", async () => {
    const { app, memory, dataDir } = await harness();

    const submitted = await app.request("/v1/memory/discord-people/proposals", {
      method: "POST",
      headers: { authorization: "Bearer discord", "content-type": "application/json" },
      body: JSON.stringify(proposal()),
    });
    // No approval ceremony anymore: the fact lands on submission.
    expect(submitted.status).toBe(201);
    await expect(submitted.json()).resolves.toMatchObject({
      schemaVersion: 1,
      proposalId: "proposal-1",
      fact: { factId: "fact-1" },
    });
    expect(memory.listDiscordPerson({ guildId: "guild-1", userId: "user-1" })).toHaveLength(1);

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

    // The store is file-backed: a fresh app over the same data dir still holds the fact.
    const reopened = createFileMemory({ dataDir });
    const { app: restarted } = await createApp(reopened);
    expect(reopened.listDiscordPerson({ guildId: "guild-1", userId: "user-1" })).toHaveLength(1);

    const ambientExport = await restarted.request("/v1/memory/discord-people/guild-1/user-1/export", {
      headers: { authorization: "Bearer discord" },
    });
    expect(ambientExport.status).toBe(401);
    const exported = await restarted.request("/v1/memory/discord-people/guild-1/user-1/export", {
      headers: { authorization: "Bearer operator" },
    });
    await expect(exported.json()).resolves.toMatchObject({
      facts: [{ factId: "fact-1" }],
    });

    const deleted = await restarted.request("/v1/memory/discord-people/guild-1/user-1", {
      method: "DELETE",
      headers: { authorization: "Bearer operator" },
    });
    await expect(deleted.json()).resolves.toMatchObject({ deletedFactIds: ["fact-1"] });
    expect(reopened.listDiscordPerson({ guildId: "guild-1", userId: "user-1" })).toEqual([]);
  });

  it("keeps operator_private facts out of ambient reads but inside the operator export", async () => {
    const { app, memory } = await harness();
    memory.storeDiscordPersonFact({
      ...proposal().fact,
      factId: "fact-private",
      visibility: { scope: "operator_private" as const },
    });

    const recalled = await app.request("/v1/memory/discord-people/guild-1/user-1", {
      headers: { authorization: "Bearer discord" },
    });
    await expect(recalled.json()).resolves.toMatchObject({ facts: [] });

    const exported = await app.request("/v1/memory/discord-people/guild-1/user-1/export", {
      headers: { authorization: "Bearer operator" },
    });
    await expect(exported.json()).resolves.toMatchObject({ facts: [{ factId: "fact-private" }] });
  });

  it("rejects non-Discord captain identities for person-memory proposal and recall", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clankie-discord-person-memory-auth-"));
    roots.push(dataDir);
    const { app } = await createClankieApp({
      captain: createStubCaptain(),
      memory: createFileMemory({ dataDir }),
      authenticateCaptain: () => Promise.resolve({ captainId: "captain-clankie", steerSourceLane: "api" }),
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
  });

  it("lets only the operator browse, edit, and forget individual memories", async () => {
    const { app, memory } = await harness();
    memory.storeDiscordPersonFact(proposal().fact);
    memory.recordEpisode({
      schemaVersion: 1,
      episodeId: "episode-1",
      lane: "operator",
      targetId: "self",
      summary: "Original note",
      visibility: "operator_private",
      provenance: {
        characterId: "clankie",
        sessionId: "session-1",
        selfAuthored: true,
        rawTranscript: false,
      },
      occurredAt: "2026-07-25T11:00:00.000Z",
    });

    expect((await app.request("/v1/memory")).status).toBe(401);
    const browsed = await app.request("/v1/memory", {
      headers: { authorization: "Bearer operator" },
    });
    await expect(browsed.json()).resolves.toMatchObject({
      discordPeople: [{ facts: [{ factId: "fact-1" }] }],
      captainEpisodes: [{ episodeId: "episode-1" }],
    });

    const editedFact = await app.request("/v1/memory/discord-people/guild-1/user-1/fact-1", {
      method: "PATCH",
      headers: { authorization: "Bearer operator", "content-type": "application/json" },
      body: JSON.stringify({ body: "Now prefers Squirtle", confidence: 0.75 }),
    });
    expect(editedFact.status).toBe(200);
    await expect(editedFact.json()).resolves.toMatchObject({
      body: "Now prefers Squirtle",
      confidence: 0.75,
      provenance: { sourceSurface: "discord_text" },
    });

    const editedEpisode = await app.request("/v1/memory/captain-episodes/operator/episode-1", {
      method: "PATCH",
      headers: { authorization: "Bearer operator", "content-type": "application/json" },
      body: JSON.stringify({ summary: "Corrected note", visibility: "shareable" }),
    });
    expect(editedEpisode.status).toBe(200);
    await expect(editedEpisode.json()).resolves.toMatchObject({
      summary: "Corrected note",
      visibility: "shareable",
      provenance: { selfAuthored: true },
    });

    expect(
      (
        await app.request("/v1/memory/discord-people/guild-1/user-1/fact-1", {
          method: "DELETE",
          headers: { authorization: "Bearer operator" },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await app.request("/v1/memory/captain-episodes/operator/episode-1", {
          method: "DELETE",
          headers: { authorization: "Bearer operator" },
        })
      ).status,
    ).toBe(204);
    expect(memory.catalog()).toMatchObject({ discordPeople: [], captainEpisodes: [] });
  });

  it("keeps one global ring bounded to the 128 newest episodes", async () => {
    const { memory } = await harness();
    for (let index = 0; index < 130; index += 1) {
      memory.recordEpisode({
        schemaVersion: 1,
        episodeId: `episode-${String(index)}`,
        lane: index % 2 === 0 ? "operator" : "gameplay",
        targetId: "self",
        summary: `Note ${String(index)}`,
        visibility: "operator_private",
        provenance: {
          characterId: "clankie",
          sessionId: "session-1",
          selfAuthored: true,
          rawTranscript: false,
        },
        occurredAt: new Date(Date.UTC(2026, 6, 25, 0, 0, index)).toISOString(),
      });
    }
    const episodes = memory.catalog().captainEpisodes;
    expect(episodes).toHaveLength(128);
    expect(episodes[0]?.episodeId).toBe("episode-2");
    expect(episodes.at(-1)?.episodeId).toBe("episode-129");
  });
});

function proposal() {
  return {
    schemaVersion: 1,
    proposalId: "proposal-1",
    fact: {
      schemaVersion: 1 as const,
      factId: "fact-1",
      subject: { guildId: "guild-1", userId: "user-1" },
      kind: "preference" as const,
      body: "Prefers Bulbasaur as a starter",
      visibility: { scope: "guild" as const },
      provenance: {
        correlationId: "discord-interaction:interaction-1",
        sourceEventId: "interaction-1",
        sourceSurface: "discord_text" as const,
        rawTranscript: false as const,
      },
      confidence: 1,
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
    },
  };
}
