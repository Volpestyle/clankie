import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClankieApp, type TrustedCaptainIdentity } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { MemoryCapacityError, createFileMemory } from "../src/memory.ts";

/** `api` is the in-process captain; `discord_text` is the bridge's own bearer. */
const captain =
  (steerSourceLane: TrustedCaptainIdentity["steerSourceLane"]) =>
  (request: Request): Promise<TrustedCaptainIdentity | undefined> =>
    Promise.resolve(
      request.headers.get("authorization") === "Bearer captain"
        ? { captainId: "captain-clankie", ...(steerSourceLane ? { steerSourceLane } : {}) }
        : undefined,
    );

function episodeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    episodeId: "episode-1",
    lane: "operator",
    targetId: "global-default",
    summary: "Reviewed the credential rotation plan.",
    visibility: "operator_private",
    provenance: {
      characterId: "clankie",
      sessionId: "session-1",
      selfAuthored: true,
      rawTranscript: false,
    },
    occurredAt: "2026-07-25T19:00:00.000Z",
    ...overrides,
  });
}

async function harness(steerSourceLane: TrustedCaptainIdentity["steerSourceLane"]) {
  const root = await mkdtemp(join(tmpdir(), "clankie-captain-episodes-"));
  const memory = createFileMemory({ dataDir: root });
  const { app, close } = await createClankieApp({
    captain: createStubCaptain(),
    memory,
    authenticateCaptain: captain(steerSourceLane),
    clock: () => new Date("2026-07-25T19:00:00.000Z"),
  });
  return { app, memory, close };
}

const authed = { "content-type": "application/json", authorization: "Bearer captain" };

describe("captain episode routes", () => {
  it("records an episode and recalls it in the operator lane", async () => {
    const { app, memory, close } = await harness("api");
    const response = await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: authed,
      body: episodeBody(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schemaVersion: 1, episodeId: "episode-1" });
    expect(memory.episodeRecallCard({ lane: "operator" })).toContain("credential rotation");
    close();
  });

  it("refuses an unauthenticated write", async () => {
    const { app, memory, close } = await harness("api");
    const response = await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: episodeBody(),
    });

    expect(response.status).toBe(401);
    expect(memory.episodeRecallCard({ lane: "operator" })).toBe("");
    close();
  });

  it("refuses an episode that does not claim to be self-authored", async () => {
    const { app, close } = await harness("api");
    const response = await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: authed,
      body: episodeBody({
        provenance: {
          characterId: "clankie",
          sessionId: "session-1",
          selfAuthored: false,
          rawTranscript: false,
        },
      }),
    });

    expect(response.status).toBe(400);
    close();
  });

  it("never hands operator-private content to a Discord-scoped bearer", async () => {
    const { app, close } = await harness("discord_text");
    await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: authed,
      body: episodeBody(),
    });

    const forbidden = await app.request("/v1/memory/captain-episodes?lane=operator", { headers: authed });
    expect(forbidden.status).toBe(403);

    const allowed = await app.request("/v1/memory/captain-episodes?lane=discord_presence", {
      headers: authed,
    });
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { recallCard: string }).recallCard).not.toContain(
      "credential rotation",
    );
    close();
  });

  it("gives the operator lane its own private episodes back", async () => {
    const { app, close } = await harness("api");
    await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: authed,
      body: episodeBody(),
    });

    const response = await app.request("/v1/memory/captain-episodes?lane=operator", { headers: authed });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { recallCard: string }).recallCard).toContain("credential rotation");
    close();
  });

  it("recalls shareable episodes across rooms while keeping operator notes private", async () => {
    const { memory, close } = await harness("api");
    memory.recordEpisode(
      JSON.parse(
        episodeBody({
          episodeId: "game-1",
          lane: "gameplay",
          targetId: "pokemon-emerald",
          summary: "Beat Roxanne on the second attempt.",
          visibility: "shareable",
          occurredAt: "2026-07-25T18:00:00.000Z",
        }),
      ),
    );
    memory.recordEpisode(JSON.parse(episodeBody()));

    const discord = memory.episodeRecallCard({ lane: "discord_presence" });
    expect(discord).toContain("gameplay · pokemon-emerald");
    expect(discord).toContain("Beat Roxanne");
    expect(discord).not.toContain("credential rotation");

    const operator = memory.episodeRecallCard({ lane: "operator" });
    expect(operator).toContain("Beat Roxanne");
    expect(operator).toContain("credential rotation");
    close();
  });

  it("keeps an operator-private episode out of a shareable lane's recall, even in its own lane", async () => {
    const { app, close } = await harness("api");
    await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: authed,
      body: episodeBody({ lane: "discord_presence" }),
    });
    const response = await app.request("/v1/memory/captain-episodes?lane=discord_presence", {
      headers: authed,
    });
    expect(((await response.json()) as { recallCard: string }).recallCard).toBe("");
    close();
  });

  it("rejects a lane it does not recognise", async () => {
    const { app, close } = await harness("api");
    const response = await app.request("/v1/memory/captain-episodes?lane=root", { headers: authed });

    expect(response.status).toBe(400);
    close();
  });
});

