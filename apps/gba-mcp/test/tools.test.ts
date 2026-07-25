import type { EnvironmentActionResult, GbaEmulatorObservation } from "@clankie/interactive-environment";
import type { GbaDriverIo } from "@clankie/gba-emulator";
import { describe, expect, it, vi } from "vitest";
import { actTool, observeTool, toAction, type GbaToolContext } from "../src/tools.ts";

function overworld(): GbaEmulatorObservation {
  return {
    schemaVersion: 1,
    kind: "overworld",
    observationId: "obs-1",
    sessionId: "s",
    characterId: "clankie",
    worldId: "w",
    goalVersion: 0,
    capturedAt: "2026-07-25T18:00:00.000Z",
    frame: 1,
    data: {
      position: { mapId: "bedroom", x: 10, y: 5 },
      facing: "south",
      ramStateSha256: "b".repeat(64),
    },
  } as unknown as GbaEmulatorObservation;
}

function completed(): EnvironmentActionResult {
  return {
    schemaVersion: 1,
    status: "completed",
    actionId: "11111111-1111-4111-8111-111111111111",
    sessionId: "s",
    updatedAt: "2026-07-25T18:00:00.000Z",
    acceptedGoalVersion: 0,
    outcome: { applied: true },
  } as EnvironmentActionResult;
}

function context(overrides: Partial<GbaToolContext> = {}): GbaToolContext {
  const io: GbaDriverIo = {
    observe: (kind) => {
      if (kind !== "overworld") throw new Error(`no ${kind} view`);
      return overworld();
    },
    act: () => Promise.resolve(completed()),
    pause: () => Promise.resolve(),
  };
  return { io, framePng: () => null, ...overrides };
}

describe("gba mcp tools", () => {
  it("returns the decoded state and the screen together", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const result = observeTool(context({ framePng: () => png }), {});
    const kinds = result.content.map((part) => part.type);
    // The caller sees what Clankie sees, not only what the decoder exposes.
    expect(kinds).toEqual(["text", "image"]);
    expect(String((result.content[0] as { text: string }).text)).toContain("bedroom");
  });

  it("omits the image when nothing has rendered, rather than sending an empty one", () => {
    const result = observeTool(context(), {});
    expect(result.content.map((part) => part.type)).toEqual(["text"]);
  });

  it("dispatches a catalogued action through the runtime seam", async () => {
    const act = vi.fn(() => Promise.resolve(completed()));
    const result = await actTool(context({ io: { ...context().io, act } }), {
      actionKind: "button_press",
      button: "left",
      holdFrames: 16,
    });
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ kind: "button_press", button: "left" }));
    expect(result.isError).toBeUndefined();
  });

  it("fails closed on an uncatalogued button instead of guessing", async () => {
    const result = await actTool(context(), {
      actionKind: "button_press",
      // Not in the frozen catalogue.
      button: "turbo" as never,
      holdFrames: 16,
    });
    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain("invalid_action");
  });

  it("surfaces an emulator refusal as an error, not a silent success", async () => {
    const refused = {
      ...completed(),
      status: "failed",
      errorCode: "frame_bound_exceeded",
      message: "too many frames",
      retryable: false,
    } as unknown as EnvironmentActionResult;
    const result = await actTool(context({ io: { ...context().io, act: () => Promise.resolve(refused) } }), {
      actionKind: "frame_advance",
      // Valid per the schema, so this reaches the emulator and is refused there
      // rather than being rejected as malformed before dispatch.
      frames: 100,
    });
    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain("refused");
  });

  it("refuses gameplay when another holder owns the body", async () => {
    // The P2 lease hook: observation stays open, acting does not.
    const result = await actTool(
      context({
        assertMayAct: () => {
          throw new Error("possession_lease_not_held");
        },
      }),
      { actionKind: "button_press", button: "left", holdFrames: 16 },
    );
    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain("possession_lease_not_held");
  });

  it("defaults a hold long enough to commit a step", () => {
    // A short tap only turns the character; an omitted hold should still move.
    expect(toAction({ actionKind: "button_press", button: "up" })).toMatchObject({ holdFrames: 16 });
    expect(toAction({ actionKind: "button_press", button: "up", repeat: 1 })).not.toHaveProperty("repeat");
    expect(toAction({ actionKind: "button_press", button: "up", repeat: 4 })).toMatchObject({ repeat: 4 });
  });
});
