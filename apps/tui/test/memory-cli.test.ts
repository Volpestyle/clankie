import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import type { CaptainEpisode, OperatorMemoryCatalog } from "@clankie/protocol";
import { matchEpisodes, parseMemoryArgs, runMemoryCommand } from "../src/command/memory.ts";

function episode(overrides: Partial<CaptainEpisode> & Pick<CaptainEpisode, "episodeId">): CaptainEpisode {
  return {
    schemaVersion: 1,
    lane: "operator",
    targetId: "global-default",
    summary: "Reviewed the release plan.",
    visibility: "operator_private",
    retained: false,
    provenance: {
      characterId: "clankie",
      sessionId: "captain",
      selfAuthored: true,
      rawTranscript: false,
    },
    occurredAt: "2026-08-15T12:00:00.000Z",
    ...overrides,
  };
}

const catalog: OperatorMemoryCatalog = {
  schemaVersion: 1,
  captainEpisodes: [
    episode({ episodeId: "kept-1", summary: "Chose file memory over a database.", retained: true }),
    episode({
      episodeId: "recent-1",
      lane: "gameplay",
      targetId: "pokemon-emerald",
      visibility: "shareable",
      summary: "Beat Roxanne on the second attempt.",
      occurredAt: "2026-08-20T12:00:00.000Z",
    }),
  ],
  retention: { retained: 1, capacity: 1_024, recentCapacity: 128 },
  discordPeople: [],
};

/** Stands in for the service: records what the CLI asked of it. */
function service(): { calls: string[]; fetchImpl: typeof fetch } {
  const calls: string[] = [];
  const fetchImpl = ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    if (init?.method === "PATCH") {
      const edit = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(Response.json({ ...catalog.captainEpisodes[0], ...edit }));
    }
    return Promise.resolve(Response.json(catalog));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const env = { CLANKIE_OPERATOR_TOKEN: "operator-test-token" };

describe("clankie memory arguments", () => {
  it("accepts the verbs it documents and refuses the rest", () => {
    expect(parseMemoryArgs([])).toEqual({ verb: "status" });
    expect(parseMemoryArgs(["search", "relay", "port"])).toEqual({ verb: "search", query: "relay port" });
    expect(parseMemoryArgs(["retain", "kept-1"])).toEqual({ verb: "retain", episodeId: "kept-1" });
    expect(parseMemoryArgs(["correct", "kept-1", "--summary", "Actually 4321."])).toEqual({
      verb: "correct",
      episodeId: "kept-1",
      summary: "Actually 4321.",
    });
    expect(() => parseMemoryArgs(["search"])).toThrow("Usage:");
    expect(() => parseMemoryArgs(["retain"])).toThrow("Usage:");
    expect(() => parseMemoryArgs(["correct", "kept-1"])).toThrow("Usage:");
    expect(() => parseMemoryArgs(["forgetti", "kept-1"])).toThrow("Usage:");
  });

  it("matches every term against the note and the room it happened in", () => {
    expect(matchEpisodes(catalog.captainEpisodes, "roxanne").map((entry) => entry.episodeId)).toEqual([
      "recent-1",
    ]);
    expect(matchEpisodes(catalog.captainEpisodes, "pokemon-emerald").map((entry) => entry.episodeId)).toEqual(
      ["recent-1"],
    );
    expect(matchEpisodes(catalog.captainEpisodes, "file database")).toHaveLength(1);
    expect(matchEpisodes(catalog.captainEpisodes, "file postgres")).toHaveLength(0);
  });
});

describe("clankie memory", () => {
  it("reports what is kept and how much room is left", async () => {
    const { calls, fetchImpl } = service();
    const result = await runMemoryCommand([], { env, fetchImpl, host: "http://127.0.0.1:4319" });
    expect(result).toMatchObject({
      ok: true,
      retention: { retained: 1, capacity: 1_024, recentCapacity: 128 },
      people: 0,
    });
    expect(calls).toEqual(["GET /v1/memory"]);
  });

  it("searches the operator's own view, private notes included", async () => {
    const { fetchImpl } = service();
    const result = await runMemoryCommand(["search", "file", "database"], { env, fetchImpl });
    expect(result).toMatchObject({ ok: true, query: "file database", found: 1 });
    expect("episodes" in result && result.episodes[0]?.episodeId).toBe("kept-1");
  });

  it("retains, corrects, and forgets by id, resolving the lane from the catalog", async () => {
    const retain = service();
    await expect(
      runMemoryCommand(["retain", "kept-1"], { env, fetchImpl: retain.fetchImpl }),
    ).resolves.toMatchObject({ ok: true, episode: { retained: true } });
    expect(retain.calls).toEqual(["GET /v1/memory", "PATCH /v1/memory/captain-episodes/operator/kept-1"]);

    const correct = service();
    await expect(
      runMemoryCommand(["correct", "kept-1", "--summary", "Files, not a database."], {
        env,
        fetchImpl: correct.fetchImpl,
      }),
    ).resolves.toMatchObject({ ok: true, episode: { summary: "Files, not a database." } });

    const forget = service();
    await expect(
      runMemoryCommand(["forget", "recent-1"], { env, fetchImpl: forget.fetchImpl }),
    ).resolves.toEqual({ ok: true, forgotten: "recent-1", lane: "gameplay" });
    expect(forget.calls).toEqual(["GET /v1/memory", "DELETE /v1/memory/captain-episodes/gameplay/recent-1"]);
  });

  it("says so rather than throwing when the id is unknown or the credential is missing", async () => {
    const { fetchImpl } = service();
    await expect(runMemoryCommand(["forget", "nope"], { env, fetchImpl })).resolves.toEqual({
      ok: false,
      error: "No episode with id nope.",
    });
    // An empty store and no environment override: the real machine credential
    // must not leak into the assertion.
    const empty = new FileCredentialStore(
      join(await mkdtemp(join(tmpdir(), "clankie-memory-cli-")), "credentials.json"),
    );
    const anonymous = await runMemoryCommand([], {
      env: {},
      fetchImpl,
      operatorCredentialStore: empty,
    });
    expect(anonymous).toMatchObject({ ok: false });
    expect((anonymous as { error: string }).error).toContain("operator credential");
  });
});
