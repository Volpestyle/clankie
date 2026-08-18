import type { EnvironmentActionResult, GbaEmulatorObservation } from "@clankie/interactive-environment";
import { describe, expect, it, vi } from "vitest";
import type { GbaDriverIo } from "../src/driver.ts";
import type { VoiceView } from "../src/free-play-voice.ts";
import {
  FREE_PLAY_INTERJECTION_MAX,
  FREE_PLAY_MONOLOGUE_MAX,
  FREE_PLAY_NOTES_MAX,
  FREE_PLAY_REPEAT_TURNS,
  FREE_PLAY_REPLY_MAX,
  FREE_PLAY_STALL_TURNS,
  InterjectionQueue,
  intentMatchesAction,
  runFreePlay,
  type FreePlayMind,
  type FreePlayTurnEvidence,
  type FreePlayView,
} from "../src/free-play.ts";

function overworld(frame: number, x = 5, mapId = "PALLET_TOWN"): GbaEmulatorObservation {
  return {
    schemaVersion: 1,
    kind: "overworld",
    observationId: `obs-${String(frame)}`,
    sessionId: "gba-emulator:test",
    characterId: "clankie",
    worldId: "gba-emulator-lab-v1",
    goalVersion: 0,
    capturedAt: "2026-07-25T18:00:00.000Z",
    frame,
    data: {
      position: { mapId, x, y: 6 },
      facing: "south",
      ramStateSha256: "b".repeat(64),
    },
  } as unknown as GbaEmulatorObservation;
}

/** A battle view, where there is no position to be stalled at. */
function battle(): GbaEmulatorObservation {
  return {
    schemaVersion: 1,
    kind: "battle",
    observationId: "obs-battle",
    sessionId: "gba-emulator:test",
    characterId: "clankie",
    worldId: "gba-emulator-lab-v1",
    goalVersion: 0,
    capturedAt: "2026-07-25T18:00:00.000Z",
    frame: 100,
    data: {
      battleId: "battle-1",
      turn: 1,
      phase: "awaiting_input",
      opponent: { speciesId: "rattata", level: 3, currentHp: 10, maxHp: 10 },
      activePartySlot: 0,
      moveCursor: 0,
      legalMoves: [{ moveId: "tackle", power: 40 }],
      untrusted: true,
    },
  } as unknown as GbaEmulatorObservation;
}

function unsupportedExit(frame = 100): GbaEmulatorObservation {
  const observation = overworld(frame, 17, "pallet-town/players-house-1f") as unknown as {
    data: Record<string, unknown>;
  };
  observation.data["exits"] = {
    warps: [
      {
        x: 12,
        y: 15,
        destination: "pallet-town",
        walkTo: "unsupported",
      },
    ],
    connections: [],
  };
  return observation as unknown as GbaEmulatorObservation;
}

function completed(): EnvironmentActionResult {
  return {
    schemaVersion: 1,
    status: "completed",
    actionId: "11111111-1111-4111-8111-111111111111",
    sessionId: "gba-emulator:test",
    updatedAt: "2026-07-25T18:00:00.000Z",
    acceptedGoalVersion: 0,
    outcome: { applied: true },
  } as EnvironmentActionResult;
}

function failed(errorCode: string): EnvironmentActionResult {
  return {
    schemaVersion: 1,
    status: "failed",
    actionId: "22222222-2222-4222-8222-222222222222",
    sessionId: "gba-emulator:test",
    updatedAt: "2026-07-25T18:00:00.000Z",
    acceptedGoalVersion: 0,
    errorCode,
    message: "input bound exceeded",
    retryable: false,
  } as EnvironmentActionResult;
}

function io(act: () => Promise<EnvironmentActionResult>): GbaDriverIo {
  let frame = 100;
  let x = 5;
  return {
    observe: (kind) => {
      // Only the overworld view exists here; other kinds throw exactly as the
      // adapter does when a view is meaningless in the current state.
      if (kind !== "overworld") throw new Error(`no ${kind} view`);
      frame += 1;
      // Position advances, so actions read as real moves and plans survive.
      x += 1;
      return overworld(frame, x);
    },
    act,
    pause: () => Promise.resolve(),
    resume: () => Promise.resolve(),
  };
}

function cyclingIo(): GbaDriverIo {
  let frame = 100;
  let x = 5;
  return {
    observe: (kind) => {
      if (kind !== "overworld") throw new Error(`no ${kind} view`);
      return overworld(frame++, x);
    },
    act: () => {
      x = x === 5 ? 6 : 5;
      return Promise.resolve(completed());
    },
    pause: () => Promise.resolve(),
    resume: () => Promise.resolve(),
  };
}

