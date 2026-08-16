import { describe, expect, it } from "vitest";
import {
  GBA_EMULATOR_CAPABILITY_BOUNDARY,
  GbaEmulatorActionRequestSchema,
  GbaEmulatorActionSchema,
  GbaEmulatorCapabilityBoundarySchema,
  GbaEmulatorObservationSchema,
  GbaEmulatorResourceBoundsSchema,
  GbaEmulatorSessionSpecSchema,
  GbaEmulatorStartActionCommandSchema,
  EnvironmentLeaseV2Schema,
  isGbaEmulatorCapabilityLocal,
  normalizeEnvironmentSessionSpec,
  resolveGbaEmulatorToolExposure,
} from "../src/index.ts";

const bounds = {
  profile: "gba_emulator",
  coreId: "gba-core-double-v1",
  savestateId: "verdant-path-savestate-v1",
  savestateSha256: "9be05ed42a7ec145e7f98cc22003844f63501b478f829e58581e805c0abd90fe",
  rngSeed: 20_260_719,
  worldId: "gba-emulator-lab-v1",
  characterId: "clankie",
  maxInputsPerAction: 8,
  maxFramesPerAction: 600,
  maxActionDurationMs: 5_000,
  capabilities: ["emulator.gba.observe", "emulator.gba.input"],
} as const;

const spec = {
  schemaVersion: 2,
  sessionId: "gba-session-1",
  environmentKind: "gba_emulator",
  characterId: "clankie",
  worldId: "gba-emulator-lab-v1",
  requestedBy: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
  initialGoalVersion: 1,
  resourceBounds: bounds,
} as const;

