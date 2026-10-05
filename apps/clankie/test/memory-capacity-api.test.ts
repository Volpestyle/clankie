import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createFileMemory } from "../src/memory.ts";

it("accepts memory through the real API beyond the historical retention quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-memory-capacity-api-"));
  const note = {
    schemaVersion: 1,
    episodeId: "new-note",
    lane: "operator",
    targetId: "test",
    summary: "Keep this decision.",
    visibility: "operator_private",
    retained: true,
    provenance: { characterId: "clankie", sessionId: "test", selfAuthored: true, rawTranscript: false },
    occurredAt: "2026-09-04T12:00:00.000Z",
  };
  await mkdir(join(root, "captain-episodes"), { recursive: true });
  await writeFile(
    join(root, "captain-episodes", "operator.jsonl"),
    Array.from(
      { length: 1024 },
      (_, index) => `${JSON.stringify({ ...note, episodeId: `old-${String(index)}` })}\n`,
    ).join(""),
  );
  const memory = createFileMemory({ dataDir: root });
  const clankie = await createClankieApp({
    captain: createStubCaptain(),
    memory,
    authenticateCaptain: async () => ({
      captainId: "test",
      steerSourceLane: "api",
      episodeSource: { conversationId: "test", lane: "operator", targetId: "test", sessionId: "test" },
    }),
    authenticateOperator: async () => ({ operatorId: "test" }),
  });
  try {
    const requests = [
      {
        method: "POST",
        path: "/v1/memory/captain-episodes",
        body: note,
      },
      {
        method: "PATCH",
        path: "/v1/memory/captain-episodes/operator/old-0",
        body: { summary: "Edited a legacy note after the former quota was full." },
      },
    ];
    for (const request of requests) {
      const response = await clankie.app.request(request.path, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      expect(response.status).toBe(200);
    }
    expect(memory.catalog().captainEpisodes).toHaveLength(1025);
    expect(createFileMemory({ dataDir: root }).catalog().captainEpisodes).toHaveLength(1025);
    expect(memory.searchEpisodeCard({ lane: "operator", query: "edited legacy" })).toContain("old-0");
  } finally {
    clankie.close();
    await rm(root, { recursive: true, force: true });
  }
});