function mind(decisions: unknown[]): FreePlayMind {
  let index = 0;
  return {
    decide: () => {
      const next = decisions[Math.min(index, decisions.length - 1)];
      index += 1;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

function position(observations: readonly GbaEmulatorObservation[] | undefined) {
  const overworld = observations?.find((observation) => observation.kind === "overworld") as
    | { data?: { position?: { mapId: string; x: number; y: number } } }
    | undefined;
  return overworld?.data?.position ?? null;
}

const press = (button: string, intent: string, notes: string | null = null) => ({
  monologue: `I want to head ${intent}.`,
  intent: `move ${intent}`,
  notes,
  action: { kind: "button_press", button, holdFrames: 4 },
});

describe("free play", () => {
  it("reports thinking and acting at their real boundaries", async () => {
    const phases: string[] = [];
    await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up")]),
      turns: 1,
      onPhase: (phase) => phases.push(phase),
    });

    expect(phases).toEqual(["thinking", "acting"]);
  });

  it("lets the model choose and records a causally linked trace", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up"), press("left", "left")]),
      turns: 2,
      framebufferSha256: () => "a".repeat(64),
    });

    expect(result.accepted).toBe(2);
    expect(result.turns).toHaveLength(2);
    const [first] = result.turns;
    expect(first?.outcome).toBe("accepted");
    expect(first?.action).toMatchObject({ kind: "button_press", button: "up" });
    expect(first?.monologue).toContain("head up");
    // Digests link the decision to the state it was made from.
    expect(first?.observationSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first?.framebufferSha256).toBe("a".repeat(64));
    // The trace carries digests, never frame bytes.
    expect(JSON.stringify(result.turns)).not.toContain("data:image");
  });

  it("blames the action for what the action changed, not for idling while he thought", async () => {
    // The console keeps running between the screen he decided on and the moment
    // the action dispatches (ADR 0047), so a digest sampled at observation
    // drifts with ambient animation across the whole decision. Diffing from it
    // told him a fruitless A press had changed the screen, and cost him the
    // next turn to work out that it had not.
    //
    // The three samples are: what he was shown, what stood there when the
    // action went in, and what stood there after. The last two match, because
    // the press did nothing — so the honest answer is "nothing happened".
    const digests = ["a".repeat(64), "b".repeat(64), "b".repeat(64)];
    let sample = 0;
    const still = overworld(100);
    const result = await runFreePlay({
      io: {
        observe: (kind) => {
          if (kind !== "overworld") throw new Error(`no ${kind} view`);
          return still;
        },
        act: () => Promise.resolve(completed()),
        pause: () => Promise.resolve(),
        resume: () => Promise.resolve(),
      },
      mind: mind([press("a", "talk to the kid")]),
      turns: 1,
      framebufferSha256: () => digests[Math.min(sample++, digests.length - 1)] ?? null,
    });

    expect(result.turns[0]?.effect).toContain("no visible change");
    expect(result.turns[0]?.effect).not.toContain("ambient animation");
  });

  it("separates decision, immediate pre-action, and post-action semantic state", async () => {
    let x = 5;
    let captured: FreePlayTurnEvidence | undefined;
    const result = await runFreePlay({
      io: {
        observe: (kind) => {
          if (kind !== "overworld") throw new Error(`no ${kind} view`);
          return overworld(100, x);
        },
        act: () => Promise.resolve(completed()),
        pause: () => Promise.resolve(),
        resume: () => Promise.resolve(),
      },
      mind: {
        decide: () => {
          // The hosted world moved while the model was thinking. The action
          // itself then changed nothing.
          x = 6;
          return Promise.resolve(press("a", "talk to the kid"));
        },
      },
      turns: 1,
      onTurn: (_turn, evidence) => {
        captured = evidence;
      },
    });

    expect(position(captured?.decision.observations)).toEqual({ mapId: "PALLET_TOWN", x: 5, y: 6 });
    expect(position(captured?.immediatePreAction?.observations)).toEqual({
      mapId: "PALLET_TOWN",
      x: 6,
      y: 6,
    });
    expect(position(captured?.postAction?.observations)).toEqual({ mapId: "PALLET_TOWN", x: 6, y: 6 });
    expect(result.turns[0]?.effect).toContain("no visible change");
  });

  it("keeps the structured action result whole when the legacy detail is bounded", async () => {
    const transcript = "x".repeat(1_000);
    let captured: FreePlayTurnEvidence | undefined;
    const result = await runFreePlay({
      io: io(() => Promise.resolve({ ...completed(), outcome: { transcript: [transcript] } })),
      mind: mind([press("a", "a")]),
      turns: 1,
      onTurn: (_turn, evidence) => {
        captured = evidence;
      },
    });

    expect(result.turns[0]?.detail).toHaveLength(400);
    expect(captured?.actionResult).toMatchObject({
      source: "environment",
      result: { outcome: { transcript: [transcript] } },
    });
  });

  it("survives an adapter rejection and keeps playing", async () => {
    const act = vi
      .fn<() => Promise<EnvironmentActionResult>>()
      .mockResolvedValueOnce(failed("frame_bound_exceeded"))
      .mockResolvedValue(completed());

    const result = await runFreePlay({
      io: io(act),
      mind: mind([press("up", "up"), press("down", "down")]),
      turns: 2,
    });

    // A rejection is a legitimate answer, not a crash: the loop continues.
    expect(result.turns[0]?.outcome).toBe("rejected_by_adapter");
    expect(result.turns[0]?.detail).toContain("frame_bound_exceeded");
    expect(result.turns[1]?.outcome).toBe("accepted");
    expect(result.accepted).toBe(1);
  });

  it("survives an unparseable decision and a model that throws", async () => {
    const evidence: FreePlayTurnEvidence[] = [];
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([{ monologue: "no action field" }, new Error("model unavailable"), press("a", "a")]),
      turns: 3,
      onTurn: (_turn, packet) => evidence.push(packet),
    });

    expect(result.turns[0]?.outcome).toBe("invalid_decision");
    expect(result.turns[1]?.outcome).toBe("mind_failed");
    expect(result.turns[1]?.detail).toContain("model unavailable");
    // Neither failure ends the playthrough.
    expect(result.turns[2]?.outcome).toBe("accepted");
    expect(evidence[0]).toMatchObject({ immediatePreAction: null, postAction: null, actionResult: null });
    expect(evidence[1]).toMatchObject({ immediatePreAction: null, postAction: null, actionResult: null });
  });

  it("rejects an out-of-bounds action and unbounded model text", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([
        // Not a catalogued button.
        {
          monologue: "mash it",
          intent: "mash",
          action: { kind: "button_press", button: "turbo", holdFrames: 4 },
        },
        {
          monologue: "x".repeat(FREE_PLAY_MONOLOGUE_MAX + 1),
          intent: "ramble",
          action: { kind: "frame_advance", frames: 4 },
        },
      ]),
      turns: 2,
    });

    expect(result.turns[0]?.outcome).toBe("invalid_decision");
    // Untrusted model text is bounded before it can reach an operator surface.
    expect(result.turns[1]?.outcome).toBe("invalid_decision");
    expect(result.accepted).toBe(0);
  });

  it("does not count a revised plan as incoherence when the world refused him", async () => {
    // Blocked, then he changes direction. Revising is the correct response, so
    // the transition is excluded rather than scored as a broken promise.
    const blockingIo: GbaDriverIo = {
      observe: (kind) => {
        if (kind !== "overworld") throw new Error(`no ${kind} view`);
        return overworld(100);
      },
      act: () => Promise.resolve(completed()),
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
    };
    const result = await runFreePlay({
      io: blockingIo,
      mind: mind([
        {
          monologue: "west",
          intent: "go left",
          action: { kind: "button_press", button: "left", holdFrames: 4 },
        },
        {
          monologue: "that wall again",
          intent: "try up instead",
          action: { kind: "button_press", button: "up", holdFrames: 4 },
        },
      ]),
      turns: 2,
    });
    // The position never changes, so every turn is a refusal: nothing scoreable.
    expect(result.turns[0]?.effect).toContain("position unchanged");
    expect(result.coherence).toBeNull();
  });

  it("scores coherence as a reported lower bound, never a gate", async () => {
    const result = await runFreePlay({
      // This io advances position every observation, so plans survive and the
      // transitions are scoreable.
      io: io(() => Promise.resolve(completed())),
      mind: mind([
        {
          monologue: "north first",
          intent: "go up the path",
          action: { kind: "button_press", button: "up", holdFrames: 4 },
        },
        // Follows through on "up".
        {
          monologue: "still north",
          intent: "keep going up",
          action: { kind: "button_press", button: "up", holdFrames: 4 },
        },
        // Contradicts the stated intent.
        {
          monologue: "changed my mind",
          intent: "keep going up",
          action: { kind: "button_press", button: "left", holdFrames: 4 },
        },
      ]),
      turns: 3,
    });

    // Two scoreable transitions, one of which followed through.
    expect(result.coherence).toBeCloseTo(0.5, 5);
    // Nothing about a low score fails the run.
    expect(result.accepted).toBe(3);
  });

  it("matches intent to action by keyword, tolerating natural phrasing", () => {
    const up = { kind: "button_press", button: "up", holdFrames: 4 } as const;
    expect(intentMatchesAction("head north toward the lab", up)).toBe(true);
    expect(intentMatchesAction("walk up a bit", up)).toBe(true);
    expect(intentMatchesAction("open the bag", up)).toBe(false);
    expect(intentMatchesAction("let the dialog play out", { kind: "frame_advance", frames: 8 })).toBe(true);
  });

  it("reports no coherence when there is nothing to score", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up")]),
      turns: 1,
    });
    expect(result.coherence).toBeNull();
  });
});

