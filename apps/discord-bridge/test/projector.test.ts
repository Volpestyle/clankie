import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MissionThreadProjector } from "../src/projector.ts";
import { MissionThreadRegistry } from "../src/thread-registry.ts";

describe("mission thread projector", () => {
  it("polls bound missions and deduplicates unchanged projections", async () => {
    const registry = new MissionThreadRegistry();
    registry.bind("thread-1", "mission-1");
    const sent: string[] = [];
    const record = {
      id: "mission-1",
      state: "running",
      eventCount: 2,
      approvals: [],
      tasks: [{ spec: { id: "task-1", title: "Build" }, state: "running" }],
    };
    const projector = new MissionThreadProjector(
      registry,
      { getMission: async () => record },
      { send: async (_threadId, message) => void sent.push(message) },
      5_000,
    );

    await projector.refreshAll();
    await projector.refreshAll();
    expect(sent).toEqual(["Mission **mission-1** is **running**. - Build: **running**"]);

    record.state = "succeeded";
    record.tasks[0]!.state = "succeeded";
    await projector.refreshAll();
    expect(sent.slice(1)).toEqual([
      "Mission **mission-1** changed from **running** to **succeeded**. Task **Build** is now **succeeded**.",
    ]);
  });

  it("uses the registry cursor to suppress an unchanged summary after projector restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-projector-restart-"));
    const statePath = join(root, "state.json");
    const registry = new MissionThreadRegistry({ statePath });
    registry.bind("thread-1", "mission-1");
    const sent: string[] = [];
    const api = {
      getMission: async () => ({ id: "mission-1", state: "running", tasks: [], approvals: [] }),
    };
    const sink = { send: async (_threadId: string, message: string) => void sent.push(message) };
    await new MissionThreadProjector(registry, api, sink, 5_000).refreshAll();
    const restarted = new MissionThreadRegistry({ statePath });
    await new MissionThreadProjector(restarted, api, sink, 5_000).refreshAll();
    expect(sent).toHaveLength(1);
  });
});
