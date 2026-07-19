import {
  EnvironmentSemanticEventSchema,
  GbaEmulatorSessionSpecSchema,
  GbaMapPositionSchema,
  type EnvironmentEvent,
  type EnvironmentSemanticEvent,
  type GbaEmulatorAction,
  type GbaEmulatorObservation,
  type GbaEmulatorStartActionCommand,
} from "@clankie/interactive-environment";
import { EnvironmentRuntime } from "@clankie/environment-runtime";
import { z } from "zod";
import { GbaEmulatorAdapter } from "./adapter.ts";
import { Sha256Schema, type GbaEmulatorTrace } from "./contracts.ts";
import { canonicalJson, sha256 } from "./core-double.ts";
import type { GbaCoreSeam } from "./core-seam.ts";

/**
 * Real-core route scenario (VUH-913, ADR 0040): Clankie boots the real
 * headless mGBA core from a pinned savestate and walks a bounded overworld
 * route to a target tile. Every decision is a pure function of the latest
 * decoded observation — a BFS step over the empirically verified tile map
 * from the currently observed position — and every action flows through
 * `EnvironmentRuntime.startAction` into the same governed adapter the CI
 * double uses. There is no input transcript: move the observed position and
 * the next decision changes with it.
 *
 * The fixture's tile map (bounds + blocked set) was probed against the
 * running ROM: a tile is listed walkable only after the emulator actually
 * moved the player onto it. Anything unprobed is treated as blocked.
 */

export const REAL_GBA_SCENARIO_SCHEMA_VERSION = 1 as const;

const TileSchema = z
  .object({ x: z.number().int().nonnegative().max(4_096), y: z.number().int().nonnegative().max(4_096) })
  .strict();

export const RealGbaRouteScenarioSchema = z
  .object({
    schemaVersion: z.literal(REAL_GBA_SCENARIO_SCHEMA_VERSION),
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    coreId: z.string().min(1).max(128),
    savestateId: z.string().min(1).max(128),
    /** SHA-256 of the pinned savestate bytes (the bytes stay operator-local). */
    savestateSha256: Sha256Schema,
    /** SHA-256 of the operator-supplied ROM bytes (never stored in-repo). */
    romSha256: Sha256Schema,
    /** SHA-256 of the pinned mGBA core wasm binary (supply-chain anchor). */
    coreWasmSha256: Sha256Schema,
    /** The core is frame-stepped; game RNG state comes from the savestate. */
    rngSeed: z.number().int().nonnegative().max(4_294_967_295),
    worldId: z.string().min(1).max(256),
    player: z.object({ characterId: z.string().min(1).max(256) }).strict(),
    maxEvidenceEvents: z.number().int().positive().max(256),
    maxDecisions: z.number().int().positive().max(256),
    /** Frames each route step holds its d-pad button. */
    holdFramesPerStep: z.number().int().positive().max(240),
    map: z
      .object({
        mapId: z.string().min(1).max(128),
        bounds: z
          .object({
            minX: z.number().int().nonnegative().max(4_096),
            maxX: z.number().int().nonnegative().max(4_096),
            minY: z.number().int().nonnegative().max(4_096),
            maxY: z.number().int().nonnegative().max(4_096),
          })
          .strict(),
        /** Verified-unwalkable and unprobed tiles inside the bounds. */
        blocked: z.array(TileSchema).max(256),
      })
      .strict(),
    start: GbaMapPositionSchema,
    target: GbaMapPositionSchema,
    expected: z.object({ minimumDecisions: z.number().int().positive().max(256) }).strict(),
  })
  .strict()
  .superRefine((scenario, context) => {
    const { bounds } = scenario.map;
    if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) {
      context.addIssue({ code: "custom", path: ["map", "bounds"], message: "map bounds are inverted" });
    }
    const blocked = new Set(scenario.map.blocked.map((tile) => `${String(tile.x)},${String(tile.y)}`));
    for (const [label, position] of [
      ["start", scenario.start],
      ["target", scenario.target],
    ] as const) {
      if (position.mapId !== scenario.map.mapId) {
        context.addIssue({ code: "custom", path: [label], message: `${label} is not on the scenario map` });
      }
      if (
        position.x < bounds.minX ||
        position.x > bounds.maxX ||
        position.y < bounds.minY ||
        position.y > bounds.maxY ||
        blocked.has(`${String(position.x)},${String(position.y)}`)
      ) {
        context.addIssue({ code: "custom", path: [label], message: `${label} is not a walkable tile` });
      }
    }
  });
