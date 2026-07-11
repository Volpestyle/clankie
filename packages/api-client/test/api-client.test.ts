import { describe, expect, it, vi } from "vitest";
import { SaplingApiClient } from "../src/index.ts";

describe("SaplingApiClient runner surface", () => {
  it("starts missions and authenticates runner claims", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/start")) {
        expect(init?.headers).toMatchObject({ authorization: "Bearer captain-secret" });
        return Response.json({ missionId: "mission-1" }, { status: 202 });
      }
      expect(init?.headers).toMatchObject({
        authorization: "Bearer runner-secret",
        "x-sapling-runner-id": "runner-1",
      });
      return Response.json({
        assignment: {
          missionId: "mission-1",
          profileHash: "profile",
          workerRunId: "run-1",
          attempt: 1,
          task: {
            id: "implement",
            title: "Implement",
            objective: "Implement",
            kind: "implementation",
            role: "implementer",
            dependsOn: [],
            executionClass: "automatic",
            risk: "low",
            writeScope: ["src/**"],
            successCriteria: ["done"],
            evidenceRequirements: ["diff"],
            maxAttempts: 1,
            metadata: {},
          },
          worker: {
            id: "codex-implementer",
            displayName: "Codex implementer",
            harness: "codex",
            capabilities: {
              kinds: ["implementation"],
              canWrite: true,
              supportsStructuredEvents: true,
              supportsTerminal: true,
              supportsNativeSession: true,
            },
          },
        },
      });
    });
    const client = new SaplingApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      runnerToken: "runner-secret",
      runnerId: "runner-1",
      captainToken: "captain-secret",
    });
    await expect(client.startMission("mission-1")).resolves.toMatchObject({ missionId: "mission-1" });
    await expect(
      client.claimTask("claim-1", [
        {
          id: "codex-implementer",
          displayName: "Codex implementer",
          harness: "codex",
          capabilities: {
            kinds: ["implementation"],
            canWrite: true,
            supportsStructuredEvents: true,
            supportsTerminal: true,
            supportsNativeSession: true,
          },
        },
      ]),
    ).resolves.toMatchObject({ workerRunId: "run-1" });
  });

  it("fails before a runner request when no token is configured", async () => {
    const client = new SaplingApiClient({ baseUrl: "http://127.0.0.1:4310", fetchImpl: vi.fn() });
    await expect(client.claimTask("claim-1", [])).rejects.toThrow("SAPLING_RUNNER_TOKEN");
    await expect(client.startMission("mission-1")).rejects.toThrow("SAPLING_CAPTAIN_TOKEN");
  });
});