describe("rewind is his to choose", () => {
  // ADR 0075: restart and checkpoint loads are play choices, dispatched to an
  // injected port rather than the frozen emulator catalog.
  const summary = (checkpointId: string) => ({
    checkpointId,
    label: "autosave" as string | null,
    capturedAt: "2026-08-01T00:00:00.000Z",
    position: { mapId: "PALLET_TOWN", x: 5, y: 6 } as { mapId: string; x: number; y: number } | null,
  });

  it("lists his checkpoints when he asks with no id", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([
        {
          monologue: "what saves do I have?",
          intent: "list my checkpoints",
          action: { kind: "load_checkpoint" },
        },
      ]),
      checkpoints: {
        list: () => [summary("cp-newest"), summary("cp-older")],
        load: () => summary("unused"),
        restart: () => undefined,
      },
      turns: 1,
    });
    expect(result.turns[0]?.outcome).toBe("accepted");
    expect(result.turns[0]?.effect).toContain("cp-newest");
    expect(result.turns[0]?.effect).toContain("newest first");
  });

  it("restores the checkpoint he names and keeps his notes", async () => {
    const load = vi.fn((checkpointId: string) => summary(checkpointId));
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([
        {
          monologue: "back to before the gym",
          intent: "load my checkpoint",
          notes: "Brock uses rock types",
          action: { kind: "load_checkpoint", checkpointId: "cp-before-gym" },
        },
      ]),
      checkpoints: { list: () => [], load, restart: () => undefined },
      turns: 1,
    });
    expect(load).toHaveBeenCalledWith("cp-before-gym");
    expect(result.turns[0]?.outcome).toBe("accepted");
    expect(result.turns[0]?.effect).toContain("restored checkpoint cp-before-gym");
    // The world rewound; his memory did not.
    expect(result.turns[0]?.notes).toBe("Brock uses rock types");
  });

  it("restarts the game from its beginning when he chooses to", async () => {
    const restart = vi.fn();
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([
        {
          monologue: "I want a clean run",
          intent: "restart the game",
          action: { kind: "restart_game" },
        },
      ]),
      checkpoints: { list: () => [], load: () => summary("unused"), restart },
      turns: 1,
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(result.turns[0]?.outcome).toBe("accepted");
    expect(result.turns[0]?.effect).toContain("restarted from its configured beginning");
  });

  it("refuses truthfully when the body has no saved time", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([{ monologue: "start over", intent: "restart the game", action: { kind: "restart_game" } }]),
      turns: 1,
    });
    expect(result.turns[0]?.outcome).toBe("rejected_by_adapter");
    expect(result.turns[0]?.effectAdvice).toContain("no saved time");
  });

  it("reports a refused load as the refusal, and the game does not move", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([
        {
          monologue: "load something",
          intent: "load a checkpoint",
          action: { kind: "load_checkpoint", checkpointId: "not-a-checkpoint" },
        },
      ]),
      checkpoints: {
        list: () => [],
        load: () => {
          throw new Error("checkpoint_not_found: not-a-checkpoint");
        },
        restart: () => undefined,
      },
      turns: 1,
    });
    expect(result.turns[0]?.outcome).toBe("rejected_by_adapter");
    expect(result.turns[0]?.effectAdvice).toContain("checkpoint_not_found");
  });
});