export type RealGbaRouteScenario = z.infer<typeof RealGbaRouteScenarioSchema>;

export const RealGbaReasonCodeSchema = z.enum([
  "route_step_toward_target",
  "halt_target_reached",
  "halt_uncertain_state",
  "halt_action_failed",
  "halt_route_unreachable",
  "halt_decision_budget_exhausted",
]);
export type RealGbaReasonCode = z.infer<typeof RealGbaReasonCodeSchema>;

export const RealGbaDecisionSchema = z
  .object({
    schemaVersion: z.literal(REAL_GBA_SCENARIO_SCHEMA_VERSION),
    sequence: z.number().int().positive().max(256),
    observedPosition: GbaMapPositionSchema,
    observedFacing: z.enum(["north", "east", "south", "west"]),
    observedFrame: z.number().int().nonnegative().max(100_000_000),
    observedRamStateSha256: Sha256Schema,
    reasonCode: RealGbaReasonCodeSchema,
    action: z
      .object({
        kind: z.literal("button_press"),
        button: z.enum(["up", "down", "left", "right"]),
        holdFrames: z.number().int().positive().max(240),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    const halts = decision.reasonCode.startsWith("halt_");
    if (halts === (decision.action !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "halt decisions carry no action and acting decisions must carry one",
      });
    }
  });
export type RealGbaDecision = z.infer<typeof RealGbaDecisionSchema>;

export const RealGbaDecisionTraceSchema = z
  .object({
    schemaVersion: z.literal(REAL_GBA_SCENARIO_SCHEMA_VERSION),
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    fixtureSha256: Sha256Schema,
    decisions: z.array(RealGbaDecisionSchema).min(1).max(256),
  })
  .strict()
  .superRefine((trace, context) => {
    let previousFrame = -1;
    for (const [index, decision] of trace.decisions.entries()) {
      if (decision.sequence !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["decisions", index, "sequence"],
          message: "decision sequence is not contiguous",
        });
      }
      if (decision.observedFrame < previousFrame) {
        context.addIssue({
          code: "custom",
          path: ["decisions", index, "observedFrame"],
          message: "decision observed a frame older than its predecessor",
        });
      }
      previousFrame = decision.observedFrame;
    }
  });
export type RealGbaDecisionTrace = z.infer<typeof RealGbaDecisionTraceSchema>;

const RealArtifactReferenceSchema = z
  .object({
    kind: z.enum(["event_trace", "decision_trace", "frame"]),
    artifactId: z.string().min(1).max(256),
    uri: z.string().regex(/^artifact:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u),
    sha256: Sha256Schema,
    summary: z.string().min(1).max(512),
  })
  .strict();