describe("GBA emulator contract", () => {
  it("accepts bounded button, frame-advance, and wait actions and rejects impossible values", () => {
    expect(
      GbaEmulatorActionSchema.parse({ kind: "button_press", button: "a", holdFrames: 12 }),
    ).toMatchObject({ kind: "button_press" });
    expect(GbaEmulatorActionSchema.parse({ kind: "frame_advance", frames: 60 })).toMatchObject({
      frames: 60,
    });
    expect(GbaEmulatorActionSchema.parse({ kind: "wait", durationMs: 500 })).toMatchObject({ kind: "wait" });
    expect(() =>
      GbaEmulatorActionSchema.parse({ kind: "button_press", button: "turbo", holdFrames: 12 }),
    ).toThrow();
    expect(() =>
      GbaEmulatorActionSchema.parse({ kind: "button_press", button: "a", holdFrames: 0 }),
    ).toThrow();
    expect(() =>
      GbaEmulatorActionSchema.parse({ kind: "button_press", button: "a", holdFrames: 12_000 }),
    ).toThrow();
    expect(() => GbaEmulatorActionSchema.parse({ kind: "macro_replay", inputs: [] })).toThrow();
    expect(() =>
      GbaEmulatorActionSchema.parse({ kind: "button_press", button: "a", holdFrames: 12, memory: "0x0" }),
    ).toThrow();
    expect(() =>
      GbaEmulatorActionRequestSchema.parse({
        kind: "other_environment_action",
        action: { kind: "button_press", button: "a", holdFrames: 12 },
        limits: { maxInputs: 8, maxFrames: 600, timeoutMs: 5_000 },
      }),
    ).toThrow();
  });

  it("normalizes an emulator session spec through the shared v2 union without field leakage", () => {
    const normalized = normalizeEnvironmentSessionSpec(spec);
    expect(normalized.resourceBounds).toMatchObject({ profile: "gba_emulator" });
    expect(Object.keys(normalized.resourceBounds)).not.toContain("serverId");
    expect(Object.keys(normalized.resourceBounds)).not.toContain("allowedMapIds");
    expect(Object.keys(normalized.resourceBounds)).not.toContain("simulatorId");
    // Other environment vocabulary cannot enter the emulator contract.
    expect(() => GbaEmulatorResourceBoundsSchema.parse({ ...bounds, serverId: "not-a-server" })).toThrow();
    expect(() =>
      GbaEmulatorResourceBoundsSchema.parse({ ...bounds, allowedMapIds: ["verdant-path"] }),
    ).toThrow();
    expect(() => GbaEmulatorResourceBoundsSchema.parse({ ...bounds, maxBlockChangesPerAction: 0 })).toThrow();
    expect(() =>
      GbaEmulatorResourceBoundsSchema.parse({ ...bounds, capabilities: ["environment.remote.observe"] }),
    ).toThrow();
    // The environment kind must match the emulator profile and its bindings.
    expect(() =>
      GbaEmulatorSessionSpecSchema.parse({ ...spec, environmentKind: "other_environment" }),
    ).toThrow();
    expect(() =>
      normalizeEnvironmentSessionSpec({ ...spec, environmentKind: "other_environment" }),
    ).toThrow();
    expect(() => GbaEmulatorSessionSpecSchema.parse({ ...spec, worldId: "other-world" })).toThrow(
      /world binding mismatch/,
    );
    expect(() => GbaEmulatorSessionSpecSchema.parse({ ...spec, characterId: "someone-else" })).toThrow(
      /character binding mismatch/,
    );
    expect(() =>
      GbaEmulatorResourceBoundsSchema.parse({ ...bounds, savestateSha256: "not-a-digest" }),
    ).toThrow();
  });

  it("binds emulator bounds into the v2 lease", () => {
    const lease = EnvironmentLeaseV2Schema.parse({
      schemaVersion: 2,
      leaseId: "lease-1",
      sessionId: "gba-session-1",
      holderId: "runner",
      issuedAt: "2026-07-19T00:00:00.000Z",
      heartbeatAt: "2026-07-19T00:00:00.000Z",
      expiresAt: "2026-07-19T00:01:00.000Z",
      resourceBounds: bounds,
    });
    expect(lease.resourceBounds).toMatchObject({ profile: "gba_emulator" });
  });

  it("parses strict start-action commands and rejects unknown fields", () => {
    const command = {
      schemaVersion: 1,
      commandId: "command-1",
      type: "start_action",
      requestedAt: "2026-07-19T00:00:00.000Z",
      context: {
        sourceLane: "gameplay",
        authority: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
        correlationId: "correlation-1",
        expectedGoalVersion: 1,
      },
      sessionId: "gba-session-1",
      actionId: "action-1",
      action: {
        kind: "gba_emulator_action",
        action: { kind: "button_press", button: "a", holdFrames: 12 },
        limits: { maxInputs: 8, maxFrames: 600, timeoutMs: 5_000 },
      },
    };
    expect(GbaEmulatorStartActionCommandSchema.parse(command)).toMatchObject({ actionId: "action-1" });
    expect(() => GbaEmulatorStartActionCommandSchema.parse({ ...command, packetInjection: true })).toThrow();
  });

  it("bounds observations and rejects impossible or unknown observation data", () => {
    const base = {
      schemaVersion: 1,
      observationId: "obs-1",
      sessionId: "gba-session-1",
      characterId: "clankie",
      worldId: "gba-emulator-lab-v1",
      goalVersion: 1,
      capturedAt: "2026-07-19T00:00:01.000Z",
      frame: 42,
    };
    expect(
      GbaEmulatorObservationSchema.parse({
        ...base,
        kind: "overworld",
        data: {
          position: { mapId: "verdant-path", x: 1, y: 1 },
          facing: "east",
          ramStateSha256: "a".repeat(64),
        },
      }),
    ).toMatchObject({ kind: "overworld" });
    expect(
      GbaEmulatorObservationSchema.parse({
        ...base,
        kind: "frame_reference",
        data: {
          artifactId: "gba-session-1:frame:42",
          uri: "artifact://gba-emulator/gba-session-1/frames/42",
          framebufferSha256: "b".repeat(64),
          ramStateSha256: "c".repeat(64),
          summary: "Bounded framebuffer reference",
        },
      }),
    ).toMatchObject({ kind: "frame_reference" });
    expect(() =>
      GbaEmulatorObservationSchema.parse({
        ...base,
        kind: "frame_reference",
        data: {
          artifactId: "gba-session-1:frame:42",
          uri: "https://example.com/frame.png",
          framebufferSha256: "b".repeat(64),
          ramStateSha256: "c".repeat(64),
          summary: "raw network URI is not a bounded artifact reference",
        },
      }),
    ).toThrow();
    expect(() =>
      GbaEmulatorObservationSchema.parse({
        ...base,
        kind: "party",
        data: {
          activeSlot: 0,
          members: [
            { slot: 0, speciesId: "embercub", level: 8, currentHp: 25, maxHp: 20, status: "healthy" },
          ],
        },
      }),
    ).toThrow(/HP exceeds max/);
    expect(
      GbaEmulatorObservationSchema.parse({
        ...base,
        kind: "inventory",
        data: {
          items: [
            {
              pocket: "poke-balls",
              itemId: "firered-item-4",
              count: 12,
            },
          ],
        },
      }),
    ).toMatchObject({ kind: "inventory" });
    expect(() =>
      GbaEmulatorObservationSchema.parse({
        ...base,
        kind: "battle",
        data: {
          battleId: "battle-1",
          turn: 1,
          phase: "awaiting_input",
          opponent: { speciesId: "sproutlet", level: 6, currentHp: 12, maxHp: 12 },
          activePartySlot: 0,
          moveCursor: 0,
          legalMoves: [{ moveId: "tackle", power: 3 }],
          untrusted: false,
        },
      }),
    ).toThrow();
    expect(() => GbaEmulatorObservationSchema.parse({ ...base, kind: "ram_dump", data: {} })).toThrow();
  });

  it("scopes gameplay tools to the active gameplay lane and keeps dormant sessions join/status-only", () => {
    expect(resolveGbaEmulatorToolExposure("off", "gameplay")).toMatchObject({
      lifecycleTools: ["gba_emulator_join", "gba_emulator_status"],
      gameplayTools: [],
    });
    expect(resolveGbaEmulatorToolExposure("failed", "tui")).toMatchObject({
      lifecycleTools: ["gba_emulator_join", "gba_emulator_status"],
      gameplayTools: [],
    });
    expect(resolveGbaEmulatorToolExposure("active", "gameplay").gameplayTools).toEqual([
      "gba_emulator_observe",
      "gba_emulator_start_action",
      "gba_emulator_action_status",
      "gba_emulator_cancel_action",
    ]);
    // Supervision lanes steer, pause, resume, and disconnect without gameplay tools.
    expect(resolveGbaEmulatorToolExposure("active", "tui")).toMatchObject({
      lifecycleTools: [
        "gba_emulator_status",
        "gba_emulator_steer",
        "gba_emulator_pause",
        "gba_emulator_disconnect",
      ],
      gameplayTools: [],
    });
    expect(resolveGbaEmulatorToolExposure("paused", "tui").lifecycleTools).toContain("gba_emulator_resume");
    expect(resolveGbaEmulatorToolExposure("active", "discord_voice").gameplayTools).toEqual([]);
  });

  it("cannot represent a network or live-service tamper capability", () => {
    expect(GBA_EMULATOR_CAPABILITY_BOUNDARY.networkCapabilities).toEqual([]);
    expect(GBA_EMULATOR_CAPABILITY_BOUNDARY.remoteTamperCapabilities).toEqual([]);
    expect(() =>
      GbaEmulatorCapabilityBoundarySchema.parse({
        ...GBA_EMULATOR_CAPABILITY_BOUNDARY,
        networkCapabilities: ["emulator.gba.upload"],
      }),
    ).toThrow();
    expect(isGbaEmulatorCapabilityLocal("emulator.gba.input")).toBe(true);
    expect(isGbaEmulatorCapabilityLocal("environment.remote.act")).toBe(false);
  });
});
