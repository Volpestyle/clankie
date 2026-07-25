import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClankieApiClient } from "@clankie/api-client";
import { MissionPlanSchema } from "@clankie/protocol";
import { compileDoctrine, loadDoctrineFile } from "../../../packages/doctrine/src/index.ts";
import { SqliteEventStore } from "../../../packages/event-store/src/index.ts";
import { createControlPlane } from "../../control-plane/src/app.ts";
import { MissionObserver } from "../../tui/src/observation/mission-observer.ts";
import { SqliteMissionEventSource } from "../../tui/src/observation/mission-events.ts";
import { describe, expect, it } from "vitest";
import { MissionThreadRegistry } from "../src/thread-registry.ts";

describe("Discord-origin worker visibility in the TUI", () => {
  it("preserves one mission and worker identity from Discord creation through TUI projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-discord-tui-"));
    const eventPath = join(root, "events.db");
    const store = new SqliteEventStore(eventPath);
    try {
      const doctrine = compileDoctrine([
        await loadDoctrineFile(
          resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml"),
        ),
      ]);
      const control = await createControlPlane({
        doctrine,
        eventStore: store,
        authenticateCaptain: (request) =>
          Promise.resolve(
            request.headers.get("authorization") === "Bearer discord-captain-token"
              ? { captainId: "captain-discord", steerSourceLane: "discord_text" as const }
              : undefined,
          ),
        authenticateRunner: (request) =>
          Promise.resolve(
            request.headers.get("authorization") === "Bearer runner-token"
              ? { runnerId: "runner-1" }
              : undefined,
          ),
      });
      const fetchImpl: typeof fetch = async (input, init) => control.fetch(new Request(input, init));
      const discordClient = new ClankieApiClient({
        baseUrl: "http://control-plane.test",
        captainToken: "discord-captain-token",
        fetchImpl,
      });
      const runnerClient = new ClankieApiClient({
        baseUrl: "http://control-plane.test",
        runnerToken: "runner-token",
        runnerId: "runner-1",
        fetchImpl,
      });
      const registryPath = join(root, "discord-registry.json");
      const registry = new MissionThreadRegistry({ statePath: registryPath });
      registry.beginCreation("guild-1", "interaction-1");
      const { missionId } = await discordClient.createMission({
        goal: "Show Discord-started workers in the TUI",
        doctrineId: "structured",
        context: {
          channel: "discord",
          authorityTier: "ambient",
          guildId: "guild-1",
          requestedBy: "discord-user-1",
          transcriptRetention: "off",
          discordInteractionId: "interaction-1",
        },
      });
      registry.completeCreation("guild-1", "interaction-1", missionId);
      registry.bind("thread-1", missionId, "guild-1", "interaction-1");

      await discordClient.proposePlan(
        missionId,
        MissionPlanSchema.parse({
          missionId,
          goal: "Show Discord-started workers in the TUI",
          rationale: "Exercise the canonical cross-surface event identity.",
          tasks: [
            {
              id: "implement",
              title: "Implement",
              objective: "Produce the bounded candidate.",
              kind: "implementation",
              role: "implementer",
              writeScope: ["src/**"],
              successCriteria: ["Candidate exists."],
              evidenceRequirements: ["Runner Git evidence."],
            },
            {
              id: "verify",
              title: "Verify",
              objective: "Independently verify the candidate.",
              kind: "verification",
              role: "verifier",
              dependsOn: ["implement"],
              successCriteria: ["Checks pass unchanged."],
              evidenceRequirements: ["Runner test report."],
            },
          ],
          successCriteria: ["The worker is visible under the Discord mission identity."],
          profileHash: doctrine.profileHash,
        }),
      );
      await discordClient.startMission(missionId);
      const assignment = await runnerClient.claimTask("discord-tui-claim", [
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
      ]);
      expect(assignment).toBeDefined();

      const observer = new MissionObserver({
        source: new SqliteMissionEventSource(eventPath),
        checkpointPath: join(root, "tui-observer.json"),
      });
      await observer.refresh();

      expect(new MissionThreadRegistry({ statePath: registryPath }).missionId("thread-1", "guild-1")).toBe(
        missionId,
      );
      expect(observer.dashboard).toMatchObject({
        mission: `${missionId} · Show Discord-started workers in the TUI`,
        missions: [{ id: missionId, state: "running", selected: true }],
        tasks: [
          { id: "implement", state: "running", dependsOn: [] },
          { id: "verify", state: "queued", dependsOn: ["implement"] },
        ],
        agents: [
          {
            id: assignment?.workerRunId,
            harness: "codex",
            state: "working",
            task: "implement",
          },
        ],
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