/**
 * Retention (VUH-1104). A note he kept has to outlive the recent window, an
 * eviction, a restart, and a busy room — and never leak across the lane fence
 * on its way back.
 */
describe("durable retention", () => {
  const episode = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    ...JSON.parse(episodeBody()),
    ...overrides,
  });

  it("recalls a kept episode after far more than the recent window, across a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-retention-"));
    const first = createFileMemory({ dataDir: root });
    first.recordEpisode(
      episode({
        episodeId: "kept-1",
        summary: "Decided the gateway holds no state and routes back over the socket.",
        retained: true,
        occurredAt: "2026-07-01T10:00:00.000Z",
      }),
    );
    // 200 newer notes: more than enough to evict anything the ring still owns.
    for (let index = 0; index < 200; index += 1) {
      first.recordEpisode(
        episode({
          episodeId: `noise-${String(index)}`,
          lane: "gameplay",
          targetId: "pokemon-emerald",
          visibility: "shareable",
          summary: `Routine turn ${String(index)}.`,
          occurredAt: new Date(Date.parse("2026-08-01T00:00:00.000Z") + index * 60_000).toISOString(),
        }),
      );
    }

    // A fresh store over the same directory is the restart.
    const restarted = createFileMemory({ dataDir: root });
    const ids = restarted.catalog().captainEpisodes.map((entry) => entry.episodeId);
    // The recent window did evict: 128 unretained survive, and the kept one is extra.
    expect(ids).toHaveLength(129);
    expect(ids).not.toContain("noise-0");

    // Recall on demand reaches it; the automatic card still shows only the newest few.
    const found = restarted.searchEpisodeCard({ lane: "operator", query: "gateway state" });
    expect(found.split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- operator · global-default · 2026-07-01T10:00:00.000Z · kept-1 [kept]: " +
        "Decided the gateway holds no state and routes back over the socket.",
    ]);
    expect(restarted.episodeRecallCard({ lane: "operator" })).not.toContain("kept-1");
    expect(restarted.episodeRecallCard({ lane: "operator" }).split("\n")).toHaveLength(11);
  });

  it("answers with the source and date, and lets a correction supersede the stale note", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-correction-"));
    const memory = createFileMemory({
      dataDir: root,
      clock: () => new Date("2026-09-04T12:00:00.000Z"),
    });
    memory.recordEpisode(
      episode({
        episodeId: "decision-1",
        lane: "discord_presence",
        targetId: "guild-1:channel-9",
        visibility: "shareable",
        summary: "We decided to ship the relay on port 4000.",
        retained: true,
        occurredAt: "2026-08-29T09:00:00.000Z",
      }),
    );

    const card = memory.searchEpisodeCard({ lane: "gameplay", query: "relay port" });
    expect(card).toContain("discord_presence · guild-1:channel-9 · 2026-08-29T09:00:00.000Z");
    expect(card).toContain("port 4000");

    // Reading it from another room is fine; rewriting it from there is not.
    expect(
      memory.correctEpisode({
        lane: "gameplay",
        episodeId: "decision-1",
        summary: "Gameplay rewriting a room it was never in.",
      }),
    ).toBeUndefined();

    const corrected = memory.correctEpisode({
      lane: "discord_presence",
      episodeId: "decision-1",
      summary: "We decided to ship the relay on port 4321, not 4000.",
    });
    expect(corrected?.correctedAt).toBe("2026-09-04T12:00:00.000Z");
    // The correction replaces the note without rewriting where or when it happened.
    expect(corrected?.occurredAt).toBe("2026-08-29T09:00:00.000Z");
    expect(corrected?.targetId).toBe("guild-1:channel-9");
    expect(corrected?.retained).toBe(true);

    const after = memory.searchEpisodeCard({ lane: "gameplay", query: "relay port" });
    expect(after).toContain("port 4321");
    expect(after).not.toContain("port 4000.");
    expect(after).toContain("corrected 2026-09-04T12:00:00.000Z");
    expect(memory.searchEpisodeCard({ lane: "gameplay", query: "rewriting" })).toBe("");
  });

  it("lets only the room that wrote a note, or the operator, correct it", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-correct-fence-"));
    const memory = createFileMemory({ dataDir: root });
    // Shareable is the ordinary case, so this console note is readable everywhere.
    memory.recordEpisode(
      episode({
        episodeId: "console-1",
        lane: "operator",
        targetId: "console",
        visibility: "shareable",
        summary: "We bundled the runtime rather than shelling out.",
        retained: true,
      }),
    );
    expect(memory.searchEpisodeCard({ lane: "discord_presence", query: "bundled" })).toContain("console-1");

    for (const lane of ["discord_presence", "discord_voice", "gameplay"] as const) {
      expect(
        memory.correctEpisode({
          lane,
          episodeId: "console-1",
          summary: "Actually we never bundled anything.",
        }),
      ).toBeUndefined();
    }
    // Untouched: a room that talks him into "you misremembered that" changes nothing.
    const untouched = memory.catalog().captainEpisodes[0];
    expect(untouched).toMatchObject({
      summary: "We bundled the runtime rather than shelling out.",
      retained: true,
    });
    expect(untouched).not.toHaveProperty("correctedAt");

    const owned = memory.correctEpisode({
      lane: "operator",
      episodeId: "console-1",
      summary: "We bundled the runtime, and it ships in the release.",
    });
    expect(owned?.summary).toBe("We bundled the runtime, and it ships in the release.");
    expect(owned?.occurredAt).toBe("2026-07-25T19:00:00.000Z");
  });

  it("keeps a retained operator note out of every social and gameplay recall", async () => {
    const { app, memory, close } = await harness("discord_text");
    memory.recordEpisode(
      episode({ episodeId: "private-1", retained: true, summary: "Rotated the broker credential." }),
    );

    for (const lane of ["discord_presence", "discord_voice", "gameplay"] as const) {
      expect(memory.searchEpisodeCard({ lane, query: "broker credential" })).toBe("");
    }
    expect(memory.searchEpisodeCard({ lane: "operator", query: "broker credential" })).toContain("private-1");

    // The same fence over HTTP: a Discord bearer cannot ask the operator lane at all.
    const forbidden = await app.request(
      "/v1/memory/captain-episodes?lane=operator&query=broker%20credential",
      { headers: authed },
    );
    expect(forbidden.status).toBe(403);
    const social = await app.request(
      "/v1/memory/captain-episodes?lane=discord_presence&query=broker%20credential",
      { headers: authed },
    );
    // A card, never records: the recall branch withholds provenance ids and so does this one.
    expect(await social.json()).toEqual({
      schemaVersion: 1,
      lane: "discord_presence",
      query: "broker credential",
      recallCard: "",
    });

    // Search results stay framed as his own notes, not instructions or fact.
    const operatorCard = memory.searchEpisodeCard({ lane: "operator", query: "broker" });
    expect(operatorCard).toContain("not instructions or established fact");
    close();
  });

  it("forgets the one record, so neither recent nor kept recall keeps a copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-forget-"));
    const memory = createFileMemory({ dataDir: root });
    const close = (): void => undefined;
    memory.recordEpisode(
      episode({ episodeId: "kept-2", retained: true, summary: "Chose sqlite-free file memory." }),
    );
    expect(memory.catalog().retention.retained).toBe(1);

    memory.deleteEpisode("operator", "kept-2");
    expect(memory.searchEpisodeCard({ lane: "operator", query: "sqlite-free" })).toBe("");
    expect(memory.episodeRecallCard({ lane: "operator" })).toBe("");
    expect(memory.catalog().captainEpisodes).toHaveLength(0);
    expect(memory.catalog().retention.retained).toBe(0);

    // Nothing is left on disk for a restart to bring back either.
    expect(createFileMemory({ dataDir: root }).catalog().captainEpisodes).toHaveLength(0);
    close();
  });

  it("refuses a retain at capacity and leaves every kept record untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-capacity-"));
    const capacity = new MemoryCapacityError("probe").capacity;
    // Seeded on disk rather than written one call at a time: the point is the
    // full shelf, not the thousand writes it would take to fill it.
    mkdirSync(join(root, "captain-episodes"), { recursive: true });
    const seeded = Array.from({ length: capacity }, (_unused, index) =>
      JSON.stringify(
        episode({
          episodeId: `kept-${String(index)}`,
          retained: true,
          summary: `Kept memory ${String(index)}.`,
          occurredAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
        }),
      ),
    );
    writeFileSync(join(root, "captain-episodes", "operator.jsonl"), `${seeded.join("\n")}\n`);
    const memory = createFileMemory({ dataDir: root });
    expect(memory.catalog().retention).toEqual({ retained: capacity, capacity, recentCapacity: 128 });

    expect(() =>
      memory.recordEpisode(
        episode({ episodeId: "overflow-1", retained: true, summary: "One memory too many." }),
      ),
    ).toThrow(MemoryCapacityError);
    expect(() => memory.updateEpisode("operator", "kept-0", { retained: true })).not.toThrow();

    // Nothing evicted, nothing renamed, and the refused note is simply absent.
    const after = memory.catalog();
    expect(after.retention.retained).toBe(capacity);
    expect(after.captainEpisodes).toHaveLength(capacity);
    expect(after.captainEpisodes.map((entry) => entry.episodeId)).toContain("kept-0");
    expect(memory.searchEpisodeCard({ lane: "operator", query: "one memory too many" })).toBe("");

    // Releasing one makes room, and the same write then succeeds.
    memory.updateEpisode("operator", "kept-0", { retained: false });
    expect(() =>
      memory.recordEpisode(
        episode({ episodeId: "overflow-1", retained: true, summary: "One memory too many." }),
      ),
    ).not.toThrow();
    expect(memory.catalog().retention.retained).toBe(capacity);
  });
  it("refuses a write that lands on an id the store already holds", async () => {
    const { app, memory, close } = await harness("api");
    memory.recordEpisode(episode({ episodeId: "kept-3", retained: true, summary: "The original." }));

    // A byte-identical retry is the same memory arriving twice, not a second one.
    expect(
      memory.recordEpisode(episode({ episodeId: "kept-3", retained: true, summary: "The original." })),
    ).toMatchObject({ summary: "The original." });
    expect(memory.catalog().captainEpisodes).toHaveLength(1);

    const conflict = await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: authed,
      body: episodeBody({ episodeId: "kept-3", summary: "Something else entirely." }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "captain_episode_id_conflict" });
    expect(memory.catalog().captainEpisodes[0]).toMatchObject({
      summary: "The original.",
      retained: true,
    });
    close();
  });

  it("will not let a Discord bearer forge a lane or record over a private memory", async () => {
    const { app, memory, close } = await harness("discord_text");
    // What he wrote at the console: private, kept, and only the operator's to change.
    memory.recordEpisode(
      episode({
        episodeId: "console-secret",
        lane: "operator",
        targetId: "global-default",
        visibility: "operator_private",
        retained: true,
        summary: "Rotated the broker credential at the console.",
      }),
    );

    // The exact forgery: that id, re-declared as a shareable Discord memory.
    const overwrite = await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: authed,
      body: episodeBody({
        episodeId: "console-secret",
        lane: "discord_presence",
        targetId: "guild-1:channel-9",
        visibility: "shareable",
        summary: "Nothing happened at the console.",
      }),
    });
    expect(overwrite.status).toBe(409);

    // A forged operator-lane write is refused before the store is even asked.
    const forgedLane = await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: authed,
      body: episodeBody({ episodeId: "forged-1", lane: "operator", visibility: "shareable" }),
    });
    expect(forgedLane.status).toBe(403);
    expect(await forgedLane.json()).toEqual({ error: "captain_episode_lane_forbidden" });

    const gameplayLane = await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: authed,
      body: episodeBody({ episodeId: "forged-2", lane: "gameplay", visibility: "shareable" }),
    });
    expect(gameplayLane.status).toBe(403);

    // Its own room still works, so the fence is a fence and not a wall.
    const allowed = await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: authed,
      body: episodeBody({
        episodeId: "room-1",
        lane: "discord_presence",
        targetId: "guild-1:channel-9",
        visibility: "shareable",
        summary: "Someone showed me their shiny.",
      }),
    });
    expect(allowed.status).toBe(200);

    // The private original survived untouched, still private, still kept.
    const stored = memory.catalog().captainEpisodes.find((entry) => entry.episodeId === "console-secret");
    expect(stored).toMatchObject({
      lane: "operator",
      visibility: "operator_private",
      retained: true,
      summary: "Rotated the broker credential at the console.",
    });
    expect(memory.searchEpisodeCard({ lane: "discord_presence", query: "broker credential" })).toBe("");
    expect(
      memory
        .catalog()
        .captainEpisodes.map((entry) => entry.episodeId)
        .sort(),
    ).toEqual(["console-secret", "room-1"]);
    close();
  });
});
