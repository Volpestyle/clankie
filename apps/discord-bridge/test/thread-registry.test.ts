import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MissionThreadRegistry,
  ZERO_RETENTION_STATUS,
  threadNameForMission,
} from "../src/thread-registry.ts";

describe("Discord mission thread registry", () => {
  it("never restores authority from a Discord-controlled thread name", () => {
    const registry = new MissionThreadRegistry();
    expect(
      registry.restoreFromThreadName("attacker-thread", threadNameForMission("mission-secret")),
    ).toBeUndefined();
    expect(registry.entries()).toEqual([]);
  });

  it("enforces one trusted guild-scoped thread per mission", () => {
    const registry = new MissionThreadRegistry();
    const canonical = registry.bind("thread-1", "mission-1", "guild-1");
    expect(registry.bind("thread-2", "mission-1", "guild-1")).toEqual(canonical);
    expect(registry.entries()).toEqual([["thread-1", "mission-1"]]);
    expect(registry.missionId("thread-1", "guild-1")).toBe("mission-1");
    expect(registry.missionId("thread-1", "guild-2")).toBeUndefined();
    expect(registry.missionId("thread-2", "guild-1")).toBeUndefined();
  });

  it("persists trusted bindings, creation idempotency, and projection cursors", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-discord-registry-"));
    const statePath = join(root, "state.json");
    const first = new MissionThreadRegistry({ statePath });
    first.recordCreation("guild-1", "interaction-1", "mission-1");
    expect(() => first.recordCreation("guild-1", "interaction-1", "mission-other")).toThrow(
      "another mission",
    );
    first.bind("thread-1", "mission-1", "guild-1", "interaction-1");
    first.recordProjectionFingerprint("thread-1", "mission-1", "fingerprint-1");
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);

    const restarted = new MissionThreadRegistry({ statePath });
    expect(restarted.creationForInteraction("guild-1", "interaction-1")).toMatchObject({
      missionId: "mission-1",
    });
    expect(restarted.missionId("thread-1", "guild-1")).toBe("mission-1");
    expect(restarted.projectionFingerprint("thread-1", "mission-1")).toBe("fingerprint-1");
  });

  it("persists an incomplete creation before the API request so retry fails closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-discord-pending-"));
    const statePath = join(root, "state.json");
    new MissionThreadRegistry({ statePath }).beginCreation("guild-1", "interaction-1");
    const restarted = new MissionThreadRegistry({ statePath });
    expect(restarted.creationForInteraction("guild-1", "interaction-1")).toEqual({
      guildId: "guild-1",
      interactionId: "interaction-1",
    });
    expect(restarted.entries()).toEqual([]);
  });

  it("forgets only the exact guild-scoped bridge correlation", () => {
    const registry = new MissionThreadRegistry();
    registry.bind("thread-1", "mission-1", "guild-1");
    expect(registry.forget("thread-1", "guild-2")).toBe(false);
    expect(registry.forget("thread-1", "guild-1")).toBe(true);
    expect(registry.missionId("thread-1", "guild-1")).toBeUndefined();
  });

  it("states the enforced zero-transcript invariant without claiming upstream deletion", () => {
    expect(ZERO_RETENTION_STATUS).toContain("transcript retention is **off**");
    expect(ZERO_RETENTION_STATUS).toContain("does not");
  });
});