describe("stall visibility", () => {
  it("tells him when he has stopped reaching new tiles, once it means something", async () => {
    // The measured failure: 85 turns without a new tile while the counter sat
    // in a summary nobody reads mid-game. The view now carries it — as a fact,
    // past the noise threshold, never as advice.
    const stalls: (number | null)[] = [];
    const stuckIo: GbaDriverIo = {
      observe: (kind) => {
        if (kind !== "overworld") throw new Error(`no ${kind} view`);
        return overworld(100);
      },
      act: () => Promise.resolve(completed()),
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
    };
    await runFreePlay({
      io: stuckIo,
      mind: {
        decide: (view) => {
          stalls.push(view.stalledForTurns);
          return Promise.resolve(press("up", "up"));
        },
      },
      turns: FREE_PLAY_STALL_TURNS + 3,
    });

    // Quiet below the threshold, then the count itself.
    expect(stalls[0]).toBeNull();
    expect(stalls[FREE_PLAY_STALL_TURNS - 1]).toBeNull();
    expect(stalls[FREE_PLAY_STALL_TURNS]).toBe(FREE_PLAY_STALL_TURNS);
    expect(stalls[FREE_PLAY_STALL_TURNS + 2]).toBe(FREE_PLAY_STALL_TURNS + 2);
  });

  it("tells him when the same action keeps producing the same result, wherever he is", async () => {
    // The wedge the tile counter cannot see: a refusal repeating forever with
    // no position to be stuck at (a battle, a menu, a script). Run-from-battle
    // froze a whole session this way while every progress counter stayed calm.
    const repeats: (number | null)[] = [];
    const battleIo: GbaDriverIo = {
      // No overworld view at all, so `stalledForTurns` is structurally null.
      observe: (kind) => {
        if (kind !== "battle") throw new Error(`no ${kind} view`);
        return battle();
      },
      act: () => Promise.resolve(failed("action_unavailable")),
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
    };
    const result = await runFreePlay({
      io: battleIo,
      mind: {
        decide: (view) => {
          repeats.push(view.repeatingForTurns);
          expect(view.stalledForTurns).toBeNull();
          return Promise.resolve(press("b", "run"));
        },
      },
      turns: FREE_PLAY_REPEAT_TURNS + 2,
    });

    // Quiet below the threshold — the first two identical turns are just play.
    expect(repeats[0]).toBeNull();
    expect(repeats[FREE_PLAY_REPEAT_TURNS - 1]).toBeNull();
    expect(repeats[FREE_PLAY_REPEAT_TURNS]).toBe(FREE_PLAY_REPEAT_TURNS);
    expect(result.longestUnchangedRun).toBe(FREE_PLAY_REPEAT_TURNS + 2);
  });

  it("retains a stable capability failure after recent history rolls off", async () => {
    const seen: FreePlayView["knownHardFailures"][] = [];
    const evidence: FreePlayTurnEvidence[] = [];
    let frame = 100;
    const worldIo: GbaDriverIo = {
      observe: (kind) => {
        if (kind !== "overworld") throw new Error(`no ${kind} view`);
        return unsupportedExit(frame++);
      },
      act: () => Promise.resolve(failed("walk_exit_unsupported")),
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
    };
    await runFreePlay({
      io: worldIo,
      mind: {
        decide: (view) => {
          seen.push(view.knownHardFailures);
          return Promise.resolve({
            monologue: "I still want to try that visible exit.",
            intent: "walk to the exit",
            action: { kind: "walk_to", x: 12, y: 15 },
          });
        },
      },
      turns: 4,
      historyLimit: 1,
      provenance: () => ({
        body: "world",
        sessionId: "session-1",
        worldId: "kanto",
        bodyGeneration: 1,
        adapterVersion: 3,
      }),
      onTurn: (_turn, turnEvidence) => evidence.push(turnEvidence),
    });

    expect(seen[0]).toEqual([]);
    expect(seen.slice(1).every((failures) => failures.length === 1)).toBe(true);
    expect(seen.at(-1)?.[0]).toMatchObject({
      action: { kind: "walk_to", x: 12, y: 15 },
      errorCode: "walk_exit_unsupported",
    });
    expect(evidence[1]?.signals.knownHardFailures).toHaveLength(1);
  });

  it("stays quiet while the same action keeps changing something", async () => {
    // Walking a corridor repeats the action every turn and is not a wedge:
    // the effect names a new tile each time, so nothing is reported.
    const repeats: (number | null)[] = [];
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: {
        decide: (view) => {
          repeats.push(view.repeatingForTurns);
          return Promise.resolve(press("up", "up"));
        },
      },
      turns: FREE_PLAY_REPEAT_TURNS + 3,
    });

    expect(repeats.every((value) => value === null)).toBe(true);
    expect(result.longestUnchangedRun).toBe(1);
  });

  it("detects an alternating semantic-state loop even when actions differ", async () => {
    const recurring: (number | null)[] = [];
    const result = await runFreePlay({
      io: cyclingIo(),
      mind: {
        decide: (view) => {
          recurring.push(view.recurringForTurns);
          return Promise.resolve(press(view.turn % 2 === 0 ? "left" : "right", "around the table"));
        },
      },
      turns: 8,
    });

    expect(recurring.some((turns) => (turns ?? 0) >= FREE_PLAY_REPEAT_TURNS * 2)).toBe(true);
    expect(result.longestRecurringRun).toBeGreaterThanOrEqual(FREE_PLAY_REPEAT_TURNS * 2);
    expect(result.longestUnchangedRun).toBe(1);
  });

  it("counts recurrence that first reaches the boundary on the final settled turn", async () => {
    const recurring: (number | null)[] = [];
    const result = await runFreePlay({
      io: cyclingIo(),
      mind: {
        decide: (view) => {
          recurring.push(view.recurringForTurns);
          return Promise.resolve(press(view.turn % 2 === 0 ? "left" : "right", "around the table"));
        },
      },
      turns: FREE_PLAY_REPEAT_TURNS * 2 - 1,
    });

    expect(recurring).not.toContain(FREE_PLAY_REPEAT_TURNS * 2);
    expect(result.longestRecurringRun).toBe(FREE_PLAY_REPEAT_TURNS * 2);
  });

  it("retires a stale objective after one warned loop turn without choosing a replacement", async () => {
    const retired: (string | null)[] = [];
    const result = await runFreePlay({
      io: cyclingIo(),
      mind: {
        decide: (view) => {
          retired.push(view.retiredObjective);
          return Promise.resolve(press(view.turn % 2 === 0 ? "left" : "right", "try the other side"));
        },
      },
      turns: FREE_PLAY_STALL_TURNS + 4,
      initialObjective: "leave through the front door",
    });

    expect(result.objectivesRetired).toBe(1);
    expect(result.turns.some((turn) => turn.objectiveRetired === "leave through the front door")).toBe(true);
    expect(retired).toContain("leave through the front door");
    expect(result.turns.at(-1)?.objective).toBeNull();
  });
});

