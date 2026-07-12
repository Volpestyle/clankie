import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore, projectMission } from "@clankie/event-store";
import type { MissionSnapshot } from "@clankie/mission-engine";
import { describe, expect, it } from "vitest";
import { runSelfBuildLab } from "../src/lab.ts";

describe("SQLite mission projection parity", () => {
  it("matches the in-memory mission snapshot across the self-build eval", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "clankie-parity-artifacts-"));
    const run = await runSelfBuildLab({ outputDirectory, generatedAt: "2026-07-10T00:00:00.000Z" });
    const snapshot = JSON.parse(
      await readFile(join(outputDirectory, "self-build-snapshot.json"), "utf8"),
    ) as MissionSnapshot;

    const store = new SqliteEventStore(
      join(await mkdtemp(join(tmpdir(), "clankie-parity-db-")), "events.db"),
    );
    for (const event of run.events) await store.append(event);
    const replayed = (await store.readAll()).map((entry) => entry.event);
    expect(replayed).toEqual(run.events);

    const projection = projectMission(replayed, snapshot.id);
    expect(projection.missionId).toBe(snapshot.id);
    expect(projection.goal).toBe(snapshot.goal);
    expect(projection.state).toBe(snapshot.state);
    expect(projection.profileHash).toBe(snapshot.profileHash);
    expect(projection.approvalCount).toBe(snapshot.approvals.length);
    expect(projection.eventCount).toBe(snapshot.eventCount);
    expect(projection.taskStates).toEqual(
      Object.fromEntries(snapshot.tasks.map((task) => [task.spec.id, task.state])),
    );
    store.close();
  });
});
