import { describe, expect, it, vi } from "vitest";
import {
  DISCORD_WORKER_STEER_CHOICES,
  issueMissionSteering,
  renderMissionSteeringReply,
  workerSteerIntentForDiscordChoice,
} from "../src/steering.ts";
import { MissionThreadRegistry } from "../src/thread-registry.ts";

describe("Discord mission steering", () => {
  it("resolves a trusted thread binding to the active worker and issues only the typed intent", async () => {
    const registry = new MissionThreadRegistry();
    registry.bind("thread-1", "mission-1");
    const steerWorker = vi.fn(async () => ({ accepted: true }));
    const api = {
      getMission: vi.fn(async () => ({
        id: "mission-1",
        state: "running",
        tasks: [
          {
            spec: { id: "task-1", title: "Implement" },
            state: "running",
            workerRunId: "worker-run-1",
          },
        ],
      })),
      steerWorker,
    };

    await expect(
      issueMissionSteering(registry, api, "thread-1", { type: "focus", target: "failing_test" }),
    ).resolves.toEqual({
      status: "issued",
      missionId: "mission-1",
      workerRunId: "worker-run-1",
      accepted: true,
    });
    expect(api.getMission).toHaveBeenCalledWith("mission-1");
    expect(steerWorker).toHaveBeenCalledWith("worker-run-1", {
      type: "focus",
      target: "failing_test",
    });
  });

  it("maps only registered choice values to finite worker steering intents", () => {
    for (const choice of DISCORD_WORKER_STEER_CHOICES) {
      expect(workerSteerIntentForDiscordChoice(choice.value)).toEqual(choice.intent);
    }
    expect(workerSteerIntentForDiscordChoice("merge_the_pull_request")).toBeUndefined();
    expect(workerSteerIntentForDiscordChoice("Continue.")).toBeUndefined();
  });

  it("does not query or steer for an unbound thread", async () => {
    const api = {
      getMission: vi.fn(async () => ({})),
      steerWorker: vi.fn(async () => ({ accepted: true })),
    };
    await expect(
      issueMissionSteering(new MissionThreadRegistry(), api, "unbound", { type: "continue" }),
    ).resolves.toEqual({ status: "thread_not_bound" });
    expect(api.getMission).not.toHaveBeenCalled();
    expect(api.steerWorker).not.toHaveBeenCalled();
  });

  it("returns a visible fail-closed result without relaying control-plane error content", async () => {
    const registry = new MissionThreadRegistry();
    registry.bind("thread-1", "mission-1");
    const api = {
      getMission: vi.fn(async () => ({
        id: "mission-1",
        state: "running",
        tasks: [
          {
            spec: { id: "task-1", title: "Implement" },
            state: "running",
            workerRunId: "worker-run-1",
          },
        ],
      })),
      steerWorker: vi.fn(async () => {
        throw new Error('Clankie API 403: {"error":"steer_policy_denied","reason":"private"}');
      }),
    };
    const result = await issueMissionSteering(registry, api, "thread-1", { type: "summarize_status" });

    expect(result).toEqual({
      status: "control_plane_refused",
      missionId: "mission-1",
      workerRunId: "worker-run-1",
      httpStatus: 403,
    });
    expect(renderMissionSteeringReply(result)).toBe(
      "Steering was refused by the control plane for worker run **worker-run-1** (HTTP 403).",
    );
    expect(renderMissionSteeringReply(result)).not.toContain("private");
  });

  it("fails closed when the control-plane snapshot belongs to another mission", async () => {
    const registry = new MissionThreadRegistry();
    registry.bind("thread-1", "mission-1");
    const api = {
      getMission: vi.fn(async () => ({
        id: "mission-2",
        state: "running",
        tasks: [
          {
            spec: { id: "task-2", title: "Other" },
            state: "running",
            workerRunId: "worker-other",
          },
        ],
      })),
      steerWorker: vi.fn(async () => ({ accepted: true })),
    };
    await expect(issueMissionSteering(registry, api, "thread-1", { type: "continue" })).resolves.toEqual({
      status: "mission_snapshot_mismatch",
      missionId: "mission-1",
    });
    expect(api.steerWorker).not.toHaveBeenCalled();
  });

  it("renders accepted and adapter-refused responses accurately", () => {
    expect(
      renderMissionSteeringReply({
        status: "issued",
        missionId: "mission-1",
        workerRunId: "worker-run-1",
        accepted: true,
      }),
    ).toContain("Steering accepted");
    expect(
      renderMissionSteeringReply({
        status: "issued",
        missionId: "mission-1",
        workerRunId: "worker-run-1",
        accepted: false,
      }),
    ).toContain("Steering was refused");
  });
});