describe("burst actions", () => {
  it("accepts a bounded repeat and reports it in the trace", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([
        {
          monologue: "long corridor",
          intent: "cross the corridor",
          action: { kind: "button_press", button: "left", holdFrames: 16, repeat: 5 },
        },
      ]),
      turns: 1,
    });
    expect(result.turns[0]?.outcome).toBe("accepted");
    expect(result.turns[0]?.action).toMatchObject({ button: "left", repeat: 5 });
  });

  it("rejects a repeat beyond the catalogued bound", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([
        {
          monologue: "mash",
          intent: "mash",
          // A burst is coarser granularity, not an unbounded budget.
          action: { kind: "button_press", button: "left", holdFrames: 4, repeat: 99 },
        },
      ]),
      turns: 1,
    });
    expect(result.turns[0]?.outcome).toBe("invalid_decision");
  });

  it("treats an omitted repeat as a single press, so frozen actions are unchanged", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up")]),
      turns: 1,
    });
    expect(result.turns[0]?.action).toMatchObject({ kind: "button_press", button: "up" });
    const first = result.turns[0]?.action as { repeat?: number } | null | undefined;
    expect(first?.repeat).toBeUndefined();
  });
});

describe("persistent notes", () => {
  it("carries his notes forward and lets him rewrite them", async () => {
    const seen: (string | null)[] = [];
    const recordingMind: FreePlayMind = {
      decide: (view) => {
        seen.push(view.notes);
        const step = seen.length;
        return Promise.resolve(press("up", "up", step === 1 ? "stairs are upper-right" : null));
      },
    };
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: recordingMind,
      turns: 3,
    });

    // Nothing on the first turn, then his own note handed back verbatim.
    expect(seen[0]).toBeNull();
    expect(seen[1]).toBe("stairs are upper-right");
    // Returning null leaves them standing rather than erasing them.
    expect(seen[2]).toBe("stairs are upper-right");
    expect(result.turns.at(-1)?.notes).toBe("stairs are upper-right");
  });

  it("seeds notes and objective from a previous run, then they are his to rewrite", async () => {
    const seenNotes: (string | null)[] = [];
    const seenObjectives: (string | null)[] = [];
    const recordingMind: FreePlayMind = {
      decide: (view) => {
        seenNotes.push(view.notes);
        seenObjectives.push(view.objective);
        return Promise.resolve(
          seenNotes.length === 1 ? press("up", "up") : press("up", "up", "new plan entirely"),
        );
      },
    };
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: recordingMind,
      turns: 3,
      initialNotes: "stairs upper-right",
      initialObjective: "get outside",
    });

    // The resumed mind arrives on turn one, not after his first rewrite.
    expect(seenNotes[0]).toBe("stairs upper-right");
    expect(seenObjectives[0]).toBe("get outside");
    // And it is memory, not a script: his rewrite wins immediately.
    expect(seenNotes[2]).toBe("new plan entirely");
    expect(result.turns.at(-1)?.objective).toBe("get outside");
  });

  it("lets null explicitly clear a standing objective while omission keeps it", async () => {
    const kept = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up")]),
      turns: 1,
      initialObjective: "get outside",
    });
    const cleared = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([{ ...press("up", "up"), objective: null }]),
      turns: 1,
      initialObjective: "get outside",
    });

    expect(kept.turns[0]?.objective).toBe("get outside");
    expect(cleared.turns[0]?.objective).toBeNull();
  });

  it("keeps learned transition facts after recent history eviction and a return to the map", async () => {
    let mapId = "house";
    let x = 11;
    let actionCount = 0;
    const learned: FreePlayView["learnedTransitions"][] = [];
    const transitionIo: GbaDriverIo = {
      observe: (kind) => {
        if (kind !== "overworld") throw new Error(`no ${kind} view`);
        return overworld(100 + actionCount, x, mapId);
      },
      act: () => {
        if (actionCount === 0) {
          mapId = "town";
          x = 13;
        } else if (actionCount === 8) {
          mapId = "house";
          x = 11;
        }
        actionCount += 1;
        return Promise.resolve(completed());
      },
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
    };

    await runFreePlay({
      io: transitionIo,
      mind: {
        decide: (view) => {
          learned.push(view.learnedTransitions);
          return Promise.resolve(press(view.turn === 0 ? "down" : "a", "continue"));
        },
      },
      turns: 10,
      historyLimit: 2,
    });

    expect(learned[9]).toContainEqual(
      expect.objectContaining({
        from: { mapId: "house", x: 11, y: 6 },
        action: expect.objectContaining({ kind: "button_press", button: "down" }),
        to: { mapId: "town", x: 13, y: 6 },
      }),
    );
  });

  it("rejects notes beyond the bound instead of growing the prompt forever", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up", "x".repeat(FREE_PLAY_NOTES_MAX + 1))]),
      turns: 1,
    });
    expect(result.turns[0]?.outcome).toBe("invalid_decision");
  });
});

