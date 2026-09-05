import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createFileMemory, MemoryCapacityError } from "../src/memory.ts";

it("returns an actionable conflict when either memory write exceeds retained capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-memory-capacity-api-"));
  const message = "Retained memory is full. Release or forget a retained memory, then retry.";
  const refuse = (): never => {
    throw new MemoryCapacityError(message);
  };
  const clankie = await createClankieApp({
    captain: createStubCaptain(),
    memory: { ...createFileMemory({ dataDir: root }), recordEpisode: refuse, updateEpisode: refuse },
    authenticateCaptain: async () => ({ captainId: "test", steerSourceLane: "api" }),
    authenticateOperator: async () => ({ operatorId: "test" }),
  });
  try {
    const requests = [
      {
        method: "POST",
        path: "/v1/memory/captain-episodes",
        body: {
          schemaVersion: 1,
          episodeId: "new-note",
          lane: "operator",
          targetId: "test",
          summary: "Keep this decision.",
          visibility: "operator_private",
          retained: true,
          provenance: { characterId: "clankie", sessionId: "test", selfAuthored: true, rawTranscript: false },
          occurredAt: "2026-09-04T12:00:00.000Z",
        },
      },
      {
        method: "PATCH",
        path: "/v1/memory/captain-episodes/operator/existing-note",
        body: { retained: true },
      },
    ];
    for (const request of requests) {
      const response = await clankie.app.request(request.path, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "retained_memory_full",
        message,
        capacity: 1024,
      });
    }
  } finally {
    clankie.close();
    await rm(root, { recursive: true, force: true });
  }
});
