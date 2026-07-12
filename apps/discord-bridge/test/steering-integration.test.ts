import { ClankieApiClient } from "@clankie/api-client";
import { compileDoctrine, loadDoctrineFile } from "../../../packages/doctrine/src/index.ts";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane, createDeterministicWorkerSteerAuthorizer } from "../../control-plane/src/app.ts";
import { DISCORD_WORKER_STEER_CHOICES, issueMissionSteering } from "../src/steering.ts";
import { MissionThreadRegistry } from "../src/thread-registry.ts";

describe("Discord → API client → VUH-812 steering integration", () => {
  let doctrine: ReturnType<typeof compileDoctrine>;

  beforeAll(async () => {
    doctrine = compileDoctrine([
      await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
    ]);
  });

  it("sends every exposed Discord choice through ClankieApiClient as its typed intent", async () => {
    const registry = boundRegistry();
    const submitted: unknown[] = [];
    const client = new ClankieApiClient({
      baseUrl: "http://control-plane.test",
      captainToken: "captain-token",
      fetchImpl: async (input, init) => {
        if (!init?.method || init.method === "GET") return Response.json(runningMission());
        expect(init.headers).toMatchObject({ authorization: "Bearer captain-token" });
        const request = JSON.parse(String(init.body)) as { intent: unknown };
        submitted.push(request.intent);
        return Response.json({ accepted: true, command: { status: "pending" } }, { status: 202 });
      },
    });

    for (const choice of DISCORD_WORKER_STEER_CHOICES) {
      await expect(issueMissionSteering(registry, client, "thread-1", choice.intent)).resolves.toMatchObject({
        status: "issued",
        accepted: true,
      });
    }
    expect(submitted).toEqual(DISCORD_WORKER_STEER_CHOICES.map((choice) => choice.intent));
  });

  it("retains trusted Discord authority and policy at the real control-plane boundary", async () => {
    const deterministic = createDeterministicWorkerSteerAuthorizer();
    const controlPlane = await createControlPlane({
      doctrine,
      authorizeWorkerSteer: (input) =>
        input.intent.type === "summarize_status"
          ? Promise.resolve({ allowed: false, reason: "Probe policy denial." })
          : deterministic(input),
      authenticateCaptain: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer captain-token"
            ? { captainId: "captain-discord", steerSourceLane: "discord_text" }
            : undefined,
        ),
      authenticateRunner: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer runner-token"
            ? { runnerId: "runner-1" }
            : undefined,
        ),
    });
    const fetchImpl: typeof fetch = async (input, init) => controlPlane.fetch(new Request(input, init));
    const client = new ClankieApiClient({
      baseUrl: "http://control-plane.test",
      captainToken: "captain-token",
      fetchImpl,
    });
    const created = await controlPlane.request("/v1/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Verify Discord steering integration" }),
    });
    const { missionId } = (await created.json()) as { missionId: string };
    const plan = {
      missionId,
      goal: "Verify Discord steering integration",
      rationale: "Exercise the real typed policy boundary.",
      tasks: [
        {
          id: "implement",
          title: "Implement",
          objective: "Work",
          kind: "implementation",
          role: "implementer",
          writeScope: ["src/**"],
          successCriteria: ["done"],
          evidenceRequirements: ["diff"],
        },
        {
          id: "verify",
          title: "Verify",
          objective: "Verify",
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          successCriteria: ["verified"],
          evidenceRequirements: ["report"],
        },
      ],
      successCriteria: ["done"],
      profileHash: doctrine.profileHash,
    };
    expect(
      (
        await controlPlane.request(`/v1/missions/${missionId}/plan`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(plan),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await controlPlane.request(`/v1/missions/${missionId}/start`, {
          method: "POST",
          headers: { authorization: "Bearer captain-token" },
        })
      ).status,
    ).toBe(202);
    const claimed = await controlPlane.request("/v1/runner/claims", {
      method: "POST",
      headers: {
        authorization: "Bearer runner-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        claimId: "claim-1",
        workers: [
          {
            id: "codex",
            displayName: "Codex",
            harness: "codex",
            capabilities: {
              kinds: ["implementation"],
              canWrite: true,
              supportsStructuredEvents: true,
              supportsTerminal: true,
              supportsNativeSession: true,
            },
          },
        ],
      }),
    });
    const { assignment } = (await claimed.json()) as {
      assignment: { workerRunId: string; attempt: number };
    };
    const registry = new MissionThreadRegistry();
    registry.bind("thread-1", missionId);

    await expect(
      issueMissionSteering(registry, client, "thread-1", { type: "summarize_status" }),
    ).resolves.toMatchObject({ status: "control_plane_refused", httpStatus: 403 });
    await expect(
      issueMissionSteering(registry, client, "thread-1", { type: "continue" }),
    ).resolves.toMatchObject({ status: "issued", accepted: true });

    const commandResponse = await controlPlane.request("/v1/runner/steering/claim", {
      method: "POST",
      headers: {
        authorization: "Bearer runner-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workerRunId: assignment.workerRunId, attempt: assignment.attempt }),
    });
    await expect(commandResponse.json()).resolves.toMatchObject({
      command: {
        workerRunId: assignment.workerRunId,
        intent: { type: "continue" },
        sourceLane: "discord_text",
        principal: { kind: "captain", id: "captain-discord" },
      },
    });
  });
});

function boundRegistry(): MissionThreadRegistry {
  const registry = new MissionThreadRegistry();
  registry.bind("thread-1", "mission-1");
  return registry;
}

function runningMission(): Record<string, unknown> {
  return {
    id: "mission-1",
    state: "running",
    tasks: [
      {
        spec: { id: "task-1", title: "Implement" },
        state: "running",
        workerRunId: "worker-run-1",
      },
    ],
  };
}
