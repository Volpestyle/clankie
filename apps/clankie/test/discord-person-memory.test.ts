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
