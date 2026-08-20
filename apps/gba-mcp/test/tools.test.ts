import type { EnvironmentActionResult, GbaEmulatorObservation } from "@clankie/interactive-environment";
import type { GbaCheckpointSummary, GbaDriverIo } from "@clankie/gba-emulator";
import { describe, expect, it, vi } from "vitest";
import { actTool, loadStateTool, observeTool, saveStateTool, type GbaToolContext } from "../src/tools.ts";

function overworld(): GbaEmulatorObservation {
  return {
    schemaVersion: 1,
    kind: "overworld",
    observationId: "obs-1",
    sessionId: "s",
    characterId: "gba-mcp-harness",
    worldId: "w",
    goalVersion: 0,
    capturedAt: "2026-07-25T18:00:00.000Z",
    frame: 1,
    data: {
      position: { mapId: "bedroom", x: 10, y: 5 },
      facing: "south",
      ramStateSha256: "b".repeat(64),
    },
  } as GbaEmulatorObservation;
}

function completed(actionId = "action-1"): EnvironmentActionResult {
  return {
    schemaVersion: 1,
    status: "completed",
    actionId,
    sessionId: "s",
    updatedAt: "2026-07-25T18:00:00.000Z",
    acceptedGoalVersion: 0,
    outcome: { applied: true },
  };
}

function context(overrides: Partial<GbaToolContext> = {}): GbaToolContext {
  const io: GbaDriverIo = {
    observe: (kind) => {
      if (kind !== "overworld") throw new Error(`no ${kind} view`);
      return overworld();
    },
    act: () => Promise.resolve(completed()),
    pause: () => Promise.resolve(),
    resume: () => Promise.resolve(),
  };
  return { io, framePng: () => null, ...overrides };
}

const summary: GbaCheckpointSummary = {
  checkpointId: "2026-07-25T18-00-00-000Z-before-rival-a1b2c3d4e5f6",
  label: "before-rival",
  capturedAt: "2026-07-25T18:00:00.000Z",
  position: { mapId: "pallet-town/oaks-lab", x: 6, y: 10 },
};

describe("gba mcp tools", () => {
  it("returns decoded state and the rendered screen together", () => {
    const result = observeTool(context({ framePng: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }), {});
    expect(result.content.map((part) => part.type)).toEqual(["text", "image"]);
    expect(String((result.content[0] as { text: string }).text)).toContain("gba-mcp-harness");
  });

  it("dispatches the canonical nested action and returns the complete shared result", async () => {
    const act = vi.fn(() => Promise.resolve(completed()));
    const result = await actTool(context({ io: { ...context().io, act } }), {
      action: { kind: "button_press", button: "left", holdFrames: 16 },
    });
    expect(act).toHaveBeenCalledWith({ kind: "button_press", button: "left", holdFrames: 16 });
    expect(result.structuredContent).toEqual(completed());
    expect(JSON.parse(String((result.content[0] as { text: string }).text))).toEqual(completed());
  });

  it("preserves a shared failed action result instead of flattening it", async () => {
    const failed: EnvironmentActionResult = {
      schemaVersion: 1,
      status: "failed",
      actionId: "action-1",
      sessionId: "s",
      updatedAt: "2026-07-25T18:00:00.000Z",
      acceptedGoalVersion: 0,
      errorCode: "frame_bound_exceeded",
      message: "too many frames",
      retryable: false,
    };
    const result = await actTool(context({ io: { ...context().io, act: () => Promise.resolve(failed) } }), {
      action: { kind: "frame_advance", frames: 2_000 },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(failed);
  });

  it("saves, lists, and restores only through checkpoint hooks", () => {
    const saveCheckpoint = vi.fn(() => summary);
    expect(saveStateTool(context({ saveCheckpoint }), "before-rival").isError).toBeUndefined();
    expect(saveCheckpoint).toHaveBeenCalledWith("before-rival");

    const loadCheckpoint = vi.fn(() => summary);
    const listed = loadStateTool(context({ loadCheckpoint, listCheckpoints: () => [summary] }), undefined);
    expect(loadCheckpoint).not.toHaveBeenCalled();
    expect(String((listed.content[0] as { text: string }).text)).toContain(summary.checkpointId);

    const loaded = loadStateTool(
      context({ loadCheckpoint, listCheckpoints: () => [summary] }),
      summary.checkpointId,
    );
    expect(loadCheckpoint).toHaveBeenCalledWith(summary.checkpointId);
    expect(String((loaded.content[1] as { text: string }).text)).toContain("bedroom");
  });

  it("refuses checkpoint operations when the deterministic double has no state bytes", () => {
    expect(saveStateTool(context(), undefined).isError).toBe(true);
    expect(loadStateTool(context(), undefined).isError).toBe(true);
  });
});