describe("interjection", () => {
  it("reaches the next turn and is answered without losing turn state", async () => {
    const seen: (string | null)[] = [];
    const queue = new InterjectionQueue();
    queue.offer("how's it going?");
    const listening: FreePlayMind = {
      decide: (view) => {
        seen.push(view.interjection);
        return Promise.resolve({
          ...press("up", "up"),
          reply: view.interjection === null ? null : "slow, this desk keeps blocking me",
        });
      },
    };
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: listening,
      turns: 2,
      interjections: queue,
    });

    expect(seen[0]).toBe("how's it going?");
    // Consumed once: a question is not re-asked every turn afterwards.
    expect(seen[1]).toBeNull();
    expect(result.turns[0]?.reply).toContain("desk");
    expect(result.turns[1]?.reply).toBeNull();
    // Play continued either way.
    expect(result.accepted).toBe(2);
    // Recorded, so an interjection's influence stays auditable.
    expect(result.turns[0]?.interjection).toBe("how's it going?");
  });

  it("keeps only the newest message rather than a stale backlog", () => {
    const queue = new InterjectionQueue();
    queue.offer("first");
    queue.offer("second");
    // Answering an old question several turns late reads worse than the newest.
    expect(queue.take()).toBe("second");
    expect(queue.take()).toBeNull();
  });

  it("ignores empty chatter and bounds what one person can say", () => {
    const queue = new InterjectionQueue();
    queue.offer("   ");
    expect(queue.take()).toBeNull();
    queue.offer("x".repeat(FREE_PLAY_INTERJECTION_MAX + 100));
    expect(queue.take()?.length).toBe(FREE_PLAY_INTERJECTION_MAX);
  });

  it("rejects a reply longer than a person could be sent", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([{ ...press("up", "up"), reply: "x".repeat(FREE_PLAY_REPLY_MAX + 1) }]),
      turns: 1,
    });
    expect(result.turns[0]?.outcome).toBe("invalid_decision");
  });
});

