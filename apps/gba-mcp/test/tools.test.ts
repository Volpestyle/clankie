import {
  GbaEmulatorActionSchema,
  type EnvironmentActionResult,
  type GbaEmulatorObservation,
} from "@clankie/interactive-environment";
import { FREE_PLAY_ACTION_LIMITS, type GbaDriverIo } from "@clankie/gba-emulator";
import { describe, expect, it, vi } from "vitest";
import {
  ActArgumentsSchema,
  actTool,
  loadStateTool,
  observeTool,
  resumeTool,
  saveStateTool,
  toAction,
  type GbaCheckpointSummary,
  type GbaToolContext,
} from "../src/tools.ts";

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
    resume: () => Promise.resolve(),
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

  it("shows a carried monologue to watchers as the action dispatches", async () => {
    const publishThought = vi.fn();
    const result = await actTool(context({ publishThought }), {
      actionKind: "button_press",
      button: "up",
      monologue: "The stairs are up-right; heading there.",
    });
    expect(result.isError).toBeUndefined();
    expect(publishThought).toHaveBeenCalledWith("The stairs are up-right; heading there.");
  });

  it("keeps the overlay silent without a monologue, and for actions that never dispatch", async () => {
    const publishThought = vi.fn();
    await actTool(context({ publishThought }), { actionKind: "button_press", button: "up" });
    // A malformed action is refused before dispatch; its thought never shows.
    await actTool(context({ publishThought }), {
      actionKind: "button_press",
      button: "turbo" as never,
      monologue: "never shown",
    });
    expect(publishThought).not.toHaveBeenCalled();
  });

  it("never lets a non-holder put words on the surface", async () => {
    const publishThought = vi.fn();
    const result = await actTool(
      context({
        publishThought,
        assertMayAct: () => {
          throw new Error("possession_lease_not_held");
        },
      }),
      { actionKind: "button_press", button: "up", monologue: "smuggled" },
    );
    expect(result.isError).toBe(true);
    expect(publishThought).not.toHaveBeenCalled();
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

  it("gates resume like acting: pausing is safe from anyone, resuming is driving", async () => {
    const resume = vi.fn(() => Promise.resolve());
    const refused = await resumeTool(
      context({
        io: { ...context().io, resume },
        assertMayAct: () => {
          throw new Error("possession_lease_not_held");
        },
      }),
    );
    expect(refused.isError).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    const allowed = await resumeTool(context({ io: { ...context().io, resume } }));
    expect(allowed.isError).toBeUndefined();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("gates checkpointing like acting, and reports when the double cannot checkpoint", () => {
    const saveCheckpoint = vi.fn();
    const refused = saveStateTool(
      context({
        saveCheckpoint,
        assertMayAct: () => {
          throw new Error("possession_lease_not_held");
        },
      }),
      undefined,
    );
    expect(refused.isError).toBe(true);
    expect(saveCheckpoint).not.toHaveBeenCalled();

    // No capability wired: the deterministic double has nothing to serialize.
    const unavailable = saveStateTool(context(), undefined);
    expect(unavailable.isError).toBe(true);
    expect(String((unavailable.content[0] as { text: string }).text)).toContain("checkpoints_unavailable");
  });

  it("saves through the hook and names what was saved", () => {
    const summary: GbaCheckpointSummary = {
      checkpointId: "2026-07-25T18-00-00-000Z-before-rival",
      label: "before-rival",
      capturedAt: "2026-07-25T18:00:00.000Z",
      position: { mapId: "pallet-town/oaks-lab", x: 6, y: 10 },
    };
    const saveCheckpoint = vi.fn(() => summary);
    const result = saveStateTool(context({ saveCheckpoint }), "before-rival");
    expect(saveCheckpoint).toHaveBeenCalledWith("before-rival");
    const text = String((result.content[0] as { text: string }).text);
    expect(text).toContain("before-rival");
    expect(text).toContain("oaks-lab");
  });

  it("lists checkpoints when no id is given, instead of guessing which to load", () => {
    const summary: GbaCheckpointSummary = {
      checkpointId: "2026-07-25T18-00-00-000Z",
      label: null,
      capturedAt: "2026-07-25T18:00:00.000Z",
      position: null,
    };
    const loadCheckpoint = vi.fn();
    const result = loadStateTool(context({ loadCheckpoint, listCheckpoints: () => [summary] }), undefined);
    expect(loadCheckpoint).not.toHaveBeenCalled();
    expect(String((result.content[0] as { text: string }).text)).toContain(summary.checkpointId);
  });

  it("restores through the hook and returns the restored view with it", () => {
    const summary: GbaCheckpointSummary = {
      checkpointId: "2026-07-25T18-00-00-000Z",
      label: null,
      capturedAt: "2026-07-25T18:00:00.000Z",
      position: null,
    };
    const loadCheckpoint = vi.fn(() => summary);
    const result = loadStateTool(
      context({ loadCheckpoint, listCheckpoints: () => [summary] }),
      summary.checkpointId,
    );
    expect(loadCheckpoint).toHaveBeenCalledWith(summary.checkpointId);
    expect(result.isError).toBeUndefined();
    // The caller gets the post-restore state without paying for an observe.
    expect(String((result.content[0] as { text: string }).text)).toContain("restored checkpoint");
    expect(String((result.content[1] as { text: string }).text)).toContain("bedroom");
  });

  it("surfaces a failed restore as an error, never a silent success", () => {
    const result = loadStateTool(
      context({
        loadCheckpoint: () => {
          throw new Error("checkpoint_not_found: nope");
        },
        listCheckpoints: () => [],
      }),
      "nope",
    );
    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain("checkpoint_not_found");
  });

  it("advertises exactly the repeat budget the lease allows, never more", () => {
    // A schema promising more than the lease teaches a driver to distrust
    // both and press one button at a time (the timid-repeat regression).
    const press = { actionKind: "button_press", button: "a" } as const;
    expect(
      ActArgumentsSchema.safeParse({ ...press, repeat: FREE_PLAY_ACTION_LIMITS.maxInputs }).success,
    ).toBe(true);
    expect(
      ActArgumentsSchema.safeParse({ ...press, repeat: FREE_PLAY_ACTION_LIMITS.maxInputs + 1 }).success,
    ).toBe(false);
  });

  it("defaults a hold long enough to commit a step", () => {
    // A short tap only turns the character; an omitted hold should still move.
    expect(toAction({ actionKind: "button_press", button: "up" })).toMatchObject({ holdFrames: 16 });
    expect(toAction({ actionKind: "button_press", button: "up", repeat: 1 })).not.toHaveProperty("repeat");
    expect(toAction({ actionKind: "button_press", button: "up", repeat: 4 })).toMatchObject({ repeat: 4 });
  });

  it("maps a dialog advance to the catalogued action, carrying no arguments", () => {
    // The action takes nothing: where it stops is read from the game, never
    // supplied by the caller (ADR 0066).
    expect(toAction({ actionKind: "advance_dialog" })).toEqual({ kind: "advance_dialog" });
    expect(GbaEmulatorActionSchema.safeParse(toAction({ actionKind: "advance_dialog" })).success).toBe(true);
  });
});
