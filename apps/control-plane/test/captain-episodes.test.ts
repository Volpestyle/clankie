import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { MemoryStore } from "@clankie/memory-store";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane, type TrustedCaptainIdentity } from "../src/app.ts";

let doctrine: ReturnType<typeof compileDoctrine>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
});

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
  const eventStore = new SqliteEventStore(join(root, "events.db"));
  const memoryStore = new MemoryStore(join(root, "memory.db"), { doctrine: doctrine.profile.memory });
  const app = await createControlPlane({
    doctrine,
    eventStore,
    memoryStore,
    authenticateCaptain: captain(steerSourceLane),
    clock: () => new Date("2026-07-25T19:00:00.000Z"),
  });
  return { app, eventStore, memoryStore, close: () => (memoryStore.close(), eventStore.close()) };
}

const authed = { "content-type": "application/json", authorization: "Bearer captain" };

describe("captain episode routes", () => {
  it("records an episode and logs it without the summary body", async () => {
    const { app, eventStore, memoryStore, close } = await harness("api");
    const response = await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: authed,
      body: episodeBody(),
    });

    expect(response.status).toBe(200);
    expect(memoryStore.recallEpisodes({ lane: "operator" })).toHaveLength(1);
    const recorded = (await eventStore.readAll()).find(
      ({ event }) => event.type === "captain.episode.recorded",
    );
    expect(recorded).toBeDefined();
    expect(JSON.stringify(recorded?.event.data)).not.toContain("credential rotation");
    close();
  });

  it("refuses an unauthenticated write", async () => {
    const { app, memoryStore, close } = await harness("api");
    const response = await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: episodeBody(),
    });

    expect(response.status).toBe(401);
    expect(memoryStore.recallEpisodes({ lane: "operator" })).toHaveLength(0);
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

  it("rejects a lane it does not recognise", async () => {
    const { app, close } = await harness("api");
    const response = await app.request("/v1/memory/captain-episodes?lane=root", { headers: authed });

    expect(response.status).toBe(400);
    close();
  });
});