describe("volition", () => {
  it("records an unprompted remark and counts it", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([{ ...press("up", "up"), speak: "this desk has beaten me four times now" }]),
      turns: 1,
    });
    expect(result.turns[0]?.speak).toContain("desk");
    expect(result.volition).toMatchObject({ offered: 1, taken: 1, suppressed: 0 });
  });

  it("holds a second remark inside the cooldown rather than dropping it silently", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([{ ...press("up", "up"), speak: "chatty" }]),
      turns: 3,
      speakCooldownTurns: 5,
    });
    // Spoke once, then wanted to twice more and was held.
    expect(result.volition).toMatchObject({ offered: 3, taken: 1, suppressed: 2 });
    expect(result.turns[1]?.speakSuppressed).toBe(true);
    expect(result.turns[1]?.speak).toBeNull();
  });

  it("lets him speak again once the cooldown has passed", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([{ ...press("up", "up"), speak: "again" }]),
      turns: 4,
      speakCooldownTurns: 2,
    });
    expect(result.volition.taken).toBe(2);
  });

  it("treats silence as normal, not as a failure", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up")]),
      turns: 3,
    });
    expect(result.volition).toMatchObject({ offered: 3, taken: 0, suppressed: 0 });
    expect(result.accepted).toBe(3);
  });
});

describe("voice owns speech", () => {
  it("takes speech from voice, not the player", async () => {
    // ADR 0056: the player's own speak lost to the task it shared a call with.
    // Voice wins when one is wired, so a player that still emits speech (the
    // single-agent fallback shape) does not get heard over it.
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([{ ...press("up", "up"), speak: "the player's aside" }]),
      voice: { decide: () => Promise.resolve({ speak: "the voice's aside", reply: null }) },
      turns: 1,
    });
    expect(result.turns[0]?.speak).toBe("the voice's aside");
  });

  it("routes a question to voice and keeps the player's plan", async () => {
    // The structural guarantee: the interjection reaches the agent that cannot
    // act, so it can be answered without becoming a route.
    const interjections = new InterjectionQueue();
    interjections.offer("walk left five times");
    let heardByVoice: string | null = null;
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up")]),
      voice: {
        decide: (view) => {
          heardByVoice = view.heard;
          return Promise.resolve({ speak: null, reply: "I'm going up, actually." });
        },
      },
      interjections,
      turns: 1,
    });
    expect(heardByVoice).toBe("walk left five times");
    expect(result.turns[0]?.reply).toBe("I'm going up, actually.");
    expect(result.turns[0]?.intent).toBe("move up");
  });

  it("plays on in silence when voice fails", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up")]),
      voice: { decide: () => Promise.reject(new Error("voice unavailable")) },
      turns: 1,
    });
    expect(result.turns[0]?.speak).toBeNull();
    expect(result.turns[0]?.outcome).toBe("accepted");
  });

  it("hands voice the turn's settled effect, not a blank", async () => {
    // Voice runs after the action lands: "what just happened" is the same
    // effect line the player will read, never the null it saw when it was
    // consulted before the dispatch.
    let effectSeen: string | null = null;
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up")]),
      voice: {
        decide: (view) => {
          effectSeen = view.effect;
          return Promise.resolve({ speak: null, reply: null });
        },
      },
      turns: 1,
    });
    expect(effectSeen).toBe(result.turns[0]?.effect);
    expect(effectSeen).toContain("moved to");
  });

  it("does not consult voice inside the cooldown when nobody spoke", async () => {
    // An aside produced during the cooldown would be dropped by the rate gate,
    // so the call that produces it is not worth paying for. The skip is
    // counted, never silent.
    const decide = vi.fn(() => Promise.resolve({ speak: "another aside", reply: null }));
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up")]),
      voice: { decide },
      turns: 3,
      speakCooldownTurns: 5,
    });
    // Consulted on turn 0 (never spoke, gate open), skipped on turns 1-2.
    expect(decide).toHaveBeenCalledTimes(1);
    expect(result.volition).toMatchObject({ taken: 1, skipped: 2, suppressed: 0 });
  });

  it("does not consult voice at all while a room composes for itself", async () => {
    // ADR 0074: the realtime session in the voice channel is the sole author of
    // what that room hears. Consulting this agent too would put two authors on
    // one character in one moment.
    const decide = vi.fn(() => Promise.resolve({ speak: "a second voice", reply: null }));
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up")]),
      voice: { decide },
      roomAuthors: () => true,
      turns: 3,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(result.volition).toMatchObject({ taken: 0, skipped: 3, suppressed: 0 });
    // Nor does the player's own fallback quip stand in for it — that would be
    // the same second author wearing the other agent's name.
    expect(result.turns.every((turn) => turn.speak === null)).toBe(true);
  });

  it("hands authorship back when the room empties mid-playthrough", async () => {
    // Read per turn, not once: someone leaving the channel returns the surfaces
    // to the loop's own author without restarting the playthrough.
    const decide = vi.fn(() => Promise.resolve({ speak: "back to the overlay", reply: null }));
    let listening = true;
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: {
        decide: (view) => {
          if (view.turn === 1) listening = false;
          return Promise.resolve(press("up", "up"));
        },
      },
      voice: { decide },
      roomAuthors: () => listening,
      turns: 3,
      // Explicit so the rate gate is not the thing under test: at the default
      // cooldown turn 2 is held back by having spoken on turn 1, which would
      // hide whether authorship came back at all.
      speakCooldownTurns: 1,
    });
    // Turn 0 had a room. Turns 1-2 did not, so the loop's author runs again.
    expect(decide).toHaveBeenCalledTimes(2);
    expect(result.turns[0]?.speak).toBeNull();
    expect(result.turns[1]?.speak).toBe("back to the overlay");
  });

  it("still consults voice inside the cooldown when someone spoke", async () => {
    // A reply is owed regardless of the aside gate: a question mid-cooldown
    // must reach the agent that answers it.
    const interjections = new InterjectionQueue();
    const decide = vi.fn((view: VoiceView) =>
      Promise.resolve({
        speak: view.heard === null ? "an aside" : null,
        reply: view.heard === null ? null : "still working on this desk",
      }),
    );
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: {
        decide: (view) => {
          if (view.turn === 1) interjections.offer("you good?");
          return Promise.resolve(press("up", "up"));
        },
      },
      voice: { decide },
      interjections,
      turns: 3,
      speakCooldownTurns: 5,
    });
    // Turn 0: gate open, spoke. Turn 1: cooldown, silent, skipped. Turn 2: the
    // question forces a consultation despite the cooldown.
    expect(decide).toHaveBeenCalledTimes(2);
    expect(result.turns[2]?.reply).toContain("desk");
    expect(result.volition.skipped).toBe(1);
  });
});