export const RealGbaScenarioReportSchema = z
  .object({
    schemaVersion: z.literal(REAL_GBA_SCENARIO_SCHEMA_VERSION),
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    fixtureSha256: Sha256Schema,
    runId: z.string().min(1).max(128),
    result: z.enum(["passed", "failed"]),
    halt: z.enum([
      "target_reached",
      "uncertain_state",
      "action_failed",
      "route_unreachable",
      "decision_budget_exhausted",
    ]),
    checks: z
      .object({
        identityVerified: z.boolean(),
        targetLocationReached: z.boolean(),
        decisionsStateDerived: z.boolean(),
        authoritativeStateCertain: z.boolean(),
        evidenceBounded: z.boolean(),
        inputsWithinBounds: z.boolean(),
      })
      .strict(),
    finalState: z
      .object({
        position: GbaMapPositionSchema,
        facing: z.enum(["north", "east", "south", "west"]),
        frame: z.number().int().nonnegative().max(100_000_000),
        inputCount: z.number().int().nonnegative().max(16_384),
      })
      .strict(),
    evidence: z
      .object({
        eventCount: z.number().int().nonnegative().max(256),
        decisionCount: z.number().int().nonnegative().max(256),
        eventChainHeadSha256: Sha256Schema,
        decisionTraceSha256: Sha256Schema,
        finalRamStateSha256: Sha256Schema,
        finalFramebufferSha256: Sha256Schema,
      })
      .strict(),
    artifacts: z.array(RealArtifactReferenceSchema).max(6),
  })
  .strict()
  .superRefine((report, context) => {
    const allChecksPass = Object.values(report.checks).every(Boolean);
    if ((report.result === "passed") !== allChecksPass) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "result disagrees with emulator-authoritative checks",
      });
    }
    if (report.result === "passed" && report.halt !== "target_reached") {
      context.addIssue({ code: "custom", path: ["halt"], message: "a passing run must halt at the target" });
    }
  });
export type RealGbaScenarioReport = z.infer<typeof RealGbaScenarioReportSchema>;

const ALL_EMULATOR_CAPABILITIES = [
  "emulator.gba.observe",
  "emulator.gba.input",
  "emulator.gba.frame_advance",
  "emulator.gba.wait",
] as const;
const ACTION_LIMITS = { maxInputs: 8, maxFrames: 600, timeoutMs: 5_000 } as const;
const RUN_CLOCK = "2026-07-19T00:00:00.000Z";

type Direction = "up" | "down" | "left" | "right";

/**
 * One BFS step over the verified tile map from the observed position.
 * `blockedEdges` carries directed transitions the emulator itself refused
 * ("x,y>x,y"); routing excludes them so the driver adapts to observed
 * collision reality instead of replaying a doomed input.
 */
export function nextRealRouteStep(
  scenario: RealGbaRouteScenario,
  position: { mapId: string; x: number; y: number },
  blockedEdges: ReadonlySet<string> = new Set(),
): Direction | null {
  if (position.mapId !== scenario.map.mapId) throw new Error("Observed position left the scenario map");
  const { bounds } = scenario.map;
  const target = scenario.target;
  const blocked = new Set(scenario.map.blocked.map((tile) => `${String(tile.x)},${String(tile.y)}`));
  const directions: { button: Direction; dx: number; dy: number }[] = [
    { button: "right", dx: 1, dy: 0 },
    { button: "down", dx: 0, dy: 1 },
    { button: "left", dx: -1, dy: 0 },
    { button: "up", dx: 0, dy: -1 },
  ];
  const queue: { x: number; y: number; first: Direction | null }[] = [
    { x: position.x, y: position.y, first: null },
  ];
  const seen = new Set([`${String(position.x)},${String(position.y)}`]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.x === target.x && current.y === target.y && current.first) return current.first;
    for (const direction of directions) {
      const next = { x: current.x + direction.dx, y: current.y + direction.dy };
      const key = `${String(next.x)},${String(next.y)}`;
      const edge = `${String(current.x)},${String(current.y)}>${key}`;
      if (
        next.x < bounds.minX ||
        next.x > bounds.maxX ||
        next.y < bounds.minY ||
        next.y > bounds.maxY ||
        blocked.has(key) ||
        blockedEdges.has(edge) ||
        seen.has(key)
      ) {
        continue;
      }
      seen.add(key);
      queue.push({ ...next, first: current.first ?? direction.button });
    }
  }
  return null;
}

export interface RunRealGbaScenarioInput {
  rootDir: string;
  scenario: unknown;
  fixtureSha256: string;
  /** Pre-initialized core behind the adapter seam (real mGBA, or a CI stub). */
  core: GbaCoreSeam;
  /** Digests the core actually verified at creation; checked against pins. */
  coreIdentity?: { romSha256: string; savestateSha256: string; coreWasmSha256: string };
}

export interface RunRealGbaScenarioResult {
  report: RealGbaScenarioReport;
  trace: GbaEmulatorTrace;
  decisionTrace: RealGbaDecisionTrace;
  semanticEvents: EnvironmentEvent[];
  goalEvent: EnvironmentSemanticEvent;
}

export async function runRealGbaScenario(input: RunRealGbaScenarioInput): Promise<RunRealGbaScenarioResult> {
  const scenario = RealGbaRouteScenarioSchema.parse(input.scenario);
  if (scenario.coreId !== input.core.coreId) {
    throw new Error("Provided core does not match the scenario's pinned core identifier");
  }
  const sessionId = `gba-real:${scenario.scenarioId}:v${String(scenario.scenarioVersion)}`;
  const spec = GbaEmulatorSessionSpecSchema.parse({
    schemaVersion: 2,
    sessionId,
    environmentKind: "gba_emulator",
    characterId: scenario.player.characterId,
    worldId: scenario.worldId,
    requestedBy: { principal: { kind: "captain", id: scenario.player.characterId }, tier: "autonomous" },
    initialGoalVersion: 1,
    resourceBounds: {
      profile: "gba_emulator",
      coreId: scenario.coreId,
      savestateId: scenario.savestateId,
      savestateSha256: scenario.savestateSha256,
      rngSeed: scenario.rngSeed,
      worldId: scenario.worldId,
      characterId: scenario.player.characterId,
      maxInputsPerAction: ACTION_LIMITS.maxInputs,
      maxFramesPerAction: ACTION_LIMITS.maxFrames,
      maxActionDurationMs: ACTION_LIMITS.timeoutMs,
      capabilities: ALL_EMULATOR_CAPABILITIES,
    },
  });
  const adapter = new GbaEmulatorAdapter(scenario, input.fixtureSha256, () => input.core);
  const semanticEvents: EnvironmentEvent[] = [];
  const runtime = new EnvironmentRuntime({
    rootDir: input.rootDir,
    adapter,
    events: { append: (event) => (semanticEvents.push(event), Promise.resolve()) },
    clock: () => new Date(RUN_CLOCK),
    randomToken: () => "runner-private-real-emulator-grant",
  });
  const grant = await runtime.start({
    spec,
    holderId: "gba-real-scenario-runner",
    correlationId: `scenario:${scenario.scenarioId}`,
    leaseDurationMs: 300_000,
  });
  const session = adapter.session(sessionId);

  let actionSequence = 0;
  const act = async (action: GbaEmulatorAction) => {
    actionSequence += 1;
    const actionId = `real-action-${String(actionSequence)}`;
    const command: GbaEmulatorStartActionCommand = {
      schemaVersion: 1,
      commandId: `real-command-${String(actionSequence)}`,
      type: "start_action",
      requestedAt: RUN_CLOCK,
      context: {
        sourceLane: "gameplay",
        authority: { principal: { kind: "captain", id: scenario.player.characterId }, tier: "autonomous" },
        correlationId: `scenario:${scenario.scenarioId}:${String(actionSequence)}`,
        expectedGoalVersion: spec.initialGoalVersion,
      },
      sessionId,
      actionId,
      action: { kind: "gba_emulator_action", action, limits: ACTION_LIMITS },
    };
    return runtime.startAction(grant.token, command);
  };
  const observeOverworld = () => {
    const observation: GbaEmulatorObservation = session.observe("overworld");
    if (observation.kind !== "overworld") throw new Error("Expected an overworld observation");
    return observation;
  };
  const observeDanger = () => {
    const observation: GbaEmulatorObservation = session.observe("danger");
    if (observation.kind !== "danger") throw new Error("Expected a danger observation");
    return observation;
  };

  // ── State-derived route loop: observe → decide → act once → verify. ────────
  // The driver carries no input transcript. Its only memory is the set of
  // directed transitions the emulator itself refused (position unchanged,
  // facing turned to the pressed direction) — observed collision reality that
  // BFS then routes around. Frame freezes or unexpected positions are desync,
  // not collision, and fail closed.
  const decisions: RealGbaDecision[] = [];
  const observedBlockedEdges = new Set<string>();
  let halt: RealGbaScenarioReport["halt"] = "decision_budget_exhausted";
  const facingOf = { up: "north", down: "south", left: "west", right: "east" } as const;
  for (let sequence = 1; sequence <= scenario.maxDecisions; sequence += 1) {
    const danger = observeDanger();
    const overworld = observeOverworld();
    const observed = {
      schemaVersion: REAL_GBA_SCENARIO_SCHEMA_VERSION,
      sequence,
      observedPosition: overworld.data.position,
      observedFacing: overworld.data.facing,
      observedFrame: overworld.frame,
      observedRamStateSha256: overworld.data.ramStateSha256,
    };
    if (!danger.data.stateCertain) {
      decisions.push({ ...observed, reasonCode: "halt_uncertain_state" });
      await runtime.pause(grant.token, sessionId, "uncertain emulator state: failing closed");
      halt = "uncertain_state";
      break;
    }
    const position = overworld.data.position;
    if (position.x === scenario.target.x && position.y === scenario.target.y) {
      decisions.push({ ...observed, reasonCode: "halt_target_reached" });
      halt = "target_reached";
      break;
    }
    const button = nextRealRouteStep(scenario, position, observedBlockedEdges);
    if (button === null) {
      decisions.push({ ...observed, reasonCode: "halt_route_unreachable" });
      await runtime.pause(grant.token, sessionId, "no route to the target over observed collisions");
      halt = "route_unreachable";
      break;
    }
    const action = {
      kind: "button_press",
      button,
      holdFrames: scenario.holdFramesPerStep,
    } as const;
    decisions.push({ ...observed, reasonCode: "route_step_toward_target", action });
    const result = await act(action);
    if (result.status !== "completed") {
      await runtime.pause(grant.token, sessionId, `emulator action ended ${result.status}: failing closed`);
      halt = "action_failed";
      break;
    }
    // Verify against the emulator before deciding again.
    const verify = observeOverworld();
    const intended = {
      up: { x: position.x, y: position.y - 1 },
      down: { x: position.x, y: position.y + 1 },
      left: { x: position.x - 1, y: position.y },
      right: { x: position.x + 1, y: position.y },
    }[button];
    const landed = verify.data.position.x === intended.x && verify.data.position.y === intended.y;
    const refused =
      verify.data.position.x === position.x &&
      verify.data.position.y === position.y &&
      verify.data.facing === facingOf[button];
    if (verify.frame <= overworld.frame || (!landed && !refused)) {
      await runtime.pause(grant.token, sessionId, "input did not land on the intended tile: failing closed");
      halt = "uncertain_state";
      break;
    }
    if (refused) {
      observedBlockedEdges.add(
        `${String(position.x)},${String(position.y)}>${String(intended.x)},${String(intended.y)}`,
      );
    }
  }

  const decisionTrace = RealGbaDecisionTraceSchema.parse({
    schemaVersion: REAL_GBA_SCENARIO_SCHEMA_VERSION,
    scenarioId: scenario.scenarioId,
    scenarioVersion: scenario.scenarioVersion,
    fixtureSha256: input.fixtureSha256,
    decisions,
  });
  const trace = session.trace();
  const traceBytes = `${JSON.stringify(trace, null, 2)}\n`;
  const decisionBytes = `${JSON.stringify(decisionTrace, null, 2)}\n`;
  const runId = `gba-real-${input.fixtureSha256.slice(0, 16)}`;
  const final = session.snapshot();
  const finalOverworld = observeOverworld();
  const finalFrameReference = session.observe("frame_reference");
  if (finalFrameReference.kind !== "frame_reference") throw new Error("Expected a frame reference");
  const framesStrictlyIncrease = decisions.every(
    (decision, index) => index === 0 || decision.observedFrame > (decisions[index - 1]?.observedFrame ?? 0),
  );
  const ramStateChanges = decisions.every(
    (decision, index) =>
      index === 0 || decision.observedRamStateSha256 !== decisions[index - 1]?.observedRamStateSha256,
  );
  const distinctButtons = new Set(
    decisions.map((decision) => decision.action?.button).filter((button) => button !== undefined),
  );
  const checks = {
    identityVerified:
      input.coreIdentity !== undefined &&
      input.coreIdentity.romSha256 === scenario.romSha256 &&
      input.coreIdentity.savestateSha256 === scenario.savestateSha256 &&
      input.coreIdentity.coreWasmSha256 === scenario.coreWasmSha256,
    targetLocationReached:
      halt === "target_reached" &&
      final.position.mapId === scenario.target.mapId &&
      final.position.x === scenario.target.x &&
      final.position.y === scenario.target.y,
    decisionsStateDerived:
      decisions.length >= scenario.expected.minimumDecisions &&
      framesStrictlyIncrease &&
      ramStateChanges &&
      distinctButtons.size >= 2,
    authoritativeStateCertain: final.stateCertain,
    evidenceBounded:
      trace.events.length <= scenario.maxEvidenceEvents && decisions.length <= scenario.maxDecisions,
    inputsWithinBounds:
      final.inputCount === trace.events.filter((event) => event.actionKind === "button_press").length &&
      final.inputCount <= scenario.maxDecisions,
  };
  const report = RealGbaScenarioReportSchema.parse({
    schemaVersion: REAL_GBA_SCENARIO_SCHEMA_VERSION,
    scenarioId: scenario.scenarioId,
    scenarioVersion: scenario.scenarioVersion,
    fixtureSha256: input.fixtureSha256,
    runId,
    result: Object.values(checks).every(Boolean) ? "passed" : "failed",
    halt,
    checks,
    finalState: {
      position: final.position,
      facing: finalOverworld.data.facing,
      frame: final.frame,
      inputCount: final.inputCount,
    },
    evidence: {
      eventCount: trace.events.length,
      decisionCount: decisions.length,
      eventChainHeadSha256: trace.eventChainHeadSha256,
      decisionTraceSha256: sha256(decisionBytes),
      finalRamStateSha256: final.ramStateSha256,
      finalFramebufferSha256: finalFrameReference.data.framebufferSha256,
    },
    artifacts: [
      {
        kind: "event_trace",
        artifactId: `${runId}:event-trace`,
        uri: `artifact://gba-emulator/${runId}/events.json`,
        sha256: sha256(traceBytes),
        summary: "Bounded emulator-authoritative action trace",
      },
      {
        kind: "decision_trace",
        artifactId: `${runId}:decision-trace`,
        uri: `artifact://gba-emulator/${runId}/decisions.json`,
        sha256: sha256(decisionBytes),
        summary: "State-derived route decision trace",
      },
      {
        kind: "frame",
        artifactId: finalFrameReference.data.artifactId,
        uri: finalFrameReference.data.uri,
        sha256: finalFrameReference.data.framebufferSha256,
        summary: "Bounded final framebuffer reference",
      },
    ],
  });
  const goalEvent = EnvironmentSemanticEventSchema.parse({
    schemaVersion: 1,
    plane: "semantic",
    id: `gba-emulator-real:${runId}`,
    type: report.result === "passed" ? "environment.goal.verified" : "environment.goal.failed",
    occurredAt: "2026-07-19T00:01:00.000Z",
    correlationId: runId,
    sessionId,
    data: {
      scenarioId: report.scenarioId,
      scenarioVersion: report.scenarioVersion,
      fixtureSha256: report.fixtureSha256,
    },
  });
  semanticEvents.push(goalEvent);
  if (
    JSON.stringify({ report, trace, decisionTrace, semanticEvents }).includes(
      "runner-private-real-emulator-grant",
    )
  ) {
    throw new Error("Runner-private grant escaped into scenario evidence");
  }
  if (sha256(canonicalJson(scenario)).length !== 64) throw new Error("Scenario canonical hash failed");
  return { report, trace, decisionTrace, semanticEvents, goalEvent };
}