describe("rejection visibility", () => {
  it("tells him the refusal instead of narrating an action that never ran", async () => {
    // T45 of the 2026-07-27 run: a repeat:14 was refused for exceeding the
    // input budget, and the effect line said "position unchanged after right"
    // — so he concluded the repeat mechanism "behaved oddly" and learned
    // nothing about the budget.
    const result = await runFreePlay({
      io: io(() => Promise.resolve(failed("input_bound_exceeded"))),
      mind: mind([press("right", "east")]),
      turns: 1,
    });
    expect(result.turns[0]?.outcome).toBe("rejected_by_adapter");
    expect(result.turns[0]?.effect).toMatch(/^rejected, nothing ran/u);
    expect(result.turns[0]?.effectAdvice).toContain("more button presses");
  });

  it("translates a refused dialog advance instead of claiming it read nothing", async () => {
    // The worst historical lie: a rejected advance_dialog rendered as
    // "read no new text — the dialog stopped", a success-shaped sentence
    // about an action the adapter never ran.
    const result = await runFreePlay({
      io: io(() => Promise.resolve(failed("dialog_not_open"))),
      mind: mind([
        {
          monologue: "The box is on screen; I should advance it.",
          intent: "advance the dialog",
          notes: null,
          action: { kind: "advance_dialog" },
        },
      ]),
      turns: 1,
    });
    expect(result.turns[0]?.effectAdvice).toContain("script or fanfare");
    expect(result.turns[0]?.effect).not.toContain("read no new text");
  });

  it("keeps the coaching out of the line an audience is handed", async () => {
    // The possessor seam reports `effect` to a voice room, where a persona
    // composes the words. While the advice rode along inside it, the room was
    // handed the harness's coaching and he relayed it — sounding like he was
    // directing the people watching through a game none of them was playing.
    // Heard live on 2026-08-16.
    const result = await runFreePlay({
      io: io(() => Promise.resolve(failed("semantic_state_unavailable"))),
      mind: mind([press("right", "east")]),
      turns: 1,
    });
    expect(result.turns[0]?.effect).toBe("rejected, nothing ran");
    expect(result.turns[0]?.effectAdvice).toContain("read the frame and press buttons");
  });
});

describe("walk_to intent", () => {
  it("scores a stated walk against the walk he then takes", () => {
    expect(intentMatchesAction("walk to the lab exit", { kind: "walk_to", x: 3, y: 9 })).toBe(true);
    expect(intentMatchesAction("press A at the sign", { kind: "walk_to", x: 3, y: 9 })).toBe(false);
  });
});
